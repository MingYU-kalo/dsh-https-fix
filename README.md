# dsh-https-fix

> ⚠️ **维护说明**：本项目主要服务于**作者本人使用**。更新频率与作者升级 dsh 新版本深度绑定，统计学上**无法预测**更新节奏。如有使用需求，请 `git` 拉取最新版本并自行修复/适配。

DeepSeek Harness (dsh) 插件：为 dsh Web GUI 提供**内置 HTTPS 反代与可配置管理**。

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
| `dsh-<版本号>` | 与特定 dsh 版本兼容的冻结分支，如 `dsh-0.1.2-rc.1`（当前）、`dsh-0.1.1-rc.2` |

## 安装

> 本插件**未发布到 npm**，请从 Git 或本地路径安装。

按 dsh 版本安装对应冻结分支（推荐，与你的 dsh 版本严格对应）：

```bash
# dsh 0.1.1-rc.2 对应分支
dsh plugin --profile web add github:MingYU-kalo/dsh-https-fix#dsh-0.1.1-rc.2
# 或始终追随最新代码（main，可能超前于你的 dsh 版本）
dsh plugin --profile web add github:MingYU-kalo/dsh-https-fix#main
```

本地 clone 后自行修改/修复，再从本地路径安装：

```bash
git clone https://github.com/MingYU-kalo/dsh-https-fix.git
dsh plugin --profile web add file:./dsh-https-fix
```

安装完成后**重启 dsh web** 生效；插件出现在 设置 → 插件配置 → Https Fix。

## 部署前提

dsh 0.1.2 起 Web 端有两道门槛，需要配套：

1. **受信域名**：`/api` 与 RPC 通道的 Host/Origin 栅栏只接受回环或 `--trusted-host` 声明的权威。经域名访问必须以
   `dsh web --trusted-host <你的域名>` 启动（写域名即可，端口可省略，匹配任意端口）。
2. **网页 token 鉴权**：每个请求（含回环）都需携带鉴权 cookie；首次访问要经 `/?token=<进程token>` 换取。
   插件**自动模式**开启时自动完成这一步（浏览器直接访问 `https://域名:端口` 即可）；关闭时请手动使用 `dsh web`
   启动时打印的带 token URL。

此外，dsh 客户端因 `connection.isLoopback` 判定会**禁用设置页**（settings 仅回环同源可用）。放行方式：

**推荐：在插件卡片点「一键打热补丁」**（自动完成，无需手改文件）

在 设置 → 插件配置 → Https Fix 展开卡片，点「一键打热补丁」即可为当前配置的 `域名:https端口` 写入 `connection.isLoopback` 豁免，随后**刷新页面**生效（HMR 自动热更新，无需重启 dsh）。该按钮不受设置页"只读/不可用"限制。

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

在其后追加你的域名（含端口）豁免：

```js
isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname) || pageLocation.host === "你的域名:端口"
```

保存后**刷新页面**即可（客户端 bundle 变更由 dsh HMR 自动热更新，无需重启 dsh）。注意：dsh 升级会覆盖该文件，需重新打补丁。

## 许可

MIT
