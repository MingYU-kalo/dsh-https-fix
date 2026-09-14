/**
 * 纯 Node 自签证书生成(零依赖)。
 *
 * 用途:不拥有域名、只有公网 IP 时,插件自动签发一张覆盖「配置的域名/IP + 回环」
 * 的自签证书,浏览器首次访问手动信任一次即可;用户也可以随时改回「填证书路径」
 * 使用自有证书(例如 Let's Encrypt 的 IP 证书)。
 *
 * 实现:node:crypto 生成 RSA-2048 密钥,DER 手工编码一张 X.509 v3 自签证书
 * (basicConstraints CA:TRUE + keyUsage + extendedKeyUsage serverAuth + subjectAltName),
 * 用 sha256WithRSA 自签。之所以不用 openssl 子进程:插件运行时只依赖 Node 内建,
 * 不假设目标机器装了 openssl。
 */
import { generateKeyPairSync, sign as signPayload, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isIP } from "node:net"

// ── DER 编码原语 ──────────────────────────────────────────────────────────

/** DER 长度字段(短/长形式都用最小编码)。 */
function derLength(n) {
  if (n < 0x80) return Buffer.from([n])
  const bytes = []
  let v = n
  while (v > 0) { bytes.unshift(v & 0xff); v = Math.floor(v / 256) }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function tlv(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content])
}

const seq = (...items) => tlv(0x30, Buffer.concat(items))
const setOf = (...items) => tlv(0x31, Buffer.concat(items))
const octetString = (buf) => tlv(0x04, buf)
const bitString = (buf) => tlv(0x03, Buffer.concat([Buffer.from([0]), buf]))
const bool = (value) => tlv(0x01, Buffer.from([value ? 0xff : 0x00]))
const nullDer = () => tlv(0x05, Buffer.alloc(0))
const utf8String = (s) => tlv(0x0c, Buffer.from(s, "utf8"))
const ia5String = (s) => tlv(0x16, Buffer.from(s, "ascii"))

/** 正整数 INTEGER(去掉多余前导零;最高位为 1 时补 0x00 保持正数)。 */
function integer(buf) {
  let b = buf
  while (b.length > 1 && b[0] === 0 && (b[1] & 0x80) === 0) b = b.subarray(1)
  if ((b[0] & 0x80) !== 0) b = Buffer.concat([Buffer.from([0]), b])
  return tlv(0x02, b)
}

function oid(dotted) {
  const parts = dotted.split(".").map((n) => Number(n))
  const bytes = [40 * parts[0] + parts[1]]
  for (const part of parts.slice(2)) {
    const chunk = []
    let v = part
    do { chunk.unshift(v & 0x7f); v = Math.floor(v / 128) } while (v > 0)
    for (let i = 0; i < chunk.length - 1; i++) chunk[i] |= 0x80
    bytes.push(...chunk)
  }
  return tlv(0x06, Buffer.from(bytes))
}

/** [n] EXPLICIT 包装(version / extensions 用)。 */
const explicit = (n, content) => tlv(0xa0 | n, content)

function utcTime(date) {
  const p = (n) => String(n).padStart(2, "0")
  const s = p(date.getUTCFullYear() % 100) + p(date.getUTCMonth() + 1) + p(date.getUTCDate()) +
    p(date.getUTCHours()) + p(date.getUTCMinutes()) + p(date.getUTCSeconds()) + "Z"
  return tlv(0x17, Buffer.from(s, "ascii"))
}

// ── IP 地址 → 字节 ────────────────────────────────────────────────────────

function ipv4Bytes(ip) {
  const parts = ip.split(".")
  if (parts.length !== 4) return null
  const bytes = parts.map((p) => Number(p))
  if (bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) return null
  return Buffer.from(bytes)
}

/** IPv6(含 :: 缩写与 IPv4-mapped 尾缀)转 16 字节。 */
function ipv6Bytes(input) {
  let s = input.includes("%") ? input.slice(0, input.indexOf("%")) : input
  if (s.includes(".")) {
    const idx = s.lastIndexOf(":")
    const v4 = ipv4Bytes(s.slice(idx + 1))
    if (v4 === null) return null
    const g1 = ((v4[0] << 8) | v4[1]).toString(16)
    const g2 = ((v4[2] << 8) | v4[3]).toString(16)
    s = s.slice(0, idx) + ":" + g1 + ":" + g2
  }
  const halves = s.split("::")
  if (halves.length > 2) return null
  const left = halves[0] === "" ? [] : halves[0].split(":")
  const right = halves.length === 2 ? (halves[1] === "" ? [] : halves[1].split(":")) : []
  const groups = [...left, ...right]
  if (groups.some((g) => g === "" || !/^[0-9a-fA-F]{1,4}$/.test(g))) return null
  let full
  if (halves.length === 2) {
    const missing = 8 - groups.length
    if (missing < 0) return null
    full = [...left, ...new Array(missing).fill("0"), ...right]
  } else {
    if (groups.length !== 8) return null
    full = groups
  }
  const bytes = []
  for (const g of full) {
    const n = parseInt(g, 16)
    bytes.push((n >> 8) & 0xff, n & 0xff)
  }
  return Buffer.from(bytes)
}

/** IP 字符串转字节(非 IP 返回 null)。 */
export function ipToBytes(ip) {
  const text = String(ip ?? "").trim()
  const version = isIP(text)
  if (version === 4) return ipv4Bytes(text)
  if (version === 6) return ipv6Bytes(text)
  return null
}

// ── 证书生成 ──────────────────────────────────────────────────────────────

const OIDS = {
  sha256WithRSA: "1.2.840.113549.1.1.11",
  commonName: "2.5.4.3",
  organizationName: "2.5.4.10",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  extKeyUsage: "2.5.29.37",
  subjectAltName: "2.5.29.17",
  serverAuth: "1.3.6.1.5.5.7.3.1"
}

function algorithmIdentifier() {
  return seq(oid(OIDS.sha256WithRSA), nullDer())
}

function rdn(oidDotted, value) {
  return setOf(seq(oid(oidDotted), utf8String(value)))
}

function distinguishedName(commonName, organization) {
  const items = []
  if (organization) items.push(rdn(OIDS.organizationName, organization))
  items.push(rdn(OIDS.commonName, commonName))
  return seq(...items)
}

function extension(oidDotted, critical, value) {
  const head = critical ? [oid(oidDotted), bool(true), octetString(value)] : [oid(oidDotted), octetString(value)]
  return seq(...head)
}

function subjectAltName(dnsNames, ipAddresses) {
  const names = []
  // GeneralName: dNSName 是 [2] IMPLICIT IA5String(0x82),iPAddress 是 [7] IMPLICIT OCTET STRING(0x87)
  for (const name of dnsNames) names.push(tlv(0x82, Buffer.from(name, "ascii")))
  for (const ip of ipAddresses) names.push(tlv(0x87, ipToBytes(ip)))
  return seq(...names)
}

function pem(label, der) {
  const body = der.toString("base64").replace(/(.{64})/g, "$1" + String.fromCharCode(10)).replace(/\n$/, "")
  return "-----BEGIN " + label + "-----" + String.fromCharCode(10) + body + String.fromCharCode(10) + "-----END " + label + "-----" + String.fromCharCode(10)
}

/**
 * 生成一张自签证书。
 * hosts: 覆盖的域名/IP 列表(至少一个);days: 有效期天数。
 * 返回 cert/key(都是 PEM 字符串)与 subject/notAfter/dnsNames/ipAddresses。
 */
export function createSelfSignedCertificate({ hosts, days = 3650, organization = "dsh-https-fix self-signed" }) {
  const dnsNames = [...new Set(hosts.map((h) => String(h).trim()).filter((h) => h !== "" && isIP(h) === 0))]
  const ipAddresses = [...new Set(hosts.map((h) => String(h).trim()).filter((h) => isIP(h) !== 0))]
  if (dnsNames.length === 0 && ipAddresses.length === 0) throw new Error("自签证书至少需要一个域名或 IP")
  const preferred = String(hosts[0] ?? "").trim()
  const commonName = (preferred !== "" ? preferred : String(dnsNames[0] ?? ipAddresses[0])).slice(0, 64)

  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const now = Date.now()
  const notBefore = new Date(now - 3600000)
  const notAfter = new Date(now + days * 86400000)

  const serial = randomBytes(16)
  serial[0] &= 0x7f
  if (serial.every((b) => b === 0)) serial[serial.length - 1] = 1

  const extensions = [
    extension(OIDS.basicConstraints, true, seq(bool(true))),
    extension(OIDS.keyUsage, true, bitString(Buffer.from([0xa4]))),
    extension(OIDS.extKeyUsage, false, seq(oid(OIDS.serverAuth))),
    extension(OIDS.subjectAltName, false, subjectAltName(dnsNames, ipAddresses))
  ]

  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    algorithmIdentifier(),
    distinguishedName(commonName, organization),
    seq(utcTime(notBefore), utcTime(notAfter)),
    distinguishedName(commonName, organization),
    publicKey.export({ type: "spki", format: "der" }),
    explicit(3, seq(...extensions))
  )

  const signature = signPayload("sha256", tbs, privateKey)
  const certificate = seq(tbs, algorithmIdentifier(), bitString(signature))

  return {
    cert: pem("CERTIFICATE", certificate),
    key: String(privateKey.export({ type: "pkcs8", format: "pem" })),
    subject: "CN=" + commonName,
    notAfter: notAfter.toISOString(),
    dnsNames,
    ipAddresses
  }
}

// ── 持久化 ────────────────────────────────────────────────────────────────

function writeAtomic(path, data, mode) {
  const tmp = path + ".tmp-" + process.pid + "-" + randomBytes(4).toString("hex")
  writeFileSync(tmp, data, { mode })
  renameSync(tmp, path)
}

/**
 * 确保目录下有一张覆盖 hosts 的自签证书;hosts 变化或临近过期时自动重签。
 * 证书/密钥/元数据写在同一个目录,私钥 0600。renewDays: 剩余有效期低于该天数就重签。
 * 返回 cert/key(PEM)、certPath/keyPath、generated(本次是否重签)、notAfter、dnsNames、ipAddresses。
 */
export function ensureSelfSignedCertificate({ dir, hosts, days = 3650, renewDays = 30 }) {
  const created = createSelfSignedCertificate({ hosts, days })
  const want = JSON.stringify({ dns: [...created.dnsNames].sort(), ips: [...created.ipAddresses].sort(), days })
  const certPath = join(dir, "self-signed.crt")
  const keyPath = join(dir, "self-signed.key")
  const metaPath = join(dir, "self-signed.json")

  if (existsSync(certPath) && existsSync(keyPath) && existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf8"))
      const notAfter = Date.parse(meta && meta.notAfter ? meta.notAfter : "")
      if (meta && meta.want === want && Number.isFinite(notAfter) && notAfter - Date.now() > renewDays * 86400000) {
        return {
          cert: readFileSync(certPath, "utf8"),
          key: readFileSync(keyPath, "utf8"),
          certPath, keyPath, generated: false,
          notAfter: new Date(notAfter).toISOString(),
          dnsNames: created.dnsNames, ipAddresses: created.ipAddresses
        }
      }
    } catch { /* 元数据损坏 → 重新签发 */ }
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeAtomic(certPath, created.cert, 0o644)
  writeAtomic(keyPath, created.key, 0o600)
  writeAtomic(metaPath, JSON.stringify({
    want,
    dns: created.dnsNames,
    ips: created.ipAddresses,
    notAfter: created.notAfter,
    generatedAt: new Date().toISOString()
  }, null, 2) + String.fromCharCode(10), 0o600)

  return { ...created, certPath, keyPath, generated: true }
}
