# dsh-https-fix

DeepSeek Harness (dsh) 插件：为 dsh Web GUI 提供**内置 HTTPS 反代与可配置管理**。

在 **设置 → 插件配置 → Https Fix** 中统一管理：

- 保留/校验 HTTP 端口（默认开）
- HTTPS 开关（默认关）、HTTPS 端口（默认 3081，可复用 http 端口）
- 域名、监听地址、TLS 证书/密钥路径
- 「校验 HTTPS 可用性」按钮（端口 / 证书配对 / 域名逐项校验并输出日志）
- 「保存配置」按钮

详细需求与技术方案见 [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md)。

## 分支策略

| 分支 | 内容 |
|------|------|
| `main` | 最新代码（跟随 dsh 最新版本） |
| `dsh-<版本号>` | 与特定 dsh 版本兼容的冻结分支，如 `dsh-0.1.1-rc.2` |

## 安装（开发期预览）

```bash
dsh plugin --profile web add github:MingYU-kalo/dsh-https-fix#dsh-0.1.1-rc.2
# 重启 dsh web 后生效
```

## 部署前提

- 经域名访问时，设置页需要客户端 `connection.isLoopback` 放行（dsh 客户端门）。
- 若保留外部 nginx 反代，SSE 通道需 `proxy_buffering off`。

## 许可

MIT
