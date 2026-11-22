window.__ModuleLoader__.load({id:"dsh-client-ui-secrets",factory:require=>{var module={exports:{}};var exports=module.exports;Object.defineProperty(exports,Symbol.toStringTag,{value:"Module"});
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
var index_exports = {};
__export(index_exports, {
  PANEL_ID: () => PANEL_ID,
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/locales.ts
var NS = "secretsDashboard";
var zh = {
  "page.title": "\u5BC6\u94A5\u770B\u677F",
  "page.nav": "\u5BC6\u94A5",
  "page.subtitle": "\u672C\u673A dsh-secrets \u4FDD\u9669\u5E93\u7684\u53EA\u8BFB\u89C6\u56FE\uFF1A\u540D\u79F0\u3001\u63CF\u8FF0\u3001\u6807\u7B7E\u3001\u6307\u7EB9\u3001\u957F\u5EA6\u4E0E\u66F4\u65B0\u65F6\u95F4\u3002",
  "notice.title": "\u503C\u4E0D\u53EF\u67E5\u770B",
  "notice.body": "\u672C\u9875\u53EA\u663E\u793A\u5143\u6570\u636E\uFF0C\u4EFB\u4F55\u63A5\u53E3\u90FD\u4E0D\u8FD4\u56DE\u5BC6\u94A5\u660E\u6587\u3002\u5BC6\u94A5\u53EA\u80FD\u901A\u8FC7 secret_* \u5DE5\u5177\u4F7F\u7528\uFF1Asecret_exec \u6CE8\u5165\u73AF\u5883\u53D8\u91CF\u3001secret_http \u5728\u8BF7\u6C42\u91CC\u7528 {placeholder} \u5360\u4F4D\u7B26\uFF1B\u6838\u5BF9\u7528 secret_check\u3002",
  "notice.fingerprint": "\u6307\u7EB9 = SHA-256(\u503C) \u7684\u524D 8 \u4F4D\u5341\u516D\u8FDB\u5236\uFF1B\u957F\u5EA6 = \u5B57\u7B26\u6570\u3002\u4E8C\u8005\u7528\u4E8E\u6838\u5BF9\u662F\u5426\u540C\u4E00\u4E2A\u503C\uFF0C\u4E0D\u80FD\u8FD8\u539F\u660E\u6587\u3002",
  "vault.state.unlocked": "\u5DF2\u89E3\u9501",
  "vault.state.missing": "\u5C1A\u672A\u521B\u5EFA",
  "vault.state.locked": "\u5DF2\u9501\u5B9A",
  "vault.state.error": "\u65E0\u6CD5\u8BFB\u53D6",
  "vault.keySource.passphrase-env": "\u4E3B\u5BC6\u94A5\uFF1A\u73AF\u5883\u53D8\u91CF\u53E3\u4EE4",
  "vault.keySource.keyfile": "\u4E3B\u5BC6\u94A5\uFF1Akeyfile",
  "vault.key.configured": "\u4E3B\u5BC6\u94A5\u5DF2\u5C31\u7EEA",
  "vault.key.missing": "\u4E3B\u5BC6\u94A5\u672A\u914D\u7F6E",
  "vault.path": "\u4FDD\u9669\u5E93\u6587\u4EF6\uFF1A{path}",
  "vault.count": "\u5171 {total} \u4E2A\u5BC6\u94A5",
  "vault.lastUpdated": "\u6700\u8FD1\u66F4\u65B0 {time}",
  "locked.title": "\u4FDD\u9669\u5E93\u5DF2\u9501\u5B9A\uFF0C\u65E0\u6CD5\u5217\u51FA\u5BC6\u94A5",
  "locked.key-missing": "\u670D\u52A1\u8FDB\u7A0B\u91CC\u6CA1\u6709\u4E3B\u5BC6\u94A5\u3002\u8BBE\u7F6E\u73AF\u5883\u53D8\u91CF\uFF08\u9ED8\u8BA4 DSH_SECRETS_PASSPHRASE\uFF09\u6216\u914D\u7F6E keyfile \u540E\u91CD\u542F\u670D\u52A1\u3002",
  "locked.decrypt-failed": "\u4E3B\u5BC6\u94A5\u4E0D\u5BF9\uFF0C\u6216\u4FDD\u9669\u5E93\u6587\u4EF6\u5DF2\u635F\u574F\u3002\u786E\u8BA4\u670D\u52A1\u8FDB\u7A0B\u91CC\u7684\u53E3\u4EE4 / keyfile \u4E0E\u5199\u5165\u65F6\u4E00\u81F4\u3002",
  "locked.key-invalid": "keyfile \u65E0\u6CD5\u4F7F\u7528\uFF08\u6743\u9650\u6216\u957F\u5EA6\u4E0D\u7B26\uFF09\u3002\u6309\u63D0\u793A\u4FEE\u6B63\u540E\u5237\u65B0\u3002",
  "locked.key-source-mismatch": "\u4FDD\u9669\u5E93\u7684\u52A0\u5BC6\u65B9\u5F0F\u4E0E\u5F53\u524D keySource \u914D\u7F6E\u4E0D\u4E00\u81F4\u3002",
  "locked.generic": "\u65E0\u6CD5\u89E3\u5BC6\u4FDD\u9669\u5E93\u3002",
  "error.vault.title": "\u4FDD\u9669\u5E93\u6587\u4EF6\u65E0\u6CD5\u8BFB\u53D6",
  "detail": "\u8BE6\u60C5\uFF1A{message}",
  "filter.search": "\u641C\u7D22\u540D\u79F0\u6216\u63CF\u8FF0\u2026",
  "filter.search.aria": "\u6309\u540D\u79F0\u6216\u63CF\u8FF0\u641C\u7D22",
  "filter.tags.aria": "\u6309\u6807\u7B7E\u7B5B\u9009",
  "filter.all": "\u5168\u90E8",
  "filter.untagged": "{count} \u4E2A\u65E0\u6807\u7B7E",
  "filter.clear": "\u6E05\u9664\u7B5B\u9009",
  "filter.matched": "\u663E\u793A {matched} / {total}",
  "refresh": "\u5237\u65B0",
  "refreshing": "\u5237\u65B0\u4E2D\u2026",
  "updatedAt": "\u66F4\u65B0\u4E8E {time}",
  "stale": "\u5237\u65B0\u5931\u8D25\uFF08{message}\uFF09\uFF0C\u4E0B\u9762\u662F {time} \u7684\u6570\u636E",
  "col.name": "\u540D\u79F0",
  "col.description": "\u63CF\u8FF0",
  "col.tags": "\u6807\u7B7E",
  "col.fingerprint": "\u6307\u7EB9",
  "col.length": "\u957F\u5EA6",
  "col.updated": "\u66F4\u65B0\u65F6\u95F4",
  "cell.noDescription": "\uFF08\u65E0\u63CF\u8FF0\uFF09",
  "cell.noTags": "\u2014",
  "cell.length": "{count} \u5B57\u7B26",
  "cell.tagFilter": "\u53EA\u770B\u6807\u7B7E {tag}",
  "cell.times": "\u521B\u5EFA {created}\n\u503C\u66F4\u65B0 {updated}\n\u5143\u6570\u636E\u66F4\u65B0 {meta}",
  "age.now": "\u521A\u521A",
  "age.minutes": "{count} \u5206\u949F\u524D",
  "age.hours": "{count} \u5C0F\u65F6\u524D",
  "age.days": "{count} \u5929\u524D",
  "age.months": "{count} \u4E2A\u6708\u524D",
  "age.years": "{count} \u5E74\u524D",
  "loading": "\u6B63\u5728\u8BFB\u53D6\u4FDD\u9669\u5E93\u2026",
  "empty.missing.title": "\u4FDD\u9669\u5E93\u8FD8\u6CA1\u6709\u521B\u5EFA",
  "empty.missing.hint": "\u7B2C\u4E00\u6B21\u8C03\u7528 secret_set \u5B58\u5165\u5BC6\u94A5\u65F6\u4F1A\u81EA\u52A8\u521B\u5EFA\u3002\u4E5F\u53EF\u4EE5\u7528 ingest-file.mjs \u6279\u91CF\u5BFC\u5165\u3002",
  "empty.vault.title": "\u4FDD\u9669\u5E93\u662F\u7A7A\u7684",
  "empty.vault.hint": "\u7528 secret_set \u5B58\u5165\u7B2C\u4E00\u4E2A\u5BC6\u94A5\uFF08\u5EFA\u8BAE\u540C\u65F6\u5199 description \u548C tags\uFF09\u3002",
  "empty.filter.title": "\u6CA1\u6709\u5339\u914D\u7684\u5BC6\u94A5",
  "empty.filter.hint": "\u6362\u4E2A\u5173\u952E\u5B57\u6216\u6807\u7B7E\u8BD5\u8BD5\u3002\u6CE8\u610F\uFF1A\u641C\u7D22\u53EA\u5339\u914D\u540D\u79F0\u548C\u63CF\u8FF0\uFF0C\u4E0D\u5339\u914D\u503C\u3002",
  "error.title": "\u8BFB\u4E0D\u5230\u5BC6\u94A5\u770B\u677F\u6570\u636E",
  "error.hint": "\u5BBF\u4E3B\u4FA7\u7684\u53EA\u8BFB\u63A5\u53E3 /api/secrets/* \u6CA1\u6709\u6B63\u5E38\u54CD\u5E94\u3002\u9875\u9762\u5176\u4F59\u90E8\u5206\u4E0D\u53D7\u5F71\u54CD\u3002",
  "error.unauthorized": "\u767B\u5F55\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55\u540E\u518D\u8BD5\u3002",
  "error.unavailable": "\u767B\u5F55\u670D\u52A1\u6682\u4E0D\u53EF\u7528\uFF0C\u6216 dsh-host-secrets \u6CA1\u6709\u6302\u8F7D\u770B\u677F\u63A5\u53E3\u3002",
  "retry": "\u91CD\u8BD5"
};
var en = {
  "page.title": "Secrets dashboard",
  "page.nav": "Secrets",
  "page.subtitle": "Read-only view of the local dsh-secrets vault: name, description, tags, fingerprint, length and update time.",
  "notice.title": "Values cannot be viewed",
  "notice.body": "This page shows metadata only; no route ever returns a secret value. Secrets can only be used through the secret_* tools: secret_exec injects them as environment variables, secret_http fills {placeholder} placeholders in a request, secret_check compares a candidate.",
  "notice.fingerprint": "Fingerprint = first 8 hex chars of SHA-256(value); length = characters. Both tell values apart; neither reveals one.",
  "vault.state.unlocked": "Unlocked",
  "vault.state.missing": "Not created yet",
  "vault.state.locked": "Locked",
  "vault.state.error": "Unreadable",
  "vault.keySource.passphrase-env": "Master key: passphrase env var",
  "vault.keySource.keyfile": "Master key: keyfile",
  "vault.key.configured": "master key available",
  "vault.key.missing": "master key not configured",
  "vault.path": "Vault file: {path}",
  "vault.count": "{total} secrets",
  "vault.lastUpdated": "last updated {time}",
  "locked.title": "The vault is locked; secrets cannot be listed",
  "locked.key-missing": "The service has no master key. Set the environment variable (default DSH_SECRETS_PASSPHRASE) or configure a keyfile, then restart the service.",
  "locked.decrypt-failed": "Wrong master key, or the vault file is corrupted. Make sure the service uses the passphrase / keyfile the vault was written with.",
  "locked.key-invalid": "The keyfile cannot be used (permissions or length). Fix it as described and refresh.",
  "locked.key-source-mismatch": "The vault was encrypted with a different keySource than the one configured.",
  "locked.generic": "The vault cannot be decrypted.",
  "error.vault.title": "The vault file cannot be read",
  "detail": "Details: {message}",
  "filter.search": "Search name or description\u2026",
  "filter.search.aria": "Search by name or description",
  "filter.tags.aria": "Filter by tag",
  "filter.all": "All",
  "filter.untagged": "{count} untagged",
  "filter.clear": "Clear filters",
  "filter.matched": "Showing {matched} / {total}",
  "refresh": "Refresh",
  "refreshing": "Refreshing\u2026",
  "updatedAt": "Updated {time}",
  "stale": "Refresh failed ({message}); showing data from {time}",
  "col.name": "Name",
  "col.description": "Description",
  "col.tags": "Tags",
  "col.fingerprint": "Fingerprint",
  "col.length": "Length",
  "col.updated": "Updated",
  "cell.noDescription": "(no description)",
  "cell.noTags": "\u2014",
  "cell.length": "{count} chars",
  "cell.tagFilter": "Only tag {tag}",
  "cell.times": "Created {created}\nValue updated {updated}\nMetadata updated {meta}",
  "age.now": "just now",
  "age.minutes": "{count} min ago",
  "age.hours": "{count} h ago",
  "age.days": "{count} d ago",
  "age.months": "{count} mo ago",
  "age.years": "{count} y ago",
  "loading": "Reading the vault\u2026",
  "empty.missing.title": "No vault yet",
  "empty.missing.hint": "It is created by the first secret_set call. ingest-file.mjs can bulk-import as well.",
  "empty.vault.title": "The vault is empty",
  "empty.vault.hint": "Store the first secret with secret_set (a description and tags help later).",
  "empty.filter.title": "No matching secrets",
  "empty.filter.hint": "Try another keyword or tag. Search matches names and descriptions, never values.",
  "error.title": "Secrets dashboard data is unreachable",
  "error.hint": "The host-side read-only routes /api/secrets/* did not answer. The rest of the page is unaffected.",
  "error.unauthorized": "Your login has expired. Sign in again and retry.",
  "error.unavailable": "The login service is unavailable, or dsh-host-secrets did not mount the dashboard routes.",
  "retry": "Retry"
};
var DICTIONARIES = { zh: { ...zh }, en: { ...en } };

// src/client/SecretsIcon.tsx
var import_jsx_runtime = require("react/jsx-runtime");
function SecretsIcon({ size = 18, active = false }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { width: size, height: size, viewBox: "0 0 18 18", fill: "none", "aria-hidden": "true", style: { opacity: active ? 1 : 0.72 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("circle", { cx: "6", cy: "9", r: "3.4", stroke: "currentColor", strokeWidth: "1.4" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M9.4 9h6.2M13.4 9v2.6M15.6 9v1.8", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round" })
  ] });
}
function LockIcon({ size = 18 }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { width: size, height: size, viewBox: "0 0 18 18", fill: "none", "aria-hidden": "true", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("rect", { x: "3.5", y: "8", width: "11", height: "7.5", rx: "2", stroke: "currentColor", strokeWidth: "1.4" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M6 8V5.8a3 3 0 0 1 6 0V8", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("circle", { cx: "9", cy: "11.6", r: "1.1", fill: "currentColor" })
  ] });
}

// src/client/SecretsPage.tsx
var import_react = require("react");

// src/client/format.ts
function pad(value) {
  return value < 10 ? `0${String(value)}` : String(value);
}
function formatDateTime(iso) {
  if (iso === null || iso === void 0) return "\u2014";
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "\u2014";
  const date = new Date(time);
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function formatClock(iso) {
  if (iso === null || iso === void 0) return "\u2014";
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "\u2014";
  const date = new Date(time);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function ageOf(iso, now = Date.now()) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return { unit: "now", count: 0 };
  const seconds = Math.max(0, Math.round((now - time) / 1e3));
  if (seconds < 60) return { unit: "now", count: 0 };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { unit: "minutes", count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: "hours", count: hours };
  const days = Math.floor(hours / 24);
  if (days < 31) return { unit: "days", count: days };
  const months = Math.floor(days / 30);
  if (months < 12) return { unit: "months", count: months };
  return { unit: "years", count: Math.floor(days / 365) };
}

// src/client/source.ts
var BRIDGE_BASE = "/api/secrets";
var SUMMARY_PATH = `${BRIDGE_BASE}/summary`;
var LIST_PATH = `${BRIDGE_BASE}/list`;
var BridgeError = class extends Error {
  status;
  constructor(message, status) {
    super(message);
    this.name = "BridgeError";
    this.status = status;
  }
};
function errorMessageOf(body) {
  if (typeof body !== "object" || body === null) return void 0;
  const error = body.error;
  if (typeof error !== "object" || error === null) return void 0;
  const message = error.message;
  return typeof message === "string" ? message : void 0;
}
async function getJson(url, signal) {
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
      signal
    });
  } catch (error) {
    throw new BridgeError(error instanceof Error ? error.message : String(error));
  }
  const text = await response.text();
  let body;
  if (text.trim() !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      body = void 0;
    }
  }
  if (!response.ok) {
    const plain = body === void 0 && text.trim() !== "" && text.length < 200 ? text.trim() : void 0;
    throw new BridgeError(errorMessageOf(body) ?? plain ?? `HTTP ${String(response.status)}`, response.status);
  }
  if (typeof body !== "object" || body === null) throw new BridgeError("empty response", response.status);
  return body;
}
function fetchSummary(signal) {
  return getJson(SUMMARY_PATH, signal);
}
function fetchList(filter, signal) {
  const params = new URLSearchParams();
  if (filter.tag !== void 0 && filter.tag !== "") params.set("tag", filter.tag);
  if (filter.query !== void 0 && filter.query.trim() !== "") params.set("query", filter.query.trim());
  const query = params.toString();
  return getJson(query === "" ? LIST_PATH : `${LIST_PATH}?${query}`, signal);
}

// src/client/SecretsPage.tsx
var import_jsx_runtime2 = require("react/jsx-runtime");
var PLACEHOLDER = "${secret:NAME}";
var SEARCH_DEBOUNCE_MS = 250;
var LOCK_HINTS = {
  "key-missing": "locked.key-missing",
  "decrypt-failed": "locked.decrypt-failed",
  "key-invalid": "locked.key-invalid",
  "key-source-mismatch": "locked.key-source-mismatch"
};
function useDashboard(filter) {
  const [state, setState] = (0, import_react.useState)({ busy: true });
  const ticket = (0, import_react.useRef)(0);
  const inflight = (0, import_react.useRef)(null);
  const current = (0, import_react.useRef)(filter);
  current.current = filter;
  const load = (0, import_react.useCallback)((wanted) => {
    const mine = ticket.current + 1;
    ticket.current = mine;
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    setState((previous) => ({ ...previous, busy: true }));
    Promise.all([fetchSummary(controller.signal), fetchList(wanted, controller.signal)]).then(
      ([summary, list]) => {
        if (mine === ticket.current) setState({ data: { summary, list }, busy: false });
      },
      (error) => {
        if (mine !== ticket.current) return;
        const message = error instanceof Error ? error.message : String(error);
        const status = error instanceof BridgeError ? error.status : void 0;
        setState((previous) => ({ data: previous.data, busy: false, error: { message, status } }));
      }
    );
  }, []);
  const tag = filter.tag;
  const query = filter.query;
  (0, import_react.useEffect)(() => {
    load({ tag, query });
  }, [load, tag, query]);
  (0, import_react.useEffect)(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") load(current.current);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      inflight.current?.abort();
      ticket.current += 1;
    };
  }, [load]);
  const reload = (0, import_react.useCallback)(() => {
    load(current.current);
  }, [load]);
  return { state, reload };
}
function ageText(t, iso) {
  const age = ageOf(iso);
  if (age.unit === "now") return t("age.now");
  return t(`age.${age.unit}`, { count: age.count });
}
function Notice({ t }) {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { className: "dss-notice", role: "note", "aria-label": t("notice.title"), children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-notice-icon", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(LockIcon, { size: 20 }) }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dss-notice-body", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-notice-title", children: t("notice.title") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dss-notice-text", children: t("notice.body", { placeholder: PLACEHOLDER }) }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dss-notice-text", children: t("notice.fingerprint") })
    ] })
  ] });
}
function VaultLine({ t, vault, summary }) {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dss-status", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-chip", "data-tone": vault.state, children: t(`vault.state.${vault.state}`) }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: t(`vault.keySource.${vault.keySource}`) }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-status-key", "data-ok": vault.keyConfigured, children: vault.keyConfigured ? t("vault.key.configured") : t("vault.key.missing") }),
    vault.state === "unlocked" && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-status-sep", "aria-hidden": "true", children: "\xB7" }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: t("vault.count", { total: summary.total }) }),
      summary.lastUpdatedAt !== null && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { title: summary.lastUpdatedAt, children: t("vault.lastUpdated", { time: formatDateTime(summary.lastUpdatedAt) }) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-status-path", title: vault.path, children: t("vault.path", { path: vault.path }) })
  ] });
}
function VaultProblem({ t, vault }) {
  const code = vault.error?.code ?? "";
  const locked = vault.state === "locked";
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { className: "dss-banner", "data-tone": vault.state, role: "alert", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-banner-title", children: locked ? t("locked.title") : t("error.vault.title") }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dss-banner-text", children: locked ? t(LOCK_HINTS[code] ?? "locked.generic") : t("error.hint") }),
    vault.error !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dss-banner-detail", children: t("detail", { message: vault.error.message }) })
  ] });
}
function Row({ t, item, activeTag, onTag }) {
  const times = t("cell.times", {
    created: formatDateTime(item.createdAt),
    updated: formatDateTime(item.updatedAt),
    meta: formatDateTime(item.metaUpdatedAt)
  });
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("tr", { children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { className: "dss-cell-name", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("code", { children: item.name }) }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { className: "dss-cell-desc", children: item.description === "" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-muted", children: t("cell.noDescription") }) : item.description }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { className: "dss-cell-tags", children: item.tags.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-muted", children: t("cell.noTags") }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-cell-tags-list", children: item.tags.map((tag) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      "button",
      {
        type: "button",
        className: "dss-tag",
        "data-on": tag === activeTag,
        title: t("cell.tagFilter", { tag }),
        onClick: () => {
          onTag(tag === activeTag ? void 0 : tag);
        },
        children: tag
      },
      tag
    )) }) }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { className: "dss-cell-fp", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("code", { children: item.fingerprint }) }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { className: "dss-cell-len", children: t("cell.length", { count: item.length }) }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("td", { className: "dss-cell-time", title: times, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: formatDateTime(item.updatedAt) }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-muted", children: ageText(t, item.updatedAt) })
    ] })
  ] });
}
function SecretsPage({ t }) {
  const [tag, setTag] = (0, import_react.useState)(void 0);
  const [queryInput, setQueryInput] = (0, import_react.useState)("");
  const [query, setQuery] = (0, import_react.useState)("");
  (0, import_react.useEffect)(() => {
    const timer = window.setTimeout(() => {
      setQuery(queryInput.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [queryInput]);
  const { state, reload } = useDashboard({ tag, query: query === "" ? void 0 : query });
  const data = state.data;
  const summary = data?.summary;
  const list = data?.list;
  const vault = summary?.vault;
  const filtering = tag !== void 0 || query !== "";
  const clear = (0, import_react.useCallback)(() => {
    setTag(void 0);
    setQueryInput("");
    setQuery("");
  }, []);
  const tagChips = summary === void 0 ? [] : [...summary.tags];
  if (tag !== void 0 && !tagChips.some((chip) => chip.tag === tag)) tagChips.push({ tag, count: 0 });
  let body;
  if (data === void 0 || summary === void 0 || list === void 0 || vault === void 0) {
    if (state.error !== void 0 && !state.busy) {
      const status = state.error.status;
      const hint = status === 401 || status === 403 ? t("error.unauthorized") : status === 503 ? t("error.unavailable") : t("error.hint");
      body = /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dss-empty", "data-bad": "true", role: "alert", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-empty-title", children: t("error.title") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-empty-hint", children: hint }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-empty-hint", children: t("detail", { message: state.error.message }) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dss-btn", "data-primary": "true", onClick: reload, children: t("retry") })
      ] });
    } else {
      body = /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dss-empty", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-empty-hint", children: t("loading") }) });
    }
  } else if (vault.state === "locked" || vault.state === "error") {
    body = /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(VaultProblem, { t, vault });
  } else if (vault.state === "missing") {
    body = /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dss-empty", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-empty-title", children: t("empty.missing.title") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-empty-hint", children: t("empty.missing.hint") })
    ] });
  } else if (list.total === 0) {
    body = /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dss-empty", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-empty-title", children: t("empty.vault.title") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-empty-hint", children: t("empty.vault.hint") })
    ] });
  } else {
    body = /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dss-toolbar", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "input",
          {
            className: "dss-search",
            type: "search",
            value: queryInput,
            placeholder: t("filter.search"),
            "aria-label": t("filter.search.aria"),
            autoComplete: "off",
            spellCheck: false,
            onChange: (event) => {
              setQueryInput(event.target.value);
            },
            onKeyDown: (event) => {
              if (event.key === "Escape") setQueryInput("");
            }
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dss-tags-row", role: "group", "aria-label": t("filter.tags.aria"), children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("button", { type: "button", className: "dss-filter", "data-on": tag === void 0, onClick: () => {
            setTag(void 0);
          }, children: [
            t("filter.all"),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-filter-count", children: summary.total })
          ] }),
          tagChips.map((chip) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
            "button",
            {
              type: "button",
              className: "dss-filter",
              "data-on": chip.tag === tag,
              onClick: () => {
                setTag(chip.tag === tag ? void 0 : chip.tag);
              },
              children: [
                chip.tag,
                /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-filter-count", children: chip.count })
              ]
            },
            chip.tag
          ))
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dss-toolbar-foot", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: t("filter.matched", { matched: list.matched, total: list.total }) }),
          summary.untagged > 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: t("filter.untagged", { count: summary.untagged }) }),
          filtering && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dss-link", onClick: clear, children: t("filter.clear") })
        ] })
      ] }),
      list.items.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dss-empty", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-empty-title", children: t("empty.filter.title") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-empty-hint", children: t("empty.filter.hint") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dss-btn", onClick: clear, children: t("filter.clear") })
      ] }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dss-table-wrap", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("table", { className: "dss-table", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("thead", { children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("tr", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { scope: "col", children: t("col.name") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { scope: "col", children: t("col.description") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { scope: "col", children: t("col.tags") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { scope: "col", children: t("col.fingerprint") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { scope: "col", children: t("col.length") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { scope: "col", children: t("col.updated") })
        ] }) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("tbody", { children: list.items.map((item) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Row, { t, item, activeTag: tag, onTag: setTag }, item.name)) })
      ] }) })
    ] });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dss-page", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dss-col", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("header", { className: "dss-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dss-head-text", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h1", { className: "dss-title", children: t("page.title") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dss-sub", children: t("page.subtitle") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dss-head-actions", children: [
        data !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-updated", children: t("updatedAt", { time: formatClock(data.list.generatedAt) }) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dss-btn", disabled: state.busy, onClick: reload, children: state.busy && data !== void 0 ? t("refreshing") : t("refresh") })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Notice, { t }),
    vault !== void 0 && summary !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(VaultLine, { t, vault, summary }),
    data !== void 0 && state.error !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("section", { className: "dss-banner", "data-tone": "error", role: "status", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dss-banner-text", children: t("stale", { message: state.error.message, time: formatClock(data.list.generatedAt) }) }) }),
    body
  ] }) });
}

// src/client/styles.ts
var STYLE_KEY = "dsh-client-ui-secrets/SecretsPage.css";
var SECRETS_CSS = `
.dss-page {
  --dss-accent: #4d6bfe;
  --dss-accent-soft: color-mix(in srgb, var(--dss-accent) 11%, transparent);
  --dss-text: var(--dsw-alias-label-primary, #0f1115);
  --dss-text-2: var(--dsw-alias-label-secondary, #61666b);
  --dss-text-3: var(--dsw-alias-label-tertiary, #81858c);
  --dss-line: var(--dsw-alias-border-l, #e1e5ee);
  --dss-base: var(--dsw-alias-bg-base, #fff);
  --dss-fill: var(--dsw-alias-bg-layer-1, #f9fafb);
  --dss-fill-2: var(--dsw-alias-bg-layer-2, #f5f7fa);
  --dss-hover: var(--dsw-alias-interactive-bg-hover, rgba(15, 17, 21, 0.05));
  --dss-ok: var(--dsw-alias-state-success-primary, #22c55e);
  --dss-warn: var(--dsw-alias-state-warn-primary, #f59e0b);
  --dss-bad: var(--dsw-alias-state-error-primary, #ec1313);
  --dss-idle: var(--dsw-alias-state-idle-primary, #a3a3a3);
  --dss-mono: var(--dsh-mono, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace);
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  background: var(--dss-base);
  color: var(--dss-text);
  font-family: var(--dsh-font, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif);
  font-size: 14px;
  line-height: 22px;
  container-type: inline-size;
  -webkit-font-smoothing: antialiased;
}
.dss-page *, .dss-page *::before, .dss-page *::after { box-sizing: border-box; }
.dss-page button, .dss-page input { font: inherit; color: inherit; }
.dss-col { width: 100%; max-width: 1120px; margin: 0 auto; padding: 0 24px 48px; display: flex; flex-direction: column; gap: 16px; }

/* ---------- head ---------- */
.dss-head { padding-top: 36px; display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.dss-head-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dss-title { margin: 0; font-size: 24px; line-height: 32px; font-weight: 600; letter-spacing: 0; }
.dss-sub { margin: 0; font-size: 13px; color: var(--dss-text-3); }
.dss-head-actions { display: flex; align-items: center; gap: 10px; }
.dss-updated { font-size: 12px; color: var(--dss-text-3); }
.dss-btn {
  display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 14px; border: 0; border-radius: 10px;
  background: var(--dss-fill-2); cursor: pointer; font-size: 13px; font-weight: 500; transition: background 120ms ease;
}
.dss-btn:hover:not(:disabled) { background: var(--dss-hover); }
.dss-btn:disabled { opacity: 0.6; cursor: default; }
.dss-btn:focus-visible { outline: 2px solid var(--dss-accent); outline-offset: 2px; }
.dss-btn[data-primary="true"] { background: var(--dss-accent); color: #fff; }

/* ---------- read-only notice ---------- */
.dss-notice {
  display: flex; gap: 12px; padding: 14px 16px; border-radius: 14px;
  background: color-mix(in srgb, var(--dss-warn) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--dss-warn) 40%, transparent);
}
.dss-notice-icon { flex: none; color: color-mix(in srgb, var(--dss-warn) 85%, var(--dss-text)); margin-top: 1px; }
.dss-notice-body { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dss-notice-title { font-weight: 600; font-size: 14px; color: color-mix(in srgb, var(--dss-warn) 70%, var(--dss-text)); }
.dss-notice-text { margin: 0; font-size: 13px; line-height: 20px; color: var(--dss-text-2); }
.dss-notice-text code, .dss-page code { font-family: var(--dss-mono); font-size: 12.5px; }

/* ---------- vault status ---------- */
.dss-status { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 14px; font-size: 12.5px; color: var(--dss-text-2); }
.dss-chip {
  display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: 999px;
  background: color-mix(in srgb, var(--dss-tone, var(--dss-idle)) 14%, transparent);
  color: color-mix(in srgb, var(--dss-tone, var(--dss-idle)) 80%, var(--dss-text)); font-weight: 600;
}
.dss-chip::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--dss-tone, var(--dss-idle)); }
.dss-page [data-tone="unlocked"] { --dss-tone: var(--dss-ok); }
.dss-page [data-tone="missing"] { --dss-tone: var(--dss-idle); }
.dss-page [data-tone="locked"] { --dss-tone: var(--dss-warn); }
.dss-page [data-tone="error"] { --dss-tone: var(--dss-bad); }
.dss-status-sep { color: var(--dss-text-3); }
.dss-status-path { font-family: var(--dss-mono); font-size: 12px; color: var(--dss-text-3); overflow-wrap: anywhere; }
.dss-status-key[data-ok="false"] { color: var(--dss-warn); }

/* ---------- banners ---------- */
.dss-banner { display: flex; flex-direction: column; gap: 4px; padding: 14px 16px; border-radius: 14px; background: var(--dss-fill); }
.dss-banner[data-tone] { background: color-mix(in srgb, var(--dss-tone) 10%, transparent); }
.dss-banner-title { font-weight: 600; }
.dss-banner-text { margin: 0; font-size: 13px; color: var(--dss-text-2); }
.dss-banner-detail { margin: 0; font-family: var(--dss-mono); font-size: 12px; color: var(--dss-text-3); overflow-wrap: anywhere; }
.dss-banner-actions { margin-top: 6px; }

/* ---------- toolbar ---------- */
.dss-toolbar { display: flex; flex-direction: column; gap: 10px; }
.dss-search {
  width: 100%; max-width: 420px; height: 36px; padding: 0 12px; border-radius: 10px; border: 1px solid var(--dss-line);
  background: var(--dss-base); outline: none; font-size: 13.5px;
}
.dss-search:focus { border-color: var(--dss-accent); box-shadow: 0 0 0 3px var(--dss-accent-soft); }
.dss-tags-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.dss-filter {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 11px; border: 0; border-radius: 999px;
  background: var(--dss-fill-2); cursor: pointer; font-size: 12.5px;
}
.dss-filter:hover { background: var(--dss-hover); }
.dss-filter[data-on="true"] { background: var(--dss-accent-soft); color: var(--dss-accent); font-weight: 600; }
.dss-filter:focus-visible { outline: 2px solid var(--dss-accent); outline-offset: 1px; }
.dss-filter-count { color: var(--dss-text-3); font-variant-numeric: tabular-nums; }
.dss-filter[data-on="true"] .dss-filter-count { color: inherit; opacity: 0.75; }
.dss-toolbar-foot { display: flex; align-items: center; gap: 12px; font-size: 12px; color: var(--dss-text-3); }
.dss-link { border: 0; background: none; padding: 0; color: var(--dss-accent); cursor: pointer; font-size: 12px; }

/* ---------- table ---------- */
.dss-table-wrap { overflow-x: auto; border-radius: 14px; border: 1px solid var(--dss-line); }
.dss-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.dss-table th {
  position: sticky; top: 0; text-align: left; font-weight: 500; font-size: 12px; color: var(--dss-text-3);
  background: var(--dss-fill); padding: 9px 12px; white-space: nowrap; border-bottom: 1px solid var(--dss-line);
}
.dss-table td { padding: 10px 12px; vertical-align: top; border-bottom: 1px solid var(--dss-line); }
.dss-table tbody tr:last-child td { border-bottom: 0; }
.dss-table tbody tr:hover td { background: var(--dss-fill); }
.dss-cell-name code { font-weight: 600; font-size: 13px; overflow-wrap: anywhere; }
.dss-cell-desc { min-width: 200px; max-width: 420px; color: var(--dss-text-2); overflow-wrap: anywhere; white-space: pre-wrap; }
.dss-cell-tags { min-width: 120px; }
.dss-cell-tags-list { display: flex; flex-wrap: wrap; gap: 4px; }
.dss-tag {
  height: 22px; padding: 0 8px; border: 0; border-radius: 6px; background: var(--dss-fill-2); color: var(--dss-text-2);
  font-size: 12px; cursor: pointer;
}
.dss-tag:hover { background: var(--dss-hover); }
.dss-tag[data-on="true"] { background: var(--dss-accent-soft); color: var(--dss-accent); }
.dss-cell-fp code { padding: 2px 6px; border-radius: 6px; background: var(--dss-fill-2); letter-spacing: 0.04em; white-space: nowrap; }
.dss-cell-len { white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--dss-text-2); }
.dss-cell-time { white-space: nowrap; font-variant-numeric: tabular-nums; }
.dss-cell-time span { display: block; }
.dss-muted { color: var(--dss-text-3); }
.dss-cell-time .dss-muted { font-size: 12px; line-height: 17px; }

/* ---------- empty / error / loading ---------- */
.dss-empty {
  display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 48px 16px; border-radius: 14px;
  background: var(--dss-fill); text-align: center;
}
.dss-empty-title { font-weight: 600; font-size: 15px; }
.dss-empty-hint { max-width: 520px; font-size: 13px; color: var(--dss-text-3); }
.dss-empty .dss-btn { margin-top: 8px; }
.dss-empty[data-bad="true"] .dss-empty-title { color: var(--dss-bad); }

@container (max-width: 720px) {
  .dss-col { padding: 0 14px 32px; }
  .dss-head { padding-top: 20px; }
  .dss-cell-desc { min-width: 160px; }
}
@media (prefers-reduced-motion: reduce) {
  .dss-btn { transition: none; }
}
`;
function installStyles() {
  if (typeof document === "undefined") return;
  const selector = `style[data-plugin-css=${JSON.stringify(STYLE_KEY)}]`;
  if (document.querySelector(selector) !== null) return;
  const tag = document.createElement("style");
  tag.dataset["plugin"] = "dsh-client-ui-secrets";
  tag.dataset["pluginCss"] = STYLE_KEY;
  tag.textContent = SECRETS_CSS;
  document.head.appendChild(tag);
}

// src/client/index.ts
var PANEL_ID = "secrets/page";
var inject = ["slots", "locale"];
function apply(ctx) {
  installStyles();
  ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), "client-ui-secrets: dictionaries");
  const t = ctx.locale.bind(NS);
  ctx.slots.inject("main", () => ctx.slots.register({
    name: "main",
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ t })
  }, SecretsPage));
  ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
    name: "sidebar.panellist",
    id: PANEL_ID,
    order: -25,
    locale: NS,
    label: () => t("page.nav")
  }, SecretsIcon));
}

return module.exports}});
