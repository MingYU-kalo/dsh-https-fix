# dsh-https-fix 详细项目需求

> 版本：v0.2（定稿版，已并入用户决策） · 目标平台：DeepSeek Harness (dsh) 0.1.1-rc.2
> 项目仓库：`dsh-https-fix`（公开，GitHub 账号 `MingYU-kalo`）
> 分支策略：`main` 始终为最新代码；版本分支按 dsh 版本号命名，本期为 `dsh-0.1.1-rc.2`

---

## 1. 项目背景与目标

DeepSeek Harness 的 Web GUI（`dsh web`）默认只提供 **HTTP** 监听（`dsh-host-webserver` 服务，绑定 `127.0.0.1` 或 `0.0.0.0`，端口默认 3080，由启动参数 `webStartup.port` 决定）。要在公网通过域名安全访问，目前只能依赖外部反向代理（如 nginx + 证书），并且会遇到几类典型问题：

1. SSE 事件通道（`/plugins/events`）被代理缓冲导致页面挂起；
2. 客户端 `connection.isLoopback` 只看 `location.hostname`，经域名访问时设置页全部降级为不可用；
3. Host/Origin 与 dsh 的 browser-trust 防护不匹配导致 403；
4. 证书、端口、域名配置分散在 nginx/系统层面，无法在 Harness 的 UI 中统一管理。

**本插件目标**：为 dsh 增加一套"内置 HTTPS 反代 + 可配置管理"能力——在 **设置 → 插件配置 → Https Fix** 中集中配置 HTTP 端口、外网访问开关、HTTPS 开关、端口、域名、证书/密钥路径，并提供"校验 HTTPS 可用性"与"保存配置"操作。插件自身维护一个 HTTPS 监听器，把流量安全地反代进 dsh 的 HTTP 端口，使"域名 + HTTPS"开箱即用，无需外部 nginx。

---

## 2. 功能需求（配置项逐条定义，已并入 2026-08-22 用户决策）

插件在设置页的"插件配置"区块注册一张卡片（settings 命名空间 `https-fix`）。字段如下：

| # | 字段 | 类型 | 默认值 | 约束/规则 | 生效方式 |
|---|------|------|--------|-----------|----------|
| F1 | 关闭http外网访问 (blockHttpExternalAccess) | 布尔 | **false** | **用户决策①**：原"启用http端口"改为本语义。true 时插件向 `$DSH_HOME/cordis.patch.yml` 写入 webserver 行覆盖 `host: 127.0.0.1`（机器级补丁层，重启后 http 仅回环可达）；false 时移除插件写入的该项覆盖 | 重启 dsh 后 |
| F2 | http端口 (httpPort) | 整数 | 无默认值；初始值 = dsh 配置中的 http 端口（`webServer` 当前实际端口） | 1–65535。**用户决策②**：保存时插件自动改写 `$DSH_HOME/cordis.patch.yml` 中 webserver 行的 `port`，重启 dsh 生效 | 重启后 |
| F3 | 启用https (enableHttps) | 布尔 | **false** | 置 true 前自动执行一次完整校验（同 F9），**全部通过才允许为 true**；为 true 时自动启动 HTTPS 服务。true 时证书路径、密钥路径、域名必填 | 即时 |
| F4 | https端口 (httpsPort) | 整数 | **3081** | 1–65535 | 即时 |
| F5 | 域名 (domain) | 字符串 | 空 | 启用https 时**必填**；用于 Host 透传与证书域名校验 | 即时 |
| F6 | 地址 (address) | 字符串 | 空 | 多网卡时指定 HTTPS 监听 IP；留空 = 监听所有网卡 `0.0.0.0`。备注可留空 | 即时 |
| F7 | TLS证书(cert)路径 (certPath) | 字符串 | 空 | 启用https 时**必填**；文件必须可读、PEM 格式、证书域名含 F5 | 即时 |
| F8 | TLS密钥(Key)路径 (keyPath) | 字符串 | 空 | 启用https 时**必填**；文件必须可读、与 F7 证书配对 | 即时 |
| F9 | 校验https可用性（按钮） | 动作 | — | 校验：HTTPS 端口可监听、证书/密钥可加载且配对、域名可解析（**用户决策③：仅检查可解析**，不要求解析结果指向本机）；逐项输出日志到卡片 | 即时 |
| F10 | 保存配置（按钮） | 动作 | — | 把当前表单一次性写入 settings 命名空间 `https-fix`（`settings.update` 写路径），写后自动重读；F1/F2 同时触发补丁文件改写 | 即时 |

### 2.1 行为细则

- **F3 的校验门**：`enableHttps` 从 false 切到 true 时，Host 侧执行一次自检（F9 全套：端口探测、证书加载、密钥配对、域名解析）。全部通过 → 置 true 并自动启动 HTTPS 监听；任一失败 → 拒绝置 true，卡片展示失败原因日志。
- **HTTPS 自动启动**：`enableHttps=true 且 F5/F7/F8 已填` 时，Host 侧立即启动 HTTPS 监听器；启动失败（端口占用等）回写错误状态到 UI，不 crash 整个 dsh。
- **F1/F2 的补丁托管**：插件独占管理 `$DSH_HOME/cordis.patch.yml`（机器级用户补丁层，应用顺序：bundle 层 → profile 层 → **home 层** → --patch 层，已源码验证）。插件只增删自己负责的 `id: webserver` 条目；不触碰 profile 自己的 `cordis.patch.yml`。**注意**：若用户手动以 `--port` 启动，--patch 层高于 home 层，会覆盖插件写入值（文档明示）。
- **证书热更新**：每次校验/保存以及定时（`ctx.timer.interval`，默认 60s）stat 证书文件，内容变化自动重建 TLS context，无需重启 dsh。
- **日志输出**：F9 校验结果逐条输出到卡片内日志区（成功/失败着色），同时写 Host 侧 `ctx.logger`。

---

## 3. 非功能需求

| 维度 | 要求 |
|------|------|
| 安全性 | 不绕过 dsh 的 `/api` browser-trust 防护：反代对 `/api` 及插件自有 RPC 通道改写 Host/Origin 为回环；访问控制仍由部署层（IP 白名单/防火墙）承担，README 明示 |
| 稳定性 | HTTPS 监听失败不影响 dsh 主进程；所有监听器/定时器/路由注册都在 Cordis fiber 内（`ctx.effect`），插件停止/卸载时全部释放 |
| 兼容性 | 支持 dsh 0.1.1-rc.2；`main` 分支向前兼容，版本分支冻结 |
| 可维护性 | 纯 JS/ESM、零构建产物；README 提供安装/排障/升级说明 |
| 审计 | 配置写入选通 settings 文档（`$DSH_HOME/settings.yaml` 的 `https-fix` 命名空间）；补丁改写只发生在 `$DSH_HOME/cordis.patch.yml` |

---

## 4. 技术实现路径

### 4.1 总体架构

```
浏览器 ──HTTPS(domain:httpsPort)──▶ [插件内置 HTTPS 反向代理] ──HTTP(127.0.0.1:httpPort)──▶ dsh Web 服务(webserver)
        ──HTTP(127.0.0.1:httpPort)───────────────────────────────────────────────────────▶（本机直连通道）
外网 ──(F1=true 时被 host:127.0.0.1 补丁阻断)──✕──▶ webserver
```

- **Host 半**（`lib/index.js`）：声明 `Config`（schemastery schema）、注册 settings 命名空间 `https-fix`、管理 `$DSH_HOME/cordis.patch.yml` 的 webserver 覆盖、启动/停止 HTTPS 反代、提供校验 RPC。
- **Client 半**（`lib/client.js`）：向 `settings.plugin.item` 槽位注册卡片（key=`https-fix`），渲染字段与两个按钮，调用 RPC 并展示日志。
- **通信**：卡片读/写走 dsh 标准 settings 写路径（`POST /api/settings.update`）；校验按钮走插件自有 RPC 通道 `POST /https-fix/validate`（`client-request` 信封）。

### 4.2 仓库与包结构

```
dsh-https-fix/
├── package.json          # name: dsh-https-fix；dsh.client 元数据
├── lib/
│   ├── index.js          # Host 插件：Config + apply()
│   ├── client.js         # Client 插件：设置卡片
│   └── https-proxy.js    # HTTPS 反代实现（node:https + http 转发 + WS upgrade 透传）
├── docs/REQUIREMENTS.md  # 本文件
└── README.md
```

package.json 关键字段（参照 `dsh-client-ui-settings-models`）：

```jsonc
{
  "name": "dsh-https-fix",
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js", "./package.json": "./package.json" },
  "dsh": {
    "client": {
      "inject": ["@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-connection", "@deepseek-ai/dsh-client-runtime"],
      "platform": "web"
    }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-client-connection": "^0.1.1-rc.2",
    "@deepseek-ai/dsh-client-ui-settings": "^0.1.1-rc.2",
    "@deepseek-ai/dsh-client-runtime": "^0.1.1-rc.2"
  }
}
```

### 4.3 Host 侧实现（lib/index.js）

```js
import { createServer as createHttpsServer } from 'node:https'
import { createSecureContext } from 'node:tls'
import { readFileSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'
import { applyHttpsProxy } from './https-proxy.js'

const name = 'https-fix'
const inject = ['webServer', 'settings', 'connection', 'timer']

const Config = z.object({
  blockHttpExternalAccess: z.boolean().default(false),   // F1
  httpPort:               z.natural().min(1).max(65535), // F2 无默认值，apply 时以 ctx.webServer.port 初始化
  enableHttps:            z.boolean().default(false),    // F3
  httpsPort:              z.natural().min(1).max(65535).default(3081), // F4
  domain:                 z.string().default(''),        // F5
  address:                z.string().default(''),        // F6
  certPath:               z.string().default(''),        // F7
  keyPath:                z.string().default(''),        // F8
})

function apply(ctx, config) { /* 见下 */ }
```

1. **settings 命名空间**：`ctx.settings.register('https-fix', Config, { /* 初始 httpPort 快照 */ })`（`settings` 服务契约已用 Inspect 确认：`register(ns, schema, options?) → SettingsScope`）。配置落在 settings 文档（`$DSH_HOME/settings.yaml`），随 Harness 持久化；卡片保存 = `POST /api/settings.update`（含 revision 乐观锁与 schema 校验）。若 Harness 核心已对插件 `Config` 自动注册同名命名空间，则跳过显式 register（M2 实测确认二选一）。
2. **F1/F2 补丁托管**（`$DSH_HOME/cordis.patch.yml`，home 层）：

```js
// 读 → 解析(js-yaml) → 合并/移除 id:'webserver' 的插件条目 → 原子写回(dsh-atomic-write 或临时文件+rename)
const PATCH_FILE = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cordis.patch.yml')
function writeWebserverOverride({ host, port }) {
  // host: F1=true → '127.0.0.1'；F1=false → 不写 host（保留部署默认/其他层）
  // port: F2 值 ≠ 当前实际端口时才写入（避免无意义覆盖）
}
```

   - 条目格式已实测验证：`- id: webserver` + `config: {host, port}` 能被 `--dump-config` 正确合并进 webserver 行。
   - 应用顺序（源码确认）：bundle 层 → profile `cordis.patch.yml` → **home 层** → `--patch` 层。文档注明 `--port` 启动参数优先级更高。
3. **HTTPS 反代生命周期**（`ctx.effect` 管理，条件不满足返回空 disposer）：

```js
ctx.effect(() => {
  if (!config.enableHttps) return
  if (!config.domain || !config.certPath || !config.keyPath) return
  const server = createHttpsServer(tlsContext(config), (req, res) =>
    req.headers.upgrade?.toLowerCase() === 'websocket' ? tunnelUpgrade(req, res) : proxy(req, res))
  server.listen(effectivePort, config.address || '0.0.0.0')
  return () => server.close()
}, 'https-fix: https listener')
```

   - **proxy()**：改写请求头——`/api` 与 `/https-fix` 路径将 `Host`、`Origin` 改为 `127.0.0.1:<httpPort>`（满足 dsh browser-trust 防护，`isTrustedApiRequest` 源码已确认只查 Host/Origin/sec-fetch-site）；其余路径透传原始 `Host`（域名:https端口）。转发用 `node:http` `request()`，响应流原样管道，**不做缓冲**（SSE 通道 `/plugins/events` 必须逐帧下发）。
   - **tunnelUpgrade()**：WebSocket 升级（`/api/events.mux`、`/api/events.host`）——转发 upgrade 请求到 http 端口，双方 socket 管道直连。
4. **校验 RPC**（自有通道，避开 `/api` 的单 interceptor 占用；`connection.rpc` 契约已确认）：

```js
ctx.effect(() => ctx.connection.rpc.handle('/https-fix', {
  async validate() {
    const log = []
    log.push(...checkPort(httpsPort, address))       // net 探测端口是否空闲
    log.push(...checkTls(certPath, keyPath, domain)) // tls.createSecureContext + X509 SAN/CN 匹配 + 公私钥配对
    log.push(...checkDomain(domain))                 // dns.lookup A/AAAA —— 仅检查可解析（用户决策③）
    log.push(...checkHttpUp(httpPort))               // http.get 127.0.0.1:httpPort 可达性
    return { ok, log }
  },
  async status() { return { running, port, domain, lastError } }
}, { authority: 'loopback' }))
```

   - 通道契约：`POST /https-fix/validate`，body = `{ type:"client-request", rpcId, payload:{} }`，响应 `{ type:"server-response", rpcId, result }`。
   - `authority:'loopback'`：强制 loopback 同源；经本插件 HTTPS 反代时由 proxy() 改写 Host/Origin 放行；远程直连 HTTP 被防护（最小特权）。

### 4.4 Client 侧实现（lib/client.js）

1. **槽位注册**（契约已用 Inspect 确认：`settings.plugin.item`，keyed by `key`，owner props 为空，卡片自带 inject face）：

```js
const inject = ['slots', 'locale', 'connection', 'settingsScope']
ctx.slots.register({
  name: 'settings.plugin.item',
  key: 'https-fix',                          // options.key = settings 命名空间
  inject: () => ({ controller, api: connection.api, t }),
}, HttpsFixCard)
```

2. **卡片数据流**：`ctx.settingsScope.bind({ namespace:'https-fix', decode })` 建立命名空间 scope；参照 `ui-settings-plugins` 的 `CardForm` 模式：布尔/整数/文本字段阶段化编辑；`保存配置` 按钮把阶段值合并提交。
3. **F9 校验按钮**：`fetch('/https-fix/validate', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({type:'client-request', rpcId: crypto.randomUUID(), payload:{}}) })` → 渲染返回的逐行日志。
4. **F10 保存按钮**：走 scope 写路径（`settings.update`）一次性提交；提交成功后触发共享镜像重读；F1/F2 字段旁标注"重启 dsh 后生效"。
5. **条件渲染**：`enableHttps=false` 时 https 相关字段置灰但可见。

### 4.5 校验逻辑明细（F9）

| 检查项 | 方法 | 失败输出示例 |
|--------|------|--------------|
| https 端口可监听 | `net.createServer().listen(port, address)` 探测后立即关闭 | `端口 3081 已被占用 (EADDRINUSE)` |
| cert 文件可读 | `readFileSync` + `tls.createSecureContext` | `证书路径不可读: ENOENT` |
| 证书链可解析 | `X509Certificate` 解析 subject/issuer/SAN | `证书解析失败: ...` |
| 域名匹配 | SAN(优先)/CN 与 `domain` 比对 | `证书不包含域名 example.com` |
| 密钥配对 | `key` 载入 `secureContext` 不抛错（crypto sign/verify 指纹比对） | `密钥与证书不匹配` |
| 域名解析 | `dns.lookup(domain)` A/AAAA —— **仅检查可解析** | `域名解析失败 ENOTFOUND` |
| http 端口可达 | `http.get('http://127.0.0.1:'+httpPort)` | `http 端口不可达` |

### 4.6 安装与接入（部署侧）

```bash
# profile 内安装（dsh 会把剩余参数转发给 profile 目录的 pnpm）
dsh plugin --profile web add github:MingYU-kalo/dsh-https-fix#dsh-0.1.1-rc.2
# 或本地开发链接
dsh plugin --profile web add file:./dsh-https-fix
```

- 安装后重启 `dsh web`；插件出现在 设置 → 插件配置 → Https Fix。
- **依赖的部署前提（重要）**：经域名访问时，设置页需要客户端 `connection.isLoopback` 放行（Harness 客户端门，与插件无关但影响插件卡片本身是否可用）。本机已应用补丁（`dsh-client-connection/lib/client.js` 增加本域豁免，见 `$DSH_HOME/local-patches.md`）；其他部署需要同样处理或经回环地址访问设置页。
- 与外部 nginx 的关系：插件上线后可下线 nginx 3081 反代（HTTPS 由插件直接提供）；若保留 nginx，注意 SSE 需要 `proxy_buffering off`（本机 nginx 已处理）。

### 4.7 风险与边界

| 风险/边界 | 说明与对策 |
|-----------|-----------|
| http 监听无法由插件热关 | `webserver` 服务归属 dsh 核心，插件不强行 dispose；F1 通过改写 home 补丁层的绑定地址（`host: 127.0.0.1`）+ 重启实现"外网不可达"（用户决策①） |
| `--port` 启动参数优先级 | `--patch`/启动参数层高于 home 补丁层；文档明示：使用 F1/F2 时不要同时传 `--port`/`--host` |
| home 补丁影响所有 profile | `$DSH_HOME/cordis.patch.yml` 对每个 profile 生效；webserver 行只存在于 web 类 profile，其余 profile 无此行则补丁条目为无操作（M2 实测确认 loader 对未知 id 的行为，必要时在文档标注） |
| 证书私钥安全 | 插件只读文件路径，不复制内容；settings 文档不落密钥内容 |
| dsh 升级 | 版本分支 `dsh-0.1.1-rc.2` 冻结兼容；`main` 跟进最新 |
| 端口冲突/证书过期 | 启动失败与校验失败均回写 UI 日志，不 crash |

---

## 5. 里程碑与验收标准

- **M1 需求与仓库**（本期完成）：本需求文档入库；`main` 与 `dsh-0.1.1-rc.2` 分支就绪；README 说明分支策略。
- **M2 可安装骨架**：`dsh plugin add` 安装成功；插件出现在插件配置卡片列表；字段与默认值符合第 2 节定义；补丁托管在 `$DSH_HOME/cordis.patch.yml` 验证可合并。
- **M3 HTTPS 服务**：配置证书/域名后 HTTPS 监听自动启动；`/`、`/api`、SSE、WS 全链路经 HTTPS 可用；关闭开关后监听释放。
- **M4 校验与保存**：F9 输出逐项日志且结论准确（错误证书/占用端口/错误域名做负向用例）；F10 保存后重启 dsh 配置保持；F1/F2 改写补丁后 `--dump-config` 显示 webserver 行生效。
- **验收环境**：本机 dsh 0.1.1-rc.2 + 域名 `example.com` + 现有证书 `/path/to/certs/example.com/*.pem`。

## 6. 已定稿决策记录（2026-08-22）

1. **F1 语义**（用户决策①）：原"启用http端口(默认开)"→ **"关闭http外网访问(默认关)"**，实现为改写 home 补丁层 webserver 行的 `host: 127.0.0.1`，重启生效。校验门与"true 时自动启动 https 服务"改挂到 F3 启用https。
2. **F2 生效方式**（用户决策②）：保存时**自动改写 profile/机器级补丁配置**（落点为 `$DSH_HOME/cordis.patch.yml` 而非 profile 的 `cordis.patch.yml`，避免污染用户层与注释丢失），重启生效。
3. **域名校验强度**（用户决策③）：F9 仅检查**域名可解析**，不要求解析结果指向本机网卡。
