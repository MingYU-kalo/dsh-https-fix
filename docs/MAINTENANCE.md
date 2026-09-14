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
| 代码规模 | `lib/index.js` 847 行、`lib/self-signed.js` 272 行、`lib/https-proxy.js` 212 行、`lib/client.js` 538 行；`test/ui-harness.mjs` 195 行（卡片回归测试，38 项断言） |
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

另外三个附加能力：
- **机器级补丁托管**：`blockHttpExternalAccess` 开启时，往 `$DSH_HOME/cordis.patch.yml` 写一条 `webserver` 行覆盖（`host: 127.0.0.1`）；`httpPort` 与实际端口不同时也写 `port`。
- **版本核查**：`versionCheck` 开启（默认）时，dsh 版本与 `TARGET_DSH_VERSION` 不一致就拒绝启动 HTTPS（见第 6 节）。
- **无域名自签证书**：`domain` 填 IP、证书路径留空时，插件用纯 Node 生成/复用一张覆盖「该 IP + 回环」的自签证书（`lib/self-signed.js`），不需要 ACME、不需要域名（见第 2、9 节）。

---

## 2. 代码地图

### `lib/index.js`（host 半边，插件主体）

| 行号 | 符号 | 职责 |
|---|---|---|
| 34 / 37 | `name` / `inject` | `inject = ["webServer", "clientModules", "connection"]` |
| 40 | `NS` | settings 命名空间 `https-fix` |
| 46–57 | `Config` | zod schema，同时也是 settings 命名空间 schema（10 个字段） |
| 60 | `TARGET_DSH_VERSION` | **适配新 dsh 版本时要改的第一处** |
| 66–69 | `LOOPBACK_TARGET_LINES` | 客户端 bundle 里 `isLoopback` 行的候选字面量（**第二处**） |
| 75 | `exemptionPattern()` | 匹配已写入的豁免片段，新老形式都认 |
| 80 / 86 | `normalizeVersion()` / `runningDshVersion()` | 去掉 `v` 前缀与 `+build`，再与目标版本精确比对 |
| 96 / 100 | `dshHome()` / `patchFilePath()` | `$DSH_HOME`（默认 `~/.dsh`）与机器级补丁路径 |
| 105 / 119 | `isPrivateIPv4()` / `serverIPv4Addresses()` | 「填入服务器 IP」的数据源：直接枚举网卡（IPv4、非 internal），带 `{iface, address, private}`、公网优先排序；**只收 IPv4**（IPv6 方括号语义在 Host/trustedHosts/SAN 三处不一致） |
| 137 | `certDir()` | 自签证书目录 `$DSH_HOME/https-fix/` |
| 147 / 156 / 165 / 170 | `certificateMode()` / `certificateHosts()` / `autoCertificate()` / `loadCertificate()` | 证书来源判定（`paths` / `auto` / `invalid`）、自签要覆盖的名字、生成或复用自签、装配监听用的证书材料 |
| 191 | `apply(ctx, config)` | 全部逻辑的入口 |
| 208 | `safeSource()` | 读 settings 生效值，失败回退到组成配置 |
| 223 | `report(label, err)` | 异常收敛：写 `ctx.logger` + 去重 `console.warn` |
| 241 | `guard(label, fn)` | **异步/同步异常统一兜底，见第 6 节红线** |
| 258 | `currentToken()` | 取进程 token（`connection.authenticatedUrl`，5 秒缓存） |
| 274 / 282 | `stopServer()` / `startServer()` | HTTPS 服务生命周期；`startServer` 里把 5 类回调异常全部就地收敛，并记录 `activeCert` / `startedSignature` |
| 350 / 356 | `wantHttps(cfg)` / `serverSignature(cfg)` | 是否该起 HTTPS（证书路径"成对填或都留空"）；影响监听的配置签名 |
| 370 | `versionCheckResult(cfg)` | 版本核查，返回 `{ok, msg, block}` |
| 379 | `reconcile()` | **配置变更的统一收敛点**（见第 3 节）；签名变了先停再起 |
| 405 / 416 | `readPatchEntries()` / `writePatchOverride()` | 机器级补丁层读写 |
| 441 | `ctx.inject(["settings"], …)` | 注册 settings 命名空间（`settings.installSection`） |
| 449–470 | 证书热重载定时器 | 60 秒一轮：文件证书按 mtime/size；自签证书按内容变化（hosts 变了或临近过期会重签）；`unref()` 不阻止进程退出 |
| 488 | dispose | 卸载时关闭 HTTPS 监听 |
| 495–501 | `RPC_ROUTES` | 5 个端点 → endpoint 名 |
| 507 / 537 | `rpcResponse()` / 注册循环 | `connection.fetch.register({path, methods:["POST"], requestBody:"buffered"})` |
| 545 | `statusView()` | `status` 端点的返回体（含 `certSource` / `certPath` / `serverIps`） |
| 568 | `loopbackBundlePath()` | 用 `clientModules.clientPath("@deepseek-ai/dsh-client-connection")` 定位 bundle |
| 585 / 592 / 608 | `loopbackExemption()` / `exemptionPresent()` / `loopbackPatchTarget()` | 热补丁的生成、查重、定位（域名或 IP 都可以） |
| 616 / 632 / 646 | `patchLoopback()` / `revertLoopback()` / `patchStatus()` | 打补丁 / 还原 / 查状态 |
| 667 / 689 | `ensureTrustedHost()` / `trustedHostCheck()` | 运行时注册域名/IP + 校验用检查 |
| 706 | `runValidation(cfg)` | 11 项校验的编排 |
| 726 | `hotPatchCheck()` | 校验里附带的热补丁状态项 |
| 741 / 761 / 825 / 835 | `checkPort` / `checkTls` / `checkDomain` / `checkHttpUp` | 四个子检查；`checkTls` 同时支持路径证书与自动自签，名字匹配交给 `X509Certificate.checkHost/checkIP` |

### `lib/client.js`（浏览器半边）

- 单文件 bundle，由 `window.__ModuleLoader__.load({id:"dsh-https-fix", factory})` 加载，`inject = ["slots", "settingsScope"]`。
- 向 `settings.plugin.item` 槽注册**折叠卡片**；`apply()` 在 524 行，卡片主体 `HttpsFixCard` 在 177–522 行。
- 卡片结构：
  - 头部：标题 + **实时状态徽标**（挂载 / 校验后 / 保存后调 `/api/https-fix/status`，显示「运行中 域名:端口 · 自签|自有证书」/「HTTPS 未启用」/「设置不可用」）+「未保存」+ 折叠箭头。
  - 展开后四组 `Section`（112 行）：**HTTPS 服务**（启用 / 域名或 IP +「填入当前地址」+「填入服务器 IP」/ https 端口 / 监听地址 / 访问入口预览）、**TLS 证书**（`Choice` 单选「自动自签 ↔ 自定义路径」，路径字段只在自定义模式出现）、**访问与安全**（自动模式 / 关闭 http 外网访问 / http 端口 / 核对版本号）、**诊断**（校验、热补丁、结果汇总、热补丁状态）。
  - 页脚：「有 N 项改动未保存」+「放弃修改」+「保存配置」。
- 视图原语在 104–175 行：`Chevron` / `Section` / `Field` / `Checkbox` / `TextInput` / `NumberInput` / `Choice`；样式全在文件顶部 `cssText`（25 行起，`hf_*` 类名，复用 `--dsw-*` 令牌），**不引入额外 CSS 文件**。
- 数据通道：
  - 读 `settingsScope` 快照：`value`（生效值）/ `user`（用户层，用来决定某项能否「恢复默认」）/ `base`（组成层，http 端口占位符）/ `writable` / `status`。
  - **两个「填入」按钮**：「填入当前地址」= `window.location.hostname`（浏览器地址栏，不含端口，IPv6 保持方括号原样）；「填入服务器 IP」= host 侧 `serverIPv4Addresses()` 经 `status.serverIps` 下发的 `{iface,address,private}[]`，唯一候选直接填、多个候选展开一行带网卡名的按钮（公网优先），无候选时按钮禁用。
  - 写：`staged` 暂存（189 行），保存时逐字段 `controller.set`（264 行）；「恢复默认」= `controller.unset(field)`（292 行，老 dsh 没有该方法时按钮自动隐藏）。
  - RPC 统一走 `rpc()`（220 行）→ `/api/https-fix/<endpoint>`。
- **热补丁端点的 `result.log` 是字符串数组**（只有 `validate` 返回 `{ok,msg}` 数组），必须过 `asLogLines()`（210 行）归一——早期版本没归一，补丁结果显示成「✗ undefined」。
- **布局不变量**：一行一个设置，禁止任何并排容器（`hf_grid` 已删）；每个 `Field` 必须是 `Section` 的直接子元素（`React.Fragment` 包一层可以，它不产生 DOM 节点）。`test/ui-harness.mjs` 有对应断言。
- **改这个文件后不需要重启 dsh**：它是 client bundle，浏览器硬刷新即可（HMR 也会自己更新）；改完请跑第 8 节的 `test/ui-harness.mjs`。

### `lib/self-signed.js`（零依赖自签证书）

- 纯 Node（`node:crypto` + 手写 DER），不依赖 openssl、不新增 npm 依赖；host 侧唯一新增运行时文件。
- `ipToBytes(ip)`（118 行）：IPv4/IPv6 → 字节，支持 `::` 缩写、IPv4-mapped 尾缀与 `%zone`。
- `createSelfSignedCertificate({hosts, days})`（177 行）：RSA-2048 + SHA-256，X.509 v3，`basicConstraints CA:TRUE`（可直接导入设备信任库当锚）、`keyUsage`、`extendedKeyUsage serverAuth`、`subjectAltName`。
  - **改这里最容易踩坑**：SAN 里 dNSName 必须是 `[2]`（tag `0x82`）、iPAddress 是 `[7]`（tag `0x87`）。写成普通 IA5String（`0x16`）时 OpenSSL 不会报错，而是**整段 SAN 当不存在**——`checkIP` 恒失败、浏览器域名校验失败，只有 `openssl x509 -text` 才看得出来。
- `ensureSelfSignedCertificate({dir, hosts, days, renewDays})`（237 行）：按 `self-signed.json` 里的 hosts 指纹复用；hosts 变了或剩余有效期 < `renewDays`（默认 30 天）就重签。证书 0644、私钥 0600、目录 0700，写入一律"临时文件 + rename"，避免读者看到半截文件。
- 落盘位置 `$DSH_HOME/https-fix/`；SAN 固定包含「配置的域名/IP + `127.0.0.1` + `localhost`」。

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
 ├─ ensureTrustedHost(cfg)      把配置的域名/IP push 进 connection.trustedHosts
 ├─ writePatchOverride(cfg)     机器级补丁层（不需要时删除该文件）
 ├─ !wantHttps → stopServer() 并返回（域名空、或证书路径只填一个，都视为不可用）
 ├─ versionCheckResult(cfg).block → 停止 HTTPS 并 warn
 └─ 配置签名变化或未监听 → stopServer()（已在听时）+ startServer(cfg)
     签名 = certificateMode|domain|httpsPort|address|httpPort；改域名/端口/证书来源都会立即重启监听
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
2. `lib/client.js` 的 `HttpsFixCard` 里加一个 `jsx(Field, {id, label, hint, children})`（放进四个 `Section` 之一），值用 `cur("<字段名>")`，写用对应的 `onChange`；需要「恢复默认」就加 `reset: canReset && isUserSet("<字段名>")` + `onReset`。
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
8. **设置卡片一行一个设置，禁止并排**（用户明确要求）：不要引入两列/自适应并排容器（`hf_grid` 已删除），每个 `Field` 必须是 `Section` 的直接子元素；`React.Fragment` 只用来分组条件渲染，它不产生 DOM 节点。`test/ui-harness.mjs` 对此有专门断言（「设置项一行一个」「自定义路径也一行一个」）。

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
dsh plugin --profile web add file:/path/to/dsh-https-fix   # 必须是 file: 前缀,裸路径会装成 link: 导致模块解析失败(见第 9 节第 10 条)

# 2) 用独立端口起一个测试实例（脱离当前 shell，避免把自己杀掉）
systemd-run --unit=hf-test --collect \
  --setenv=DSH_HOME=/tmp/dsh-test-home --setenv=HOME=/root \
  --setenv=PATH=<node-bin>:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  --working-directory=/root \
  <node-bin>/dsh web

# 3) 验证后按 PID 精确结束（从 ss -ltnp 取），不要用 pkill -f "dsh web"
```

**客户端卡片(设置页 UI)回归测试**(不用起 dsh:jsdom + React 直接渲染卡片,31 项断言,失败退出码非 0):

```bash
cd <仓库>
npm i --no-save react@18 react-dom@18 jsdom   # 只装到本仓库 node_modules,不写进 package.json
node test/ui-harness.mjs                      # 默认测 ../lib/client.js,也可传路径参数
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
9. **自动自签证书是自签的**：浏览器第一访问必然报警（这是自签的性质，不是插件故障）。要消除警告只有两条路：把 `$DSH_HOME/https-fix/self-signed.crt` 导入设备信任库，或改填证书路径使用受信任 CA（含 Let's Encrypt 的 IP 证书）。自签证书有效期 10 年、按 hosts 指纹复用，改域名/IP 会自动重签并重启监听（最迟 60 秒内由定时器完成）。
10. **测试环境装插件别用裸路径**：`dsh plugin add /path` 会生成 `link:` 依赖，插件按真实路径解析 `@deepseek-ai/schemastery` 就会失败（表现为 boot 报 `Cannot find package '@deepseek-ai/schemastery'`，折腾半天才发现）。用 `dsh plugin add file:/path`（生产就是 `file:` + 硬链接），或直接把插件目录放进 profile 的 `node_modules`。

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
| `6f2f2d0` feat: adapt to dsh 0.1.5-rc.2 | 逐项比对 7 个依赖点，**全部未变**，仅版本常量与元数据跟随到 rc.2；同时把 `docs/MAINTENANCE.md` 维护交接文档纳入仓库 |
| `a613917` refactor(client): 设置卡片重构 | 头部实时状态徽标；四组分区（HTTPS 服务/TLS 证书/访问与安全/诊断）；证书来源显式单选；「填入当前地址」；每项「恢复默认」(`controller.unset`)；校验 N/M 汇总 +「放弃修改」；修复热补丁结果渲染成「✗ undefined」（`asLogLines` 归一字符串数组）；新增 `test/ui-harness.mjs`（31 项断言） |
| `9df312b` feat(client): 「填入服务器 IP」 | host 侧 `serverIPv4Addresses()` 直接枚举网卡（非回环 IPv4，带 `{iface,address,private}`、公网优先），经 `status.serverIps` 下发；卡片第二个一键按钮：唯一候选直填、多候选展开带网卡名的按钮；IPv6 按要求保持方括号原样不归一 |
| `723fc4b` fix(client): 设置卡片一行一个设置 | 删除 `hf_grid` 并排容器（HTTPS 端口/监听地址、cert/key 路径不再自动并排）；条件分支改用 `React.Fragment` 保证 Field 是 Section 直接子元素；harness 增加布局不变量断言（34 项断言） |
| `deb80f4` feat(cert): 无域名部署(IP + 自动自签证书) | 新增 `lib/self-signed.js`（纯 Node 自签，零新依赖）；证书路径改为可选（都留空 = 自动自签）；`domain` 支持 IP；`reconcile()` 增加配置签名，域名/端口/证书来源变化立即重启监听；`checkTls` 改用 `X509Certificate.checkHost/checkIP`（能认 IP SAN） |
