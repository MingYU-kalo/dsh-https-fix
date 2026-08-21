# dsh-https-fix 详细项目需求

> 版本：v0.1（草案） · 目标平台：DeepSeek Harness (dsh) 0.1.1-rc.2
> 项目仓库：`dsh-https-fix`（公开，GitHub 账号 `MingYU-kalo`）
> 分支策略：`main` 始终为最新代码；版本分支按 dsh 版本号命名，本期为 `dsh-0.1.1-rc.2`

---

## 1. 项目背景与目标

DeepSeek Harness 的 Web GUI（`dsh web`）默认只提供 **HTTP** 监听（`dsh-host-webserver` 服务，绑定 `127.0.0.1` 或 `0.0.0.0`，端口默认 3080，由启动参数 `webStartup.port` 决定）。要在公网通过域名安全访问，目前只能依赖外部反向代理（如 nginx + 自签/Let's Encrypt 证书），并且会遇到几类典型问题：

1. SSE 事件通道（`/plugins/events`）被代理缓冲导致页面挂起；
2. 客户端 `connection.isLoopback` 只看 `location.hostname`，经域名访问时设置页（settings）全部降级为不可用；
3. Host/Origin 与 dsh 的 browser-trust 防护不匹配导致 403；
4. 证书、端口、域名配置分散在 nginx/系统层面，无法在 Harness 的 UI 中统一管理。

**本插件目标**：为 dsh 增加一套"内置 HTTPS 反代 + 可配置管理"能力——在 **设置 → 插件配置 → Https Fix** 中集中配置 HTTP 端口、HTTPS 开关、端口、域名、证书/密钥路径，并提供"校验 HTTPS 可用性"与"保存配置"操作。插件自身维护一个 HTTPS 监听器，把流量安全地反代进 dsh 的 HTTP 端口，使"域名 + HTTPS"开箱即用，无需外部 nginx。

---

## 2. 功能需求（配置项逐条定义）

插件在设置页的"插件配置"区块中注册一张卡片（settings 命名空间 `https-fix`）。字段如下：

| # | 字段 | 类型 | 默认值 | 约束/规则 | 生效方式 |
|---|------|------|--------|-----------|----------|
| F1 | 启用http端口 (keepHttpPort) | 布尔 | **true** | 开启时自动执行一次校验，**校验全部通过后才允许置为 true**；置为 true 后自动启动 HTTPS 服务（若启用https=true） | 即时 |
| F2 | http端口 (httpPort) | 整数 | 无默认值；初始值 = dsh 配置中的 http 端口（即 `webServer` 当前实际端口） | 1–65535；**需手动重启 dsh 后生效** | 重启后 |
| F3 | 启用https (enableHttps) | 布尔 | **false** | 为 true 时：证书路径、密钥路径、域名必填；插件尝试启动 HTTPS 监听 | 即时 |
| F4 | https端口使用http端口 (httpsSamePort) | 布尔 | **false** | true 时忽略 F5，HTTPS 直接监听在 http 端口（仅当 http 端口空闲且 dsh 改绑回环/其他端口时可用） | 即时 |
| F5 | https端口 (httpsPort) | 整数 | **3081** | 1–65535；F4=false 时生效 | 即时 |
| F6 | 域名 (domain) | 字符串 | 空 | 启用https 时**必填**；用于 Host 校验与证书域名校验 | 即时 |
| F7 | 地址 (address) | 字符串 | 空 | 多网卡时指定 HTTPS 监听 IP；留空 = 监听所有网卡 `0.0.0.0`。备注可留空 | 即时 |
| F8 | TLS证书(cert)路径 (certPath) | 字符串 | 空 | 启用https 时**必填**；文件必须可读、PEM 格式、证书域名含 F6 | 即时 |
| F9 | TLS密钥(Key)路径 (keyPath) | 字符串 | 空 | 启用https 时**必填**；文件必须可读、与 F8 证书配对 | 即时 |
| F10 | 校验https可用性（按钮） | 动作 | — | 校验：HTTPS 端口可监听、证书/密钥可加载且配对、域名解析可用（可选）、输出完整日志到卡片 | 即时 |
| F11 | 保存配置（按钮） | 动作 | — | 把当前表单一次性写入 settings 命名空间 `https-fix`（`settings.update` 写路径），写后自动重读 | 即时 |

### 2.1 行为细则

- **F1 的校验门**：`keepHttpPort` 从 false 切到 true 时，Host 侧执行一次自检（http 端口仍在监听且可达、证书路径可读（若已配置）、目标 https 端口未被占用）。自检全部通过 → 写入成功；任一失败 → 拒绝置 true，卡片展示失败原因日志。
- **HTTPS 自动启动**：`keepHttpPort=true 且 enableHttps=true 且 F8/F9/F6 已填` 时，Host 侧立即启动 HTTPS 监听器（启动失败回写错误状态到 UI）。
- **端口监听失败**：目标端口被占用 → 服务不启动，校验/启动日志给出 `EADDRINUSE` 明细；不 crash 整个 dsh。
- **证书热更新**：证书文件内容变化时（插件定时 stat 或每次校验/保存时读取）自动重载 TLS context，无需重启 dsh。
- **日志输出**：F10 校验结果（端口探测、证书链解析、SAN/CN 与域名匹配、密钥配对、DNS A/AAAA 解析）逐条输出到卡片内日志区，同时写 Host 侧 `ctx.logger`。

---

## 3. 非功能需求

| 维度 | 要求 |
|------|------|
| 安全性 | 不绕过 dsh 的 `/api` browser-trust 防护：反代对 `/api` 及插件自有 RPC 通道改写 Host/Origin 为回环；访问控制仍由部署层（IP 白名单/防火墙）承担，插件文档明示 |
| 稳定性 | HTTPS 监听失败不影响 dsh 主进程；所有监听器/定时器/路由注册都在 Cordis fiber 内（`ctx.effect`），插件停止/卸载时全部释放 |
| 兼容性 | 支持 dsh 0.1.1-rc.2；`main` 分支向前兼容，版本分支冻结 |
| 可维护性 | 纯 JS/ESM、零构建产物；代码注释双语关键段；README 提供安装/排障/升级说明 |
| 审计 | 配置写入选通 settings 文档（`$DSH_HOME/settings.yaml` 的 `https-fix` 命名空间），随 Harness 持久化与备份 |

---

## 4. 技术实现路径

### 4.1 总体架构

```
浏览器 ──HTTPS(domain:httpsPort)──▶ [插件内置 HTTPS 反向代理] ──HTTP(127.0.0.1:httpPort)──▶ dsh Web 服务(webserver)
        ──HTTP(127.0.0.1:httpPort)──────────────────────────────────────────────────────▶（保留的直连通道，F1=true 时）
```

- **Host 半**（`lib/index.js`）：声明 `Config`（schemastery schema，即 settings 命名空间 `https-fix`）、注册 settings 命名空间、启动/停止 HTTPS 反代、提供校验 RPC。
- **Client 半**（`lib/client.js`）：向 `settings.plugin.item` 槽位注册卡片（key=`https-fix`），渲染字段与两个按钮，调用 RPC 并展示日志。
- **通信**：卡片读/写走 dsh 标准 settings 写路径（`/api/settings.update`）；校验按钮走插件自有 RPC 通道 `POST /https-fix/validate`（`client-request` 信封）。

### 4.2 仓库与包结构

```
dsh-https-fix/
├── package.json          # name: @mingyu-kalo/dsh-https-fix（或 dsh-https-fix）；dsh.client 元数据
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
import { request as httpRequest, createServer as createHttpServer } from 'node:http'
import { createSecureContext } from 'node:tls'
import { readFileSync } from 'node:fs'
import { lookup } from 'node:dns'
import z from '@deepseek-ai/schemastery'

const name = 'https-fix'
const inject = ['webServer', 'connection']

const Config = z.object({
  keepHttpPort: z.boolean().default(true),
  httpPort:      z.natural().min(1).max(65535),        // 无默认值；apply 时以 ctx.webServer.port 初始化
  enableHttps:   z.boolean().default(false),
  httpsSamePort: z.boolean().default(false),
  httpsPort:     z.natural().min(1).max(65535).default(3081),
  domain:        z.string().default(''),
  address:       z.string().default(''),
  certPath:      z.string().default(''),
  keyPath:       z.string().default(''),
})

function apply(ctx, config) { /* 见下 */ }
```

1. **settings 命名空间**：`dsh-settings` 服务将插件 `Config` 自动注册为命名空间 `https-fix`（kebab-case 插件名），存于 settings 文档；Host 内通过 `ctx.settings` 或配置反射读取用户层覆盖值。卡片保存 = `POST /api/settings.update`（复用 dsh 现有写路径，含 revision 乐观锁与 schema 校验）。
2. **httpPort 初始化**：`apply` 时若 settings 文档尚无该值，则快照 `ctx.webServer.port` 作为初始值写入命名空间（只读展示为"当前 dsh http 端口"）。
3. **HTTPS 反代生命周期**（`ctx.effect` 管理）：

```js
ctx.effect(() => {
  if (!config.enableHttps || !config.keepHttpPort) return            // 条件不满足 → 无服务
  if (!config.certPath || !config.keyPath || !config.domain) return  // 必填缺失 → 无服务
  const httpsServer = createHttpsServer({ SNICallback, cert, key }, (req, res) => {
    if (req.headers.upgrade?.toLowerCase() === 'websocket') return upgradeTunnel(req, res)
    proxy(req, res)   // 转发到 http://127.0.0.1:${httpPort}
  })
  httpsServer.listen(effectivePort, config.address || '0.0.0.0')
  return () => httpsServer.close()   // fiber 结束自动释放
}, 'https-fix: https listener')
```

   - **proxy()**：改写请求头——`/api` 与 `/https-fix` 路径将 `Host`、`Origin` 改为 `127.0.0.1:<httpPort>`（满足 dsh browser-trust 防护）；其余路径保留原始 `Host`（域名:https端口）以满足非特权 API 的 Host==Origin 校验。转发用 `node:http` 的 `request()`，响应流原样管道，**关闭缓冲**（SSE 通道 `/plugins/events` 必须逐帧下发）。
   - **upgradeTunnel()**：WebSocket 升级（`/api/events.mux`、`/api/events.host`）——把 upgrade 请求转发到 http 端口，双方 socket 管道直连。
4. **校验 RPC**（自有通道，避开 `/api` 的单 interceptor 占用）：

```js
ctx.effect(() => ctx.connection.rpc.handle('/https-fix', {
  async validate(payload) {
    const log = []
    log.push(...checkPort(httpsPort))                     // net.connect 探测 / EADDRINUSE
    log.push(...checkTls(certPath, keyPath, domain))      // tls.createSecureContext + X509 解析 SAN/CN 匹配 + 公私钥配对
    log.push(...checkDomain(domain, address))             // dns.lookup A/AAAA；可选比对是否指向本机网卡
    return { ok, log }
  },
  async status(payload) { return { running, port, domain, lastError } }
}, { authority: 'loopback' }))
```

   - 通道契约：`POST /https-fix/validate`，body = `{ type:"client-request", rpcId, payload:{} }`，响应 `{ type:"server-response", rpcId, result }`。
   - `authority:'loopback'`：该通道强制 loopback 同源（与 settings 同级别）；经本插件 HTTPS 反代时由 proxy() 改写 Host/Origin 放行；远程域名直连 HTTP 时被防护（符合最小特权）。
5. **日志**：校验明细 `ctx.logger.info/warn`，同时作为 RPC 返回值回传 UI。

### 4.4 Client 侧实现（lib/client.js）

1. **槽位注册**（已用 Inspect 确认的契约）：

```js
const inject = ['slots', 'locale', 'connection', 'settingsScope']
ctx.slots.register({
  name: 'settings.plugin.item',
  key: 'https-fix',                          // options.key = settings 命名空间
  inject: () => ({ controller, api: connection.api, t }),
}, HttpsFixCard)
```

2. **卡片数据流**：`ctx.settingsScope.bind({ namespace:'https-fix', decode })` 建立命名空间 scope（读写走共享 settings 镜像）；`Controller` 参照 `ui-settings-plugins` 的 `CardForm` 模式：每个字段以 `booleanField/numberField/textField` 阶段化编辑，`保存配置` 按钮把阶段值合并提交。
3. **F10 校验按钮**：`fetch('/https-fix/validate', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({type:'client-request', rpcId: crypto.randomUUID(), payload:{}}) })` → 渲染返回的逐行日志（成功/失败着色）。
4. **F11 保存按钮**：调用 scope 的写路径（`settings.update`）一次性提交；提交成功后触发共享镜像重读，卡片显示最新生效值；HTTP 端口字段旁标注"需重启 dsh 后生效"。
5. **条件渲染**：`enableHttps=false` 时，https 相关字段置灰但可见（保留已填值）；`httpsSamePort=true` 时 https 端口字段禁用。

### 4.5 校验逻辑明细（F10）

| 检查项 | 方法 | 失败输出示例 |
|--------|------|--------------|
| https 端口可监听 | `net.createServer().listen(port)` 探测后立即关闭（0.0.0.0 与指定 address 各一次） | `端口 3081 已被占用 (EADDRINUSE)` |
| cert 文件可读 | `readFileSync` + `tls.createSecureContext` | `证书路径不可读: ENOENT` |
| 证书链可解析 | `X509Certificate` 解析 subject/issuer/SAN | `证书解析失败: ...` |
| 域名匹配 | SAN(优先)/CN 与 `domain` 比对 | `证书不包含域名 example.com` |
| 密钥配对 | `key` 载入 `secureContext` 不抛错（或 crypto sign/verify 指纹比对） | `密钥与证书不匹配` |
| 域名解析 | `dns.lookup(domain)`（可选：比对返回 IP 是否属于本机网卡 `os.networkInterfaces()`） | `域名解析失败 ENOTFOUND` |
| http 端口可达 | `http.get('http://127.0.0.1:'+httpPort)` 状态码 | `http 端口不可达` |

### 4.6 安装与接入（部署侧）

```bash
# profile 内安装（dsh 会把剩余参数转发给 profile 目录的 pnpm）
dsh plugin --profile web add github:MingYU-kalo/dsh-https-fix#dsh-0.1.1-rc.2
# 或本地开发链接
dsh plugin --profile web add file:./dsh-https-fix
```

- 安装后重启 `dsh web`；插件出现在 设置 → 插件配置 → Https Fix。
- **依赖的部署前提（重要）**：经域名访问时，设置页需要 `connection.isLoopback` 放行（Harness 客户端门）。本机已应用补丁（`dsh-client-connection/lib/client.js` 增加本域豁免，见 `$DSH_HOME/local-patches.md`）；其他部署需要同样处理或经回环地址访问设置页。
- 与外部 nginx 的关系：插件上线后可下线 nginx 3081 反代（HTTPS 由插件直接提供）；若保留 nginx，注意 SSE 需要 `proxy_buffering off`（本机 nginx 已处理）。

### 4.7 风险与边界

| 风险/边界 | 说明与对策 |
|-----------|-----------|
| http 监听无法由插件真正关闭 | `webserver` 服务归属 dsh 核心组成，插件不强行 dispose；`keepHttpPort=false` 的语义限定为"校验门/HTTPS 前置条件"，文档明示。真正的"仅 HTTPS"需部署层配合（http 仅绑 127.0.0.1 或防火墙封禁外网 http） |
| http 端口修改需重启 | 端口来自启动参数 `webStartup`，插件写入命名空间并提示 `--port N` 重启（可选增强：自动改写 profile 的 `cordis.patch.yml` webserver 行，列为 P1 可选需求） |
| 证书私钥安全 | 插件只读文件路径，不复制内容；settings 文档不落密钥内容；路径字段标记 `secrets` 为空（避免泄露到 describe 输出） |
| dsh 升级 | 版本分支 `dsh-0.1.1-rc.2` 冻结兼容；`main` 跟进最新；升级后如 settings 契约变化需重新验证 |
| 端口冲突/证书过期 | 启动失败与校验失败均回写 UI 日志，不 crash |

---

## 5. 里程碑与验收标准

- **M1 需求与仓库**（本期）：本需求文档入库；`main` 与 `dsh-0.1.1-rc.2` 分支就绪；README 说明分支策略。
- **M2 可安装骨架**：`dsh plugin add` 安装成功，插件出现在插件配置卡片列表，字段与默认值符合 4 节定义。
- **M3 HTTPS 服务**：配置证书/域名后 HTTPS 监听自动启动；`/`、`/api`、SSE、WS 全链路经 HTTPS 可用；关闭开关后监听释放。
- **M4 校验与保存**：F10 输出逐项日志且结论准确（用错误证书/占用端口/错误域名做负向用例）；F11 保存后重启 dsh 配置保持。
- **验收环境**：本机 dsh 0.1.1-rc.2 + 域名 `example.com` + 现有证书 `/path/to/certs/example.com/*.pem`。

## 6. 待确认问题（实现前定稿）

1. **F1 `keepHttpPort` 语义**：原文"开启时自动做一次校验，校验全部通过后才能为 true；true 时自动启动 https 服务"。拟实现为：校验通过才允许置 true；true 且 enableHttps=true 时自动启动 HTTPS。是否接受"该开关不真正关闭 dsh 的 http 监听"（见 4.7）？
2. **F2 http 端口写入位置**：接受"写插件命名空间 + 提示重启"，还是需要插件自动改写 profile 的 `cordis.patch.yml`（webserver 行端口）？
3. **域名校验强度**：F10 的域名解析是否强制要求解析结果指向本机网卡（多网卡/NAT 场景可能误报）？
