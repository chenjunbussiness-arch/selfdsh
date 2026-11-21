window.__ModuleLoader__.load({id:"dsh-client-ui-token-stats",factory:require=>{var module={exports:{}};var exports=module.exports;Object.defineProperty(exports,Symbol.toStringTag,{value:"Module"});
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
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);

// src/client/locales.ts
var NS = "tokenStats";
var zh = {
  "today.short": "\u4ECA\u65E5",
  "spark.title": "\u8FD1 7 \u5929\u8D70\u52BF",
  "split.input": "\u65B0\u8F93\u5165",
  "split.cache": "\u7F13\u5B58\u8BFB",
  "split.output": "\u8F93\u51FA",
  "split.calls": "\u8C03\u7528\u6B21\u6570",
  "range.today": "\u4ECA\u65E5",
  "hero.note": "{range}\u5408\u8BA1 \xB7 \u542B\u7F13\u5B58\u8BFB \xB7 \u66F4\u65B0\u4E8E {time}",
  "empty.range": "\u8FD9\u6BB5\u65F6\u95F4\u6CA1\u6709\u7528\u91CF",
  "daily.title7": "\u6BCF\u65E5\u7528\u91CF\uFF08\u8FD1 7 \u5929\uFF0C\u6309\u6A21\u578B\u7740\u8272\uFF09",
  "daily.title30": "\u6BCF\u65E5\u7528\u91CF\uFF08\u8FD1 30 \u5929\uFF0C\u6309\u6A21\u578B\u7740\u8272\uFF09",
  "refresh": "\u7ACB\u5373\u5237\u65B0",
  "refreshing": "\u5237\u65B0\u4E2D\u2026",
  "stale": "\u5237\u65B0\u5931\u8D25\uFF0C\u4E0B\u9762\u662F {time} \u7684\u6570\u636E",
  "title": "Token \u7528\u91CF",
  "unit": "tok",
  "today.label": "\u4ECA\u65E5\u603B\u91CF",
  "today.note": "\u542B\u7F13\u5B58\u8BFB \xB7 \u622A\u81F3 {time}",
  "models.title": "\u6309\u6A21\u578B",
  "daily.title": "\u6BCF\u65E5\u6C47\u603B",
  "range.7": "\u8FD1 7 \u5929",
  "range.30": "\u8FD1 30 \u5929",
  "close": "\u5173\u95ED",
  "loading": "\u6B63\u5728\u7EDF\u8BA1\u2026",
  "error.short": "\u7EDF\u8BA1\u670D\u52A1\u4E0D\u53EF\u7528",
  "error.title": "\u8BFB\u4E0D\u5230\u7528\u91CF\u7EDF\u8BA1",
  "error.hint": "\u5BBF\u4E3B\u4FA7\u7684\u53EA\u8BFB\u805A\u5408\u63A5\u53E3\u6CA1\u6709\u54CD\u5E94\u3002\u9875\u9762\u5176\u4F59\u90E8\u5206\u4E0D\u53D7\u5F71\u54CD\u3002",
  "retry": "\u91CD\u8BD5",
  "empty.short": "\u6682\u65E0\u7528\u91CF\u6570\u636E",
  "empty.title": "\u6682\u65E0\u7528\u91CF\u6570\u636E",
  "empty.hint": "\u8FD0\u884C\u4E00\u6B21\u4F1A\u8BDD\u540E\uFF0C\u8FD9\u91CC\u4F1A\u663E\u793A\u771F\u5B9E token \u6D88\u8017\uFF08\u6309\u6A21\u578B\u3001\u6309\u5929\uFF09\u3002",
  "foot.scope": "\u6570\u636E\u6765\u81EA\u672C\u673A ~/.dsh \u4F1A\u8BDD\u65E5\u5FD7\uFF0C\u6309 UTC+8 \u5206\u5929\uFF1B\u603B\u91CF = \u65B0\u8F93\u5165 + \u7F13\u5B58\u8BFB + \u8F93\u51FA",
  "foot.scan": "\u626B\u63CF {files} \u4E2A\u4F1A\u8BDD \xB7 {events} \u6761\u7528\u91CF\u4E8B\u4EF6 \xB7 \u9996\u626B {cold} ms \xB7 \u6700\u8FD1\u5237\u65B0 {warm} ms",
  "foot.updated": "\u66F4\u65B0\u4E8E {time} \xB7 \u626B\u63CF {files} \u4E2A\u4F1A\u8BDD\u3001{events} \u6B21\u8C03\u7528",
  "value.none": "\u2014",
  "hint.cache": "\u542B\u7F13\u5B58\u8BFB",
  "aria.open": "\u5C55\u5F00 token \u7528\u91CF\u7EDF\u8BA1",
  "aria.close": "\u6536\u8D77 token \u7528\u91CF\u7EDF\u8BA1"
};
var en = {
  "today.short": "today",
  "spark.title": "Last 7 days",
  "split.input": "fresh in",
  "split.cache": "cache read",
  "split.output": "output",
  "split.calls": "calls",
  "range.today": "Today",
  "hero.note": "{range} total \xB7 incl. cache reads \xB7 updated {time}",
  "empty.range": "No usage in this range",
  "daily.title7": "Daily usage (7 days, coloured by model)",
  "daily.title30": "Daily usage (30 days, coloured by model)",
  "refresh": "Refresh now",
  "refreshing": "Refreshing\u2026",
  "stale": "Refresh failed; showing data from {time}",
  "title": "Token usage",
  "unit": "tok",
  "today.label": "Today",
  "today.note": "incl. cache reads \xB7 as of {time}",
  "models.title": "By model",
  "daily.title": "Daily totals",
  "range.7": "Last 7 days",
  "range.30": "Last 30 days",
  "close": "Close",
  "loading": "Aggregating\u2026",
  "error.short": "Stats service unavailable",
  "error.title": "Usage stats are unreachable",
  "error.hint": "The host-side read-only aggregation route did not answer. The rest of the page is unaffected.",
  "retry": "Retry",
  "empty.short": "No usage data yet",
  "empty.title": "No usage data yet",
  "empty.hint": "Run a session and its real token usage shows up here, by model and by day.",
  "foot.scope": "Local ~/.dsh session logs only \xB7 time zone UTC+8",
  "foot.scan": "Scanned {files} sessions \xB7 {events} usage events \xB7 cold {cold} ms \xB7 last refresh {warm} ms",
  "foot.updated": "Updated {time} \xB7 {files} sessions, {events} calls scanned",
  "value.none": "\u2014",
  "hint.cache": "incl. cache reads",
  "aria.open": "Expand token usage statistics",
  "aria.close": "Collapse token usage statistics"
};
var DICTIONARIES = { zh, en: { ...en } };

// src/client/styles.ts
var STYLE_KEY = "dsh-client-ui-token-stats/TokenStats.css";
var TOKEN_STATS_CSS = `
:where(div):has(> [data-slot] > .dst-root) { flex-wrap: wrap; row-gap: 6px; }
.dst-root {
  --dst-text: var(--dsw-alias-label-primary, #0f1115);
  --dst-text2: var(--dsw-alias-label-secondary, #61666b);
  --dst-caption: var(--dsw-alias-label-caption, #81858c);
  --dst-line: var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.06));
  --dst-line2: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08));
  --dst-hover: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
  --dst-accent: var(--dsw-alias-state-business-primary, #4d6bfe);
  --dst-bad: var(--dsw-alias-state-error-primary, #ec1313);
  --dst-pop: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, #ffffff));
  --dst-soft: color-mix(in srgb, var(--dst-caption) 14%, transparent);
  position: relative; display: block; flex: 1 0 100%; width: 100%; min-width: 0; box-sizing: border-box;
  color: var(--dst-text); font-family: inherit; text-align: left;
}
.dst-root *, .dst-root *::before, .dst-root *::after { box-sizing: border-box; }

/* ---------- card ---------- */
.dst-card {
  display: flex; flex-direction: column; gap: 6px; width: 100%; min-width: 0;
  padding: 8px 10px 9px; border: 1px solid var(--dst-line); border-radius: 12px;
  background: transparent; color: var(--dst-text); font: inherit; font-size: 12px; line-height: 1.35;
  text-align: left; cursor: pointer; transition: background 0.15s ease;
}
.dst-card:hover { background: var(--dst-hover); }
.dst-card:focus-visible { outline: 2px solid var(--dst-accent); outline-offset: 1px; }
.dst-card[aria-expanded="true"] { border-color: color-mix(in srgb, var(--dst-accent) 38%, var(--dst-line)); }
.dst-head { display: flex; align-items: center; gap: 6px; width: 100%; }
.dst-title { font-size: 11px; font-weight: 500; letter-spacing: 0.02em; color: var(--dst-caption); white-space: nowrap; margin-right: auto; }
.dst-caret { font-size: 9px; color: var(--dst-caption); }
.dst-big-row { display: flex; align-items: flex-end; gap: 6px; min-width: 0; }
.dst-big { font-size: 20px; font-weight: 650; letter-spacing: -0.01em; line-height: 1.05; font-variant-numeric: tabular-nums; }
.dst-big-label { font-size: 10px; color: var(--dst-caption); padding-bottom: 2px; white-space: nowrap; }
.dst-spark { margin-left: auto; display: flex; align-items: flex-end; gap: 2px; height: 22px; flex: none; }
.dst-spark i { display: block; width: 5px; min-height: 2px; border-radius: 1.5px; background: color-mix(in srgb, var(--dst-accent) 35%, transparent); }
.dst-spark i[data-today="true"] { background: var(--dst-accent); }
.dst-split { display: flex; flex-wrap: wrap; gap: 2px 10px; font-size: 10.5px; color: var(--dst-caption); }
.dst-split b { font-weight: 600; color: var(--dst-text2); font-variant-numeric: tabular-nums; }
.dst-stack { display: flex; width: 100%; height: 5px; border-radius: 3px; overflow: hidden; background: var(--dst-soft); gap: 1px; }
.dst-stack i { display: block; height: 100%; min-width: 2px; }
.dst-model { display: grid; grid-template-columns: 8px minmax(0, 1fr) auto 30px; align-items: center; gap: 6px; min-width: 0; }
.dst-swatch { display: block; width: 8px; height: 8px; border-radius: 2px; flex: none; }
.dst-model-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--dst-text2); min-width: 0; }
.dst-model-tok { font-size: 11px; font-variant-numeric: tabular-nums; color: var(--dst-text); white-space: nowrap; }
.dst-model-share { font-size: 10px; font-variant-numeric: tabular-nums; color: var(--dst-caption); text-align: right; white-space: nowrap; }
.dst-note { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10.5px; color: var(--dst-caption); }
.dst-note[data-bad] { color: var(--dst-bad); }

/* ---------- collapsed 56px rail ---------- */
.dst-rail {
  display: flex; align-items: center; justify-content: center; width: 40px; height: 40px; margin: 0 auto; padding: 0;
  border: 1px solid var(--dst-line); border-radius: 12px; background: transparent; color: var(--dst-text2); font: inherit; cursor: pointer;
}
.dst-rail:hover { background: var(--dst-hover); }
.dst-rail[aria-expanded="true"] { color: var(--dst-accent); background: color-mix(in srgb, var(--dst-accent) 12%, transparent); }
.dst-rail:focus-visible { outline: 2px solid var(--dst-accent); outline-offset: 1px; }
.dst-rail-bars { display: flex; align-items: flex-end; gap: 2px; height: 16px; }
.dst-rail-bars i { display: block; width: 3px; border-radius: 1px; background: currentColor; opacity: 0.9; }

/* ---------- popover ---------- */
.dst-pop {
  position: fixed; z-index: 1200; display: flex; flex-direction: column; min-height: 0;
  border: 1px solid var(--dst-line2); border-radius: 14px; background: var(--dst-pop); color: var(--dst-text);
  box-shadow: 0 18px 48px rgba(15, 17, 21, 0.2), 0 2px 8px rgba(15, 17, 21, 0.08);
  font-size: 12px; line-height: 1.45; overflow: hidden;
}
.dst-pop-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px 8px; border-bottom: 1px solid var(--dst-line); flex: none; }
.dst-pop-title { font-size: 12px; font-weight: 600; }
.dst-pop-sub { margin-right: auto; font-size: 10px; font-variant-numeric: tabular-nums; color: var(--dst-caption); }
.dst-close {
  display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0;
  border: 0; border-radius: 6px; background: transparent; color: var(--dst-caption); font: inherit; font-size: 15px; line-height: 1; cursor: pointer;
}
.dst-close:hover { background: var(--dst-hover); color: var(--dst-text); }
.dst-pop-body { display: flex; flex-direction: column; gap: 12px; min-height: 0; padding: 10px 12px 12px; overflow-y: auto; }
.dst-tabs { display: flex; gap: 2px; padding: 2px; border-radius: 9px; background: var(--dst-soft); }
.dst-tab { flex: 1; padding: 4px 6px; border: 0; border-radius: 7px; background: transparent; color: var(--dst-text2); font: inherit; font-size: 11px; cursor: pointer; }
.dst-tab[data-on="true"] { background: var(--dst-pop); color: var(--dst-text); font-weight: 600; box-shadow: 0 1px 2px rgba(15, 17, 21, 0.12); }
.dst-hero { display: flex; flex-direction: column; gap: 1px; }
.dst-hero-value { font-size: 24px; font-weight: 650; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
.dst-hero-unit { margin-left: 4px; font-size: 11px; font-weight: 500; color: var(--dst-caption); }
.dst-hero-note { font-size: 10.5px; color: var(--dst-caption); }
.dst-cells { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
.dst-cell { display: flex; flex-direction: column; gap: 1px; padding: 6px 7px; border-radius: 8px; background: var(--dst-soft); min-width: 0; }
.dst-cell span { font-size: 10px; color: var(--dst-caption); white-space: nowrap; }
.dst-cell b { font-size: 12.5px; font-weight: 600; font-variant-numeric: tabular-nums; }
.dst-section { display: flex; flex-direction: column; gap: 7px; }
.dst-section-title { font-size: 10.5px; font-weight: 600; letter-spacing: 0.04em; color: var(--dst-caption); }
.dst-model-row { display: flex; flex-direction: column; gap: 3px; }
.dst-model-row-head { display: grid; grid-template-columns: 8px minmax(0, 1fr) auto 34px; align-items: center; gap: 6px; }
.dst-model-row .dst-model-name { color: var(--dst-text); font-size: 11.5px; }
.dst-track { display: block; height: 4px; border-radius: 2px; background: var(--dst-soft); overflow: hidden; }
.dst-fill { display: block; height: 100%; min-width: 2px; border-radius: 2px; }
.dst-days { display: flex; flex-direction: column; gap: 4px; }
.dst-day { display: grid; grid-template-columns: 38px minmax(0, 1fr) 44px; align-items: center; gap: 8px; }
.dst-day-date { font-size: 10.5px; font-variant-numeric: tabular-nums; color: var(--dst-text2); }
.dst-day[data-today="true"] .dst-day-date { color: var(--dst-accent); font-weight: 600; }
.dst-day-track { display: block; height: 8px; border-radius: 3px; background: var(--dst-soft); overflow: hidden; }
.dst-day-bar { display: flex; height: 100%; border-radius: 3px; overflow: hidden; gap: 1px; }
.dst-day-bar i { display: block; height: 100%; min-width: 1px; }
.dst-day-tok { font-size: 10.5px; font-variant-numeric: tabular-nums; color: var(--dst-text2); text-align: right; }
.dst-day[data-zero="true"] .dst-day-tok { color: var(--dst-caption); }
.dst-empty { display: flex; flex-direction: column; gap: 4px; padding: 14px 4px; text-align: center; }
.dst-empty-title { font-size: 12px; font-weight: 600; }
.dst-empty-hint { font-size: 11px; line-height: 1.4; color: var(--dst-caption); }
.dst-error { display: flex; flex-direction: column; gap: 3px; padding: 8px 10px; border: 1px solid color-mix(in srgb, var(--dst-bad) 35%, transparent); border-radius: 10px; }
.dst-error-title { font-size: 11px; font-weight: 600; color: var(--dst-bad); }
.dst-error-hint { font-size: 10px; line-height: 1.4; color: var(--dst-caption); }
.dst-retry, .dst-refresh {
  align-self: flex-start; margin-top: 2px; padding: 3px 8px; border: 1px solid var(--dst-line2); border-radius: 7px;
  background: transparent; color: var(--dst-text2); font: inherit; font-size: 10px; cursor: pointer;
}
.dst-retry:hover, .dst-refresh:hover { background: var(--dst-hover); }
.dst-pop-foot { display: flex; flex-direction: column; gap: 1px; flex: none; padding: 7px 12px 8px; border-top: 1px solid var(--dst-line); }
.dst-foot-line { font-size: 10px; line-height: 1.35; color: var(--dst-caption); overflow-wrap: anywhere; }
.dst-foot-line[data-bad] { color: var(--dst-bad); }
.dst-refresh:disabled { opacity: .55; cursor: default; }
@media (prefers-reduced-motion: reduce) { .dst-card, .dst-rail { transition: none; } }
`;
function installStyles() {
  if (typeof document === "undefined") return;
  const existing = document.head.querySelector(`style[data-dsh-style="${STYLE_KEY}"]`);
  if (existing !== null) {
    existing.textContent = TOKEN_STATS_CSS;
    return;
  }
  const style = document.createElement("style");
  style.setAttribute("data-dsh-style", STYLE_KEY);
  style.textContent = TOKEN_STATS_CSS;
  document.head.appendChild(style);
}

// src/client/TokenStats.tsx
var import_react = require("react");

// src/client/format.ts
function formatTokens(value) {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1e9) return `${trim(value / 1e9)}B`;
  if (value >= 1e6) return `${trim(value / 1e6)}M`;
  if (value >= 1e3) return `${trim(value / 1e3)}K`;
  return String(Math.round(value));
}
function trim(value) {
  const fixed = value >= 100 ? value.toFixed(0) : value.toFixed(1);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}
function formatPercent(share) {
  if (!Number.isFinite(share) || share <= 0) return "0%";
  const percent = share * 100;
  if (percent >= 99.5) return "100%";
  if (percent < 1) return "<1%";
  return `${Math.round(percent)}%`;
}
function shortDate(date) {
  return date.length >= 10 ? date.slice(5) : date;
}
function timeOfDay(iso) {
  const at = iso.indexOf("T");
  return at >= 0 ? iso.slice(at + 1, at + 6) : iso;
}
function shortModel(model) {
  const slash = model.lastIndexOf("/");
  return slash >= 0 && slash < model.length - 1 ? model.slice(slash + 1) : model;
}
function shiftDate(date, deltaDays) {
  const parts = date.split("-").map(Number);
  const year = parts[0] ?? 1970;
  const month = parts[1] ?? 1;
  const day = parts[2] ?? 1;
  return new Date(Date.UTC(year, month - 1, day) + deltaDays * 864e5).toISOString().slice(0, 10);
}

// src/client/source.ts
var SUMMARY_PATH = "/api/token-stats/summary";
function errorMessageOf(body) {
  if (typeof body !== "object" || body === null) return void 0;
  const error = body.error;
  if (typeof error !== "object" || error === null) return void 0;
  const message = error.message;
  return typeof message === "string" ? message : void 0;
}
async function fetchSummary(force = false) {
  const url = force ? `${SUMMARY_PATH}?force=1` : SUMMARY_PATH;
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    headers: { accept: "application/json" }
  });
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
    throw new Error(errorMessageOf(body) ?? `HTTP ${String(response.status)}`);
  }
  if (typeof body !== "object" || body === null) throw new Error("empty response");
  return body;
}

// src/client/TokenStats.tsx
var import_jsx_runtime = require("react/jsx-runtime");
var PALETTE = ["#4d6bfe", "#22a06b", "#e6a23c", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#64748b"];
function useSummary() {
  const [state, setState] = (0, import_react.useState)({ status: "loading" });
  const ticket = (0, import_react.useRef)(0);
  const load = (0, import_react.useCallback)((force = false) => {
    const mine = ticket.current + 1;
    ticket.current = mine;
    if (force) setState((previous) => ({ ...previous, refreshing: true }));
    fetchSummary(force).then(
      (data) => {
        if (mine === ticket.current) setState({ status: "ready", data });
      },
      (error) => {
        if (mine !== ticket.current) return;
        const message = error instanceof Error ? error.message : String(error);
        setState((previous) => previous.data === void 0 ? { status: "error", error: message } : { status: "ready", data: previous.data, staleError: message });
      }
    );
  }, []);
  (0, import_react.useEffect)(() => {
    load(false);
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") load(false);
    }, 2e4);
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") load(false);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      ticket.current += 1;
    };
  }, [load]);
  return { state, reload: load };
}
function colorMap(data) {
  const map = /* @__PURE__ */ new Map();
  const ranked = [...data?.models ?? []].sort((a, b) => b.total - a.total);
  ranked.forEach((model, index) => {
    map.set(model.model, PALETTE[index % PALETTE.length] ?? "#64748b");
  });
  return map;
}
function modelTotalsOf(data, range, colors) {
  const first = shiftDate(data.today.date, -(range - 1));
  const sums = /* @__PURE__ */ new Map();
  for (const day of data.days) {
    if (day.date < first || day.date > data.today.date) continue;
    for (const [model, tokens] of Object.entries(day.models)) sums.set(model, (sums.get(model) ?? 0) + tokens);
  }
  const total = [...sums.values()].reduce((sum, value) => sum + value, 0);
  const models = [...sums.entries()].filter(([, tokens]) => tokens > 0).sort((a, b) => b[1] - a[1]).map(([model, tokens]) => ({ model, tokens, share: total > 0 ? tokens / total : 0, color: colors.get(model) ?? "#64748b" }));
  return { total, models };
}
function dayRowsOf(data, range, colors) {
  const byDate = new Map(data.days.map((day) => [day.date, day]));
  const raw = [];
  for (let offset = range - 1; offset >= 0; offset -= 1) {
    const date = shiftDate(data.today.date, -offset);
    raw.push({ date, day: byDate.get(date), today: offset === 0 });
  }
  const max = raw.reduce((highest, row) => Math.max(highest, row.day?.billed ?? 0), 0);
  return raw.map(({ date, day, today }) => {
    const billed = day?.billed ?? 0;
    const percent = max > 0 && billed > 0 ? Math.max(2, billed / max * 100) : 0;
    const parts = Object.entries(day?.models ?? {}).filter(([, tokens]) => tokens > 0).sort((a, b) => b[1] - a[1]).map(([model, tokens]) => ({ model, percent: billed > 0 ? tokens / billed * 100 : 0, color: colors.get(model) ?? "#64748b" }));
    return { date, billed, today, percent, parts };
  });
}
function exact(value) {
  return `${Math.round(value).toLocaleString()} tokens`;
}
function width(share) {
  return `${Math.max(2, Math.round(share * 100))}%`;
}
function TokenStats({ wide = true, t }) {
  const [open, setOpen] = (0, import_react.useState)(false);
  const [range, setRange] = (0, import_react.useState)(1);
  const [placement, setPlacement] = (0, import_react.useState)(null);
  const rootRef = (0, import_react.useRef)(null);
  const popRef = (0, import_react.useRef)(null);
  const { state, reload } = useSummary();
  const data = state.data;
  const colors = (0, import_react.useMemo)(() => colorMap(data), [data]);
  const todaySplit = (0, import_react.useMemo)(() => data === void 0 ? void 0 : modelTotalsOf(data, 1, colors), [data, colors]);
  const rangeSplit = (0, import_react.useMemo)(() => data === void 0 ? void 0 : modelTotalsOf(data, range, colors), [data, range, colors]);
  const week = (0, import_react.useMemo)(() => data === void 0 ? [] : dayRowsOf(data, 7, colors), [data, colors]);
  const dayRows = (0, import_react.useMemo)(() => data === void 0 ? [] : dayRowsOf(data, range === 1 ? 7 : range, colors), [data, range, colors]);
  const totalText = data === void 0 ? "\u2014" : formatTokens(data.today.billed);
  const toggle = (0, import_react.useCallback)(() => {
    setOpen((previous) => !previous);
  }, []);
  (0, import_react.useEffect)(() => {
    if (!open) return;
    const place = () => {
      const anchor = rootRef.current?.getBoundingClientRect();
      if (anchor === void 0) return;
      const w = Math.min(340, Math.max(280, window.innerWidth - 24));
      setPlacement({
        left: Math.min(Math.max(8, anchor.left), Math.max(8, window.innerWidth - w - 8)),
        bottom: Math.max(8, window.innerHeight - anchor.top + 6),
        width: w,
        maxHeight: Math.max(260, Math.min(anchor.top - 12, 680))
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);
  (0, import_react.useEffect)(() => {
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
  const todayModels = todaySplit?.models ?? [];
  const card = wide ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "button",
    {
      type: "button",
      className: "dst-card",
      onClick: toggle,
      "aria-expanded": open,
      "aria-label": open ? t("aria.close") : t("aria.open"),
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dst-head", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dst-title", children: t("title") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dst-caret", "aria-hidden": true, children: open ? "\u25BE" : "\u25B4" })
        ] }),
        state.status === "error" && data === void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dst-note", "data-bad": "", children: t("error.short") }) : data === void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dst-note", children: t("loading") }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dst-big-row", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dst-big", title: exact(data.today.billed), children: totalText }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dst-big-label", children: t("today.short") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dst-spark", "aria-hidden": true, title: t("spark.title"), children: week.map((row) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", { "data-today": row.today ? "true" : void 0, style: { height: `${Math.max(row.percent, row.billed > 0 ? 8 : 4)}%` } }, row.date)) })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dst-split", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { title: exact(data.today.uncachedInput), children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: formatTokens(data.today.uncachedInput) }),
              " ",
              t("split.input")
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { title: exact(data.today.cacheRead), children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: formatTokens(data.today.cacheRead) }),
              " ",
              t("split.cache")
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { title: exact(data.today.output), children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: formatTokens(data.today.output) }),
              " ",
              t("split.output")
            ] })
          ] }),
          todayModels.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dst-note", children: t("empty.short") }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dst-stack", "aria-hidden": true, children: todayModels.map((model) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", { style: { width: width(model.share), background: model.color } }, model.model)) }),
          todayModels.slice(0, 3).map((model) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dst-model", title: model.model, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dst-swatch", style: { background: model.color } }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dst-model-name", children: shortModel(model.model) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dst-model-tok", children: formatTokens(model.tokens) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dst-model-share", children: formatPercent(model.share) })
          ] }, model.model))
        ] })
      ]
    }
  ) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    "button",
    {
      type: "button",
      className: "dst-rail",
      onClick: toggle,
      "aria-expanded": open,
      "aria-label": open ? t("aria.close") : t("aria.open"),
      title: `${t("title")} \xB7 ${totalText}`,
      children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dst-rail-bars", "aria-hidden": true, children: (week.length > 0 ? week.slice(-4) : [40, 72, 56, 100].map((h) => ({ date: String(h), percent: h }))).map((row) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", { style: { height: `${Math.max(12, row.percent)}%` } }, row.date)) })
    }
  );
  const rangeTitle = range === 1 ? t("range.today") : range === 7 ? t("range.7") : t("range.30");
  const body = data !== void 0 && data.totals.billed > 0 && rangeSplit !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dst-tabs", role: "tablist", children: [1, 7, 30].map((value) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "button",
      {
        type: "button",
        role: "tab",
        className: "dst-tab",
        "aria-selected": range === value,
        "data-on": range === value,
        onClick: () => {
          setRange(value);
        },
        children: value === 1 ? t("range.today") : value === 7 ? t("range.7") : t("range.30")
      },
      value
    )) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dst-hero", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dst-hero-value", title: exact(rangeSplit.total), children: [
        formatTokens(rangeSplit.total),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dst-hero-unit", children: "tokens" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dst-hero-note", children: t("hero.note", { range: rangeTitle, time: timeOfDay(data.generatedAt) }) })
    ] }),
    range === 1 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dst-cells", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dst-cell", title: exact(data.today.uncachedInput), children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: t("split.input") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: formatTokens(data.today.uncachedInput) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dst-cell", title: exact(data.today.cacheRead), children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: t("split.cache") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: formatTokens(data.today.cacheRead) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dst-cell", title: exact(data.today.output), children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: t("split.output") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: formatTokens(data.today.output) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dst-cell", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: t("split.calls") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: data.today.events })
      ] })
    ] }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dst-section", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dst-section-title", children: t("models.title") }),
      rangeSplit.models.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dst-empty-hint", children: t("empty.range") }) : rangeSplit.models.map((model) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dst-model-row", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dst-model-row-head", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dst-swatch", style: { background: model.color } }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dst-model-name", title: model.model, children: model.model }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dst-model-tok", title: exact(model.tokens), children: formatTokens(model.tokens) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dst-model-share", children: formatPercent(model.share) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dst-track", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dst-fill", style: { width: width(model.share), background: model.color } }) })
      ] }, model.model))
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dst-section", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dst-section-title", children: range === 30 ? t("daily.title30") : t("daily.title7") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dst-days", children: dayRows.map((row) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dst-day", "data-today": row.today ? "true" : void 0, "data-zero": row.billed === 0 ? "true" : void 0, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dst-day-date", children: shortDate(row.date) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dst-day-track", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dst-day-bar", style: { width: `${row.percent}%` }, children: row.parts.map((part) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", { title: part.model, style: { width: `${part.percent}%`, background: part.color } }, part.model)) }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dst-day-tok", title: row.billed > 0 ? exact(row.billed) : void 0, children: row.billed > 0 ? formatTokens(row.billed) : t("value.none") })
      ] }, row.date)) })
    ] })
  ] }) : state.status === "error" && data === void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dst-error", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dst-error-title", children: t("error.title") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dst-error-hint", children: [
      t("error.hint"),
      state.error === void 0 ? "" : ` (${state.error})`
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dst-retry", onClick: () => reload(true), children: t("retry") })
  ] }) : data === void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dst-empty", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dst-empty-hint", children: t("loading") }) }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dst-empty", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dst-empty-title", children: t("empty.title") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dst-empty-hint", children: t("empty.hint") })
  ] });
  const footer = data === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dst-pop-foot", children: [
    state.staleError !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dst-foot-line", "data-bad": "", title: state.staleError, children: t("stale", { time: timeOfDay(data.generatedAt) }) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dst-foot-line", children: t("foot.scope") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dst-foot-line", children: t("foot.updated", { time: timeOfDay(data.generatedAt), files: data.source.sessionFiles, events: data.source.usageEvents }) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dst-refresh", disabled: state.refreshing === true, onClick: () => reload(true), children: state.refreshing === true ? t("refreshing") : t("refresh") })
  ] });
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dst-root", ref: rootRef, children: [
    card,
    open && placement !== null ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "div",
      {
        ref: popRef,
        className: "dst-pop",
        role: "dialog",
        "aria-label": t("title"),
        style: { left: placement.left, bottom: placement.bottom, width: placement.width, maxHeight: placement.maxHeight },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dst-pop-head", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dst-pop-title", children: t("title") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dst-pop-sub", children: data?.today.date ?? "" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dst-close", onClick: () => setOpen(false), "aria-label": t("close"), children: "\xD7" })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dst-pop-body", children: body }),
          footer
        ]
      }
    ) : null
  ] });
}

// src/client/index.ts
var inject = ["slots", "locale"];
function apply(ctx) {
  installStyles();
  ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), "client-ui-token-stats: dictionaries");
  const t = ctx.locale.bind(NS);
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
    name: "sidebar.footer.action",
    id: "token-stats",
    order: -100,
    locale: NS,
    inject: () => ({ t })
  }, TokenStats));
}

return module.exports}});
