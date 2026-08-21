/**
 * dsh-https-fix 的 HTTPS → HTTP 反向代理(纯 Node,零依赖)。
 *
 * 职责:把到达插件 HTTPS 监听器的请求转发到 dsh 的 HTTP 端口(127.0.0.1:<port>),
 * 并做两件 dsh 需要的事:
 *  1. 对特权路径(/api、/https-fix)改写 Host/Origin 为回环,通过 browser-trust 防护;
 *  2. 对 WebSocket 升级(/api/events.mux、/api/events.host)透传 upgrade。
 * 响应流原样管道、不做缓冲,保证 SSE(/plugins/events)逐帧下发。
 */
import { request as httpRequest } from "node:http"
import { URL } from "node:url"

/** 需要按回环同源改写的特权路径前缀。 */
const PRIVILEGED_PREFIXES = ["/api", "/https-fix"]

/** Node 会自行管理的逐跳头,转发时移除,避免污染上游。 */
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-connection", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade"
])

function forwardHeaders(req, upstream, isUpgrade) {
  const headers = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (HOP_BY_HOP.has(key.toLowerCase())) continue
    headers[key] = value
  }
  const url = new URL(req.url || "/", "http://x")
  const privileged = PRIVILEGED_PREFIXES.some((p) => url.pathname === p || url.pathname.startsWith(p + "/"))
  if (privileged) {
    headers.host = `${upstream.host}:${upstream.port}`
    headers.origin = `http://${upstream.host}:${upstream.port}`
  } else {
    // 非特权路径保留原始 Host(域名:https端口),满足非特权 API 的 Host==Origin 校验
    if (req.headers.host !== undefined) headers.host = req.headers.host
  }
  headers["x-forwarded-proto"] = "https"
  if (isUpgrade) {
    headers.connection = "upgrade"
    if (req.headers.upgrade !== undefined) headers.upgrade = req.headers.upgrade
  }
  return headers
}

export function createHttpsProxy({ upstream }) {
  return {
    handle(req, res) {
      const options = {
        hostname: upstream.host,
        port: upstream.port,
        path: req.url,
        method: req.method,
        headers: forwardHeaders(req, upstream, false)
      }
      const upstreamReq = httpRequest(options, (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
        upstreamRes.pipe(res)
      })
      upstreamReq.on("error", (err) => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" })
        res.end(`upstream error: ${err?.message ?? String(err)}`)
      })
      req.on("error", () => upstreamReq.destroy())
      req.pipe(upstreamReq)
    },

    handleUpgrade(req, socket, head) {
      const options = {
        hostname: upstream.host,
        port: upstream.port,
        path: req.url,
        method: req.method,
        headers: forwardHeaders(req, upstream, true)
      }
      const upstreamReq = httpRequest(options)
      upstreamReq.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
        const statusLine = `HTTP/1.1 101 ${upstreamRes.statusMessage || "Switching Protocols"}`
        const headers = Object.entries(upstreamRes.headers)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
          .join("\r\n")
        socket.write(`${statusLine}\r\n${headers}\r\n\r\n`)
        if (upstreamHead && upstreamHead.length > 0) socket.write(upstreamHead)
        upstreamSocket.pipe(socket)
        socket.pipe(upstreamSocket)
        upstreamSocket.on("error", () => socket.destroy())
        socket.on("error", () => upstreamSocket.destroy())
      })
      upstreamReq.on("error", () => socket.destroy())
      upstreamReq.end(head)
    }
  }
}
