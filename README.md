# dsh-https-fix

**一句话：让 dsh 的 Web GUI 能从外网访问。** 自带 HTTPS 反向代理、受信域名注册、客户端热补丁、Web 账密登录、证书管理（自动自签 / 自有证书 / 无域名用 IP）。

> 本项目主要服务于**作者本人使用**。更新节奏与作者升级 dsh 的节奏绑定，**不定期、无法预测**；请自行拉取最新代码并自行承担适配成本。

---

## ⚠️ 高危插件：先读完这三条再装

1. **它改了 dsh 的源码。** dsh 没有官方扩展点，插件靠给 dsh 安装目录里的 `@deepseek-ai/dsh-client-connection/lib/client.js` 打**运行时热补丁**来放行设置页。**dsh 一升级就被覆盖**，需要重新打补丁。
2. **装错版本 = dsh 直接起不来**（不是"功能不可用"）。插件版本必须与 dsh 版本**严格一致**：`dsh --version` 的输出 = 要装的分支名 = 插件 `version`。升 dsh 之前，先把插件切到对应分支，或者先禁用插件。
3. **它把 dsh 暴露到公网。** dsh 里的 agent 能在你机器上执行命令；请务必改掉默认密码、配好防火墙白名单。默认账密是 `admin` / `admin`，登录页的「忘记密码?」里有重置办法。

> ## 🔴 dsh 更新时必须同时处理这个插件
>
> **dsh 一升级，旧插件会让 dsh 完全起不来。** 所以升级 dsh 前**二选一，不能跳过**：
>
> 1. **先把插件关掉**：`dsh plugin --profile web remove dsh-https-fix`，或者在 `$DSH_HOME/profiles/web/cordis.patch.yml` 里给 `https-fix` 那一行加上 `disabled: true`；
> 2. **或者让 agent 一并更新**：把下面这句话交给你的 agent ——
>
>    > “我要把 dsh 从 <旧版本> 升到 <新版本>。请按 `AGENTS.md` 的升级顺序，先把 dsh-https-fix 切到 `dsh-<新版本>` 分支（上游没有该分支就先禁用插件），再升级 dsh；重启后跑完 12 项校验、重打热补丁，最后把结果报给我。”
>
> **顺序永远是：先处理插件，再升级 dsh。** 反过来就是 dsh 起不来的事故（`plugin(s) failed to load`）。

---

## 安装（可以直接把下面这段丢给 agent 让它干）

> **复制这句话给你的 agent**：
> “读 `https://github.com/MingYU-kalo/dsh-https-fix/blob/main/AGENTS.md`，按它安装 dsh-https-fix；安装前先问我它要求的四个必问问题。”
>
> agent 版完整步骤、四个必问问题（http 是否公网 / IP 还是域名 / 自签还是自有证书 / 是否启用账密登录）、装完验证、以及**重置登录账密的方法**都在 [AGENTS.md](AGENTS.md)。

自己动手就三步：

    dsh --version                                                             # 1) 记下版本，例如 0.1.7-rc.1
    dsh plugin --profile web add github:MingYU-kalo/dsh-https-fix#dsh-<版本>   # 2) 装同名分支
    # 3) 重启 dsh web，浏览器打开 https://<域名或IP>:<https端口>，用 admin/admin 登录

首次进入后到 **设置 → 插件配置 → Https Fix**：填域名或 IP、选证书（两个路径都留空 = 自动自签）、点「一键打热补丁」，再点「校验 HTTPS 可用性」应当 **12 项全绿**。

本地路径安装必须带 `file:` 前缀（裸路径会被装成 `link:` 依赖，dsh 直接起不来）：

    dsh plugin --profile web add file:/path/to/dsh-https-fix

---

## 版本对应表

| dsh 版本 | 装哪个分支（= 插件版本） |
|---|---|
| `0.1.7-rc.1`（当前） | `dsh-0.1.7-rc.1`、`main` |
| `0.1.5-rc.2` | `dsh-0.1.5-rc.2` |
| `0.1.5-rc.1` | `dsh-0.1.5-rc.1` |
| `0.1.5-alpha.1` | `dsh-0.1.5-alpha.1` |
| `0.1.2-rc.1` | `dsh-0.1.2-rc.1` |
| `0.1.1-rc.2` | `dsh-0.1.1-rc.2` |

> 自检：`dsh --version` 必须与插件 `package.json` 的 `version` **完全一致**；不一致就是装错分支了。

---

## dsh 起不来时怎么自救

    # 方式 1：卸载插件
    dsh plugin --profile web remove dsh-https-fix

    # 方式 2：只禁用这一行（$DSH_HOME/profiles/web/cordis.patch.yml 必须是顶层数组）
    - insert:
        - id: https-fix
          name: dsh-https-fix
          disabled: true

改完重启 dsh web 即可恢复。

---

## 功能一览（都在卡片里配置，一行一个设置）

- **HTTPS 反代**：插件自己监听 TLS，反代到 `127.0.0.1:<httpPort>`，不依赖 nginx
- **受信域名**：运行时把域名/IP 注册进 `trustedHosts`，不用改 dsh 启动参数
- **客户端热补丁**：一键给 dsh 的 `connection.isLoopback` 打豁免（含还原），让经域名/IP 访问的设置页可用
- **TLS 证书**：自动自签（含公网 IP，无域名也能用）或填自己的 cert/key 路径（Let's Encrypt 的 IP 证书也行）
- **Web 账密登录**：默认开启；账号明文保存、密码只存 SHA-256；会话 7 天；只作用于插件端口
- **访问与安全**：关闭 http 外网访问、自动模式（网页 token）、http 端口、核对版本号（不一致拒绝启动 HTTPS）
- **诊断**：「校验 HTTPS 可用性」（12 项，含登录项）、「一键打热补丁」「还原补丁」

---

## 文档

- [AGENTS.md](AGENTS.md) —— 给 agent 的安装/维护手册（四个必问问题 + 重置密码步骤）
- [docs/MAINTENANCE.md](docs/MAINTENANCE.md) —— 内部机制、代码地图、排障手册
- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) —— 最早的需求文档

## 许可

[MIT](LICENSE) © 2026 MingYU-kalo
