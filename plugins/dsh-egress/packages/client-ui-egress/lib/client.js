window.__ModuleLoader__.load({id:"dsh-client-ui-egress",factory:require=>{var module={exports:{}};var exports=module.exports;Object.defineProperty(exports,Symbol.toStringTag,{value:"Module"});
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var client_exports = {};
__export(client_exports, {
  PANEL_ID: () => PANEL_ID,
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);
var import_react2 = require("react");

// src/client/controller.ts
var INITIAL = { data: null, origin: "mock", status: "loading", probing: [] };
var EgressController = class {
  /**
   * @param host - the real bridge source.
   * @param makeMock - builds the sample source on first need.
   * @param pollMs - bridge refresh interval; 0 disables polling (tests, preview).
   */
  constructor(host, makeMock, pollMs = 15e3) {
    this.host = host;
    this.makeMock = makeMock;
    this.pollMs = pollMs;
    this.active = host;
  }
  state = INITIAL;
  listeners = /* @__PURE__ */ new Set();
  active;
  mock;
  timer;
  disposed = false;
  /** Current state; stable between changes. */
  getSnapshot = () => this.state;
  /**
   * Subscribe to state changes.
   * @param listener - change callback.
   * @returns unsubscribe.
   */
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  set(patch) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
  /** First read, then poll. */
  start() {
    void this.refresh();
    if (this.pollMs > 0) this.timer = setInterval(() => {
      void this.refresh(true);
    }, this.pollMs);
    return () => {
      this.dispose();
    };
  }
  /** Stop polling and drop listeners. */
  dispose() {
    this.disposed = true;
    if (this.timer !== void 0) clearInterval(this.timer);
    this.listeners.clear();
  }
  /**
   * Read the state, preferring the real bridge.
   * @param quiet - true for background polls: do not flash the loading state.
   */
  async refresh(quiet = false) {
    if (!quiet && this.state.data === null) this.set({ status: "loading" });
    try {
      const data = await this.host.load();
      this.active = this.host;
      const { bridgeError: _drop, ...rest } = this.state;
      this.state = rest;
      this.set({ data, origin: "host", status: "ready" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.active === this.host || this.mock === void 0) {
        this.mock ??= this.makeMock();
        this.active = this.mock;
        this.set({ data: await this.mock.load(), origin: "mock", status: "ready", bridgeError: message });
      } else {
        this.set({ bridgeError: message });
      }
    }
  }
  /** Run one write and fold its answer (or error) into the state. */
  async act(run, okText) {
    try {
      const data = await run();
      this.set({ data, notice: { kind: "ok", text: okText } });
      return true;
    } catch (error) {
      this.set({ notice: { kind: "error", text: error instanceof Error ? error.message : String(error) } });
      return false;
    }
  }
  /** Clear the toast line. */
  dismissNotice() {
    const { notice: _drop, ...rest } = this.state;
    this.state = rest;
    this.set({});
  }
  /**
   * Create or update an exit.
   * @param input - form values.
   * @returns whether the write was accepted.
   */
  saveExit(input, okText) {
    return this.act(() => this.active.putExit(input), okText);
  }
  /** Delete an exit. */
  removeExit(id, okText) {
    return this.act(() => this.active.deleteExit(id), okText);
  }
  /** Bind a host (or `*`, the default exit) to an exit; `null` unbinds. */
  bind(host, exit, okText) {
    return this.act(() => this.active.putBinding(host, exit), okText);
  }
  /** Probe one exit and show the result in its row. */
  async probe(id) {
    if (this.state.probing.includes(id)) return;
    this.set({ probing: [...this.state.probing, id] });
    try {
      const { state } = await this.active.probe(id);
      this.set({ data: state });
    } catch (error) {
      this.set({ notice: { kind: "error", text: error instanceof Error ? error.message : String(error) } });
    } finally {
      this.set({ probing: this.state.probing.filter((entry) => entry !== id) });
    }
  }
};

// src/client/EgressIcon.tsx
var import_jsx_runtime = require("react/jsx-runtime");
function EgressIcon({ size = 18, active = false }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { width: size, height: size, viewBox: "0 0 18 18", fill: "none", "aria-hidden": "true", style: { opacity: active ? 1 : 0.72 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("rect", { x: "1.5", y: "6.5", width: "4.5", height: "5", rx: "1.6", fill: "currentColor" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M6 9h2.5M8.5 9l3-4.5H15M8.5 9H15M8.5 9l3 4.5H15", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round" })
  ] });
}

// src/client/EgressPanel.tsx
var import_react = require("react");
var import_jsx_runtime2 = require("react/jsx-runtime");
var TYPES = ["http", "https", "socks5"];
function age(iso, now) {
  if (iso === void 0) return "";
  const diff = Math.max(0, now - Date.parse(iso));
  if (!Number.isFinite(diff)) return "";
  const minutes = Math.round(diff / 6e4);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${String(hours)}h` : `${String(Math.round(hours / 24))}d`;
}
var typeLabel = (exit) => exit.type === "socks5" ? "SOCKS5" : exit.type.toUpperCase();
function StatusBar({ data, origin, bridgeError, t }) {
  const [copied, setCopied] = (0, import_react.useState)(false);
  const restart = data.apply.mode === "restart";
  const copy = () => {
    void navigator.clipboard?.writeText(data.apply.restartHint).then(() => {
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 1500);
    }, () => void 0);
  };
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshe-status", "data-mode": restart ? "restart" : "instant", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshe-status-main", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshe-dot", "aria-hidden": "true" }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("strong", { children: t(restart ? "status.restart" : "status.instant") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshe-status-hint", children: restart ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
        t("status.restart.hint", { cmd: "" }).replace(/\s*$/, " "),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("code", { className: "dshe-code", children: data.apply.restartHint })
      ] }) : t("status.instant.hint") }),
      restart && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dshe-btn", "data-size": "sm", onClick: copy, children: copied ? t("status.copied") : t("status.copy") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshe-fill" }),
      origin === "mock" && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshe-badge", title: bridgeError === void 0 ? t("badge.mock.hint") : `${t("badge.mock.hint")}
${bridgeError}`, children: t("badge.mock") })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dshe-status-sub", children: t("status.failclosed") }),
    data.apply.corrupt !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dshe-alert", children: t("status.corrupt", { error: data.apply.corrupt }) }),
    !data.apply.undici.ok && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dshe-alert", children: t("status.undici", { error: data.apply.undici.error ?? "" }) })
  ] });
}
function ExitForm({ exit, t, saving, onSave, onCancel }) {
  const [name, setName] = (0, import_react.useState)(exit?.name ?? "");
  const [type, setType] = (0, import_react.useState)(exit !== void 0 && exit.type !== "direct" ? exit.type : "http");
  const [host, setHost] = (0, import_react.useState)(exit?.host ?? "");
  const [port, setPort] = (0, import_react.useState)(exit?.port === void 0 ? "" : String(exit.port));
  const [username, setUsername] = (0, import_react.useState)("");
  const [password, setPassword] = (0, import_react.useState)("");
  const [clearAuth, setClearAuth] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)();
  const submit = () => {
    const portNumber = /^[0-9]{1,5}$/.test(port.trim()) ? Number(port.trim()) : 0;
    if (name.trim() === "") return setError(t("form.err.name"));
    if (host.trim() === "") return setError(t("form.err.host"));
    if (portNumber < 1 || portNumber > 65535) return setError(t("form.err.port"));
    setError(void 0);
    onSave({
      ...exit === void 0 ? {} : { id: exit.id },
      name: name.trim(),
      type,
      host: host.trim(),
      port: portNumber,
      ...clearAuth ? { clearAuth: true } : {},
      ...!clearAuth && username !== "" ? { username } : {},
      ...!clearAuth && password !== "" ? { password } : {}
    });
  };
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("form", { className: "dshe-form", onSubmit: (event) => {
    event.preventDefault();
    submit();
  }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dshe-form-title", children: t(exit === void 0 ? "form.new" : "form.edit") }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshe-form-grid", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { className: "dshe-field", style: { gridColumn: "span 2" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: t("form.name") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("input", { className: "dshe-input", value: name, maxLength: 40, onChange: (e) => {
          setName(e.target.value);
        }, placeholder: "Tokyo", autoFocus: exit === void 0 })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { className: "dshe-field", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: t("form.type") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("select", { className: "dshe-input", value: type, onChange: (e) => {
          setType(e.target.value);
        }, children: TYPES.map((value) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("option", { value, children: value === "socks5" ? "socks5 (socks5h)" : value }, value)) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { className: "dshe-field", style: { gridColumn: "span 2" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: t("form.host") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("input", { className: "dshe-input", value: host, onChange: (e) => {
          setHost(e.target.value);
        }, placeholder: "proxy.example.com", spellCheck: false })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { className: "dshe-field", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: t("form.port") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("input", { className: "dshe-input", value: port, inputMode: "numeric", onChange: (e) => {
          setPort(e.target.value);
        }, placeholder: "1080" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { className: "dshe-field", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { children: [
          t("form.username"),
          " ",
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("em", { children: t("form.optional") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("input", { className: "dshe-input", value: username, autoComplete: "off", disabled: clearAuth, onChange: (e) => {
          setUsername(e.target.value);
        }, placeholder: exit?.hasAuth === true ? t("form.hasAuth") : "", spellCheck: false })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { className: "dshe-field", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { children: [
          t("form.password"),
          " ",
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("em", { children: t("form.optional") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("input", { className: "dshe-input", type: "password", value: password, autoComplete: "new-password", disabled: clearAuth, onChange: (e) => {
          setPassword(e.target.value);
        }, placeholder: exit?.hasAuth === true ? t("form.keep") : "" })
      ] }),
      exit?.hasAuth === true && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { className: "dshe-check", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("input", { type: "checkbox", checked: clearAuth, onChange: (e) => {
          setClearAuth(e.target.checked);
        } }),
        " ",
        t("form.clearAuth")
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshe-form-note", children: [
      type === "socks5" ? `${t("form.hint.socks5")} \xB7 ` : "",
      t("form.hint.secret")
    ] }),
    error !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dshe-form-error", children: error }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshe-form-actions", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "submit", className: "dshe-btn", "data-tone": "primary", disabled: saving, children: t(saving ? "form.saving" : "form.save") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dshe-btn", onClick: onCancel, children: t("form.cancel") })
    ] })
  ] });
}
function ExitRow({ exit, isDefault, probing, now, t, onProbe, onEdit, onDelete }) {
  const [confirm, setConfirm] = (0, import_react.useState)(false);
  const probe = exit.lastProbe;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("li", { className: "dshe-exit", "data-builtin": exit.builtin, "data-probe": probe === void 0 ? "none" : probe.ok ? "ok" : "fail", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshe-exit-id", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshe-exit-name", children: exit.name }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshe-pill", "data-type": exit.type, children: exit.builtin ? t("exit.builtin") : typeLabel(exit) }),
      isDefault && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshe-pill", "data-tone": "accent", children: t("exit.default") }),
      exit.hasAuth && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshe-pill", "data-tone": "muted", children: t("exit.auth") })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dshe-exit-addr", title: exit.url, children: exit.builtin ? t("exit.direct.desc") : exit.url }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dshe-exit-probe", children: probing ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshe-probe-wait", children: t("exit.probing") }) : probe === void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshe-probe-none", children: t("exit.noProbe") }) : probe.ok ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "dshe-probe-ok", title: probe.at, children: [
      t("exit.probeOk", { ip: probe.ip ?? "?", ms: probe.ms ?? 0 }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("em", { children: age(probe.at, now) })
    ] }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "dshe-probe-fail", title: probe.error, children: [
      t("exit.probeFail", { error: probe.error ?? "" }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("em", { children: age(probe.at, now) })
    ] }) }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshe-exit-actions", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dshe-btn", "data-size": "sm", disabled: probing, onClick: onProbe, children: t(probing ? "exit.probing" : "exit.probe") }),
      !exit.builtin && !confirm && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dshe-btn", "data-size": "sm", onClick: onEdit, children: t("exit.edit") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dshe-btn", "data-size": "sm", "data-tone": "bad", onClick: () => {
          setConfirm(true);
        }, children: t("exit.delete") })
      ] }),
      !exit.builtin && confirm && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dshe-btn", "data-size": "sm", "data-tone": "bad-solid", onClick: () => {
          setConfirm(false);
          onDelete();
        }, children: t("exit.confirm") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dshe-btn", "data-size": "sm", onClick: () => {
          setConfirm(false);
        }, children: t("exit.cancel") })
      ] })
    ] })
  ] });
}
function ExitSelect({ exits, value, onChange, label }) {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("select", { className: "dshe-select", "aria-label": label, value: exits.some((e) => e.id === value) ? value : "", onChange: (e) => {
    onChange(e.target.value);
  }, children: [
    !exits.some((e) => e.id === value) && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("option", { value: "", disabled: true, children: value }),
    exits.map((exit) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("option", { value: exit.id, children: exit.builtin ? exit.name : `${exit.name} \xB7 ${typeLabel(exit)}` }, exit.id))
  ] });
}
function Bindings({ data, t, now, onBind }) {
  const [host, setHost] = (0, import_react.useState)("");
  const add = () => {
    const value = host.trim().toLowerCase();
    if (value === "") return;
    onBind(value, data.defaultExit);
    setHost("");
  };
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { className: "dshe-section", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("header", { className: "dshe-section-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h2", { children: t("bind.title") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshe-section-sub", children: t("bind.subtitle") })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshe-table", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshe-row dshe-row-head", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: t("bind.host") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", {}),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: t("bind.exit") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", {})
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshe-row", "data-kind": "default", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "dshe-host", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("strong", { children: t("bind.default") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("em", { children: t("bind.default.hint") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", {}),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(ExitSelect, { exits: data.exits, value: data.defaultExit, label: t("bind.default"), onChange: (id) => {
          onBind("*", id);
        } }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", {})
      ] }),
      data.bindings.map((row) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshe-row", "data-source": row.source, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "dshe-host", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("code", { children: row.host }),
          row.provider !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshe-pill", "data-tone": "muted", children: row.provider })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshe-seen", children: row.lastSeen === void 0 ? t("bind.neverSeen") : t("bind.lastSeen", { time: age(row.lastSeen, now) }) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(ExitSelect, { exits: data.exits, value: row.exit, label: row.host, onChange: (id) => {
          onBind(row.host, id);
        } }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "dshe-row-end", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshe-source", "data-source": row.source, children: t(row.source === "binding" ? "bind.source.binding" : "bind.source.default") }),
          row.source === "binding" && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dshe-link", onClick: () => {
            onBind(row.host, null);
          }, children: t("bind.unbind") })
        ] })
      ] }, row.host))
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("form", { className: "dshe-addhost", onSubmit: (event) => {
      event.preventDefault();
      add();
    }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("input", { className: "dshe-input", value: host, onChange: (e) => {
        setHost(e.target.value);
      }, placeholder: t("bind.addHost.placeholder"), spellCheck: false, "aria-label": t("bind.addHost") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "submit", className: "dshe-btn", disabled: host.trim() === "", children: t("bind.addHost") })
    ] })
  ] });
}
function RequestLog({ entries, t, now, initialOpen }) {
  const [open, setOpen] = (0, import_react.useState)(initialOpen);
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { className: "dshe-section", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("header", { className: "dshe-section-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h2", { children: t("log.title") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshe-section-sub", children: t("log.hint") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshe-fill" }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("button", { type: "button", className: "dshe-link", "aria-expanded": open, onClick: () => {
        setOpen(!open);
      }, children: [
        t(open ? "log.hide" : "log.show"),
        " (",
        entries.length,
        ")"
      ] })
    ] }),
    open && (entries.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dshe-empty", children: t("log.empty") }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("ul", { className: "dshe-log", children: entries.slice(0, 30).map((entry, index) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("li", { "data-ok": entry.ok, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshe-log-dot", "aria-hidden": "true" }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("code", { children: entry.host }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "dshe-log-exit", children: [
        "\u2192 ",
        entry.exitName
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshe-log-result", children: entry.ok ? t("log.ok") : `${t("log.fail")}${entry.error === void 0 ? "" : `: ${entry.error}`}` }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshe-log-time", children: age(entry.at, now) })
    ] }, `${entry.at}-${String(index)}`)) }))
  ] });
}
function EgressPanel({ controller, t, initialForm, initialLogOpen = false }) {
  const state = (0, import_react.useSyncExternalStore)(controller.subscribe, controller.getSnapshot);
  const [form, setForm] = (0, import_react.useState)(initialForm);
  const [saving, setSaving] = (0, import_react.useState)(false);
  const data = state.data;
  const now = data === null ? Date.now() : Date.parse(data.fetchedAt) || Date.now();
  if (data === null) {
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dshe-panel", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dshe-page", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dshe-empty", children: t("loading") }) }) });
  }
  const editing = typeof form === "object" ? data.exits.find((exit) => exit.id === form.edit) : void 0;
  const save = (input) => {
    setSaving(true);
    void controller.saveExit(input, t("form.save")).then((ok) => {
      setSaving(false);
      if (ok) setForm(void 0);
    });
  };
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dshe-panel", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshe-page", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("header", { className: "dshe-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h1", { className: "dshe-title", children: t("panel.title") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dshe-sub", children: t("panel.subtitle") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshe-fill" }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dshe-btn", onClick: () => {
        void controller.refresh();
      }, children: t("refresh") })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(StatusBar, { data, origin: state.origin, bridgeError: state.bridgeError, t }),
    state.notice !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshe-notice", "data-kind": state.notice.kind, role: "status", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: state.notice.text }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dshe-link", onClick: () => {
        controller.dismissNotice();
      }, children: "\xD7" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { className: "dshe-section", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("header", { className: "dshe-section-head", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h2", { children: t("exits.title") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshe-fill" }),
        form === void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("button", { type: "button", className: "dshe-btn", "data-tone": "primary", onClick: () => {
          setForm("new");
        }, children: [
          "+ ",
          t("exits.add")
        ] })
      ] }),
      form !== void 0 && (form === "new" || editing !== void 0) && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(ExitForm, { exit: editing, t, saving, onSave: save, onCancel: () => {
        setForm(void 0);
      } }, form === "new" ? "new" : form.edit),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("ul", { className: "dshe-exits", children: data.exits.map((exit) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        ExitRow,
        {
          exit,
          isDefault: data.defaultExit === exit.id,
          probing: state.probing.includes(exit.id),
          now,
          t,
          onProbe: () => {
            void controller.probe(exit.id);
          },
          onEdit: () => {
            setForm({ edit: exit.id });
          },
          onDelete: () => {
            void controller.removeExit(exit.id, t("exit.delete"));
          }
        },
        exit.id
      )) }),
      data.exits.length === 1 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dshe-empty", children: t("exits.empty") })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Bindings, { data, t, now, onBind: (host, exit) => {
      void controller.bind(host, exit, t("bind.title"));
    } }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(RequestLog, { entries: data.recent, t, now, initialOpen: initialLogOpen })
  ] }) });
}

// src/client/locales.ts
var NS = "egress.panel";
var zh = {
  "panel.title": "\u51FA\u53E3",
  "panel.subtitle": "\u4E3A\u6BCF\u4E2A\u6A21\u578B\u7AEF\u70B9\u9009\u62E9\u51FA\u7AD9\u4EE3\u7406",
  "badge.mock": "\u793A\u4F8B\u6570\u636E",
  "badge.mock.hint": "\u5BBF\u4E3B\u4FA7\u7684\u51FA\u53E3\u6865\u6CA1\u6709\u63A5\u901A\uFF0C\u4E0B\u9762\u662F\u5185\u7F6E\u793A\u4F8B\u6570\u636E\uFF0C\u6539\u52A8\u4E0D\u4F1A\u4FDD\u5B58",
  "refresh": "\u5237\u65B0",
  "retry": "\u91CD\u8BD5",
  "loading": "\u6B63\u5728\u8BFB\u53D6\u2026",
  "error.load": "\u8BFB\u53D6\u5931\u8D25\uFF1A{message}",
  "status.instant": "\u5373\u65F6\u751F\u6548",
  "status.instant.hint": "\u4FDD\u5B58\u540E\u4E0B\u4E00\u6761\u6A21\u578B\u8BF7\u6C42\u5C31\u8D70\u65B0\u51FA\u53E3\uFF0C\u4E0D\u7528\u91CD\u542F dsh-web",
  "status.restart": "\u9700\u91CD\u542F dsh-web",
  "status.restart.hint": "\u8BF7\u6C42\u94A9\u5B50\u6CA1\u6709\u751F\u6548\uFF08\u63D2\u4EF6\u521A\u5B89\u88C5\uFF0C\u6216\u88AB\u5176\u5B83\u4EE3\u7801\u8986\u76D6\uFF09\u3002\u8BF7\u5728\u670D\u52A1\u5668\u4E0A\u6267\u884C {cmd}\u3002\u672C\u9762\u677F\u4E0D\u4F1A\u81EA\u5DF1\u91CD\u542F\u3002",
  "status.corrupt": "\u914D\u7F6E\u6587\u4EF6\u65E0\u6CD5\u8BFB\u53D6\uFF0C\u6240\u6709\u975E\u672C\u673A\u8BF7\u6C42\u5DF2\u88AB\u62E6\u622A\uFF1A{error}",
  "status.undici": "\u627E\u4E0D\u5230 undici\uFF0C\u8D70\u4EE3\u7406\u7684\u8BF7\u6C42\u4F1A\u76F4\u63A5\u5931\u8D25\uFF08\u4E0D\u4F1A\u76F4\u8FDE\uFF09\uFF1A{error}",
  "status.failclosed": "\u5931\u8D25\u5373\u65AD\uFF1A\u51FA\u53E3\u4E0D\u901A\u65F6\u8BF7\u6C42\u76F4\u63A5\u62A5\u9519\uFF0C\u4E0D\u4F1A\u56DE\u9000\u76F4\u8FDE",
  "status.copy": "\u590D\u5236\u547D\u4EE4",
  "status.copied": "\u5DF2\u590D\u5236",
  "exits.title": "\u51FA\u53E3",
  "exits.add": "\u6DFB\u52A0\u51FA\u53E3",
  "exits.empty": "\u8FD8\u6CA1\u6709\u81EA\u5B9A\u4E49\u51FA\u53E3\u3002\u70B9\u300C\u6DFB\u52A0\u51FA\u53E3\u300D\u914D\u7F6E\u4E00\u4E2A http\u3001https \u6216 socks5 \u4EE3\u7406\u3002",
  "exit.builtin": "\u5185\u7F6E",
  "exit.default": "\u9ED8\u8BA4",
  "exit.probe": "\u63A2\u6D4B",
  "exit.probing": "\u63A2\u6D4B\u4E2D\u2026",
  "exit.edit": "\u7F16\u8F91",
  "exit.delete": "\u5220\u9664",
  "exit.confirm": "\u786E\u8BA4\u5220\u9664",
  "exit.cancel": "\u53D6\u6D88",
  "exit.noProbe": "\u672A\u63A2\u6D4B",
  "exit.probeOk": "\u51FA\u53E3 IP {ip} \xB7 {ms} ms",
  "exit.probeFail": "\u5931\u8D25\uFF1A{error}",
  "exit.auth": "\u6709\u8BA4\u8BC1",
  "exit.direct.desc": "\u670D\u52A1\u5668\u81EA\u5DF1\u7684\u7F51\u7EDC\uFF0C\u4E0D\u7ECF\u8FC7\u4EE3\u7406",
  "form.new": "\u6DFB\u52A0\u51FA\u53E3",
  "form.edit": "\u7F16\u8F91\u51FA\u53E3",
  "form.name": "\u540D\u79F0",
  "form.type": "\u7C7B\u578B",
  "form.host": "\u4E3B\u673A",
  "form.port": "\u7AEF\u53E3",
  "form.username": "\u7528\u6237\u540D",
  "form.password": "\u5BC6\u7801",
  "form.optional": "\u53EF\u9009",
  "form.keep": "\u7559\u7A7A\u5219\u4FDD\u7559\u539F\u5BC6\u7801",
  "form.clearAuth": "\u6E05\u9664\u8BA4\u8BC1",
  "form.hasAuth": "\u5DF2\u8BBE\u7F6E\u8BA4\u8BC1",
  "form.save": "\u4FDD\u5B58",
  "form.saving": "\u4FDD\u5B58\u4E2D\u2026",
  "form.cancel": "\u53D6\u6D88",
  "form.hint.socks5": "socks5 \u7531\u4EE3\u7406\u89E3\u6790\u57DF\u540D\uFF08socks5h\uFF09",
  "form.hint.secret": "\u8BA4\u8BC1\u53EA\u4FDD\u5B58\u5728\u670D\u52A1\u5668\u4E0A\u6743\u9650 0600 \u7684\u6587\u4EF6\u91CC\uFF0C\u4E0D\u4F1A\u56DE\u4F20\u5230\u6D4F\u89C8\u5668\u3002",
  "form.err.name": "\u8BF7\u586B\u5199\u540D\u79F0",
  "form.err.host": "\u8BF7\u586B\u5199\u4E3B\u673A",
  "form.err.port": "\u7AEF\u53E3\u9700\u8981\u662F 1 \u5230 65535 \u7684\u6574\u6570",
  "bind.title": "\u7ED1\u5B9A",
  "bind.subtitle": "\u6BCF\u4E2A\u6A21\u578B\u7AEF\u70B9\u4E3B\u673A\u8D70\u54EA\u4E2A\u51FA\u53E3",
  "bind.host": "\u76EE\u6807\u4E3B\u673A",
  "bind.exit": "\u51FA\u53E3",
  "bind.default": "\u9ED8\u8BA4\u51FA\u53E3",
  "bind.default.hint": "\u6CA1\u6709\u5355\u72EC\u7ED1\u5B9A\u7684\u4E3B\u673A\u8D70\u8FD9\u91CC",
  "bind.source.binding": "\u5DF2\u7ED1\u5B9A",
  "bind.source.default": "\u8DDF\u968F\u9ED8\u8BA4",
  "bind.unbind": "\u53D6\u6D88\u7ED1\u5B9A",
  "bind.addHost": "\u6DFB\u52A0\u4E3B\u673A",
  "bind.addHost.placeholder": "\u4F8B\u5982 api.example.com",
  "bind.lastSeen": "\u6700\u8FD1\u8BF7\u6C42 {time}",
  "bind.neverSeen": "\u5C1A\u65E0\u8BF7\u6C42",
  "log.title": "\u6700\u8FD1\u8BF7\u6C42",
  "log.hint": "\u6700\u8FD1 100 \u6761\uFF0C\u53EA\u8BB0\u4E3B\u673A\u3001\u51FA\u53E3\u548C\u7ED3\u679C\uFF0C\u4E0D\u8BB0\u5185\u5BB9\u548C\u5BC6\u94A5",
  "log.empty": "\u8FD8\u6CA1\u6709\u8BF7\u6C42\u7ECF\u8FC7\u672C\u63D2\u4EF6",
  "log.ok": "\u6210\u529F",
  "log.fail": "\u5931\u8D25",
  "log.show": "\u5C55\u5F00",
  "log.hide": "\u6536\u8D77"
};
var en = {
  "panel.title": "Egress",
  "panel.subtitle": "Choose the proxy each model endpoint leaves through",
  "badge.mock": "Sample data",
  "badge.mock.hint": "The host egress bridge is not reachable. This is built-in sample data and changes are not saved.",
  "refresh": "Refresh",
  "retry": "Retry",
  "loading": "Loading\u2026",
  "error.load": "Could not load: {message}",
  "status.instant": "Applies instantly",
  "status.instant.hint": "After saving, the next model request already uses the new exit. No dsh-web restart.",
  "status.restart": "dsh-web restart needed",
  "status.restart.hint": "The request hook is not active (just installed, or overwritten by other code). Run {cmd} on the server. This panel never restarts anything itself.",
  "status.corrupt": "The config file is unreadable and every non-local request is blocked: {error}",
  "status.undici": "undici was not found. Requests that need a proxy fail (they are never sent directly): {error}",
  "status.failclosed": "Fail-closed: if an exit is down the request errors out. It never falls back to a direct connection.",
  "status.copy": "Copy command",
  "status.copied": "Copied",
  "exits.title": "Exits",
  "exits.add": "Add exit",
  "exits.empty": 'No custom exits yet. Use "Add exit" to configure an http, https or socks5 proxy.',
  "exit.builtin": "built in",
  "exit.default": "default",
  "exit.probe": "Probe",
  "exit.probing": "Probing\u2026",
  "exit.edit": "Edit",
  "exit.delete": "Delete",
  "exit.confirm": "Confirm delete",
  "exit.cancel": "Cancel",
  "exit.noProbe": "Not probed",
  "exit.probeOk": "Exit IP {ip} \xB7 {ms} ms",
  "exit.probeFail": "Failed: {error}",
  "exit.auth": "auth",
  "exit.direct.desc": "The server's own network, no proxy",
  "form.new": "Add exit",
  "form.edit": "Edit exit",
  "form.name": "Name",
  "form.type": "Type",
  "form.host": "Host",
  "form.port": "Port",
  "form.username": "Username",
  "form.password": "Password",
  "form.optional": "optional",
  "form.keep": "Leave empty to keep the stored password",
  "form.clearAuth": "Remove authentication",
  "form.hasAuth": "Authentication set",
  "form.save": "Save",
  "form.saving": "Saving\u2026",
  "form.cancel": "Cancel",
  "form.hint.socks5": "socks5 lets the proxy resolve host names (socks5h)",
  "form.hint.secret": "Credentials stay in a 0600 file on the server and are never sent back to the browser.",
  "form.err.name": "Enter a name",
  "form.err.host": "Enter a host",
  "form.err.port": "Port must be an integer from 1 to 65535",
  "bind.title": "Bindings",
  "bind.subtitle": "Which exit each model endpoint host uses",
  "bind.host": "Target host",
  "bind.exit": "Exit",
  "bind.default": "Default exit",
  "bind.default.hint": "Hosts without their own binding use this",
  "bind.source.binding": "bound",
  "bind.source.default": "follows default",
  "bind.unbind": "Unbind",
  "bind.addHost": "Add host",
  "bind.addHost.placeholder": "e.g. api.example.com",
  "bind.lastSeen": "last request {time}",
  "bind.neverSeen": "no request yet",
  "log.title": "Recent requests",
  "log.hint": "Last 100. Only host, exit and result are kept, never content or keys.",
  "log.empty": "No request has passed through this plugin yet",
  "log.ok": "ok",
  "log.fail": "failed",
  "log.show": "Show",
  "log.hide": "Hide"
};
var DICTIONARIES = { zh, en };

// src/client/mock.ts
var ago = (minutes, now) => new Date(now - minutes * 6e4).toISOString();
function sampleState(now = Date.now()) {
  const exits = [
    { id: "direct", name: "direct", type: "direct", builtin: true, hasAuth: false, url: "direct" },
    {
      id: "tokyo",
      name: "Tokyo",
      type: "socks5",
      builtin: false,
      host: "jp-1.proxy.example.net",
      port: 1080,
      hasAuth: true,
      url: "socks5://***:***@jp-1.proxy.example.net:1080",
      lastProbe: { ok: true, ip: "198.51.100.23", ms: 184, at: ago(3, now) }
    },
    {
      id: "hk-http",
      name: "HK relay",
      type: "http",
      builtin: false,
      host: "hk-relay.example.net",
      port: 3128,
      hasAuth: false,
      url: "http://hk-relay.example.net:3128",
      lastProbe: { ok: false, error: "ECONNREFUSED connect ECONNREFUSED 203.0.113.8:3128", ms: 41, at: ago(12, now) }
    },
    {
      id: "us-https",
      name: "US secure",
      type: "https",
      builtin: false,
      host: "us-2.proxy.example.net",
      port: 8443,
      hasAuth: true,
      url: "https://***:***@us-2.proxy.example.net:8443"
    }
  ];
  const bindings = [
    { host: "api.commandcode.ai", provider: "commandecode", exit: "tokyo", source: "binding", lastSeen: ago(1, now) },
    { host: "api.deepseek.com", provider: "deepseek", exit: "direct", source: "default", lastSeen: ago(55, now) },
    { host: "mcp.example.org", exit: "direct", source: "default" }
  ];
  const recent = [
    { at: ago(1, now), host: "api.commandcode.ai", exit: "tokyo", exitName: "Tokyo", ok: true },
    { at: ago(1.4, now), host: "api.commandcode.ai", exit: "tokyo", exitName: "Tokyo", ok: true },
    { at: ago(9, now), host: "api.commandcode.ai", exit: "hk-http", exitName: "HK relay", ok: false, error: "ECONNREFUSED connect ECONNREFUSED 203.0.113.8:3128" },
    { at: ago(55, now), host: "api.deepseek.com", exit: "direct", exitName: "direct", ok: true }
  ];
  return {
    version: 1,
    origin: "mock",
    fetchedAt: new Date(now).toISOString(),
    exits,
    defaultExit: "direct",
    bindings,
    recent,
    apply: { mode: "instant", hookActive: true, undici: { ok: true, version: "8.11.2" }, restartHint: "systemctl restart dsh-web" },
    probeEndpoint: "https://ifconfig.me/ip"
  };
}
function createMockSource(options = {}) {
  let state = options.initial ?? sampleState();
  const delay = options.probeDelayMs ?? 700;
  const wait = (ms) => new Promise((done) => setTimeout(done, ms));
  const maskedUrl = (input, hasAuth) => `${input.type}://${hasAuth ? "***:***@" : ""}${input.host}:${String(input.port)}`;
  const set = (next) => {
    state = { ...state, ...next, fetchedAt: (/* @__PURE__ */ new Date()).toISOString() };
    return state;
  };
  const rebuildBindings = (bound) => state.bindings.map((row) => {
    const exit = bound[row.host];
    return exit === void 0 ? { ...row, exit: state.defaultExit, source: "default" } : { ...row, exit, source: "binding" };
  });
  return {
    origin: "mock",
    load: () => Promise.resolve(state),
    putExit(input) {
      const existing = input.id === void 0 ? void 0 : state.exits.find((exit) => exit.id === input.id);
      const hasAuth = input.clearAuth === true ? false : input.username !== void 0 && input.username !== "" || (existing?.hasAuth ?? false);
      const id = existing?.id ?? input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const next = {
        id,
        name: input.name,
        type: input.type,
        builtin: false,
        host: input.host,
        port: input.port,
        hasAuth,
        url: maskedUrl(input, hasAuth)
      };
      const exits = existing === void 0 ? [...state.exits, next] : state.exits.map((exit) => exit.id === id ? next : exit);
      return Promise.resolve(set({ exits }));
    },
    deleteExit(id) {
      const users = state.bindings.filter((row) => row.exit === id && row.source === "binding").map((row) => row.host);
      if (state.defaultExit === id) users.push("* (default)");
      if (users.length > 0) return Promise.reject(new Error(`exit "${id}" is still used by ${users.join(", ")}; rebind them first`));
      return Promise.resolve(set({ exits: state.exits.filter((exit) => exit.id !== id) }));
    },
    putBinding(host, exit) {
      if (host === "*") return Promise.resolve(set({ defaultExit: exit ?? "direct", bindings: state.bindings.map((row) => row.source === "default" ? { ...row, exit: exit ?? "direct" } : row) }));
      const bound = {};
      for (const row of state.bindings) if (row.source === "binding") bound[row.host] = row.exit;
      if (exit === null) delete bound[host];
      else bound[host] = exit;
      const known = state.bindings.some((row) => row.host === host);
      const base = known ? [...state.bindings] : [...state.bindings, { host, exit: state.defaultExit, source: "default" }];
      state = { ...state, bindings: base };
      return Promise.resolve(set({ bindings: rebuildBindings(bound) }));
    },
    async probe(id) {
      await wait(delay);
      const exit = state.exits.find((candidate) => candidate.id === id);
      const down = /dead|down/.test(exit?.host ?? "") || exit?.id === "hk-http";
      const at = (/* @__PURE__ */ new Date()).toISOString();
      const result = down ? { ok: false, ms: 52, error: `ECONNREFUSED connect ECONNREFUSED ${exit?.host ?? "?"}:${String(exit?.port ?? 0)}`, at } : { ok: true, ip: id === "direct" ? "203.0.113.50" : "198.51.100.23", ms: id === "direct" ? 96 : 184, at };
      return { result, state: set({ exits: state.exits.map((candidate) => candidate.id === id ? { ...candidate, lastProbe: result } : candidate) }) };
    }
  };
}

// src/client/source.ts
var BRIDGE_BASE = "/api/egress";
async function call(doFetch, url, init) {
  const response = await doFetch(url, { credentials: "same-origin", cache: "no-store", ...init });
  const text = await response.text();
  let body;
  try {
    body = text === "" ? void 0 : JSON.parse(text);
  } catch {
    body = void 0;
  }
  if (!response.ok) {
    const error = body?.error;
    const message = typeof error?.message === "string" ? error.message : `HTTP ${String(response.status)}`;
    throw new Error(message);
  }
  return body;
}
var JSON_HEADERS = { "content-type": "application/json" };
function asState(body) {
  const candidate = body;
  if (candidate === void 0 || candidate.version !== 1 || !Array.isArray(candidate.exits) || !Array.isArray(candidate.bindings)) {
    throw new Error("the egress bridge answered with something that is not a state document");
  }
  return candidate;
}
function createHttpSource(options = {}) {
  const base = options.base ?? BRIDGE_BASE;
  const doFetch = () => {
    const impl = options.fetchImpl ?? globalThis.fetch;
    if (typeof impl !== "function") throw new Error("this environment has no fetch(); the egress bridge is unreachable");
    return impl.bind(globalThis);
  };
  return {
    origin: "host",
    async load() {
      return asState(await call(doFetch(), `${base}/state`, { method: "GET" }));
    },
    async putExit(input) {
      return asState(await call(doFetch(), `${base}/exit`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(input) }));
    },
    async deleteExit(id) {
      return asState(await call(doFetch(), `${base}/exit?id=${encodeURIComponent(id)}`, { method: "DELETE" }));
    },
    async putBinding(host, exit) {
      return asState(await call(doFetch(), `${base}/binding`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ host, exit }) }));
    },
    async probe(id) {
      const body = await call(doFetch(), `${base}/probe`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ id }) });
      if (body?.result === void 0) throw new Error("the egress bridge answered a probe without a result");
      return { result: body.result, state: asState(body.state) };
    }
  };
}
function defaultSources() {
  return { host: createHttpSource(), mock: () => createMockSource() };
}

// src/client/styles.ts
var STYLE_KEY = "dsh-client-ui-egress/EgressPanel.css";
var EGRESS_CSS = `
.dshe-panel {
  --dshe-accent: #4d6bfe;
  --dshe-accent-soft: color-mix(in srgb, var(--dshe-accent) 10%, transparent);
  --dshe-text: var(--dsw-alias-label-primary, #0f1115);
  --dshe-text-2: var(--dsw-alias-label-secondary, #61666b);
  --dshe-text-3: var(--dsw-alias-label-tertiary, #81858c);
  --dshe-line: var(--dsw-alias-border-l, #e1e5ee);
  --dshe-bg: var(--dsw-alias-bg-base, #fff);
  --dshe-fill: var(--dsw-alias-bg-layer-1, #f9fafb);
  --dshe-fill-2: var(--dsw-alias-bg-layer-2, #f5f7fa);
  --dshe-hover: var(--dsw-alias-interactive-bg-hover, rgba(15, 17, 21, 0.05));
  --dshe-ok: var(--dsw-alias-state-success-primary, #22c55e);
  --dshe-warn: var(--dsw-alias-state-warn-primary, #f59e0b);
  --dshe-bad: var(--dsw-alias-state-error-primary, #ec1313);
  --dshe-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;

  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  background: var(--dshe-bg);
  color: var(--dshe-text);
  font-family: var(--dsh-font, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif);
  font-size: 14px;
  line-height: 22px;
  text-align: left;
  container-type: inline-size;
}
.dshe-panel *, .dshe-panel *::before, .dshe-panel *::after { box-sizing: border-box; }
.dshe-panel ::-webkit-scrollbar { width: 8px; height: 8px; }
.dshe-panel ::-webkit-scrollbar-thumb { border: 2px solid transparent; border-radius: 999px; background-clip: content-box; background-color: color-mix(in srgb, var(--dshe-text) 16%, transparent); }

.dshe-page { max-width: 880px; margin: 0 auto; padding: 36px 28px 64px; display: flex; flex-direction: column; gap: 22px; }
.dshe-fill { flex: 1 1 auto; min-width: 0; }
.dshe-head { display: flex; align-items: flex-end; gap: 12px; }
.dshe-title { margin: 0; font-size: 24px; line-height: 32px; font-weight: 600; letter-spacing: 0; }
.dshe-sub { margin: 2px 0 0; color: var(--dshe-text-3); font-size: 13px; }
.dshe-code { font-family: var(--dshe-mono); font-size: 12px; padding: 1px 6px; border-radius: 6px; background: var(--dshe-fill-2); color: var(--dshe-text); }
.dshe-empty { padding: 14px 16px; border-radius: 12px; background: var(--dshe-fill); color: var(--dshe-text-3); font-size: 13px; }

/* ---------- buttons ---------- */
.dshe-btn {
  display: inline-flex; align-items: center; gap: 4px; height: 32px; padding: 0 14px;
  border: 0; border-radius: 999px; background: var(--dshe-fill-2); color: var(--dshe-text);
  font: inherit; font-size: 13px; line-height: 20px; cursor: pointer; white-space: nowrap;
  transition: background-color 120ms ease, color 120ms ease, opacity 120ms ease;
}
.dshe-btn:hover { background: color-mix(in srgb, var(--dshe-text) 9%, var(--dshe-fill-2)); }
.dshe-btn:focus-visible, .dshe-link:focus-visible, .dshe-select:focus-visible { outline: 2px solid var(--dshe-accent); outline-offset: 2px; }
.dshe-btn[disabled] { opacity: 0.55; cursor: default; }
.dshe-btn[data-size="sm"] { height: 28px; padding: 0 12px; font-size: 12.5px; }
.dshe-btn[data-tone="primary"] { background: var(--dshe-accent); color: #fff; font-weight: 500; }
.dshe-btn[data-tone="primary"]:hover { background: color-mix(in srgb, var(--dshe-accent) 88%, #000); }
.dshe-btn[data-tone="bad"] { color: var(--dshe-bad); background: color-mix(in srgb, var(--dshe-bad) 9%, transparent); }
.dshe-btn[data-tone="bad"]:hover { background: color-mix(in srgb, var(--dshe-bad) 16%, transparent); }
.dshe-btn[data-tone="bad-solid"] { background: var(--dshe-bad); color: #fff; }
.dshe-link { border: 0; background: transparent; padding: 0 2px; color: var(--dshe-accent); font: inherit; font-size: 12.5px; cursor: pointer; border-radius: 4px; }
.dshe-link:hover { text-decoration: underline; }

/* ---------- status bar ---------- */
.dshe-status { padding: 14px 16px; border-radius: 16px; background: var(--dshe-accent-soft); display: flex; flex-direction: column; gap: 6px; }
.dshe-status[data-mode="restart"] { background: color-mix(in srgb, var(--dshe-warn) 14%, transparent); }
.dshe-status-main { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dshe-status-main strong { font-weight: 600; color: var(--dshe-accent); }
.dshe-status[data-mode="restart"] .dshe-status-main strong { color: color-mix(in srgb, var(--dshe-warn) 80%, var(--dshe-text)); }
.dshe-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dshe-ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dshe-ok) 22%, transparent); flex: none; }
.dshe-status[data-mode="restart"] .dshe-dot { background: var(--dshe-warn); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dshe-warn) 25%, transparent); }
.dshe-status-hint { color: var(--dshe-text-2); font-size: 13px; }
.dshe-status-sub { color: var(--dshe-text-3); font-size: 12.5px; padding-left: 16px; }
.dshe-alert { margin-top: 2px; padding: 8px 12px; border-radius: 10px; background: color-mix(in srgb, var(--dshe-bad) 10%, transparent); color: var(--dshe-bad); font-size: 12.5px; line-height: 18px; }
.dshe-badge { padding: 1px 10px; border-radius: 999px; background: color-mix(in srgb, var(--dshe-warn) 20%, transparent); color: color-mix(in srgb, var(--dshe-warn) 75%, var(--dshe-text)); font-size: 12px; font-weight: 500; cursor: help; }

.dshe-notice { display: flex; align-items: center; gap: 10px; padding: 8px 14px; border-radius: 12px; font-size: 13px; background: color-mix(in srgb, var(--dshe-ok) 12%, transparent); }
.dshe-notice[data-kind="error"] { background: color-mix(in srgb, var(--dshe-bad) 10%, transparent); color: var(--dshe-bad); }
.dshe-notice span { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }

/* ---------- sections ---------- */
.dshe-section { display: flex; flex-direction: column; gap: 10px; }
.dshe-section-head { display: flex; align-items: center; gap: 10px; min-height: 32px; }
.dshe-section-head h2 { margin: 0; font-size: 15px; line-height: 24px; font-weight: 600; }
.dshe-section-sub { color: var(--dshe-text-3); font-size: 12.5px; }

/* ---------- exit list ---------- */
.dshe-exits { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.dshe-exit {
  display: grid; grid-template-columns: minmax(150px, 1.1fr) minmax(0, 1.5fr) minmax(0, 1.5fr) auto; align-items: center; gap: 4px 16px;
  padding: 12px 16px; border-radius: 14px; background: var(--dshe-fill); transition: background-color 120ms ease;
}
.dshe-exit:hover { background: var(--dshe-fill-2); }
.dshe-exit-id { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
.dshe-exit-name { font-weight: 600; font-size: 14px; overflow-wrap: anywhere; }
.dshe-exit-addr { font-family: var(--dshe-mono); font-size: 12px; color: var(--dshe-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshe-exit[data-builtin="true"] .dshe-exit-addr { font-family: inherit; font-size: 12.5px; color: var(--dshe-text-3); }
.dshe-exit-probe { font-size: 12.5px; min-width: 0; line-height: 18px; }
.dshe-exit-probe em { font-style: normal; margin-left: 6px; color: var(--dshe-text-3); }
.dshe-probe-ok { color: color-mix(in srgb, var(--dshe-ok) 70%, var(--dshe-text)); }
.dshe-probe-fail { color: var(--dshe-bad); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.dshe-probe-none, .dshe-probe-wait { color: var(--dshe-text-3); }
.dshe-probe-wait { color: var(--dshe-accent); }
.dshe-exit-actions { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }
.dshe-pill { display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border-radius: 999px; background: var(--dshe-accent-soft); color: var(--dshe-accent); font-size: 11px; font-weight: 600; letter-spacing: 0.02em; }
.dshe-pill[data-type="direct"] { background: color-mix(in srgb, var(--dshe-text) 8%, transparent); color: var(--dshe-text-2); }
.dshe-pill[data-tone="muted"] { background: color-mix(in srgb, var(--dshe-text) 7%, transparent); color: var(--dshe-text-2); font-weight: 500; }
.dshe-pill[data-tone="accent"] { background: var(--dshe-accent); color: #fff; }

@container (max-width: 700px) {
  .dshe-exit { grid-template-columns: minmax(0, 1fr) auto; }
  .dshe-exit-addr, .dshe-exit-probe { grid-column: 1 / -1; }
  .dshe-exit-actions { grid-column: 1 / -1; justify-content: flex-start; }
  .dshe-page { padding: 24px 16px 48px; }
}

/* ---------- form ---------- */
.dshe-form { padding: 16px 18px 14px; border-radius: 16px; background: var(--dshe-bg); box-shadow: 0 0 0 1px var(--dshe-line), 0 6px 22px rgba(15, 17, 21, 0.06); display: flex; flex-direction: column; gap: 12px; }
.dshe-form-title { font-weight: 600; font-size: 14px; }
.dshe-form-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.dshe-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; font-size: 12.5px; color: var(--dshe-text-2); }
.dshe-field em { font-style: normal; color: var(--dshe-text-3); }
.dshe-check { grid-column: 1 / -1; display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--dshe-text-2); }
.dshe-input, .dshe-select {
  width: 100%; height: 36px; padding: 0 12px; border: 0; border-radius: 10px; background: var(--dshe-fill-2); color: var(--dshe-text);
  font: inherit; font-size: 13.5px; transition: box-shadow 120ms ease, background-color 120ms ease;
}
.dshe-input::placeholder { color: var(--dshe-text-3); }
.dshe-input:focus { outline: none; background: var(--dshe-bg); box-shadow: 0 0 0 1.5px var(--dshe-accent); }
.dshe-input:disabled { opacity: 0.5; }
.dshe-form-note { font-size: 12px; color: var(--dshe-text-3); }
.dshe-form-error { font-size: 12.5px; color: var(--dshe-bad); }
.dshe-form-actions { display: flex; gap: 8px; }
@container (max-width: 700px) { .dshe-form-grid { grid-template-columns: 1fr 1fr; } }

/* ---------- bindings ---------- */
.dshe-table { display: flex; flex-direction: column; border-radius: 14px; background: var(--dshe-fill); padding: 4px 6px; }
.dshe-row { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 0.8fr) minmax(190px, 1fr) minmax(130px, auto); align-items: center; gap: 12px; padding: 9px 10px; border-radius: 10px; min-height: 48px; }
.dshe-row + .dshe-row { box-shadow: 0 -0.5px 0 var(--dshe-line); }
.dshe-row-head { min-height: 32px; padding-top: 6px; padding-bottom: 2px; color: var(--dshe-text-3); font-size: 12px; box-shadow: none !important; }
.dshe-row[data-kind="default"] { background: var(--dshe-accent-soft); box-shadow: none; }
.dshe-row[data-kind="default"] + .dshe-row { box-shadow: none; }
.dshe-host { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.dshe-host code { font-family: var(--dshe-mono); font-size: 12.5px; overflow-wrap: anywhere; }
.dshe-host strong { font-weight: 600; }
.dshe-host em { font-style: normal; color: var(--dshe-text-3); font-size: 12px; }
.dshe-seen { color: var(--dshe-text-3); font-size: 12px; }
.dshe-select { appearance: none; cursor: pointer; padding-right: 30px; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5l3 3 3-3' fill='none' stroke='%2381858c' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 10px center; }
.dshe-select option { background: var(--dshe-bg); color: var(--dshe-text); }
.dshe-row-end { display: flex; align-items: center; gap: 8px; justify-content: flex-end; }
.dshe-source { font-size: 12px; color: var(--dshe-text-3); }
.dshe-source[data-source="binding"] { color: var(--dshe-accent); font-weight: 500; }
.dshe-addhost { display: flex; gap: 8px; max-width: 460px; }
@container (max-width: 700px) {
  .dshe-row { grid-template-columns: 1fr 1fr; }
  .dshe-row-head { display: none; }
  .dshe-seen { order: 3; }
}

/* ---------- request log ---------- */
.dshe-log { list-style: none; margin: 0; padding: 4px 6px; border-radius: 14px; background: var(--dshe-fill); display: flex; flex-direction: column; }
.dshe-log li { display: grid; grid-template-columns: 8px minmax(0, 1.3fr) minmax(0, 0.9fr) minmax(0, 2fr) 40px; align-items: center; gap: 10px; padding: 7px 10px; font-size: 12.5px; }
.dshe-log li + li { box-shadow: 0 -0.5px 0 var(--dshe-line); }
.dshe-log code { font-family: var(--dshe-mono); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshe-log-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dshe-ok); }
.dshe-log li[data-ok="false"] .dshe-log-dot { background: var(--dshe-bad); }
.dshe-log-exit { color: var(--dshe-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshe-log-result { color: var(--dshe-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshe-log li[data-ok="false"] .dshe-log-result { color: var(--dshe-bad); }
.dshe-log-time { color: var(--dshe-text-3); text-align: right; }

@media (prefers-reduced-motion: reduce) { .dshe-btn, .dshe-exit, .dshe-input { transition: none; } }
`;
function installStyles() {
  if (typeof document === "undefined") return;
  const selector = `style[data-plugin-css=${JSON.stringify(STYLE_KEY)}]`;
  if (document.querySelector(selector) !== null) return;
  const tag = document.createElement("style");
  tag.dataset.plugin = "dsh-client-ui-egress";
  tag.dataset.pluginCss = STYLE_KEY;
  tag.textContent = EGRESS_CSS;
  document.head.appendChild(tag);
}

// src/client/index.ts
var PANEL_ID = "egress/panel";
var inject = ["slots", "locale"];
function optionalService(ctx, name) {
  const get = ctx.get;
  return typeof get === "function" ? get.call(ctx, name) : void 0;
}
function makePage(controller, t) {
  return function EgressPage() {
    return (0, import_react2.createElement)(EgressPanel, { controller, t });
  };
}
function apply(ctx) {
  installStyles();
  ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), "client-ui-egress: dictionaries");
  const t = ctx.locale.bind(NS);
  const sources = defaultSources();
  const controller = new EgressController(sources.host, sources.mock);
  ctx.effect(() => controller.start(), "client-ui-egress: first read and poll");
  const Page = makePage(controller, t);
  const layout = optionalService(ctx, "layout");
  ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: PANEL_ID, locale: NS }, Page));
  ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
    name: "sidebar.panellist",
    id: PANEL_ID,
    order: -30,
    locale: NS,
    label: () => t("panel.title")
  }, EgressIcon));
}

return module.exports}});
