// dsh-folder-permissions — Client half (browser bundle).
//
// Registers a "Permissions" tab in the conversation view ring
// (`conversation.view` slot, beside Chat/Trajectory/Context) that lets the user
// register and toggle per-session write permissions. The tab is self-adaptive:
// it joins the ring by `order` only, so it sits beside whatever other view tabs
// are mounted rather than at a fixed index.
//
// Data plane: a loopback HTTP route on the host (`/folder-permissions/grants`)
// reads and mutates the same durable per-session grant store the host command
// and enforcement use. The tab fetches that route; no custom RPC channel.
//
// This module is the body of the package's `./client` bundle (hand-written in
// the `window.__ModuleLoader__.load({ id, factory })` handoff the web shell
// executes). React comes from the injected `require('react')` — the frozen
// browser module table supplies it.
window.__ModuleLoader__.load({
  id: "dsh-folder-permissions",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    var h = React.createElement;

    var NS = "dsh-folder-permissions";
    var GRANTS_PATH = "/folder-permissions/grants";

    var DICT_ZH = {
      "tab": "权限",
      "loading": "加载中…",
      "empty": "暂无文件夹授权",
      "error": "加载失败",
      "placeholder": "输入文件夹路径（支持 ~），例如 ~/code/dsh",
      "grantWrite": "授权写入",
      "revoke": "撤销",
      "toggle": "授权/撤销",
      "revoked": "已撤销",
      "write": "写入",
      "read": "读取",
      "global": "全局（继承，只读）",
      "globalBadge": "全局",
      "session": "本会话授权",
      "mode": "沙箱模式",
      "approval": "审批策略",
      "workspace": "工作目录",
      "hint": "授权后，该会话在 workspace-write 模式下即可写入对应文件夹；撤销后立即重新阻断。"
    };
    var DICT_EN = {
      "tab": "Permissions",
      "loading": "Loading…",
      "empty": "No folder grants yet",
      "error": "Failed to load",
      "placeholder": "Folder path to grant write access (~ supported), e.g. ~/code/dsh",
      "grantWrite": "Grant write",
      "revoke": "Revoke",
      "toggle": "Grant/revoke",
      "revoked": "Revoked",
      "write": "write",
      "read": "read",
      "global": "Global (inherited, read-only)",
      "globalBadge": "global",
      "session": "Granted in this session",
      "mode": "Sandbox mode",
      "approval": "Approval policy",
      "workspace": "Workspace",
      "hint": "Once granted, this session may write under the folder in workspace-write mode; revoking immediately re-blocks it."
    };

    var STYLE = [
      ".dfp-root{box-sizing:border-box;height:100%;color:var(--dsw-alias-label-primary);padding:16px 20px 32px;font-size:13px;overflow-y:auto}",
      ".dfp-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;margin-bottom:14px;padding:14px 16px}",
      ".dfp-title{font-weight:600;margin-bottom:8px}",
      ".dfp-hint{color:var(--dsw-alias-label-secondary);font-size:12px;margin-bottom:12px}",
      ".dfp-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}",
      ".dfp-input{flex:1;min-width:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px 10px;font-size:13px;font-family:inherit}",
      ".dfp-btn{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;cursor:pointer;padding:6px 12px;font-size:12px;font-family:inherit}",
      ".dfp-btn:hover{border-color:var(--dsw-alias-label-primary)}",
      ".dfp-btn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent}",
      ".dfp-list{display:flex;flex-direction:column;gap:6px}",
      ".dfp-item{display:flex;align-items:center;gap:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px 10px}",
      ".dfp-item-global{opacity:.72;background:var(--dsw-alias-bg-layer-1)}",
      ".dfp-item-disabled{opacity:.55}",
      ".dfp-toggle{width:14px;height:14px;cursor:pointer;flex:none}",
      ".dfp-tag-off{color:var(--dsw-alias-label-tertiary);border-color:var(--dsw-alias-border-l1)}",
      ".dfp-path{flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all}",
      ".dfp-tags{display:flex;gap:4px;align-items:center}",
      ".dfp-tag{color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:0 6px;font-size:11px;white-space:nowrap}",
      ".dfp-tag-on{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent)}",
      ".dfp-tag-global{color:var(--dsw-alias-state-business-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-business-primary) 40%, transparent)}",
      ".dfp-section{margin-top:8px}",
      ".dfp-section+.dfp-section{margin-top:10px}",
      ".dfp-subtitle{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;margin-bottom:6px}",
      ".dfp-summary{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;margin-bottom:12px}",
      ".dfp-kv{display:flex;gap:8px;margin-bottom:3px}",
      ".dfp-kv:last-child{margin-bottom:0}",
      ".dfp-kv-label{color:var(--dsw-alias-label-secondary);flex:none;min-width:88px;font-size:12px}",
      ".dfp-kv-value{color:var(--dsw-alias-label-primary);min-width:0;word-break:break-all;font-size:12px}",
      ".dfp-empty{color:var(--dsw-alias-label-secondary);text-align:center;padding:18px 0}",
      ".dfp-error{color:var(--dsw-alias-state-error-primary)}"
    ].join("\n");

    function PermissionsView(props) {
      var sessionId = props.sessionId;
      var t = props.t;
      var viewState = React.useState({ status: "loading", grants: [], global: [], mode: null, approval: null, workspace: null });
      var view = viewState[0];
      var setView = viewState[1];
      var draftState = React.useState("");
      var draft = draftState[0];
      var setDraft = draftState[1];
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];

      var load = React.useCallback(function () {
        fetch(GRANTS_PATH + "?session=" + encodeURIComponent(sessionId), { headers: { accept: "application/json" } })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data && data.ok === true) setView({ status: "ok", grants: Array.isArray(data.grants) ? data.grants : [], global: Array.isArray(data.global) ? data.global : [], mode: data.mode ?? null, approval: data.approval ?? null, workspace: data.workspace ?? null });
            else setView({ status: "error", message: (data && data.error) || t("error") });
          })
          .catch(function (err) {
            setView({ status: "error", message: String((err && err.message) || err) });
          });
      }, [sessionId, t]);

      React.useEffect(function () {
        load();
      }, [load]);

      var apply = function (action, path, access) {
        setBusy(true);
        return fetch(GRANTS_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session: sessionId, action: action, path: path, access: access })
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data && data.ok === true) setView({ status: "ok", grants: Array.isArray(data.grants) ? data.grants : [], global: Array.isArray(data.global) ? data.global : [], mode: data.mode ?? null, approval: data.approval ?? null, workspace: data.workspace ?? null });
            else setView({ status: "error", message: (data && data.error) || t("error") });
          })
          .catch(function (err) {
            setView({ status: "error", message: String((err && err.message) || err) });
          })
          .finally(function () { setBusy(false); });
      };

      var grantWrite = function () {
        var path = draft.trim();
        if (path === "") return;
        apply("grant", path, "write").then(function () { setDraft(""); });
      };

      var globalGrants = (view.global || []).filter(function (g) { return g.write === true; });
      var sessionGrants = view.grants.filter(function (g) { return g.write === true; });

      function renderGlobalRow(g) {
        return h("div", { className: "dfp-item dfp-item-global", key: "g-" + g.path },
          h("span", { className: "dfp-path", title: g.path }, g.path),
          h("span", { className: "dfp-tags" },
            h("span", { className: "dfp-tag dfp-tag-on" }, t("write")),
            g.read === true ? h("span", { className: "dfp-tag dfp-tag-on" }, t("read")) : null,
            h("span", { className: "dfp-tag dfp-tag-global" }, t("globalBadge"))
          )
        );
      }

      function renderSessionRow(g) {
        var disabled = g.enabled === false;
        return h("div", { className: "dfp-item" + (disabled ? " dfp-item-disabled" : ""), key: g.path },
          h("span", { className: "dfp-path", title: g.path }, g.path),
          h("span", { className: "dfp-tags" },
            h("span", { className: "dfp-tag dfp-tag-on" }, t("write")),
            g.read === true ? h("span", { className: "dfp-tag dfp-tag-on" }, t("read")) : null,
            disabled ? h("span", { className: "dfp-tag dfp-tag-off" }, t("revoked")) : null
          ),
          h("input", {
            className: "dfp-toggle",
            type: "checkbox",
            checked: !disabled,
            disabled: busy,
            title: t("toggle"),
            "aria-label": t("toggle"),
            onChange: function () { apply("toggle", g.path); }
          })
        );
      }

      function kvRow(label, value) {
        if (value === null || value === undefined || value === "") return null;
        return h("div", { className: "dfp-kv" },
          h("span", { className: "dfp-kv-label" }, label),
          h("span", { className: "dfp-kv-value", title: String(value) }, String(value))
        );
      }

      function renderSummary() {
        var rows = [kvRow(t("mode"), view.mode), kvRow(t("approval"), view.approval), kvRow(t("workspace"), view.workspace)].filter(Boolean);
        if (rows.length === 0) return null;
        return h("div", { className: "dfp-summary" }, rows);
      }

      var body;
      if (view.status === "loading") {
        body = h("div", { className: "dfp-empty" }, t("loading"));
      } else if (view.status === "error") {
        body = h("div", { className: "dfp-empty dfp-error" }, view.message);
      } else if (globalGrants.length === 0 && sessionGrants.length === 0) {
        body = h("div", { className: "dfp-empty" }, t("empty"));
      } else {
        body = h("div", null,
          globalGrants.length > 0 ? h("div", { className: "dfp-section" },
            h("div", { className: "dfp-subtitle" }, t("global")),
            h("div", { className: "dfp-list" }, globalGrants.map(renderGlobalRow))
          ) : null,
          sessionGrants.length > 0 ? h("div", { className: "dfp-section" },
            h("div", { className: "dfp-subtitle" }, t("session")),
            h("div", { className: "dfp-list" }, sessionGrants.map(renderSessionRow))
          ) : null
        );
      }

      return h("div", { className: "dfp-root" },
        h("div", { className: "dfp-card" },
          h("div", { className: "dfp-title" }, t("tab")),
          h("div", { className: "dfp-hint" }, t("hint")),
          renderSummary(),
          h("div", { className: "dfp-row" },
            h("input", {
              className: "dfp-input",
              type: "text",
              value: draft,
              placeholder: t("placeholder"),
              onChange: function (ev) { setDraft(ev.target.value); },
              onKeyDown: function (ev) { if (ev.key === "Enter") grantWrite(); }
            }),
            h("button", { className: "dfp-btn dfp-btn-primary", type: "button", disabled: busy || draft.trim() === "", onClick: grantWrite }, t("grantWrite"))
          ),
          body
        )
      );
    }

    function apply(ctx) {
      var t = ctx.locale.bind(NS);
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN });
      }, "dsh-folder-permissions: dictionaries");

      var style = document.createElement("style");
      style.setAttribute("data-dsh-folder-permissions", "");
      style.textContent = STYLE;
      document.head.appendChild(style);
      ctx.effect(function () {
        return function () { if (style.parentNode) style.parentNode.removeChild(style); };
      }, "dsh-folder-permissions: styles");

      ctx.slots.inject("conversation.view", function () {
        return ctx.slots.register({
          name: "conversation.view",
          id: "permissions",
          order: 30,
          locale: NS,
          label: function () { return t("tab"); }
        }, function (props) {
          return h(PermissionsView, Object.assign({}, props, { t: t }));
        });
      });
    }

    module.exports = { name: "dsh-folder-permissions", inject: ["slots", "locale"], apply };
    return module.exports;
  }
});
