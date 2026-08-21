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
import z from "@deepseek-ai/schemastery"
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings"
import yaml from "js-yaml"
import { createHttpsProxy } from "./https-proxy.js"

export const name = "https-fix"

/** 依赖 webServer 服务(读取当前 http 端口);settings/connection 由 apply 内部 scoped inject。 */
export const inject = ["webServer"]

/** settings 命名空间(与插件短名一致,kebab-case)。 */
const NS = settingsNamespace("https-fix")

/**
 * 插件 Config(组成配置)与 settings 命名空间 schema 复用同一份。
 * httpPort 无默认值:apply 时以 ctx.webServer.port 作为 base 层种子。
 */
export const Config = z.object({
  blockHttpExternalAccess: z.boolean().default(false),      // F1 关闭http外网访问
  httpPort: z.natural().min(1).max(65535),                 // F2 http端口(无默认)
  enableHttps: z.boolean().default(false),                 // F3 启用https
  httpsSamePort: z.boolean().default(false),               // F4 https复用http端口
  httpsPort: z.natural().min(1).max(65535).default(3081),  // F5 https端口
  domain: z.string().default(""),                          // F6 域名
  address: z.string().default(""),                         // F7 监听地址
  certPath: z.string().default(""),                        // F8 证书路径
  keyPath: z.string().default("")                          // F9 密钥路径
})

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

  function effectiveHttpsPort(cfg) {
    return cfg.httpsSamePort ? (cfg.httpPort ?? actualHttpPort) : cfg.httpsPort
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

    proxy = createHttpsProxy({ upstream })
    httpsServer = createHttpsServer({ cert, key }, (req, res) => proxy.handle(req, res))
    httpsServer.on("upgrade", (req, socket, head) => proxy.handleUpgrade(req, socket, head))
    httpsServer.on("error", (err) => {
      logger.warn(`[https-fix] HTTPS 服务错误: ${err?.message ?? String(err)}`)
    })
    const port = effectiveHttpsPort(cfg)
    const bind = cfg.address || "0.0.0.0"
    httpsServer.listen(port, bind, () => {
      logger.info(`[https-fix] HTTPS 监听于 ${bind}:${port} → 127.0.0.1:${upstream.port}`)
    })
    try {
      const s = statSync(cfg.certPath)
      certStamp = { mtimeMs: s.mtimeMs, size: s.size }
    } catch { certStamp = null }
  }

  function reconcile() {
    const cfg = source()
    writePatchOverride(cfg)
    const want = cfg.enableHttps && !!cfg.domain && !!cfg.certPath && !!cfg.keyPath
    if (!want) {
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

  // ── settings 命名空间注册(触发 reconcile 的变更通知) ───────────────────

  installSettingsSection(ctx, NS, Config, entry, {
    setSource: (next) => { source = next },
    onChange: () => reconcile()
  })

  // ── 证书热重载(60s stat) ────────────────────────────────────────────────

  ctx.effect(() => {
    const timer = setInterval(() => {
      const cfg = source()
      if (!cfg.enableHttps || !cfg.certPath || !cfg.keyPath) return
      try {
        const s = statSync(cfg.certPath)
        if (certStamp !== null && certStamp.mtimeMs === s.mtimeMs && certStamp.size === s.size) return
        stopServer()
        startServer(cfg)
        logger.info("[https-fix] TLS 证书已热重载")
      } catch { /* 证书暂不可读,等待下次轮询 */ }
    }, 60000)
    if (typeof timer.unref === "function") timer.unref()
    return () => clearInterval(timer)
  }, "https-fix: certificate hot reload")

  // ── 卸载时释放 HTTPS 监听 ───────────────────────────────────────────────

  ctx.effect(() => () => stopServer(), "https-fix: dispose listener")

  // ── RPC 通道 /https-fix(validate / status) ──────────────────────────────

  ctx.inject(["connection"], (cctx) => {
    cctx.connection.rpc.handle("/https-fix", async (endpoint, payload) => {
      if (endpoint === "validate") return runValidation(source())
      if (endpoint === "status") return statusView(source())
      return { ok: false, error: { code: "not-found", message: `未知端点 ${endpoint}`, details: {} } }
    }, { authority: "loopback" })
  })

  function statusView(cfg) {
    return {
      ok: true,
      value: {
        running: httpsServer !== null,
        httpPort: cfg.httpPort ?? actualHttpPort,
        httpsPort: effectiveHttpsPort(cfg),
        domain: cfg.domain,
        address: cfg.address || "0.0.0.0",
        enableHttps: cfg.enableHttps,
        blockHttpExternalAccess: cfg.blockHttpExternalAccess
      }
    }
  }

  // ── 校验逻辑 ─────────────────────────────────────────────────────────────

  async function runValidation(cfg) {
    const log = []
    const push = (ok, msg) => log.push({ ok, msg })
    const allOk = () => log.every((l) => l.ok !== false)

    await checkPort(effectiveHttpsPort(cfg), cfg.address || "0.0.0.0", push)
    checkTls(cfg.certPath, cfg.keyPath, cfg.domain, push)
    if (cfg.domain) await checkDomain(cfg.domain, push)
    await checkHttpUp(cfg.httpPort ?? actualHttpPort, push)

    return { ok: allOk(), log }
  }

  function checkPort(port, address, push) {
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
