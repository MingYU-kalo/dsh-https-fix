/**
 * dsh-https-fix 浏览器端 bundle(单文件,经 __ModuleLoader__ 加载)。
 *
 * 向 settings.plugin.item 槽位注册折叠卡片(key = settings 命名空间 https-fix)。
 * 头部一直显示运行状态;展开后按「HTTPS 服务 / TLS 证书 / 访问与安全 / 诊断」四组排布,
 * 证书来源改为显式二选一(自动自签 / 自定义路径),每项支持「恢复默认」。
 *
 * 数据通道与旧版一致:读走 settingsScope 快照,写走 controller.set/unset,
 * 校验与热补丁走自有 RPC(POST /api/https-fix/*)。
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

    // ── 卡片样式(复用设置页 --dsw-* 主题令牌,与其它插件卡片一致) ──
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
      ".hf_body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:10px;display:flex;flex-direction:column;gap:0}",
      ".hf_pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}",
      ".hf_readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}",
      ".hf_section{border-top:1px solid var(--dsw-alias-border-l2);padding:12px 0;display:flex;flex-direction:column;gap:10px}",
      ".hf_sectionFirst{border-top:0;padding-top:12px}",
      ".hf_sectionTitle{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px;font-weight:600;letter-spacing:.05em}",
      ".hf_sectionHint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}",
      ".hf_field{display:flex;flex-direction:column;gap:4px}",
      ".hf_fieldHead{align-items:baseline;gap:8px;display:flex}",
      ".hf_label{font-size:13px;font-weight:500}",
      ".hf_hint{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.5}",
      ".hf_input{width:100%;max-width:340px;padding:6px 8px;font-size:13px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:inherit}",
      ".hf_inputMono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}",
      ".hf_check{display:flex;align-items:center;gap:8px;font-size:13px}",
      ".hf_row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
      ".hf_choices{display:flex;flex-direction:column;gap:8px}",
      ".hf_choiceRow{display:flex;align-items:flex-start;gap:8px;cursor:pointer;font-size:13px;line-height:1.5}",
      ".hf_choiceRow input{margin-top:2px}",
      ".hf_choiceText{display:flex;flex-direction:column;gap:2px}",
      ".hf_choiceDesc{color:var(--dsw-alias-label-tertiary);font-size:12px}",
      ".hf_note{background:var(--dsw-alias-bg-module-platform);border-radius:8px;padding:8px 10px;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6;display:flex;flex-direction:column;gap:4px}",
      ".hf_code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;word-break:break-all}",
      ".hf_warn{color:var(--dsw-alias-label-warning,#b45309);margin:0;font-size:12px;line-height:1.5}",
      ".hf_badge{white-space:nowrap;border-radius:999px;flex:none;padding:2px 10px;font-size:11px;font-weight:600;line-height:17px}",
      ".hf_badgeOk{background:rgba(22,163,74,.12);color:var(--dsw-alias-label-success,#16a34a)}",
      ".hf_badgeOff{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-tertiary)}",
      ".hf_inlineBtn{appearance:none;background:0 0;border:0;cursor:pointer;color:var(--dsw-alias-brand-primary,#3b82f6);padding:0;font:inherit;font-size:12px;text-decoration:underline}",
      ".hf_inlineBtn:disabled{cursor:not-allowed;opacity:.5;text-decoration:none}",
      ".hf_url{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-all}",
      ".hf_log{display:flex;flex-direction:column;gap:2px;font-size:12px;font-family:ui-monospace,monospace}",
      ".hf_logOk{color:var(--dsw-alias-label-success,#16a34a)}",
      ".hf_logErr{color:var(--dsw-alias-label-error,#dc2626)}",
      ".hf_summary{font-size:12px;font-weight:600}",
      ".hf_footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}",
      ".hf_footerNote{color:var(--dsw-alias-label-tertiary);margin-right:auto;font-size:12px}",
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
      body: "hf_body", pending: "hf_pending", readOnly: "hf_readOnly",
      section: "hf_section", sectionFirst: "hf_sectionFirst", sectionTitle: "hf_sectionTitle", sectionHint: "hf_sectionHint",
      field: "hf_field", fieldHead: "hf_fieldHead", label: "hf_label", hint: "hf_hint",
      input: "hf_input", inputMono: "hf_inputMono", check: "hf_check", row: "hf_row",
      choices: "hf_choices", choiceRow: "hf_choiceRow", choiceText: "hf_choiceText", choiceDesc: "hf_choiceDesc",
      note: "hf_note", code: "hf_code", warn: "hf_warn",
      badge: "hf_badge", badgeOk: "hf_badgeOk", badgeOff: "hf_badgeOff", inlineBtn: "hf_inlineBtn", url: "hf_url",
      log: "hf_log", logOk: "hf_logOk", logErr: "hf_logErr", summary: "hf_summary",
      footer: "hf_footer", footerNote: "hf_footerNote", btn: "hf_btn", btnPrimary: "hf_btnPrimary"
    };

    function cx() {
      return Array.prototype.filter.call(arguments, Boolean).join(" ");
    }

    // ── 视图原语 ──────────────────────────────────────────────────────────

    function Chevron(props) {
      return jsx("svg", {
        width: 14, height: 14, viewBox: "0 0 14 14", fill: "none", "aria-hidden": true,
        className: cx(css.chevron, props.open && css.chevronOpen),
        children: jsx("path", { d: "M3 5l4 4 4-4", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" })
      });
    }

    function Section(props) {
      return jsxs("section", { className: cx(css.section, props.first && css.sectionFirst), children: [
        jsx("h4", { className: css.sectionTitle, children: props.title }),
        props.hint ? jsx("p", { className: css.sectionHint, children: props.hint }) : null,
        props.children
      ] });
    }

    /** 一行配置:标签 + 可选「恢复默认」+ 说明 + 控件。 */
    function Field(props) {
      return jsxs("div", { className: css.field, children: [
        jsxs("div", { className: css.fieldHead, children: [
          jsx("label", { className: css.label, htmlFor: props.id, children: props.label }),
          props.reset ? jsx("button", {
            type: "button", className: css.inlineBtn, disabled: props.resetDisabled,
            title: "清除这一项的用户设置,回到组成配置/默认值",
            onClick: props.onReset, children: "恢复默认"
          }) : null
        ] }),
        props.hint ? jsx("span", { className: css.hint, children: props.hint }) : null,
        props.children
      ] });
    }

    function Checkbox(props) {
      return jsxs("label", { className: css.check, children: [
        jsx("input", {
          id: props.id, type: "checkbox", checked: !!props.value, disabled: props.disabled,
          onChange: (e) => props.onChange(e.target.checked)
        }),
        jsx("span", { children: props.label })
      ] });
    }

    function TextInput(props) {
      return jsx("input", {
        id: props.id, className: cx(css.input, props.mono && css.inputMono), type: "text",
        value: props.value ?? "", placeholder: props.placeholder, disabled: props.disabled, spellCheck: false,
        onChange: (e) => props.onChange(e.target.value)
      });
    }

    function NumberInput(props) {
      return jsx("input", {
        id: props.id, className: css.input, type: "number", min: 1, max: 65535,
        value: props.value ?? "", placeholder: props.placeholder, disabled: props.disabled,
        onChange: (e) => props.onChange(e.target.value === "" ? undefined : Number(e.target.value))
      });
    }

    function Choice(props) {
      return jsx("label", { className: css.choiceRow, children: [
        jsx("input", {
          type: "radio", name: props.name, checked: props.checked, disabled: props.disabled,
          onChange: () => props.onSelect(props.value)
        }),
        jsxs("span", { className: css.choiceText, children: [
          jsx("span", { children: props.label }),
          props.description ? jsx("span", { className: css.choiceDesc, children: props.description }) : null
        ] })
      ] });
    }

    // ── 卡片主体 ──────────────────────────────────────────────────────────

    function HttpsFixCard(props) {
      const { controller } = props;
      const snap = React.useSyncExternalStore(
        React.useCallback((cb) => controller.subscribe(cb), [controller]),
        () => controller.getSnapshot()
      );
      const value = snap.value || {};
      const user = snap.user || {};
      const writable = snap.writable === true;
      const unavailable = snap.status === "unavailable";

      const [open, setOpen] = React.useState(false);
      const [staged, setStaged] = React.useState(null);
      const [log, setLog] = React.useState([]);
      const [busy, setBusy] = React.useState(false);
      const [saving, setSaving] = React.useState(false);
      const [status, setStatus] = React.useState(null);
      const [patchMsg, setPatchMsg] = React.useState([]);
      const [patchState, setPatchState] = React.useState(null);
      const [modeChoice, setModeChoice] = React.useState(null);

      const uid = String(React.useId()).replace(/:/g, "");
      const fid = (k) => "hf" + uid + "-" + k;

      const cur = (k) => (staged && Object.prototype.hasOwnProperty.call(staged, k) ? staged[k] : value[k]);
      const set = (k, v) => setStaged((s) => Object.assign({}, s, { [k]: v }));
      const dirtyKeys = staged ? Object.keys(staged) : [];
      const dirty = dirtyKeys.length > 0;
      const isUserSet = (k) => Object.prototype.hasOwnProperty.call(user, k);
      const canReset = typeof controller.unset === "function";

      /** 把 RPC 返回的 log 统一成 {ok, msg}:热补丁端点返回的是字符串数组,不是 {ok,msg} 对象。 */
      function asLogLines(result, fallbackMsg) {
        const okFlag = !!(result && result.ok);
        const raw = result && Array.isArray(result.log) ? result.log : [];
        if (raw.length === 0) return [{ ok: okFlag, msg: okFlag ? "完成" : fallbackMsg }];
        return raw.map((l) => ({
          ok: okFlag,
          msg: typeof l === "string" ? l : String((l && l.msg) || l)
        }));
      }

      async function rpc(endpoint) {
        const rpcId = "r" + Math.random().toString(36).slice(2);
        const res = await fetch("/api/https-fix/" + endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "client-request", method: endpoint, rpcId, payload: {} })
        });
        return res.json();
      }

      const refreshStatus = React.useCallback(() => {
        rpc("status").then((d) => {
          if (d && d.result && d.result.ok) setStatus(d.result.value);
        }).catch(() => {});
      }, []);

      React.useEffect(() => { refreshStatus(); }, [refreshStatus]);
      React.useEffect(() => {
        rpc("patch-status").then((d) => {
          if (d && d.result && d.result.ok) setPatchState(d.result);
        }).catch(() => {});
      }, []);

      async function validate() {
        setLog([]);
        setBusy(true);
        try {
          const data = await rpc("validate");
          if (data && data.result && Array.isArray(data.result.log)) {
            setLog(data.result.log);
            refreshStatus();
            return data.result;
          }
          const msg = data && data.result && data.result.error ? data.result.error.message : "响应格式异常";
          setLog([{ ok: false, msg: "校验请求失败: " + msg }]);
          return { ok: false, log: [] };
        } catch (e) {
          setLog([{ ok: false, msg: "校验请求失败: " + (e && e.message ? e.message : String(e)) }]);
          return { ok: false, log: [] };
        } finally {
          setBusy(false);
        }
      }

      async function save() {
        if (!staged || Object.keys(staged).length === 0) return;
        // 启用 https 的门:从 false 切 true 前先完整校验,全部通过才允许写入
        if (staged.enableHttps === true && value.enableHttps !== true) {
          const result = await validate();
          if (result.ok !== true) return;
        }
        setSaving(true);
        try {
          for (const k of Object.keys(staged)) await controller.set(k, staged[k]);
          setStaged(null);
          setModeChoice(null);
          setLog([]);
          refreshStatus();
        } catch (e) {
          setLog([{ ok: false, msg: "保存失败: " + (e && e.message ? e.message : String(e)) }]);
        } finally {
          setSaving(false);
        }
      }

      function discard() {
        setStaged(null);
        setModeChoice(null);
      }

      async function resetField(key) {
        if (typeof controller.unset !== "function") return;
        try {
          await controller.unset(key);
          setStaged((s) => {
            if (!s) return s;
            const next = Object.assign({}, s);
            delete next[key];
            return next;
          });
          refreshStatus();
        } catch (e) {
          setLog([{ ok: false, msg: "恢复默认失败: " + (e && e.message ? e.message : String(e)) }]);
        }
      }

      async function applyPatch() {
        setPatchMsg([]);
        setBusy(true);
        try {
          const d = await rpc("patch-loopback");
          setPatchMsg(asLogLines(d && d.result, (d && d.result && d.result.error && d.result.error.message) || "打补丁失败"));
          if (d && d.result && d.result.ok) setPatchState(d.result);
        } catch (e) {
          setPatchMsg([{ ok: false, msg: "请求失败: " + (e && e.message ? e.message : String(e)) }]);
        } finally {
          setBusy(false);
        }
      }

      async function revertPatch() {
        setPatchMsg([]);
        setBusy(true);
        try {
          const d = await rpc("revert-loopback");
          setPatchMsg(asLogLines(d && d.result, (d && d.result && d.result.error && d.result.error.message) || "还原失败"));
          if (d && d.result && d.result.ok) setPatchState(d.result);
        } catch (e) {
          setPatchMsg([{ ok: false, msg: "请求失败: " + (e && e.message ? e.message : String(e)) }]);
        } finally {
          setBusy(false);
        }
      }

      function onToggleVersionCheck(checked) {
        if (checked) { set("versionCheck", true); return; }
        // 关闭「核对版本号」需三重确认
        if (!window.confirm("关闭「核对版本号」将跳过 dsh 版本一致性检查,HTTPS 可能在不适配的 dsh 版本上运行。\n第 1/3 次确认?")) return;
        if (!window.confirm("再次确认关闭「核对版本号」? 第 2/3 次")) return;
        if (!window.confirm("最后一次确认关闭「核对版本号」? 第 3/3 次")) return;
        set("versionCheck", false);
      }

      /** 一键把当前浏览器地址栏的 host 填进「域名 / IP」,无域名场景最常用。 */
      function fillCurrentHost() {
        try {
          const host = window.location && window.location.hostname;
          if (host) set("domain", host);
        } catch { /* 忽略:拿不到地址栏 */ }
      }

      // 证书来源:显式选择优先,否则按当前值推断(两个都填 = 路径,两个都空 = 自动)
      const modeFromValue = (() => {
        const cert = String(cur("certPath") ?? "").trim();
        const key = String(cur("keyPath") ?? "").trim();
        if (cert !== "" && key !== "") return "paths";
        if (cert === "" && key === "") return "auto";
        return "invalid";
      })();
      const mode = modeChoice ?? modeFromValue;
      const pairingBroken = modeFromValue === "invalid";
      function chooseMode(next) {
        setModeChoice(next);
        if (next === "auto") { set("certPath", ""); set("keyPath", ""); }
      }

      const badge = (() => {
        if (unavailable) return { tone: "off", text: "设置不可用" };
        if (!status) return null;
        if (!status.running) return { tone: "off", text: status.enableHttps ? "HTTPS 未运行" : "HTTPS 未启用" };
        const source = status.certSource === "auto-self-signed" ? "自签" : "自有证书";
        return { tone: "ok", text: "运行中 " + (status.domain || "?") + ":" + status.httpsPort + " · " + source };
      })();

      const failed = log.filter((l) => l.ok === false).length;
      const accessUrl = "https://" + (String(cur("domain") ?? "").trim() || "<域名或 IP>") + ":" + (cur("httpsPort") ?? 3081) + "/";

      return jsxs("li", { className: cx(css.card, open && css.cardOpen), children: [
        jsxs("button", { type: "button", className: css.header, "aria-expanded": open, onClick: () => setOpen(!open), children: [
          jsxs("span", { className: css.headText, children: [
            jsx("span", { className: css.name, children: "Https Fix" }),
            jsx("span", { className: css.description, children: "内置 HTTPS 反向代理与证书管理" })
          ] }),
          badge ? jsx("span", { className: cx(css.badge, badge.tone === "ok" ? css.badgeOk : css.badgeOff), children: badge.text }) : null,
          dirty ? jsx("span", { className: css.pending, children: "未保存" }) : null,
          jsx(Chevron, { open })
        ] }),
        open ? jsxs("div", { className: css.body, children: [

          !writable || unavailable ? jsx("p", { className: css.readOnly, role: "status", children: unavailable ? "设置不可用(需经回环地址或受信域名访问)" : "只读:当前会话没有写入权限" }) : null,

          jsxs(Section, { first: true, title: "HTTPS 服务", hint: "插件按下面的地址与端口启动内置 HTTPS 反代,转发到 dsh 本机 http 端口", children: [
            jsxs(Field, { id: fid("enable"), label: "启用 HTTPS", children: [
              jsx(Checkbox, {
                id: fid("enable"), value: cur("enableHttps"), disabled: !writable,
                label: cur("enableHttps") ? "已启用" : "未启用", onChange: (v) => set("enableHttps", v)
              })
            ] }),
            jsxs(Field, {
              id: fid("domain"), label: "域名 / IP", hint: "浏览器访问用的地址;没有域名就直接填公网 IP",
              reset: canReset && isUserSet("domain"), onReset: () => resetField("domain"), resetDisabled: !writable,
              children: jsxs("div", { className: css.row, children: [
                jsx(TextInput, { id: fid("domain"), value: cur("domain"), placeholder: "example.com 或 203.0.113.7", disabled: !writable, onChange: (v) => set("domain", v) }),
                jsx("button", { type: "button", className: css.inlineBtn, disabled: !writable, onClick: fillCurrentHost, children: "填入当前地址" })
              ] })
            }),
            jsxs(Field, { id: fid("httpsPort"), label: "HTTPS 端口", children: [
              jsx(NumberInput, { id: fid("httpsPort"), value: cur("httpsPort"), placeholder: "3081", disabled: !writable, onChange: (v) => set("httpsPort", v) })
            ] }),
            jsxs(Field, { id: fid("address"), label: "监听地址", hint: "留空 = 0.0.0.0(所有网卡)", children: [
              jsx(TextInput, { id: fid("address"), value: cur("address"), placeholder: "0.0.0.0", disabled: !writable, onChange: (v) => set("address", v) })
            ] }),
            jsx("div", { className: css.url, children: "访问入口 " + accessUrl })
          ] }),

          jsxs(Section, { title: "TLS 证书", hint: "没有域名时用自动自签;也可以填自有证书路径", children: [
            jsxs("div", { className: css.choices, children: [
              jsx(Choice, {
                name: fid("certMode"), value: "auto", checked: mode === "auto", disabled: !writable, onSelect: chooseMode,
                label: "自动自签证书", description: "插件生成并复用自签证书,适合没有域名、用 IP 访问;浏览器首次访问需手动信任一次"
              }),
              jsx(Choice, {
                name: fid("certMode"), value: "paths", checked: mode === "paths", disabled: !writable, onSelect: chooseMode,
                label: "使用我自己的证书路径", description: "PEM 格式的 cert + key,例如 Let's Encrypt(含 IP 证书)或企业证书"
              })
            ] }),
            pairingBroken ? jsx("p", { className: css.warn, children: "cert 与 key 路径需要成对填写;两个都清空则改用自动自签证书。" }) : null,
            mode === "auto" ? jsxs("div", { className: css.note, children: [
              jsx("span", { children: "证书位置 " + ((status && status.certSource === "auto-self-signed" && status.certPath) || "$DSH_HOME/https-fix/self-signed.crt") + ";改域名/IP 后最迟 60 秒自动重签。" }),
              jsx("span", { children: "想彻底消除浏览器警告:把该证书导入设备信任库,或改用自有证书路径。" })
            ] }) : null,
            mode === "paths" ? jsxs(React.Fragment, { children: [
              jsxs(Field, {
                id: fid("certPath"), label: "cert 路径",
                reset: canReset && isUserSet("certPath"), onReset: () => resetField("certPath"), resetDisabled: !writable,
                children: jsx(TextInput, { id: fid("certPath"), mono: true, value: cur("certPath"), placeholder: "/path/to/fullchain.pem", disabled: !writable, onChange: (v) => set("certPath", v) })
              }),
              jsxs(Field, {
                id: fid("keyPath"), label: "key 路径",
                reset: canReset && isUserSet("keyPath"), onReset: () => resetField("keyPath"), resetDisabled: !writable,
                children: jsx(TextInput, { id: fid("keyPath"), mono: true, value: cur("keyPath"), placeholder: "/path/to/privkey.pem", disabled: !writable, onChange: (v) => set("keyPath", v) })
              })
            ] }) : null
          ] }),

          jsxs(Section, { title: "访问与安全", children: [
            jsxs(Field, { id: fid("autoToken"), label: "自动模式(网页 token)", hint: "开启后浏览器直接访问 https://域名:端口 就能用;关闭则需自行使用 dsh 启动时打印的带 token URL", children: [
              jsx(Checkbox, {
                id: fid("autoToken"), value: cur("autoToken"), disabled: !writable,
                label: cur("autoToken") ? "已启用" : "未启用", onChange: (v) => set("autoToken", v)
              })
            ] }),
            jsxs(Field, { id: fid("blockHttp"), label: "关闭 http 外网访问", hint: "开启后 dsh 的 http 只监听 127.0.0.1(写机器级补丁,重启 dsh 生效)", children: [
              jsx(Checkbox, {
                id: fid("blockHttp"), value: cur("blockHttpExternalAccess"), disabled: !writable,
                label: cur("blockHttpExternalAccess") ? "已关闭外网访问" : "保持外网可访问", onChange: (v) => set("blockHttpExternalAccess", v)
              })
            ] }),
            jsxs(Field, { id: fid("httpPort"), label: "http 端口", hint: "dsh 核心 HTTP 端口;保存后重启 dsh 生效", children: [
              jsx(NumberInput, {
                id: fid("httpPort"), value: cur("httpPort"), placeholder: String((snap.base && snap.base.httpPort) ?? ""),
                disabled: !writable, onChange: (v) => set("httpPort", v)
              })
            ] }),
            jsxs(Field, { id: fid("versionCheck"), label: "核对版本号", hint: "默认开启;不一致时校验不通过、HTTPS 不启动。关闭需三次确认", children: [
              jsx(Checkbox, {
                id: fid("versionCheck"), value: cur("versionCheck"), disabled: !writable,
                label: cur("versionCheck") ? "已开启" : "已关闭(不推荐)", onChange: onToggleVersionCheck
              })
            ] })
          ] }),

          jsxs(Section, { title: "诊断", children: [
            jsxs("div", { className: css.row, children: [
              jsx("button", { type: "button", className: css.btn, disabled: busy || !writable, onClick: () => validate(), children: busy ? "处理中…" : "校验 HTTPS 可用性" }),
              jsx("button", { type: "button", className: css.btn, disabled: busy || !writable, onClick: () => applyPatch(), children: "一键打热补丁" }),
              jsx("button", { type: "button", className: css.btn, disabled: busy || !writable, onClick: () => revertPatch(), children: "还原补丁" }),
              jsx("span", { className: css.hint, children: patchState ? (patchState.patched ? "热补丁:已应用" : "热补丁:未应用") : "" })
            ] }),
            patchMsg.length > 0 ? jsx("div", { className: css.log, children: patchMsg.map((l, i) => jsx("span", { key: i, className: l.ok ? css.logOk : css.logErr, children: (l.ok ? "✓ " : "✗ ") + l.msg })) }) : null,
            log.length > 0 ? jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "6px" }, children: [
              jsx("div", { className: cx(css.summary, failed === 0 ? css.logOk : css.logErr), children: failed === 0 ? "校验通过(" + log.length + " 项)" : "校验未通过:" + failed + "/" + log.length + " 项需要处理" }),
              jsx("div", { className: css.log, children: log.map((l, i) => jsx("span", { key: i, className: l.ok ? css.logOk : css.logErr, children: (l.ok ? "✓ " : "✗ ") + l.msg })) })
            ] }) : null
          ] }),

          jsxs("div", { className: css.footer, children: [
            dirty ? jsx("span", { className: css.footerNote, children: "有 " + dirtyKeys.length + " 项改动未保存" }) : null,
            jsx("button", { type: "button", className: css.btn, disabled: saving || busy || !dirty, onClick: discard, children: "放弃修改" }),
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
