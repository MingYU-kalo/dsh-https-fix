/**
 * dsh-https-fix 的 HTTPS → HTTP 反向代理(纯 Node,零依赖)。
 *
 * 适配 dsh 0.1.2 的网页鉴权模型:
 *  - 每个请求(含 /api、RPC 通道、回环)都要过 Host/Origin 栅栏 + 浏览器 cookie 鉴权;
 *    cookie 绑定在请求权威(Host)上,因此这里**原样转发 Host**,依赖 dsh 启动时的
 *    `--trusted-host <域名>` 通过栅栏。
 *  - 自动模式:插件**在服务端完成 token 交换**(用本进程启动 token 换出会话 cookie),
 *    并把该 cookie 注入上游请求、同时下发给浏览器。这样浏览器即使不保存 cookie 也不会
 *    陷入 303 重定向循环(根因:浏览器未回传 cookie 时,"注入 token→303"会无限循环)。
 *  - 关闭自动模式:不做任何交换,直接透传(等同原始 http 模式,需自行带 token URL)。
 *
 * 响应流原样管道、不做缓冲,保证 SSE(/plugins/events)逐帧下发;WebSocket 升级透传。
 */
import { request as httpRequest } from "node:http"
import { URL } from "node:url"

/** Node 会自行管理的逐跳头,转发时移除,避免污染上游。 */
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-connection", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade"
])

function forwardHeaders(req, isUpgrade) {
  const headers = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (HOP_BY_HOP.has(key.toLowerCase())) continue
    headers[key] = value
  }
  headers["x-forwarded-proto"] = "https"
  if (isUpgrade) {
    headers.connection = "upgrade"
    if (req.headers.upgrade !== undefined) headers.upgrade = req.headers.upgrade
  }
  return headers
}

/** 给上游下发的 Set-Cookie 补上 Secure(本代理跑在 HTTPS 上)。 */
function secureCookies(headers) {
  const raw = headers["set-cookie"]
  if (raw === undefined) return headers
  const list = Array.isArray(raw) ? raw : [raw]
  headers["set-cookie"] = list.map((cookie) => /(^|;)\s*secure\s*(;|$)/i.test(cookie) ? cookie : `${cookie}; Secure`)
  return headers
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000

export function createHttpsProxy({ upstream, tokenProvider, log }) {
  /** 每个权威(Host)一份由插件代为持有的会话 cookie。 */
  const sessions = new Map()

  /** 用进程启动 token 换一次会话 cookie(Set-Cookie 首段)。 */
  function exchangeToken(token, authority, done) {
    let req
    try {
      req = httpRequest({
        hostname: upstream.host,
        port: upstream.port,
        path: `/?token=${encodeURIComponent(token)}`,
        method: "GET",
        headers: { host: authority }
      }, (res) => {
        res.resume()
        const raw = res.headers["set-cookie"]
        const first = Array.isArray(raw) ? raw[0] : raw
        done(typeof first === "string" ? first.split(";")[0] : null)
      })
    } catch {
      done(null)
      return
    }
    req.on("error", () => done(null))
    req.end()
  }

  /** 取(必要时换取)某权威的会话 cookie 名值对。 */
  function sessionCookieFor(token, authority, done) {
    const cached = sessions.get(authority)
    if (cached !== undefined && Date.now() - cached.at < SESSION_TTL_MS) return done(cached.pair)
    exchangeToken(token, authority, (pair) => {
      if (pair !== null && pair !== "") sessions.set(authority, { pair, at: Date.now() })
      done(pair)
    })
  }

  /**
   * 转发普通请求;cookieOverride 覆盖上游 Cookie,setCookie 额外下发浏览器。
   * httpRequest 对非法头/路径会同步抛出,而调用方是 https 服务器的请求回调,
   * 同步抛出即 uncaughtException → 整个 dsh 进程退出,因此这里必须自兜底。
   */
  function forward(req, res, cookieOverride, setCookie) {
    try {
      const headers = forwardHeaders(req, false)
      if (cookieOverride !== null && cookieOverride !== undefined) headers.cookie = cookieOverride
      const upstreamReq = httpRequest({
        hostname: upstream.host,
        port: upstream.port,
        path: req.url,
        method: req.method,
        headers
      }, (upstreamRes) => {
        try {
          const out = { ...upstreamRes.headers }
          if (setCookie !== null && setCookie !== undefined && setCookie !== "") {
            const existing = out["set-cookie"]
            out["set-cookie"] = existing === undefined
              ? [setCookie]
              : (Array.isArray(existing) ? [...existing, setCookie] : [existing, setCookie])
          }
          res.writeHead(upstreamRes.statusCode ?? 502, secureCookies(out))
          // 任一侧断开都不能留下未处理的 'error' 事件。
          upstreamRes.on("error", () => { try { res.destroy() } catch {} })
          res.on("error", () => { try { upstreamRes.destroy() } catch {} })
          upstreamRes.pipe(res)
        } catch (err) {
          try {
            if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" })
            res.end(`proxy response error: ${err?.message ?? String(err)}`)
          } catch {}
        }
      })
      upstreamReq.on("error", (err) => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" })
        res.end(`upstream error: ${err?.message ?? String(err)}`)
      })
      req.on("error", () => upstreamReq.destroy())
      req.pipe(upstreamReq)
    } catch (err) {
      try {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" })
        res.end(`proxy error: ${err?.message ?? String(err)}`)
      } catch {}
    }
  }

  /** 转发 WebSocket 升级。 */
  function forwardUpgrade(req, socket, head, cookieOverride) {
    socket.on("error", () => {})
    try {
      const headers = forwardHeaders(req, true)
      if (cookieOverride !== null && cookieOverride !== undefined) headers.cookie = cookieOverride
      const upstreamReq = httpRequest({
        hostname: upstream.host,
        port: upstream.port,
        path: req.url,
        method: req.method,
        headers
      })
      upstreamReq.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
        try {
          const statusLine = `HTTP/1.1 101 ${upstreamRes.statusMessage || "Switching Protocols"}`
          const lines = Object.entries(upstreamRes.headers)
            .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
            .join("\r\n")
          socket.write(`${statusLine}\r\n${lines}\r\n\r\n`)
          if (upstreamHead && upstreamHead.length > 0) socket.write(upstreamHead)
          upstreamSocket.pipe(socket)
          socket.pipe(upstreamSocket)
          upstreamSocket.on("error", () => socket.destroy())
          socket.on("error", () => upstreamSocket.destroy())
        } catch {
          try { socket.destroy() } catch {}
        }
      })
      upstreamReq.on("error", () => { try { socket.destroy() } catch {} })
      upstreamReq.end(head)
    } catch {
      try { socket.destroy() } catch {}
    }
  }

  return {
    handle(req, res) {
      try {
        const token = tokenProvider?.()
        const authority = req.headers.host
        const hasAuth = (req.headers.cookie ?? "").includes("dsh-auth-")
        if (token && !hasAuth && authority !== undefined) {
          sessionCookieFor(token, authority, (pair) => {
            if (typeof log === "function") log(`auto-token: ${authority} session=${pair ? "ok" : "fail"} ${req.method} ${req.url}`)
            forward(req, res, pair, pair)
          })
          return
        }
        forward(req, res, null, null)
      } catch (err) {
        try {
          if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" })
          res.end(`proxy error: ${err?.message ?? String(err)}`)
        } catch {}
      }
    },

    handleUpgrade(req, socket, head) {
      try {
        socket.on("error", () => {})
        const token = tokenProvider?.()
        const authority = req.headers.host
        const hasAuth = (req.headers.cookie ?? "").includes("dsh-auth-")
        if (token && !hasAuth && authority !== undefined) {
          sessionCookieFor(token, authority, (pair) => forwardUpgrade(req, socket, head, pair))
          return
        }
        forwardUpgrade(req, socket, head, null)
      } catch {
        try { socket.destroy() } catch {}
      }
    }
  }
}
