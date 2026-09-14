# dsh-https-fix 维护交接文档

> **读者**：后续维护本插件的人。
> **与 README 的分工**：README 面向使用者（怎么装、怎么配、装错版本怎么自救）；本文面向维护者（内部怎么运作、要改就改哪里、崩了怎么查、怎么适配新 dsh 版本）。
> **本文不含任何部署私密信息**：域名、IP、证书路径一律用 `<域名>`、`<证书路径>` 之类占位符，可以安全提交到公开仓库。
>
> 最后核对时间：2026-09-14，对应插件版本 `0.1.5-rc.2`（rc.1 → rc.2 已逐项比对，见第 10 节）。

---

## 0. 当前状态速览

| 项 | 值 |
|---|---|
| 仓库 | `https://github.com/MingYU-kalo/dsh-https-fix`（公开） |
| 当前适配的 dsh | `0.1.5-rc.2` |
| 对应分支 | `dsh-0.1.5-rc.2`（= `main`） |
| 插件版本 | `0.1.5-rc.2` |
| 代码规模 | `lib/index.js` 689 行、`lib/client.js` 299 行、`lib/https-proxy.js` 212 行 |
| 依赖 | 仅 `js-yaml`（host 侧解析属性）；运行时其余全用 Node 内建 |
| 冻结分支 | `dsh-0.1.5-rc.1`、`dsh-0.1.5-alpha.1`、`dsh-0.1.2-rc.1`、`dsh-0.1.1-rc.2` |

### 版本号规则（2026-09-10 起生效）

> **插件 `version` = 分支名 = 目标 dsh 版本号。**

不存在独立的插件版本号（早期曾有 `0.1.1-rc.x` 这种与 dsh 版本无关的编号，已废弃）。
因此有一条极强的自检：**`dsh --version` 的输出必须与 `package.json` 的 `version` 完全一致**，不一致就是装错分支了。
这条规则由 `e0b558b` 引入，并回填到了全部冻结分支。

---

## 1. 心智模型：这插件在解决什么

dsh 的 Web GUI 只监听 `127.0.0.1:<httpPort>` 的明文 HTTP。想把它安全地暴露到公网，会遇到四个各自独立的问题，插件逐一对付：

| # | 问题 | 插件的做法 |
|---|---|---|
| 1 | 没有 HTTPS | 用 Node `https` 模块自己起一个 TLS 监听，反代到 `127.0.0.1:<httpPort>`；不依赖 nginx |
| 2 | dsh 0.1.2 起 `/api` 有 Host/Origin 信任围栏 | 运行时把配置的域名 push 进 `connection.trustedHosts`，等价于启动参数 `--trusted-host <域名>` |
| 3 | 浏览器端 `isLoopback` 判定为假 → 设置页显示"在此浏览器不可用" | 对 dsh 的**客户端 bundle 文件**打运行时热补丁，追加一条 `pageLocation.hostname === "<域名>"` 豁免 |
| 4 | 首次访问要带 token，直接开域名会出现 303 重定向循环 | 插件**在服务端**用进程 token 换出会话 cookie，注入上游并同时下发给浏览器 |

另外两个附加能力：
- **机器级补丁托管**：`blockHttpExternalAccess` 开启时，往 `$DSH_HOME/cordis.patch.yml` 写一条 `webserver` 行覆盖（`host: 127.0.0.1`）；`httpPort` 与实际端口不同时也写 `port`。
- **版本核查**：`versionCheck` 开启（默认）时，dsh 版本与 `TARGET_DSH_VERSION` 不一致就拒绝启动 HTTPS（见第 6 节）。

---

## 2. 代码地图

### `lib/index.js`（host 半边，插件主体）

| 行号 | 符号 | 职责 |
|---|---|---|
| 33 / 36 | `name` / `inject` | `inject = ["webServer", "clientModules", "connection"]` |
| 39 | `NS` | settings 命名空间 `https-fix` |
| 45–56 | `Config` | zod schema，同时也是 settings 命名空间 schema（10 个字段） |
| 59 | `TARGET_DSH_VERSION` | **适配新 dsh 版本时要改的第一处** |
| 65–68 | `LOOPBACK_TARGET_LINES` | 客户端 bundle 里 `isLoopback` 行的候选字面量（**第二处**） |
| 74 | `exemptionPattern()` | 匹配已写入的豁免片段，新老形式都认 |
| 79 / 85 | `normalizeVersion()` / `runningDshVersion()` | 去掉 `v` 前缀与 `+build`，再与目标版本精确比对 |
| 95 / 99 | `dshHome()` / `patchFilePath()` | `$DSH_HOME`（默认 `~/.dsh`）与机器级补丁路径 |
| 103 | `apply(ctx, config)` | 全部逻辑的入口 |
| 118 | `safeSource()` | 读 settings 生效值，失败回退到组成配置 |
| 133 | `report(label, err)` | 异常收敛：写 `ctx.logger` + 去重 `console.warn` |
| 151 | `guard(label, fn)` | **异步/同步异常统一兜底，见第 6 节红线** |
| 168 | `currentToken()` | 取进程 token（`connection.authenticatedUrl`，5 秒缓存） |
| 184 / 192 | `stopServer()` / `startServer()` | HTTPS 服务生命周期；`startServer` 里把 5 类回调异常全部就地收敛 |
| 253 | `wantHttps(cfg)` | `enableHttps && domain && certPath && keyPath` |
| 262 | `versionCheckResult(cfg)` | 版本核查，返回 `{ok, msg, block}` |
| 271 | `reconcile()` | **配置变更的统一收敛点**（见第 3 节） |
| 295 / 306 | `readPatchEntries()` / `writePatchOverride()` | 机器级补丁层读写 |
| 330 | `ctx.inject(["settings"], …)` | 注册 settings 命名空间（`settings.installSection`） |
| 339–360 | 证书热重载定时器 | 60 秒 `stat` 证书文件，mtime/size 变了就重启监听；`unref()` 不阻止进程退出 |
| 364 | dispose | 卸载时关闭 HTTPS 监听 |
| 371–377 | `RPC_ROUTES` | 5 个端点 → endpoint 名 |
| 383 / 412 | `rpcResponse()` / 注册循环 | `connection.fetch.register({path, methods:["POST"], requestBody:"buffered"})` |
| 421 | `statusView()` | `status` 端点的返回体 |
| 441 | `loopbackBundlePath()` | 用 `clientModules.clientPath("@deepseek-ai/dsh-client-connection")` 定位 bundle |
| 458 / 465 / 481 | `loopbackExemption()` / `exemptionPresent()` / `loopbackPatchTarget()` | 热补丁的生成、查重、定位 |
| 489 / 505 / 519 | `patchLoopback()` / `revertLoopback()` / `patchStatus()` | 打补丁 / 还原 / 查状态 |
| 540 / 562 | `ensureTrustedHost()` / `trustedHostCheck()` | 运行时注册域名 + 校验用检查 |
| 579 | `runValidation(cfg)` | 11 项校验的编排 |
| 599 | `hotPatchCheck()` | 校验里附带的热补丁状态项 |
| 614 / 629 / 667 / 677 | `checkPort` / `checkTls` / `checkDomain` / `checkHttpUp` | 四个子检查 |

### `lib/client.js`（浏览器半边）

- 单文件 bundle，由 `window.__ModuleLoader__.load({id:"dsh-https-fix", factory})` 加载，`inject = ["slots", "settingsScope"]`。
- 向 `settings.plugin.item` 槽注册**折叠卡片**（`ctx.slots.inject` + `ctx.slots.register`，第 287 行）。
- 字段 UI 在第 233–266 行，顺序：关闭 http 外网访问 / http 端口 / 启用 https / https 端口 / 域名 / 监听地址 / cert 路径 / key 路径 / 自动模式 / 核对版本号 / 客户端热补丁区块。
- 数据通道：读走 `settingsScope`，写走 `settings.update`；「校验」按钮 `fetch("/api/https-fix/validate")`（第 130 行），热补丁按钮 `fetch("/api/https-fix/" + endpoint)`（第 176 行）。
- **改这个文件后不需要重启 dsh**：它是 client bundle，浏览器硬刷新即可（HMR 也会自己更新）。

### `lib/https-proxy.js`（HTTPS → HTTP 反代）

- 零依赖，`createHttpsProxy({upstream, tokenProvider, log})`。
- `HOP_BY_HOP`（19 行）逐跳头过滤；`forwardHeaders()` 透传 Host 并补 `x-forwarded-proto: https`。
- `secureCookies()`（40 行）给上游 `Set-Cookie` 补 `Secure`（代理本身跑在 HTTPS 上）。
- `exchangeToken()`（55 行）用进程 token 请求 `/?token=…`，取出会话 cookie 名值对；`sessionCookieFor()`（79 行）按 Host 缓存 12 小时。
- `forward()`（93 行）与 `forwardUpgrade()`（139 行）分别处理普通请求与 WebSocket；响应流**不缓冲**，保证 SSE（`/plugins/events`）逐帧下发。
- 自动模式逻辑在 `handle()`（175 行）：请求已带 `dsh-auth-` cookie 就纯透传，否则先换 cookie 再注入。

---

## 3. 启动与收敛流程

```
apply()
 ├─ 读 ctx.webServer.port 作为 httpPort 的种子
 ├─ ctx.inject(["settings"])  → settings.installSection(..., { setSource, onChange })
 │                              onChange → guard(reconcile)
 ├─ ctx.effect: 60s 定时器（证书热重载，每次先过版本核查）
 ├─ ctx.effect: dispose → stopServer()
 └─ for RPC_ROUTES: ctx.effect → connection.fetch.register(...)

reconcile()            ← 启动时由定时器/首次调用触发；设置变更时由 onChange 触发
 ├─ ensureTrustedHost(cfg)      把域名 push 进 connection.trustedHosts
 ├─ writePatchOverride(cfg)     机器级补丁层（不需要时删除该文件）
 ├─ !wantHttps → stopServer() 并返回
 ├─ versionCheckResult(cfg).block → 停止 HTTPS 并 warn
 └─ httpsServer === null → startServer(cfg)
```

要点：**`reconcile()` 是唯一的收敛点**。任何新增的"配置变了要做什么"都必须挂在这里或它的调用链上，不要另起一套 watcher——否则会出现两条路径互相打架。

---

## 4. 配置读写

- `Config`（zod）既是插件组成配置的 schema，也是 settings 命名空间的 schema，**同一份**，避免两处漂移。
- `httpPort` **故意不给默认值**：`apply` 时以 `ctx.webServer.port` 作为 base 层种子（第 108 行），所以用户没配过也能读到真实端口。
- 生效值通过 `source()` thunk 读取，由 `installSettingsSection` 的 `setSource` 替换；读取一律走 `safeSource()`（settings 服务重载期间会短暂失败）。
- 字段清单（含含义）见 `Config` 第 45–56 行，注释里的 F1–F10 编号与需求文档 `docs/REQUIREMENTS.md` 对应。

---

## 5. 维护任务手册

### A. 新增一个配置项

必须同时改四处，漏一处就会出现"能存但不生效"或"能显示但存不了"：

1. `lib/index.js` 的 `Config`（45–56 行）加字段 + 默认值/约束。
2. `lib/client.js` 第 233–266 行加一个 `jsx(Field, {label, hint, children})`，值用 `cur("<字段名>")`，写用对应的 `onChange`。
3. 若该字段影响运行行为 → 在 `reconcile()`（271 行）或其调用链里消费它。
4. 若该字段影响"能不能正常跑" → 在 `runValidation()`（579 行）里加一项检查。

### B. 新增一个 RPC 端点

1. `RPC_ROUTES`（371 行）加 `"/api/https-fix/<名字>": "<名字>"`。
2. `rpcResponse()` 的分发链（398–403 行）加分支。
3. 注册循环（412 行）会自动为新路由挂 `ctx.effect`，**不要**手写第二处 `register`。
4. 客户端调用用 `fetch("/api/https-fix/<名字>")`，请求体固定是 `{type:"client-request", method, rpcId, payload}`，响应体是 `{type:"server-response", rpcId, result}`。

> 路径前缀必须是 `/api/`：dsh 的 Host/Origin 栅栏与 cookie 鉴权都挂在这一层，非 `/api` 路径拿不到鉴权上下文（0.1.5 实测返回 405）。

### C. 适配新的 dsh 版本（**最重要的维护动作**）

dsh 每个版本都可能改动插件依赖的内部接口。**必须逐项人工比对**，不要只看版本号就改常量。

**步骤**

0. 先读 README 首屏的版本警告：装错版本会让 dsh **完全起不来**，不是"功能不可用"。
1. 装新版 dsh，记录版本号 `X`。
2. 到 dsh 安装目录比对下面这张表的每一项（路径模式：
   `<node>/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/<包名>/`）。
3. 按比对结果改代码：能只改常量的就只改常量；接口变了就改对应调用点。
4. 改 `lib/index.js:59` 的 `TARGET_DSH_VERSION` → `X`。
5. 改 `package.json` 的 `version` 与 `dshhub.compatibility.dsh` → `X`。
6. 新建分支 `dsh-X`，同步更新 `main`。
7. 装好后跑「校验 HTTPS 可用性」，**11 项必须全绿**（其中第 1 项就是版本核查）。
8. 更新 README 的版本对应表。

> **rc.1 → rc.2 实测记录(2026-09-14)**:7 个依赖点**全部未变**。`dsh-client-connection/lib/index.js`(host 半边)与 `lib/client.js` 里的 `isLoopback` 目标行在 rc.1/rc.2 逐字节一致(客户端 bundle 的唯一差异来自本机上已打的热补丁),`dsh-settings`、`dsh-client-modules`、`dsh-host-webserver`、`dsh-app-boot` 均无代码改动;rc.1 → rc.2 的改动集中在 `dsh-client-ui-*` 与 `dsh-web-frontend` 的 UI bundle。因此本次只改版本常量与元数据(`TARGET_DSH_VERSION` / `package.json`),不动任何调用点。

**依赖点清单**

| 依赖点 | 用在哪 | 怎么比对 |
|---|---|---|
| `settings.installSection(ctx, ns, schema, entry, opts)` | `lib/index.js:331` | 看 `dsh-settings` 导出与签名，`opts` 是否仍认 `setSource`/`onChange` |
| `connection.fetch.register({path, methods, requestBody, fetch})` | `lib/index.js:413` | 看 `dsh-client-connection` 里 `fetch` 服务的 `register` 签名 |
| `connection.trustedHosts`（**活数组**） | `lib/index.js:545` | 确认仍是可就地 push 的数组；改成 getter/只读就要换方案 |
| `connection.authenticatedUrl(base)` | `lib/index.js:175` | 确认仍返回带 `token=` 的 URL |
| `clientModules.clientPath(pkg)` | `lib/index.js:443` | 确认仍能解析出 `dsh-client-connection` 的客户端 bundle 路径 |
| `ctx.webServer.port` | `lib/index.js:105` | 确认字段名未变 |
| `isLoopback` 目标行字面量 | `LOOPBACK_TARGET_LINES`（65 行） | 在 `dsh-client-connection/lib/client.js` 里搜 `isLoopback:`，把新行加进候选数组 |

**版本核查的语义**（`versionCheckResult`，262 行）：不一致时返回 `block: true`，`reconcile()` 会**停止 HTTPS** 并写 warn。这是刻意的：与其带着不兼容的代码跑出诡异故障，不如明确拒绝。用户想强行试可以关掉 `versionCheck`，但需要三次确认。

### D. 发布新版本分支

```bash
git worktree add /tmp/wt -b dsh-<X>     # 用 worktree，别在主工作树 checkout（见下文硬链接）
# 改代码 / 提交
git push origin dsh-<X>
git push origin dsh-<X>:main            # main 跟随最新
git worktree remove /tmp/wt
```

### E. 改客户端卡片 UI

只改 `lib/client.js`。它必须在 `factory(require)` 里用 `require("react")` + `react/jsx-runtime` 的 `jsx/jsxs`，**不能**用 JSX 语法（这个文件不经过任何编译）。改完浏览器硬刷新即可。

---

## 6. 不变量与红线

这些是踩过事故之后立的规矩，改代码时必须继续满足：

1. **任何异步路径都必须包在 `guard()` 里。**
   dsh 的 `dsh-app-boot` 在进程上注册了 `unhandledRejection` 处理器（`installFailLoud`，`dsh-app-boot/lib/index.js:1401`）：它打印 `dsh: fatal load failure: …` 然后 `process.exit(1)`。插件漏出任何一个未处理的 rejection，**整个 dsh 进程就会猝死**。
   涉及：60 秒定时器回调、settings `onChange`、RPC 处理器、HTTPS 服务器的 `request`/`upgrade`/`clientError`/`tlsClientError` 回调、代理里的 socket/stream `error` 事件、`httpRequest()` 的同步抛出。
2. **`inject` 没声明的服务，不要用 `ctx.<name>` 访问**（用 `ctx.get("<name>")` 并处理 `undefined`）。
3. **不要在 `apply` 里用 Cordis 内部类/深路径 import**：只用 `ctx` API + Node 内建 + `js-yaml`。`@deepseek-ai/schemastery` 与 `@deepseek-ai/dsh-settings` 靠 profile 的模块回退解析到宿主同一实例，保证 schema 兼容。
4. **热补丁必须幂等且可还原**：写入前用 `exemptionPresent()` 查重；`revertLoopback()` 要能清掉新老两种形式。
5. **所有副作用挂在 Fiber 上**：定时器、RPC 注册、监听器都用 `ctx.effect()` / `ctx.on()` 返回 disposer，保证停止/更新/卸载时能干净移除。
6. **响应流不要缓冲**：SSE 必须逐帧下发，别引入中间缓冲层。
7. **日志双写**：cordis 的 `ctx.logger` 只有内存环形缓冲、**不落盘**，关键诊断必须同时 `console.warn`（`report()` 已封装，注意它是去重的）。

---

## 7. 故障排查手册

### 7.1 dsh 完全起不来：`plugin(s) failed to load` / `entry did not activate`

**根因**：`dsh-app-boot/lib/index.js:1465` 的 `assertEntriesActivated()` 在 boot 返回前审计整棵插件树。任何**启用但未激活**的插件行——导出不存在、`inject` 的服务不存在而卡在 `FIBER_PENDING`（0）、或 `apply` 抛错——都会让启动整体失败。
**最常见触发条件**：插件版本与 dsh 版本不匹配。

**处置**（dsh web 起不来时仍可用，因为 `dsh plugin` 是 pnpm 直通）：
```bash
dsh plugin --profile <profile> remove dsh-https-fix
# 或在 $DSH_HOME/profiles/<profile>/cordis.patch.yml 里禁用该行：
#   - id: https-fix
#     disabled: true
```
> 注意：该文件必须是**顶层 YAML 数组**。只有注释会被解析成 `null`，报 `must be a top-level YAML array of loader patch entries`。

### 7.2 dsh 跑一段时间后整个进程退出：`dsh: fatal load failure: …`

**根因**：7.1 里同一个文件第 1401 行的 `installFailLoud()`。任何漏出的未处理 rejection 都会触发。
**处置**：看 stack 定位是哪个异步路径没包 `guard()`，补上。别去改 dsh。

### 7.3 经域名访问 `/api/*` 返回 403

`trustedHosts` 没生效。检查：
- 配置的域名是否与浏览器地址栏的 host 一致（`ensureTrustedHost` 只注册配置里的那个）。
- `validate` 的第 2 项「受信域名」是否为绿。
- 兜底手段：启动时加 `--trusted-host <域名>`（等价，双保险）。

### 7.4 页面能开，但设置页显示"在此浏览器不可用"

客户端 `isLoopback` 热补丁没生效。检查 `patch-status` 端点；大概率是 **dsh 升级把 client bundle 覆盖了**（补丁写在 dsh 安装目录里），重新点「一键打热补丁」即可。

### 7.5 卡片「校验 HTTPS 可用性」恒报失败

看返回的 HTTP 状态：405 ⇒ 客户端调的路径不对（必须是 `/api/https-fix/validate`）；403 ⇒ 见 7.3。

### 7.6 打开域名后无限跳转（`ERR_TOO_MANY_REDIRECTS`）

token 交换没生效。确认「自动模式」开着，且 `connection.authenticatedUrl()` 能取到 token（见 `currentToken()` 的 5 秒缓存逻辑）。

### 7.7 校验报「HTTPS 端口不可监听」

`EADDRINUSE`。注意 `checkPort()`（614 行）对"端口正是本插件自己在监听"做了豁免，不会误报。

### 7.8 校验报「未找到 isLoopback 目标行」

dsh 升级改了那一行。按 5.C 的表格把新字面量加进 `LOOPBACK_TARGET_LINES`。

---

## 8. 本地测试方法（务必隔离）

**不要**在正在对外服务的 `$DSH_HOME` 上做实验，也不要同时跑两个同 `DSH_HOME` 的 dsh 实例。

```bash
# 1) 另建一个隔离 DSH_HOME，装本地插件
export DSH_HOME=/tmp/dsh-test-home
mkdir -p "$DSH_HOME"
dsh plugin --profile web add /path/to/dsh-https-fix

# 2) 用独立端口起一个测试实例（脱离当前 shell，避免把自己杀掉）
systemd-run --unit=hf-test --collect \
  --setenv=DSH_HOME=/tmp/dsh-test-home --setenv=HOME=/root \
  --setenv=PATH=<node-bin>:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  --working-directory=/root \
  <node-bin>/dsh web

# 3) 验证后按 PID 精确结束（从 ss -ltnp 取），不要用 pkill -f "dsh web"
```

**验证清单**（RPC 响应形状有坑，注意 `result.log` / `result.value`，不是 `result.value.log`）：

```bash
TOKEN=$(grep -o 'token=[A-Za-z0-9_-]*' <日志文件> | tail -1 | cut -d= -f2)
curl -sk -c /tmp/jar -o /dev/null "https://<域名>:<https端口>/?token=$TOKEN"   # 期望 303 + Set-Cookie，别加 -L
curl -sk -b /tmp/jar -X POST "https://<域名>:<https端口>/api/https-fix/validate" \
  -H 'content-type: application/json' \
  -d '{"type":"client-request","method":"https-fix/validate","rpcId":"t","payload":{}}'
# 期望 result.log 11 项全 ok:true
```

settings 命名空间核查（`method` 必须等于 `settings/describe`，否则 400；返回里键名是 `ns`）：
```bash
curl -sk -b /tmp/jar -X POST "https://<域名>:<https端口>/api/settings/describe" \
  -H 'content-type: application/json' \
  -d '{"type":"client-request","method":"settings/describe","rpcId":"t","payload":{"args":{}}}'
```

---

## 9. 已知边界与技术债

1. **安装是"硬链接"而非拷贝**（`file:` 依赖 + pnpm）。所以直接改仓库文件等于改已安装副本、**不需要重装**。
   代价：任何"写新文件再 rename"的操作（`git checkout` / `git switch` / `git stash` / 编辑器另存）都会**打断硬链接**，已安装副本会静默变旧。切分支请用 `git worktree`；已经断了就用 `ln -f` 逐文件接回。
2. **热补丁写在 dsh 的安装目录里**，任何 dsh 升级都会覆盖它。这是设计使然（没有官方扩展点），代价是升级后要重新打一次。
3. **`trustedHosts` 是运行时 push**，不落地。dsh 重启后由插件在 `reconcile()` 里重新注册，属于预期行为。
4. **`blockHttpExternalAccess` 会写机器级补丁层**，需要重启 dsh 才生效。开启前请确认 HTTPS 侧已经可用——否则 http 一旦只监听回环，就没有兜底入口了。
5. **证书热重载粒度是 60 秒**（`stat` 比对 mtime+size）。换证书后最多等一分钟。
6. **`autoToken` 的会话 cookie 按 Host 缓存 12 小时**。换域名或端口后旧缓存不会复用（cache key 是 authority），但同一 Host 内 token 轮换要等 TTL 过期。
7. **`versionCheck` 是"版本字符串精确相等"**，不是语义化范围。`0.1.5` 与 `0.1.5+build1` 会因归一化而相等，但 `0.1.5` 与 `0.1.5-rc.1` 不等——这是刻意的。
8. 早期版本号（`0.1.1-rc.x`）与 dsh 版本无对应关系，只存在于历史 commit；当前所有分支已统一为「版本号 = 分支名 = dsh 版本」。

---

## 10. 版本历史要点（每个提交为什么存在）

| 提交 | 原因 |
|---|---|
| `ee7ae1d` feat: adapt to dsh 0.1.5-alpha.1 | dsh 接口变更，插件跟随 |
| `94f3f4b` fix: 收敛插件内所有异步异常 | 定位到 `installFailLoud` → 插件漏 rejection 导致 dsh 猝死 |
| `440abff` fix: installSection 也走 guard | 上一条的漏网之鱼：settings 注册路径 |
| `194e216` fix(logging): 关键异常同时 console.warn | cordis logger 不落盘，崩溃时无现场 |
| `4a0bd08` feat(host): 运行时注册 trustedHosts | 经域名访问 `/api` 403：不再依赖用户改启动参数 |
| `df535d2` fix(proxy): 服务端 token 交换 | 浏览器不回传 cookie 时的 303 无限重定向 |
| `60f1ea5` fix(proxy): Set-Cookie 补 Secure / 记录鉴权决策 | HTTPS 下 cookie 不生效 |
| `84e5139` docs: README 重写 | 版本不匹配会让 dsh 完全不可用，必须首屏警告 |
| `e0b558b` feat: adapt to dsh 0.1.5-rc.1 | 版本号规则改为「插件版本 = 分支名 = dsh 版本」；修正客户端校验路径为 `/api/https-fix/validate`（旧路径 405）；热补丁豁免改为按 **hostname** 匹配（端口无关，兼容前置 nginx） |
| `PENDING_SHA` feat: adapt to dsh 0.1.5-rc.2 | 逐项比对 7 个依赖点，**全部未变**，仅版本常量与元数据跟随到 rc.2；同时把 `docs/MAINTENANCE.md` 维护交接文档纳入仓库 |
