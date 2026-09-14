# AGENTS.md — 给 agent 的安装/维护手册（dsh-https-fix）

> 这是给**替你干活的 AI agent** 看的操作手册。人类用户请看 [README.md](README.md)。
> agent：请从头读完再动手，**先问完第 1 节的四个问题**，再碰任何文件。

---

## 🔴 绝对不可逾越的界限

> ## 禁止让 dsh 自己给自己装这个插件。
>
> - 如果**你（agent）就跑在目标 dsh 里**（你的进程树里有 `dsh web`）：**不要**在这个 dsh 上安装/升级本插件，**不要**重启它。
>   安装/重启会把你自己杀掉，或者把写到一半的配置留在生产上。
> - **不要**用 `pkill -f "dsh web"`（会匹配到你自己所在的进程树），**不要** `systemctl restart` 你所在的 dsh。
> - 正确做法（任选）：
>   1. 把安装步骤交给**人类**在另一个终端执行；或
>   2. 在**隔离环境**验证：另建 `DSH_HOME`（如 `/tmp/dsh-test-home`）+ 独立端口（`--port`）+ 独立进程（`systemd-run` / `setsid`），绝不碰生产 `$DSH_HOME`。
> - 需要重启生产 dsh 时：**先告知人类**，并给出回滚方式。可以用 `systemd-run --on-active=<秒>` 之类脱离式方式安排，但必须人类知情。

---

## 0. 这是什么，为什么危险

`dsh-https-fix` 让 dsh 的 Web GUI 可以从外网访问：自带 HTTPS 反向代理、把域名注册进 `trustedHosts`、给 dsh 的客户端 bundle 打 `isLoopback` 热补丁、可选的 Web 账密登录、可选的自签/IP 证书。

**它为什么是高危插件：**

| 事实 | 后果 |
|---|---|
| 不通过官方扩展点，**直接改 dsh 安装目录里的** `@deepseek-ai/dsh-client-connection/lib/client.js` | dsh 一升级就被覆盖，设置页会「在此浏览器不可用」，需要重打热补丁 |
| 插件版本必须与 dsh 版本**严格一致**，否则 `inject`/导出对不上 | dsh **启动直接失败**（`plugin(s) failed to load` / `entry did not activate`），不是"功能不可用" |
| 它把 dsh 暴露到公网 | 等于把「能在你机器上执行命令的 agent」挂到互联网；必须配账密登录 + 防火墙白名单 |

---

## 1. 安装前必须问清的四个问题（一个都不能省）

按顺序问，拿到答案再动手。第 2、4 问有追加问题。

### 问题 1：是否开放 http 公网访问？

- **不开放（推荐）** → 配置 `blockHttpExternalAccess: true`（插件会往 `$DSH_HOME/cordis.patch.yml` 写机器级补丁，**重启 dsh 才生效**）
- **开放** → `blockHttpExternalAccess: false`

> 提醒人类：开启前先确认 HTTPS 侧已经可用，否则 http 一旦只监听 127.0.0.1，就没有兜底入口了。

### 问题 2：HTTPS 使用 **IP 地址** 还是 **域名**？

- **域名** → `domain: <域名>`（必须与浏览器地址栏里的 host **完全一致**；不要带端口）
- **IP 地址** → **再问一遍：IPv4 还是 IPv6？**
  - **IPv4** → `domain: <IPv4>`
  - **IPv6** → `domain: [<IPv6>]`（**要带方括号**）。并且**必须**走第 3 问的「提供证书路径」：插件自动生成的自签证书只写 IPv4 的 IP SAN，覆盖不了 IPv6，直接用会校验失败

### 问题 3：TLS 证书用 **插件自签** 还是 **你提供证书 & 密钥路径**？

- **自签（省事，浏览器会警告一次）** → `certPath: ""` 且 `keyPath: ""`（两个都留空 = 自动自签；SAN 覆盖「配置的域名/IP + 127.0.0.1 + localhost」，私钥 0600，放 `$DSH_HOME/https-fix/`，有效期 10 年）
- **提供路径** → 填 `certPath` / `keyPath`（PEM；**必须成对填**，只填一个插件不会启动 HTTPS）。例如 Let's Encrypt 证书、企业证书，或 IPv6 场景的带 IP SAN 证书

### 问题 4：是否启用 **Web 账密登录**？

- **启用（推荐）** → `loginEnabled: true`，然后**顺便问**：是否修改默认账号密码？
  - 告诉人类默认凭据是 **`admin` / `admin`**
  - 要改 → `loginUser: <账号>`，`loginPasswordHash: <新密码的 SHA-256 十六进制>`
- **不启用** → `loginEnabled: false`（此时校验里的「登录」项会标红，属预期）

### 顺带确认的（可以不问，但要写进配置）

- `httpPort`：dsh 自身端口（默认 3080；不填则用运行时实际端口）
- `httpsPort`：插件监听端口（默认 3081；若前面还挂了 nginx 就换一个，如 3082）
- `address`：`0.0.0.0`（所有网卡）或 `127.0.0.1`（只本机 / 前置代理）

---

## 2. 安装步骤

### 2.0 dsh 升级时的顺序（人类要升级 dsh 时先看这里）

**铁律：先处理插件，再升级 dsh。** 带着旧版本插件启动新版本 dsh = dsh 直接起不来。

1. 先看上游有没有对应分支：

       git ls-remote --heads https://github.com/MingYU-kalo/dsh-https-fix.git | grep 'dsh-<新版本>'

2. 分两种情况：
   - **有该分支** → 先把插件切过去（`dsh plugin --profile web add github:MingYU-kalo/dsh-https-fix#dsh-<新版本>`），再升级 dsh；
   - **没有该分支** → **先禁用插件**（`dsh plugin --profile web remove dsh-https-fix`，或在 profile 的 `cordis.patch.yml` 里写 `disabled: true`），再升级 dsh。等作者适配出分支后再装回来。
3. 升级完成后：按第 3 节跑一遍 12 项校验，并**重打一次热补丁**（dsh 升级会覆盖它的客户端 bundle）。
4. 全程遵守上面的红线：要重启的 dsh 如果就是你所在的实例，**交给人类执行**。

### 2.1 先对版本（错版本会让 dsh 起不来）

    dsh --version        # 例如 0.1.5-rc.2

### 2.2 装对应分支（分支名 = 插件版本 = 目标 dsh 版本）

    # 从 GitHub 装（推荐）：分支名必须与 dsh --version 完全一致
    dsh plugin --profile web add github:MingYU-kalo/dsh-https-fix#dsh-<dsh版本>

    # 从本地路径装：必须带 file: 前缀
    # 裸路径会被 pnpm 装成 link: 依赖，插件按真实路径解析不到 @deepseek-ai/schemastery，dsh 直接起不来
    dsh plugin --profile web add file:/path/to/dsh-https-fix

### 2.3 写配置（`$DSH_HOME/settings.yaml` 的 `https-fix` 段）

把第 1 节的四个答案落进去，例如（**按实际答案改**）：

    https-fix:
      blockHttpExternalAccess: true          # 问题1：不开放 http 公网
      enableHttps: true
      domain: dsh.example.com                # 问题2：域名（IP 就填 IP，IPv6 写 [addr]）
      httpsPort: 3081
      address: 0.0.0.0
      certPath: ""                           # 问题3：留空 = 自动自签
      keyPath: ""
      loginEnabled: true                     # 问题4：启用登录
      loginUser: admin
      loginPasswordHash: 8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918

> 改 `settings.yaml` 前先备份；这个文件是 dsh 维护的，别把别的插件的段弄丢。
> 只想改密码：见第 4 节。

### 2.4 重启 dsh（人类执行，见红线）

    # 让人类在他自己的终端里重启 dsh web；或先问清楚启动方式
    # 插件对 host 侧的改动必须重启才生效；只改客户端卡片则浏览器硬刷新即可

### 2.5 首次访问要做两件事

1. **登录**：默认 `admin` / `admin`（如果问题 4 改过就用新凭据）
2. **一键打热补丁**：设置 → 插件配置 → Https Fix → 诊断 → 「一键打热补丁」（把 `isLoopback` 豁免写进 dsh 的客户端 bundle，让经域名/IP 访问的设置页可用）。dsh 每次升级后都要重打一次。

---

## 3. 装完必须验证（12 项全绿）

    BASE=https://<域名或IP>:<https端口>
    JAR=/tmp/hf-jar; rm -f $JAR

    # 1) 登录（启用登录时；默认 admin/admin）
    curl -sk -c $JAR -o /dev/null -w '%{http_code}\n' -d 'user=admin&password=admin' "$BASE/__https-fix/login"   # 期望 303

    # 2) 插件校验：期望 result.log 12 项全 ok:true
    curl -sk -b $JAR -X POST "$BASE/api/https-fix/validate" \
      -H 'content-type: application/json' \
      -d '{"type":"client-request","method":"https-fix/validate","rpcId":"t","payload":{}}'

逐项应为：版本核对 / 受信域名 / 登录 / 热补丁 / HTTPS 端口 / 证书来源 / 自签证书就绪 / 证书解析 / 证书包含域名或 IP / 证书与密钥配对 / 域名解析 / HTTP 端口可达。

任何一项红：
- **版本核对**红 → 分支装错了，按 2.2 重装对应分支
- **热补丁**红 → 点「一键打热补丁」后重验
- **受信域名**红 → 域名与地址栏不一致，或插件还没重启
- **证书包含域名/IP** 红 → 证书不含该名字（IPv6 + 自签必然如此，按问题 2/3 的说明改）

---

## 4. 修改 / 重置登录账号密码（人类来问就照这个做）

**原则：账号明文保存，密码只存 SHA-256。**

### 4.1 在界面里改（推荐）

设置 → 插件配置 → Https Fix → 访问与安全 → 登录账号 / 登录密码（输入新密码 → 保存；密码框由浏览器算好 SHA-256 再写入）。

### 4.2 直接改配置文件（忘记密码时）

    # 算出新密码的 SHA-256
    printf '%s' '你的新密码' | sha256sum | cut -d' ' -f1

把得到的十六进制填进 `$DSH_HOME/settings.yaml`：

    https-fix:
      loginUser: admin
      loginPasswordHash: <上一步的哈希>

然后**重启 dsh**（人类执行）。

### 4.3 重置回默认（admin / admin）

    # 默认密码 admin 的 SHA-256
    loginPasswordHash: 8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918

> 改 `loginUser` 会让所有已登录会话失效（令牌里绑定了账号）。
> 登录会话有效期 7 天，密钥在 `$DSH_HOME/https-fix/session.key`（0600）；删掉它 = 所有会话立即失效。

---

## 5. 出事怎么办

| 症状 | 处置 |
|---|---|
| dsh 起不来，报 `plugin(s) failed to load` / `entry did not activate` | 版本不匹配。`dsh plugin --profile web remove dsh-https-fix`，或把 `$DSH_HOME/profiles/web/cordis.patch.yml` 改成顶层数组：`- insert: [{id: https-fix, name: dsh-https-fix, disabled: true}]`（**只有注释会被解析成 null 并报错**） |
| 跑一段时间后 `dsh: fatal load failure` | 插件漏了未处理的 Promise rejection，按 `dsh-app-boot/lib/index.js` 的 `installFailLoud` 机制整个进程退出；把 stack 贴出来定位 |
| 经域名访问 `/api` 403 | 域名与地址栏不一致，或 `ensureTrustedHost` 没跑到（重启插件） |
| 设置页显示「在此浏览器不可用」 | 热补丁被打回（dsh 升级过），重打 |
| 页面无限跳转 | 「自动模式（网页 token）」被关了，重新打开 |
| 忘记账号密码 | 见第 4 节 |

细节与内部机制见 [docs/MAINTENANCE.md](docs/MAINTENANCE.md)。

---

## 6. 红线再念一遍

> 🔴 **不要让 dsh 给自己装/重启这个插件。**
> 🔴 **不要在生产 `$DSH_HOME` 上做实验**，用隔离 `DSH_HOME` + 独立端口。
> 🔴 **不要 `pkill -f "dsh web"`**；要停就按 `ss -ltnp` 取到的 PID 精确 kill。
> 🔴 **不要把本仓库的私密信息（服务器 IP、域名、证书路径、token）提交回公开仓库。**
