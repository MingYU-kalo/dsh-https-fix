/**
 * dsh-https-fix 浏览器端 bundle(单文件,经 __ModuleLoader__ 加载)。
 *
 * 向 `settings.plugin.item` 槽位注册卡片(key = settings 命名空间 `https-fix`),
 * 渲染「设置 → 插件配置 → Https Fix」:关闭 http 外网访问、http/https 端口、
 * 域名、监听地址、TLS 证书/密钥路径,以及「校验 HTTPS 可用性」与「保存配置」按钮。
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

    const style = {
      card: { display: "flex", flexDirection: "column", gap: "12px", maxWidth: "760px" },
      title: { margin: 0, fontSize: "18px", fontWeight: 600 },
      desc: { color: "var(--dsw-alias-label-tertiary, #888)", margin: 0, fontSize: "13px" },
      field: { display: "flex", flexDirection: "column", gap: "4px" },
      label: { fontSize: "13px", fontWeight: 500 },
      hint: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #888)" },
      input: { width: "100%", maxWidth: "340px", padding: "6px 8px", fontSize: "13px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2, #ccc)", background: "transparent", color: "inherit" },
      row: { display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "flex-end" },
      btn: { padding: "6px 14px", fontSize: "13px", borderRadius: "6px", cursor: "pointer", border: "1px solid var(--dsw-alias-border-l2, #ccc)", background: "transparent", color: "inherit" },
      btnPrimary: { padding: "6px 14px", fontSize: "13px", borderRadius: "6px", cursor: "pointer", border: "1px solid transparent", background: "var(--dsw-alias-state-business-primary, #3b82f6)", color: "#fff" },
      log: { display: "flex", flexDirection: "column", gap: "2px", fontSize: "12px", fontFamily: "ui-monospace, monospace" },
      logOk: { color: "var(--dsw-alias-state-success, #16a34a)" },
      logErr: { color: "var(--dsw-alias-state-error, #dc2626)" },
      check: { display: "flex", alignItems: "center", gap: "8px", fontSize: "13px" }
    };

    function Field(props) {
      return jsx("div", { style: style.field, children: [
        jsx("label", { style: style.label, children: props.label }),
        props.hint ? jsx("span", { style: style.hint, children: props.hint }) : null,
        props.children
      ] });
    }

    function BoolField(props) {
      return jsx("label", { style: style.check, children: [
        jsx("input", { type: "checkbox", checked: !!props.value, disabled: props.disabled, onChange: (e) => props.onChange(e.target.checked) }),
        jsx("span", { children: props.label })
      ] });
    }

    function TextField(props) {
      return jsx("input", { style: style.input, type: "text", value: props.value ?? "", placeholder: props.placeholder, disabled: props.disabled, onChange: (e) => props.onChange(e.target.value) });
    }

    function NumberField(props) {
      return jsx("input", { style: style.input, type: "number", min: 1, max: 65535, value: props.value ?? "", placeholder: props.placeholder, disabled: props.disabled, onChange: (e) => props.onChange(e.target.value === "" ? undefined : Number(e.target.value)) });
    }

    function HttpsFixCard(props) {
      const { controller } = props;
      const snap = React.useSyncExternalStore(
        React.useCallback((cb) => controller.subscribe(cb), [controller]),
        () => controller.getSnapshot()
      );
      const value = snap.value || {};
      const writable = snap.writable === true;
      const [staged, setStaged] = React.useState(null);
      const [log, setLog] = React.useState([]);
      const [busy, setBusy] = React.useState(false);

      const cur = (k) => (staged && Object.prototype.hasOwnProperty.call(staged, k) ? staged[k] : value[k]);
      const set = (k, v) => setStaged((s) => Object.assign({}, s, { [k]: v }));

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
        setBusy(true);
        try {
          for (const k of Object.keys(staged)) {
            await controller.set(k, staged[k]);
          }
          setStaged(null);
        } catch (e) {
          setLog([{ ok: false, msg: "保存失败: " + (e?.message ?? String(e)) }]);
        } finally {
          setBusy(false);
        }
      }

      const httpsOn = cur("enableHttps") === true;

      return jsxs("section", { style: style.card, children: [
        jsx("h3", { style: style.title, children: "Https Fix" }),
        jsx("p", { style: style.desc, children: "为 dsh Web GUI 提供内置 HTTPS 反向代理。http 端口与外网访问改动会写入机器级补丁层,重启 dsh 后生效。" }),

        jsx(Field, { label: "HTTP", hint: "dsh 核心 HTTP 监听(重启生效)", children: [
          jsx(BoolField, { label: "关闭 http 外网访问", value: cur("blockHttpExternalAccess"), disabled: !writable, onChange: (v) => set("blockHttpExternalAccess", v) }),
          jsx(NumberField, { value: cur("httpPort"), placeholder: "当前 http 端口", disabled: !writable, onChange: (v) => set("httpPort", v) })
        ] }),

        jsx(Field, { label: "HTTPS", children: [
          jsx(BoolField, { label: "启用 https(开启前自动校验,通过后自动启动服务)", value: cur("enableHttps"), disabled: !writable, onChange: (v) => set("enableHttps", v) })
        ] }),

        jsx(Field, { label: "端口", hint: httpsOn ? "https 端口与监听地址" : "启用 https 后可配置", children: [
          jsx(BoolField, { label: "https 端口使用 http 端口", value: cur("httpsSamePort"), disabled: !writable, onChange: (v) => set("httpsSamePort", v) }),
          jsx(NumberField, { value: cur("httpsPort"), disabled: !writable || cur("httpsSamePort") === true, onChange: (v) => set("httpsPort", v) })
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

        jsx("div", { style: style.row, children: [
          jsx("button", { style: style.btn, disabled: busy || !writable, onClick: () => validate(), children: "校验 HTTPS 可用性" }),
          jsx("button", { style: style.btnPrimary, disabled: busy || !writable || !staged || Object.keys(staged).length === 0, onClick: () => save(), children: "保存配置" })
        ] }),

        log.length > 0 ? jsx("div", { style: style.log, children: log.map((l, i) => jsx("span", { key: i, style: l.ok ? style.logOk : style.logErr, children: (l.ok ? "✓ " : "✗ ") + l.msg })) }) : null
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
