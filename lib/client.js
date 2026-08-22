/**
 * dsh-https-fix 浏览器端 bundle(单文件,经 __ModuleLoader__ 加载)。
 *
 * 向 `settings.plugin.item` 槽位注册折叠卡片(key = settings 命名空间 `https-fix`),
 * 渲染「设置 → 插件配置 → Https Fix」:与其它插件卡片一致的折叠式配置卡片
 * (头部标题+描述,点击展开字段与「校验 HTTPS 可用性」「保存配置」按钮)。
 *
 * 数据通道:读/写走 settingsScope(共享 settings 镜像 + settings.update 写路径);
 * 校验走自有 RPC 通道 POST /https-fix/validate。
 */
window.__ModuleLoader__.load({
  id: "dsh-https-fix",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const { jsx, jsxs } = require("react/jsx-runtime");

    const NS = "https-fix";
    const name = "dsh-https-fix";
    const inject = ["slots", "settingsScope"];

    // ── 折叠卡片样式(复用设置页 --dsw-* 主题令牌,与其它插件卡片一致) ──
    const cssText = [
      ".hf_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}",
      ".hf_card:hover{border-color:var(--dsw-alias-label-dimmed)}",
      ".hf_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}",
      ".hf_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}",
      ".hf_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}",
      ".hf_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}",
      ".hf_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}",
      ".hf_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}",
      ".hf_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}",
      ".hf_chevronOpen{transform:rotate(180deg)}",
      ".hf_body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:10px;display:flex;flex-direction:column;gap:12px}",
      ".hf_pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}",
      ".hf_readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}",
      ".hf_field{display:flex;flex-direction:column;gap:4px;margin-top:12px}",
      ".hf_field:first-of-type{margin-top:0}",
      ".hf_label{font-size:13px;font-weight:500}",
      ".hf_hint{font-size:12px;color:var(--dsw-alias-label-tertiary)}",
      ".hf_input{width:100%;max-width:340px;padding:6px 8px;font-size:13px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:inherit}",
      ".hf_check{display:flex;align-items:center;gap:8px;font-size:13px}",
      ".hf_log{display:flex;flex-direction:column;gap:2px;font-size:12px;font-family:ui-monospace,monospace}",
      ".hf_logOk{color:var(--dsw-alias-label-success,#16a34a)}",
      ".hf_logErr{color:var(--dsw-alias-label-error,#dc2626)}",
      ".hf_footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex;margin-top:4px}",
      ".hf_btn,.hf_btnPrimary{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}",
      ".hf_btn{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}",
      ".hf_btnPrimary{color:var(--dsw-alias-label-inverse,#fff);background:var(--dsw-alias-brand-primary,#3b82f6)}",
      ".hf_btn:disabled,.hf_btnPrimary:disabled{cursor:not-allowed;opacity:.5}"
    ].join("\n");
    const cssTagId = "dsh-https-fix/card.module.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(cssTagId) + "]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-https-fix";
      tag.dataset.pluginCss = cssTagId;
      tag.textContent = cssText;
      document.head.appendChild(tag);
    }
    const css = {
      card: "hf_card", cardOpen: "hf_cardOpen", header: "hf_header", headText: "hf_headText",
      name: "hf_name", description: "hf_description", chevron: "hf_chevron", chevronOpen: "hf_chevronOpen",
      body: "hf_body", pending: "hf_pending", readOnly: "hf_readOnly", field: "hf_field",
      label: "hf_label", hint: "hf_hint", input: "hf_input", check: "hf_check",
      log: "hf_log", logOk: "hf_logOk", logErr: "hf_logErr", footer: "hf_footer",
      btn: "hf_btn", btnPrimary: "hf_btnPrimary"
    };

    function cx() {
      return Array.prototype.filter.call(arguments, Boolean).join(" ");
    }

    function Chevron(props) {
      return jsx("svg", {
        width: 14, height: 14, viewBox: "0 0 14 14", fill: "none", "aria-hidden": true,
        className: cx(css.chevron, props.open && css.chevronOpen),
        children: jsx("path", { d: "M3 5l4 4 4-4", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" })
      });
    }

    function Field(props) {
      return jsx("div", { className: css.field, children: [
        jsx("label", { className: css.label, children: props.label }),
        props.hint ? jsx("span", { className: css.hint, children: props.hint }) : null,
        props.children
      ] });
    }

    function BoolField(props) {
      return jsx("label", { className: css.check, children: [
        jsx("input", { type: "checkbox", checked: !!props.value, disabled: props.disabled, onChange: (e) => props.onChange(e.target.checked) }),
        jsx("span", { children: props.label })
      ] });
    }

    function TextField(props) {
      return jsx("input", { className: css.input, type: "text", value: props.value ?? "", placeholder: props.placeholder, disabled: props.disabled, onChange: (e) => props.onChange(e.target.value) });
    }

    function NumberField(props) {
      return jsx("input", { className: css.input, type: "number", min: 1, max: 65535, value: props.value ?? "", placeholder: props.placeholder, disabled: props.disabled, onChange: (e) => props.onChange(e.target.value === "" ? undefined : Number(e.target.value)) });
    }

    function HttpsFixCard(props) {
      const { controller } = props;
      const snap = React.useSyncExternalStore(
        React.useCallback((cb) => controller.subscribe(cb), [controller]),
        () => controller.getSnapshot()
      );
      const value = snap.value || {};
      const writable = snap.writable === true;
      const unavailable = snap.status === "unavailable";
      const [open, setOpen] = React.useState(false);
      const [staged, setStaged] = React.useState(null);
      const [log, setLog] = React.useState([]);
      const [busy, setBusy] = React.useState(false);
      const [saving, setSaving] = React.useState(false);

      const cur = (k) => (staged && Object.prototype.hasOwnProperty.call(staged, k) ? staged[k] : value[k]);
      const set = (k, v) => setStaged((s) => Object.assign({}, s, { [k]: v }));
      const dirty = staged !== null && Object.keys(staged).length > 0;

      async function validate() {
        setLog([]);
        setBusy(true);
        try {
          const rpcId = "v" + Math.random().toString(36).slice(2);
          const res = await fetch("/https-fix/validate", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "client-request", method: "validate", rpcId, payload: {} })
          });
          const data = await res.json();
          if (data && data.result && Array.isArray(data.result.log)) {
            setLog(data.result.log);
            return data.result;
          }
          setLog([{ ok: false, msg: "校验请求失败: " + (data?.result?.error?.message ?? res.status) }]);
          return { ok: false, log: [] };
        } catch (e) {
          setLog([{ ok: false, msg: "校验请求失败: " + (e?.message ?? String(e)) }]);
          return { ok: false, log: [] };
        } finally {
          setBusy(false);
        }
      }

      async function save() {
        if (!staged || Object.keys(staged).length === 0) return;
        // 启用https 的门:从 false 切 true 前先完整校验,全部通过才允许写入
        if (staged.enableHttps === true && value.enableHttps !== true) {
          const result = await validate();
          if (result.ok !== true) return;
        }
        setSaving(true);
        try {
          for (const k of Object.keys(staged)) {
            await controller.set(k, staged[k]);
          }
          setStaged(null);
          setLog([]);
        } catch (e) {
          setLog([{ ok: false, msg: "保存失败: " + (e?.message ?? String(e)) }]);
        } finally {
          setSaving(false);
        }
      }

      const [patchMsg, setPatchMsg] = React.useState([]);
      const [patchState, setPatchState] = React.useState(null); // null | { patched }

      async function rpc(endpoint) {
        const rpcId = "r" + Math.random().toString(36).slice(2);
        const res = await fetch("/https-fix/" + endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "client-request", method: endpoint, rpcId, payload: {} })
        });
        return res.json();
      }

      React.useEffect(() => {
        rpc("patch-status").then((d) => {
          if (d?.result?.ok) setPatchState(d.result);
        }).catch(() => {});
      }, []);

      async function applyPatch() {
        setPatchMsg([]);
        setBusy(true);
        try {
          const d = await rpc("patch-loopback");
          setPatchMsg(d?.result?.log ?? [{ ok: false, msg: d?.result?.error?.message ?? "打补丁失败" }]);
          if (d?.result?.ok) setPatchState(d.result);
        } catch (e) { setPatchMsg([{ ok: false, msg: "请求失败: " + (e?.message ?? String(e)) }]); }
        finally { setBusy(false); }
      }

      async function revertPatch() {
        setPatchMsg([]);
        setBusy(true);
        try {
          const d = await rpc("revert-loopback");
          setPatchMsg(d?.result?.log ?? [{ ok: false, msg: d?.result?.error?.message ?? "还原失败" }]);
          if (d?.result?.ok) setPatchState(d.result);
        } catch (e) { setPatchMsg([{ ok: false, msg: "请求失败: " + (e?.message ?? String(e)) }]); }
        finally { setBusy(false); }
      }

      function onToggleVersionCheck(checked) {
        if (checked) { set("versionCheck", true); return; }
        // 关闭「核对版本号」需三重确认
        if (!window.confirm("关闭「核对版本号」将跳过 dsh 版本一致性检查,HTTPS 可能在不适配的 dsh 版本上运行。\n第 1/3 次确认?")) return;
        if (!window.confirm("再次确认关闭「核对版本号」? 第 2/3 次")) return;
        if (!window.confirm("最后一次确认关闭「核对版本号」? 第 3/3 次")) return;
        set("versionCheck", false);
      }

      return jsxs("li", { className: cx(css.card, open && css.cardOpen), children: [
        jsxs("button", { type: "button", className: css.header, "aria-expanded": open, onClick: () => setOpen(!open), children: [
          jsxs("span", { className: css.headText, children: [
            jsx("span", { className: css.name, children: "Https Fix" }),
            jsx("span", { className: css.description, children: "内置 HTTPS 反向代理;http 端口与外网访问改动重启后生效" })
          ] }),
          dirty ? jsx("span", { className: css.pending, children: "未保存" }) : null,
          jsx(Chevron, { open })
        ] }),
        open ? jsxs("div", { className: css.body, children: [
          !writable || unavailable ? jsx("p", { className: css.readOnly, role: "status", children: unavailable ? "设置不可用(需经回环地址或受信域名访问)" : "只读" }) : null,

          jsx(Field, { label: "关闭 http 外网访问", hint: "开启后 http 仅监听 127.0.0.1(写入机器级补丁,重启 dsh 生效)", children: [
            jsx(BoolField, { label: "启用", value: cur("blockHttpExternalAccess"), disabled: !writable, onChange: (v) => set("blockHttpExternalAccess", v) })
          ] }),
          jsx(Field, { label: "http 端口", hint: "dsh 核心 HTTP 端口;保存后重启 dsh 生效", children: [
            jsx(NumberField, { value: cur("httpPort"), placeholder: String(snap.base?.httpPort ?? ""), disabled: !writable, onChange: (v) => set("httpPort", v) })
          ] }),
          jsx(Field, { label: "启用 https", hint: "开启前自动校验(端口/证书/域名),通过后自动启动 HTTPS 服务", children: [
            jsx(BoolField, { label: "启用", value: cur("enableHttps"), disabled: !writable, onChange: (v) => set("enableHttps", v) })
          ] }),
          jsx(Field, { label: "https 端口", hint: "HTTPS 独立监听端口", children: [
            jsx(NumberField, { value: cur("httpsPort"), placeholder: "3081", disabled: !writable, onChange: (v) => set("httpsPort", v) })
          ] }),
          jsx(Field, { label: "域名", hint: "启用 https 时必填,用于 Host 透传与证书域名校验", children: [
            jsx(TextField, { value: cur("domain"), placeholder: "example.com", disabled: !writable, onChange: (v) => set("domain", v) })
          ] }),
          jsx(Field, { label: "监听地址", hint: "多网卡时指定一个 IP;留空 = 0.0.0.0(所有网卡)", children: [
            jsx(TextField, { value: cur("address"), placeholder: "0.0.0.0", disabled: !writable, onChange: (v) => set("address", v) })
          ] }),
          jsx(Field, { label: "TLS 证书(cert)路径", hint: "启用 https 时必填,PEM 格式", children: [
            jsx(TextField, { value: cur("certPath"), placeholder: "/path/to/fullchain.pem", disabled: !writable, onChange: (v) => set("certPath", v) })
          ] }),
          jsx(Field, { label: "TLS 密钥(key)路径", hint: "启用 https 时必填,与证书配对", children: [
            jsx(TextField, { value: cur("keyPath"), placeholder: "/path/to/privkey.pem", disabled: !writable, onChange: (v) => set("keyPath", v) })
          ] }),

          jsx(Field, { label: "核对版本号", hint: "默认开启。开启时校验 dsh 版本与插件目标版本一致;不一致则 HTTPS 校验无法通过、无法开启 HTTPS。关闭需三次确认", children: [
            jsx(BoolField, { label: "启用", value: cur("versionCheck"), disabled: !writable, onChange: onToggleVersionCheck })
          ] }),

          jsx(Field, { label: "客户端热补丁", hint: "一键给 dsh-client-connection 打 connection.isLoopback 豁免,让域名访问时的设置页可用(经本插件 HTTPS 可达时可用)", children: [
            jsxs("div", { style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }, children: [
              jsx("button", { type: "button", className: css.btn, disabled: busy, onClick: () => applyPatch(), children: "一键打热补丁" }),
              jsx("button", { type: "button", className: css.btn, disabled: busy, onClick: () => revertPatch(), children: "还原补丁" }),
              jsx("span", { className: css.hint, children: patchState ? (patchState.patched ? "已打补丁" : "未打补丁") : "" })
            ] }),
            patchMsg.length > 0 ? jsx("div", { className: css.log, children: patchMsg.map((l, i) => jsx("span", { key: i, className: l.ok ? css.logOk : css.logErr, children: (l.ok ? "✓ " : "✗ ") + l.msg })) }) : null
          ] }),

          log.length > 0 ? jsx("div", { className: css.log, children: log.map((l, i) => jsx("span", { key: i, className: l.ok ? css.logOk : css.logErr, children: (l.ok ? "✓ " : "✗ ") + l.msg })) }) : null,

          jsxs("div", { className: css.footer, children: [
            jsx("button", { type: "button", className: css.btn, disabled: busy || !writable, onClick: () => validate(), children: "校验 HTTPS 可用性" }),
            jsx("button", { type: "button", className: css.btnPrimary, disabled: saving || busy || !writable || !dirty, onClick: () => save(), children: saving ? "保存中…" : "保存配置" })
          ] })
        ] }) : null
      ] });
    }

    function apply(ctx) {
      const controller = ctx.settingsScope.bind({ namespace: NS });
      ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
        name: "settings.plugin.item",
        key: NS,
        inject: () => ({ controller })
      }, HttpsFixCard));
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
