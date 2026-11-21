window.__ModuleLoader__.load({id:"dsh-client-ui-router",factory:require=>{var module={exports:{}};var exports=module.exports;Object.defineProperty(exports,Symbol.toStringTag,{value:"Module"});
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
  TAB_ID: () => TAB_ID,
  TAB_KIND: () => TAB_KIND,
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);

// src/client/credentials.ts
var SOURCES = ["file", "env", "unset", "unknown"];
function asCredentialViews(refs, value) {
  if (typeof value !== "object" || value === null) return [];
  const record = value;
  const rows = [];
  for (const ref of refs) {
    const entry = record[ref];
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry;
    const source = SOURCES.find((item) => item === candidate.source);
    rows.push({
      ref,
      configured: candidate.configured === true,
      ...source === void 0 ? {} : { source },
      ...typeof candidate.writable === "boolean" ? { writable: candidate.writable } : {}
    });
  }
  return rows;
}

// src/client/controller.ts
var INITIAL = { board: null, status: "idle", publishing: false };
var RouterBoardController = class {
  /**
   * @param source - the board source this panel reads.
   * @param onChange - called after the source reports a Host-side change.
   */
  constructor(source, onChange) {
    this.source = source;
    this.onChange = onChange;
  }
  state = INITIAL;
  listeners = /* @__PURE__ */ new Set();
  inFlight = null;
  disposed = false;
  /** Attach to the source's change feed once, for the controller's lifetime. */
  start() {
    return this.source.subscribe(() => {
      if (this.disposed) return;
      this.onChange?.();
      void this.load();
    });
  }
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
  /** Stop accepting results from in-flight reads. */
  dispose() {
    this.disposed = true;
    this.listeners.clear();
  }
  emit(next) {
    if (this.disposed) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }
  /**
   * Read the board.
   *
   * Concurrent calls join the in-flight read: a burst of change events must not
   * become a burst of Host round-trips.
   * @returns completion of the read.
   */
  async load() {
    if (this.inFlight !== null) return this.inFlight;
    this.emit({ ...this.state, status: this.state.board === null ? "loading" : this.state.status });
    this.inFlight = (async () => {
      try {
        const board = await this.source.read();
        this.emit({ ...this.state, board, status: "ready", error: void 0 });
      } catch (error) {
        this.emit({
          ...this.state,
          status: "error",
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }
  /**
   * Publish demands, then re-read so the new tasks appear.
   * @param demands - one entry per submitted line.
   * @returns the routing result, or undefined on failure.
   */
  async publish(demands) {
    if (demands.length === 0) return void 0;
    this.emit({ ...this.state, publishing: true, error: void 0 });
    try {
      const result = await this.source.publish(demands);
      const board = await this.source.read();
      this.emit({ ...this.state, board, status: "ready", publishing: false, lastPublish: result });
      return result;
    } catch (error) {
      this.emit({
        ...this.state,
        publishing: false,
        error: error instanceof Error ? error.message : String(error)
      });
      return void 0;
    }
  }
  /**
   * Record a verification decision and re-read.
   * @param taskId - the reported task.
   * @param verdict - accept or send back.
   * @param note - rejection reason shown on the card.
   */
  async verify(taskId, verdict, note) {
    try {
      await this.source.verify(taskId, verdict, note);
      const board = await this.source.read();
      this.emit({ ...this.state, board, status: "ready", error: void 0 });
    } catch (error) {
      this.emit({ ...this.state, error: error instanceof Error ? error.message : String(error) });
    }
  }
  /** Whether the source can run `task_control` actions at all. */
  get canControl() {
    return typeof this.source.control === "function";
  }
  /**
   * Run one `task_control` action, then re-read the board.
   *
   * `resume` is applied optimistically: the row is moved to `running` in the
   * local snapshot before the request, so it leaves 已挂起 at once. A fresh read
   * (not a join of an older in-flight one) follows a success; a failure restores
   * the snapshot taken before the optimistic patch and re-reads.
   * @param taskId - the task.
   * @param action - the `task_control` action.
   * @param value - its optional `value`.
   * @returns undefined on success, else the human-readable failure.
   */
  async control(taskId, action, value) {
    const source = this.source;
    if (source.control === void 0) return "task_control is not wired on this source";
    const before = this.state.board;
    if (action === "resume" && before !== null) {
      this.emit({
        ...this.state,
        board: {
          ...before,
          tasks: before.tasks.map((task) => task.id !== taskId ? task : {
            ...task,
            state: "running",
            hostState: "running",
            resumeNote: void 0
          })
        }
      });
    }
    try {
      await source.control(taskId, action, value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (before !== null) this.emit({ ...this.state, board: before });
      void this.load();
      return message;
    }
    try {
      if (this.inFlight !== null) await this.inFlight;
      const board = await source.read();
      this.emit({ ...this.state, board, status: "ready", error: void 0 });
    } catch {
    }
    return void 0;
  }
  /** Clear the publish banner after the view has shown it. */
  clearPublishNotice() {
    if (this.state.lastPublish === void 0) return;
    this.emit({ ...this.state, lastPublish: void 0 });
  }
};

// src/client/RouterPanelTitle.tsx
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
function RouterPanelTitle({ controller, t }) {
  const state = (0, import_react.useSyncExternalStore)(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const awaiting = (state.board?.tasks ?? []).filter((task) => task.state === "reported").length;
  const running = (state.board?.tasks ?? []).filter((task) => task.state === "running").length;
  const suffix = awaiting > 0 ? ` \xB7 ${awaiting}` : running > 0 ? ` \xB7 ${running}` : "";
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_jsx_runtime.Fragment, { children: `${t("panel.title")}${suffix}` });
}

// src/client/RouterPanelButton.tsx
var import_react2 = require("react");
var import_jsx_runtime2 = require("react/jsx-runtime");
function RouterPanelButton({ controller, t, open }) {
  const state = (0, import_react2.useSyncExternalStore)(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const tasks = state.board?.tasks ?? [];
  const awaiting = tasks.filter((task) => task.state === "reported").length;
  const running = tasks.filter((task) => task.state === "running").length;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
    "button",
    {
      type: "button",
      className: "dshr-btn",
      onClick: open,
      title: t("panel.title"),
      "aria-label": t("panel.title"),
      "data-router-entry": true,
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { "aria-hidden": "true", children: "\u25A4" }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: t("panel.title") }),
        awaiting > 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshr-tab-count", "data-tone": "warn", title: t("lane.reported"), children: awaiting }),
        awaiting === 0 && running > 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshr-tab-count", title: t("lane.running"), children: running })
      ]
    }
  );
}

// src/client/Brand.tsx
var import_jsx_runtime3 = require("react/jsx-runtime");
var PRODUCT_NAME = "Team";
function BrandMark({ size = 20 }) {
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("svg", { width: size, height: size, viewBox: "0 0 20 20", fill: "none", "aria-hidden": "true", children: [
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("rect", { x: "2", y: "11", width: "3.4", height: "7", rx: "1.2", fill: "currentColor", opacity: "0.5" }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("rect", { x: "8.3", y: "7", width: "3.4", height: "11", rx: "1.2", fill: "currentColor", opacity: "0.75" }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("rect", { x: "14.6", y: "2", width: "3.4", height: "16", rx: "1.2", fill: "currentColor" })
  ] });
}
function BrandName(_props) {
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { style: { fontSize: 13, fontWeight: 650, letterSpacing: "0.02em" }, children: PRODUCT_NAME });
}

// src/client/RoutingIcon.tsx
var import_jsx_runtime4 = require("react/jsx-runtime");
function RoutingIcon({ size = 18, active = false }) {
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 18 18",
      fill: "none",
      "aria-hidden": "true",
      style: { opacity: active ? 1 : 0.72 },
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("rect", { x: "2", y: "3", width: "14", height: "3.2", rx: "1.2", fill: "currentColor" }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("rect", { x: "2", y: "7.6", width: "10", height: "3.2", rx: "1.2", fill: "currentColor", opacity: "0.72" }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("rect", { x: "2", y: "12.2", width: "6.5", height: "3.2", rx: "1.2", fill: "currentColor", opacity: "0.45" })
      ]
    }
  );
}

// src/client/CompactBoard.tsx
var import_react3 = require("react");

// src/client/format.ts
function relativeTime(iso, now = Date.now()) {
  if (iso === void 0) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1e3));
  if (seconds < 45) return "\u521A\u521A";
  if (seconds < 3600) return `${Math.round(seconds / 60)} \u5206\u949F\u524D`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} \u5C0F\u65F6\u524D`;
  return `${Math.round(seconds / 86400)} \u5929\u524D`;
}
function clockTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(void 0, { hour12: false });
}
function duration(seconds) {
  if (seconds === void 0) return "";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest === 0 ? `${minutes}m` : `${minutes}m${rest}s`;
}

// src/client/native-todos.ts
var EMPTY = Object.freeze({ projectionsBySession: {} });
var NO_SESSIONS = {
  list: {
    getSnapshot: () => EMPTY,
    subscribe: () => () => {
    }
  }
};
function asTodos(value) {
  if (!Array.isArray(value)) return void 0;
  const items = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return void 0;
    const candidate = entry;
    if (typeof candidate.content !== "string") return void 0;
    if (candidate.status !== "pending" && candidate.status !== "in_progress" && candidate.status !== "completed") return void 0;
    items.push({ content: candidate.content, status: candidate.status });
  }
  return items;
}
function todosOf(snapshot, sessionId) {
  if (sessionId === void 0) return void 0;
  return asTodos(snapshot.projectionsBySession?.[sessionId]?.values?.todos);
}

// src/client/styles.ts
var STYLE_KEY = "dsh-client-ui-router/RouterPanel.css";
var ROUTER_CSS = `
.dshr-panel {
  --dshr-text: var(--dsw-alias-label-primary, #0f1115);
  --dshr-text-2: var(--dsw-alias-label-secondary, #61666b);
  --dshr-text-3: var(--dsw-alias-label-tertiary, #81858c);
  --dshr-line: var(--dsw-alias-border-l, #e1e5ee);
  --dshr-fill: var(--dsw-alias-bg-layer-1, #f9fafb);
  --dshr-fill-2: var(--dsw-alias-bg-layer-2, #f5f7fa);
  --dshr-hover: var(--dsw-alias-interactive-bg-hover, rgba(15, 17, 21, 0.05));
  --dshr-ok: var(--dsw-alias-state-success-primary, #22c55e);
  --dshr-warn: var(--dsw-alias-state-warn-primary, #f59e0b);
  --dshr-busy: var(--dsw-alias-state-business-primary, #4176e6);
  --dshr-bad: var(--dsw-alias-state-error-primary, #ec1313);
  --dshr-idle: var(--dsw-alias-state-idle-primary, #d4d4d4);
  --dshr-radius-sm: var(--dsw-radius-sm, 6px);
  --dshr-radius-md: var(--dsw-radius-md, 8px);
  --dshr-radius-lg: var(--dsw-radius-lg, 12px);
  --dshr-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --dshr-rail-w: 212px;

  container-type: inline-size;
  display: flex;
  box-sizing: border-box;
  min-height: 0;
  height: 100%;
  color: var(--dshr-text);
  font-size: 13px;
  line-height: 20px;
  text-align: left;
}

.dshr-panel *,
.dshr-panel *::before,
.dshr-panel *::after { box-sizing: border-box; }

.dshr-fill { flex: 1 1 auto; min-width: 0; }
.dshr-sep { opacity: 0.5; }
.dshr-mono { font-family: var(--dshr-mono); font-size: 11px; }
.dshr-ellipsis { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---------- scroll surfaces ---------- */

.dshr-scroll,
.dshr-rail-scroll,
.dshr-todos { overscroll-behavior: contain; }

.dshr-scroll::-webkit-scrollbar,
.dshr-rail-scroll::-webkit-scrollbar,
.dshr-todos::-webkit-scrollbar { width: 8px; height: 8px; }
.dshr-scroll::-webkit-scrollbar-thumb,
.dshr-rail-scroll::-webkit-scrollbar-thumb,
.dshr-todos::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: 999px;
  background-clip: content-box;
  background-color: var(--dsw-alias-scrollbar-bg-l1, rgba(15, 17, 21, 0.14));
}
.dshr-scroll::-webkit-scrollbar-thumb:hover,
.dshr-rail-scroll::-webkit-scrollbar-thumb:hover,
.dshr-todos::-webkit-scrollbar-thumb:hover {
  background-color: var(--dsw-alias-scrollbar-hover-l1, rgba(15, 17, 21, 0.28));
}
.dshr-scroll::-webkit-scrollbar-track,
.dshr-rail-scroll::-webkit-scrollbar-track,
.dshr-todos::-webkit-scrollbar-track { background: transparent; }

/* ---------- buttons ---------- */

.dshr-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--dshr-line);
  border-radius: var(--dshr-radius-sm);
  background: transparent;
  color: var(--dshr-text-2);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
}
.dshr-btn:hover { background: var(--dshr-hover); color: var(--dshr-text); }
.dshr-btn:focus-visible { outline: 2px solid var(--dshr-busy); outline-offset: 1px; }
.dshr-btn[disabled] { opacity: 0.55; cursor: default; }
.dshr-btn[data-tone="primary"] {
  border-color: transparent;
  background: var(--dshr-busy);
  color: var(--dsw-alias-label-primary-foreground, #fff);
  font-weight: 500;
}
.dshr-btn[data-tone="primary"]:hover { background: color-mix(in srgb, var(--dshr-busy) 88%, #000); }
.dshr-btn[data-tone="ok"] { border-color: color-mix(in srgb, var(--dshr-ok) 45%, transparent); color: var(--dshr-ok); }
.dshr-btn[data-tone="ok"]:hover { background: color-mix(in srgb, var(--dshr-ok) 12%, transparent); }
.dshr-btn[data-tone="bad"] { border-color: color-mix(in srgb, var(--dshr-bad) 40%, transparent); color: var(--dshr-bad); }
.dshr-btn[data-tone="bad"]:hover { background: color-mix(in srgb, var(--dshr-bad) 10%, transparent); }
.dshr-btn[data-size="xs"] { height: 20px; padding: 0 6px; font-size: 11.5px; line-height: 16px; }

.dshr-icon-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--dshr-radius-sm);
  background: transparent;
  color: var(--dshr-text-2);
  font: inherit;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.dshr-icon-btn:hover { background: var(--dshr-hover); color: var(--dshr-text); }
.dshr-icon-btn:focus-visible { outline: 2px solid var(--dshr-busy); outline-offset: 1px; }
.dshr-icon-btn[data-open="plus"] { font-size: 16px; }
.dshr-icon-btn[data-open="plus"][aria-expanded="true"],
.dshr-icon-btn[data-open="plus"]:hover { border-color: var(--dshr-line); background: var(--dshr-fill); }

/* ---------- badges ---------- */

.dshr-badge {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 15px;
  padding: 0 4px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--dshr-text-3) 16%, transparent);
  color: var(--dshr-text-2);
  font-size: 10.5px;
  line-height: 15px;
  font-variant-numeric: tabular-nums;
}
.dshr-badge[data-tone="warn"] { background: color-mix(in srgb, var(--dshr-warn) 16%, transparent); color: var(--dshr-warn); }
.dshr-badge[data-tone="ok"] { background: color-mix(in srgb, var(--dshr-ok) 16%, transparent); color: var(--dshr-ok); }
.dshr-badge[data-tone="busy"] { background: color-mix(in srgb, var(--dshr-busy) 14%, transparent); color: var(--dshr-busy); }
.dshr-badge[data-tone="bad"] { background: color-mix(in srgb, var(--dshr-bad) 12%, transparent); color: var(--dshr-bad); }

/* ---------- presence dots ---------- */

.dshr-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dshr-idle);
}
.dshr-dot[data-presence="online"] { background: var(--dshr-ok); }
.dshr-dot[data-presence="busy"] { background: var(--dshr-busy); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dshr-busy) 20%, transparent); }
.dshr-dot[data-presence="offline"] { background: var(--dshr-text-3); }
.dshr-dot[data-presence="released"] { background: transparent; box-shadow: inset 0 0 0 1px var(--dshr-text-3); }

/* ---------- rail ---------- */

.dshr-rail {
  display: none;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: transparent;
}

.dshr-panel[data-rail="open"] .dshr-rail { display: flex; flex: 1 1 auto; }
.dshr-panel[data-rail="open"] .dshr-main { display: none; }

/* A closed rail stays in the DOM but out of layout, tab order and a11y tree. */
.dshr-rail[hidden] { display: none !important; }

.dshr-rail-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 8px 6px 12px;
  min-width: 0;
}
.dshr-rail-title {
  font-size: 11.5px;
  line-height: 16px;
  letter-spacing: 0.04em;
  color: var(--dshr-text-3);
  white-space: nowrap;
}
.dshr-rail-count {
  color: var(--dshr-text-3);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.dshr-rail-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0 6px 8px;
}

.dshr-project-all {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 26px;
  padding: 0 6px;
  border: 0;
  border-radius: var(--dshr-radius-sm);
  background: transparent;
  color: var(--dshr-text-2);
  font: inherit;
  font-size: 12.5px;
  line-height: 18px;
  text-align: left;
  cursor: pointer;
}
.dshr-project-all:hover { background: var(--dshr-hover); }
.dshr-project-all[data-on="true"] { background: var(--dshr-fill); color: var(--dshr-text); font-weight: 500; }
.dshr-project-all > .dshr-project-name { flex: 1 1 auto; }
.dshr-caret {
  flex: none;
  width: 8px;
  color: var(--dshr-text-3);
  font-size: 9px;
  line-height: 1;
}
.dshr-project-all[data-on="true"] > .dshr-caret { color: var(--dshr-text); }

.dshr-projects {
  list-style: none;
  margin: 1px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.dshr-project { min-width: 0; }

.dshr-project-row {
  display: flex;
  align-items: center;
  gap: 2px;
  border-radius: var(--dshr-radius-sm);
}
.dshr-project-row:hover { background: var(--dshr-hover); }
.dshr-project[data-on="true"] > .dshr-project-row { background: var(--dshr-fill); }

.dshr-project-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 4px 2px 4px 6px;
  border: 0;
  border-radius: var(--dshr-radius-sm);
  background: transparent;
  color: var(--dshr-text-2);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dshr-project-main:focus-visible { outline: 2px solid var(--dshr-busy); outline-offset: -2px; }

.dshr-project-line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.dshr-project-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  line-height: 18px;
  font-weight: 500;
}
.dshr-project[data-on="true"] .dshr-project-name { color: var(--dshr-text); }
.dshr-project-count {
  flex: none;
  color: var(--dshr-text-3);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.dshr-project-sub {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dshr-text-3);
  font-size: 11px;
  line-height: 15px;
}
.dshr-project-off {
  flex: none;
  padding: 0 4px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--dshr-text-3) 14%, transparent);
  color: var(--dshr-text-3);
  font-size: 10px;
  line-height: 14px;
  white-space: nowrap;
}
/* A partition the router does not dispatch into reads muted, not struck out. */
.dshr-project[data-off="true"] .dshr-project-name { color: var(--dshr-text-3); font-weight: 400; }

.dshr-switch {
  flex: none;
  position: relative;
  width: 24px;
  height: 14px;
  margin-right: 4px;
  padding: 0;
  border: 1px solid var(--dshr-line);
  border-radius: 999px;
  background: color-mix(in srgb, var(--dshr-text-3) 18%, transparent);
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.dshr-switch[data-on="true"] { background: var(--dshr-ok); border-color: transparent; }
.dshr-switch[data-wired="false"] { opacity: 0.55; }
.dshr-switch:focus-visible { outline: 2px solid var(--dshr-busy); outline-offset: 1px; }
.dshr-switch-knob {
  position: absolute;
  top: 1px;
  left: 1px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--dsw-alias-label-primary-foreground, #fff);
  transition: transform 120ms ease;
}
.dshr-switch[data-on="true"] > .dshr-switch-knob { transform: translateX(10px); }

.dshr-workers {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  padding: 0 6px 5px 22px;
}
.dshr-worker {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 0 5px;
  border: 1px solid var(--dshr-line);
  border-radius: 999px;
  color: var(--dshr-text-2);
  font-size: 11px;
  line-height: 15px;
  background: transparent;
}
.dshr-worker > .dshr-worker-name { white-space: nowrap; }
.dshr-worker > .dshr-worker-what {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dshr-text-3);
  font-family: var(--dshr-mono);
  font-size: 10.5px;
}
/* A released worker holds no machine: dashed border + muted text says so. */
.dshr-worker[data-presence="released"] { border-style: dashed; color: var(--dshr-text-3); }
.dshr-worker[data-presence="released"] > .dshr-worker-what { font-family: inherit; }
.dshr-worker[data-presence="offline"] { opacity: 0.6; }

.dshr-rail-new {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 26px;
  margin-top: 2px;
  padding: 0 6px;
  border: 0;
  border-radius: var(--dshr-radius-sm);
  background: transparent;
  color: var(--dshr-text-3);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
  text-align: left;
}
.dshr-rail-new:hover { background: var(--dshr-hover); color: var(--dshr-text); }
.dshr-rail-new > span:first-child { font-size: 13px; line-height: 1; }

.dshr-create {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 2px 2px;
}
.dshr-create-input { min-height: 0; height: 24px; padding: 0 6px; font-size: 12px; }

/* ---------- API key block ---------- */

.dshr-keys {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 8px 10px 10px;
  border-top: 1px solid var(--dshr-line);
}
.dshr-rail-label {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0 2px 3px;
  color: var(--dshr-text-3);
  font-size: 11px;
  line-height: 16px;
  letter-spacing: 0.04em;
}

.dshr-key-block { display: flex; flex-direction: column; gap: 3px; }

.dshr-key {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  min-width: 0;
  padding: 1px 2px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--dshr-text-2);
  font: inherit;
  text-align: left;
}
button.dshr-key { cursor: pointer; }
button.dshr-key:hover { background: var(--dshr-hover); }
button.dshr-key:focus-visible { outline: 2px solid var(--dshr-busy); outline-offset: 1px; }

.dshr-key-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--dshr-text-3);
}
.dshr-key-dot[data-on="true"] { background: var(--dshr-ok); box-shadow: none; }

.dshr-key-ref {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--dshr-mono);
  font-size: 10.5px;
  line-height: 16px;
  color: var(--dshr-text-2);
}
.dshr-key-state { flex: none; font-size: 10.5px; line-height: 16px; color: var(--dshr-text-3); }
.dshr-key-state[data-on="true"] { color: var(--dshr-text-2); }

.dshr-key-empty,
.dshr-key-where {
  padding: 1px 2px;
  color: var(--dshr-text-3);
  font-size: 10.5px;
  line-height: 15px;
}
.dshr-key-where { padding-top: 3px; }
.dshr-key-input { min-height: 0; height: 24px; padding: 0 6px; font-size: 11.5px; }
.dshr-key-actions { display: flex; gap: 4px; }
.dshr-key-error { padding: 0 2px; color: var(--dshr-bad); font-size: 10.5px; line-height: 15px; overflow-wrap: anywhere; }
.dshr-key-ok { padding: 0 2px; color: var(--dshr-ok); font-size: 10.5px; line-height: 15px; }

.dshr-rail-note {
  flex: none;
  margin: 0 10px 10px;
  padding: 5px 6px;
  border-radius: var(--dshr-radius-sm);
  background: var(--dshr-fill-2);
  color: var(--dshr-text-2);
  font-size: 11px;
  line-height: 15px;
}

/* ---------- task column ---------- */

.dshr-main {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.dshr-main-bare { padding: 12px; gap: 8px; }

.dshr-main-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 10px 0 12px;
  min-width: 0;
}
.dshr-main-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
  letter-spacing: 0.01em;
  white-space: nowrap;
}

.dshr-main-sub {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 1px 10px 0 12px;
  color: var(--dshr-text-3);
  font-size: 11px;
  line-height: 16px;
  min-width: 0;
}
.dshr-stamp { flex: none; font-family: var(--dshr-mono); font-size: 10.5px; }
.dshr-origin {
  flex: none;
  padding: 0 4px;
  border: 1px solid var(--dshr-line);
  border-radius: 4px;
  color: var(--dshr-text-3);
  font-size: 10.5px;
  line-height: 15px;
}
.dshr-origin[data-tone="bad"] { color: var(--dshr-bad); border-color: color-mix(in srgb, var(--dshr-bad) 45%, transparent); }

.dshr-notice {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 6px 10px 0 12px;
  padding: 5px 8px;
  border-radius: var(--dshr-radius-sm);
  background: var(--dshr-fill-2);
  color: var(--dshr-text-2);
  font-size: 11px;
  line-height: 15px;
}
.dshr-notice[data-tone="bad"] { color: var(--dshr-bad); }

/* ---------- composer drawer ---------- */

.dshr-drawer { flex: none; border-bottom: 1px solid var(--dshr-line); }
.dshr-composer {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 8px 10px 8px 12px;
}
.dshr-label { color: var(--dshr-text-3); font-size: 11px; line-height: 16px; }

.dshr-input {
  width: 100%;
  min-height: 48px;
  max-height: 132px;
  padding: 5px 7px;
  border: 1px solid var(--dshr-line);
  border-radius: var(--dshr-radius-sm);
  background: var(--dshr-fill);
  color: var(--dshr-text);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  resize: vertical;
}
.dshr-input::placeholder { color: var(--dshr-text-3); }
.dshr-input:focus-visible { outline: none; border-color: var(--dshr-busy); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dshr-busy) 18%, transparent); }

.dshr-composer-foot { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dshr-composer-foot > .dshr-hint {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dshr-text-3);
  font-size: 10.5px;
  line-height: 15px;
}

/* ---------- tabs ---------- */

.dshr-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  padding: 8px 10px 0 12px;
}
.dshr-tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: var(--dshr-radius-sm);
  background: transparent;
  color: var(--dshr-text-2);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
  white-space: nowrap;
}
.dshr-tab:hover { background: var(--dshr-hover); }
.dshr-tab:focus-visible { outline: 2px solid var(--dshr-busy); outline-offset: 1px; }
.dshr-tab[aria-selected="true"] {
  border-color: var(--dshr-line);
  background: var(--dshr-fill);
  color: var(--dshr-text);
  font-weight: 500;
}
.dshr-tab-count {
  padding: 0 4px;
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 12%, transparent);
  font-size: 10.5px;
  line-height: 15px;
  font-variant-numeric: tabular-nums;
}
.dshr-tab[data-tone="warn"][data-has="true"] .dshr-tab-count { color: var(--dshr-warn); background: color-mix(in srgb, var(--dshr-warn) 16%, transparent); }
.dshr-tab[data-tone="ok"][data-has="true"] .dshr-tab-count { color: var(--dshr-ok); background: color-mix(in srgb, var(--dshr-ok) 16%, transparent); }
.dshr-tab[data-has="false"] .dshr-tab-count { opacity: 0.45; }

.dshr-tab-hint {
  padding: 2px 10px 0 12px;
  color: var(--dshr-text-3);
  font-size: 10.5px;
  line-height: 15px;
}

/* ---------- sections ---------- */

.dshr-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 8px 16px 10px;
}

.dshr-section {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  padding-top: 8px;
}
.dshr-section + .dshr-section { margin-top: 6px; }
/* The hidden attribute must beat the display above: closed tabs are out of the
   accessibility tree, not merely invisible. */
.dshr-section[hidden] { display: none; }

.dshr-section-head {
  display: flex;
  align-items: baseline;
  gap: 5px;
  padding: 0 4px 3px;
  border-bottom: 1px solid var(--dshr-line);
  min-width: 0;
  flex-wrap: nowrap;
}
.dshr-section-title {
  font-size: 11.5px;
  font-weight: 600;
  line-height: 16px;
  color: var(--dshr-text-2);
  white-space: nowrap;
}
.dshr-section[data-tone="warn"] > .dshr-section-head > .dshr-section-title { color: var(--dshr-warn); }
.dshr-section[data-tone="bad"] > .dshr-section-head > .dshr-section-title { color: var(--dshr-bad); }
.dshr-section-hint {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dshr-text-3);
  font-size: 10.5px;
  line-height: 15px;
}

.dshr-empty {
  padding: 8px 4px;
  color: var(--dshr-text-3);
  font-size: 11.5px;
  line-height: 16px;
}

/* ---------- task row ---------- */

.dshr-task {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-radius: var(--dshr-radius-sm);
}
.dshr-task[data-open="true"] { background: var(--dshr-fill); }

.dshr-task-row {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  width: 100%;
  min-width: 0;
  padding: 4px 6px;
  border: 0;
  border-radius: var(--dshr-radius-sm);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dshr-task-row:hover { background: var(--dshr-hover); }
.dshr-task[data-open="true"] > .dshr-task-row:hover { background: transparent; }
.dshr-task-row:focus-visible { outline: 2px solid var(--dshr-busy); outline-offset: -2px; }

/* State ring: the only place state is carried by shape as well as colour. */
.dshr-ring {
  flex: none;
  position: relative;
  width: 13px;
  height: 13px;
  margin-top: 3px;
  border: 1.5px solid var(--dshr-text-3);
  border-radius: 50%;
}
.dshr-ring[data-state="queued"] { border-color: color-mix(in srgb, var(--dshr-text-3) 70%, transparent); }
.dshr-ring[data-state="running"] { border-color: var(--dshr-busy); }
.dshr-ring[data-state="running"]::after {
  content: "";
  position: absolute;
  inset: 2.5px;
  border-radius: 50%;
  background: var(--dshr-busy);
}
.dshr-ring[data-state="reported"] { border-color: var(--dshr-warn); border-style: dashed; }
.dshr-ring[data-state="reported"]::after {
  content: "";
  position: absolute;
  inset: 3.5px;
  border-radius: 50%;
  background: var(--dshr-warn);
  opacity: 0.7;
}
.dshr-ring[data-state="verified"] {
  border-color: var(--dshr-ok);
  background: var(--dshr-ok);
}
.dshr-ring[data-state="verified"]::after {
  content: "";
  position: absolute;
  left: 3.5px;
  top: 1px;
  width: 3px;
  height: 6px;
  border: solid var(--dsw-alias-label-primary-foreground, #fff);
  border-width: 0 1.5px 1.5px 0;
  transform: rotate(45deg);
}
.dshr-ring[data-state="rejected"] { border-color: var(--dshr-bad); }
.dshr-ring[data-state="rejected"]::before,
.dshr-ring[data-state="rejected"]::after {
  content: "";
  position: absolute;
  left: 50%;
  top: 50%;
  width: 6px;
  height: 1.5px;
  border-radius: 1px;
  background: var(--dshr-bad);
}
.dshr-ring[data-state="rejected"]::before { transform: translate(-50%, -50%) rotate(45deg); }
.dshr-ring[data-state="rejected"]::after { transform: translate(-50%, -50%) rotate(-45deg); }

.dshr-task-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12.5px;
  line-height: 18px;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.dshr-task[data-tone="warn"] > .dshr-task-row > .dshr-task-title { color: var(--dshr-text); }
.dshr-task[data-tone="ok"] > .dshr-task-row > .dshr-task-title { color: var(--dshr-text-2); }

.dshr-task-prog {
  flex: none;
  color: var(--dshr-text-3);
  font-family: var(--dshr-mono);
  font-size: 10.5px;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
}

/* ---------- task detail ---------- */

.dshr-task-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 2px 8px 8px 26px;
  min-width: 0;
  /* A checklist is read as a column, not as a line across a 760px panel. */
  max-width: 620px;
}
.dshr-task-body[hidden] { display: none; }

.dshr-task-meta {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
  color: var(--dshr-text-3);
  font-size: 10.5px;
  line-height: 15px;
}
.dshr-chip {
  flex: none;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 10.5px;
  line-height: 16px;
  white-space: nowrap;
  color: var(--dshr-text-2);
  background: color-mix(in srgb, currentColor 10%, transparent);
}
.dshr-chip[data-tone="busy"] { color: var(--dshr-busy); }
.dshr-chip[data-tone="warn"] { color: var(--dshr-warn); }
.dshr-chip[data-tone="ok"] { color: var(--dshr-ok); }
.dshr-chip[data-tone="bad"] { color: var(--dshr-bad); }

/* ---------- checklist ---------- */

.dshr-todos {
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: 168px;
  overflow-y: auto;
  padding: 3px 0 1px;
  border-top: 1px dashed var(--dshr-line);
}

.dshr-todo-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  color: var(--dshr-text-2);
  font-size: 11px;
  line-height: 15px;
}
.dshr-todo-head > .dshr-progress {
  flex: 0 1 72px;
  height: 3px;
  min-width: 24px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--dshr-text-3) 22%, transparent);
  overflow: hidden;
}
.dshr-progress > i {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--dshr-busy);
}
.dshr-task[data-tone="ok"] .dshr-progress > i { background: var(--dshr-ok); }
.dshr-task[data-tone="warn"] .dshr-progress > i { background: var(--dshr-warn); }
.dshr-todo-head > .dshr-count {
  font-variant-numeric: tabular-nums;
  font-family: var(--dshr-mono);
  font-size: 10.5px;
  color: var(--dshr-text-3);
}

.dshr-todo {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 1px 0;
  font-size: 11.5px;
  line-height: 16px;
  color: var(--dshr-text-2);
  min-width: 0;
}
.dshr-todo > .dshr-todo-text { min-width: 0; overflow-wrap: anywhere; }
.dshr-todo[data-status="completed"] > .dshr-todo-text { color: var(--dshr-text-3); }
.dshr-todo[data-status="in_progress"] > .dshr-todo-text { color: var(--dshr-text); font-weight: 500; }

/* Checklist box, drawn rather than typed: crisp at 12px in both themes. */
.dshr-mark {
  flex: none;
  position: relative;
  width: 11px;
  height: 11px;
  margin-top: 2px;
  border: 1px solid var(--dshr-text-3);
  border-radius: 3px;
}
.dshr-todo[data-status="completed"] > .dshr-mark { border-color: var(--dshr-ok); background: var(--dshr-ok); }
.dshr-todo[data-status="completed"] > .dshr-mark::after {
  content: "";
  position: absolute;
  left: 2.5px;
  top: 0;
  width: 3px;
  height: 6px;
  border: solid var(--dsw-alias-label-primary-foreground, #fff);
  border-width: 0 1.5px 1.5px 0;
  transform: rotate(45deg);
}
.dshr-todo[data-status="in_progress"] > .dshr-mark { border-color: var(--dshr-busy); border-radius: 50%; }
.dshr-todo[data-status="in_progress"] > .dshr-mark::after {
  content: "";
  position: absolute;
  inset: 1.5px;
  border-radius: 50%;
  background: var(--dshr-busy);
}

.dshr-current {
  display: flex;
  gap: 5px;
  padding: 1px 0;
  color: var(--dshr-busy);
  font-size: 11px;
  line-height: 15px;
  min-width: 0;
}
.dshr-current > .dshr-current-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- task actions + artifacts ---------- */

.dshr-task-actions {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}

.dshr-reject-note {
  padding: 4px 6px;
  border-radius: var(--dshr-radius-sm);
  background: color-mix(in srgb, var(--dshr-bad) 9%, transparent);
  color: var(--dshr-bad);
  font-size: 11px;
  line-height: 15px;
  overflow-wrap: anywhere;
}

.dshr-artifacts { display: flex; flex-wrap: wrap; gap: 4px; }
.dshr-artifact {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 0 6px;
  border: 1px solid var(--dshr-line);
  border-radius: var(--dshr-radius-sm);
  background: transparent;
  color: var(--dshr-text-2);
  font: inherit;
  font-size: 10.5px;
  line-height: 18px;
  cursor: pointer;
  text-decoration: none;
}
.dshr-artifact:hover { background: var(--dshr-hover); color: var(--dshr-text); }
.dshr-artifact > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---------- wide: rail and list side by side ---------- */

@container (min-width: 660px) {
  /* Closed by default even when wide: only an open rail takes a column. */
  .dshr-panel[data-rail="open"] .dshr-rail {
    display: flex;
    flex: 0 0 var(--dshr-rail-w);
    width: var(--dshr-rail-w);
    border-right: 1px solid var(--dshr-line);
  }
  .dshr-panel[data-rail="open"] .dshr-main { display: flex; }
  .dshr-rail-close { display: none; }
  .dshr-main-head { padding: 12px 12px 0 14px; }
  .dshr-main-sub { padding: 1px 12px 0 14px; }
  .dshr-tabs { padding: 10px 12px 0 14px; }
  .dshr-tab-hint { padding: 2px 12px 0 14px; }
  .dshr-scroll { padding: 6px 12px 20px 12px; }
  .dshr-task-row { padding: 5px 8px; }
  .dshr-task-body { padding: 2px 10px 9px 28px; }
  .dshr-rail-head { padding: 12px 8px 6px 12px; }
}

/* ---------- the Routing page ---------- */

/* The board promoted to a page. At window width the rail plus task column would
   stretch into a very long line, so the page centres a column and lets the
   panel's own container queries choose the layout inside it. */
.dshr-page {
  height: 100%;
  min-height: 0;
  display: flex;
  justify-content: center;
  padding: 20px 24px;
  overflow: hidden;
}
.dshr-page > .dshr-panel {
  width: 100%;
  max-width: 880px;
  min-height: 0;
  height: 100%;
  border: 1px solid var(--dshr-line);
  border-radius: var(--dshr-radius-lg);
  background: var(--dshr-fill);
  overflow: hidden;
}

/* ---------- header, tabs, section heads (2026-11-19 pass, Duet-like) ---------- */

/* The head is an app bar: title and actions, one hairline, nothing between. */
.dshr-main-head {
  padding: 10px 10px 8px 10px;
  border-bottom: 1px solid var(--dshr-line);
}
.dshr-main-title { font-size: 14px; font-weight: 600; }
.dshr-main-sub { padding: 6px 12px 0; font-size: 10.5px; gap: 6px; }

/* Plain text tabs, selected one filled. A track behind four words draws a box
   that carries no information and eats the width of the words inside it. */
.dshr-tabs {
  gap: 4px;
  margin: 8px 8px 0;
  padding: 0;
  background: transparent;
  flex-wrap: nowrap;
}
.dshr-tab {
  flex: 0 0 auto;
  height: 28px;
  padding: 0 10px;
  border: none;
  border-radius: var(--dshr-radius-sm);
  color: var(--dshr-text-2);
  font-weight: 400;
}
.dshr-tab:hover { background: var(--dshr-hover); color: var(--dshr-text); }
.dshr-tab[aria-selected="true"] {
  background: var(--dshr-fill);
  border: none;
  box-shadow: none;
  color: var(--dshr-text);
  font-weight: 500;
}
.dshr-tab-count {
  min-width: 0;
  padding: 0;
  background: none;
  border: none;
  color: var(--dshr-text-3);
  font-variant-numeric: tabular-nums;
}
.dshr-tab[aria-selected="true"] .dshr-tab-count { color: var(--dshr-text-2); }

/* A section head is a label, not a card header: name, count, nothing else. */
.dshr-section-head {
  align-items: baseline;
  gap: 6px;
  padding: 12px 12px 4px;
  border-bottom: none;
}
.dshr-section-title { font-size: 12.5px; font-weight: 500; color: var(--dshr-text-2); }
.dshr-section-count { font-size: 12.5px; color: var(--dshr-text-3); font-variant-numeric: tabular-nums; }
.dshr-section-head .dshr-badge { display: none; }

/* One row is one clickable line: icon, title, air. Detail lives behind the click. */
.dshr-task-row { min-height: 40px; padding: 8px 12px; }

/* The checklist is a block of its own under the meta line; without a gap the two
   read as one run-on sentence. */
.dshr-todo-head {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--dshr-line);
}

/* Header actions are icon-sized: at 420px a text button next to a "+" read as
   two different weights of the same thing. */
.dshr-icon-btn[disabled] { opacity: 0.45; cursor: default; }
.dshr-stamp { font-variant-numeric: tabular-nums; }

/* A closed row is clickable, so it says so on hover; an open one already has a
   fill and must not change under the pointer. */
.dshr-task:not([data-open="true"]):hover { background: var(--dshr-hover); }

/* ---------- 2026-11-19 usability pass ---------- */

/* Row aside: partition, progress, age. Hidden in the docked Sidebar, shown as
   aligned columns once the panel is wide enough to read them in one line. */
.dshr-task-aside { display: none; }
.dshr-task-row { align-items: center; }
.dshr-ring { margin-top: 0; }
.dshr-btn-label { display: none; }

/* Tabs read as an underline strip on one hairline, not floating pills. */
.dshr-tabs {
  margin: 0;
  padding: 0 8px;
  gap: 0;
  border-bottom: 1px solid var(--dshr-line);
}
.dshr-tab {
  position: relative;
  height: 34px;
  padding: 0 10px;
  border-radius: 0;
  background: transparent;
}
.dshr-tab:hover { background: transparent; color: var(--dshr-text); }
.dshr-tab[aria-selected="true"] { background: transparent; }
.dshr-tab[aria-selected="true"]::after {
  content: "";
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: -1px;
  height: 2px;
  border-radius: 1px;
  background: var(--dshr-text);
}
.dshr-tab[data-tone="warn"][data-has="true"] .dshr-tab-count { color: var(--dshr-warn); background: none; font-weight: 600; }
.dshr-tab[data-tone="ok"][data-has="true"] .dshr-tab-count { background: none; }

.dshr-main-sub { padding: 8px 12px 6px; }
.dshr-section-head { padding: 14px 12px 6px; }
.dshr-section-title { font-weight: 600; }
.dshr-task-title { font-size: 13px; line-height: 20px; }
.dshr-task-row { min-height: 38px; padding: 8px 12px; gap: 10px; }
.dshr-task-body { padding: 0 12px 12px 35px; }
.dshr-task + .dshr-task { margin-top: 1px; }

@container (min-width: 660px) {
  .dshr-task-aside {
    flex: none;
    display: grid;
    grid-template-columns: 120px 44px 72px;
    align-items: center;
    column-gap: 16px;
    color: var(--dshr-text-3);
    font-size: 12px;
    line-height: 18px;
    font-variant-numeric: tabular-nums;
  }
  .dshr-task-part {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--dshr-mono);
    font-size: 11.5px;
  }
  .dshr-task-prog { text-align: right; font-size: 11.5px; line-height: 18px; }
  .dshr-task-time { text-align: right; white-space: nowrap; }
  .dshr-task-title { -webkit-line-clamp: 1; }

  /* The main action earns words when there is room for them. */
  .dshr-icon-btn[data-open="plus"] {
    width: auto;
    height: 28px;
    gap: 4px;
    padding: 0 10px;
    border: 1px solid transparent;
    background: var(--dshr-text);
    color: var(--dsw-alias-bg-base, #fff);
    font-size: 12.5px;
    font-weight: 500;
  }
  .dshr-icon-btn[data-open="plus"]:hover,
  .dshr-icon-btn[data-open="plus"][aria-expanded="true"] {
    background: color-mix(in srgb, var(--dshr-text) 85%, transparent);
    border-color: transparent;
  }
  .dshr-btn-label { display: inline; }
  .dshr-main-head { padding: 12px 16px 12px 16px; }
  .dshr-main-title { font-size: 15px; }
  .dshr-main-sub { padding: 8px 16px 6px; }
  .dshr-tabs { padding: 0 12px; }
  .dshr-scroll { padding: 4px 12px 24px; }
}

/* The page owns the whole main area: no floating card with dead margins. */
.dshr-page {
  padding: 0;
  justify-content: stretch;
  background: var(--dsw-alias-bg-base, #fff);
}
.dshr-page > .dshr-panel {
  max-width: none;
  border: 0;
  border-radius: 0;
  background: transparent;
}
.dshr-page .dshr-rail {
  background: var(--dshr-fill);
}
.dshr-page .dshr-main {
  max-width: 1080px;
}
@container (min-width: 660px) {
  .dshr-page .dshr-rail { flex-basis: 240px; width: 240px; }
  .dshr-page .dshr-rail-head { padding: 16px 10px 8px 16px; }
  .dshr-page .dshr-rail-scroll { padding: 0 8px 10px; }
  .dshr-page .dshr-project-all { height: 32px; padding: 0 8px; }
  .dshr-page .dshr-project-main { padding: 6px 4px 6px 8px; }
}

/* ---------- send button (composer) ---------- */

.dshr-send {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--dshr-accent);
  color: #fff;
  cursor: pointer;
  transition: background-color 120ms ease, opacity 120ms ease;
}
.dshr-send:hover { background: color-mix(in srgb, var(--dshr-accent) 88%, #000); }
.dshr-send:focus-visible { outline: 2px solid var(--dshr-accent); outline-offset: 2px; }
.dshr-send[disabled] { background: color-mix(in srgb, var(--dshr-text-3) 35%, transparent); cursor: default; }
.dshr-send[data-busy="true"] { opacity: 0.6; }

/* ==========================================================================
   DeepSeek-style pass (2026-11-19 b)
   Whole surface: one accent (DeepSeek blue), soft grey sidebar, rounded
   composer, list rows that read like a chat history list. No borders on
   containers; separation is tone and spacing.
   ========================================================================== */

.dshr-panel {
  --dshr-accent: #4d6bfe;
  --dshr-accent-soft: color-mix(in srgb, var(--dshr-accent) 10%, transparent);
  --dshr-busy: var(--dshr-accent);
  font-family: var(--dsh-font, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif);
}

/* Docked panel: small refinements only. */
.dshr-task { border-radius: 10px; }
.dshr-task-row { border-radius: 10px; }
.dshr-task[data-open="true"] {
  background: var(--dsw-alias-bg-base, #fff);
  box-shadow: 0 0 0 1px var(--dshr-line), 0 2px 8px rgba(15, 17, 21, 0.04);
}
.dshr-tab[aria-selected="true"]::after { background: var(--dshr-accent); }
.dshr-tab[aria-selected="true"] { color: var(--dshr-text); font-weight: 600; }
.dshr-section-title { font-size: 12px; font-weight: 500; color: var(--dshr-text-3); }
.dshr-section[data-tone="warn"] > .dshr-section-head > .dshr-section-title { color: var(--dshr-warn); }
.dshr-section-count { font-size: 12px; }
.dshr-composer {
  margin: 10px 10px;
  padding: 10px 10px 8px 12px;
  border: 1px solid var(--dshr-line);
  border-radius: 16px;
  background: var(--dsw-alias-bg-base, #fff);
  box-shadow: 0 2px 10px rgba(15, 17, 21, 0.04);
}
.dshr-composer:focus-within { border-color: color-mix(in srgb, var(--dshr-accent) 55%, var(--dshr-line)); }
.dshr-composer > .dshr-label { display: none; }
.dshr-composer > .dshr-input {
  min-height: 44px;
  max-height: 200px;
  padding: 0;
  border: 0;
  background: transparent;
  font-size: 13.5px;
  line-height: 22px;
  resize: none;
}
.dshr-composer > .dshr-input:focus-visible { box-shadow: none; }
.dshr-drawer { border-bottom: 0; }

/* ---------- the Routing page ---------- */

.dshr-panel[data-variant="page"] {
  font-size: 14px;
  line-height: 22px;
}

/* Left rail: DeepSeek's history column. */
.dshr-panel[data-variant="page"] .dshr-rail {
  background: var(--dsw-alias-bg-layer-1, #f9fafb);
  border-right: 0;
}
.dshr-panel[data-variant="page"] .dshr-rail-head { padding: 20px 14px 10px 20px; }
.dshr-panel[data-variant="page"] .dshr-rail-title {
  font-size: 12px;
  letter-spacing: 0;
  color: var(--dshr-text-3);
}
.dshr-panel[data-variant="page"] .dshr-rail-scroll { padding: 0 10px 12px; }
.dshr-panel[data-variant="page"] .dshr-project-all,
.dshr-panel[data-variant="page"] .dshr-project-row { border-radius: 10px; }
.dshr-panel[data-variant="page"] .dshr-project-all { height: 38px; padding: 0 10px; font-size: 13.5px; }
.dshr-panel[data-variant="page"] .dshr-project-main { padding: 8px 6px 8px 10px; }
.dshr-panel[data-variant="page"] .dshr-project-name { font-size: 13.5px; line-height: 20px; }
.dshr-panel[data-variant="page"] .dshr-project-sub { font-size: 12px; line-height: 17px; }
.dshr-panel[data-variant="page"] .dshr-project-all[data-on="true"],
.dshr-panel[data-variant="page"] .dshr-project[data-on="true"] > .dshr-project-row {
  background: var(--dshr-accent-soft);
}
.dshr-panel[data-variant="page"] .dshr-project-all[data-on="true"] { color: var(--dshr-accent); }
.dshr-panel[data-variant="page"] .dshr-project[data-on="true"] .dshr-project-name { color: var(--dshr-accent); }
.dshr-panel[data-variant="page"] .dshr-switch[data-on="true"] { background: var(--dshr-accent); }
.dshr-panel[data-variant="page"] .dshr-rail-new { height: 38px; padding: 0 10px; border-radius: 10px; font-size: 13px; }
.dshr-panel[data-variant="page"] .dshr-keys { padding: 12px 20px 16px; border-top: 0; }

/* Main column: everything sits in one centred reading column, like the chat. */
.dshr-panel[data-variant="page"] .dshr-main {
  max-width: none;
  background: var(--dsw-alias-bg-base, #fff);
}
.dshr-panel[data-variant="page"] .dshr-main > :not(.dshr-scroll),
.dshr-panel[data-variant="page"] .dshr-scroll > * {
  width: 100%;
  max-width: 820px;
  margin-left: auto;
  margin-right: auto;
}
.dshr-panel[data-variant="page"] .dshr-main-head {
  padding: 40px 24px 4px;
  border-bottom: 0;
}
.dshr-panel[data-variant="page"] .dshr-main-title {
  font-size: 24px;
  line-height: 32px;
  font-weight: 600;
  letter-spacing: 0;
}
.dshr-panel[data-variant="page"] .dshr-main-sub {
  padding: 0 24px 16px;
  font-size: 13px;
  color: var(--dshr-text-3);
}
.dshr-panel[data-variant="page"] .dshr-stamp { font-family: inherit; font-size: 12px; }

/* The demand box is the page's main action: always open, chat-sized. */
.dshr-hero { flex: none; padding: 0 24px; }
.dshr-panel[data-variant="page"] .dshr-composer {
  margin: 0;
  padding: 14px 14px 10px 18px;
  border-radius: 24px;
  box-shadow: 0 0 0 0.5px var(--dshr-line), 0 4px 18px rgba(15, 17, 21, 0.06);
  border-color: transparent;
}
.dshr-panel[data-variant="page"] .dshr-composer:focus-within {
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--dshr-accent) 55%, transparent), 0 4px 18px rgba(77, 107, 254, 0.10);
}
.dshr-panel[data-variant="page"] .dshr-composer > .dshr-input {
  min-height: 52px;
  font-size: 15px;
  line-height: 24px;
}
.dshr-panel[data-variant="page"] .dshr-composer-foot > .dshr-hint { font-size: 12px; }

.dshr-panel[data-variant="page"] .dshr-tabs {
  margin-top: 28px;
  padding: 0 24px;
  gap: 6px;
  border-bottom: 0;
}
.dshr-panel[data-variant="page"] .dshr-tab {
  height: 32px;
  padding: 0 14px;
  border-radius: 999px;
  font-size: 13.5px;
  color: var(--dshr-text-2);
}
.dshr-panel[data-variant="page"] .dshr-tab::after { display: none; }
.dshr-panel[data-variant="page"] .dshr-tab:hover { background: var(--dshr-hover); }
.dshr-panel[data-variant="page"] .dshr-tab[aria-selected="true"] {
  background: var(--dshr-accent-soft);
  color: var(--dshr-accent);
  font-weight: 600;
}
.dshr-panel[data-variant="page"] .dshr-tab[aria-selected="true"] .dshr-tab-count { color: var(--dshr-accent); }

.dshr-panel[data-variant="page"] .dshr-scroll { padding: 4px 0 48px; }
.dshr-panel[data-variant="page"] .dshr-scroll > .dshr-section { padding: 0 24px; }
.dshr-panel[data-variant="page"] .dshr-section-head { padding: 22px 12px 8px; }
.dshr-panel[data-variant="page"] .dshr-section-title { font-size: 12.5px; }
.dshr-panel[data-variant="page"] .dshr-empty { padding: 10px 12px; font-size: 13px; }

.dshr-panel[data-variant="page"] .dshr-task-row { min-height: 46px; padding: 11px 12px; gap: 12px; }
.dshr-panel[data-variant="page"] .dshr-task-title { font-size: 14px; line-height: 22px; }
.dshr-panel[data-variant="page"] .dshr-task-body { padding: 0 16px 16px 37px; max-width: none; }
.dshr-panel[data-variant="page"] .dshr-task-meta { font-size: 12px; line-height: 18px; }
.dshr-panel[data-variant="page"] .dshr-todo { font-size: 13px; line-height: 20px; }
.dshr-panel[data-variant="page"] .dshr-todos { max-height: 260px; }
.dshr-panel[data-variant="page"] .dshr-btn[data-size="xs"] { height: 28px; padding: 0 12px; border-radius: 999px; font-size: 12.5px; }
.dshr-panel[data-variant="page"] .dshr-btn[data-tone="ok"] { background: var(--dshr-accent); border-color: transparent; color: #fff; }
.dshr-panel[data-variant="page"] .dshr-btn[data-tone="ok"]:hover { background: color-mix(in srgb, var(--dshr-accent) 88%, #000); }

@container (min-width: 660px) {
  .dshr-panel[data-variant="page"] .dshr-rail { flex-basis: 260px; width: 260px; border-right: 0; }
  .dshr-panel[data-variant="page"] .dshr-task-aside { grid-template-columns: 110px 40px 72px; font-size: 12.5px; }
  .dshr-panel[data-variant="page"] .dshr-main-head { padding: 40px 24px 4px; }
  .dshr-panel[data-variant="page"] .dshr-main-sub { padding: 0 24px 16px; }
  .dshr-panel[data-variant="page"] .dshr-tabs { padding: 0 24px; }
  .dshr-panel[data-variant="page"] .dshr-scroll { padding: 4px 0 48px; }
}

/* ---------- project rail toggle (task header) ---------- */

/* One pill: sidebar glyph, label, count. When a partition filter is on, the label
   becomes "Filtering: name" and a small x clears it, so a closed rail never
   leaves the user wondering why the list is short. */
.dshr-rail-ctl {
  flex: none;
  display: inline-flex;
  align-items: center;
  min-width: 0;
  max-width: 100%;
  height: 26px;
  margin-left: 6px;
  border: 1px solid var(--dshr-line);
  border-radius: 999px;
  background: transparent;
  color: var(--dshr-text-2);
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.dshr-rail-ctl:hover { background: var(--dshr-hover); color: var(--dshr-text); }
.dshr-rail-ctl:has(.dshr-rail-btn[aria-expanded="true"]) {
  background: var(--dshr-accent-soft);
  border-color: color-mix(in srgb, var(--dshr-accent) 30%, transparent);
  color: var(--dshr-accent);
}
.dshr-rail-ctl[data-filtered="true"] {
  background: var(--dshr-accent-soft);
  border-color: color-mix(in srgb, var(--dshr-accent) 40%, transparent);
  color: var(--dshr-accent);
}
.dshr-rail-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: 100%;
  padding: 0 10px 0 9px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
}
.dshr-rail-ctl[data-filtered="true"] .dshr-rail-btn { padding-right: 4px; }
.dshr-rail-btn:focus-visible,
.dshr-rail-clear:focus-visible { outline: 2px solid var(--dshr-accent); outline-offset: 1px; }
.dshr-rail-icon { flex: none; display: block; }
.dshr-rail-btn-label { white-space: nowrap; }
.dshr-rail-btn-count {
  min-width: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 12%, transparent);
  font-size: 11px;
  line-height: 17px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.dshr-rail-clear {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-right: 3px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}
.dshr-rail-clear:hover { background: color-mix(in srgb, var(--dshr-accent) 18%, transparent); }
.dshr-panel[data-variant="page"] .dshr-rail-ctl { height: 30px; margin-left: 12px; }
.dshr-panel[data-variant="page"] .dshr-rail-btn { font-size: 13px; }
.dshr-rail-ctl .dshr-ellipsis { max-width: 22ch; overflow: hidden; text-overflow: ellipsis; }
@container (max-width: 659px) {
  .dshr-rail-ctl { max-width: 58%; }
  .dshr-panel[data-variant="page"] .dshr-main-head { padding: 24px 16px 4px; flex-wrap: wrap; row-gap: 8px; }
}

@media (prefers-reduced-motion: reduce) {
  .dshr-btn, .dshr-tab, .dshr-switch, .dshr-switch-knob, .dshr-send, .dshr-rail-ctl { transition: none; }
}
`;
function installStyles() {
  if (typeof document === "undefined") return;
  const selector = `style[data-plugin-css=${JSON.stringify(STYLE_KEY)}]`;
  if (document.querySelector(selector) !== null) return;
  const tag = document.createElement("style");
  tag.dataset.plugin = "dsh-client-ui-router";
  tag.dataset.pluginCss = STYLE_KEY;
  tag.textContent = ROUTER_CSS;
  document.head.appendChild(tag);
}
var BOARD_PALETTE = {
  light: {
    surface: {
      base: "#ffffff",
      hover: "#cad2db",
      press: "#bec5cd",
      line: "rgba(0, 0, 0, 0.04)",
      // Ghost-button border: neutral-bluish-600 80% + neutral-bluish-500 (≥3:1 on base and on the error tint).
      ghostLine: "#858a91",
      // Secondary text: label-secondary 60% + label-tertiary (≥4.5:1).
      meta: "#6e7278",
      // Task id, the lowest-contrast text: neutral-bluish-600 50% + neutral-bluish-500 (≥3:1).
      id: "#8c9199"
    },
    running: {
      dot: { hex: "#4176e6", from: "state-business-primary (deepseek-500)" },
      text: { hex: "#4868b2", from: "deepseek-600" },
      bg: { hex: "#edf3fe", from: "deepseek-50" }
    },
    blocked: {
      dot: { hex: "#b0740e", from: "state-warn-primary (amber-500) 70% + label-primary" },
      text: { hex: "#8e5f10", from: "amber-500 55% + label-primary" },
      bg: { hex: "#fef5e7", from: "amber-100" }
    },
    done: {
      dot: { hex: "#488c66", from: "state-success-primary (green-500) 40% + label-secondary" },
      text: { hex: "#517e68", from: "green-500 25% + label-secondary" },
      bg: { hex: "#ecf7f1", from: "green-100 50% + neutral-bluish-75" }
    },
    failed: {
      dot: { hex: "#ec1313", from: "state-error-primary (red-600)" },
      text: { hex: "#c01313", from: "red-600 80% + label-primary" },
      bg: { hex: "#fef2f2", from: "red-50" }
    },
    cancelled: {
      dot: { hex: "#81858c", from: "label-tertiary (neutral-bluish-600)" },
      text: { hex: "#61666b", from: "label-secondary (neutral-bluish-700)" },
      bg: { hex: "#f1f3f5", from: "interactive-bg-hover-solid (neutral-bluish-75)" }
    }
  },
  dark: {
    surface: {
      base: "#151517",
      hover: "#43454a",
      press: "#4f5257",
      line: "rgba(255, 255, 255, 0.06)",
      // Ghost-button hover border: neutral-bluish-600 60% + neutral-bluish-750 (≥3:1).
      ghostLine: "#686b72",
      // Secondary text: label-tertiary (neutral-bluish-400), unchanged.
      meta: "#adb2b8",
      // Task id: label-tertiary 80% over bg-base, unchanged from round 1.
      id: "#8f9398"
    },
    running: {
      dot: { hex: "#7aaaff", from: "state-business-primary (deepseek-400)" },
      text: { hex: "#b7c8fe", from: "deepseek-300" },
      bg: { hex: "#222935", from: "deepseek-900 70% + bg-base" }
    },
    blocked: {
      dot: { hex: "#f7ad31", from: "amber-400" },
      text: { hex: "#f8c46e", from: "amber-400 70% + label-primary" },
      bg: { hex: "#27241f", from: "amber-900" }
    },
    done: {
      dot: { hex: "#5abd82", from: "state-success-primary (green-500) 60% + label-tertiary" },
      text: { hex: "#a2d2b7", from: "green-400 35% + label-secondary" },
      bg: { hex: "#1d2c24", from: "green-900 60% + bg-base" }
    },
    failed: {
      dot: { hex: "#f25a5a", from: "state-error-primary (red-400)" },
      text: { hex: "#f48a8a", from: "red-400 70% + label-primary" },
      bg: { hex: "#331112", from: "red-900 45% + bg-base" }
    },
    cancelled: {
      dot: { hex: "#81858c", from: "neutral-bluish-600" },
      text: { hex: "#adb2b8", from: "label-tertiary (neutral-bluish-400)" },
      bg: { hex: "#232324", from: "bg-layer-1 (neutral-bluish-875)" }
    }
  }
};
var BOARD_TONES = ["running", "blocked", "done", "failed", "cancelled"];
function boardVars(theme) {
  const set = BOARD_PALETTE[theme];
  const lines = [
    `--c-hover:${set.surface.hover}`,
    `--c-press:${set.surface.press}`,
    `--c-ghost-line:${set.surface.ghostLine}`,
    `--c-meta:${set.surface.meta}`,
    `--c-id:${set.surface.id}`
  ];
  for (const tone of BOARD_TONES) {
    for (const tier of ["dot", "text", "bg"]) lines.push(`--st-${tone}-${tier}:${set[tone][tier].hex}`);
  }
  return lines.join(";");
}
var BOARD_TOKENS_CSS = `
.dshrc{${boardVars("light")};--sp-1:4px;--sp-2:8px;--sp-3:12px;--sp-4:16px;--h-ctl:28px;--r-ctl:6px;--h-row:44px;--h-sub:36px}
body[data-ds-dark-theme] .dshrc{${boardVars("dark")}}
`;

// src/client/CompactBoard.tsx
var import_jsx_runtime5 = require("react/jsx-runtime");
var PAGE = 12;
var POLL_MS = 3e3;
var TABS = [
  { id: "active", key: "seg.active" },
  { id: "next", key: "seg.next" },
  { id: "scheduled", key: "seg.scheduled" },
  { id: "resolved", key: "seg.resolved" }
];
var TAB_GROUPS = {
  active: ["running", "blocked"],
  next: ["queued"],
  scheduled: ["stale"],
  resolved: ["done", "failed", "cancelled"]
};
var GROUP_KEY = {
  running: "grp.running",
  blocked: "grp.blocked",
  queued: "grp.queued",
  stale: "grp.stale",
  done: "grp.done",
  failed: "grp.failed",
  cancelled: "grp.cancelled"
};
var FOLDED_GROUPS = ["done"];
var FAMILY_FOLD = "f:";
var COLLAPSED_STORAGE_KEY = "dshr.board.collapsed";
function readCollapsedFamilies() {
  try {
    const raw = globalThis.sessionStorage?.getItem(COLLAPSED_STORAGE_KEY);
    if (raw === null || raw === void 0 || raw === "") return /* @__PURE__ */ new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return /* @__PURE__ */ new Set();
    const keys = parsed.filter((item) => typeof item === "string" && item.startsWith(FAMILY_FOLD));
    return new Set(keys);
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
function writeCollapsedFamilies(collapsed) {
  try {
    globalThis.sessionStorage?.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([...collapsed]));
  } catch {
  }
}
function hostOf(task) {
  if (task.hostState !== void 0) return task.hostState;
  return task.state === "rejected" ? "failed" : task.state;
}
function groupOf(task, live) {
  const host = hostOf(task);
  if (host === "done" || host === "verified" || host === "reported") return "done";
  if (host === "cancelled") return "cancelled";
  if (host === "failed") return isCancelled(task) ? "cancelled" : "failed";
  if (!live.has(task.partitionId)) return "stale";
  if (host === "blocked") return "blocked";
  if (host === "queued") return "queued";
  return "running";
}
var isLive = (g) => g === "running" || g === "queued" || g === "blocked";
var GROUP_ORDER = ["running", "blocked", "queued", "stale", "failed", "cancelled", "done"];
function isAborted(task) {
  return /aborted|interrupted|已中止/i.test(`${task.error ?? ""} ${task.rejectionReason ?? ""}`);
}
function isCancelled(task) {
  return /cancel|已取消/i.test(`${task.error ?? ""} ${task.rejectionReason ?? ""}`);
}
function groupOfTask(task, live) {
  return groupOf(task, live);
}
function statusKeyOf(task, live) {
  const host = hostOf(task);
  if (host === "done" || host === "verified" || host === "reported") return "status.done";
  if (host === "cancelled") return "status.cancelled";
  if (host === "failed") {
    if (isCancelled(task)) return "status.cancelled";
    return isAborted(task) ? "status.aborted" : "status.failed";
  }
  if (!live.has(task.partitionId)) return "status.stale";
  if (host === "blocked") return "status.blocked";
  if (host === "interrupted") return "status.resuming";
  if (host === "queued" || host === "dispatched") return "status.queued";
  return "status.running";
}
function foldTitle(title) {
  return title.toLowerCase().replace(/\s+/gu, " ").replace(/[\p{P}\p{S}\s]/gu, "");
}
function buildFamilies(tasks, live) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const trees = /* @__PURE__ */ new Map();
  for (const task of tasks) {
    let root = task;
    const seen = /* @__PURE__ */ new Set();
    while (root.parentId !== void 0 && byId.has(root.parentId) && !seen.has(root.id)) {
      seen.add(root.id);
      root = byId.get(root.parentId);
    }
    const list = trees.get(root.id);
    if (list === void 0) trees.set(root.id, [task]);
    else list.push(task);
  }
  const families = [];
  const folded = /* @__PURE__ */ new Map();
  for (const [id, members] of trees) {
    const root = byId.get(id);
    if (members.length > 1) {
      families.push({ key: `root:${id}`, group: "done", root, rep: root, members, attempt: 1 });
      continue;
    }
    const dedupeKey = [root.partitionId, groupOfTask(root, live), foldTitle(root.title)].join("\0");
    const hit = folded.get(dedupeKey);
    if (hit === void 0) {
      const family = { key: `one:${dedupeKey}`, group: "done", root, rep: root, members: [root], attempt: 1 };
      folded.set(dedupeKey, family);
      families.push(family);
      continue;
    }
    hit.members.push(root);
    if (startOf(root) > startOf(hit.root)) hit.root = root;
  }
  for (const family of families) {
    family.group = GROUP_ORDER.find((group) => family.members.some((task) => groupOfTask(task, live) === group)) ?? "done";
    family.rep = family.members.find((task) => groupOfTask(task, live) === family.group) ?? family.root;
    family.attempt = family.members.reduce((most, task) => Math.max(most, task.attempt ?? 1), 1);
    const reason = family.members.map((task) => task.error ?? task.rejectionReason).find((text) => text !== void 0 && text !== "");
    if (reason !== void 0) family.reason = reason;
  }
  return families.sort((left, right) => startOf(right.root) - startOf(left.root));
}
function ago(iso, now) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1e3));
  return seconds < 60 ? `${seconds} \u79D2\u524D` : relativeTime(iso, now);
}
var startOf = (task) => Date.parse(task.requestedAt ?? task.updatedAt) || 0;
var TONE_COLOR = {
  running: "running",
  resuming: "running",
  blocked: "blocked",
  queued: "cancelled",
  stale: "cancelled",
  done: "done",
  failed: "failed",
  aborted: "failed",
  cancelled: "cancelled"
};
function Status({ tone, label }) {
  return /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("span", { className: "dshrc-st", "data-tone": tone, "data-color": TONE_COLOR[tone] ?? "cancelled", title: label, children: [
    /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "dshrc-dot", "aria-hidden": "true" }),
    /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "dshrc-st-text", children: label })
  ] });
}
function Icon({ d, className, open }) {
  return /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
    "svg",
    {
      className,
      "data-open": open === true ? "" : void 0,
      viewBox: "0 0 16 16",
      width: "16",
      height: "16",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.5",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      focusable: "false",
      children: /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("path", { d })
    }
  );
}
function shortId(id) {
  const tail = id.slice(id.lastIndexOf("-") + 1);
  return tail.length >= 3 && tail.length < id.length ? `#${tail}` : id;
}
var CARET = "M6 4l4 4-4 4";
var ICON_REFRESH = "M13 8a5 5 0 1 1-1.5-3.6M13 3v3h-3";
var ICON_PLUS = "M8 3v10M3 8h10";
var ICON_CLOSE = "M4 4l8 8M12 4l-8 8";
var STYLE = `${BOARD_TOKENS_CSS}
.dshrc{container-type:inline-size;--c-text:var(--dsw-alias-label-primary,#0f1115);--c-text2:var(--dsw-alias-label-secondary,#61666b);--c-text3:var(--c-meta);--c-line:var(--dsw-alias-border-l2,rgba(0,0,0,.1));--c-line-soft:var(--dsw-alias-border-l1,rgba(0,0,0,.04));--c-pill:var(--dsw-alias-interactive-bg-hover-solid,#f1f3f5);--c-focus:var(--st-running-dot);--f-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base,transparent);color:var(--c-text);font-size:13px;line-height:1.45;text-align:left}
.dshrc *{box-sizing:border-box}
/* Zero-specificity reset so .dshrc-gh/-chip/-fold/-tab keep their own font size, weight and numerals. */
:where(.dshrc button){font:inherit}
.dshrc button:focus-visible{outline:2px solid var(--c-focus);outline-offset:1px}
.dshrc button:disabled{opacity:.45;cursor:default}
.dshrc-head{display:flex;align-items:center;gap:var(--sp-2);padding:var(--sp-3) var(--sp-3) var(--sp-1) var(--sp-4);flex:none}
.dshrc-title{flex:1 1 auto;min-width:0;margin:0;font-size:13px;font-weight:600;line-height:20px;color:var(--c-text)}
.dshrc-acts{display:flex;align-items:center;gap:var(--sp-1);flex:none}
.dshrc-ico{display:flex;align-items:center;justify-content:center;width:var(--h-ctl);height:var(--h-ctl);padding:0;border:0;border-radius:var(--r-ctl);background:transparent;color:var(--c-text2);cursor:pointer;transition:background-color .12s ease,color .12s ease}
.dshrc-ico:hover{background:var(--c-hover);color:var(--c-text)}
.dshrc-ico:active{background:var(--c-press);color:var(--c-text)}
.dshrc-ico svg{width:16px;height:16px;display:block}
.dshrc-tabs{display:flex;align-items:center;gap:var(--sp-1);flex:none;padding:var(--sp-1) var(--sp-3) var(--sp-2) var(--sp-4);overflow-x:auto;scrollbar-width:none;border-bottom:1px solid var(--c-line-soft)}
.dshrc-tabs::-webkit-scrollbar{display:none}
.dshrc-tab{flex:none;height:var(--h-ctl);padding:0 var(--sp-3);border:0;border-radius:var(--r-ctl);background:transparent;color:var(--c-text2);font-size:12px;font-weight:500;line-height:var(--h-ctl);cursor:pointer;white-space:nowrap;transition:background-color .12s ease,color .12s ease}
.dshrc-tab:hover{background:var(--c-hover);color:var(--c-text)}
.dshrc-tab:active{background:var(--c-press)}
.dshrc-tab[data-on]{background:var(--c-pill);color:var(--c-text);font-weight:600}
.dshrc-tab-n{margin-left:var(--sp-1);font-weight:500;color:var(--c-text3);font-variant-numeric:tabular-nums}
.dshrc-tab-flag{display:inline-block;width:6px;height:6px;margin-left:var(--sp-1);vertical-align:middle;border-radius:50%;background:var(--st-blocked-dot)}
.dshrc-ico[data-busy] svg{animation:dshrc-spin .8s linear infinite}
@keyframes dshrc-spin{to{transform:rotate(360deg)}}
.dshrc-row[data-link]:focus-visible{outline:2px solid var(--c-focus);outline-offset:-2px}
.dshrc-list{flex:1 1 auto;min-height:0;overflow:auto;padding:0 var(--sp-1) 24px;scrollbar-width:thin}
.dshrc-group{margin-top:var(--sp-4)}
.dshrc-group+.dshrc-group{padding-top:var(--sp-3);margin-top:var(--sp-1);border-top:1px solid var(--c-line-soft)}
.dshrc-gh{display:flex;align-items:center;gap:var(--sp-2);width:100%;height:var(--h-ctl);margin:0 0 6px;padding:0 var(--sp-3) 0 var(--sp-2);border:0;border-radius:var(--r-ctl);background:transparent;color:var(--c-text2);font-size:11px;font-weight:600;line-height:16px;letter-spacing:.02em;text-transform:uppercase;text-align:left;cursor:pointer;transition:background-color .12s ease}
.dshrc-gh:hover{background:var(--c-hover);color:var(--c-text)}
.dshrc-gh:active{background:var(--c-press)}
.dshrc-gcaret{flex:none;width:16px;height:16px;color:var(--c-text3);transition:transform .15s ease}
.dshrc-gcaret[data-open]{transform:rotate(90deg)}
.dshrc-gn{color:inherit}
.dshrc-gc,.dshrc-gshown{font-weight:500;color:var(--c-text3);font-variant-numeric:tabular-nums;white-space:nowrap;letter-spacing:0}
.dshrc-family{display:block}
.dshrc-family+.dshrc-family{border-top:1px solid var(--c-line-soft)}
.dshrc-row{display:flex;align-items:center;gap:var(--sp-2);width:100%;min-height:var(--h-row);padding:var(--sp-1) var(--sp-3);border-radius:var(--r-ctl);cursor:default;transition:background-color .12s ease}
.dshrc-row[data-link]{cursor:pointer}
.dshrc-row[data-link]:hover{background:var(--c-hover)}
.dshrc-row[data-link]:active{background:var(--c-press)}
.dshrc-sub{min-height:var(--h-sub);padding-left:28px}
.dshrc-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column}
.dshrc-rt{flex:1 1 auto;min-width:56px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500;line-height:20px;color:var(--c-text)}
.dshrc-sub .dshrc-rt{font-weight:400;color:var(--c-text2)}
.dshrc-row[data-group="stale"] .dshrc-rt{color:var(--c-text2)}
.dshrc-meta{display:flex;align-items:baseline;gap:var(--sp-2);min-width:0;font-size:11px;line-height:16px;color:var(--c-text3);white-space:nowrap}
.dshrc-rm{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;color:var(--c-text3);font-variant-numeric:tabular-nums}
.dshrc-sub>.dshrc-rm{flex:0 1 auto;max-width:40%;text-align:right}
.dshrc-id{flex:none;font-family:var(--f-mono);font-size:11px;line-height:16px;color:var(--c-id);white-space:nowrap}
.dshrc-st{flex:none;display:inline-flex;align-items:center;gap:var(--sp-1);font-size:11px;line-height:16px;white-space:nowrap;color:var(--st-cancelled-text)}
.dshrc-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--st-cancelled-dot)}
.dshrc-st[data-color="running"]{color:var(--st-running-text)}.dshrc-st[data-color="running"] .dshrc-dot{background:var(--st-running-dot);animation:dshrc-pulse 1.6s ease-in-out infinite}
.dshrc-st[data-color="blocked"]{color:var(--st-blocked-text)}.dshrc-st[data-color="blocked"] .dshrc-dot{background:var(--st-blocked-dot)}
.dshrc-st[data-color="done"]{color:var(--st-done-text)}.dshrc-st[data-color="done"] .dshrc-dot{background:var(--st-done-dot)}
.dshrc-st[data-color="failed"]{color:var(--st-failed-text)}.dshrc-st[data-color="failed"] .dshrc-dot{background:var(--st-failed-dot)}
.dshrc-st[data-tone="queued"] .dshrc-dot,.dshrc-st[data-tone="stale"] .dshrc-dot,.dshrc-st[data-tone="aborted"] .dshrc-dot{background:transparent;box-shadow:inset 0 0 0 1.5px currentColor}
@keyframes dshrc-pulse{0%,100%{opacity:1}50%{opacity:.4}}
/* Worker fold chip: ghost button, 28x28 minimum hit area, 16px caret. The
   negative block margin keeps it from growing the 44px family row. */
.dshrc-chip{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;gap:var(--sp-1);min-width:var(--h-ctl);height:var(--h-ctl);margin-block:-4px;padding:0 var(--sp-2) 0 var(--sp-1);border:1px solid transparent;border-radius:var(--r-ctl);background:transparent;color:var(--c-text3);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;cursor:pointer;white-space:nowrap;transition:background-color .12s ease,border-color .12s ease,color .12s ease}
.dshrc-chip:hover{border-color:var(--c-ghost-line);background:var(--dsw-alias-bg-base,transparent);color:var(--c-text)}
.dshrc-chip:active{background:var(--c-press);color:var(--c-text)}
.dshrc-caret{flex:none;width:16px;height:16px;display:block;transition:transform .15s ease}
.dshrc-caret[data-open]{transform:rotate(90deg)}
.dshrc-tag{flex:none;display:inline-flex;align-items:center;height:20px;padding:0 var(--sp-1);border-radius:4px;background:var(--st-cancelled-bg);color:var(--c-text3);font-size:11px;line-height:16px;white-space:nowrap;font-variant-numeric:tabular-nums}
.dshrc-fold{display:flex;align-items:center;gap:var(--sp-1);height:var(--h-ctl);margin:var(--sp-1) 0 0 var(--sp-1);padding:0 var(--sp-2);border:1px solid transparent;border-radius:var(--r-ctl);background:transparent;color:var(--c-text3);font-size:12px;cursor:pointer;font-variant-numeric:tabular-nums}
.dshrc-fold:hover{border-color:var(--c-ghost-line);color:var(--c-text)}
.dshrc-fold:active{background:var(--c-press)}
.dshrc-err{display:flex;align-items:center;gap:var(--sp-2);flex:none;margin:var(--sp-2) var(--sp-3) 0;padding:var(--sp-2) var(--sp-3);border-radius:var(--r-ctl);background:var(--st-failed-bg);color:var(--c-text);font-size:12px;line-height:16px}
.dshrc-err-text{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.dshrc-err-msg{color:var(--st-failed-text)}
.dshrc-err-stale{display:block;color:var(--c-text3);font-size:11px}
.dshrc-err-btn,.dshrc-hold-btn{flex:none;height:var(--h-ctl);padding:0 var(--sp-3);border:1px solid transparent;border-radius:var(--r-ctl);background:transparent;color:var(--c-text);font-size:12px;line-height:16px;white-space:nowrap;cursor:pointer;transition:background-color .12s ease,border-color .12s ease}
.dshrc-err-btn{border-color:var(--c-ghost-line)}
.dshrc-err-btn:hover,.dshrc-hold-btn:hover:not(:disabled){border-color:var(--c-ghost-line);background:var(--dsw-alias-bg-base,transparent)}
.dshrc-err-btn:active,.dshrc-hold-btn:active:not(:disabled){background:var(--c-press)}
.dshrc-sample{flex:none;margin:var(--sp-2) var(--sp-3) 0;padding:var(--sp-1) var(--sp-3);border-radius:var(--r-ctl);background:var(--st-blocked-bg);color:var(--st-blocked-text);font-size:11px}
.dshrc-hold{display:flex;align-items:center;gap:var(--sp-2);min-width:0;margin:-4px 0 var(--sp-1);padding:0 var(--sp-3) 0 28px;font-size:12px;line-height:16px;color:var(--c-text2)}
.dshrc-hold-why{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshrc-hold-err{flex:0 1 auto;min-width:0;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--st-failed-text)}
.dshrc-hold-btn{color:var(--st-blocked-text)}
.dshrc-notice{flex:none;margin:var(--sp-2) var(--sp-3) 0;padding:var(--sp-1) var(--sp-3);border-radius:var(--r-ctl);background:var(--st-done-bg);color:var(--st-done-text);font-size:12px;line-height:20px;overflow-wrap:anywhere}
.dshrc-notice[data-tone="bad"]{background:var(--st-failed-bg);color:var(--st-failed-text)}
.dshrc-empty{padding:36px var(--sp-4);color:var(--c-text3);text-align:center;font-size:12px}
@media (prefers-reduced-motion:reduce){.dshrc *{transition:none!important;animation:none!important}}
/* Narrow rail (about 340px at a 1024 viewport): title and status dot only. */
@container (max-width:379px){
.dshrc-meta,.dshrc-id,.dshrc-sub>.dshrc-rm,.dshrc-chip-text{display:none}
.dshrc-st-text{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.dshrc-chip{padding:0 var(--sp-1)}
.dshrc-st{padding:0 var(--sp-1)}
}
`;
function CompactBoard({ controller, t, onOpenSession, onOpenWarRoom, onClose, sessions }) {
  const state = (0, import_react3.useSyncExternalStore)(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const board = state.board;
  const sessionFace = sessions ?? NO_SESSIONS;
  const sessionList = (0, import_react3.useSyncExternalStore)(sessionFace.list.subscribe, sessionFace.list.getSnapshot, sessionFace.list.getSnapshot);
  const [tab, setTab] = (0, import_react3.useState)("active");
  const [collapsed, setCollapsed] = (0, import_react3.useState)(readCollapsedFamilies);
  const [open, setOpen] = (0, import_react3.useState)(() => /* @__PURE__ */ new Set());
  const [folded, setFolded] = (0, import_react3.useState)(() => new Set(FOLDED_GROUPS));
  const [now, setNow] = (0, import_react3.useState)(() => Date.now());
  const [resuming, setResuming] = (0, import_react3.useState)(() => /* @__PURE__ */ new Set());
  const [resumeError, setResumeError] = (0, import_react3.useState)(() => /* @__PURE__ */ new Map());
  const [notice, setNotice] = (0, import_react3.useState)(null);
  const [refreshing, setRefreshing] = (0, import_react3.useState)(false);
  const refresh = () => {
    if (refreshing) return;
    setRefreshing(true);
    void controller.load().finally(() => {
      setRefreshing(false);
    });
  };
  (0, import_react3.useEffect)(() => {
    if (notice === null) return;
    const timer = setTimeout(() => {
      setNotice(null);
    }, 4e3);
    return () => {
      clearTimeout(timer);
    };
  }, [notice]);
  (0, import_react3.useEffect)(() => {
    writeCollapsedFamilies(collapsed);
  }, [collapsed]);
  const resume = async (task) => {
    if (resuming.has(task.id)) return;
    setResuming((previous) => new Set(previous).add(task.id));
    setResumeError((previous) => {
      if (!previous.has(task.id)) return previous;
      const next = new Map(previous);
      next.delete(task.id);
      return next;
    });
    const failure = await controller.control(task.id, "resume");
    setResuming((previous) => {
      const next = new Set(previous);
      next.delete(task.id);
      return next;
    });
    if (failure === void 0) {
      setNotice({ tone: "ok", text: t("hold.resumed", { title: task.title }) });
    } else {
      setResumeError((previous) => new Map(previous).set(task.id, failure));
      setNotice({ tone: "bad", text: t("hold.resumeFailed", { message: failure }) });
    }
  };
  const toggleFolded = (group) => {
    setFolded((previous) => {
      const next = new Set(previous);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };
  (0, import_react3.useEffect)(() => {
    const detach = controller.start();
    void controller.load();
    return () => {
      detach();
    };
  }, [controller]);
  const model = (0, import_react3.useMemo)(() => {
    const tasks = board?.tasks ?? [];
    const partitions2 = board?.partitions ?? [];
    const live = new Set(partitions2.map((partition) => partition.id));
    const nameOf = new Map(partitions2.map((partition) => [partition.id, partition.name]));
    const workerName = /* @__PURE__ */ new Map();
    for (const partition of partitions2) for (const worker2 of partition.workers) workerName.set(worker2.id, worker2.name);
    const families = buildFamilies(tasks, live);
    const groupFams = /* @__PURE__ */ new Map();
    for (const group of Object.keys(TAB_GROUPS).flatMap((id) => TAB_GROUPS[id])) groupFams.set(group, []);
    for (const family of families) {
      const list = groupFams.get(family.group);
      if (list !== void 0) list.push(family);
    }
    const counts = /* @__PURE__ */ new Map();
    for (const [group, list] of groupFams) counts.set(group, list.length);
    const anyLive = [...counts].some(([group, count]) => count > 0 && isLive(group));
    return { live, nameOf, workerName, groupFams, counts, anyLive };
  }, [board]);
  (0, import_react3.useEffect)(() => {
    if (!model.anyLive) return;
    const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
    const tick = () => {
      if (hidden()) return;
      setNow(Date.now());
      void controller.load();
    };
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [model.anyLive, controller]);
  const tabCounts = (0, import_react3.useMemo)(() => {
    const counts = /* @__PURE__ */ new Map();
    for (const item of TABS) counts.set(item.id, TAB_GROUPS[item.id].reduce((sum, group) => sum + (model.counts.get(group) ?? 0), 0));
    return counts;
  }, [model]);
  const waiting = model.counts.get("blocked") ?? 0;
  const [landed, setLanded] = (0, import_react3.useState)(false);
  (0, import_react3.useEffect)(() => {
    if (board === null || landed) return;
    setLanded(true);
    if ((tabCounts.get(tab) ?? 0) > 0) return;
    const next = TABS.find((item) => (tabCounts.get(item.id) ?? 0) > 0);
    if (next !== void 0) setTab(next.id);
  }, [board, landed, tabCounts, tab]);
  const toggle = (id) => {
    setOpen((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleCollapsed = (key) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const elapsed = (task, group) => {
    const start = Date.parse(task.startedAt ?? "") || startOf(task);
    if (start === 0) return "";
    const end = isLive(group) ? now : Date.parse(task.updatedAt) || now;
    return duration(Math.max(0, (end - start) / 1e3));
  };
  const todoLine = (task) => {
    const liveTodos = todosOf(sessionList, task.workerSessionId);
    if (liveTodos !== void 0 && liveTodos.length > 0) {
      return { done: liveTodos.filter((item) => item.status === "completed").length, total: liveTodos.length };
    }
    const progress = task.todoProgress;
    if (progress === void 0 || progress.total === 0) return void 0;
    return { done: progress.done, total: progress.total };
  };
  const metaOf = (task, group) => {
    const parts = [];
    const partition = model.nameOf.get(task.partitionId);
    if (partition !== void 0) parts.push(partition);
    if (isLive(group)) {
      const spent = elapsed(task, group);
      if (spent !== "") parts.push(spent);
    } else if (group === "stale") {
      parts.push(t("compact.stale"));
    } else {
      const when = relativeTime(task.updatedAt, now);
      if (when !== "") parts.push(when);
    }
    return parts.join(" \xB7 ");
  };
  const openOf = (task) => task.workerSessionId !== void 0 && onOpenSession !== void 0 ? () => {
    onOpenSession(task.workerSessionId);
  } : void 0;
  const linkProps = (click) => click === void 0 ? {} : {
    "data-link": "",
    role: "button",
    tabIndex: 0,
    onClick: click,
    onKeyDown: (event) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        click();
      }
    }
  };
  const workerNameOf = (task) => (task.workerId === void 0 ? void 0 : model.workerName.get(task.workerId) ?? task.workerId) ?? "";
  const tooltipOf = (task, group, extra = []) => {
    const who = group === "running" || group === "queued" || group === "blocked" ? workerNameOf(task) : "";
    return [
      task.title,
      `${task.id} \xB7 ${task.hostState ?? task.state}`,
      model.nameOf.get(task.partitionId) ?? task.partitionId,
      who === "" ? void 0 : who,
      ...extra,
      (() => {
        const todo = todoLine(task);
        return todo === void 0 ? void 0 : t("todo.progress", { done: todo.done, total: todo.total });
      })(),
      task.toolCalls !== void 0 && task.toolCalls > 0 ? `${t("compact.calls", { n: task.toolCalls })}${task.lastTool === void 0 ? "" : ` \xB7 ${task.lastTool}`}` : void 0,
      task.lastActivityAt === void 0 ? void 0 : ago(task.lastActivityAt, now)
    ].filter((line) => line !== void 0 && line !== "").join("\n");
  };
  const statusOf = (task) => {
    const key = statusKeyOf(task, model.live);
    return { key, tone: key.replace("status.", "") };
  };
  const childRow = (task, group) => {
    const click = openOf(task);
    const status = statusOf(task);
    return /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(
      "div",
      {
        className: "dshrc-row dshrc-sub",
        "data-group": group,
        "data-task": task.id,
        ...linkProps(click),
        title: tooltipOf(task, group),
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "dshrc-rt", children: task.title }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "dshrc-rm", children: metaOf(task, group) }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "dshrc-id", children: shortId(task.id) }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(Status, { tone: status.tone, label: t(status.key) })
        ]
      },
      task.id
    );
  };
  const familyRow = (family) => {
    const group = family.group;
    const click = openOf(family.root);
    const hidden = family.members.filter((task) => task.id !== family.root.id);
    const foldKey = `${FAMILY_FOLD}${family.key}`;
    const expanded = !collapsed.has(foldKey);
    const status = statusOf(family.rep);
    const extra = [];
    if (hidden.length > 0) extra.push(t("compact.family", { n: family.members.length }));
    if (family.attempt > 1) extra.push(t("task.attempt", { count: family.attempt }));
    if (family.reason !== void 0) extra.push(family.reason);
    return /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "dshrc-family", "data-family": family.key, "data-group": group, children: [
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(
        "div",
        {
          className: "dshrc-row",
          "data-group": group,
          "data-task": family.root.id,
          ...linkProps(click),
          title: tooltipOf(family.root, group, extra),
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("span", { className: "dshrc-main", children: [
              /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "dshrc-rt", children: family.root.title }),
              /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("span", { className: "dshrc-meta", children: [
                /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "dshrc-rm", children: metaOf(family.rep, group) }),
                /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "dshrc-id", children: shortId(family.root.id) })
              ] })
            ] }),
            family.attempt > 1 && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "dshrc-tag", "data-tone": "attempt", children: t("compact.retry", { n: family.attempt }) }),
            hidden.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(
              "button",
              {
                type: "button",
                className: "dshrc-chip",
                "aria-expanded": expanded,
                "aria-label": t("compact.workers", { n: hidden.length }),
                title: t("compact.family", { n: family.members.length }),
                onClick: (event) => {
                  event.stopPropagation();
                  toggleCollapsed(foldKey);
                },
                children: [
                  /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(Icon, { className: "dshrc-caret", d: CARET, open: expanded }),
                  /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "dshrc-chip-text", children: t("compact.workers", { n: hidden.length }) })
                ]
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(Status, { tone: status.tone, label: t(status.key) })
          ]
        }
      ),
      group === "blocked" && holdLine(family.rep),
      expanded && hidden.map((task) => childRow(task, groupOfTask(task, model.live)))
    ] }, family.key);
  };
  const holdLine = (task) => {
    const why = task.resumeNote ?? task.error ?? "";
    const busy = resuming.has(task.id);
    const failure = resumeError.get(task.id);
    const wired = controller.canControl;
    return /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "dshrc-hold", "data-hold": task.id, children: [
      /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "dshrc-hold-why", title: why === "" ? void 0 : why, children: why === "" ? t("hold.noReason") : t("hold.reason", { reason: why }) }),
      failure !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "dshrc-hold-err", title: failure, children: t("hold.resumeFailedShort") }),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
        "button",
        {
          type: "button",
          className: "dshrc-hold-btn",
          disabled: busy || !wired,
          title: wired ? t("hold.resumeHint") : t("hold.notWired"),
          onClick: (event) => {
            event.stopPropagation();
            void resume(task);
          },
          children: busy ? t("hold.resuming") : t("hold.resume")
        }
      )
    ] });
  };
  const groupBlock = (group) => {
    const list = model.groupFams.get(group) ?? [];
    if (list.length === 0) return null;
    const foldKey = `g:${group}`;
    const more = open.has(foldKey);
    const shown = more ? list : list.slice(0, PAGE);
    const closed = folded.has(group);
    const tasks = list.reduce((sum, family) => sum + family.members.length, 0);
    const visible = closed ? 0 : shown.length;
    const hint = closed ? t("compact.foldedHint", { n: list.length }) : visible < list.length ? t("compact.shown", { n: visible, m: list.length }) : "";
    return /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("section", { className: "dshrc-group", "data-section": group, "data-folded": closed ? "" : void 0, children: [
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(
        "button",
        {
          type: "button",
          className: "dshrc-gh",
          "aria-expanded": !closed,
          onClick: () => {
            toggleFolded(group);
          },
          title: t("compact.familyTotal", { n: tasks }),
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(Icon, { className: "dshrc-gcaret", d: CARET, open: !closed }),
            /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "dshrc-gn", children: t(GROUP_KEY[group]) }),
            /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "dshrc-gc", children: list.length }),
            hint !== "" && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "dshrc-gshown", "data-shown": visible, "data-total": list.length, children: hint })
          ]
        }
      ),
      !closed && shown.map(familyRow),
      !closed && list.length > PAGE && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("button", { type: "button", className: "dshrc-fold", "aria-expanded": more, onClick: () => {
        toggle(foldKey);
      }, children: more ? t("compact.less") : t("compact.more", { n: list.length - PAGE }) })
    ] }, group);
  };
  const groups = TAB_GROUPS[tab];
  const shownCount = groups.reduce((sum, group) => sum + (model.counts.get(group) ?? 0), 0);
  const failed = state.status === "error";
  const lastOk = board === null ? "" : clockTime(board.fetchedAt);
  return /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "dshrc", "data-router-compact": true, "data-tab": tab, children: [
    /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("style", { children: STYLE }),
    /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("header", { className: "dshrc-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("h2", { className: "dshrc-title", children: t("board.title") }),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "dshrc-acts", children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
          "button",
          {
            type: "button",
            className: "dshrc-ico",
            onClick: refresh,
            "data-busy": refreshing ? "" : void 0,
            title: t(refreshing ? "board.refreshing" : "board.refresh"),
            "aria-label": t(refreshing ? "board.refreshing" : "board.refresh"),
            children: /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(Icon, { d: ICON_REFRESH })
          }
        ),
        onOpenWarRoom !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
          "button",
          {
            type: "button",
            className: "dshrc-ico",
            onClick: onOpenWarRoom,
            title: t("board.newTask"),
            "aria-label": t("board.newTask"),
            children: /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(Icon, { d: ICON_PLUS })
          }
        ),
        onClose !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
          "button",
          {
            type: "button",
            className: "dshrc-ico",
            onClick: onClose,
            title: t("board.close"),
            "aria-label": t("board.close"),
            children: /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(Icon, { d: ICON_CLOSE })
          }
        )
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "dshrc-tabs", role: "tablist", "aria-label": t("panel.title"), children: TABS.map((item) => /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(
      "button",
      {
        type: "button",
        role: "tab",
        className: "dshrc-tab",
        "data-on": tab === item.id ? "" : void 0,
        "aria-selected": tab === item.id,
        onClick: () => {
          setTab(item.id);
        },
        children: [
          t(item.key),
          (tabCounts.get(item.id) ?? 0) > 0 && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "dshrc-tab-n", children: tabCounts.get(item.id) }),
          item.id === "active" && waiting > 0 && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "dshrc-tab-flag", title: t("seg.waiting", { n: waiting }), "aria-label": t("seg.waiting", { n: waiting }) })
        ]
      },
      item.id
    )) }),
    failed && /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "dshrc-err", role: "alert", "data-router-error": true, children: [
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("span", { className: "dshrc-err-text", children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "dshrc-err-msg", children: t("board.error", { message: state.error ?? "" }) }),
        lastOk !== "" && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "dshrc-err-stale", children: t("board.lastOk", { time: lastOk }) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("button", { type: "button", className: "dshrc-err-btn", onClick: refresh, disabled: refreshing, children: t("board.retry") })
    ] }),
    board !== null && board.origin === "mock" && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "dshrc-sample", "data-router-sample": true, title: t("board.mock.hint"), children: t("board.mock") }),
    notice !== null && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "dshrc-notice", role: "status", "data-tone": notice.tone, children: notice.text }),
    /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "dshrc-list", children: board === null ? /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "dshrc-empty", children: failed ? t("board.emptyOnError") : t("board.loading") }) : shownCount === 0 ? /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "dshrc-empty", children: t("compact.empty") }) : groups.map(groupBlock) })
  ] });
}

// src/client/WarRoomRedirect.tsx
var import_react4 = require("react");
var import_jsx_runtime6 = require("react/jsx-runtime");
function WarRoomRedirect({ t, open }) {
  (0, import_react4.useEffect)(() => {
    open();
  }, [open]);
  return /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, height: "100%" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("div", { style: { opacity: 0.7 }, children: t("warroom.opening") }),
    /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("button", { type: "button", className: "dshr-btn", style: { height: 32, padding: "0 16px" }, onClick: open, children: t("warroom.open") })
  ] });
}

// src/client/ModelTiers.tsx
var import_react5 = require("react");
var import_jsx_runtime7 = require("react/jsx-runtime");
var TIERS = ["easy", "medium", "hard"];
var LABEL = { easy: "\u521D\u7EA7", medium: "\u4E2D\u7EA7", hard: "\u9AD8\u7EA7" };
var HINT = {
  easy: "\u53EA\u8BFB\u5C0F\u6D3B\uFF1A\u5217\u76EE\u5F55\u3001\u7EDF\u8BA1\u3001\u67E5\u72B6\u6001",
  medium: "\u5E38\u89C4\u4FEE\u6539\uFF1A\u52A0\u529F\u80FD\u3001\u4FEE\u5C0F\u95EE\u9898",
  hard: "\u5927\u6539\u52A8\uFF1A\u91CD\u6784\u3001\u6539\u7248\u3001\u8DE8\u6587\u4EF6\u6392\u67E5"
};
var keyOf = (route) => route == null ? "" : `${route.provider}\0${route.model}`;
function shortName(name) {
  const slash = name.lastIndexOf("/");
  return slash >= 0 && slash < name.length - 1 ? name.slice(slash + 1) : name;
}
var EFFORT_LABEL = {
  off: "\u5173\u95ED",
  low: "\u4F4E",
  medium: "\u4E2D",
  high: "\u9AD8",
  xhigh: "\u5F88\u9AD8",
  max: "\u6700\u9AD8"
};
var CSS = `
:where(div):has(> [data-slot] > .dmt-root), :where(div):has(> [data-slot] > .dst-root) {
  flex-wrap: wrap; row-gap: 6px;
}
.dmt-root {
  --dmt-text: var(--dsw-alias-label-primary, #0f1115);
  --dmt-text2: var(--dsw-alias-label-secondary, #61666b);
  --dmt-caption: var(--dsw-alias-label-caption, #81858c);
  --dmt-line: var(--dsw-alias-border-l1, rgba(0,0,0,.06));
  --dmt-line2: var(--dsw-alias-border-l2, rgba(0,0,0,.08));
  --dmt-hover: var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06));
  --dmt-accent: var(--dsw-alias-state-business-primary, #4d6bfe);
  --dmt-bad: var(--dsw-alias-state-error-primary, #ec1313);
  --dmt-pop: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, #ffffff));
  --dmt-easy: #22a06b; --dmt-medium: #e6a23c; --dmt-hard: #8b5cf6;
  position: relative; flex: 1 0 100%; width: 100%; min-width: 0; box-sizing: border-box;
  color: var(--dmt-text); font-family: inherit; text-align: left;
}
.dmt-root *, .dmt-root *::before, .dmt-root *::after { box-sizing: border-box; }
.dmt-card {
  display: flex; flex-direction: column; gap: 6px; width: 100%; min-width: 0;
  padding: 8px 10px; border: 1px solid var(--dmt-line); border-radius: 12px;
  background: transparent; color: var(--dmt-text); font: inherit; font-size: 12px;
  line-height: 1.35; text-align: left; cursor: pointer; transition: background .15s ease;
}
.dmt-card:hover { background: var(--dmt-hover); }
.dmt-card:focus-visible { outline: 2px solid var(--dmt-accent); outline-offset: 1px; }
.dmt-card[aria-expanded="true"] { border-color: color-mix(in srgb, var(--dmt-accent) 38%, var(--dmt-line)); }
.dmt-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dmt-title { font-size: 11px; font-weight: 500; letter-spacing: .02em; color: var(--dmt-caption); white-space: nowrap; }
.dmt-badge {
  margin-left: auto; padding: 1px 6px; border-radius: 999px; font-size: 10px; white-space: nowrap;
  color: var(--dmt-caption); background: color-mix(in srgb, var(--dmt-caption) 12%, transparent);
}
.dmt-badge[data-on] { color: var(--dmt-accent); background: color-mix(in srgb, var(--dmt-accent) 12%, transparent); }
.dmt-caret { font-size: 9px; color: var(--dmt-caption); }
.dmt-lines { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.dmt-line { display: grid; grid-template-columns: auto minmax(0,1fr) auto; align-items: center; gap: 6px; min-width: 0; }
.dmt-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dmt-caption); }
.dmt-dot[data-tier="easy"] { background: var(--dmt-easy); }
.dmt-dot[data-tier="medium"] { background: var(--dmt-medium); }
.dmt-dot[data-tier="hard"] { background: var(--dmt-hard); }
.dmt-line-label { font-size: 11px; color: var(--dmt-text2); white-space: nowrap; }
.dmt-line-model { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--dmt-text); text-align: right; }
.dmt-root[data-off] .dmt-line { opacity: .5; }
.dmt-note { font-size: 10px; color: var(--dmt-caption); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dmt-note[data-bad] { color: var(--dmt-bad); }

.dmt-pop {
  position: fixed; z-index: 1200; display: flex; flex-direction: column; min-height: 0;
  border: 1px solid var(--dmt-line2); border-radius: 14px; background: var(--dmt-pop); color: var(--dmt-text);
  box-shadow: 0 18px 48px rgba(15,17,21,.2), 0 2px 8px rgba(15,17,21,.08);
  font-size: 12px; line-height: 1.45; overflow: hidden;
}
.dmt-pop-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px 8px; border-bottom: 1px solid var(--dmt-line); flex: none; }
.dmt-pop-title { margin-right: auto; font-size: 12px; font-weight: 600; }
.dmt-close {
  display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0;
  border: 0; border-radius: 6px; background: transparent; color: var(--dmt-caption);
  font: inherit; font-size: 15px; line-height: 1; cursor: pointer;
}
.dmt-close:hover { background: var(--dmt-hover); color: var(--dmt-text); }
.dmt-pop-body { display: flex; flex-direction: column; gap: 10px; min-height: 0; padding: 10px 12px 12px; overflow-y: auto; }
.dmt-switch-row { display: flex; align-items: flex-start; gap: 10px; padding: 8px 10px; border-radius: 10px;
  background: color-mix(in srgb, var(--dmt-accent) 6%, transparent); }
.dmt-switch-text { display: flex; flex-direction: column; gap: 1px; margin-right: auto; min-width: 0; }
.dmt-switch-title { font-size: 12px; font-weight: 600; }
.dmt-switch-hint { font-size: 10.5px; color: var(--dmt-caption); }
.dmt-switch {
  position: relative; flex: none; width: 32px; height: 18px; margin-top: 1px; padding: 0; border: 0; border-radius: 999px;
  background: color-mix(in srgb, var(--dmt-caption) 35%, transparent); cursor: pointer; transition: background .15s ease;
}
.dmt-switch::after {
  content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: transform .15s ease;
}
.dmt-switch[aria-checked="true"] { background: var(--dmt-accent); }
.dmt-switch[aria-checked="true"]::after { transform: translateX(14px); }
.dmt-switch:disabled { opacity: .5; cursor: default; }
.dmt-tier { display: flex; flex-direction: column; gap: 5px; padding: 8px 10px; border: 1px solid var(--dmt-line); border-radius: 10px; }
.dmt-root[data-off] ~ .dmt-pop .dmt-tier, .dmt-pop[data-off] .dmt-tier { opacity: .55; }
.dmt-tier-head { display: flex; align-items: center; gap: 6px; }
.dmt-tier-name { font-size: 12px; font-weight: 600; }
.dmt-tier-hint { margin-right: auto; font-size: 10.5px; color: var(--dmt-caption); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.dmt-tag { flex: none; font-size: 10px; color: var(--dmt-caption); }
.dmt-reset {
  flex: none; padding: 1px 6px; border: 1px solid var(--dmt-line2); border-radius: 6px; background: transparent;
  color: var(--dmt-text2); font: inherit; font-size: 10px; cursor: pointer;
}
.dmt-reset:hover { background: var(--dmt-hover); }
.dmt-fields { display: grid; grid-template-columns: minmax(0,1fr) 76px; gap: 6px; }
.dmt-fields[data-single] { grid-template-columns: minmax(0,1fr); }
.dmt-select {
  width: 100%; min-width: 0; height: 26px; padding: 0 6px; font: inherit; font-size: 11.5px;
  border: 1px solid var(--dmt-line2); border-radius: 7px; background: transparent; color: var(--dmt-text);
}
.dmt-select:focus-visible { outline: 2px solid var(--dmt-accent); outline-offset: 0; }
.dmt-select option, .dmt-select optgroup { color: #0f1115; background: #fff; }
.dmt-pop-foot { flex: none; padding: 7px 12px 8px; border-top: 1px solid var(--dmt-line); font-size: 10.5px; color: var(--dmt-caption); }
.dmt-pop-foot[data-bad] { color: var(--dmt-bad); }
@media (prefers-reduced-motion: reduce) { .dmt-card, .dmt-switch, .dmt-switch::after { transition: none; } }
`;
function installModelTierStyles() {
  if (typeof document === "undefined") return;
  const existing = document.querySelector('style[data-plugin-css="dsh-model-tiers"]');
  if (existing !== null) {
    existing.textContent = CSS;
    return;
  }
  const tag = document.createElement("style");
  tag.dataset.pluginCss = "dsh-model-tiers";
  tag.textContent = CSS;
  document.head.appendChild(tag);
}
function usePlacement(open, anchor) {
  const [placement, setPlacement] = (0, import_react5.useState)(null);
  (0, import_react5.useEffect)(() => {
    if (!open) return;
    const place = () => {
      const box = anchor.current?.getBoundingClientRect();
      if (box === void 0) return;
      const width = Math.min(340, Math.max(280, window.innerWidth - 24));
      setPlacement({
        left: Math.min(Math.max(8, box.left), Math.max(8, window.innerWidth - width - 8)),
        bottom: Math.max(8, window.innerHeight - box.top + 6),
        width,
        maxHeight: Math.max(260, Math.min(box.top - 12, 680))
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchor]);
  return open ? placement : null;
}
function ModelTiers({ wide = true }) {
  const [doc, setDoc] = (0, import_react5.useState)(null);
  const [msg, setMsg] = (0, import_react5.useState)(null);
  const [busy, setBusy] = (0, import_react5.useState)(false);
  const [open, setOpen] = (0, import_react5.useState)(false);
  const rootRef = (0, import_react5.useRef)(null);
  const popRef = (0, import_react5.useRef)(null);
  const placement = usePlacement(open, rootRef);
  const load = (0, import_react5.useCallback)(async () => {
    try {
      const response = await fetch("/api/router/tiers", { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      setDoc(await response.json());
      setMsg((previous) => previous?.bad === true ? null : previous);
    } catch (error) {
      setMsg({ text: `\u8BFB\u53D6\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`, bad: true });
    }
  }, []);
  (0, import_react5.useEffect)(() => {
    void load();
  }, [load]);
  (0, import_react5.useEffect)(() => {
    if (msg === null || msg.bad === true || busy) return;
    const timer = setTimeout(() => {
      setMsg((previous) => previous === msg ? null : previous);
    }, 4e3);
    return () => {
      clearTimeout(timer);
    };
  }, [msg, busy]);
  (0, import_react5.useEffect)(() => {
    if (open) void load();
  }, [open, load]);
  const save = (0, import_react5.useCallback)(async (body, done) => {
    setBusy(true);
    setMsg({ text: "\u4FDD\u5B58\u4E2D\u2026" });
    try {
      const response = await fetch("/api/router/tiers", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const text = await response.text();
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        value = void 0;
      }
      if (!response.ok || value === void 0) throw new Error(value?.error?.message ?? `HTTP ${String(response.status)}`);
      setDoc(value);
      setMsg({ text: done });
    } catch (error) {
      setMsg({ text: `\u4FDD\u5B58\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`, bad: true });
    } finally {
      setBusy(false);
    }
  }, []);
  (0, import_react5.useEffect)(() => {
    if (!open) return;
    const onPointerDown = (event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target) === true || popRef.current?.contains(target) === true) return;
      setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
  const groups = (0, import_react5.useMemo)(() => {
    const out = [];
    for (const model of doc?.models ?? []) {
      const group = out.find((entry) => entry.name === model.providerName);
      if (group === void 0) out.push({ name: model.providerName, models: [model] });
      else group.models.push(model);
    }
    return out;
  }, [doc]);
  const optionOf = (route) => doc?.models.find((entry) => keyOf(entry) === keyOf(route));
  const labelOf = (route) => {
    if (route == null) return "\u9ED8\u8BA4\u6A21\u578B";
    const option = optionOf(route);
    return shortName(option?.name ?? route.model);
  };
  if (!wide) return null;
  const auto = doc?.auto ?? true;
  const offAttr = doc !== null && !auto ? { "data-off": "" } : {};
  return /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { className: "dmt-root", "data-model-tiers": "", ref: rootRef, ...offAttr, children: [
    /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(
      "button",
      {
        type: "button",
        className: "dmt-card",
        "aria-expanded": open,
        "aria-label": open ? "\u6536\u8D77\u6A21\u578B\u6863\u4F4D\u8BBE\u7F6E" : "\u5C55\u5F00\u6A21\u578B\u6863\u4F4D\u8BBE\u7F6E",
        onClick: () => {
          setOpen((previous) => !previous);
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("span", { className: "dmt-head", children: [
            /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("span", { className: "dmt-title", children: "\u6A21\u578B\u6863\u4F4D" }),
            /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("span", { className: "dmt-badge", ...auto ? { "data-on": "" } : {}, children: doc === null ? "\u2026" : auto ? "\u81EA\u52A8\u9009\u62E9" : "\u5DF2\u5173\u95ED" }),
            /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("span", { className: "dmt-caret", "aria-hidden": true, children: open ? "\u25BE" : "\u25B4" })
          ] }),
          doc === null ? /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("span", { className: "dmt-note", ...msg?.bad === true ? { "data-bad": "" } : {}, children: msg?.text ?? "\u52A0\u8F7D\u4E2D\u2026" }) : /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("span", { className: "dmt-lines", children: TIERS.map((tier) => {
            const route = doc.effective[tier];
            const effort = route?.reasoningEffort;
            return /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("span", { className: "dmt-line", title: route == null ? "" : `${optionOf(route)?.providerName ?? route.provider} \xB7 ${route.model}`, children: [
              /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("span", { className: "dmt-dot", "data-tier": tier }),
              /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("span", { className: "dmt-line-label", children: LABEL[tier] }),
              /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("span", { className: "dmt-line-model", children: [
                labelOf(route),
                effort === void 0 ? "" : ` \xB7 ${EFFORT_LABEL[effort] ?? effort}`
              ] })
            ] }, tier);
          }) })
        ]
      }
    ),
    placement === null ? null : /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(
      "div",
      {
        ref: popRef,
        className: "dmt-pop",
        role: "dialog",
        "aria-label": "\u6A21\u578B\u6863\u4F4D",
        ...offAttr,
        style: { left: placement.left, bottom: placement.bottom, width: placement.width, maxHeight: placement.maxHeight },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { className: "dmt-pop-head", children: [
            /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("span", { className: "dmt-pop-title", children: "\u6A21\u578B\u6863\u4F4D" }),
            /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("button", { type: "button", className: "dmt-close", "aria-label": "\u5173\u95ED", onClick: () => {
              setOpen(false);
            }, children: "\xD7" })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { className: "dmt-pop-body", children: [
            /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { className: "dmt-switch-row", children: [
              /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("span", { className: "dmt-switch-text", children: [
                /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("span", { className: "dmt-switch-title", children: "\u81EA\u52A8\u6309\u96BE\u5EA6\u9009\u62E9" }),
                /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("span", { className: "dmt-switch-hint", children: auto ? "\u6D3E\u4EFB\u52A1\u65F6\u5148\u5224\u65AD\u96BE\u5EA6\uFF0C\u518D\u7528\u5BF9\u5E94\u6863\u4F4D\u7684\u6A21\u578B" : `\u5DF2\u5173\u95ED\uFF1A\u6240\u6709\u4EFB\u52A1\u4F7F\u7528\u9ED8\u8BA4\u6A21\u578B ${labelOf(doc?.defaultModel)}` })
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(
                "button",
                {
                  type: "button",
                  role: "switch",
                  className: "dmt-switch",
                  "data-tier-auto": "",
                  "aria-checked": auto,
                  "aria-label": "\u81EA\u52A8\u6309\u96BE\u5EA6\u9009\u62E9",
                  disabled: doc === null || busy,
                  onClick: () => {
                    void save({ auto: !auto }, auto ? "\u5DF2\u5173\u95ED\u81EA\u52A8\u9009\u62E9" : "\u5DF2\u5F00\u542F\u81EA\u52A8\u9009\u62E9");
                  }
                }
              )
            ] }),
            doc === null ? /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("div", { className: "dmt-note", children: "\u52A0\u8F7D\u4E2D\u2026" }) : TIERS.map((tier) => {
              const route = doc.effective[tier];
              const option = optionOf(route);
              const efforts = option?.efforts ?? [];
              const saved = doc.saved[tier] !== void 0;
              return /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { className: "dmt-tier", "data-tier-block": tier, children: [
                /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { className: "dmt-tier-head", children: [
                  /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("span", { className: "dmt-dot", "data-tier": tier }),
                  /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("span", { className: "dmt-tier-name", children: LABEL[tier] }),
                  /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("span", { className: "dmt-tier-hint", title: HINT[tier], children: HINT[tier] }),
                  saved ? /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(
                    "button",
                    {
                      type: "button",
                      className: "dmt-reset",
                      disabled: busy,
                      onClick: () => {
                        void save({ tiers: { [tier]: null } }, `${LABEL[tier]}\u5DF2\u6062\u590D\u9ED8\u8BA4`);
                      },
                      children: "\u6062\u590D\u9ED8\u8BA4"
                    }
                  ) : /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("span", { className: "dmt-tag", children: "\u9ED8\u8BA4" })
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { className: "dmt-fields", ...efforts.length === 0 ? { "data-single": "" } : {}, children: [
                  /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(
                    "select",
                    {
                      className: "dmt-select",
                      "data-tier": tier,
                      "aria-label": `${LABEL[tier]}\u6A21\u578B`,
                      disabled: busy,
                      value: keyOf(route),
                      onChange: (event) => {
                        const next = doc.models.find((entry) => keyOf(entry) === event.currentTarget.value);
                        if (next === void 0) return;
                        const keep = route?.reasoningEffort !== void 0 && (next.efforts ?? []).includes(route.reasoningEffort);
                        void save({
                          tiers: { [tier]: { provider: next.provider, model: next.model, ...keep ? { reasoningEffort: route?.reasoningEffort } : {} } }
                        }, `${LABEL[tier]}\u5DF2\u6539\u4E3A ${shortName(next.name)}\uFF0C\u4E0B\u4E00\u4E2A\u4EFB\u52A1\u751F\u6548`);
                      },
                      children: [
                        option === void 0 ? /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("option", { value: keyOf(route), children: route == null ? "\uFF08\u9ED8\u8BA4\u6A21\u578B\uFF09" : `${route.model}\uFF08\u4E0D\u53EF\u7528\uFF09` }) : null,
                        groups.map((group) => /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("optgroup", { label: group.name, children: group.models.map((entry) => /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("option", { value: keyOf(entry), children: shortName(entry.name) }, keyOf(entry))) }, group.name))
                      ]
                    }
                  ),
                  efforts.length === 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(
                    "select",
                    {
                      className: "dmt-select",
                      "data-tier-effort": tier,
                      "aria-label": `${LABEL[tier]}\u63A8\u7406\u5F3A\u5EA6`,
                      disabled: busy || route == null,
                      value: route?.reasoningEffort ?? "",
                      onChange: (event) => {
                        if (route == null) return;
                        const value = event.currentTarget.value;
                        void save({
                          tiers: { [tier]: { provider: route.provider, model: route.model, ...value === "" ? {} : { reasoningEffort: value } } }
                        }, `${LABEL[tier]}\u63A8\u7406\u5F3A\u5EA6\u5DF2\u4FDD\u5B58`);
                      },
                      children: [
                        /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("option", { value: "", children: "\u63A8\u7406\uFF1A\u9ED8\u8BA4" }),
                        efforts.map((effort) => /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("option", { value: effort, children: `\u63A8\u7406\uFF1A${EFFORT_LABEL[effort] ?? effort}` }, effort))
                      ]
                    }
                  )
                ] })
              ] }, tier);
            })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("div", { className: "dmt-pop-foot", ...msg?.bad === true ? { "data-bad": "" } : {}, children: msg?.text ?? "\u4FEE\u6539\u7ACB\u5373\u4FDD\u5B58\uFF0C\u4ECE\u4E0B\u4E00\u4E2A\u6D3E\u51FA\u7684\u4EFB\u52A1\u5F00\u59CB\u751F\u6548" })
        ]
      }
    )
  ] });
}

// src/client/locales.ts
var NS = "router.board";
var zh = {
  "panel.title": "\u4EFB\u52A1\u677F",
  "panel.subtitle": "{partitions} \u4E2A\u5206\u533A \xB7 {workers} \u4E2A worker",
  "board.updated": "\u66F4\u65B0\u4E8E {time}",
  "board.mock": "\u793A\u4F8B\u6570\u636E",
  "board.mock.hint": "\u5BBF\u4E3B\u4FA7\u7684 router \u672A\u63A5\u5165\uFF0C\u4E0B\u9762\u662F\u5185\u7F6E\u793A\u4F8B\u6570\u636E",
  "board.error": "\u8BFB\u53D6\u5931\u8D25\uFF1A{message}",
  "board.retry": "\u91CD\u8BD5",
  "board.refresh": "\u5237\u65B0",
  "board.refreshing": "\u5237\u65B0\u4E2D\u2026",
  "seg.waiting": "\u6709 {n} \u4E2A\u4EFB\u52A1\u5728\u7B49\u4F60\u8F93\u5165",
  "board.loading": "\u6B63\u5728\u8BFB\u53D6\u4EFB\u52A1\u677F\u2026",
  "board.empty": "\u8FD9\u4E2A\u72B6\u6001\u6682\u65F6\u6CA1\u6709\u4EFB\u52A1",
  "board.stale": "\u5BBF\u4E3B\u6682\u65F6\u8BFB\u4E0D\u5230\uFF0C\u4EE5\u4E0B\u662F\u4E0A\u6B21\u7ED3\u679C",
  "tab.active": "\u73B0\u5728",
  "tab.next": "\u6392\u961F",
  "tab.scheduled": "\u6392\u7A0B",
  "tab.resolved": "\u5DF2\u7ED3\u675F",
  "tab.active.hint": "\u6B63\u5728\u8DD1\u7684",
  "tab.next.hint": "\u7B49\u6D3E\u5DE5\u7684\uFF0C\u548C\u9000\u56DE\u91CD\u505A\u7684",
  "tab.scheduled.hint": "\u6392\u4E86\u65F6\u95F4\uFF0C\u8FD8\u6CA1\u5F00\u59CB",
  "tab.resolved.hint": "\u5DF2\u5B8C\u6210\u7684",
  "lane.queued": "\u5F85\u6D3E",
  "lane.running": "\u8FDB\u884C\u4E2D",
  "lane.rejected": "\u9000\u56DE\u91CD\u505A",
  "lane.reported": "\u5DF2\u5B8C\u6210",
  "lane.scheduled": "\u6392\u7A0B",
  "lane.verified": "\u5DF2\u5B8C\u6210",
  "lane.queued.hint": "\u5DF2\u63A5\u6536\uFF0C\u7B49 manager \u6D3E\u7ED9 worker",
  "lane.running.hint": "worker \u6B63\u5728\u505A",
  "lane.rejected.hint": "\u5931\u8D25\u6216\u5DF2\u53D6\u6D88",
  "lane.reported.hint": "worker \u5DF2\u5B8C\u6210\u5E76\u6C47\u62A5",
  "lane.scheduled.hint": "\u5230\u70B9\u624D\u6D3E",
  "lane.verified.hint": "worker \u5DF2\u5B8C\u6210\u5E76\u6C47\u62A5\uFF0C\u7ED3\u679C\u5728\u4F5C\u6218\u5BA4\u5BF9\u8BDD\u91CC",
  "roster.title": "\u5206\u533A\u82B1\u540D\u518C",
  "roster.manager": "manager",
  "roster.workers": "{count} worker",
  "roster.awaiting": "{count} \u5DF2\u5B8C\u6210",
  "presence.online": "\u5728\u7EBF",
  "presence.busy": "\u5FD9",
  "presence.offline": "\u79BB\u7EBF",
  "presence.released": "\u5DF2\u91CA\u653E",
  "presence.released.hint": "\u4E0D\u5360\u7528\u673A\u5668",
  "rail.title": "\u9879\u76EE",
  "rail.all": "\u5168\u90E8",
  "rail.selected": "\u53EA\u770B {name}",
  "rail.new": "\u65B0\u5EFA\u5206\u533A",
  "rail.name.placeholder": "\u5206\u533A\u540D\uFF0C\u4F8B\u5982 slidecraft",
  "rail.create": "\u5EFA\u7ACB",
  "rail.cancel": "\u53D6\u6D88",
  "rail.enable": "\u542F\u7528",
  "rail.disable": "\u505C\u7528",
  "rail.disabled": "\u5DF2\u505C\u7528",
  "rail.unwired": "\u5BBF\u4E3B\u672A\u63D0\u4F9B\u8FD9\u4E2A\u64CD\u4F5C\uFF0C\u672A\u63D0\u4EA4",
  "rail.filter.clear": "\u770B\u5168\u90E8",
  "rail.open": "\u5C55\u5F00\u9879\u76EE\u680F",
  "rail.close": "\u6536\u8D77\u9879\u76EE\u680F",
  "rail.filtering": "\u6B63\u5728\u8FC7\u6EE4\uFF1A{name}",
  "rail.filter.clearTitle": "\u6E05\u9664\u8FC7\u6EE4\uFF0C\u663E\u793A\u5168\u90E8",
  "apiKey.title": "API Key",
  "apiKey.configured": "\u5DF2\u914D\u7F6E",
  "apiKey.missing": "\u672A\u914D\u7F6E",
  "apiKey.unknown": "\u672A\u77E5",
  "apiKey.source.file": "\u6765\u81EA\u51ED\u636E\u6587\u4EF6",
  "apiKey.source.env": "\u6765\u81EA\u73AF\u5883\u53D8\u91CF",
  "apiKey.source.unset": "\u6CA1\u6709\u503C",
  "apiKey.where": "\u5728 \u8BBE\u7F6E \xB7 \u6A21\u578B \u91CC\u914D\u7F6E",
  "apiKey.edit": "\u914D\u7F6E",
  "apiKey.save": "\u4FDD\u5B58",
  "apiKey.value": "\u7C98\u8D34 API Key",
  "apiKey.readonly": "\u5BBF\u4E3B\u672A\u63D0\u4F9B\u51ED\u636E\u5199\u5165",
  "apiKey.saved": "\u5DF2\u63D0\u4EA4",
  "apiKey.none": "\u5BBF\u4E3B\u672A\u62A5\u544A\u51ED\u636E",
  "apiKey.writing": "\u63D0\u4EA4\u4E2D\u2026",
  "state.queued": "\u5F85\u6D3E",
  "state.running": "\u8FDB\u884C\u4E2D",
  "state.reported": "\u5DF2\u5B8C\u6210",
  "state.verified": "\u5DF2\u5B8C\u6210",
  "state.rejected": "\u5931\u8D25",
  "status.running": "\u8FDB\u884C\u4E2D",
  "status.blocked": "\u9700\u8981\u8F93\u5165",
  "status.queued": "\u6392\u961F\u4E2D",
  "status.resuming": "\u91CD\u542F\u540E\u7EED\u4F5C\u4E2D",
  "status.done": "\u5DF2\u5B8C\u6210",
  "status.failed": "\u5931\u8D25",
  "status.aborted": "\u5DF2\u4E2D\u65AD",
  "status.cancelled": "\u5DF2\u53D6\u6D88",
  "status.stale": "\u5DF2\u5931\u6548",
  "task.attempt": "\u7B2C {count} \u6B21\u5C1D\u8BD5",
  "task.verify": "\u5DF2\u5B8C\u6210",
  "task.reject": "\u9000\u56DE",
  "task.reject.reason": "\u9000\u56DE\u539F\u56E0",
  "task.openSession": "\u6253\u5F00 worker \u4F1A\u8BDD",
  "task.noTodos": "worker \u8FD8\u6CA1\u5199\u5DE5\u4F5C\u6E05\u5355",
  "task.reportedAt": "\u5B8C\u6210\u4E8E {time}",
  "task.verifiedAt": "\u5B8C\u6210\u4E8E {time}",
  "task.expand": "\u5C55\u5F00\u8BE6\u60C5",
  "task.collapse": "\u6536\u8D77\u8BE6\u60C5",
  "task.newDemand": "\u53D1\u8D77\u9700\u6C42",
  "task.verifications": "{count} \u6761\u5DF2\u5B8C\u6210",
  "todo.title": "\u5DE5\u4F5C\u6E05\u5355",
  "todo.progress": "{done}/{total}",
  "todo.current": "\u6B63\u5728\u505A\uFF1A{content}",
  "todo.idle": "\u6CA1\u6709\u8FDB\u884C\u4E2D\u7684\u6B65\u9AA4",
  "demand.title": "\u5BF9\u4F5C\u6218\u5BA4\u8BF4",
  "warroom.open": "\u6253\u5F00\u4F5C\u6218\u5BA4\u5BF9\u8BDD",
  "warroom.opening": "\u6B63\u5728\u6253\u5F00\u4F5C\u6218\u5BA4\u5BF9\u8BDD\u2026",
  "compact.running": "\u8FDB\u884C\u4E2D",
  "compact.queued": "\u6392\u961F",
  "compact.done": "\u5DF2\u5B8C\u6210",
  "compact.failed": "\u5931\u8D25/\u53D6\u6D88",
  "compact.history": "\u5386\u53F2 {n} \u6761",
  "compact.staleGroup": "\u5DF2\u5931\u6548\u5206\u533A",
  "compact.calls": "\u5DF2\u8C03\u7528\u5DE5\u5177 {n} \u6B21",
  "compact.warroom": "\u4F5C\u6218\u5BA4",
  "compact.noWorker": "\u6CA1\u6709\u6D3E\u51FA worker",
  "compact.noWorkerYet": "\u6B63\u5728\u6D3E worker\u2026",
  "compact.partIdle": "\u6682\u65E0\u4EFB\u52A1",
  "compact.stale": "\u5DF2\u5931\u6548",
  "compact.all": "\u5168\u90E8",
  "compact.workers": "{n} \u4E2A worker",
  "compact.more": "\u66F4\u591A\uFF08\u8FD8\u6709 {n} \u6761\uFF09",
  "compact.empty": "\u6CA1\u6709\u4EFB\u52A1",
  "compact.state.running": "\u8FD0\u884C\u4E2D",
  "compact.state.queued": "\u6392\u961F",
  "compact.state.done": "\u5DF2\u5B8C\u6210",
  "compact.state.failed": "\u5931\u8D25/\u53D6\u6D88",
  "compact.state.stale": "\u5DF2\u5931\u6548",
  // Right-Sidebar task rail: segment strip, group captions, header actions.
  "board.title": "\u4EFB\u52A1",
  "seg.active": "\u8FDB\u884C\u4E2D",
  "seg.next": "\u63A5\u4E0B\u6765",
  "seg.scheduled": "\u6392\u7A0B\u4EFB\u52A1",
  "seg.resolved": "\u5DF2\u7ED3\u675F",
  "grp.running": "\u8FDB\u884C\u4E2D",
  "grp.blocked": "\u5DF2\u6302\u8D77 \xB7 \u9700\u8981\u8F93\u5165",
  "hold.reason": "\u6302\u8D77\u539F\u56E0\uFF1A{reason}",
  "hold.noReason": "\u6302\u8D77\u539F\u56E0\uFF1A\u672A\u586B\u5199",
  "hold.resume": "\u6062\u590D",
  "hold.resuming": "\u6062\u590D\u4E2D\u2026",
  "hold.resumeHint": "\u8C03\u7528 task_control resume\uFF0C\u5728\u539F\u4F1A\u8BDD\u91CC\u7EE7\u7EED\u8FD9\u4E2A\u4EFB\u52A1",
  "hold.notWired": "\u5F53\u524D\u6570\u636E\u6E90\u4E0D\u652F\u6301\u6062\u590D\u64CD\u4F5C",
  "hold.resumed": "\u5DF2\u6062\u590D\uFF1A{title}",
  "hold.resumeFailed": "\u6062\u590D\u5931\u8D25\uFF1A{message}",
  "hold.resumeFailedShort": "\u6062\u590D\u5931\u8D25",
  "grp.queued": "\u6392\u961F\u4E2D",
  "grp.stale": "\u5DF2\u5931\u6548\u5206\u533A",
  "grp.done": "\u5DF2\u5B8C\u6210",
  "grp.failed": "\u5931\u8D25",
  "grp.cancelled": "\u5DF2\u53D6\u6D88",
  "compact.shown": "\u5DF2\u663E\u793A {n}/{m}",
  "compact.foldedHint": "\u5DF2\u6298\u53E0 \xB7 \u663E\u793A 0/{n}",
  "compact.less": "\u6536\u8D77",
  "board.lastOk": "\u4E0B\u9762\u662F\u4E0A\u6B21\u6210\u529F\u8BFB\u53D6\u4E8E {time} \u7684\u6570\u636E",
  "board.emptyOnError": "\u6CA1\u6709\u53EF\u663E\u793A\u7684\u6570\u636E\uFF0C\u8BF7\u91CD\u8BD5",
  "compact.retry": "\u7B2C {n} \u6B21",
  "compact.family": "\u8FD9\u4E2A\u4EFB\u52A1\u65CF\u5171 {n} \u4E2A\u4EFB\u52A1\uFF0C\u70B9\u5F00\u67E5\u770B",
  "compact.familyTotal": "\u6309\u4EFB\u52A1\u65CF\u8BA1\u6570\uFF1A{n} \u4E2A\u4EFB\u52A1",
  "board.close": "\u5173\u95ED\u9762\u677F",
  "board.newTask": "\u65B0\u5EFA\u4EFB\u52A1",
  "demand.placeholder": "\u50CF\u804A\u5929\u4E00\u6837\u8BF4\u4F60\u7684\u4EFB\u52A1\uFF0C\u53D1\u5230\u4F5C\u6218\u5BA4\u5BF9\u8BDD\n\u4F8B\u5982\uFF1A\u5E2E\u6211\u6253\u5F00 https://example.com \u622A\u4E2A\u56FE",
  "demand.submit": "\u53D1\u9001",
  "demand.submitting": "\u53D1\u9001\u4E2D\u2026",
  "demand.hint": "\u53D1\u5230\u4F5C\u6218\u5BA4 \xB7 \u7531\u5B83\u6D3E\u7ED9\u5206\u533A\uFF0C\u505A\u5B8C\u5728\u5BF9\u8BDD\u91CC\u56DE\u590D",
  "demand.empty": "\u5148\u5199\u4E00\u6761\u9700\u6C42",
  "demand.published": "\u5DF2\u53D1\u5230\u4F5C\u6218\u5BA4\uFF0C\u7ED3\u679C\u4F1A\u5728\u5BF9\u8BDD\u91CC\u56DE\u590D",
  "demand.unrouted": "\u5F85\u5B9A\u5206\u533A",
  "artifact.title": "\u4EA7\u7269",
  "artifact.download": "\u4E0B\u8F7D",
  "workers.idle": "\u7A7A\u95F2",
  "workers.none": "\u6682\u65E0 worker"
};
var en = {
  "panel.title": "Task board",
  "panel.subtitle": "{partitions} partitions \xB7 {workers} workers",
  "board.updated": "updated {time}",
  "board.mock": "sample",
  "board.mock.hint": "the host router is not connected; this is built-in sample data",
  "board.error": "read failed: {message}",
  "board.retry": "Retry",
  "board.refresh": "Refresh",
  "board.refreshing": "Refreshing\u2026",
  "seg.waiting": "{n} task(s) waiting on your input",
  "board.loading": "Reading the board\u2026",
  "board.empty": "Nothing in this state",
  "board.stale": "Host unreachable; showing the last result",
  "tab.active": "Active",
  "tab.next": "Up next",
  "tab.scheduled": "Scheduled",
  "tab.resolved": "Resolved",
  "tab.active.hint": "running now",
  "tab.next.hint": "waiting for a worker, plus what was sent back",
  "tab.scheduled.hint": "deferred to a later start",
  "tab.resolved.hint": "finished",
  "lane.queued": "Dispatch",
  "lane.running": "Running",
  "lane.rejected": "Sent back",
  "lane.reported": "Done",
  "lane.scheduled": "Scheduled",
  "lane.verified": "Done",
  "lane.queued.hint": "accepted, waiting for a worker",
  "lane.running.hint": "a worker is on it",
  "lane.rejected.hint": "failed or cancelled",
  "lane.reported.hint": "worker finished and reported",
  "lane.scheduled.hint": "dispatched at its start time",
  "lane.verified.hint": "worker finished; the report is in the war-room chat",
  "roster.title": "Partitions",
  "roster.manager": "manager",
  "roster.workers": "{count} workers",
  "roster.awaiting": "{count} done",
  "presence.online": "online",
  "presence.busy": "busy",
  "presence.offline": "offline",
  "presence.released": "released",
  "presence.released.hint": "holds no machine",
  "rail.title": "Projects",
  "rail.all": "Everything",
  "rail.selected": "only {name}",
  "rail.new": "New partition",
  "rail.name.placeholder": "partition name, e.g. slidecraft",
  "rail.create": "Create",
  "rail.cancel": "Cancel",
  "rail.enable": "Enable",
  "rail.disable": "Disable",
  "rail.disabled": "disabled",
  "rail.unwired": "the host does not implement this action; nothing was sent",
  "rail.filter.clear": "Show all",
  "rail.open": "Show projects",
  "rail.close": "Hide projects",
  "rail.filtering": "Filtering: {name}",
  "rail.filter.clearTitle": "Clear the filter and show everything",
  "apiKey.title": "API Key",
  "apiKey.configured": "configured",
  "apiKey.missing": "missing",
  "apiKey.unknown": "unknown",
  "apiKey.source.file": "from the credentials file",
  "apiKey.source.env": "from the environment",
  "apiKey.source.unset": "no value",
  "apiKey.where": "configure in Settings \xB7 Models",
  "apiKey.edit": "Set",
  "apiKey.save": "Save",
  "apiKey.value": "paste the API key",
  "apiKey.readonly": "the host exposes no credential write",
  "apiKey.saved": "sent",
  "apiKey.none": "the host reports no credentials",
  "apiKey.writing": "sending\u2026",
  "state.queued": "Queued",
  "state.running": "Running",
  "state.reported": "Done",
  "state.verified": "Done",
  "state.rejected": "Rejected",
  "status.running": "Running",
  "status.blocked": "Needs input",
  "status.queued": "Queued",
  "status.resuming": "Resuming after restart",
  "status.done": "Done",
  "status.failed": "Failed",
  "status.aborted": "Interrupted",
  "status.cancelled": "Cancelled",
  "status.stale": "Removed",
  "task.attempt": "attempt {count}",
  "task.verify": "Done",
  "task.reject": "Send back",
  "task.reject.reason": "Reason",
  "task.openSession": "Open worker session",
  "task.noTodos": "the worker has not written a checklist yet",
  "task.reportedAt": "finished {time}",
  "task.verifiedAt": "finished {time}",
  "task.expand": "Show details",
  "task.collapse": "Hide details",
  "task.newDemand": "Post a demand",
  "task.verifications": "{count} waiting on you",
  "todo.title": "Checklist",
  "todo.progress": "{done}/{total}",
  "todo.current": "Now: {content}",
  "todo.idle": "no step in progress",
  "demand.title": "Tell the war room",
  "warroom.open": "Open war-room chat",
  "warroom.opening": "Opening the war-room chat\u2026",
  "compact.running": "Running",
  "compact.queued": "Queued",
  "compact.done": "Done",
  "compact.failed": "Failed/cancelled",
  "compact.history": "History ({n})",
  "compact.staleGroup": "Removed partitions",
  "compact.calls": "{n} tool calls",
  "compact.warroom": "War room",
  "compact.noWorker": "No worker dispatched",
  "compact.noWorkerYet": "Dispatching a worker\u2026",
  "compact.partIdle": "No tasks",
  "compact.stale": "Stale",
  "compact.all": "All",
  "compact.workers": "{n} workers",
  "compact.more": "More ({n} left)",
  "compact.empty": "No tasks",
  "compact.state.running": "Running",
  "compact.state.queued": "Queued",
  "compact.state.done": "Done",
  "compact.state.failed": "Failed/cancelled",
  "compact.state.stale": "Stale",
  // Right-Sidebar task rail: segment strip, group captions, header actions.
  "board.title": "Tasks",
  "seg.active": "Active",
  "seg.next": "Up next",
  "seg.scheduled": "Scheduled",
  "seg.resolved": "Resolved",
  "grp.running": "Running",
  "grp.blocked": "Paused \xB7 needs input",
  "hold.reason": "Paused: {reason}",
  "hold.noReason": "Paused: no reason given",
  "hold.resume": "Resume",
  "hold.resuming": "Resuming\u2026",
  "hold.resumeHint": "Send task_control resume and continue this task in its own session",
  "hold.notWired": "This data source cannot resume tasks",
  "hold.resumed": "Resumed: {title}",
  "hold.resumeFailed": "Resume failed: {message}",
  "hold.resumeFailedShort": "Resume failed",
  "grp.queued": "Up next",
  "grp.stale": "Removed partitions",
  "grp.done": "Done",
  "grp.failed": "Failed",
  "grp.cancelled": "Cancelled",
  "compact.shown": "showing {n}/{m}",
  "compact.foldedHint": "folded \xB7 showing 0/{n}",
  "compact.less": "Show less",
  "board.lastOk": "Below: data last read successfully at {time}",
  "board.emptyOnError": "Nothing to show yet; try again",
  "compact.retry": "try {n}",
  "compact.family": "This task family holds {n} tasks; open it to see them",
  "compact.familyTotal": "Counted by task family; {n} tasks in all",
  "board.close": "Close panel",
  "board.newTask": "New task",
  "demand.placeholder": "One demand per line; the router picks the partition\nfor example: make the failing go build cases pass",
  "demand.submit": "Post",
  "demand.submitting": "Posting\u2026",
  "demand.hint": "sent to the war-room chat, which dispatches and replies",
  "demand.empty": "Write a demand first",
  "demand.published": "sent to the war room; the reply arrives in the chat",
  "demand.unrouted": "partition pending",
  "artifact.title": "Artifacts",
  "artifact.download": "Download",
  "workers.idle": "idle",
  "workers.none": "no workers"
};
var DICTIONARIES = { zh, en };

// src/client/mock.ts
var worker = (id, name, presence, extra = {}) => ({ id, name, presence, ...extra });
var manager = (id, name, presence, dispatched, awaitingVerification) => ({ id, name, presence, dispatched, awaitingVerification });
var partitions = [
  {
    id: "rca-ab-test",
    name: "rca-ab-test",
    repo: "E:/PythonProject/rca-ab-test",
    manager: manager("mgr-rca", "manager", "online", 3, 1),
    workers: [
      worker("w-rca-1", "worker-1", "busy", { sessionId: "ses_rca1", activity: "go build", elapsedSeconds: 318 }),
      worker("w-rca-2", "worker-2", "released", { sessionId: "ses_rca2" }),
      worker("w-rca-3", "worker-3", "released", { sessionId: "ses_rca3" }),
      worker("w-rca-4", "worker-4", "busy", { sessionId: "ses_rca4", activity: "pytest -q", elapsedSeconds: 96 })
    ]
  },
  {
    id: "deepseek-harness",
    name: "deepseek-harness",
    repo: "E:/PythonProject/deepseek-harness-latest",
    manager: manager("mgr-harness", "manager", "busy", 5, 0),
    workers: [
      worker("w-h-1", "worker-1", "online", { sessionId: "ses_h1" }),
      worker("w-h-2", "worker-2", "offline", { sessionId: "ses_h2" }),
      worker("w-h-3", "worker-3", "busy", { sessionId: "ses_h3", activity: "tsc -b", elapsedSeconds: 44 })
    ]
  },
  {
    id: "slidecraft",
    name: "slidecraft",
    repo: "E:/PythonProject/slidecraft",
    // The sample keeps one partition switched off so the rail's control and its
    // muted row are visible without a Host that implements the switch.
    enabled: false,
    manager: manager("mgr-slide", "manager", "online", 1, 0),
    workers: [
      worker("w-s-1", "worker-1", "online", { sessionId: "ses_s1" }),
      worker("w-s-2", "worker-2", "released", { sessionId: "ses_s2" })
    ]
  }
];

// src/client/source.ts
var PANEL_STATES = /* @__PURE__ */ new Set(["queued", "running", "reported", "verified", "rejected"]);
var HOST_TO_PANEL = {
  dispatched: "running",
  interrupted: "running",
  blocked: "queued",
  done: "verified",
  failed: "rejected",
  cancelled: "rejected"
};
function normalizeTask(task) {
  const raw = task.state;
  if (PANEL_STATES.has(raw)) return task;
  const projected = HOST_TO_PANEL[raw] ?? "queued";
  return { ...task, state: projected, hostState: task.hostState ?? raw };
}
function asBoardSnapshot(value) {
  if (typeof value !== "object" || value === null) return void 0;
  const candidate = value;
  if (!Array.isArray(candidate.partitions) || !Array.isArray(candidate.tasks) || !Array.isArray(candidate.demands)) return void 0;
  return {
    fetchedAt: typeof candidate.fetchedAt === "string" ? candidate.fetchedAt : (/* @__PURE__ */ new Date()).toISOString(),
    partitions: candidate.partitions,
    tasks: candidate.tasks.map(normalizeTask),
    demands: candidate.demands,
    origin: "host",
    ...typeof candidate.staleSince === "string" ? { staleSince: candidate.staleSince } : {},
    // Additive fields are forwarded only when the Host sent them, so a view can
    // tell "the Host did not describe credentials" from "it described none".
    ...Array.isArray(candidate.credentials) ? { credentials: candidate.credentials } : {}
  };
}
function createHostSource(remote, subscribeChanges) {
  return {
    origin: "host",
    async read() {
      const result = await remote.board();
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
      const snapshot = asBoardSnapshot(result.value);
      if (snapshot === void 0) throw new Error("router/board returned a payload that is not a BoardSnapshot");
      return snapshot;
    },
    async publish(demands) {
      const result = await remote.publish({ demands });
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
      return result.value;
    },
    async verify(taskId, verdict, note) {
      const result = await remote.verify({ taskId, verdict, ...note === void 0 ? {} : { note } });
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    },
    subscribe(listener) {
      return subscribeChanges(listener);
    }
  };
}
var BRIDGE_BASE = "/api/router";
var POLL_INTERVAL_MS = 5e3;
function fetchOf(options) {
  if (options.fetchImpl !== void 0) return options.fetchImpl;
  return typeof fetch === "function" ? fetch : void 0;
}
function errorMessageOf(body) {
  if (typeof body !== "object" || body === null) return void 0;
  const error = body.error;
  if (typeof error !== "object" || error === null) return void 0;
  const candidate = error;
  const code = typeof candidate.code === "string" ? candidate.code : void 0;
  const message = typeof candidate.message === "string" ? candidate.message : void 0;
  if (code === void 0 && message === void 0) return void 0;
  return [code, message].filter((part) => part !== void 0).join(": ");
}
var REQUEST_TIMEOUT_MS = 1e4;
var BOARD_TIMEOUT_MS = 9e4;
async function requestJson(doFetch, url, init, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = typeof AbortController === "function" ? new AbortController() : void 0;
  let timedOut = false;
  const timer = controller === void 0 ? void 0 : setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let response;
  let text;
  try {
    response = await doFetch(url, controller === void 0 ? init : { ...init, signal: controller.signal });
    text = await response.text();
  } catch (error) {
    if (timedOut) throw new Error(`router bridge timed out after ${String(timeoutMs / 1e3)}s: ${url}`);
    throw error;
  } finally {
    if (timer !== void 0) clearTimeout(timer);
  }
  let body;
  if (text.trim() !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      body = void 0;
    }
  }
  if (!response.ok) {
    const detail = errorMessageOf(body) ?? (text.trim() === "" ? response.statusText : text.trim().slice(0, 200));
    throw new Error(`router bridge ${String(response.status)}: ${detail === "" ? "no detail" : detail}`);
  }
  return body;
}
function jsonPost(value) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value)
  };
}
function asPublishResult(value) {
  if (typeof value !== "object" || value === null) throw new Error("publish returned a payload that is not a PublishResult");
  const candidate = value;
  if (typeof candidate.accepted !== "number" || !Array.isArray(candidate.routed)) {
    throw new Error("publish returned a payload that is not a PublishResult");
  }
  return { accepted: candidate.accepted, routed: candidate.routed };
}
function createHttpSource(options = {}) {
  const base = options.base ?? BRIDGE_BASE;
  const fallback = options.fallback;
  const doFetch = fetchOf(options);
  let live = false;
  const requireFetch = () => {
    if (doFetch === void 0) throw new Error("this environment has no fetch(); the router bridge is unreachable");
    return doFetch;
  };
  return {
    origin: "host",
    async read() {
      try {
        const payload = await requestJson(requireFetch(), `${base}/board`, {
          headers: { accept: "application/json" }
        }, BOARD_TIMEOUT_MS);
        const snapshot = asBoardSnapshot(payload);
        if (snapshot === void 0) {
          throw new Error("GET /api/router/board returned a payload that is not a BoardSnapshot");
        }
        live = true;
        return snapshot;
      } catch (error) {
        if (live || fallback === void 0) throw error;
        const sample = await fallback.read();
        return { ...sample, staleSince: (/* @__PURE__ */ new Date()).toISOString() };
      }
    },
    async publish(demands) {
      const payload = await requestJson(requireFetch(), `${base}/publish`, jsonPost({ demands }));
      return asPublishResult(payload);
    },
    async verify(taskId, verdict, note) {
      await requestJson(
        requireFetch(),
        `${base}/verify`,
        jsonPost({ taskId, verdict, ...note === void 0 ? {} : { note } })
      );
    },
    async control(taskId, action, value) {
      await requestJson(
        requireFetch(),
        `${base}/control`,
        jsonPost({ taskId, action, ...value === void 0 ? {} : { value } })
      );
    },
    subscribe(listener) {
      let stream;
      let poll;
      const stopPolling = () => {
        if (poll === void 0) return;
        clearInterval(poll);
        poll = void 0;
      };
      const startPolling = () => {
        if (poll !== void 0 || typeof setInterval !== "function") return;
        poll = setInterval(listener, POLL_INTERVAL_MS);
      };
      if (typeof EventSource === "function") {
        try {
          stream = new EventSource(`${base}/events`);
          startPolling();
          stream.addEventListener("hello", stopPolling);
          stream.addEventListener("changed", () => {
            listener();
          });
          stream.onerror = () => {
            startPolling();
          };
        } catch {
          stream = void 0;
          startPolling();
        }
      } else {
        startPolling();
      }
      return () => {
        stopPolling();
        stream?.close();
        stream = void 0;
      };
    }
  };
}
function createHttpActions(options = {}) {
  const base = options.base ?? BRIDGE_BASE;
  const doFetch = fetchOf(options);
  return {
    async setPartitionEnabled(partitionId, enabled) {
      if (doFetch === void 0) throw new Error("this environment has no fetch(); the router bridge is unreachable");
      await requestJson(doFetch, `${base}/partition`, jsonPost({ id: partitionId, enabled }));
    }
  };
}
function resolveSource(factory) {
  return factory === void 0 ? createHttpSource() : factory();
}

// src/client/index.ts
var TAB_ID = "dsh-client-ui-router/board";
var TAB_KIND = "router-board";
var PANEL_ID = "router/routing";
var inject = ["slots", "locale", "sidebarRightTabs", "sidebarRight"];
function boardTabDefinition(t) {
  return {
    id: TAB_ID,
    kind: TAB_KIND,
    priority: "extension",
    // One board for the whole profile, not one per Session: the panel reports on
    // every worker, so a second copy would say the same thing twice.
    multiple: false,
    keepMounted: true,
    title: () => t("panel.title")
  };
}
function apply(ctx) {
  applyInner(ctx);
}
function optionalService(ctx, name) {
  const get = ctx.get;
  if (typeof get !== "function") return void 0;
  return get.call(ctx, name);
}
function safeGet(read) {
  try {
    return read();
  } catch {
    return void 0;
  }
}
var anchorId;
async function openAnchor(ctx) {
  const ui = optionalService(ctx, "uiWorkspace");
  if (ui === void 0) return false;
  if (anchorId === void 0) {
    try {
      const response = await fetch("/api/router/anchor");
      if (!response.ok) return false;
      const body = await response.json();
      if (typeof body.sessionId !== "string") return false;
      anchorId = body.sessionId;
    } catch {
      return false;
    }
  }
  try {
    ui.openSession(anchorId);
    return true;
  } catch {
    return false;
  }
}
function applyInner(ctx) {
  installStyles();
  ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), "client-ui-router: dictionaries");
  const t = ctx.locale.bind(NS);
  ctx.effect(() => ctx.sidebarRightTabs.register(boardTabDefinition(t)), "client-ui-router: tab type");
  const openWarRoom = () => {
    void openAnchor(ctx);
  };
  const toggleBoard = () => {
    const right = ctx.sidebarRight;
    const active = right.active?.();
    if (active !== void 0 && active.kind === TAB_KIND && right.isExpanded?.() === true && right.hide !== void 0) {
      right.hide(active.id);
      return;
    }
    right.openTab(TAB_KIND);
  };
  const closeBoard = () => {
    const right = ctx.sidebarRight;
    const active = right.active?.();
    if (active !== void 0 && active.kind === TAB_KIND && right.hide !== void 0) right.hide(active.id);
  };
  const remote = optionalService(ctx, "remote");
  const router = safeGet(() => remote?.router);
  const credentials = safeGet(() => remote?.credentials);
  const setPartitionEnabled = safeGet(() => router?.setPartitionEnabled);
  const createPartition = safeGet(() => router?.createPartition);
  const hostSource = router === void 0 || remote === void 0 ? void 0 : () => createHostSource(router, (listener) => remote.$on("router/changed", listener));
  const controller = new RouterBoardController(resolveSource(hostSource));
  const bridgeActions = createHttpActions();
  const host = {
    ...credentials === void 0 ? {} : {
      readCredentials: async (refs) => {
        const result = await credentials.describe([...refs]);
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
        return asCredentialViews(refs, result.value);
      },
      writeCredential: async (ref, value) => {
        const result = await credentials.set(ref, value);
        return result.ok ? void 0 : result.error.message;
      }
    },
    ...setPartitionEnabled === void 0 || router === void 0 ? { setPartitionEnabled: bridgeActions.setPartitionEnabled } : {
      setPartitionEnabled: async (partitionId, enabled) => {
        const result = await setPartitionEnabled.call(router, { partitionId, enabled });
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
      }
    },
    ...createPartition === void 0 || router === void 0 ? {} : {
      createPartition: async (name) => {
        const result = await createPartition.call(router, { name });
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
      }
    }
  };
  ctx.effect(() => {
    void controller.load();
    return () => {
      controller.dispose();
    };
  }, "client-ui-router: first read");
  const panelFace = () => {
    const sessions = optionalService(ctx, "sessions");
    const uiWorkspace = optionalService(ctx, "uiWorkspace");
    return {
      controller,
      t,
      host,
      ...sessions === void 0 ? {} : { sessions },
      ...uiWorkspace === void 0 ? {} : { onOpenSession: (sessionId) => {
        uiWorkspace.openSession(sessionId);
      } },
      ...ctx.sidebarRight.openResource === void 0 ? {} : { onDownload: (artifact) => {
        ctx.sidebarRight.openResource?.(artifact.address);
      } }
    };
  };
  ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
    name: "sidebar.right.pane.tab",
    key: TAB_ID,
    locale: NS,
    inject: () => ({ ...panelFace(), onOpenWarRoom: openWarRoom, onClose: closeBoard })
  }, CompactBoard));
  ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
    name: "sidebar.right.pane.tab.title",
    key: TAB_ID,
    locale: NS,
    inject: () => ({ controller, t })
  }, RouterPanelTitle));
  ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
    name: "conversation.session.header.utilities",
    id: "router-board",
    order: -8,
    locale: NS,
    inject: () => ({
      t,
      controller,
      open: toggleBoard
    })
  }, RouterPanelButton));
  ctx.slots.inject("main", () => ctx.slots.register({
    name: "main",
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ t, open: openWarRoom })
  }, WarRoomRedirect));
  ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
    name: "sidebar.panellist",
    id: PANEL_ID,
    order: -40,
    locale: NS,
    label: () => t("warroom.open")
  }, RoutingIcon));
  installModelTierStyles();
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
    name: "sidebar.footer.action",
    id: "model-tiers",
    order: -110
  }, ModelTiers));
  ctx.effect(() => {
    let alive = true;
    void (async () => {
      for (let attempt = 0; attempt < 20 && alive; attempt++) {
        if (await openAnchor(ctx)) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    })();
    return () => {
      alive = false;
    };
  }, "client-ui-router: land on war room");
  replaceBrandSlot(ctx, "sidebar.brand.mark", BrandMark);
  replaceBrandSlot(ctx, "sidebar.brand.name", BrandName);
}
function replaceBrandSlot(ctx, name, component) {
  const slots = ctx.slots;
  if (slots === void 0) return;
  slots.inject(name, () => {
    try {
      return slots.register({ name }, component);
    } catch {
      return () => {
      };
    }
  });
}

return module.exports}});
