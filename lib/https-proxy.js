/**
 * dsh-https-fix 的 HTTPS → HTTP 反向代理(纯 Node,零依赖)。
 *
 * 适配 dsh 0.1.2 的网页鉴权模型:
 *  - 每个请求(含 /api、RPC 通道、回环)都要过 Host/Origin 栅栏 + 浏览器 cookie 鉴权;
 *    cookie 绑定在请求权威(Host)上,因此这里**原样转发 Host**,依赖 dsh 启动时的
 *    `--trusted-host <域名>` 通过栅栏。
 *  - 自动模式:对根路径 GET / 请求注入本进程的启动 token(`?token=...`),
 *    dsh 据此签发 cookie 并 303 回干净 URL —— 浏览器侧无需手动带 token。
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

/** 自动模式下给根路径 GET 请求注入进程 token;已持有鉴权 cookie 时不注入(避免 303 循环)。 */
function indexPathWithToken(req, tokenProvider) {
  if (req.method !== "GET") return req.url
  if ((req.headers.cookie ?? "").includes("dsh-auth-")) return req.url
  const token = tokenProvider?.()
  if (token === null || token === undefined || token === "") return req.url
  try {
    const url = new URL(req.url || "/", "http://x")
    if (url.pathname !== "/" || url.searchParams.has("token")) return req.url
    url.searchParams.set("token", token)
    return url.pathname + url.search
  } catch {
    return req.url
  }
}

export function createHttpsProxy({ upstream, tokenProvider }) {
  return {
    handle(req, res) {
      const options = {
        hostname: upstream.host,
        port: upstream.port,
        path: indexPathWithToken(req, tokenProvider),
        method: req.method,
        headers: forwardHeaders(req, false)
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
        headers: forwardHeaders(req, true)
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
