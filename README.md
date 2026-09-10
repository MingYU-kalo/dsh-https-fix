# dsh-https-fix

> ⚠️ **维护说明**：本项目主要服务于**作者本人使用**。更新频率与作者升级 dsh 新版本深度绑定，统计学上**无法预测**更新节奏。如有使用需求，请 `git` 拉取最新版本并自行修复/适配。

DeepSeek Harness (dsh) 插件：为 dsh Web GUI 提供**内置 HTTPS 反代与可配置管理**。

---

## 🚨 必须使用与 dsh 版本对应的插件版本，否则 dsh 会不可用

本插件深度依赖 dsh **内部 API**（`settings.installSection`、`connection.fetch.register`、`webServer`、`clientModules` 等导出与服务）。
dsh 每个版本都可能改动这些接口。**插件版本与 dsh 版本不一致时，后果不是"插件功能失效"，而是整个 dsh 不可用：**

| 不匹配发生在 | dsh 的实际表现 | 依据（dsh 源码） |
|---|---|---|
| **启动加载期**：导入不存在的导出、`inject` 的服务在该版本不存在、`apply` 抛错 | **dsh 启动直接失败，Web GUI 完全打不开**；终端报 `dsh: plugin(s) failed to load: …` 或 `dsh: 1 entry did not activate …` | `dsh-app-boot` 的 `assertEntriesActivated()` 在 boot 结束前审计整棵插件树，任一启用条目未激活即抛错、终止启动 |
| **运行期**：版本差异导致插件漏出未处理的 Promise rejection | 正常运行一段时间后**整个进程突然退出**，终端最后一行 `dsh: fatal load failure: <stack>` | `dsh-app-boot` 的 `installFailLoud()` 给进程注册了 `unhandledRejection` 处理器，命中即写 stderr 并 `process.exit(1)` |

### 三条硬性规则

1. **装之前先核对版本**：`dsh --version`，然后安装**同名分支**（见下表）。不要凭插件版本号或"最新 main"去装。
2. **升级 dsh 之前，先更新插件到对应分支，或先禁用/卸载插件**。绝不能让旧插件留在原地、跟着新 dsh 一起启动。
3. 插件卡片里的「核对版本号」（默认开启）只是**第二道保险**：它只有在插件已成功加载之后才能校验，**挡不住上面两种不可用**。关闭它需要三次确认，请不要关。

### 版本对应表

| dsh 版本 | 插件分支（装这个） | 插件版本 | 元数据 `dshhub.compatibility.dsh` |
|---|---|---|---|
| `0.1.5-rc.1`（当前） | `dsh-0.1.5-rc.1`、`main` | 0.1.5-rc.1 | `0.1.5-rc.1` |
| `0.1.5-alpha.1` | `dsh-0.1.5-alpha.1` | 0.1.5-alpha.1 | `0.1.5-alpha.1` |
| `0.1.2-rc.1` | `dsh-0.1.2-rc.1` | 0.1.2-rc.1 | `0.1.2-rc.1` |
| `0.1.1-rc.2` | `dsh-0.1.1-rc.2` | 0.1.1-rc.2 | `0.1.1-rc.2` |

> **版本号规则：插件 `version` = 分支名 = 目标 dsh 版本号**（例如分支 `dsh-0.1.5-rc.1` 的 `version` 就是 `0.1.5-rc.1`），**不存在独立的插件版本号**。
> 因此 `dsh --version` 的输出应当与 `package.json` 的 `version` 字段完全一致；不一致就是装错了分支。

### dsh 已经起不来时怎么自救

`dsh plugin` 是 pnpm 直通命令，**dsh web 起不来也能执行**：

```bash
# 方式 1：卸载插件
dsh plugin --profile web remove dsh-https-fix

# 方式 2：不卸载，只在补丁里禁用这一行
#   编辑 $DSH_HOME/profiles/web/cordis.patch.yml
```

```yaml
- insert:
    - id: https-fix
      name: dsh-https-fix
      disabled: true
```

改完重启 dsh web 即可恢复。

### 升级 dsh 的标准流程

```bash
# 1. 看当前版本，记住它
dsh --version

# 2. 升级 dsh
npm i -g @deepseek-ai/dsh@<新版本>

# 3. 立刻把插件切到对应分支（若该分支尚未存在，说明作者还没适配：先禁用插件再启动）
dsh plugin --profile web add github:MingYU-kalo/dsh-https-fix#dsh-<新版本>

# 4. 确认插件已启用，再启动 dsh web
```

---

## 功能

在 **设置 → 插件配置 → Https Fix** 中统一管理：

- 关闭 http 外网访问（默认关；改写 `$DSH_HOME/cordis.patch.yml`，重启生效）
- http 端口（默认取 dsh 当前 http 端口；保存自动改写补丁配置，重启生效）
- HTTPS 开关（默认关，开启前自动校验、通过后自动启动 HTTPS 服务）
- HTTPS 端口（默认 3081）
- 域名、监听地址、TLS 证书/密钥路径
- **自动模式（网页 token）**（默认开；适配 dsh 0.1.2+ 的网页鉴权——自动获取进程 token 并注入，浏览器直接访问 `https://域名:端口` 即可完成 token 换取 cookie；关闭则需自行使用 dsh 启动时打印的带 token URL，等同原始 http 模式）
- **核对版本号**（默认开；校验当前 dsh 版本与插件目标版本一致，不一致则 HTTPS 校验无法通过、无法开启 HTTPS；关闭需**三次确认**）
- **一键打热补丁**（自动给 dsh-client-connection 打 `connection.isLoopback` 豁免，让经域名访问的设置页可用；含还原）
- 「校验 HTTPS 可用性」按钮（版本对应 / 受信域名 / 热补丁 / 端口 / 证书配对 / 域名逐项校验并输出日志）
- 「保存配置」按钮

详细需求与技术方案见 [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md)。

## 分支策略

| 分支 | 内容 |
|------|------|
| `main` | 最新代码（跟随 dsh 最新版本） |
| `dsh-<版本号>` | 与特定 dsh 版本兼容的冻结分支，如 `dsh-0.1.5-rc.1`（当前）、`dsh-0.1.5-alpha.1`、`dsh-0.1.2-rc.1`、`dsh-0.1.1-rc.2`；分支名即插件版本号 |

具体版本对应关系见上文[版本对应表](#版本对应表)。

## 安装

> 本插件**未发布到 npm**，请从 Git 或本地路径安装。

**第 0 步（不可跳过）：核对版本**

```bash
dsh --version    # 必须与你要安装的分支名一致
```

按 dsh 版本安装对应冻结分支（推荐，与你的 dsh 版本严格对应）：

```bash
# dsh 0.1.5-rc.1 对应分支（当前）
dsh plugin --profile web add github:MingYU-kalo/dsh-https-fix#dsh-0.1.5-rc.1
# 或始终追随最新代码（main，可能超前于你的 dsh 版本 → 见开头的版本警告）
dsh plugin --profile web add github:MingYU-kalo/dsh-https-fix#main
```

本地 clone 后自行修改/修复，再从本地路径安装：

```bash
git clone https://github.com/MingYU-kalo/dsh-https-fix.git
dsh plugin --profile web add file:./dsh-https-fix
```

安装完成后**重启 dsh web** 生效；插件出现在 设置 → 插件配置 → Https Fix。
若重启后 dsh 直接起不来，说明版本不匹配，按[自救步骤](#dsh-已经起不来时怎么自救)处理。

## 部署前提

dsh 0.1.2 起 Web 端有两道门槛，需要配套：

1. **受信域名**：`/api` 与 RPC 通道的 Host/Origin 栅栏只接受回环或 `--trusted-host` 声明的权威。经域名访问必须以
   `dsh web --trusted-host <你的域名>` 启动（写域名即可，端口可省略，匹配任意端口）。
   本插件在加载后会自动把配置里的域名注册进 `trustedHosts`（等价 `--trusted-host`），**因此裸 `dsh web` 启动也能经域名访问**；
   但仍建议显式带上 `--trusted-host` 作为兜底。
2. **网页 token 鉴权**：每个请求（含回环）都需携带鉴权 cookie；首次访问要经 `/?token=<进程token>` 换取。
   插件**自动模式**开启时自动完成这一步（浏览器直接访问 `https://域名:端口` 即可）；关闭时请手动使用 `dsh web`
   启动时打印的带 token URL。

此外，dsh 客户端因 `connection.isLoopback` 判定会**禁用设置页**（settings 仅回环同源可用）。放行方式：

**推荐：在插件卡片点「一键打热补丁」**（自动完成，无需手改文件）

在 设置 → 插件配置 → Https Fix 展开卡片，点「一键打热补丁」即可为当前配置的**域名**写入 `connection.isLoopback` 豁免，随后**刷新页面**生效（HMR 自动热更新，无需重启 dsh）。该按钮不受设置页"只读/不可用"限制。

> 豁免按 **hostname** 匹配（端口无关）：域名前面挂 nginx 等前置代理时，浏览器地址栏端口（对外端口）与本插件 `httpsPort` 可以不同，按 `域名:端口` 匹配会漏豁免。旧部署写入的 `pageLocation.host === "域名:端口"` 形式仍然兼容，「还原补丁」会把两种形式一并清掉。

**备选：手动放行**（插件不可用时）

**方式 A：经回环地址访问设置页**（无需改任何文件）

用 SSH 本地转发，然后访问回环地址即可：

```bash
ssh -L 3080:127.0.0.1:3080 <用户>@<服务器>
# 浏览器打开 http://127.0.0.1:3080
```

**方式 B：给 dsh 客户端 bundle 打补丁**（域名访问设置页也可用）

编辑 dsh 安装内的 `@deepseek-ai/dsh-client-connection/lib/client.js`，找到 `isLoopback:` 那一行
（dsh 0.1.2 为 `isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname)`，
0.1.1 为 `isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname)`）：

```js
isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname)
```

在其后追加你的域名豁免（推荐按 hostname，端口无关）：

```js
isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname) || pageLocation.hostname === "你的域名"
```

若你的浏览器访问端口与插件监听端口一致，也可用带端口的形式 `|| pageLocation.host === "你的域名:端口"`（插件两种都认）。

保存后**刷新页面**即可（客户端 bundle 变更由 dsh HMR 自动热更新，无需重启 dsh）。注意：dsh 升级会覆盖该文件，需重新打补丁。

## 故障排查

### dsh 启动直接失败：`plugin(s) failed to load` / `entry did not activate`

**第一嫌疑是版本不匹配**，见开头[版本警告](#-必须使用与-dsh-版本对应的插件版本否则-dsh-会不可用)。
先 `dsh --version` 与插件分支名核对；确认无误后，再按提示的插件名排查该插件的导出/`inject` 是否与当前 dsh 一致。

### dsh 跑一会儿整个进程退出：`dsh: fatal load failure: …`

**根因在 dsh 本身**：`@deepseek-ai/dsh-app-boot` 给进程注册了 `installFailLoud`（`unhandledRejection` 处理器），
**任何插件漏出的未处理 Promise rejection 都会打印 `dsh: fatal load failure: <stack>` 并 `process.exit(1)`**。
它发生在「启动完成之后」，所以表现为 dsh 正常跑一段时间后突然整个进程消失；"load failure" 这个措辞是误导，并不代表插件树加载失败。

排查步骤：

1. 让 dsh 的 stdout/stderr 落盘，例如 `dsh web --trusted-host <域名> 2>&1 | tee dsh-web.log`；崩溃时最后一行就是真实栈。
2. 若栈指向本插件：**`dsh-0.1.5-alpha.1` / `dsh-0.1.5-rc.1` 分支起已修复**。插件内所有异步入口——60 秒证书热重载定时器、settings `onChange`、
   RPC 处理器、HTTPS 请求/升级/TLS 握手回调，以及代理内部的 `httpRequest`（对非法头/路径会同步抛出）——全部就地
   收敛为日志；出问题时只会看到 `[https-fix] … 异常: <stack>`，服务继续运行。
3. 若栈指向别的插件，按同一原则修：`void (async () => …)()`、`onChange: () => asyncFn()`、事件回调里的 `async`
   都必须自带 `.catch()` 或 `try/catch`。

### 经域名访问 403 / 设置页不可用

见上文「部署前提」：`--trusted-host`（或让插件自动注册）与「一键打热补丁」两项都要做。卡片里的「校验 HTTPS 可用性」会逐项给出结论。

## 许可

MIT
