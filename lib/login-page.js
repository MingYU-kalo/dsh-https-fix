/**
 * 登录页(插件自带,不依赖 dsh 前端)。
 *
 * 视觉照抄 dsh 自己的主题令牌取值:
 *   深色 bg-base #151517 / layer-2 #2c2c2e / 文本 #f9fafb / 次要 #cfd3d6 / 边框 #ffffff1f
 *   浅色 bg-base #fff    / layer-2 #fff    / 文本 #0f1115 / 次要 #61666b / 边框 #0000001a
 *   主按钮 = dsh 的 brand-primary(浅色黑底白字、深色白底黑字),强调色 #4176e6
 * 跟随系统深浅色(prefers-color-scheme),字体栈与 dsh 一致。
 */

export const LOGIN_PATH = "/__https-fix/login"
export const LOGOUT_PATH = "/__https-fix/logout"
export const COOKIE_NAME = "hf-auth"
/** 会话有效期:7 天。 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 单次请求体上限(登录表单很小)。 */
export const MAX_BODY_BYTES = 4096

/**
 * 「忘记密码」里的重置方法说明(原样渲染,不要塞不可信内容)。
 * 改这里只需保持 HTML 片段合法;内容要与 AGENTS.md 第 4 节保持一致。
 */
export const RESET_METHOD_HTML = [
  "<p><strong>办法一:找你的 agent</strong> —— 把仓库里的 <code>AGENTS.md</code> 交给它,或者说「按 AGENTS.md 重置 dsh-https-fix 的登录账号密码」,它会改配置并让 dsh 重启。</p>",
  "<p><strong>办法二:自己动手(详细步骤)</strong></p>",
  "<ol>",
  "<li>算新密码的 SHA-256:<br><code>printf '%s' '新密码' | sha256sum</code></li>",
  "<li>编辑 <code>$DSH_HOME/settings.yaml</code>(默认 <code>~/.dsh/settings.yaml</code>),把 <code>https-fix.loginPasswordHash</code> 改成上一步的哈希;账号在 <code>https-fix.loginUser</code>(默认 admin)</li>",
  "<li>重启 dsh —— host 侧配置改动必须重启才生效</li>",
  "<li>想直接回到默认:把 <code>loginPasswordHash</code> 填成 <code>8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918</code>(= sha256(admin)),重启后用 admin / admin 登录</li>",
  "</ol>"
].join("")

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

const PAGE_CSS = [
  ":root{color-scheme:dark light;--hf-bg:#151517;--hf-layer:#2c2c2e;--hf-text:#f9fafb;--hf-text-2:#cfd3d6;--hf-text-3:#adb2b8;--hf-border:#ffffff1f;--hf-field:#1b1b1c;--hf-btn:#f9fafb;--hf-btn-text:#151517;--hf-danger:#f25a5a;--hf-accent:#4176e6}",
  "@media (prefers-color-scheme: light){:root{--hf-bg:#fff;--hf-layer:#fff;--hf-text:#0f1115;--hf-text-2:#61666b;--hf-text-3:#81858c;--hf-border:#0000001a;--hf-field:#f9fafb;--hf-btn:#0f1115;--hf-btn-text:#fff;--hf-danger:#ec1313}}",
  "*{box-sizing:border-box}",
  "html,body{height:100%}",
  "body{margin:0;background:var(--hf-bg);color:var(--hf-text);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:24px;font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,\"Segoe UI\",\"PingFang SC\",\"Hiragino Sans GB\",\"Microsoft YaHei\",\"Helvetica Neue\",Helvetica,Arial,sans-serif);-webkit-font-smoothing:antialiased}",
  ".hf-card{width:100%;max-width:380px;background:var(--hf-layer);border:1px solid var(--hf-border);border-radius:12px;padding:28px 26px 22px}",
  ".hf-brand{display:flex;align-items:center;gap:9px;font-size:16px;font-weight:600;letter-spacing:.01em}",
  ".hf-dot{width:9px;height:9px;border-radius:50%;background:var(--hf-accent);flex:none}",
  ".hf-sub{margin:6px 0 20px;color:var(--hf-text-3);font-size:13px}",
  ".hf-field{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}",
  ".hf-field>span{font-size:13px;color:var(--hf-text-2)}",
  ".hf-input{width:100%;padding:9px 11px;font:inherit;font-size:14px;color:var(--hf-text);background:var(--hf-field);border:1px solid var(--hf-border);border-radius:8px;outline:none}",
  ".hf-input:focus{border-color:var(--hf-accent)}",
  ".hf-error{margin:0 0 12px;color:var(--hf-danger);font-size:13px;line-height:1.5}",
  ".hf-submit{width:100%;padding:9px 14px;font:inherit;font-size:14px;font-weight:500;color:var(--hf-btn-text);background:var(--hf-btn);border:1px solid #0000;border-radius:8px;cursor:pointer}",
  ".hf-submit:active{opacity:.85}",
  ".hf-forgot{margin-top:16px;font-size:13px}",
  ".hf-forgot>summary{cursor:pointer;color:var(--hf-text-3);list-style:none}",
  ".hf-forgot>summary::-webkit-details-marker{display:none}",
  ".hf-forgot>summary:hover{color:var(--hf-text-2)}",
  ".hf-forgotBody{margin-top:10px;padding:12px;border:1px solid var(--hf-border);border-radius:8px;color:var(--hf-text-2);font-size:13px;line-height:1.7}",
  ".hf-forgotBody p{margin:0 0 6px}",
  ".hf-forgotBody h4{margin:10px 0 4px;font-size:13px;color:var(--hf-text)}",
  ".hf-forgotBody code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--hf-field);border:1px solid var(--hf-border);border-radius:5px;padding:1px 5px;font-size:12px}",
  ".hf-foot{color:var(--hf-text-3);font-size:12px;text-align:center;line-height:1.6;max-width:380px}"
].join("")

/**
 * 渲染登录页。
 * @param {object} opts
 * @param {string} [opts.error] 错误提示(会转义)
 * @param {string} [opts.user]  回填的账号
 * @param {string} [opts.next]  登录后跳回的站内路径
 */
export function loginPageHtml({ error = "", user = "", next = "/" } = {}) {
  const safeNext = String(next ?? "/").startsWith("/") && !String(next).startsWith("//") ? String(next) : "/"
  return "<!doctype html>" +
    '<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>登录 · DeepSeek Harness</title>" +
    "<style>" + PAGE_CSS + "</style></head><body>" +
    '<main class="hf-card">' +
    '<div class="hf-brand"><span class="hf-dot"></span>DeepSeek Harness</div>' +
    '<p class="hf-sub">Https Fix 访问验证</p>' +
    '<form method="post" action="' + LOGIN_PATH + '">' +
    '<input type="hidden" name="next" value="' + escapeHtml(safeNext) + '">' +
    '<label class="hf-field"><span>账号</span>' +
    '<input class="hf-input" name="user" value="' + escapeHtml(user) + '" autocomplete="username" autocapitalize="off" spellcheck="false" autofocus></label>' +
    '<label class="hf-field"><span>密码</span>' +
    '<input class="hf-input" name="password" type="password" autocomplete="current-password"></label>' +
    (error ? '<p class="hf-error">' + escapeHtml(error) + "</p>" : "") +
    '<button class="hf-submit" type="submit">登录</button>' +
    "</form>" +
    '<details class="hf-forgot"><summary>忘记密码?</summary>' +
    '<div class="hf-forgotBody">' +
    "<p>默认账号:<code>admin</code></p>" +
    "<p>默认密码:<code>admin</code></p>" +
    "<h4>重置为默认密码的方法</h4>" +
    '<div class="hf-resetNote">' + RESET_METHOD_HTML + "</div>" +
    "</div></details>" +
    "</main>" +
    '<footer class="hf-foot">登录由 dsh-https-fix 插件提供,与 dsh 自身的网页鉴权相互独立</footer>' +
    "</body></html>"
}
