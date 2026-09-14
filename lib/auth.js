/**
 * 登录系统的最小实现(host 侧,零依赖)。
 *
 * - 账号明文保存在 settings(loginUser);密码只保存 SHA-256 十六进制(loginPasswordHash)。
 * - 会话是无状态 HMAC 令牌:base64url(payload).base64url(hmac),payload = v1|user|expMs。
 *   密钥首次生成后落在 $DSH_HOME/https-fix/session.key(0600),重启后会话仍有效。
 * - 校验一律用 timingSafeEqual,避免按字节比较泄漏信息。
 *
 * 注意:这是"挡在插件 HTTPS 端口前面"的一道门,不是 dsh 的鉴权层;
 * dsh 自身的 token/会话鉴权仍然照常工作(插件代理时会自动换取上游 cookie)。
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"

/** 默认账号 / 默认密码(忘记密码面板也用它)。 */
export const DEFAULT_USER = "admin"
export const DEFAULT_PASSWORD = "admin"

/** SHA-256 十六进制;非字符串按空串处理。 */
export function sha256Hex(text) {
  return createHash("sha256").update(typeof text === "string" ? text : "", "utf8").digest("hex")
}

/** 默认密码的哈希(settings 的默认值)。 */
export function defaultPasswordHash() {
  return sha256Hex(DEFAULT_PASSWORD)
}

/** 定长比较两个十六进制字符串;长度不同或非字符串直接判否。 */
export function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false
  const left = Buffer.from(a, "utf8")
  const right = Buffer.from(b, "utf8")
  if (left.length !== right.length) return false
  try {
    return timingSafeEqual(left, right)
  } catch {
    return false
  }
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromB64url(text) {
  const padded = String(text).replace(/-/g, "+").replace(/_/g, "/")
  return Buffer.from(padded, "base64")
}

function sign(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest()
}

/** 签发会话令牌;ttlMs 之后失效。 */
export function issueSession({ secret, user, ttlMs }) {
  const payload = "v1|" + String(user) + "|" + String(Date.now() + ttlMs)
  const payloadPart = b64url(payload)
  return payloadPart + "." + b64url(sign(payloadPart, secret))
}

/**
 * 校验会话令牌:签名正确、未过期、且账号与当前配置一致。
 * 任何异常都返回 false(不抛)。
 */
export function verifySession({ secret, token, user }) {
  try {
    if (typeof token !== "string" || token === "") return false
    const dot = token.indexOf(".")
    if (dot <= 0) return false
    const payloadPart = token.slice(0, dot)
    const signaturePart = token.slice(dot + 1)
    const expected = b64url(sign(payloadPart, secret))
    if (!safeEqualHex(signaturePart, expected)) return false
    const payload = fromB64url(payloadPart).toString("utf8")
    const parts = payload.split("|")
    if (parts.length !== 3 || parts[0] !== "v1") return false
    if (parts[1] !== String(user)) return false
    const expires = Number(parts[2])
    return Number.isFinite(expires) && Date.now() < expires
  } catch {
    return false
  }
}

/** 从 Cookie 头里取一个值;取不到返回空串。 */
export function readCookie(header, name) {
  if (typeof header !== "string" || header === "") return ""
  for (const part of header.split(";")) {
    const eq = part.indexOf("=")
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return ""
}

/**
 * 读取或生成会话密钥(0600,只写一次)。
 * 失败时抛错,由调用方 guard 收敛;调用方需缓存结果,不要每请求都读盘。
 */
export function loadOrCreateSecret({ dir, fs, join }) {
  const path = join(dir, "session.key")
  if (fs.existsSync(path)) {
    const text = fs.readFileSync(path, "utf8").trim()
    if (/^[0-9a-f]{64}$/.test(text)) return Buffer.from(text, "hex")
  }
  const secret = randomBytes(32)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path, secret.toString("hex") + String.fromCharCode(10), { mode: 0o600 })
  return secret
}
