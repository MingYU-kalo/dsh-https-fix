/**
 * dsh-https-fix 宿主插件。
 *
 * 单一 Loader 行(见 cordis.patch.yml)挂载本模块,职责:
 *  1. 通过 installSettingsSection 注册 settings 命名空间 `https-fix`,
 *     作为「设置 → 插件配置 → Https Fix」卡片的数据源(用户层写入 settings 文档);
 *  2. 托管机器级补丁层 `$DSH_HOME/cordis.patch.yml` 的 webserver 行覆盖:
 *     - 关闭 http 外网访问 → host: 127.0.0.1
 *     - http 端口 → port: N(与当前实际端口不同才写入)
 *  3. 按配置启动/停止内置 HTTPS 反向代理(转发到 127.0.0.1:<httpPort>),
 *     证书文件变化时热重载 TLS context;
 *  4. 注册 /https-fix RPC 通道(validate/status),供卡片校验按钮调用。
 *
 * 与核心包共享运行时:不导入 cordis Service/Context 类,只用 ctx API、
 * Node 内建能力与 dsh-settings 的纯函数 helper。@deepseek-ai/schemastery 与
 * @deepseek-ai/dsh-settings 经 profile 模块回退解析到宿主同一实例,保证
 * schema 兼容。
 */
import { createServer as createHttpsServer } from "node:https"
import { createSecureContext } from "node:tls"
import { X509Certificate } from "node:crypto"
import { request as httpRequest } from "node:http"
import { readFileSync, writeFileSync, existsSync, rmSync, statSync } from "node:fs"
import { lookup } from "node:dns"
import net from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"
import { URL } from "node:url"
import z from "@deepseek-ai/schemastery"
import yaml from "js-yaml"
import { createHttpsProxy } from "./https-proxy.js"

export const name = "https-fix"

/** 依赖 webServer(当前 http 端口)与 clientModules(定位客户端 bundle 路径,热补丁用)。 */
export const inject = ["webServer", "clientModules"]

/** settings 命名空间(与插件短名一致,kebab-case)。 */
const NS = "https-fix"

/**
 * 插件 Config(组成配置)与 settings 命名空间 schema 复用同一份。
 * httpPort 无默认值:apply 时以 ctx.webServer.port 作为 base 层种子。
 */
export const Config = z.object({
  blockHttpExternalAccess: z.boolean().default(false),       // F1 关闭http外网访问
  httpPort: z.natural().min(1).max(65535),                  // F2 http端口(无默认)
  enableHttps: z.boolean().default(false),                  // F3 启用https
  httpsPort: z.natural().min(1).max(65535).default(3081),   // F4 https端口
  domain: z.string().default(""),                           // F5 域名
  address: z.string().default(""),                          // F6 监听地址
  certPath: z.string().default(""),                         // F7 证书路径
  keyPath: z.string().default(""),                          // F8 密钥路径
  versionCheck: z.boolean().default(true),                  // F9 核对版本号
  autoToken: z.boolean().default(true)                      // F10 自动模式(自动注入网页 token)
})

/** 本插件针对的 dsh 版本(与 dsh-<版本号> 分支对应);versionCheck 开启时用它核对。 */
const TARGET_DSH_VERSION = "0.1.2-rc.1"

/**
 * 客户端 bundle 里 isLoopback 判定的候选目标行(不同 dsh 版本该行不同)。
 * 热补丁在其后追加 `|| pageLocation.host === "<域名>:<端口>"` 豁免。
 */
const LOOPBACK_TARGET_LINES = [
  "isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname)", // 0.1.2+
  "isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname)"                                  // 0.1.1
]

/** 归一化版本号:去掉开头 v 与构建元数据(+后缀),用于精确核对。 */
function normalizeVersion(v) {
  if (typeof v !== "string") return ""
  return v.replace(/^v/i, "").split("+")[0].trim()
}

/** 读取当前运行的 dsh 版本;失败返回 "". */
async function runningDshVersion() {
  try {
    const mod = await import("@deepseek-ai/dsh/package.json", { with: { type: "json" } })
    const v = mod.default?.version ?? mod.version
    return normalizeVersion(v)
  } catch {
    return ""
  }
}

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh")
}

function patchFilePath() {
  return join(dshHome(), "cordis.patch.yml")
}

export function apply(ctx, config) {
  const logger = ctx.logger
  const actualHttpPort = ctx.webServer.port

  /** 组成配置作为 base 层;httpPort 缺省时种子为当前实际端口。 */
  const entry = { ...config, httpPort: config.httpPort ?? actualHttpPort }

  /** settings 生效值的实时读取 thunk(installSettingsSection 会替换)。 */
  let source = () => entry

  let httpsServer = null
  let proxy = null
  let certStamp = null // { mtimeMs, size }

  // ── HTTPS 反代生命周期 ──────────────────────────────────────────────────

  /** 自动模式下的进程启动 token(取自 connection.authenticatedUrl);不可用时返回 null。 */
  let tokenCache = { at: 0, value: null }
  function currentToken() {
    if (!source().autoToken) return null
    const now = Date.now()
    if (now - tokenCache.at < 5000) return tokenCache.value
    let value = null
    try {
      const conn = ctx.get("connection")
      const url = conn?.authenticatedUrl?.(`http://127.0.0.1:${actualHttpPort}`)
      if (typeof url === "string") value = new URL(url).searchParams.get("token")
    } catch {
      value = null
    }
    tokenCache = { at: now, value }
    return value
  }

  function stopServer() {
    if (httpsServer !== null) {
      try { httpsServer.close() } catch {}
      httpsServer = null
      proxy = null
    }
  }

  function startServer(cfg) {
    const upstream = { host: "127.0.0.1", port: cfg.httpPort ?? actualHttpPort }
    const cert = readFileSync(cfg.certPath)
    const key = readFileSync(cfg.keyPath)
    createSecureContext({ cert, key }) // 先校验配对,失败即抛

    proxy = createHttpsProxy({ upstream, tokenProvider: currentToken })
    httpsServer = createHttpsServer({ cert, key }, (req, res) => proxy.handle(req, res))
    httpsServer.on("upgrade", (req, socket, head) => proxy.handleUpgrade(req, socket, head))
    httpsServer.on("error", (err) => {
      logger.warn(`[https-fix] HTTPS 服务错误: ${err?.message ?? String(err)}`)
    })
    const port = cfg.httpsPort
    const bind = cfg.address || "0.0.0.0"
    httpsServer.listen(port, bind, () => {
      logger.info(`[https-fix] HTTPS 监听于 ${bind}:${port} → 127.0.0.1:${upstream.port}`)
    })
    try {
      const s = statSync(cfg.certPath)
      certStamp = { mtimeMs: s.mtimeMs, size: s.size }
    } catch { certStamp = null }
  }

  function wantHttps(cfg) {
    return cfg.enableHttps && !!cfg.domain && !!cfg.certPath && !!cfg.keyPath
  }

  /**
   * 版本一致性检查(日志与拦截共用)。
   * @returns { ok, msg, block } - ok:日志是否绿;block:true 则禁止启动 HTTPS。
   */
  async function versionCheckResult(cfg) {
    if (!cfg.versionCheck) return { ok: true, msg: "版本核对:已关闭", block: false }
    const installed = await runningDshVersion()
    if (installed === "") return { ok: false, msg: "版本核对:无法读取 dsh 版本", block: true }
    const target = normalizeVersion(TARGET_DSH_VERSION)
    if (installed !== target) return { ok: false, msg: `版本核对:dsh ${installed} 与本插件目标版本 ${target} 不一致`, block: true }
    return { ok: true, msg: `版本核对:dsh ${installed} 与插件目标版本一致`, block: false }
  }

  async function reconcile() {
    const cfg = source()
    writePatchOverride(cfg)
    if (!wantHttps(cfg)) {
      stopServer()
      return
    }
    const vc = await versionCheckResult(cfg)
    if (vc.block) {
      logger.warn(`[https-fix] ${vc.msg};已停止 HTTPS`)
      stopServer()
      return
    }
    try {
      if (httpsServer === null) startServer(cfg)
    } catch (err) {
      logger.warn(`[https-fix] 启动 HTTPS 失败: ${err?.message ?? String(err)}`)
      stopServer()
    }
  }

  // ── 机器级补丁托管($DSH_HOME/cordis.patch.yml) ─────────────────────────

  function readPatchEntries() {
    try {
      if (!existsSync(patchFilePath())) return []
      const doc = yaml.load(readFileSync(patchFilePath(), "utf8"))
      return Array.isArray(doc) ? doc : []
    } catch (err) {
      logger.warn(`[https-fix] 读取 ${patchFilePath()} 失败: ${err?.message ?? String(err)}`)
      return []
    }
  }

  function writePatchOverride(cfg) {
    const host = cfg.blockHttpExternalAccess ? "127.0.0.1" : undefined
    const port = cfg.httpPort != null && cfg.httpPort !== actualHttpPort ? cfg.httpPort : undefined
    const entries = readPatchEntries().filter((e) => !(e && typeof e === "object" && e.id === "webserver"))
    if (host !== undefined || port !== undefined) {
      const overrides = {}
      if (host !== undefined) overrides.host = host
      if (port !== undefined) overrides.port = port
      entries.push({ id: "webserver", config: overrides })
    }
    try {
      if (entries.length === 0) {
        if (existsSync(patchFilePath())) rmSync(patchFilePath())
        return
      }
      const header = "# Machine-level cordis patch layer — managed by dsh-https-fix.\n# The plugin owns the `webserver` entry below; do not hand-edit it.\n"
      writeFileSync(patchFilePath(), header + yaml.dump(entries, { lineWidth: -1 }), "utf8")
    } catch (err) {
      logger.warn(`[https-fix] 写入 ${patchFilePath()} 失败: ${err?.message ?? String(err)}`)
    }
  }

  // ── settings 命名空间注册(dsh 0.1.2 起为 settings 服务上的 installSection) ──

  ctx.inject(["settings"], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, NS, Config, entry, {
      setSource: (next) => { source = next },
      onChange: () => reconcile()
    })
  })

  // ── 证书热重载(60s stat) ────────────────────────────────────────────────

  ctx.effect(() => {
    const timer = setInterval(() => {
      void (async () => {
        const cfg = source()
        if (!wantHttps(cfg)) return
        const vc = await versionCheckResult(cfg)
        if (vc.block) {
          stopServer()
          return
        }
        try {
          const s = statSync(cfg.certPath)
          if (certStamp !== null && certStamp.mtimeMs === s.mtimeMs && certStamp.size === s.size) return
          stopServer()
          startServer(cfg)
          logger.info("[https-fix] TLS 证书已热重载")
        } catch { /* 证书暂不可读,等待下次轮询 */ }
      })()
    }, 60000)
    if (typeof timer.unref === "function") timer.unref()
    return () => clearInterval(timer)
  }, "https-fix: certificate hot reload")

  // ── 卸载时释放 HTTPS 监听 ───────────────────────────────────────────────

  ctx.effect(() => () => stopServer(), "https-fix: dispose listener")

  // ── RPC 通道 /https-fix(validate / status / 热补丁) ──────────────────────

  ctx.inject(["connection"], (cctx) => {
    // dsh 0.1.2 起 rpc.handle 不再接受 authority 选项,统一由 Host/Origin 栅栏 + cookie 鉴权把关
    cctx.connection.rpc.handle("/https-fix", async (endpoint, payload) => {
      if (endpoint === "validate") return runValidation(source())
      if (endpoint === "status") return statusView(source())
      if (endpoint === "patch-loopback") return patchLoopback(source())
      if (endpoint === "revert-loopback") return revertLoopback()
      if (endpoint === "patch-status") return patchStatus()
      return { ok: false, error: { code: "not-found", message: `未知端点 ${endpoint}`, details: {} } }
    })
  })

  function statusView(cfg) {
    return {
      ok: true,
      value: {
        running: httpsServer !== null,
        httpPort: cfg.httpPort ?? actualHttpPort,
        httpsPort: cfg.httpsPort,
        domain: cfg.domain,
        address: cfg.address || "0.0.0.0",
        enableHttps: cfg.enableHttps,
        blockHttpExternalAccess: cfg.blockHttpExternalAccess,
        versionCheck: cfg.versionCheck,
        autoToken: cfg.autoToken
      }
    }
  }

  // ── 一键打热补丁(connection.isLoopback 客户端 bundle 豁免) ──────────────

  /** dsh-client-connection 客户端 bundle 的文件路径(clientModules 解析)。 */
  function loopbackBundlePath() {
    try {
      return ctx.clientModules?.clientPath?.("@deepseek-ai/dsh-client-connection") ?? null
    } catch {
      return null
    }
  }

  /** 追加的豁免表达式(域名:端口)。 */
  function loopbackExemption(cfg) {
    const host = cfg.domain && cfg.httpsPort ? `${cfg.domain}:${cfg.httpsPort}` : ""
    return ` || pageLocation.host === ${JSON.stringify(host)}`
  }

  /** 在 bundle 源码里定位需要追加豁免的 isLoopback 行;找不到返回 null。 */
  function loopbackPatchTarget(src, cfg) {
    const exemption = loopbackExemption(cfg)
    for (const line of LOOPBACK_TARGET_LINES) {
      if (src.includes(line)) return { line, exemption }
    }
    return null
  }

  function patchLoopback(cfg) {
    const path = loopbackBundlePath()
    if (!path) return { ok: false, log: ["未找到 dsh-client-connection 客户端 bundle 路径"] }
    if (!cfg.domain || !cfg.httpsPort) return { ok: false, log: ["请先配置「域名」与「https 端口」后再打热补丁"] }
    try {
      const src = readFileSync(path, "utf8")
      const target = loopbackPatchTarget(src, cfg)
      if (target === null) return { ok: false, log: ["客户端 bundle 中未找到 isLoopback 目标行(可能 dsh 版本不同,可先关闭版本核对再试)"], path }
      if (src.includes(target.exemption.trim())) return { ok: true, log: ["热补丁已存在"], path }
      writeFileSync(path, src.replace(target.line, target.line + target.exemption), "utf8")
      return { ok: true, log: [`已写入热补丁 → ${path}`, `豁免: ${target.exemption.trim()}`, "刷新页面生效(HMR 自动热更新,无需重启 dsh)"], path }
    } catch (err) {
      return { ok: false, log: [`打热补丁失败: ${err?.message ?? String(err)}`], path }
    }
  }

  function revertLoopback() {
    const path = loopbackBundlePath()
    if (!path) return { ok: false, log: ["未找到客户端 bundle 路径"] }
    try {
      const src = readFileSync(path, "utf8")
      const pattern = / \|\| pageLocation\.host === "[^"]*"/
      if (!pattern.test(src)) return { ok: true, log: ["当前无热补丁"], path }
      writeFileSync(path, src.replace(pattern, ""), "utf8")
      return { ok: true, log: [`已还原 → ${path}`, "刷新页面生效"], path }
    } catch (err) {
      return { ok: false, log: [`还原失败: ${err?.message ?? String(err)}`], path }
    }
  }

  function patchStatus() {
    const path = loopbackBundlePath()
    if (!path) return { ok: false, patched: false, msg: "未找到客户端 bundle 路径" }
    try {
      const src = readFileSync(path, "utf8")
      const patched = / \|\| pageLocation\.host ===/.test(src)
      return { ok: true, patched, msg: patched ? "已打热补丁" : "未打热补丁", path }
    } catch (err) {
      return { ok: false, patched: false, msg: `读取失败: ${err?.message ?? String(err)}` }
    }
  }

  // ── 校验逻辑 ─────────────────────────────────────────────────────────────

  /** dsh 0.1.2 起 /api 栅栏要求域名在 trustedHosts(启动参数 --trusted-host)。 */
  function trustedHostCheck(cfg) {
    if (!cfg.domain) return null
    try {
      const conn = ctx.get("connection")
      const trusted = conn?.trustedHosts ?? []
      const authority = `${cfg.domain}:${cfg.httpsPort}`
      const hit = trusted.some((entry) => {
        const value = String(entry)
        return value === authority || value === cfg.domain
      })
      if (hit) return { ok: true, msg: `受信域名:${cfg.domain} 已在 trustedHosts 中` }
      return { ok: false, msg: `受信域名:${cfg.domain} 不在 trustedHosts 中;请以 dsh web --trusted-host ${cfg.domain} 启动` }
    } catch (err) {
      return { ok: false, msg: `受信域名:检查失败 ${err?.message ?? String(err)}` }
    }
  }

  async function runValidation(cfg) {
    const log = []
    const push = (ok, msg) => log.push({ ok, msg })
    const allOk = () => log.every((l) => l.ok !== false)

    const vc = await versionCheckResult(cfg)
    push(vc.ok, vc.msg)
    const th = trustedHostCheck(cfg)
    if (th !== null) push(th.ok, th.msg)
    const hot = hotPatchCheck(cfg)
    if (hot !== null) push(hot.ok, hot.msg)
    await checkPort(cfg.httpsPort, cfg.address || "0.0.0.0", push)
    checkTls(cfg.certPath, cfg.keyPath, cfg.domain, push)
    if (cfg.domain) await checkDomain(cfg.domain, push)
    await checkHttpUp(cfg.httpPort ?? actualHttpPort, push)

    return { ok: allOk(), log }
  }

  /** 校验里附带的热补丁状态检查:域名已配置时,确认客户端 bundle 已打豁免补丁。 */
  function hotPatchCheck(cfg) {
    if (!cfg.domain) return null // 未配置域名,跳过
    const path = loopbackBundlePath()
    if (!path) return { ok: false, msg: "热补丁:未找到 dsh-client-connection 客户端 bundle 路径" }
    try {
      const src = readFileSync(path, "utf8")
      const target = loopbackPatchTarget(src, cfg)
      if (target === null) return { ok: false, msg: "热补丁:客户端 bundle 中未找到 isLoopback 目标行(可能 dsh 版本不同)" }
      if (src.includes(target.exemption.trim())) return { ok: true, msg: `热补丁:已应用(豁免 ${target.exemption.trim()})` }
      return { ok: false, msg: "热补丁:未应用,经域名访问时设置页不可用;请在卡片点击「一键打热补丁」" }
    } catch (err) {
      return { ok: false, msg: `热补丁:读取失败 ${err?.message ?? String(err)}` }
    }
  }

  function checkPort(port, address, push) {
    // 该端口正是本插件 HTTPS 服务当前监听的端口 → 视为可用(已在服务,而非被占用)
    const selfPort = httpsServer !== null ? (httpsServer.address()?.port ?? null) : null
    if (selfPort === port) {
      push(true, `HTTPS 端口 ${port} 已由本插件 HTTPS 服务监听`)
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const probe = net.createServer()
      probe.once("error", (err) => { push(false, `HTTPS 端口 ${port} 不可监听: ${err.code ?? err.message}`); resolve() })
      probe.once("listening", () => probe.close(() => { push(true, `HTTPS 端口 ${port} 空闲可用`); resolve() }))
      probe.listen(port, address)
    })
  }

  function checkTls(certPath, keyPath, domain, push) {
    let certPem
    try {
      certPem = readFileSync(certPath)
      push(true, `证书文件可读: ${certPath}`)
    } catch (err) {
      push(false, `证书文件不可读: ${err?.message ?? String(err)}`)
      return
    }
    try {
      const x509 = new X509Certificate(certPem)
      push(true, `证书解析成功: subject=${x509.subject}`)
      const san = (x509.subjectAltName || "")
        .split(",").map((s) => s.trim().replace(/^DNS:/i, "")).filter(Boolean)
      const cn = x509.subject?.match(/CN=([^,\s]+)/)?.[1]
      const names = [...new Set([...san, cn].filter(Boolean))]
      if (domain && names.length > 0) {
        const hit = names.some((n) => n === domain || (n.startsWith("*.") && domain.endsWith(n.slice(1))))
        push(hit, hit ? `证书包含域名 ${domain}` : `证书不包含域名 ${domain}(证书含:${names.join(", ")})`)
      }
    } catch (err) {
      push(false, `证书解析失败: ${err?.message ?? String(err)}`)
    }
    try {
      readFileSync(keyPath)
      push(true, `密钥文件可读: ${keyPath}`)
    } catch (err) {
      push(false, `密钥文件不可读: ${err?.message ?? String(err)}`)
      return
    }
    try {
      createSecureContext({ key: readFileSync(keyPath), cert: certPem })
      push(true, "证书与密钥配对成功")
    } catch (err) {
      push(false, `证书与密钥不匹配: ${err?.message ?? String(err)}`)
    }
  }

  function checkDomain(domain, push) {
    return new Promise((resolve) => {
      lookup(domain, { all: true }, (err, addrs) => {
        if (err) push(false, `域名解析失败(${domain}): ${err.code ?? err.message}`)
        else push(true, `域名解析成功(${domain}): ${addrs.map((a) => a.address).join(", ")}`)
        resolve()
      })
    })
  }

  function checkHttpUp(port, push) {
    return new Promise((resolve) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/", method: "GET", timeout: 3000 }, (res) => {
        res.resume()
        push(true, `HTTP 端口 ${port} 可达(HTTP ${res.statusCode})`)
        resolve()
      })
      req.on("error", () => { push(false, `HTTP 端口 ${port} 不可达`); resolve() })
      req.on("timeout", () => { req.destroy(); push(false, `HTTP 端口 ${port} 超时`); resolve() })
      req.end()
    })
  }
}
