/**
 * dsh-https-fix 客户端卡片(settings 插件页)回归测试。
 *
 * 用法(依赖不写进插件 package.json,按需临时安装):
 *   npm i --no-save react@18 react-dom@18 jsdom
 *   node test/ui-harness.mjs [客户端 bundle 路径,默认 ../lib/client.js]
 *
 * 覆盖:折叠/展开、状态徽标、字段回显与改动、一键填入当前地址、证书来源切换、
 * 校验结果汇总、热补丁消息、保存/放弃/恢复默认、三次确认、只读与不可用态。
 * 退出码非 0 表示有断言失败。
 */
import { createRequire } from "node:module"
import { pathToFileURL, fileURLToPath } from "node:url"

// 依赖从「运行命令时的当前目录」解析:在仓库根目录 npm i --no-save react@18 react-dom@18 jsdom 再跑
const require = createRequire(process.cwd() + "/")
const { JSDOM } = await import(pathToFileURL(require.resolve("jsdom")).href)
const React = require("react")
const ReactDOM = require("react-dom/client")
const { Simulate } = require("react-dom/test-utils")
const jsxRuntime = require("react/jsx-runtime")
const { act } = React

const dom = new JSDOM("<!doctype html><html><head></head><body><ul id='root'></ul></body></html>", { url: "https://203.0.113.7:3081/settings" })
global.window = dom.window
global.document = dom.window.document
Object.defineProperty(global, "navigator", { value: dom.window.navigator, configurable: true })
global.IS_REACT_ACT_ENVIRONMENT = true
let confirmCount = 0
dom.window.confirm = () => { confirmCount++; return true }

let snapshot = {
  status: "ready", writable: true, revision: 3, mode: "host",
  value: { enableHttps: true, domain: "old.example.com", httpsPort: 3081, address: "", certPath: "", keyPath: "", autoToken: true, versionCheck: true, blockHttpExternalAccess: false },
  base: { httpPort: 3080 },
  user: { domain: "old.example.com" }
}
const listeners = new Set()
const calls = []
const controller = {
  subscribe: (cb) => { listeners.add(cb); return () => listeners.delete(cb) },
  getSnapshot: () => snapshot,
  set: async (k, v) => { calls.push(["set", k, v]); snapshot = { ...snapshot, value: { ...snapshot.value, [k]: v }, user: { ...snapshot.user, [k]: v } }; listeners.forEach((l) => l()) },
  unset: async (k) => { calls.push(["unset", k]); const u = { ...snapshot.user }; delete u[k]; snapshot = { ...snapshot, user: u }; listeners.forEach((l) => l()) }
}

global.fetch = async (url, init) => {
  JSON.parse(init.body)
  let result
  if (url.endsWith("/status")) result = { ok: true, value: { running: true, httpsPort: 3081, domain: "old.example.com", certSource: "auto-self-signed", certPath: "/root/.dsh/https-fix/self-signed.crt", enableHttps: true } }
  else if (url.endsWith("/patch-status")) result = { ok: true, patched: false, msg: "未打热补丁" }
  else if (url.endsWith("/validate")) result = { ok: false, log: [{ ok: true, msg: "版本核对:dsh 0.1.5-rc.2 一致" }, { ok: false, msg: "热补丁:未应用" }] }
  else if (url.endsWith("/patch-loopback")) result = { ok: true, log: ["已写入热补丁"] }
  else if (url.endsWith("/revert-loopback")) result = { ok: true, log: ["已还原"] }
  else result = { ok: true }
  return { json: async () => ({ type: "server-response", rpcId: "t", result }) }
}

const clientFile = process.argv[2] ?? fileURLToPath(new URL("../lib/client.js", import.meta.url))
let def = null
dom.window.__ModuleLoader__ = { load: (d) => { def = d } }
await import(pathToFileURL(clientFile).href)
const mod = def.factory((n) => (n === "react" ? React : n === "react/jsx-runtime" ? jsxRuntime : require(n)))

let Card = null
mod.apply({ settingsScope: { bind: () => controller }, slots: { inject: (name, fn) => fn(), register: (spec, comp) => { Card = comp } } })

const results = []
const check = (name, cond, extra) => { results.push([cond ? "PASS" : "FAIL", name, extra ?? ""]) }
const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => Array.from(document.querySelectorAll(sel))
const text = (sel) => ($(sel) ? $(sel).textContent : "<missing>")
const byText = (tag, t) => $$(tag).find((e) => e.textContent === t)
const labelFor = (t) => $$("label.hf_label").find((l) => l.textContent === t).htmlFor
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

const root = ReactDOM.createRoot($("#root"))
await act(async () => { root.render(React.createElement(Card, { controller })) })
await flush()

check("卡片标题渲染", text(".hf_name") === "Https Fix")
check("头部状态徽标=运行中", text(".hf_badge").includes("运行中 old.example.com:3081") && text(".hf_badge").includes("自签"), text(".hf_badge"))
check("默认折叠(无 body)", $(".hf_body") === null)

await act(async () => { $(".hf_header").click() })
check("展开后出现四个分组", ["HTTPS 服务", "TLS 证书", "访问与安全", "诊断"].every((t) => $$(".hf_sectionTitle").some((e) => e.textContent === t)), $$(".hf_sectionTitle").map((e) => e.textContent).join(" | "))
check("访问入口预览", text(".hf_url").includes("https://old.example.com:3081/"), text(".hf_url"))
check("域名输入框回显", $("#" + labelFor("域名 / IP")).value === "old.example.com")
check("用户改过的项有恢复默认", $$(".hf_inlineBtn").some((b) => b.textContent === "恢复默认"))
check("自动自签说明块存在", $$(".hf_note").length === 1 && text(".hf_note").includes("self-signed.crt"))

// 改域名 -> 未保存
const domainInput = $("#" + labelFor("域名 / IP"))
await act(async () => { Simulate.change(domainInput, { target: { value: "new.example.com" } }) })
check("改动后出现未保存徽标", text(".hf_pending") === "未保存", text(".hf_pending"))
check("页脚提示改动数量", text(".hf_footerNote").includes("1 项改动未保存"), text(".hf_footerNote"))
check("访问入口跟随改动", text(".hf_url").includes("https://new.example.com:3081/"), text(".hf_url"))

// 一键填入当前地址
await act(async () => { byText("button", "填入当前地址").click() })
check("一键填入当前地址栏 host", domainInput.value === "203.0.113.7", domainInput.value)

// 校验
await act(async () => { byText("button", "校验 HTTPS 可用性").click() })
await flush()
check("校验结果摘要", text(".hf_summary").includes("1/2 项需要处理"), text(".hf_summary"))
check("校验条目渲染两条", $$(".hf_log span").length === 2, String($$(".hf_log span").length))

// 热补丁
await act(async () => { byText("button", "一键打热补丁").click() })
await flush()
check("热补丁结果渲染", $$(".hf_log span").some((s) => s.textContent.includes("已写入热补丁")))

// 保存
await act(async () => { byText("button", "保存配置").click() })
await flush()
check("保存写入 staged 字段", calls.some((c) => c[0] === "set" && c[1] === "domain" && c[2] === "203.0.113.7"), JSON.stringify(calls.filter((c) => c[0] === "set")))
check("保存后未保存徽标消失", $(".hf_pending") === null)

// 恢复默认
const resetBtn = byText("button", "恢复默认")
check("恢复默认按钮存在", !!resetBtn)
await act(async () => { resetBtn.click() })
await flush()
check("恢复默认调用 controller.unset", calls.some((c) => c[0] === "unset" && c[1] === "domain"), JSON.stringify(calls))

// 证书模式:切到自定义路径应出现两个输入框
const radios = $$(".hf_choiceRow input[type=radio]")
await act(async () => { radios[1].click() })
check("切到自定义证书显示路径输入", $("#" + labelFor("cert 路径")) !== null && $("#" + labelFor("key 路径")) !== null)
await act(async () => { Simulate.change($("#" + labelFor("cert 路径")), { target: { value: "/etc/ssl/a.pem" } }) })
check("只填 cert 时提示成对填写", $$(".hf_warn").length === 1, text(".hf_warn"))
await act(async () => { Simulate.change($("#" + labelFor("key 路径")), { target: { value: "/etc/ssl/a.key" } }) })
check("成对填写后提示消失", $$(".hf_warn").length === 0)
await act(async () => { radios[0].click() })
check("切回自动自签显示说明块", $$(".hf_note").length === 1)

// 关闭版本核对:三次确认 + 待保存 + 保存
confirmCount = 0
await act(async () => { $("#" + labelFor("核对版本号")).click() })
check("关闭核对版本号触发三次确认", confirmCount === 3, "confirm=" + confirmCount)
check("关闭后进入待保存状态", text(".hf_pending") === "未保存", text(".hf_pending"))
await act(async () => { byText("button", "保存配置").click() })
await flush()
check("保存后写入 versionCheck=false", calls.some((c) => c[0] === "set" && c[1] === "versionCheck" && c[2] === false), JSON.stringify(calls.filter((c) => c[0] === "set")))

// 放弃修改
await act(async () => { Simulate.change($("#" + labelFor("域名 / IP")), { target: { value: "discard.me" } }) })
check("改动后可放弃", byText("button", "放弃修改").disabled === false)
await act(async () => { byText("button", "放弃修改").click() })
check("放弃后未保存徽标消失", $(".hf_pending") === null)

// 只读
snapshot = { ...snapshot, writable: false }
await act(async () => { listeners.forEach((l) => l()) })
check("只读时显示提示", $$(".hf_readOnly").length === 1, text(".hf_readOnly"))
check("只读时保存按钮禁用", byText("button", "保存配置").disabled === true)

// 设置不可用
snapshot = { ...snapshot, status: "unavailable", writable: false }
await act(async () => { listeners.forEach((l) => l()) })
check("不可用时徽标提示", text(".hf_badge") === "设置不可用", text(".hf_badge"))

console.log(results.map((r) => r[0].padEnd(5) + r[1] + (r[2] ? "   [" + r[2] + "]" : "")).join("\n"))
const failed = results.filter((r) => r[0] === "FAIL").length
console.log("\n" + (results.length - failed) + "/" + results.length + " 通过")
process.exit(failed === 0 ? 0 : 1)
