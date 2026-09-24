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
import { randomBytes, X509Certificate } from "node:crypto"
import { request as httpRequest } from "node:http"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { lookup } from "node:dns"
import net from "node:net"
import { homedir, networkInterfaces } from "node:os"
import { join } from "node:path"
import { URL } from "node:url"
import z from "@deepseek-ai/schemastery"
import yaml from "js-yaml"
import { isVolatile } from "@deepseek-ai/cosmokit"
import { createHttpsProxy } from "./https-proxy.js"
import { ensureSelfSignedCertificate } from "./self-signed.js"
import {
  DEFAULT_USER,
  defaultPasswordHash,
  issueSession,
  loadOrCreateSecret,
  readCookie,
  safeEqualHex,
  sha256Hex,
  verifySession
} from "./auth.js"
import {
  COOKIE_NAME,
  LOGIN_PATH,
  LOGOUT_PATH,
  MAX_BODY_BYTES,
  SESSION_TTL_MS,
  loginPageHtml
} from "./login-page.js"

export const name = "https-fix"

/** 依赖 webServer(当前 http 端口)与 clientModules(定位客户端 bundle 路径,热补丁用)。 */
export const inject = ["webServer", "clientModules", "connection"]

/** settings 命名空间(与插件短名一致,kebab-case)。 */
const NS = "https-fix"

/**
 * 插件 Config(组成配置)与 settings 命名空间 schema 复用同一份。
 * httpPort 无默认值:apply 时以 ctx.webServer.port 作为 base 层种子。
 */
export const Config = z.object({
  blockHttpExternalAccess: z.boolean().default(false).volatile(),        // F1 关闭http外网访问
  httpPort: z.natural().min(1).max(65535).volatile(),                    // F2 http端口(无默认)
  enableHttps: z.boolean().default(false).volatile(),                    // F3 启用https
  httpsPort: z.natural().min(1).max(65535).default(3081).volatile(),     // F4 https端口
  domain: z.string().default("").volatile(),                             // F5 域名
  address: z.string().default("").volatile(),                            // F6 监听地址
  certPath: z.string().default("").volatile(),                           // F7 证书路径
  keyPath: z.string().default("").volatile(),                            // F8 密钥路径
  versionCheck: z.boolean().default(true).volatile(),                    // F9 核对版本号
  autoToken: z.boolean().default(true).volatile(),                       // F10 自动模式(自动注入网页 token)
  loginEnabled: z.boolean().default(true).volatile(),                    // F11 启用登录(仅作用于插件 HTTPS 端口)
  loginUser: z.string().default(DEFAULT_USER).volatile(),                // F12 登录账号(明文)
  loginPasswordHash: z.string().default(defaultPasswordHash()).volatile() // F13 登录密码(SHA-256 十六进制,不存明文)
})

/** 本插件针对的 dsh 版本(与 dsh-<版本号> 分支对应);versionCheck 开启时用它核对。 */
const TARGET_DSH_VERSION = "0.1.7-rc.1"

/**
 * 客户端 bundle 里 isLoopback 判定的候选目标行(不同 dsh 版本该行不同)。
 * 热补丁在其后追加 `|| pageLocation.hostname === "<域名>"` 豁免(端口无关,兼容前置代理)。
 */
const LOOPBACK_TARGET_LINES = [
  "isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname)", // 0.1.2 ~ 0.1.7-rc.1(逐版本核对:rc.1 → 0.1.7-rc.1 该行始终未变)
  "isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname)"                                  // 0.1.1
]

/**
 * 已写入的豁免片段(用于查重/还原)。
 * 同时认新形式(hostname,0.1.5-rc.1 起)与旧形式(host:端口),保证老部署可还原。
 */
function exemptionPattern(global) {
  return new RegExp(" \\|\\| pageLocation\\.host(?:name)? === \"[^\"]*\"", global ? "g" : "")
}

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

/** 判断 IPv4 是否属于私有/保留段(仅用于候选排序,不做过滤)。 */
/** 解开 volatile 盒子;非 volatile 字段原样返回。 */
function plainConfig(config) {
  const out = {}
  for (const [key, value] of Object.entries(config ?? {})) {
    out[key] = isVolatile(value) ? value.get() : value
  }
  return out
}

/** 判断 IPv4 是否属于私有/保留段(仅用于候选排序,不做过滤)。 */
function isPrivateIPv4(ip) {
  const [a, b] = String(ip).split(".").map(Number)
  return a === 10 || a === 127 || a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
}

/**
 * 本机非回环 IPv4 候选(直接读网卡,不访问外网服务)。
 * 带上网卡名与是否私有,便于界面区分 eth0 与 docker0;公网地址优先排序。
 * 只收 IPv4:IPv6 的方括号形式在 Host 头 / trustedHosts / 证书 SAN 三处语义不一致,不在此列。
 */
function serverIPv4Addresses() {
  const out = []
  const seen = new Set()
  try {
    for (const [iface, addrs] of Object.entries(networkInterfaces())) {
      for (const addr of addrs ?? []) {
        if ((addr.family === "IPv4" || addr.family === 4) && !addr.internal && typeof addr.address === "string") {
          if (seen.has(addr.address)) continue
          seen.add(addr.address)
          out.push({ iface, address: addr.address, private: isPrivateIPv4(addr.address) })
        }
      }
    }
  } catch { /* 忽略:拿不到网卡列表 */ }
  return out.sort((a, b) => Number(a.private) - Number(b.private) || a.iface.localeCompare(b.iface))
}

/** 自签证书落盘目录(随 DSH_HOME,不污染仓库)。 */
function certDir() {
  return join(dshHome(), "https-fix")
}

/**
 * 证书来源:
 *  - "paths"  : certPath 与 keyPath 都填了 → 用用户提供的证书文件(例如 Let's Encrypt 的 IP 证书)
 *  - "auto"   : 两者都留空 → 插件自动生成/复用自签证书(适合只有公网 IP、没有域名)
 *  - "invalid": 只填了一个 → 不启动 HTTPS,由校验给出提示
 */
function certificateMode(cfg) {
  const cert = String(cfg?.certPath ?? "").trim()
  const key = String(cfg?.keyPath ?? "").trim()
  if (cert !== "" && key !== "") return "paths"
  if (cert === "" && key === "") return "auto"
  return "invalid"
}

/** 自签证书要覆盖的名字:配置的域名或 IP + 回环(方便本机自检)。 */
function certificateHosts(cfg) {
  const hosts = []
  const domain = String(cfg?.domain ?? "").trim()
  if (domain) hosts.push(domain)
  hosts.push("127.0.0.1", "localhost")
  return [...new Set(hosts)]
}

/** 生成或复用自签证书;失败抛错(调用方负责收敛)。 */
function autoCertificate(cfg) {
  return ensureSelfSignedCertificate({ dir: certDir(), hosts: certificateHosts(cfg) })
}

/** 解析本次使用的证书材料:文件证书或自动自签。 */
function loadCertificate(cfg) {
  if (certificateMode(cfg) === "paths") {
    return {
      cert: readFileSync(cfg.certPath),
      key: readFileSync(cfg.keyPath),
      auto: false,
      certPath: cfg.certPath,
      keyPath: cfg.keyPath
    }
  }
  const material = autoCertificate(cfg)
  return {
    cert: material.cert,
    key: material.key,
    auto: true,
    certPath: material.certPath,
    keyPath: material.keyPath,
    notAfter: material.notAfter
  }
}

export function apply(ctx, config) {
  const logger = ctx.logger
  const actualHttpPort = ctx.webServer.port

  /**
   * 生效配置。dsh 0.1.6 起设置表单直接由本插件的 Config 导出投影而成
   * (settings.installSection 已移除),写设置走 profile patch + Loader 热重载,
   * 会**重新 apply 本插件**——因此这里拿到的 config 永远是最新值,不需要再维护 source thunk。
   * httpPort 无默认值,缺省时以 ctx.webServer.port 兜底。
   */
  const seed = plainConfig(config)
  const entry = { ...seed, httpPort: seed.httpPort ?? actualHttpPort }
  // dsh 0.1.6 起 volatile 字段在 config 里是 cosmokit 的"盒子"(createVolatile),
  // 设置写入时盒子被**就地更新**,所以每次读都能拿到最新值(等价旧版的 setSource thunk)。
  const source = () => {
    const live = plainConfig(config)
    return { ...live, httpPort: live.httpPort ?? actualHttpPort }
  }

  let httpsServer = null
  let proxy = null
  let certStamp = null // { mtimeMs, size }(仅文件证书模式;自签模式恒为 null)
  let activeCert = null  // 当前监听使用的证书材料(自签模式下用于判断是否重签)
  let startedSignature = null // 当前监听对应的配置签名(变更即重启监听)

  // 重启瞬间旧进程可能还没放开端口(EADDRINUSE)。以前这里静默失败,
  // 0.1.7 升级那次就表现为"HTTP 3080 正常、HTTPS 3082 不监听"。
  const LISTEN_RETRY_MAX = 15
  const LISTEN_RETRY_DELAY_MS = 1000
  let listenRetry = { timer: null, attempts: 0 }

  function clearListenRetry() {
    if (listenRetry.timer !== null) {
      clearTimeout(listenRetry.timer)
      listenRetry.timer = null
    }
    listenRetry.attempts = 0
  }

  /** settings 读取兜底:settings 服务重载期间取值可能短暂失败。 */
  function safeSource() {
    try {
      return source() ?? entry
    } catch (err) {
      report("读取设置", err)
      return entry
    }
  }

  /**
   * 关键诊断:同时写 ctx.logger 与终端。
   * cordis 的 logger 只有内存 ring buffer(默认没有 console exporter),不落盘;
   * 崩溃排查要看终端/日志文件,所以这里额外 console.warn 一次(同因去重防刷屏)。
   */
  const reportedDiagnostics = new Set()

  /** 关键警告双写:logger 只有内存缓冲,排障要看终端/日志,所以同时 console.warn(去重)。 */
  function warnOnce(line) {
    logger.warn(line)
    if (!reportedDiagnostics.has(line) && reportedDiagnostics.size < 100) {
      reportedDiagnostics.add(line)
      console.warn(line)
    }
  }

  function report(label, err) {
    const line = `[https-fix] ${label} 异常: ${err?.stack ?? String(err)}`
    logger.warn(line)
    const key = `${label}:${err?.message ?? String(err)}`
    if (!reportedDiagnostics.has(key) && reportedDiagnostics.size < 100) {
      reportedDiagnostics.add(key)
      console.warn(line)
    }
  }

  /**
   * 执行可能抛错或返回 rejected promise 的逻辑,并把异常收敛成日志。
   *
   * 必须这么做:dsh-app-boot 在进程上注册了 unhandledRejection 处理器
   * (installFailLoud),它会打印 "dsh: fatal load failure: …" 然后
   * process.exit(1)。插件的定时器、settings 回调、RPC 处理器一旦漏出
   * 未处理的 rejection,整个 dsh 进程就会"莫名崩溃"。
   */
  function guard(label, fn) {
    try {
      const result = fn()
      if (result !== null && typeof result === "object" && typeof result.then === "function") {
        result.then(undefined, (err) => report(label, err))
      }
      return result
    } catch (err) {
      report(label, err)
      return undefined
    }
  }

  // ── HTTPS 反代生命周期 ──────────────────────────────────────────────────

  /** 自动模式下的进程启动 token(取自 connection.authenticatedUrl);不可用时返回 null。 */
  let tokenCache = { at: 0, value: null }
  function currentToken() {
    if (!safeSource().autoToken) return null
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

  // ── 登录(挡在插件 HTTPS 端口前的门;不影响 dsh 自身 http 端口) ──────────

  /** 会话密钥:首次读取/生成后进程内缓存,避免每请求读盘。 */
  let sessionSecret = null
  function getSessionSecret() {
    if (sessionSecret === null) {
      try {
        sessionSecret = loadOrCreateSecret({
          dir: certDir(),
          fs: { existsSync, readFileSync, writeFileSync, mkdirSync },
          join
        })
      } catch (err) {
        report("会话密钥", err)
        sessionSecret = randomBytes(32) // 兜底:进程内临时密钥,重启后所有会话失效
      }
    }
    return sessionSecret
  }

  /** 当前登录配置(账号与密码哈希都取 settings 生效值)。 */
  function authConfig() {
    const cfg = safeSource()
    const user = String(cfg?.loginUser ?? "").trim() || DEFAULT_USER
    const hash = String(cfg?.loginPasswordHash ?? "").trim().toLowerCase() || defaultPasswordHash()
    return { enabled: cfg?.loginEnabled !== false, user, hash }
  }

  /** 请求是否带有效会话;登录未启用时恒为真。 */
  function hasValidSession(req) {
    const auth = authConfig()
    if (!auth.enabled) return true
    const token = readCookie(req?.headers?.cookie, COOKIE_NAME)
    return verifySession({ secret: getSessionSecret(), token, user: auth.user })
  }

  function sessionCookie(token, maxAgeSec) {
    return COOKIE_NAME + "=" + token + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + String(maxAgeSec)
  }

  function sendHtml(res, status, html) {
    try {
      res.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'"
      })
      res.end(html)
    } catch (err) {
      report("发送登录页", err)
    }
  }

  /** 只允许站内跳转,避免开放重定向。 */
  function safeNextPath(value) {
    const text = String(value ?? "/")
    return text.startsWith("/") && !text.startsWith("//") ? text : "/"
  }

  /** 读请求体(有上限),回调式,避免在请求回调里 await。 */
  function readBody(req, limit, done) {
    const chunks = []
    let size = 0
    let finished = false
    const finish = (err, body) => {
      if (finished) return
      finished = true
      done(err, body)
    }
    req.on("data", (chunk) => {
      size += chunk.length
      if (size > limit) {
        finish(new Error("请求体过大"), "")
        try { req.destroy() } catch {}
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => finish(null, Buffer.concat(chunks).toString("utf8")))
    req.on("error", (err) => finish(err, ""))
  }

  /**
   * 处理插件自有路径(/__https-fix/login 与 /logout)以及登录门。
   * 返回 true = 本函数已响应,调用方不要再转发。
   */
  function handleAuthRequest(req, res) {
    let url
    try { url = new URL(req.url ?? "/", "https://local.invalid") } catch { url = new URL("/", "https://local.invalid") }
    const auth = authConfig()

    if (url.pathname === LOGOUT_PATH) {
      res.writeHead(303, { "set-cookie": sessionCookie("", 0), location: LOGIN_PATH, "cache-control": "no-store" })
      res.end()
      return true
    }

    if (url.pathname === LOGIN_PATH) {
      if (req.method === "GET" || req.method === "HEAD") {
        sendHtml(res, 200, loginPageHtml({ next: safeNextPath(url.searchParams.get("next")) }))
        return true
      }
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "GET, POST" })
        res.end("method not allowed")
        return true
      }
      readBody(req, MAX_BODY_BYTES, (readErr, body) => {
        guard("处理登录", () => {
          const form = new URLSearchParams(body ?? "")
          const user = String(form.get("user") ?? "")
          const password = String(form.get("password") ?? "")
          const next = safeNextPath(form.get("next"))
          if (readErr) {
            sendHtml(res, 400, loginPageHtml({ error: "请求体读取失败", user, next }))
            return
          }
          if (user === auth.user && safeEqualHex(sha256Hex(password), auth.hash)) {
            const token = issueSession({ secret: getSessionSecret(), user: auth.user, ttlMs: SESSION_TTL_MS })
            res.writeHead(303, {
              "set-cookie": sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000)),
              location: next,
              "cache-control": "no-store"
            })
            res.end()
            logger.info("[https-fix] 登录成功:" + auth.user)
            return
          }
          logger.warn("[https-fix] 登录失败:账号或密码错误(" + (user || "空账号") + ")")
          // 失败延时 300ms,给暴力尝试降速
          setTimeout(() => {
            guard("发送登录失败页", () => sendHtml(res, 401, loginPageHtml({ error: "账号或密码错误", user, next })))
          }, 300)
        })
      })
      return true
    }

    if (!auth.enabled) return false
    if (hasValidSession(req)) return false

    const wantsHtml = req.method === "GET" && String(req.headers?.accept ?? "").includes("text/html")
    if (wantsHtml) {
      sendHtml(res, 200, loginPageHtml({ next: url.pathname + url.search }))
      return true
    }
    res.writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
    res.end(JSON.stringify({ error: "unauthorized", message: "需要登录" }))
    return true
  }

  function stopServer() {
    clearListenRetry()
    if (httpsServer !== null) {
      try { httpsServer.close() } catch {}
      httpsServer = null
      proxy = null
    }
  }

  function startServer(cfg) {
    clearListenRetry()
    const upstream = { host: "127.0.0.1", port: cfg.httpPort ?? actualHttpPort }
    const material = loadCertificate(cfg) // 文件证书或自动自签;失败即抛
    const cert = material.cert
    const key = material.key
    createSecureContext({ cert, key }) // 先校验配对,失败即抛

    proxy = createHttpsProxy({ upstream, tokenProvider: currentToken, log: (msg) => logger.info(`[https-fix] ${msg}`) })
    // 请求/升级/握手回调里的同步抛出会成为 uncaughtException,未处理的
    // socket 'error' 也会带走进程 —— 全部就地收敛成日志。
    const fail = (err, what) => report(what, err)
    httpsServer = createHttpsServer({ cert, key }, (req, res) => {
      try {
        if (proxy === null) {
          res.writeHead(503, { "content-type": "text/plain; charset=utf-8" })
          res.end("https-fix: proxy stopped")
          return
        }
        if (handleAuthRequest(req, res)) return
        proxy.handle(req, res)
      } catch (err) {
        fail(err, "请求转发")
        try {
          if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" })
          res.end()
        } catch {}
      }
    })
    httpsServer.on("upgrade", (req, socket, head) => {
      try {
        socket.on("error", () => {})
        if (proxy === null) {
          socket.destroy()
          return
        }
        if (!hasValidSession(req)) {
          socket.destroy()
          return
        }
        proxy.handleUpgrade(req, socket, head)
      } catch (err) {
        fail(err, "WebSocket 转发")
        try { socket.destroy() } catch {}
      }
    })
    httpsServer.on("clientError", (err, socket) => {
      try { socket.destroy() } catch {}
      if (err && err.code !== "ECONNRESET" && err.code !== "EPIPE") fail(err, "客户端请求")
    })
    httpsServer.on("tlsClientError", (err, socket) => {
      try { socket.destroy() } catch {}
      if (err && err.code !== "ECONNRESET" && err.code !== "EPIPE") fail(err, "TLS 握手")
    })
    const port = cfg.httpsPort
    const bind = cfg.address || "0.0.0.0"
    const self = httpsServer
    httpsServer.on("error", (err) => {
      // 端口被占(重启竞态):重试而不是静默失败。首次落盘,后续只在内存日志里。
      if (err?.code === "EADDRINUSE" && listenRetry.attempts < LISTEN_RETRY_MAX) {
        listenRetry.attempts += 1
        const n = listenRetry.attempts
        const line = `[https-fix] HTTPS 端口 ${port} 被占用(旧进程尚未退出?),${LISTEN_RETRY_DELAY_MS / 1000}s 后重试 (${n}/${LISTEN_RETRY_MAX})`
        logger.warn(line)
        if (n === 1) console.warn(line)
        listenRetry.timer = setTimeout(() => {
          listenRetry.timer = null
          if (httpsServer !== self) return // 已被 stopServer / 新的 startServer 取代
          try { self.listen(port, bind) } catch (e2) { report("HTTPS 重试监听", e2) }
        }, LISTEN_RETRY_DELAY_MS)
        listenRetry.timer.unref?.()
        return
      }
      warnOnce(`[https-fix] HTTPS 服务错误: ${err?.message ?? String(err)}`)
    })
    httpsServer.listen(port, bind, () => {
      if (listenRetry.attempts > 0) {
        const line = `[https-fix] HTTPS 在重试 ${listenRetry.attempts} 次后监听成功于 ${bind}:${port}`
        listenRetry.attempts = 0
        logger.warn(line)
        console.warn(line)
      }
      logger.info(`[https-fix] HTTPS 监听于 ${bind}:${port} → 127.0.0.1:${upstream.port}${material.auto ? "(自动自签证书)" : ""}`)
    })
    activeCert = material
    startedSignature = serverSignature(cfg)
    if (material.auto) {
      certStamp = null
    } else {
      try {
        const s = statSync(material.certPath)
        certStamp = { mtimeMs: s.mtimeMs, size: s.size }
      } catch { certStamp = null }
    }
  }

  function wantHttps(cfg) {
    const c = cfg ?? {}
    return c.enableHttps && !!c.domain && certificateMode(c) !== "invalid"
  }

  /** HTTPS 监听的配置签名:影响监听端口/证书内容的字段变了就重启监听。 */
  function serverSignature(cfg) {
    return [
      certificateMode(cfg),
      String(cfg?.domain ?? ""),
      String(cfg?.httpsPort ?? ""),
      String(cfg?.address ?? ""),
      String(cfg?.httpPort ?? actualHttpPort)
    ].join("|")
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
    const cfg = safeSource()
    ensureTrustedHost(cfg)
    writePatchOverride(cfg)
    if (!wantHttps(cfg)) {
      stopServer()
      return
    }
    const vc = await versionCheckResult(cfg)
    if (vc.block) {
      warnOnce(`[https-fix] ${vc.msg};已停止 HTTPS`)
      stopServer()
      return
    }
    try {
      const signature = serverSignature(cfg)
      if (httpsServer !== null && startedSignature !== signature) stopServer() // 配置变了先停再起,避免端口占用
      if (httpsServer === null) startServer(cfg)
    } catch (err) {
      warnOnce(`[https-fix] 启动 HTTPS 失败: ${err?.stack ?? String(err)}`)
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

  // ── settings 页面策略(dsh 0.1.6 起:表单由 Config 自动投影,这里只关掉自动页) ──
  //
  // 插件自带客户端 tab(settings.plugins.tab),所以告诉 settings 服务不要再按 schema
  // 自动生成本实例的配置页;schema 本身来自上面导出的 Config,无需注册。
  ctx.inject(["settings"], (settingsCtx) => {
    guard("注册设置页策略", () => settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber)))
  })

  // ── 证书热重载(60s stat) ────────────────────────────────────────────────

  ctx.effect(() => {
    const timer = setInterval(() => {
      guard("证书热重载轮询", async () => {
        const cfg = safeSource()
        if (!wantHttps(cfg)) return
        const vc = await versionCheckResult(cfg)
        if (vc.block) {
          stopServer()
          return
        }
        if (certificateMode(cfg) === "paths") {
          try {
            const s = statSync(cfg.certPath)
            if (certStamp !== null && certStamp.mtimeMs === s.mtimeMs && certStamp.size === s.size) return
            stopServer()
            startServer(cfg)
            logger.info("[https-fix] TLS 证书已热重载")
          } catch { /* 证书暂不可读,等待下次轮询 */ }
          return
        }
        // 自动自签:hosts 变化或临近过期时 ensureSelfSignedCertificate 会重签,证书变了就重启监听
        try {
          const next = autoCertificate(cfg)
          if (activeCert === null || activeCert.cert !== next.cert) {
            stopServer()
            startServer(cfg)
            logger.info("[https-fix] 自签证书已更新")
          }
        } catch (err) {
          report("自签证书轮询", err)
        }
      })
    }, 60000)
    if (typeof timer.unref === "function") timer.unref()
    return () => clearInterval(timer)
  }, "https-fix: certificate hot reload")

  // ── 卸载时释放 HTTPS 监听 ───────────────────────────────────────────────

  ctx.effect(() => () => stopServer(), "https-fix: dispose listener")

  // ── RPC 通道 /https-fix(validate / status / 热补丁) ──────────────────────

  // RPC 端点:dsh 0.1.5 用 connection.fetch 精确路由(位于 /api 下,由 dsh 统一做
  // Host/Origin 栅栏 + cookie 鉴权)。旧的 connection.rpc.handle 在 0.1.5 因 owner
  // 上下文缺少 webServer 注入而不可用。
  const RPC_ROUTES = {
    "/api/https-fix/status": "status",
    "/api/https-fix/validate": "validate",
    "/api/https-fix/patch-loopback": "patch-loopback",
    "/api/https-fix/revert-loopback": "revert-loopback",
    "/api/https-fix/patch-status": "patch-status",
    "/api/https-fix/clientlog": "clientlog"
  }

  function rpcEnvelope(rpcId, result) {
    return Response.json({ type: "server-response", rpcId, result })
  }

  async function rpcResponse(endpoint, request) {
    let rpcId = "invalid"
    try {
      let body
      try {
        body = await request.json()
      } catch {
        return rpcEnvelope(rpcId, { ok: false, error: { code: "bad-request", message: "body is not JSON", details: {} } })
      }
      rpcId = body && typeof body.rpcId === "string" ? body.rpcId : "invalid"
      if (!body || body.type !== "client-request") {
        return rpcEnvelope(rpcId, { ok: false, error: { code: "bad-request", message: "invalid client-request message", details: {} } })
      }
      const cfg = safeSource()
      let result
      if (endpoint === "validate") result = await runValidation(cfg)
      else if (endpoint === "status") result = statusView(cfg)
      else if (endpoint === "patch-loopback") result = patchLoopback(cfg)
      else if (endpoint === "revert-loopback") result = revertLoopback()
      else if (endpoint === "patch-status") result = patchStatus()
      else if (endpoint === "clientlog") result = clientLog(body.payload)
      else result = { ok: false, error: { code: "not-found", message: `未知端点 ${endpoint}`, details: {} } }
      return rpcEnvelope(rpcId, result)
    } catch (err) {
      // 处理器自身的异常不能变成未处理 rejection(会触发 dsh 致命退出)。
      report(`RPC ${endpoint}`, err)
      return rpcEnvelope(rpcId, { ok: false, error: { code: "internal", message: err?.message ?? String(err), details: {} } })
    }
  }

  for (const [path, endpoint] of Object.entries(RPC_ROUTES)) {
    ctx.effect(() => ctx.connection.fetch.register({
      path,
      methods: ["POST"],
      requestBody: "buffered",
      fetch: (request) => rpcResponse(endpoint, request)
    }), `https-fix: rpc ${endpoint}`)
  }

  // ── 启动收敛 ────────────────────────────────────────────────────────────
  //
  // dsh 0.1.6 起 settings 不再有 installSection/onChange 回调,设置变更改为
  // 「写 profile patch → Loader 热重载 → 重新 apply 本插件」。所以这里必须显式
  // 收敛一次;否则插件加载后不会启动 HTTPS 监听(60 秒定时器才会兜底)。
  guard("启动收敛", () => reconcile())

  /**
   * 浏览器侧排障出口:卡片读设置失败时把原文回传到这里,落进服务器日志。
   * 卡片上只显示得出"设置不可用",没有这条就只能靠猜浏览器里发生了什么。
   */
  const clientDiagnostics = new Set()
  function clientLog(payload) {
    const where = String(payload?.where ?? "?").slice(0, 60)
    const message = String(payload?.message ?? "").slice(0, 400)
    const line = `[https-fix][client] ${where}: ${message}`
    logger.warn(line)
    if (!clientDiagnostics.has(line) && clientDiagnostics.size < 50) {
      clientDiagnostics.add(line)
      console.warn(line)
    }
    return { ok: true, value: { logged: true } }
  }

  function statusView(cfg) {
    return {
      ok: true,
      value: {
        running: httpsServer !== null,
        httpPort: cfg.httpPort ?? actualHttpPort,
        httpsPort: cfg.httpsPort,
        domain: cfg.domain,
        address: cfg.address || "0.0.0.0",
        certSource: certificateMode(cfg) === "auto" ? "auto-self-signed" : "files",
        serverIps: serverIPv4Addresses(),
        certPath: activeCert?.certPath ?? null,
        enableHttps: cfg.enableHttps,
        blockHttpExternalAccess: cfg.blockHttpExternalAccess,
        versionCheck: cfg.versionCheck,
        autoToken: cfg.autoToken,
        loginEnabled: cfg.loginEnabled !== false,
        loginUser: String(cfg.loginUser ?? "").trim() || DEFAULT_USER,
        loginUsesDefaultPassword: (String(cfg.loginPasswordHash ?? "").trim().toLowerCase() || defaultPasswordHash()) === defaultPasswordHash()
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

  /**
   * 追加的豁免表达式。
   *
   * 用 hostname 而不是 host(含端口):域名前面挂 nginx/其它反代时,浏览器地址栏里的
   * 端口是**对外端口**,与本插件实际监听的 httpsPort 可以不同(例如 nginx 终止 3081、
   * 插件听 3082),按 host 比对会漏豁免,设置页就会显示"不可用"。
   * hostname 维度与 dsh 自身的 isLoopbackHostname() 一致,且与插件注册进
   * trustedHosts 的裸域名(省略端口 = 任意端口)语义对齐。
   */
  function loopbackExemption(cfg) {
    const domain = String(cfg.domain ?? "").trim()
    if (!domain) return ""
    return ` || pageLocation.hostname === ${JSON.stringify(domain)}`
  }

  /** bundle 源码里是否已有针对该域名的豁免(兼容旧的 `host === "域名:端口"` 形式)。 */
  function exemptionPresent(src, cfg) {
    const domain = String(cfg.domain ?? "").trim()
    if (!domain) return false
    const fragments = src.match(exemptionPattern(true)) ?? []
    return fragments.some((fragment) => {
      const quoted = fragment.slice(fragment.indexOf('"'))
      try {
        const value = JSON.parse(quoted)
        return value === domain || value === `${domain}:${cfg.httpsPort}`
      } catch {
        return false
      }
    })
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
      if (exemptionPresent(src, cfg)) return { ok: true, log: ["热补丁已存在"], path }
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
      const next = src.replace(exemptionPattern(true), "")
      if (next === src) return { ok: true, log: ["当前无热补丁"], path }
      writeFileSync(path, next, "utf8")
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
      const patched = exemptionPattern(false).test(src)
      return { ok: true, patched, msg: patched ? "已打热补丁" : "未打热补丁", path }
    } catch (err) {
      return { ok: false, patched: false, msg: `读取失败: ${err?.message ?? String(err)}` }
    }
  }

  // ── 校验逻辑 ─────────────────────────────────────────────────────────────

  /**
   * 把配置的域名注册进 connection 的 Host/Origin 栅栏。
   *
   * dsh 0.1.2 起 /api 只接受回环或 trustedHosts 中的权威;HostConnectionService
   * 持有的是活数组,栅栏每次请求都读它,因此插件可以在运行时补进去,效果等价于
   * 启动参数 `--trusted-host <域名>`(端口可省略,匹配任意端口),用户无需再改启动命令。
   */
  function ensureTrustedHost(cfg) {
    const domain = String(cfg?.domain ?? "").trim()
    if (!domain) return
    try {
      const conn = ctx.get("connection")
      const list = conn?.trustedHosts
      if (!Array.isArray(list)) return
      const authority = cfg.httpsPort ? `${domain}:${cfg.httpsPort}` : ""
      if (list.includes(domain) || (authority !== "" && list.includes(authority))) return
      list.push(domain)
      const msg = `[https-fix] 已把 ${domain} 注册进 trustedHosts(等价 --trusted-host ${domain})`
      logger.info(msg)
      if (!reportedDiagnostics.has(msg) && reportedDiagnostics.size < 100) {
        reportedDiagnostics.add(msg)
        console.warn(msg)
      }
    } catch (err) {
      report("注册受信域名", err)
    }
  }

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
    const auth = authConfig()
    push(auth.enabled, auth.enabled
      ? "登录:已启用(账号 " + auth.user + (auth.hash === defaultPasswordHash() ? ",当前为默认密码" : ",当前为自定义密码") + ")"
      : "登录:未启用——能访问该端口的任何人都能直接进入 dsh")
    const hot = hotPatchCheck(cfg)
    if (hot !== null) push(hot.ok, hot.msg)
    await checkPort(cfg.httpsPort, cfg.address || "0.0.0.0", push)
    checkTls(cfg, push)
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
      if (exemptionPresent(src, cfg)) return { ok: true, msg: `热补丁:已应用(豁免 ${cfg.domain} 域名访问)` }
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

  /**
   * 证书校验:路径证书与自动自签证书都走这里。
   * 名字匹配交给 Node 的 X509Certificate.checkHost/checkIP(SAN 通配、IPv6 归一化都由它处理),
   * 不再手工字符串比对——手工比对认不出 IP 证书的 `IP Address:` SAN。
   */
  function checkTls(cfg, push) {
    const mode = certificateMode(cfg)
    if (mode === "invalid") {
      push(false, "证书配置:cert 与 key 路径需成对填写,或都留空以使用自动自签证书")
      return
    }
    let certPem
    let keyPem
    if (mode === "auto") {
      try {
        const material = autoCertificate(cfg)
        certPem = material.cert
        keyPem = material.key
        push(true, `证书来源:插件自动生成的自签证书(浏览器首次访问需手动信任;SAN 含 ${cfg.domain} 与回环地址)`)
        push(true, `自签证书已就绪: ${material.certPath}(私钥 ${material.keyPath},0600)`)
      } catch (err) {
        push(false, `自动自签证书生成失败: ${err?.message ?? String(err)}`)
        return
      }
    } else {
      try {
        certPem = readFileSync(cfg.certPath)
        push(true, `证书文件可读: ${cfg.certPath}`)
      } catch (err) {
        push(false, `证书文件不可读: ${err?.message ?? String(err)}`)
        return
      }
      try {
        keyPem = readFileSync(cfg.keyPath)
        push(true, `密钥文件可读: ${cfg.keyPath}`)
      } catch (err) {
        push(false, `密钥文件不可读: ${err?.message ?? String(err)}`)
        return
      }
    }

    let x509 = null
    try {
      x509 = new X509Certificate(certPem)
      push(true, `证书解析成功: subject=${x509.subject}`)
    } catch (err) {
      push(false, `证书解析失败: ${err?.message ?? String(err)}`)
    }

    if (x509 !== null && cfg.domain) {
      const isIp = net.isIP(cfg.domain) !== 0
      let hit = false
      try {
        hit = isIp ? !!x509.checkIP(cfg.domain) : !!x509.checkHost(cfg.domain)
      } catch { hit = false }
      const kind = isIp ? "IP" : "域名"
      push(hit, hit
        ? `证书包含${kind} ${cfg.domain}`
        : `证书不包含${kind} ${cfg.domain}(SAN:${x509.subjectAltName ?? "无"})`)
    }

    try {
      createSecureContext({ key: keyPem, cert: certPem })
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
