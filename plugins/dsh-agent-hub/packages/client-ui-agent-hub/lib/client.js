window.__ModuleLoader__.load({id:"dsh-client-ui-agent-hub",factory:require=>{var module={exports:{}};var exports=module.exports;Object.defineProperty(exports,Symbol.toStringTag,{value:"Module"});
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
  BADGE_POLL_MS: () => BADGE_POLL_MS,
  BOARD_TAB_ID: () => BOARD_TAB_ID,
  BOARD_TAB_ORDER: () => BOARD_TAB_ORDER,
  FALLBACK_DELAY_MS: () => FALLBACK_DELAY_MS,
  PANEL_ID: () => PANEL_ID,
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/AgentHubPage.tsx
var import_react = require("react");

// src/client/contract.ts
var TASK_STATUSES = ["pending", "accepted", "running", "waiting_input", "completed", "failed", "cancelled", "dead"];
var AGENT_STATUSES = ["online", "pending", "offline", "left", "revoked"];

// src/client/desk.ts
var LANES = ["queued", "claimed", "running", "waiting", "ended"];
var SELF_PREFIX = "dsh-self";
function laneOf(task) {
  if (task.status === "waiting_input") return "waiting";
  const finished = isFinished(task);
  const asks = task.stage === "needs_input" || task.result?.needs_input !== void 0 && task.result.needs_input !== "";
  const handled = task.acknowledged === true || task.in_history === true;
  if (asks && !handled && (!finished || task.result?.status === "partial" || task.status === "failed")) return "waiting";
  if (finished) return "ended";
  if (task.status === "pending") return "queued";
  if (task.status === "accepted") return "claimed";
  return "running";
}
function isFinished(task) {
  return task.status === "completed" || task.status === "failed" || task.status === "cancelled" || task.status === "dead";
}
function clearActionOf(task) {
  return isFinished(task) ? "ack" : "cancel";
}
function lanesOf(tasks) {
  const out = { queued: [], claimed: [], running: [], waiting: [], ended: [] };
  for (const task of tasks) out[laneOf(task)].push(task);
  const at = (task) => task.updated_at ?? task.finished_at ?? task.created_at;
  for (const lane of LANES) out[lane].sort((a, b) => at(b).localeCompare(at(a)));
  out.queued.reverse();
  return out;
}
function agentGroups(agents) {
  const live = /* @__PURE__ */ new Map();
  const dormant = [];
  for (const agent of agents) {
    if (agent.dormant === true || agent.revoked) {
      dormant.push(agent);
      continue;
    }
    const kind = agent.dsh_profile !== void 0 && agent.dsh_profile !== "" ? "profile" : agent.node !== void 0 && agent.node !== "" ? "node" : "none";
    const key = kind === "profile" ? agent.dsh_profile ?? "" : kind === "node" ? agent.node ?? "" : "";
    const id = `${kind}:${key}`;
    const slot = live.get(id) ?? { kind, agents: [] };
    slot.agents.push(agent);
    live.set(id, slot);
  }
  const rank = { profile: 0, node: 1, none: 2 };
  const groups = [...live.entries()].map(([id, slot]) => ({ key: id.slice(id.indexOf(":") + 1), kind: slot.kind, agents: slot.agents })).sort((a, b) => rank[a.kind] - rank[b.kind] || a.key.localeCompare(b.key));
  return { groups, dormant };
}
function selfParts(id) {
  const parts = id.split("/");
  if (parts[0] !== SELF_PREFIX) return {};
  return { profile: parts[1] === "" ? void 0 : parts[1], partition: parts.slice(2).join("/") || void 0 };
}
function selfWorkers(tasks) {
  const byId = /* @__PURE__ */ new Map();
  for (const task of tasks) {
    if (task.origin?.kind !== "local" || laneOf(task) === "ended") continue;
    const id = task.origin.executor ?? task.assigned_to ?? SELF_PREFIX;
    byId.set(id, [...byId.get(id) ?? [], task]);
  }
  const out = /* @__PURE__ */ new Map();
  for (const [id, held] of [...byId.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const { profile, partition } = selfParts(id);
    const worker = { id, profile: profile ?? held[0]?.dsh_profile, partition, tasks: held, quiet: held.filter((task) => task.quiet === true).length };
    const key = worker.profile ?? "";
    out.set(key, [...out.get(key) ?? [], worker]);
  }
  return out;
}
function fallbackTasks(tasks) {
  return tasks.filter((task) => task.origin?.kind !== "local" && task.fallback_by !== void 0 && task.fallback_by !== "");
}
function fallbackReason(history) {
  const entry = [...history].reverse().find((event) => event.event === "fallback");
  if (entry === void 0) return void 0;
  const text = entry.message ?? "";
  if (/no worker .*online/i.test(text)) return "nobody-online";
  if (/nobody took it in time/i.test(text)) return "waited-out";
  return "other";
}
function timeline(history) {
  const out = [];
  for (const event of history) {
    const empty = (event.message === void 0 || event.message === "") && event.stage === void 0;
    if (event.event === "progress" && empty) continue;
    const last = out.at(-1);
    if (last !== void 0 && event.event === "progress" && last.event === "progress" && event.stage === last.stage && event.message === last.message) continue;
    out.push(event);
  }
  return out.reverse();
}
function registeredBy(event) {
  if (event.event !== "registered") return void 0;
  const match = /^(\S+) runs it itself(?: \((.+)\))?$/.exec(event.message ?? "");
  if (match === null) return void 0;
  return match[2] === void 0 ? { by: match[1] ?? "" } : { by: match[1] ?? "", executor: match[2] };
}
function stageOf(task) {
  if (task.status === "completed" || task.status === "cancelled") return void 0;
  return task.stage;
}
function answerable(task) {
  if (task.origin?.kind === "local") return false;
  if (task.status === "waiting_input") return true;
  return task.question !== void 0 && (task.status === "accepted" || task.status === "running");
}
function durationParts(ms) {
  if (ms === void 0 || !Number.isFinite(ms) || ms < 0) return void 0;
  const s = ms / 1e3;
  if (s < 60) return { value: String(Math.round(s)), unit: "s" };
  if (s < 3600) return { value: String(Math.round(s / 60)), unit: "m" };
  if (s < 86400) return { value: (s / 3600).toFixed(s < 36e3 ? 1 : 0), unit: "h" };
  return { value: (s / 86400).toFixed(1), unit: "d" };
}
function percentOf(rate) {
  return rate === void 0 || !Number.isFinite(rate) ? void 0 : `${Math.round(rate * 100)}%`;
}

// src/client/format.ts
function ageMs(iso, now = Date.now()) {
  if (iso === void 0) return void 0;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.max(0, now - at) : void 0;
}
function span(ms) {
  const s = Math.round(ms / 1e3);
  if (s < 60) return { unit: "s", n: s };
  const m = Math.round(s / 60);
  if (m < 60) return { unit: "m", n: m };
  const h = Math.round(m / 60);
  if (h < 48) return { unit: "h", n: h };
  return { unit: "d", n: Math.round(h / 24) };
}
var AGO = { s: "ago.s", m: "ago.m", h: "ago.h", d: "ago.d" };
var DUR = { s: "dur.s", m: "dur.m", h: "dur.h", d: "dur.d" };
function relative(iso, t, now = Date.now()) {
  const ms = ageMs(iso, now);
  if (ms === void 0) return t("value.none");
  const { unit, n } = span(ms);
  return t(AGO[unit], { n });
}
function duration(iso, t, now = Date.now()) {
  const ms = ageMs(iso, now);
  if (ms === void 0) return t("value.none");
  const { unit, n } = span(ms);
  return t(DUR[unit], { n });
}
function agentStatus(agent) {
  const status = agent.status;
  if (typeof status === "string" && AGENT_STATUSES.includes(status)) return status;
  if (agent.revoked === true) return "revoked";
  return agent.online === true ? "online" : "offline";
}
function agentCounts(agents, hub) {
  const counts = { online: 0, pending: 0, offline: 0, left: 0, revoked: 0 };
  let fromHub = false;
  if (typeof hub === "object" && hub !== null) {
    for (const status of AGENT_STATUSES) {
      const value = hub[status];
      if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
        counts[status] = value;
        fromHub = true;
      }
    }
  }
  if (!fromHub) for (const agent of agents) counts[agentStatus(agent)] += 1;
  const total = AGENT_STATUSES.reduce((sum, status) => sum + counts[status], 0);
  return { counts, total };
}
function sortAgents(agents) {
  const rank = (agent) => AGENT_STATUSES.indexOf(agentStatus(agent));
  return agents.map((agent, index) => ({ agent, index })).sort((left, right) => rank(left.agent) - rank(right.agent) || left.index - right.index).map((item) => item.agent);
}
function presence(agent, t, now = Date.now(), labelled = true) {
  const status = agentStatus(agent);
  if (status === "offline" || status === "left") {
    const since = status === "left" ? agent.left_at ?? agent.last_seen : agent.last_seen;
    if (since === void 0) return t("agent.never");
    return t("presence.offline", { time: duration(since, t, now) });
  }
  if (agent.last_seen === void 0) return t("agent.never");
  const time = relative(agent.last_seen, t, now);
  return labelled ? t("presence.seen", { time }) : time;
}
function until(iso, t, now = Date.now()) {
  if (iso === void 0) return t("value.none");
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return t("value.none");
  const s = Math.round((at - now) / 1e3);
  if (s <= 0) return t("lease.expired");
  if (s < 60) return t("in.s", { n: s });
  const m = Math.round(s / 60);
  if (m < 60) return t("in.m", { n: m });
  return t("in.h", { n: Math.round(m / 60) });
}
function absolute(iso) {
  if (iso === void 0) return "";
  const at = Date.parse(iso);
  return Number.isFinite(at) ? new Date(at).toLocaleString() : iso;
}
function clock(ms) {
  if (ms === void 0) return "";
  const d = new Date(ms);
  const two = (n) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}
function percent(progress) {
  if (typeof progress !== "number" || !Number.isFinite(progress)) return void 0;
  return `${String(Math.round(Math.min(1, Math.max(0, progress)) * 100))}%`;
}
function bytes(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  if (value < 1024) return `${String(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

// src/client/HubIcon.tsx
var import_jsx_runtime = require("react/jsx-runtime");
function HubIcon({ size = 18, active = false }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { width: size, height: size, viewBox: "0 0 18 18", fill: "none", "aria-hidden": "true", style: { opacity: active ? 1 : 0.72 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("circle", { cx: "9", cy: "9", r: "2.4", stroke: "currentColor", strokeWidth: "1.4" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("circle", { cx: "9", cy: "2.6", r: "1.4", fill: "currentColor" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("circle", { cx: "3.2", cy: "13.4", r: "1.4", fill: "currentColor" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("circle", { cx: "14.8", cy: "13.4", r: "1.4", fill: "currentColor" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M9 4v2.6M4.4 12.6l2.5-1.9M13.6 12.6l-2.5-1.9", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round" })
  ] });
}

// src/client/source.ts
var ADMIN_BASE = "/api/agent-hub/admin";
var SourceError = class extends Error {
  status;
  code;
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
};
function errorOf(body) {
  if (typeof body !== "object" || body === null) return void 0;
  const error = body.error;
  if (typeof error !== "object" || error === null) return void 0;
  const { code, message } = error;
  return {
    code: typeof code === "string" ? code : void 0,
    message: typeof message === "string" ? message : void 0
  };
}
function getJson(path, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== void 0 && value !== "") query.set(key, String(value));
  }
  const text = query.toString();
  return send(`${ADMIN_BASE}/${path}${text === "" ? "" : `?${text}`}`, { method: "GET" });
}
async function send(url, init) {
  let response;
  try {
    response = await fetch(url, { credentials: "same-origin", cache: "no-store", ...init, headers: { accept: "application/json", ...init.headers ?? {} } });
  } catch (error) {
    throw new SourceError(error instanceof Error ? error.message : String(error), 0);
  }
  const raw = await response.text();
  let body;
  if (raw.trim() !== "") {
    try {
      body = JSON.parse(raw);
    } catch {
      body = void 0;
    }
  }
  if (!response.ok) {
    const parts = errorOf(body);
    throw new SourceError(parts?.message ?? `HTTP ${String(response.status)}`, response.status, parts?.code);
  }
  if (typeof body !== "object" || body === null) throw new SourceError("empty response", response.status);
  return body;
}
function fetchOverview() {
  return getJson("overview");
}
function fetchAgents() {
  return getJson("agents");
}
function fetchTasks(filter) {
  return getJson("tasks", {
    status: filter.status === "all" ? void 0 : filter.status,
    agent: filter.agent === "" ? void 0 : filter.agent,
    limit: filter.limit,
    history: filter.history === void 0 || filter.history === "hide" ? void 0 : filter.history
  });
}
function fetchTask(taskId) {
  return getJson("task", { task_id: taskId });
}
function fetchRequests(status) {
  return getJson("requests", { status });
}
function fetchSession(taskId, after = 0, limit = 200) {
  return getJson("session", { task_id: taskId, after, limit });
}
async function cancelTask(taskId) {
  const body = await send(`${ADMIN_BASE}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task_id: taskId })
  });
  return body.task;
}
async function ackTask(taskId) {
  const body = await send(`${ADMIN_BASE}/ack`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task_id: taskId })
  });
  return body.task;
}
function fetchTimeline(taskId) {
  return getJson("timeline", { task_id: taskId });
}
function fetchMetrics(hours) {
  return getJson("metrics", { hours });
}
async function answerTask(taskId, answer) {
  const body = await send(`${ADMIN_BASE}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task_id: taskId, answer })
  });
  return body.task;
}

// src/client/AgentHubPage.tsx
var import_jsx_runtime2 = require("react/jsx-runtime");
var REFRESH_MS = 1e4;
var EMPTY = { overview: {}, agents: {}, tasks: {}, requests: {}, refreshing: false, first: true };
var REQUEST_FILTERS = ["pending", "approved", "rejected", "expired", "all"];
var LIMITS = [20, 50, 100, 200];
function merge(previous, outcome, now) {
  return outcome.status === "fulfilled" ? { data: outcome.value, at: now } : { data: previous.data, at: previous.at, error: outcome.reason };
}
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
function failureText(error, t) {
  const status = error instanceof SourceError ? error.status : void 0;
  if (status === 401) return t("error.login");
  if (status === 403) return t("error.forbidden");
  return `${t("error.unavailable")} (${messageOf(error)})`;
}
function useBoard(filter, requestStatus, auto, active = true, onOverview) {
  const [board, setBoard] = (0, import_react.useState)(EMPTY);
  const ticket = (0, import_react.useRef)(0);
  const report = (0, import_react.useRef)(onOverview);
  (0, import_react.useEffect)(() => {
    report.current = onOverview;
  }, [onOverview]);
  const load = (0, import_react.useCallback)((manual) => {
    ticket.current += 1;
    const mine = ticket.current;
    if (manual) setBoard((previous) => ({ ...previous, refreshing: true }));
    void Promise.allSettled([fetchOverview(), fetchAgents(), fetchTasks(filter), fetchRequests(requestStatus)]).then((outcomes) => {
      if (mine !== ticket.current) return;
      const [o, a, tk, r] = outcomes;
      const now = Date.now();
      if (o.status === "fulfilled") report.current?.(o.value);
      const failed = outcomes.find((x) => x.status === "rejected");
      const anyOk = outcomes.some((x) => x.status === "fulfilled");
      setBoard((previous) => ({
        overview: merge(previous.overview, o, now),
        agents: merge(previous.agents, a, now),
        tasks: merge(previous.tasks, tk, now),
        requests: merge(previous.requests, r, now),
        loadedAt: anyOk ? now : previous.loadedAt,
        lastError: failed?.reason,
        refreshing: false,
        first: false
      }));
    });
  }, [filter, requestStatus]);
  (0, import_react.useEffect)(() => {
    load(false);
  }, [load]);
  const wasActive = (0, import_react.useRef)(active);
  (0, import_react.useEffect)(() => {
    if (active && !wasActive.current && document.visibilityState !== "hidden") load(false);
    wasActive.current = active;
  }, [active, load]);
  (0, import_react.useEffect)(() => {
    if (!auto || !active) return void 0;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") load(false);
    }, REFRESH_MS);
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") load(false);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [auto, active, load]);
  (0, import_react.useEffect)(() => () => {
    ticket.current += 1;
  }, []);
  return { board, load };
}
function useDetail(taskId, tick) {
  const [detail, setDetail] = (0, import_react.useState)({});
  const ticket = (0, import_react.useRef)(0);
  (0, import_react.useEffect)(() => {
    ticket.current += 1;
    const mine = ticket.current;
    if (taskId === void 0) {
      setDetail({});
      return void 0;
    }
    fetchTask(taskId).then(
      (doc) => {
        if (mine === ticket.current) setDetail({ id: taskId, data: doc, at: Date.now() });
      },
      (error) => {
        if (mine !== ticket.current) return;
        setDetail((previous) => ({ id: taskId, data: previous.id === taskId ? previous.data : void 0, at: previous.at, error }));
      }
    );
    return void 0;
  }, [taskId, tick]);
  (0, import_react.useEffect)(() => () => {
    ticket.current += 1;
  }, []);
  return detail;
}
function statusLabel(status, t) {
  return t(`status.${status}`);
}
var AGENT_STATUS_KEY = {
  online: "agent.status.online",
  pending: "agent.status.pending",
  offline: "agent.status.offline",
  left: "agent.status.left",
  revoked: "agent.status.revoked"
};
function AgentBadge({ agent, t }) {
  const status = agentStatus(agent);
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-badge", "data-tone": status, children: t(AGENT_STATUS_KEY[status]) });
}
function countsText(counts, t, keep) {
  return AGENT_STATUSES.filter(keep).map((status) => t("stat.online.part", { label: t(AGENT_STATUS_KEY[status]), n: counts[status] })).join(" \xB7 ");
}
function OfflineNote({ counts, t }) {
  const n = counts.offline + counts.left;
  if (n <= 0) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-count-note", title: t("agents.offline.hint", { offline: counts.offline, left: counts.left }), children: t("agents.offline", { n }) });
}
var PRESENCE_RE = /\b(worker-lost|worker-offline|agent-offline)\b/;
var PRESENCE_KEY = {
  "worker-lost": "history.worker-lost",
  "worker-offline": "history.worker-offline",
  "agent-offline": "history.agent-offline"
};
function presenceEvent(event) {
  const match = PRESENCE_RE.exec(`${event.event ?? ""} ${event.message ?? ""}`);
  const found = match?.[1];
  return found === "worker-lost" || found === "worker-offline" || found === "agent-offline" ? found : void 0;
}
function historyText(event, t) {
  const own = registeredBy(event);
  if (own === void 0) return event.message ?? "";
  return own.executor === void 0 ? t("history.registered", { by: own.by }) : t("history.registered.at", { by: own.by, executor: own.executor });
}
function onActivate(run) {
  return (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      run();
    }
  };
}
function Chips({ items, empty }) {
  if (items.length === 0) return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-muted", children: empty });
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-chips", children: items.map((item) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-chip", children: item }, item)) });
}
function SectionError({ error, t }) {
  if (error === void 0) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dah-alert", role: "alert", children: t("error.section", { error: messageOf(error) }) });
}
function Empty({ children, page = false }) {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-empty", "data-size": page ? "page" : void 0, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-empty-icon", "aria-hidden": "true", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(HubIcon, { size: 28 }) }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children })
  ] });
}
function useShown(target, enabled) {
  const [shown, setShown] = (0, import_react.useState)(true);
  (0, import_react.useEffect)(() => {
    if (!enabled) {
      setShown(true);
      return void 0;
    }
    const node = target.current;
    if (node === null || typeof IntersectionObserver === "undefined") return void 0;
    const observer = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last !== void 0) setShown(last.isIntersecting);
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [target, enabled]);
  return shown;
}
var PARTS = ["agents", "requests", "tasks", "fallback", "ended", "metrics"];
var FOLDS_KEY = "dah.embed.open";
function readFolds() {
  try {
    const raw = globalThis.sessionStorage?.getItem(FOLDS_KEY);
    if (raw === null || raw === void 0 || raw === "") return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out = {};
    for (const part of PARTS) {
      const value = parsed[part];
      if (typeof value === "boolean") out[part] = value;
    }
    return out;
  } catch {
    return {};
  }
}
function writeFolds(folds) {
  try {
    globalThis.sessionStorage?.setItem(FOLDS_KEY, JSON.stringify(folds));
  } catch {
  }
}
var present = (part) => part !== void 0 && part !== "";
function Caret() {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
    "svg",
    {
      className: "dah-caret",
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
      children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("path", { d: "M6 4l4 4-4 4" })
    }
  );
}
function EmbeddedFold({ part, title, count, note, open, onToggle, tools, children }) {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { className: "dah-group", "data-part": part, "data-open": open, "aria-label": title, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-group-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("button", { type: "button", className: "dah-group-toggle", "aria-expanded": open, onClick: onToggle, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Caret, {}),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-group-title", children: title }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-count", children: count }),
        note
      ] }),
      open ? tools : null
    ] }),
    open ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dah-group-body", children }) : null
  ] });
}
function AgentItem({ agent, titles, now, t, onTask }) {
  const status = agentStatus(agent);
  const meta = [
    agent.platform,
    agent.mode,
    // busy / idle is only meaningful while the worker is around.
    agent.reported_status !== void 0 && status === "online" ? t(`agent.${agent.reported_status}`) : void 0,
    t("embed.conc", { n: agent.running_tasks.length, max: agent.max_concurrency ?? 1 }),
    present(agent.version) ? t("agent.version", { v: agent.version }) : void 0,
    presence(agent, t, now)
  ].filter(present);
  const tip = [
    agent.description,
    agent.capabilities.length === 0 ? void 0 : `${t("agents.col.caps")}: ${agent.capabilities.join(", ")}`,
    agent.node === void 0 ? void 0 : `${t("group.node", { name: agent.node })}`,
    agent.last_seen === void 0 ? void 0 : `${t("agents.col.seen")}: ${absolute(agent.last_seen)}`,
    agent.left_at === void 0 ? void 0 : `${t("agent.status.left")}: ${absolute(agent.left_at)}`
  ].filter(present).join("\n");
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("li", { className: "dah-item", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-item-row", title: tip === "" ? void 0 : tip, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-item-top", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-item-title dah-id", children: agent.agent_id }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(AgentBadge, { agent, t })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-item-meta", children: meta.join(" \xB7 ") }),
    agent.running_tasks.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-chips", children: agent.running_tasks.map((id) => {
      const title = titles?.get(id);
      return title === void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dah-chip dah-id", onClick: () => {
        onTask(id);
      }, children: id }, id) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dah-chip", title: id, onClick: () => {
        onTask(id);
      }, children: title }, id);
    }) }) : null
  ] }) });
}
function SelfItem({ worker, t, onTask }) {
  const meta = [
    t("self.busy", { n: worker.tasks.length }),
    worker.quiet > 0 ? t("self.quiet", { n: worker.quiet }) : void 0
  ].filter(present);
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("li", { className: "dah-item", "data-kind": "self", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-item-row", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-item-top", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-item-title dah-id", children: worker.id }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-badge", "data-tone": "self", children: t("self.badge") })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-item-meta", children: meta.join(" \xB7 ") }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-chips", children: worker.tasks.map((task) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dah-chip", title: task.task_id, onClick: () => {
      onTask(task.task_id);
    }, children: task.title }, task.task_id)) })
  ] }) });
}
function groupTitle(group, t) {
  if (group.kind === "profile") return t("group.profile", { name: group.key });
  if (group.kind === "node") return t("group.node", { name: group.key });
  return t("group.none");
}
function EmbeddedAgents({ agents, tasks, loaded, now, t, onTask }) {
  const [showDormant, setShowDormant] = (0, import_react.useState)(false);
  const { groups, dormant } = (0, import_react.useMemo)(() => agentGroups(agents), [agents]);
  const selves = (0, import_react.useMemo)(() => selfWorkers(tasks), [tasks]);
  const titles = (0, import_react.useMemo)(() => new Map(tasks.filter((task) => task.title !== "").map((task) => [task.task_id, task.title])), [tasks]);
  const all = [...groups];
  for (const profile of selves.keys()) {
    if (!all.some((group) => group.kind === "profile" && group.key === profile)) {
      all.push({ key: profile, kind: profile === "" ? "none" : "profile", agents: [] });
    }
  }
  if (all.length === 0 && dormant.length === 0) return loaded ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Empty, { children: t("agents.empty") }) : null;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
    all.map((group) => {
      const mine = group.kind === "profile" ? selves.get(group.key) ?? [] : group.kind === "none" ? selves.get("") ?? [] : [];
      return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-sub", children: [
        all.length > 1 || group.kind !== "none" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dah-sub-head", children: groupTitle(group, t) }) : null,
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("ul", { className: "dah-list", children: [
          group.agents.map((agent) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(AgentItem, { agent, titles, now, t, onTask }, agent.agent_id)),
          mine.map((worker) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(SelfItem, { worker, t, onTask }, worker.id))
        ] })
      ] }, `${group.kind}:${group.key}`);
    }),
    dormant.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-sub", "data-kind": "dormant", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dah-link", title: t("dormant.hint"), "aria-expanded": showDormant, onClick: () => {
        setShowDormant((value) => !value);
      }, children: showDormant ? t("dormant.hide") : t("dormant.show", { n: dormant.length }) }),
      showDormant ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("ul", { className: "dah-list", children: dormant.map((agent) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(AgentItem, { agent, titles, now, t, onTask }, agent.agent_id)) }) : null
    ] }) : null
  ] });
}
function EmbeddedRequests({ section, status, now, t }) {
  const requests = section.data?.requests ?? [];
  if (requests.length === 0) {
    if (section.data === void 0) return null;
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Empty, { children: status === "all" ? t("requests.empty.any") : t("requests.empty", { status: t(`req.${status}`) }) });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("ul", { className: "dah-list", children: requests.map((request) => {
    const meta = [
      request.request_id,
      [request.platform, request.mode].filter(present).join(" / "),
      present(request.from) ? t("embed.from", { from: request.from }) : void 0,
      relative(request.requested_at, t, now)
    ].filter(present);
    const tip = [
      request.description,
      request.capabilities.length === 0 ? void 0 : `${t("requests.col.caps")}: ${request.capabilities.join(", ")}`,
      `${t("requests.col.conc")}: ${String(request.max_concurrency ?? 1)}`,
      `${t("requests.col.at")}: ${absolute(request.requested_at)}`
    ].filter(present).join("\n");
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("li", { className: "dah-item", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-item-row", title: tip, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-item-top", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-item-title dah-id", children: request.agent_id }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-badge", "data-tone": request.status, children: t(`req.${request.status}`) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-item-meta", children: meta.join(" \xB7 ") }),
      present(request.reason) ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-item-note", title: request.reason, children: request.reason }) : null
    ] }) }, request.request_id);
  }) });
}
function originText(task, t) {
  const kind = task.origin?.kind;
  if (kind === "local") return present(task.dsh_profile) ? t("origin.local", { profile: task.dsh_profile }) : t("origin.local.any");
  if (kind === "agent") return t("origin.agent");
  return void 0;
}
function TaskItem({ task, on, detail, now, t, onToggle, onChanged }) {
  const progress = percent(task.progress);
  const stage = stageOf(task);
  const holder = task.origin?.kind === "local" ? task.origin.executor ?? task.assigned_to ?? task.agent : task.assigned_to !== void 0 && task.assigned_to !== task.agent ? `${task.agent} \u2192 ${task.assigned_to}` : task.agent;
  const meta = [
    holder,
    originText(task, t),
    task.priority === "normal" ? void 0 : t(`priority.${task.priority}`),
    task.attempts > 1 ? t("embed.attempts", { n: task.attempts }) : void 0,
    relative(task.updated_at ?? task.created_at, t, now)
  ].filter(present);
  const note = task.result === void 0 ? task.message : [task.result.error?.code, task.result.needs_input ?? task.result.summary].filter(present).join(" ");
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("li", { className: "dah-item", "data-on": on, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
      "div",
      {
        className: "dah-item-row",
        role: "button",
        tabIndex: 0,
        "aria-expanded": on,
        onClick: () => {
          onToggle(task.task_id);
        },
        onKeyDown: onActivate(() => {
          onToggle(task.task_id);
        }),
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-item-top", children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-item-title", title: `${task.title}
${task.task_id}`, children: task.title }),
            stage !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-badge", "data-tone": stage === "needs_input" || stage === "blocked" ? "pending" : task.status, children: t(`stage.${stage}`) }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-badge", "data-tone": task.status, children: statusLabel(task.status, t) })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-item-meta", title: absolute(task.created_at), children: meta.join(" \xB7 ") }),
          progress !== void 0 && (task.status === "running" || task.status === "accepted") ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-bar", title: progress, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("i", { style: { width: progress } }) }) : null,
          present(note) ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-item-note", "data-tone": task.result?.error !== void 0 ? "failed" : void 0, title: note, children: note }) : null,
          task.quiet === true ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-item-note", "data-tone": "quiet", children: t("task.quiet") }) : null
        ]
      }
    ),
    onChanged !== void 0 && laneOf(task) === "waiting" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dah-item-actions", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(ClearWaiting, { task, t, onDone: onChanged }) }) : null,
    on ? detail : null
  ] });
}
function EmbeddedTasks({ tasks, loaded, history, selected, detail, endedOpen, onEnded, now, t, onToggle, onChanged }) {
  const lanes = (0, import_react.useMemo)(() => lanesOf(tasks), [tasks]);
  const orphan = selected !== void 0 && !tasks.some((task) => task.task_id === selected);
  const item = (task) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(TaskItem, { task, on: selected === task.task_id, detail, now, t, onToggle, onChanged }, task.task_id);
  if (history) {
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
      orphan ? detail : null,
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dah-note", children: t("history.note") }),
      tasks.length === 0 ? loaded ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Empty, { children: t("history.empty") }) : null : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("ul", { className: "dah-list", children: tasks.map(item) })
    ] });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
    orphan ? detail : null,
    tasks.length === 0 && loaded ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Empty, { children: t("tasks.empty.all") }) : null,
    LANES.filter((lane) => lanes[lane].length > 0).map((lane) => {
      const rows = lanes[lane];
      const folded = lane === "ended" && !endedOpen;
      return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-sub", "data-lane": lane, children: [
        lane === "ended" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("button", { type: "button", className: "dah-sub-head", "data-button": "true", "aria-expanded": !folded, title: t("lane.ended.hint"), onClick: onEnded, children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Caret, {}),
          t(`lane.${lane}`),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-count", children: String(rows.length) })
        ] }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-sub-head", children: [
          t(`lane.${lane}`),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-count", children: String(rows.length) })
        ] }),
        folded ? null : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("ul", { className: "dah-list", children: rows.map(item) })
      ] }, lane);
    })
  ] });
}
function EmbeddedFallback({ tasks, selected, detail, now, t, onToggle }) {
  if (tasks.length === 0) return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Empty, { children: t("fallback.empty") });
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("ul", { className: "dah-list", children: tasks.map((task) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
    TaskItem,
    {
      task: { ...task, message: task.message ?? t("fallback.by", { by: task.fallback_by ?? "" }) },
      on: selected === task.task_id,
      detail,
      now,
      t,
      onToggle
    },
    task.task_id
  )) });
}
function AgentsSection({ agents, section, now, t, onTask }) {
  const { counts } = agentCounts(agents);
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { className: "dah-section", "aria-label": t("agents.title"), children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-section-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h2", { className: "dah-section-title", children: t("agents.title") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-count", children: `${String(counts.online)} / ${String(agents.length)}` }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(OfflineNote, { counts, t })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(SectionError, { error: section.error, t }),
    agents.length === 0 ? section.data !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Empty, { children: t("agents.empty") }) : null : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dah-table-wrap", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("table", { className: "dah-table", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("thead", { children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("tr", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("agents.col.agent") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("agents.col.state") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("agents.col.platform") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("agents.col.caps") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("agents.col.conc") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("agents.col.running") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("agents.col.seen") })
      ] }) }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("tbody", { children: agents.map((agent) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("tr", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("td", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-id", children: agent.agent_id }),
          present(agent.version) ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-sub-line", children: t("agent.version", { v: agent.version }) }) : null,
          agent.description !== void 0 && agent.description !== "" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-sub-line dah-clip", title: agent.description, children: agent.description }) : null
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("td", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(AgentBadge, { agent, t }),
          agent.reported_status !== void 0 && agentStatus(agent) === "online" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-sub-line", children: t(`agent.${agent.reported_status}`) }) : null
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("td", { children: [
          agent.platform ?? t("value.none"),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-sub-line", children: agent.mode ?? "" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Chips, { items: agent.capabilities, empty: t("value.none") }) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { className: "dah-num", children: `${String(agent.running_tasks.length)} / ${String(agent.max_concurrency ?? 1)}` }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { children: agent.running_tasks.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-muted", children: t("value.none") }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-chips", children: agent.running_tasks.map((id) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dah-chip dah-id", onClick: () => {
          onTask(id);
        }, children: id }, id)) }) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { className: "dah-nowrap", title: absolute(agent.left_at ?? agent.last_seen), children: agent.last_seen === void 0 && agent.left_at === void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-muted", children: t("agent.never") }) : presence(agent, t, now, false) })
      ] }, agent.agent_id)) })
    ] }) })
  ] });
}
function RequestsSection({ section, status, onStatus, now, t }) {
  const requests = section.data?.requests ?? [];
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { className: "dah-section", "aria-label": t("requests.title"), children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-section-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h2", { className: "dah-section-title", children: t("requests.title") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-count", children: section.data === void 0 ? "" : String(requests.length) }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-spacer" }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("select", { className: "dah-select", value: status, onChange: (event) => {
        onStatus(event.target.value);
      }, "aria-label": t("requests.col.status"), children: REQUEST_FILTERS.map((value) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("option", { value, children: t(`req.${value}`) }, value)) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(SectionError, { error: section.error, t }),
    requests.length === 0 ? section.data !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Empty, { children: status === "all" ? t("requests.empty.any") : t("requests.empty", { status: t(`req.${status}`) }) }) : null : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dah-table-wrap", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("table", { className: "dah-table", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("thead", { children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("tr", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("requests.col.request") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("requests.col.agent") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("requests.col.platform") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("requests.col.caps") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("requests.col.conc") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("requests.col.from") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("requests.col.at") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("requests.col.status") })
      ] }) }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("tbody", { children: requests.map((request) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("tr", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-id", children: request.request_id }) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("td", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-id", children: request.agent_id }),
          request.description !== void 0 && request.description !== "" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-sub-line dah-clip", title: request.description, children: request.description }) : null
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("td", { children: [
          request.platform ?? t("value.none"),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-sub-line", children: request.mode ?? "" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Chips, { items: request.capabilities, empty: t("value.none") }) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { className: "dah-num", children: String(request.max_concurrency ?? 1) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { className: "dah-nowrap", children: request.from !== void 0 && request.from !== "" ? request.from : t("value.none") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { className: "dah-nowrap", title: absolute(request.requested_at), children: relative(request.requested_at, t, now) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("td", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-badge", "data-tone": request.status, children: t(`req.${request.status}`) }),
          request.reason !== void 0 && request.reason !== "" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-sub-line dah-clip", title: request.reason, children: request.reason }) : null
        ] })
      ] }, request.request_id)) })
    ] }) })
  ] });
}
var SESSION_PAGE = 200;
function SessionView({ taskId, count, t }) {
  const [open, setOpen] = (0, import_react.useState)(false);
  const [entries, setEntries] = (0, import_react.useState)([]);
  const [doc, setDoc] = (0, import_react.useState)(void 0);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)(void 0);
  const ticket = (0, import_react.useRef)(0);
  (0, import_react.useEffect)(() => {
    ticket.current += 1;
    setOpen(false);
    setEntries([]);
    setDoc(void 0);
    setError(void 0);
  }, [taskId]);
  (0, import_react.useEffect)(() => () => {
    ticket.current += 1;
  }, []);
  const read = (after) => {
    ticket.current += 1;
    const mine = ticket.current;
    setBusy(true);
    fetchSession(taskId, after, SESSION_PAGE).then((next) => {
      if (mine !== ticket.current) return;
      setDoc(next);
      setEntries((previous) => after === 0 ? next.entries : [...previous, ...next.entries]);
      setError(void 0);
      setBusy(false);
    }, (failure) => {
      if (mine !== ticket.current) return;
      setError(failure);
      setBusy(false);
    });
  };
  if (!open) {
    if (count <= 0) return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dah-muted", children: t("detail.session.none") });
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dah-btn", "data-size": "sm", onClick: () => {
      setOpen(true);
      read(0);
    }, children: t("detail.session.load", { n: count }) });
  }
  const total = doc?.total ?? count;
  const more = doc !== void 0 && entries.length < total;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-session", children: [
    error !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dah-alert", role: "alert", children: t("error.section", { error: messageOf(error) }) }) : null,
    entries.length === 0 && busy ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dah-muted", children: t("detail.session.loading") }) : null,
    doc !== void 0 && entries.length === 0 && !busy ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dah-muted", children: t("detail.session.none") }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("ol", { className: "dah-session-list", children: entries.map((entry, index) => {
      const role = present(entry.role) ? entry.role : "note";
      const label = ["user", "assistant", "tool", "note", "system"].includes(role) ? t(`role.${role}`) : role;
      return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("li", { className: "dah-session-entry", "data-role": role, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "dah-session-who", children: [
          present(entry.name) ? `${label} \xB7 ${entry.name}` : label,
          present(entry.at) ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-muted", title: absolute(entry.at), children: ` ${clockOf(entry.at)}` }) : null
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("pre", { className: "dah-session-text", children: entry.text ?? "" })
      ] }, `${String(entry.index ?? index)}`);
    }) }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-session-foot", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-muted", children: t("detail.session.shown", { n: entries.length, total }) }),
      more ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dah-btn", "data-size": "sm", disabled: busy, onClick: () => {
        read(entries.length);
      }, children: t("detail.session.more") }) : null
    ] }),
    doc?.full === true ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dah-note", children: t("detail.session.full") }) : null
  ] });
}
function clockOf(iso) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? clock(ms) : "";
}
function AckButton({ task, t, onDone }) {
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)(void 0);
  if (task.acknowledged === true || task.in_history === true) return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-muted", children: t("detail.acked") });
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      "button",
      {
        type: "button",
        className: "dah-btn",
        "data-size": "sm",
        disabled: busy,
        title: t("detail.ack.hint"),
        onClick: () => {
          setBusy(true);
          ackTask(task.task_id).then(() => {
            setBusy(false);
            setError(void 0);
            onDone();
          }, (failure) => {
            setBusy(false);
            setError(failure);
          });
        },
        children: busy ? t("detail.ack.busy") : t("detail.ack")
      }
    ),
    error !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-error-text", children: t("detail.ack.failed", { error: messageOf(error) }) }) : null
  ] });
}
function ClearWaiting({ task, t, onDone }) {
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [asking, setAsking] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)(void 0);
  const action = clearActionOf(task);
  const run = () => {
    setBusy(true);
    const call = action === "ack" ? ackTask(task.task_id) : cancelTask(task.task_id);
    call.then(() => {
      setBusy(false);
      setAsking(false);
      setError(void 0);
      onDone();
    }, (failure) => {
      setBusy(false);
      setAsking(false);
      setError(failure);
    });
  };
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
    asking ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-muted", children: t("waiting.cancel.ask") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dah-btn", "data-size": "sm", "data-tone": "danger", disabled: busy, onClick: run, children: busy ? t("waiting.busy") : t("waiting.cancel.confirm") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dah-btn", "data-size": "sm", disabled: busy, onClick: () => {
        setAsking(false);
      }, children: t("waiting.cancel.keep") })
    ] }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      "button",
      {
        type: "button",
        className: "dah-btn",
        "data-size": "sm",
        disabled: busy,
        title: t(action === "ack" ? "waiting.ack.hint" : "waiting.cancel.hint"),
        onClick: () => {
          if (action === "ack") run();
          else setAsking(true);
        },
        children: busy ? t("waiting.busy") : t(action === "ack" ? "waiting.ack" : "waiting.cancel")
      }
    ),
    error !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-error-text", children: t("waiting.failed", { error: messageOf(error) }) }) : null
  ] });
}
function duration2(ms, t) {
  const parts = durationParts(ms);
  return parts === void 0 ? t("value.none") : t(`unit.${parts.unit}`, { n: parts.value });
}
function AnswerBox({ task, t, onDone }) {
  const [text, setText] = (0, import_react.useState)("");
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [sent, setSent] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)(void 0);
  const question = task.question?.text ?? task.result?.needs_input ?? task.message ?? "";
  const send2 = () => {
    const answer = text.trim();
    if (answer === "" || busy) return;
    setBusy(true);
    answerTask(task.task_id, answer).then(
      () => {
        setBusy(false);
        setSent(true);
        setText("");
        setError(void 0);
        onDone();
      },
      (failure) => {
        setBusy(false);
        setError(failure);
      }
    );
  };
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-block dah-answer", "data-tone": "waiting", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h4", { className: "dah-block-title", children: t("answer.title") }),
    question !== "" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-text", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("b", { children: t("answer.question") }),
      question
    ] }) : null,
    sent ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dah-muted", children: t("answer.done") }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "textarea",
        {
          className: "dah-input",
          rows: 3,
          maxLength: 4e3,
          value: text,
          placeholder: t("answer.placeholder"),
          disabled: busy,
          onChange: (event) => {
            setText(event.target.value);
          },
          onKeyDown: (event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) send2();
          }
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-row-actions", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dah-btn", "data-size": "sm", "data-tone": "primary", disabled: busy || text.trim() === "", onClick: send2, children: busy ? t("answer.busy") : t("answer.send") }),
        error !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-error-text", children: t("answer.failed", { error: messageOf(error) }) }) : null
      ] })
    ] })
  ] });
}
function AnswersList({ answers, t }) {
  if (answers.length === 0) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-block", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h4", { className: "dah-block-title", children: t("answers.title") }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("ul", { className: "dah-history", children: answers.map((a, index) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("li", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-history-time", title: absolute(a.at), children: absolute(a.at) }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-history-event", children: a.by ?? "" }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-muted", children: a.question ?? "" }),
        a.question ? " \u2192 " : "",
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("b", { children: a.answer ?? "" })
      ] })
    ] }, `${a.at ?? ""}-${String(index)}`)) })
  ] });
}
function LifecycleView({ taskId, tick, t, now }) {
  const [doc, setDoc] = (0, import_react.useState)(void 0);
  const [failed, setFailed] = (0, import_react.useState)(false);
  const ticket = (0, import_react.useRef)(0);
  (0, import_react.useEffect)(() => {
    ticket.current += 1;
    const mine = ticket.current;
    fetchTimeline(taskId).then(
      (next) => {
        if (mine === ticket.current) {
          setDoc(next);
          setFailed(false);
        }
      },
      () => {
        if (mine === ticket.current) setFailed(true);
      }
    );
  }, [taskId, tick]);
  (0, import_react.useEffect)(() => () => {
    ticket.current += 1;
  }, []);
  if (doc === void 0) return failed ? null : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dah-block", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dah-muted", children: t("life.loading") }) });
  const d = doc.durations;
  const row = doc.task;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-block", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h4", { className: "dah-block-title", children: t("life.title") }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-life", children: [
      doc.phase !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-badge", "data-pill": "true", "data-tone": doc.phase, children: t(`phase.${doc.phase}`) }) : null,
      row.overdue === true ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-badge", "data-tone": "failed", children: t("life.overdue") }) : null,
      doc.archived ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-muted", children: t("life.archived") }) : null
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("dl", { className: "dah-meta", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dt", { children: t("life.queue") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dd", { className: "dah-num", children: duration2(d.queue_ms, t) })
      ] }),
      (d.claim_ms ?? 0) >= 1e3 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dt", { children: t("life.claim") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dd", { className: "dah-num", children: duration2(d.claim_ms, t) })
      ] }) : null,
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dt", { children: t("life.run") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dd", { className: "dah-num", children: duration2(d.run_ms, t) })
      ] }),
      (d.waiting_ms ?? 0) >= 1e3 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dt", { children: t("life.waiting") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dd", { className: "dah-num", children: duration2(d.waiting_ms, t) })
      ] }) : null,
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dt", { children: t("life.total") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dd", { className: "dah-num", children: duration2(d.total_ms, t) })
      ] }),
      row.due_at !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dt", { children: t("life.due") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dd", { title: absolute(row.due_at), children: until(row.due_at, t, now) })
      ] }) : null,
      row.delivered_at !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dt", { children: t("life.delivered") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dd", { title: absolute(row.delivered_at), children: `${relative(row.delivered_at, t, now)}${row.delivered_to !== void 0 ? ` \xB7 ${row.delivered_to}` : ""}` })
      ] }) : null,
      row.acknowledged_at !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dt", { children: t("life.acked") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dd", { title: absolute(row.acknowledged_at), children: `${relative(row.acknowledged_at, t, now)}${row.acknowledged_by !== void 0 ? ` \xB7 ${row.acknowledged_by}` : ""}` })
      ] }) : null
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(AnswersList, { answers: doc.answers, t })
  ] });
}
var METRIC_HOURS = [24, 168, 720];
function pair(row, key, t) {
  const p50 = row[`${key}_ms_p50`];
  const p90 = row[`${key}_ms_p90`];
  if (p50 === void 0 && p90 === void 0) return t("value.none");
  return `${duration2(p50, t)} / ${duration2(p90, t)}`;
}
function MetricCells({ row, t }) {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { className: "dah-num", children: String(row.tasks ?? 0) }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { className: "dah-num", children: `${String(row.completed ?? 0)} / ${String(row.failed ?? 0)} / ${String(row.open ?? 0)}` }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { className: "dah-num", "data-tone": (row.fail_rate ?? 0) >= 0.2 ? "failed" : void 0, children: percentOf(row.fail_rate) ?? t("value.none") }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { className: "dah-num", children: percentOf(row.ask_rate) ?? t("value.none") }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { className: "dah-num", children: String(row.fallback ?? 0) }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { className: "dah-num", "data-tone": (row.overdue ?? 0) > 0 ? "failed" : void 0, children: String(row.overdue ?? 0) }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { className: "dah-num dah-nowrap", children: pair(row, "queue", t) }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { className: "dah-num dah-nowrap", children: pair(row, "run", t) })
  ] });
}
function MetricsView({ tick, t }) {
  const [hours, setHours] = (0, import_react.useState)(168);
  const [doc, setDoc] = (0, import_react.useState)(void 0);
  const [error, setError] = (0, import_react.useState)(void 0);
  const ticket = (0, import_react.useRef)(0);
  (0, import_react.useEffect)(() => {
    ticket.current += 1;
    const mine = ticket.current;
    fetchMetrics(hours).then(
      (next) => {
        if (mine === ticket.current) {
          setDoc(next);
          setError(void 0);
        }
      },
      (failure) => {
        if (mine === ticket.current) setError(failure);
      }
    );
  }, [hours, tick]);
  (0, import_react.useEffect)(() => () => {
    ticket.current += 1;
  }, []);
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-metrics", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dah-filters", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("select", { className: "dah-select", value: String(hours), "aria-label": t("metrics.title"), onChange: (event) => {
      setHours(Number(event.target.value));
    }, children: METRIC_HOURS.map((n) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("option", { value: String(n), children: t("metrics.window", { n }) }, n)) }) }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(SectionError, { error, t }),
    doc === void 0 ? error === void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Empty, { children: t("loading") }) : null : (doc.total.tasks ?? 0) === 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Empty, { children: t("metrics.empty") }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dah-table-wrap", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("table", { className: "dah-table", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("thead", { children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("tr", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("metrics.col.worker") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("metrics.col.tasks") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("metrics.col.done") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("metrics.col.fail") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("metrics.col.ask") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("metrics.col.fallback") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("metrics.col.overdue") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("metrics.col.queue") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("metrics.col.run") })
      ] }) }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("tbody", { children: [
        doc.workers.map((row) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("tr", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { className: "dah-id", children: row.worker }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(MetricCells, { row, t })
        ] }, row.worker)),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("tr", { "data-total": "true", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("b", { children: t("metrics.total") }) }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(MetricCells, { row: doc.total, t })
        ] })
      ] })
    ] }) }),
    doc?.archived_after_hours !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dah-note", children: t("metrics.note", { n: doc.archived_after_hours }) }) : null
  ] });
}
var FALLBACK_KEY = { "nobody-online": "fallback.nobody-online", "waited-out": "fallback.waited-out", other: "fallback.other" };
function TaskDetailView({ detail, t, now, onClose, onTask, onChanged }) {
  const task = detail.data?.task;
  const result = task?.result;
  const history = task === void 0 ? [] : timeline(task.history);
  const takenOver = task !== void 0 && task.origin?.kind !== "local" && task.fallback_by !== void 0 && task.fallback_by !== "";
  const reason = task === void 0 || !takenOver ? void 0 : fallbackReason(task.history);
  const failed = task !== void 0 && (task.status === "failed" || task.status === "dead");
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-detail", role: "region", "aria-label": t("detail.title"), children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-detail-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("h3", { className: "dah-detail-title", children: [
        task === void 0 ? t("detail.title") : task.title,
        task !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-sub-line dah-id", children: task.task_id }) : null
      ] }),
      task !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-badge", "data-pill": "true", "data-tone": task.status, children: statusLabel(task.status, t) }) : null,
      task !== void 0 && laneOf(task) === "waiting" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(ClearWaiting, { task, t, onDone: () => {
        onChanged?.();
      } }) : failed && task !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(AckButton, { task, t, onDone: () => {
        onChanged?.();
      } }) : null,
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dah-btn", "data-size": "sm", "data-icon": "true", onClick: onClose, "aria-label": t("detail.close"), children: "\xD7" })
    ] }),
    detail.error !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dah-alert", role: "alert", children: t("error.section", { error: messageOf(detail.error) }) }) : null,
    task === void 0 ? detail.error === void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Empty, { children: t("detail.loading") }) : null : /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("dl", { className: "dah-meta", children: [
        task.origin !== void 0 && task.origin.kind !== "controller" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dt", { children: t("detail.meta.origin") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("dd", { children: [
            originText(task, t) ?? task.origin.kind,
            present(task.origin.executor) ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-sub-line dah-id", children: task.origin.executor }) : null
          ] })
        ] }) : null,
        present(task.dsh_profile) ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dt", { children: t("detail.meta.profile") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dd", { className: "dah-id", children: task.dsh_profile })
        ] }) : null,
        task.stage !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dt", { children: t("detail.meta.stage") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dd", { children: t(`stage.${task.stage}`) })
        ] }) : null,
        takenOver ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dt", { children: t("detail.meta.fallback") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dd", { children: `${t(FALLBACK_KEY[reason ?? "other"])} \xB7 ${task.fallback_by}` })
        ] }) : null,
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dt", { children: t("detail.meta.target") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dd", { className: "dah-id", children: task.agent })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dt", { children: t("detail.meta.assigned") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dd", { className: "dah-id", children: task.assigned_to ?? t("value.none") })
        ] }),
        task.preferred_agent !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dt", { children: t("detail.meta.preferred") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dd", { className: "dah-id", children: task.sticky_key !== void 0 ? `${task.preferred_agent} \xB7 ${task.sticky_key}` : task.preferred_agent })
        ] }) : null,
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dt", { children: t("detail.meta.type") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dd", { children: task.type })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dt", { children: t("detail.meta.priority") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dd", { children: t(`priority.${task.priority}`) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dt", { children: t("detail.meta.attempts") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dd", { className: "dah-num", children: String(task.attempts) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dt", { children: t("detail.meta.progress") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dd", { className: "dah-num", children: percent(task.progress) ?? t("value.none") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dt", { children: t("detail.meta.lease") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dd", { title: absolute(task.lease_until), children: until(task.lease_until, t, now) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dt", { children: t("detail.meta.created") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dd", { title: absolute(task.created_at), children: relative(task.created_at, t, now) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dt", { children: t("detail.meta.deps") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dd", { children: task.depends_on.length === 0 ? t("value.none") : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-chips", children: task.depends_on.map((id) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dah-chip dah-id", onClick: () => {
            onTask(id);
          }, children: id }, id)) }) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dt", { children: t("detail.meta.context") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dd", { children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Chips, { items: task.context_keys, empty: t("value.none") }) })
        ] })
      ] }),
      answerable(task) ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(AnswerBox, { task, t, onDone: () => {
        onChanged?.();
      } }, `${task.task_id}#${String(task.answers_count ?? 0)}`) : null,
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(LifecycleView, { taskId: task.task_id, tick: detail.at, t, now }),
      task.message !== void 0 && task.message !== "" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-block", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h4", { className: "dah-block-title", children: t("detail.message") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dah-text", children: task.message })
      ] }) : null,
      task.instruction !== void 0 && task.instruction !== "" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-block", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h4", { className: "dah-block-title", children: t("detail.instruction") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("pre", { className: "dah-pre", children: task.instruction })
      ] }) : null,
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-block", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h4", { className: "dah-block-title", children: t("detail.inputs") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Chips, { items: task.inputs, empty: t("value.none") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-block", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h4", { className: "dah-block-title", children: t("detail.result") }),
        result === void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dah-muted", children: t("detail.result.none") }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-result", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-badge", "data-tone": result.status === "completed" ? "completed" : result.status === "partial" ? "waiting" : "failed", children: result.status }) }),
          result.summary !== void 0 && result.summary !== "" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("pre", { className: "dah-pre", children: result.summary }) : null,
          result.error !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-error-text", children: [
            `${t("detail.error")}: ${result.error.code ?? ""}${result.error.message !== void 0 && result.error.message !== "" ? ` \u2014 ${result.error.message}` : ""}`,
            result.error.retryable ? ` (${t("detail.retryable")})` : ""
          ] }) : null,
          result.needs_input !== void 0 && result.needs_input !== "" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-text", children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("b", { children: [
              t("detail.needs"),
              ": "
            ] }),
            result.needs_input
          ] }) : null
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-block", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h4", { className: "dah-block-title", children: t("detail.outputs") }),
        (result?.outputs ?? []).length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dah-muted", children: t("detail.outputs.none") }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("ul", { className: "dah-files", children: (result?.outputs ?? []).map((file) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("li", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-id", children: file.name }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-muted", children: bytes(file.bytes) }),
            file.type !== void 0 && file.type !== "" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-chip", children: file.type }) : null,
            file.description !== void 0 && file.description !== "" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-muted", children: file.description }) : null
          ] }, file.name)) }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dah-note", children: t("detail.outputs.note") })
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-block", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h4", { className: "dah-block-title", children: t("detail.timeline") }),
        history.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dah-muted", children: t("detail.history.none") }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("ul", { className: "dah-history", children: history.map((event, index) => {
          const flag = presenceEvent(event);
          return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("li", { "data-tone": flag === void 0 ? void 0 : "warn", children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-history-time", title: absolute(event.at), children: absolute(event.at) }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-history-event", children: event.stage !== void 0 ? t(`stage.${event.stage}`) : event.event ?? "" }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { children: [
              flag === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-history-flag", children: t(PRESENCE_KEY[flag]) }),
              historyText(event, t),
              present(event.by) && event.by !== "hub" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-sub-line dah-id", children: t("life.by", { by: event.by }) }) : null
            ] })
          ] }, `${event.at ?? ""}-${String(index)}`);
        }) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-block", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h4", { className: "dah-block-title", children: t("detail.session") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(SessionView, { taskId: task.task_id, count: task.session_entries ?? 0, t })
      ] })
    ] })
  ] });
}
function createAgentHubBoardTab(t, onOverview) {
  return function AgentHubBoardTab() {
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(AgentHubPage, { t, embedded: true, onOverview });
  };
}
function AgentHubPage({ t, embedded = false, onOverview }) {
  const [filter, setFilter] = (0, import_react.useState)(embedded ? { status: "all", agent: "", limit: 200, history: "hide" } : { status: "all", agent: "", limit: 50 });
  const [requestStatus, setRequestStatus] = (0, import_react.useState)("pending");
  const [auto, setAuto] = (0, import_react.useState)(true);
  const [selected, setSelected] = (0, import_react.useState)(void 0);
  const rootRef = (0, import_react.useRef)(null);
  const shown = useShown(rootRef, embedded);
  const { board, load } = useBoard(filter, requestStatus, auto, shown, onOverview);
  const [folds, setFolds] = (0, import_react.useState)(readFolds);
  const detail = useDetail(selected, board.loadedAt);
  const detailRef = (0, import_react.useRef)(null);
  const now = board.loadedAt ?? Date.now();
  const overview = board.overview.data;
  const agents = (0, import_react.useMemo)(
    () => sortAgents(board.agents.data?.agents ?? overview?.agents ?? []),
    [board.agents.data, overview]
  );
  const listCounts = (0, import_react.useMemo)(() => agentCounts(agents), [agents]);
  const statCounts = (0, import_react.useMemo)(() => agentCounts(agents, overview?.agent_counts), [agents, overview]);
  const counts = overview?.task_counts ?? {};
  const total = TASK_STATUSES.reduce((sum, status) => sum + (counts[status] ?? 0), 0);
  const online = listCounts.counts.online;
  const otherStates = countsText(statCounts.counts, t, (status) => status !== "online" && statCounts.counts[status] > 0);
  const pendingRequests = overview?.pending_requests ?? 0;
  const tasks = board.tasks.data?.tasks ?? [];
  const agentOptions = (0, import_react.useMemo)(() => {
    const set = /* @__PURE__ */ new Set();
    for (const agent of agents) set.add(agent.agent_id);
    for (const task of tasks) if (task.agent.startsWith("pool:")) set.add(task.agent);
    if (filter.agent !== "") set.add(filter.agent);
    return [...set].sort();
  }, [agents, tasks, filter.agent]);
  const openTask = (0, import_react.useCallback)((id) => {
    setSelected(id);
    setFolds((previous) => previous.tasks === false ? { ...previous, tasks: true } : previous);
  }, []);
  const toggleTask = (0, import_react.useCallback)((id) => {
    setSelected((previous) => previous === id ? void 0 : id);
  }, []);
  const setStatus = (0, import_react.useCallback)((status) => {
    setFilter((previous) => ({ ...previous, status: previous.status === status ? "all" : status }));
  }, []);
  (0, import_react.useEffect)(() => {
    if (selected !== void 0) detailRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [selected]);
  (0, import_react.useEffect)(() => {
    if (embedded) writeFolds(folds);
  }, [embedded, folds]);
  const nothing = overview === void 0 && board.agents.data === void 0 && board.tasks.data === void 0 && board.requests.data === void 0;
  const staleAlert = board.lastError !== void 0 && board.loadedAt !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dah-alert", "data-kind": "warn", role: "status", children: t("stale", { error: failureText(board.lastError, t), time: clock(board.loadedAt) }) }) : null;
  const failedAlert = /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-alert", role: "alert", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-alert-title", children: t("error.title") }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: failureText(board.lastError, t) }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dah-btn", "data-size": "sm", disabled: board.refreshing, onClick: () => {
      load(true);
    }, children: t("retry") })
  ] });
  const overviewBlock = /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-overview", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-summary", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("button", { type: "button", className: "dah-stat", "data-on": filter.status === "all", "aria-pressed": filter.status === "all", onClick: () => {
        setStatus("all");
      }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-stat-label", children: t("stat.total") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-stat-value", children: overview === void 0 ? t("value.none") : String(total) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
        "div",
        {
          className: "dah-stat",
          "data-tone": statCounts.counts.online > 0 ? "online" : "offline",
          title: t("stat.online.counts", { list: countsText(statCounts.counts, t, () => true) }),
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "dah-stat-label", children: [
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-dot", "aria-hidden": "true" }),
              t("stat.online")
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "dah-stat-value", children: [
              String(statCounts.counts.online),
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-stat-of", children: `/${String(statCounts.total)}` })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-stat-note", children: otherStates === "" ? t("stat.online.of", { n: statCounts.total }) : otherStates })
          ]
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-stat", "data-tone": pendingRequests > 0 ? "pending" : void 0, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "dah-stat-label", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-dot", "aria-hidden": "true" }),
          t("stat.requests")
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-stat-value", children: overview === void 0 ? t("value.none") : String(pendingRequests) })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dah-states", role: embedded ? "group" : void 0, "aria-label": embedded ? t("embed.states") : void 0, children: TASK_STATUSES.map((status) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
      "button",
      {
        type: "button",
        className: "dah-state",
        "data-tone": status,
        "data-on": filter.status === status,
        "data-zero": overview !== void 0 && (counts[status] ?? 0) === 0,
        "aria-pressed": filter.status === status,
        onClick: () => {
          setStatus(status);
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "dah-state-label", children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-dot", "aria-hidden": "true" }),
            statusLabel(status, t)
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-state-value", children: overview === void 0 ? t("value.none") : String(counts[status] ?? 0) })
        ]
      },
      status
    )) })
  ] });
  const taskFilters = /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-filters", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
      "select",
      {
        className: "dah-select",
        value: filter.status,
        "aria-label": t("tasks.col.status"),
        onChange: (event) => {
          const value = event.target.value;
          setFilter((previous) => ({ ...previous, status: value }));
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("option", { value: "all", children: t("status.all") }),
          TASK_STATUSES.map((status) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("option", { value: status, children: statusLabel(status, t) }, status))
        ]
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
      "select",
      {
        className: "dah-select",
        value: filter.agent,
        "aria-label": t("tasks.col.agent"),
        onChange: (event) => {
          const value = event.target.value;
          setFilter((previous) => ({ ...previous, agent: value }));
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("option", { value: "", children: t("tasks.filter.agent") }),
          agentOptions.map((id) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("option", { value: id, children: id }, id))
        ]
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      "select",
      {
        className: "dah-select",
        value: String(filter.limit),
        "aria-label": t("tasks.filter.limit", { n: filter.limit }),
        onChange: (event) => {
          const value = Number(event.target.value);
          setFilter((previous) => ({ ...previous, limit: value }));
        },
        children: LIMITS.map((n) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("option", { value: String(n), children: t("tasks.filter.limit", { n }) }, n))
      }
    )
  ] });
  if (embedded) {
    const isOpen = (part) => folds[part] ?? (part === "ended" || part === "metrics" ? false : part !== "requests" || pendingRequests > 0 || requestStatus !== "pending");
    const flip = (part) => {
      const next = !isOpen(part);
      setFolds((previous) => ({ ...previous, [part]: next }));
    };
    const inHistory = filter.history === "only";
    const openCount = tasks.filter((task) => task.status !== "completed" && task.status !== "failed" && task.status !== "cancelled" && task.status !== "dead").length;
    const fallback = inHistory ? [] : fallbackTasks(tasks);
    const requestCount = board.requests.data === void 0 ? "" : String(board.requests.data.requests.length);
    const detailNode = selected === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { ref: detailRef, className: "dah-item-detail", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(TaskDetailView, { detail, t, now, onClose: () => {
      setSelected(void 0);
    }, onTask: openTask, onChanged: () => {
      load(true);
    } }) });
    const summary = /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-summary", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-stat", title: t("desk.active.hint"), children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-stat-label", children: t("desk.active") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-stat-value", children: board.tasks.data === void 0 || inHistory ? t("value.none") : String(openCount) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
        "div",
        {
          className: "dah-stat",
          "data-tone": statCounts.counts.online > 0 ? "online" : "offline",
          title: t("stat.online.counts", { list: countsText(statCounts.counts, t, () => true) }),
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "dah-stat-label", children: [
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-dot", "aria-hidden": "true" }),
              t("stat.online")
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "dah-stat-value", children: [
              String(statCounts.counts.online),
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-stat-of", children: `/${String(statCounts.total - (overview?.dormant_agents ?? 0))}` })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-stat-note", children: otherStates === "" ? t("stat.online.of", { n: statCounts.total }) : otherStates })
          ]
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-stat", "data-tone": pendingRequests > 0 ? "pending" : void 0, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "dah-stat-label", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-dot", "aria-hidden": "true" }),
          t("stat.requests")
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-stat-value", children: overview === void 0 ? t("value.none") : String(pendingRequests) })
      ] })
    ] });
    const taskTools = /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "dah-tools", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
        "select",
        {
          className: "dah-select",
          value: filter.agent,
          "aria-label": t("tasks.col.agent"),
          onChange: (event) => {
            const value = event.target.value;
            setFilter((previous) => ({ ...previous, agent: value }));
          },
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("option", { value: "", children: t("tasks.filter.agent") }),
            agentOptions.map((id) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("option", { value: id, children: id }, id))
          ]
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "button",
        {
          type: "button",
          className: "dah-btn",
          "data-size": "sm",
          "aria-pressed": inHistory,
          onClick: () => {
            setSelected(void 0);
            setFilter((previous) => ({ ...previous, history: previous.history === "only" ? "hide" : "only" }));
          },
          children: inHistory ? t("history.back") : t("history.show")
        }
      )
    ] });
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dah-page", "data-embedded": "true", ref: rootRef, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-inner", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-toolbar", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-updated", children: board.loadedAt === void 0 ? "" : t("updated", { time: clock(board.loadedAt) }) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-spacer" }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { className: "dah-check", title: t("embed.auto.hint", { n: REFRESH_MS / 1e3 }), children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("input", { type: "checkbox", checked: auto, onChange: (event) => {
            setAuto(event.target.checked);
          } }),
          t("embed.auto")
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dah-btn", "data-size": "sm", disabled: board.refreshing, onClick: () => {
          load(true);
        }, children: board.refreshing ? t("refreshing") : t("refresh") })
      ] }),
      nothing ? board.first || board.lastError === void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Empty, { children: t("loading") }) : failedAlert : /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
        staleAlert,
        summary,
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
          EmbeddedFold,
          {
            part: "tasks",
            title: inHistory ? t("history.show") : t("tasks.title"),
            count: board.tasks.data === void 0 ? "" : String(tasks.length),
            open: isOpen("tasks"),
            onToggle: () => {
              flip("tasks");
            },
            tools: taskTools,
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(SectionError, { error: board.tasks.error, t }),
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                EmbeddedTasks,
                {
                  tasks,
                  loaded: board.tasks.data !== void 0,
                  history: inHistory,
                  selected,
                  detail: detailNode,
                  endedOpen: isOpen("ended"),
                  onEnded: () => {
                    flip("ended");
                  },
                  now,
                  t,
                  onToggle: toggleTask,
                  onChanged: () => {
                    load(true);
                  }
                }
              )
            ]
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
          EmbeddedFold,
          {
            part: "agents",
            title: t("agents.title"),
            count: `${String(online)} / ${String(agents.filter((agent) => agent.dormant !== true && !agent.revoked).length)}`,
            note: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(OfflineNote, { counts: listCounts.counts, t }),
            open: isOpen("agents"),
            onToggle: () => {
              flip("agents");
            },
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(SectionError, { error: board.agents.error, t }),
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(EmbeddedAgents, { agents, tasks, loaded: board.agents.data !== void 0, now, t, onTask: openTask })
            ]
          }
        ),
        fallback.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(EmbeddedFold, { part: "fallback", title: t("fallback.title"), count: String(fallback.length), open: isOpen("fallback"), onToggle: () => {
          flip("fallback");
        }, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(EmbeddedFallback, { tasks: fallback, selected, detail: detailNode, now, t, onToggle: toggleTask }) }) : null,
        pendingRequests > 0 || requestStatus !== "pending" || folds.requests === true ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
          EmbeddedFold,
          {
            part: "requests",
            title: t("requests.title"),
            count: requestCount,
            open: isOpen("requests"),
            onToggle: () => {
              flip("requests");
            },
            tools: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("select", { className: "dah-select", value: requestStatus, onChange: (event) => {
              setRequestStatus(event.target.value);
            }, "aria-label": t("requests.col.status"), children: REQUEST_FILTERS.map((value) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("option", { value, children: t(`req.${value}`) }, value)) }),
            children: [
              pendingRequests > 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dah-alert", "data-kind": "warn", children: t("approve.hint", { n: pendingRequests }) }) : null,
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(SectionError, { error: board.requests.error, t }),
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(EmbeddedRequests, { section: board.requests, status: requestStatus, now, t })
            ]
          }
        ) : null,
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(EmbeddedFold, { part: "metrics", title: t("metrics.title"), count: "", open: isOpen("metrics"), onToggle: () => {
          flip("metrics");
        }, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(MetricsView, { tick: board.loadedAt, t }) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dah-foot", children: t("desk.hint") })
      ] })
    ] }) });
  }
  const header = /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("header", { className: "dah-head", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-head-text", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h1", { className: "dah-title", children: t("page.title") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dah-sub", children: t("page.sub") })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-head-actions", children: [
      board.loadedAt !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-updated", children: t("updated", { time: clock(board.loadedAt) }) }) : null,
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { className: "dah-check", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("input", { type: "checkbox", checked: auto, onChange: (event) => {
          setAuto(event.target.checked);
        } }),
        t("auto", { n: REFRESH_MS / 1e3 })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dah-btn", disabled: board.refreshing, onClick: () => {
        load(true);
      }, children: board.refreshing ? t("refreshing") : t("refresh") })
    ] })
  ] });
  if (nothing) {
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dah-page", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-inner", children: [
      header,
      board.first || board.lastError === void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Empty, { page: true, children: t("loading") }) : failedAlert
    ] }) });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dah-page", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-inner", children: [
    header,
    staleAlert,
    overviewBlock,
    pendingRequests > 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dah-alert", "data-kind": "warn", children: t("approve.hint", { n: pendingRequests }) }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(AgentsSection, { agents, section: board.agents, now, t, onTask: openTask }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(RequestsSection, { section: board.requests, status: requestStatus, onStatus: setRequestStatus, now, t }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { className: "dah-section", "aria-label": t("tasks.title"), children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dah-section-head", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h2", { className: "dah-section-title", children: t("tasks.title") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-count", children: board.tasks.data === void 0 ? "" : t("tasks.shown", { n: tasks.length }) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-spacer" }),
        taskFilters
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(SectionError, { error: board.tasks.error, t }),
      tasks.length === 0 ? board.tasks.data !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Empty, { children: filter.status === "all" && filter.agent === "" ? t("tasks.empty.all") : t("tasks.empty") }) : null : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dah-table-wrap", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("table", { className: "dah-table", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("thead", { children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("tr", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("tasks.col.task") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("tasks.col.status") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("tasks.col.agent") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("tasks.col.type") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("tasks.col.attempts") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("tasks.col.created") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("tasks.col.result") })
        ] }) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("tbody", { children: tasks.map((task) => {
          const progress = percent(task.progress);
          return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
            "tr",
            {
              className: "dah-row",
              "data-on": selected === task.task_id,
              tabIndex: 0,
              "aria-expanded": selected === task.task_id,
              onClick: () => {
                toggleTask(task.task_id);
              },
              onKeyDown: onActivate(() => {
                toggleTask(task.task_id);
              }),
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("td", { children: [
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-clip dah-task-title", title: task.title, children: task.title }),
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-sub-line dah-id", children: task.task_id })
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("td", { children: [
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-badge", "data-tone": task.status, children: statusLabel(task.status, t) }),
                  progress !== void 0 && (task.status === "running" || task.status === "accepted") ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-bar", title: progress, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("i", { style: { width: progress } }) }) : null
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("td", { children: [
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-id", children: task.agent }),
                  task.assigned_to !== void 0 && task.assigned_to !== task.agent ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-sub-line dah-id", children: `\u2192 ${task.assigned_to}` }) : null
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("td", { className: "dah-nowrap", children: [
                  task.type,
                  task.priority !== "normal" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-sub-line", children: t(`priority.${task.priority}`) }) : null
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { className: "dah-num", children: String(task.attempts) }),
                /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { className: "dah-nowrap", title: absolute(task.created_at), children: relative(task.created_at, t, now) }),
                /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { children: task.result === void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-muted dah-clip", title: task.message, children: task.message ?? t("value.none") }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "dah-clip", title: task.result.summary, children: [
                  task.result.error !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dah-error-text", children: `${task.result.error.code ?? ""} ` }) : null,
                  task.result.summary !== void 0 && task.result.summary !== "" ? task.result.summary : t("value.none")
                ] }) })
              ]
            },
            task.task_id
          );
        }) })
      ] }) }),
      selected !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { ref: detailRef, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(TaskDetailView, { detail, t, now, onClose: () => {
        setSelected(void 0);
      }, onTask: openTask, onChanged: () => {
        load(true);
      } }) }) : null
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { className: "dah-section", "aria-label": t("metrics.title"), children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dah-section-head", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h2", { className: "dah-section-title", children: t("metrics.title") }) }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(MetricsView, { tick: board.loadedAt, t })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dah-foot", children: t("readonly.hint") })
  ] }) });
}

// src/client/board-tabs.ts
var REGISTRY_KEY = "__dshRouterBoardTabs__";
var REGISTRY_VERSION = 1;
function guard(read, fallback) {
  try {
    return read();
  } catch (error) {
    console.error("[board-tabs] an extension tab threw while being read", error);
    return fallback;
  }
}
function badgeOf(def) {
  if (def.badge === void 0) return void 0;
  const value = guard(def.badge, void 0);
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return void 0;
  return Math.floor(value);
}
function flagOf(def) {
  if (typeof def.flag !== "function") return void 0;
  const value = guard(def.flag, void 0);
  if (typeof value !== "string") return void 0;
  const text = value.trim();
  return text === "" ? void 0 : text.slice(0, 200);
}
function createRegistry() {
  const slots = /* @__PURE__ */ new Map();
  const listeners = /* @__PURE__ */ new Set();
  const consumers = /* @__PURE__ */ new Map();
  let seq = 0;
  let sorted;
  let snapshot = Object.freeze([]);
  const emit = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        console.error("[board-tabs] a listener threw", error);
      }
    }
  };
  return {
    v: 1,
    register(tab) {
      if (tab === null || typeof tab !== "object" || typeof tab.id !== "string" || tab.id === "") {
        throw new TypeError("board-tabs: register() needs a non-empty string id");
      }
      if (tab.Component === null || tab.Component === void 0) {
        throw new TypeError(`board-tabs: tab "${tab.id}" has no Component`);
      }
      seq += 1;
      const slot = { def: tab, seq };
      slots.set(tab.id, slot);
      sorted = void 0;
      emit();
      let live = true;
      return () => {
        if (!live) return;
        live = false;
        if (slots.get(tab.id) !== slot) return;
        slots.delete(tab.id);
        sorted = void 0;
        emit();
      };
    },
    list() {
      if (sorted === void 0) {
        const orderOf = (slot) => Number.isFinite(slot.def.order) ? slot.def.order : 0;
        sorted = [...slots.values()].sort((left, right) => orderOf(left) - orderOf(right) || left.seq - right.seq);
      }
      const next = sorted.map((slot) => ({
        id: slot.def.id,
        order: Number.isFinite(slot.def.order) ? slot.def.order : 0,
        label: guard(() => String(slot.def.label()), slot.def.id),
        badge: badgeOf(slot.def),
        flag: flagOf(slot.def),
        Component: slot.def.Component
      }));
      const same = next.length === snapshot.length && next.every((view, index) => {
        const old = snapshot[index];
        return old !== void 0 && old.id === view.id && old.order === view.order && old.label === view.label && old.badge === view.badge && old.flag === view.flag && old.Component === view.Component;
      });
      if (!same) snapshot = Object.freeze(next.map((view) => Object.freeze(view)));
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notify() {
      emit();
    },
    consume(name) {
      const token = {};
      consumers.set(token, String(name));
      emit();
      let live = true;
      return () => {
        if (!live) return;
        live = false;
        consumers.delete(token);
        emit();
      };
    },
    hasConsumer() {
      return consumers.size > 0;
    }
  };
}
function isRegistry(value) {
  if (typeof value !== "object" || value === null) return false;
  const probe = value;
  return probe.v === REGISTRY_VERSION && typeof probe.register === "function" && typeof probe.list === "function" && typeof probe.subscribe === "function" && typeof probe.notify === "function" && typeof probe.consume === "function" && typeof probe.hasConsumer === "function";
}
var local;
function boardTabs() {
  const scope = globalThis;
  const existing = scope[REGISTRY_KEY];
  if (isRegistry(existing)) return existing;
  if (local !== void 0) return local;
  const created = createRegistry();
  if (existing !== void 0) {
    console.warn(`[board-tabs] globalThis.${REGISTRY_KEY} speaks another version; this bundle keeps a private registry`);
    local = created;
    return created;
  }
  try {
    Object.defineProperty(scope, REGISTRY_KEY, { value: created, writable: false, enumerable: false, configurable: true });
  } catch {
    local = created;
  }
  return created;
}

// src/client/locales.ts
var NS = "agentHub";
var zh = {
  "page.title": "Agent \u8C03\u5EA6",
  "page.sub": "DSH \u662F\u552F\u4E00\u8C03\u5EA6\u65B9\uFF0C\u6D3E\u4EFB\u52A1 / \u53D6\u6D88 / \u91CD\u8BD5 / \u5BA1\u6279\u90FD\u5728 DSH \u5BF9\u8BDD\u91CC\u7528\u5DE5\u5177\u5B8C\u6210\uFF1B\u8FD9\u91CC\u53EF\u4EE5\u770B\u5168\u751F\u547D\u5468\u671F\u3001\u56DE\u7B54 worker \u7684\u63D0\u95EE",
  "refresh": "\u5237\u65B0",
  "refreshing": "\u5237\u65B0\u4E2D\u2026",
  "auto": "\u6BCF {n} \u79D2\u81EA\u52A8\u5237\u65B0",
  "updated": "\u66F4\u65B0\u4E8E {time}",
  "loading": "\u6B63\u5728\u8BFB\u53D6\u2026",
  "stale": "\u6700\u8FD1\u4E00\u6B21\u5237\u65B0\u5931\u8D25\uFF08{error}\uFF09\uFF0C\u4E0B\u9762\u662F {time} \u7684\u6570\u636E",
  "error.title": "\u8BFB\u4E0D\u5230\u8C03\u5EA6\u4E2D\u5FC3\u6570\u636E",
  "error.login": "\u9700\u8981\u767B\u5F55 DSH\uFF08\u4F1A\u8BDD\u53EF\u80FD\u5DF2\u8FC7\u671F\uFF09\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u91CD\u65B0\u767B\u5F55\u3002",
  "error.forbidden": "\u5F53\u524D\u8D26\u53F7\u6CA1\u6709\u6743\u9650\u67E5\u770B\u8C03\u5EA6\u4E2D\u5FC3\u3002",
  "error.unavailable": "\u5BBF\u4E3B\u4FA7\u63A5\u53E3\u6CA1\u6709\u54CD\u5E94\uFF1A\u786E\u8BA4 dsh-host-agent-hub \u5DF2\u52A0\u8F7D\uFF0C\u65E5\u5FD7\u91CC\u6709 \u201Cagent-hub: mounted \u2026\u201D\u3002",
  "error.section": "\u8FD9\u4E00\u5757\u52A0\u8F7D\u5931\u8D25\uFF1A{error}",
  "retry": "\u91CD\u8BD5",
  "value.none": "\u2014",
  "stat.online": "\u5728\u7EBF agent",
  "stat.online.of": "\u5171 {n} \u4E2A",
  "stat.requests": "\u5F85\u5BA1\u6279\u7533\u8BF7",
  "stat.total": "\u4EFB\u52A1\u603B\u6570",
  "status.pending": "\u7B49\u5F85\u9886\u53D6",
  "status.accepted": "\u5DF2\u9886\u53D6",
  "status.running": "\u8FD0\u884C\u4E2D",
  "status.waiting_input": "\u7B49\u4F60\u56DE\u7B54",
  "status.completed": "\u5DF2\u5B8C\u6210",
  "status.failed": "\u5931\u8D25",
  "status.cancelled": "\u5DF2\u53D6\u6D88",
  "status.dead": "\u91CD\u8BD5\u7528\u5C3D",
  "status.all": "\u5168\u90E8\u72B6\u6001",
  "req.pending": "\u5F85\u5BA1\u6279",
  "req.approved": "\u5DF2\u6279\u51C6",
  "req.rejected": "\u5DF2\u9A73\u56DE",
  "req.expired": "\u5DF2\u8FC7\u671F",
  "req.all": "\u5168\u90E8",
  "approve.hint": "\u6709 {n} \u4E2A\u52A0\u5165\u7533\u8BF7\u7B49\u5F85\u5BA1\u6279\u3002\u9762\u677F\u4E0D\u63D0\u4F9B\u5BA1\u6279\u6309\u94AE\uFF1A\u8BF7\u5728 DSH \u5BF9\u8BDD\u4E2D\u7528 agent_requests \u67E5\u770B\uFF0C\u518D\u7528 agent_approve \u6279\u51C6\uFF08\u53EF\u6536\u7A84\u80FD\u529B / \u5E76\u53D1\uFF09\u6216 agent_reject \u9A73\u56DE\u3002",
  "readonly.hint": "\u672C\u9762\u677F\u53EA\u80FD\u56DE\u7B54 worker \u7684\u63D0\u95EE\uFF0C\u5176\u4F59\u53EA\u8BFB\uFF1B\u4EE4\u724C\u3001\u4EE4\u724C\u54C8\u5E0C\u548C poll secret \u6C38\u8FDC\u4E0D\u4F1A\u663E\u793A\u3002",
  "agents.title": "Agent",
  "agents.empty": "\u8FD8\u6CA1\u6709 agent\u3002\u53EF\u5728 DSH \u4E2D\u7528 agent_provision \u76F4\u63A5\u7B7E\u53D1\uFF0C\u6216\u8BA9 agent \u53D1\u8D77 enroll \u7533\u8BF7\u540E\u7528 agent_approve \u6279\u51C6\u3002",
  "agents.col.agent": "Agent",
  "agents.col.state": "\u72B6\u6001",
  "agents.col.platform": "\u5E73\u53F0 / \u6A21\u5F0F",
  "agents.col.caps": "\u80FD\u529B",
  "agents.col.conc": "\u5E76\u53D1",
  "agents.col.running": "\u6B63\u5728\u8DD1",
  "agents.col.seen": "\u6700\u540E\u5FC3\u8DF3",
  "agent.online": "\u5728\u7EBF",
  "agent.offline": "\u79BB\u7EBF",
  "agent.revoked": "\u5DF2\u540A\u9500",
  "agent.never": "\u4ECE\u672A\u5FC3\u8DF3",
  "agent.busy": "\u5FD9",
  "agent.idle": "\u7A7A\u95F2",
  "requests.title": "\u52A0\u5165\u7533\u8BF7",
  "requests.empty": "\u6CA1\u6709{status}\u7684\u7533\u8BF7\u3002",
  "requests.empty.any": "\u8FD8\u6CA1\u6709\u4EFB\u4F55\u52A0\u5165\u7533\u8BF7\u3002",
  "requests.col.request": "\u7533\u8BF7",
  "requests.col.agent": "Agent",
  "requests.col.platform": "\u5E73\u53F0 / \u6A21\u5F0F",
  "requests.col.caps": "\u7533\u8BF7\u7684\u80FD\u529B",
  "requests.col.conc": "\u5E76\u53D1",
  "requests.col.from": "\u6765\u6E90 IP",
  "requests.col.at": "\u7533\u8BF7\u65F6\u95F4",
  "requests.col.status": "\u72B6\u6001",
  "tasks.title": "\u4EFB\u52A1",
  "tasks.empty": "\u6CA1\u6709\u7B26\u5408\u6761\u4EF6\u7684\u4EFB\u52A1\u3002",
  "tasks.empty.all": "\u8FD8\u6CA1\u6709\u4EFB\u52A1\u3002\u4EFB\u52A1\u7531 DSH \u7528 task_dispatch \u6D3E\u53D1\u3002",
  "tasks.filter.agent": "\u5168\u90E8 agent",
  "tasks.filter.limit": "\u6700\u8FD1 {n} \u6761",
  "tasks.shown": "\u663E\u793A {n} \u6761",
  "tasks.col.task": "\u4EFB\u52A1",
  "tasks.col.status": "\u72B6\u6001",
  "tasks.col.agent": "\u76EE\u6807 / \u6267\u884C\u8005",
  "tasks.col.type": "\u7C7B\u578B",
  "tasks.col.attempts": "\u5C1D\u8BD5",
  "tasks.col.created": "\u521B\u5EFA",
  "tasks.col.result": "\u7ED3\u679C\u6458\u8981",
  "detail.title": "\u4EFB\u52A1\u8BE6\u60C5",
  "detail.close": "\u5173\u95ED\u8BE6\u60C5",
  "detail.loading": "\u6B63\u5728\u8BFB\u53D6\u4EFB\u52A1\u8BE6\u60C5\u2026",
  "detail.meta.id": "\u4EFB\u52A1 ID",
  "detail.meta.target": "\u6D3E\u7ED9",
  "detail.meta.assigned": "\u6267\u884C\u8005",
  "detail.meta.preferred": "\u9996\u9009",
  "detail.meta.type": "\u7C7B\u578B",
  "detail.meta.priority": "\u4F18\u5148\u7EA7",
  "detail.meta.attempts": "\u5C1D\u8BD5\u6B21\u6570",
  "detail.meta.progress": "\u8FDB\u5EA6",
  "detail.meta.lease": "\u79DF\u7EA6\u5230\u671F",
  "detail.meta.created": "\u521B\u5EFA\u65F6\u95F4",
  "detail.meta.deps": "\u4F9D\u8D56",
  "detail.meta.context": "\u4E0A\u4E0B\u6587\u5B57\u6BB5",
  "detail.instruction": "\u6307\u4EE4",
  "detail.inputs": "\u8F93\u5165\u6587\u4EF6",
  "detail.result": "\u7ED3\u679C",
  "detail.result.none": "\u8FD8\u6CA1\u6709\u7ED3\u679C\u3002",
  "detail.summary": "\u6458\u8981",
  "detail.error": "\u9519\u8BEF",
  "detail.retryable": "\u53EF\u91CD\u8BD5",
  "detail.needs": "\u9700\u8981\u4EBA\u5DE5\u8F93\u5165",
  "detail.outputs": "\u4EA7\u51FA\u6587\u4EF6",
  "detail.outputs.none": "\u6CA1\u6709\u4EA7\u51FA\u6587\u4EF6\u3002",
  "detail.outputs.note": "\u6587\u4EF6\u5185\u5BB9\u7559\u5728\u5BBF\u4E3B\u673A <DSH home>/agent-hub/artifacts/ \u4E0B\uFF0C\u9700\u8981\u65F6\u8BF7\u5728 DSH \u5BF9\u8BDD\u4E2D\u67E5\u770B\u3002",
  "detail.history": "\u5386\u53F2",
  "detail.history.none": "\u6CA1\u6709\u5386\u53F2\u8BB0\u5F55\u3002",
  "detail.message": "\u6700\u65B0\u6D88\u606F",
  "priority.high": "\u9AD8",
  "priority.normal": "\u666E\u901A",
  "priority.low": "\u4F4E",
  "ago.s": "{n} \u79D2\u524D",
  "ago.m": "{n} \u5206\u949F\u524D",
  "ago.h": "{n} \u5C0F\u65F6\u524D",
  "ago.d": "{n} \u5929\u524D",
  "in.s": "{n} \u79D2\u540E",
  "in.m": "{n} \u5206\u949F\u540E",
  "in.h": "{n} \u5C0F\u65F6\u540E",
  "lease.expired": "\u5DF2\u8FC7\u671F",
  // Router board tab (board-tabs.ts) and the embedded form of the page.
  "board.tab": "\u8C03\u5EA6\u53F0",
  "embed.auto": "\u81EA\u52A8\u5237\u65B0",
  "embed.auto.hint": "\u6BCF {n} \u79D2\u81EA\u52A8\u5237\u65B0\uFF1B\u6807\u7B7E\u9875\u4E0D\u5728\u5C4F\u5E55\u4E0A\u65F6\u6682\u505C",
  "embed.states": "\u6309\u4EFB\u52A1\u72B6\u6001\u7B5B\u9009",
  "embed.conc": "\u5E76\u53D1 {n}/{max}",
  "embed.seen": "\u5FC3\u8DF3 {time}",
  "embed.from": "\u6765\u81EA {from}",
  "embed.attempts": "\u7B2C {n} \u6B21\u5C1D\u8BD5",
  // Worker presence (protocol v2 §9): agent status, client version, heartbeat, requeues.
  "agent.status.online": "\u5728\u7EBF",
  "agent.status.offline": "\u79BB\u7EBF",
  "agent.status.left": "\u5DF2\u4E0B\u7EBF",
  "agent.status.pending": "\u5F85\u63A5\u5165",
  "agent.status.revoked": "\u5DF2\u540A\u9500",
  "agent.version": "\u5BA2\u6237\u7AEF {v}",
  "presence.seen": "\u6700\u540E\u5FC3\u8DF3 {time}",
  "presence.offline": "\u79BB\u7EBF {time}",
  "dur.s": "{n} \u79D2",
  "dur.m": "{n} \u5206\u949F",
  "dur.h": "{n} \u5C0F\u65F6",
  "dur.d": "{n} \u5929",
  "stat.online.counts": "\u5404\u72B6\u6001\uFF1A{list}",
  "stat.online.part": "{label} {n}",
  "agents.offline": "{n} \u79BB\u7EBF",
  "agents.offline.hint": "\u79BB\u7EBF {offline} \xB7 \u5DF2\u4E0B\u7EBF {left}",
  "history.worker-lost": "worker \u5931\u8054\uFF0C\u4EFB\u52A1\u5DF2\u91CD\u6392",
  "history.worker-offline": "worker \u79BB\u7EBF\uFF0C\u4EFB\u52A1\u5DF2\u91CD\u6392",
  "history.agent-offline": "\u6D3E\u53D1\u65F6 agent \u4E0D\u5728\u7EBF",
  "history.registered": "{by} \u5728\u672C\u5730\u6267\u884C",
  "history.registered.at": "{by} \u5728\u672C\u5730\u6267\u884C\uFF08{executor}\uFF09",
  "board.flag.stranded": "{n} \u4E2A\u79BB\u7EBF agent \u8FD8\u5360\u7740 {tasks} \u4E2A\u4EFB\u52A1\uFF08\u6389\u7EBF\u540E\u4F1A\u81EA\u52A8\u91CD\u6392\uFF09",
  // 调度台 (the board tab): lanes, stages, origin, profile groups, DSH's own workers, fallback, history, session.
  "desk.active": "\u5728\u529E",
  "desk.active.hint": "\u6392\u961F\u3001\u5DF2\u9886\u53D6\u3001\u8FDB\u884C\u4E2D\u548C\u7B49\u4F60\u56DE\u590D\u7684\u4EFB\u52A1",
  "lane.queued": "\u6392\u961F",
  "lane.claimed": "\u5DF2\u9886\u53D6",
  "lane.running": "\u8FDB\u884C\u4E2D",
  "lane.waiting": "\u7B49\u4F60\u56DE\u590D",
  "lane.ended": "\u5DF2\u7ED3\u675F",
  "lane.ended.hint": "\u5B8C\u6210 12 \u5C0F\u65F6\u3001\u5931\u8D25 2 \u5929\u540E\u81EA\u52A8\u6536\u8FDB\u5386\u53F2",
  "stage.received": "\u5DF2\u6536\u5230",
  "stage.started": "\u5DF2\u5F00\u5DE5",
  "stage.step": "\u505A\u5B8C\u4E00\u6B65",
  "stage.blocked": "\u5361\u4F4F",
  "stage.needs_input": "\u8981\u4F60\u56DE\u7B54",
  "stage.uploading": "\u4EA4\u7ED3\u679C",
  "origin.local": "\u672C\u673A {profile}",
  "origin.local.any": "\u672C\u673A",
  "origin.controller": "\u4E91\u7AEF\u6D3E\u53D1",
  "origin.agent": "agent \u6D3E\u53D1",
  "task.quiet": "\u672C\u673A DSH \u6682\u65F6\u6CA1\u6709\u4E0A\u62A5\uFF0C\u4E0D\u4F1A\u56E0\u6B64\u5224\u5931\u8D25",
  "group.profile": "profile {name}",
  "group.node": "\u673A\u5668 {name}",
  "group.none": "\u672A\u6807 profile",
  "self.badge": "DSH \u5206\u533A",
  "self.busy": "\u6B63\u5728\u5E72 {n} \u4EF6",
  "self.quiet": "{n} \u4EF6\u6682\u672A\u4E0A\u62A5",
  "dormant.show": "\u5DF2\u505C\u7528 {n} \u4E2A",
  "dormant.hide": "\u6536\u8D77\u5DF2\u505C\u7528",
  "dormant.hint": "\u79BB\u7EBF\u8D85\u8FC7 3 \u5929\u6216\u5DF2\u540A\u9500\u7684 agent",
  "fallback.title": "\u515C\u5E95",
  "fallback.empty": "\u6CA1\u6709 DSH \u81EA\u5DF1\u63A5\u624B\u7684\u4EFB\u52A1\u3002",
  "fallback.by": "{by} \u63A5\u624B",
  "fallback.nobody-online": "\u6CA1\u4EBA\u5728\u7EBF\uFF0C\u7ACB\u5373\u63A5\u624B",
  "fallback.waited-out": "\u6709\u4EBA\u5728\u7EBF\u4F46\u6CA1\u4EBA\u9886\uFF0C\u7B49\u6EE1\u65F6\u9650\u540E\u63A5\u624B",
  "fallback.other": "\u515C\u5E95\u63A5\u624B",
  "history.show": "\u5386\u53F2",
  "history.back": "\u56DE\u5230\u5F53\u524D",
  "history.note": "\u8FD9\u91CC\u662F\u5DF2\u6536\u8D77\u7684\u4EFB\u52A1\uFF1A\u5B8C\u6210\u6216\u53D6\u6D88 12 \u5C0F\u65F6\u540E\u3001\u5931\u8D25 2 \u5929\u540E\uFF08\u6216\u4F60\u6536\u8D77\u540E\uFF09\u30027 \u5929\u540E\u538B\u7F29\u5B58\u6863\u3002",
  "history.empty": "\u5386\u53F2\u91CC\u8FD8\u6CA1\u6709\u4EFB\u52A1\u3002",
  "detail.meta.origin": "\u6765\u6E90",
  "detail.meta.profile": "profile",
  "detail.meta.stage": "\u9636\u6BB5",
  "detail.meta.fallback": "\u515C\u5E95",
  "detail.timeline": "\u65F6\u95F4\u7EBF",
  "detail.ack": "\u6536\u8D77",
  "detail.ack.hint": "\u653E\u8FDB\u5386\u53F2\uFF0C\u5217\u8868\u91CC\u4E0D\u518D\u663E\u793A",
  "detail.ack.busy": "\u6536\u8D77\u4E2D\u2026",
  "detail.ack.failed": "\u6536\u8D77\u5931\u8D25\uFF1A{error}",
  "detail.acked": "\u5DF2\u6536\u8D77",
  "waiting.ack": "\u6536\u8D77",
  "waiting.ack.hint": "\u5DF2\u7ECF\u5904\u7406\u8FC7\u4E86\uFF1A\u4ECE\u300C\u7B49\u4F60\u56DE\u590D\u300D\u79FB\u5230\u5386\u53F2",
  "waiting.cancel": "\u53D6\u6D88\u4EFB\u52A1",
  "waiting.cancel.hint": "\u4EFB\u52A1\u8FD8\u5F00\u7740\uFF1A\u53D6\u6D88\u540E\u5B83\u7684 worker \u505C\u4E0B\uFF0C\u4EFB\u52A1\u79FB\u5230\u300C\u5DF2\u7ED3\u675F\u300D",
  "waiting.cancel.ask": "\u53D6\u6D88\u8FD9\u4E2A\u4EFB\u52A1\uFF1F",
  "waiting.cancel.confirm": "\u786E\u8BA4\u53D6\u6D88",
  "waiting.cancel.keep": "\u5148\u7559\u7740",
  "waiting.busy": "\u5904\u7406\u4E2D\u2026",
  "waiting.failed": "\u6CA1\u6210\u529F\uFF1A{error}",
  "answer.title": "\u56DE\u7B54 worker \u7684\u95EE\u9898",
  "answer.question": "\u5B83\u95EE\uFF1A",
  "answer.placeholder": "\u5199\u4E0B\u4F60\u7684\u56DE\u7B54\uFF0C\u4F1A\u4EA4\u56DE\u63D0\u95EE\u7684\u90A3\u4E2A worker \u63A5\u7740\u505A",
  "answer.send": "\u4EA4\u56DE worker",
  "answer.busy": "\u53D1\u9001\u4E2D\u2026",
  "answer.failed": "\u6CA1\u53D1\u51FA\u53BB\uFF1A{error}",
  "answer.done": "\u5DF2\u4EA4\u56DE\uFF0Cworker \u4F1A\u5E26\u7740\u56DE\u7B54\u63A5\u7740\u505A",
  "answer.local": "\u8FD9\u662F DSH \u672C\u5730\u4EFB\u52A1\uFF1A\u5728\u5B83\u7684\u4F5C\u6218\u5BA4\u91CC\u56DE\u7B54",
  "answers.title": "\u95EE\u7B54\u8BB0\u5F55",
  "life.title": "\u751F\u547D\u5468\u671F",
  "life.phase": "\u9636\u6BB5",
  "life.queue": "\u6392\u961F",
  "life.claim": "\u9886\u53D6\u672A\u52A8",
  "life.run": "\u6267\u884C",
  "life.waiting": "\u7B49\u4F60\u56DE\u7B54",
  "life.total": "\u603B\u8017\u65F6",
  "life.due": "\u671F\u9650",
  "life.overdue": "\u5DF2\u8D85\u65F6",
  "life.delivered": "\u5DF2\u9001\u8FBE",
  "life.acked": "\u6536\u8D77",
  "life.archived": "\u5DF2\u5F52\u6863\uFF08\u4ECE\u5F52\u6863\u91CC\u8BFB\u51FA\uFF09",
  "life.loading": "\u8BFB\u53D6\u65F6\u95F4\u7EBF\u2026",
  "life.by": "\u7531 {by}",
  "phase.queued": "\u6392\u961F",
  "phase.claimed": "\u5DF2\u9886\u53D6",
  "phase.running": "\u6267\u884C\u4E2D",
  "phase.waiting_input": "\u7B49\u4F60\u56DE\u7B54",
  "phase.blocked": "\u5361\u4F4F",
  "phase.completed": "\u5B8C\u6210",
  "phase.failed": "\u5931\u8D25",
  "phase.cancelled": "\u53D6\u6D88",
  "unit.s": "{n} \u79D2",
  "unit.m": "{n} \u5206",
  "unit.h": "{n} \u5C0F\u65F6",
  "unit.d": "{n} \u5929",
  "metrics.title": "\u6307\u6807",
  "metrics.window": "\u6700\u8FD1 {n} \u5C0F\u65F6",
  "metrics.col.worker": "\u6267\u884C\u8005",
  "metrics.col.tasks": "\u4EFB\u52A1",
  "metrics.col.done": "\u5B8C\u6210 / \u5931\u8D25 / \u8FDB\u884C",
  "metrics.col.fail": "\u5931\u8D25\u7387",
  "metrics.col.ask": "\u95EE\u4EBA\u6BD4\u4F8B",
  "metrics.col.fallback": "DSH \u515C\u5E95",
  "metrics.col.overdue": "\u8D85\u65F6",
  "metrics.col.queue": "\u6392\u961F p50 / p90",
  "metrics.col.run": "\u6267\u884C p50 / p90",
  "metrics.total": "\u5408\u8BA1",
  "metrics.empty": "\u8FD9\u6BB5\u65F6\u95F4\u6CA1\u6709\u4EFB\u52A1",
  "metrics.note": "\u53EA\u7B97\u8FD8\u6CA1\u5F52\u6863\u7684\u4EFB\u52A1\uFF08\u5F52\u6863\u524D {n} \u5C0F\u65F6\u5185\u7ED3\u675F\u7684\uFF09\u3002",
  "detail.session": "\u4F1A\u8BDD",
  "detail.session.load": "\u67E5\u770B\u4F1A\u8BDD\uFF08{n} \u6761\uFF09",
  "detail.session.more": "\u518D\u8BFB\u540E\u9762\u7684",
  "detail.session.none": "\u8FD9\u4E2A\u4EFB\u52A1\u6CA1\u6709\u4E0A\u4F20\u4F1A\u8BDD\u3002",
  "detail.session.loading": "\u6B63\u5728\u8BFB\u53D6\u4F1A\u8BDD\u2026",
  "detail.session.full": "\u4F1A\u8BDD\u592A\u957F\uFF0C\u540E\u9762\u7684\u6761\u76EE\u6CA1\u6709\u4FDD\u5B58\u3002",
  "detail.session.shown": "{n} / {total} \u6761",
  "role.user": "\u4EFB\u52A1",
  "role.assistant": "\u6267\u884C\u8005",
  "role.tool": "\u5DE5\u5177",
  "role.note": "\u5907\u6CE8",
  "role.system": "\u7CFB\u7EDF",
  "desk.hint": "\u6570\u636E\u90FD\u6765\u81EA\u4E91\u7AEF\u4FE1\u9053\uFF1A\u672C\u673A\u6D3E\u7684\u6D3B\u3001\u5916\u90E8 agent \u7684\u6D3B\u90FD\u5728\u8FD9\u91CC\u3002\u4EE4\u724C\u548C\u5185\u7F51\u5730\u5740\u4E0D\u4F1A\u663E\u793A\u3002"
};
var en = {
  "page.title": "Agent hub",
  "page.sub": "DSH is the only controller; dispatch, cancel, retry and approval happen through the DSH tools in chat. Here you can follow each task's lifecycle and answer a worker's question",
  "refresh": "Refresh",
  "refreshing": "Refreshing\u2026",
  "auto": "Auto-refresh every {n}s",
  "updated": "Updated {time}",
  "loading": "Loading\u2026",
  "stale": "The last refresh failed ({error}); showing data from {time}",
  "error.title": "The agent hub is unreachable",
  "error.login": "You need to be logged in to DSH (the session may have expired). Reload the page to log in again.",
  "error.forbidden": "This account may not view the agent hub.",
  "error.unavailable": 'The host routes did not answer: check that dsh-host-agent-hub is loaded and the log shows "agent-hub: mounted \u2026".',
  "error.section": "This section failed to load: {error}",
  "retry": "Retry",
  "value.none": "\u2014",
  "stat.online": "Agents online",
  "stat.online.of": "of {n}",
  "stat.requests": "Pending requests",
  "stat.total": "Tasks",
  "status.pending": "Pending",
  "status.accepted": "Accepted",
  "status.running": "Running",
  "status.waiting_input": "Waiting on you",
  "status.completed": "Completed",
  "status.failed": "Failed",
  "status.cancelled": "Cancelled",
  "status.dead": "Dead",
  "status.all": "All statuses",
  "req.pending": "pending",
  "req.approved": "approved",
  "req.rejected": "rejected",
  "req.expired": "expired",
  "req.all": "all",
  "approve.hint": "{n} enrollment request(s) await approval. The panel has no approve button: in the DSH chat, review them with agent_requests, then agent_approve (optionally narrowing capabilities / concurrency) or agent_reject.",
  "readonly.hint": "The only thing this panel changes is answering a worker's question; tokens, token hashes and poll secrets are never shown.",
  "agents.title": "Agents",
  "agents.empty": "No agents yet. Provision one from DSH with agent_provision, or let an agent enroll and approve it with agent_approve.",
  "agents.col.agent": "Agent",
  "agents.col.state": "State",
  "agents.col.platform": "Platform / mode",
  "agents.col.caps": "Capabilities",
  "agents.col.conc": "Concurrency",
  "agents.col.running": "Running",
  "agents.col.seen": "Last heartbeat",
  "agent.online": "online",
  "agent.offline": "offline",
  "agent.revoked": "revoked",
  "agent.never": "never seen",
  "agent.busy": "busy",
  "agent.idle": "idle",
  "requests.title": "Enrollment requests",
  "requests.empty": "No {status} requests.",
  "requests.empty.any": "No enrollment requests yet.",
  "requests.col.request": "Request",
  "requests.col.agent": "Agent",
  "requests.col.platform": "Platform / mode",
  "requests.col.caps": "Requested capabilities",
  "requests.col.conc": "Concurrency",
  "requests.col.from": "From",
  "requests.col.at": "Requested",
  "requests.col.status": "Status",
  "tasks.title": "Tasks",
  "tasks.empty": "No task matches the filter.",
  "tasks.empty.all": "No tasks yet. DSH dispatches them with task_dispatch.",
  "tasks.filter.agent": "All agents",
  "tasks.filter.limit": "Latest {n}",
  "tasks.shown": "{n} shown",
  "tasks.col.task": "Task",
  "tasks.col.status": "Status",
  "tasks.col.agent": "Target / holder",
  "tasks.col.type": "Type",
  "tasks.col.attempts": "Attempts",
  "tasks.col.created": "Created",
  "tasks.col.result": "Result summary",
  "detail.title": "Task detail",
  "detail.close": "Close detail",
  "detail.loading": "Loading task detail\u2026",
  "detail.meta.id": "Task id",
  "detail.meta.target": "Routed to",
  "detail.meta.assigned": "Held by",
  "detail.meta.preferred": "Preferred",
  "detail.meta.type": "Type",
  "detail.meta.priority": "Priority",
  "detail.meta.attempts": "Attempts",
  "detail.meta.progress": "Progress",
  "detail.meta.lease": "Lease until",
  "detail.meta.created": "Created",
  "detail.meta.deps": "Depends on",
  "detail.meta.context": "Context keys",
  "detail.instruction": "Instruction",
  "detail.inputs": "Input files",
  "detail.result": "Result",
  "detail.result.none": "No result yet.",
  "detail.summary": "Summary",
  "detail.error": "Error",
  "detail.retryable": "retryable",
  "detail.needs": "Needs human input",
  "detail.outputs": "Output files",
  "detail.outputs.none": "No output files.",
  "detail.outputs.note": "File bytes stay on the host under <DSH home>/agent-hub/artifacts/; review them from the DSH chat.",
  "detail.history": "History",
  "detail.history.none": "No history.",
  "detail.message": "Latest message",
  "priority.high": "high",
  "priority.normal": "normal",
  "priority.low": "low",
  "ago.s": "{n}s ago",
  "ago.m": "{n} min ago",
  "ago.h": "{n} h ago",
  "ago.d": "{n} d ago",
  "in.s": "in {n}s",
  "in.m": "in {n} min",
  "in.h": "in {n} h",
  "lease.expired": "expired",
  // Router board tab (board-tabs.ts) and the embedded form of the page.
  "board.tab": "Dispatch",
  "embed.auto": "Auto-refresh",
  "embed.auto.hint": "Refresh every {n}s; paused while the tab is off screen",
  "embed.states": "Filter by task status",
  "embed.conc": "concurrency {n}/{max}",
  "embed.seen": "seen {time}",
  "embed.from": "from {from}",
  "embed.attempts": "attempt {n}",
  // Worker presence (protocol v2 §9): agent status, client version, heartbeat, requeues.
  "agent.status.online": "online",
  "agent.status.offline": "offline",
  "agent.status.left": "left",
  "agent.status.pending": "pending",
  "agent.status.revoked": "revoked",
  "agent.version": "client {v}",
  "presence.seen": "last heartbeat {time}",
  "presence.offline": "offline for {time}",
  "dur.s": "{n}s",
  "dur.m": "{n} min",
  "dur.h": "{n} h",
  "dur.d": "{n} d",
  "stat.online.counts": "By state: {list}",
  "stat.online.part": "{label} {n}",
  "agents.offline": "{n} offline",
  "agents.offline.hint": "offline {offline} \xB7 left {left}",
  "history.worker-lost": "worker lost; task requeued",
  "history.worker-offline": "worker offline; task requeued",
  "history.agent-offline": "agent was offline at dispatch",
  "history.registered": "{by} runs it locally",
  "history.registered.at": "{by} runs it locally ({executor})",
  "board.flag.stranded": "{n} offline agent(s) still hold {tasks} task(s) (they are requeued automatically)",
  "desk.active": "Open",
  "desk.active.hint": "queued, claimed, running and waiting on you",
  "lane.queued": "Queued",
  "lane.claimed": "Claimed",
  "lane.running": "Running",
  "lane.waiting": "Waiting on you",
  "lane.ended": "Ended",
  "lane.ended.hint": "moves to history 12 h after done, 2 days after failing",
  "stage.received": "received",
  "stage.started": "started",
  "stage.step": "step done",
  "stage.blocked": "blocked",
  "stage.needs_input": "needs your answer",
  "stage.uploading": "uploading",
  "origin.local": "local {profile}",
  "origin.local.any": "local",
  "origin.controller": "from the cloud",
  "origin.agent": "from an agent",
  "task.quiet": "the local DSH has not reported for a while; it is not failed for that",
  "group.profile": "profile {name}",
  "group.node": "machine {name}",
  "group.none": "no profile",
  "self.badge": "DSH partition",
  "self.busy": "{n} running",
  "self.quiet": "{n} not reporting",
  "dormant.show": "{n} dormant",
  "dormant.hide": "Hide dormant",
  "dormant.hint": "offline for more than 3 days, or revoked",
  "fallback.title": "Fallback",
  "fallback.empty": "No task DSH took over.",
  "fallback.by": "taken by {by}",
  "fallback.nobody-online": "nobody online, taken at once",
  "fallback.waited-out": "workers online but nobody took it in time",
  "fallback.other": "taken over",
  "history.show": "History",
  "history.back": "Back to current",
  "history.note": "Put-away tasks: 12 h after done or cancelled, 2 days after failing (or when you put them away). Archived after 7 days.",
  "history.empty": "Nothing in history yet.",
  "detail.meta.origin": "Origin",
  "detail.meta.profile": "Profile",
  "detail.meta.stage": "Stage",
  "detail.meta.fallback": "Fallback",
  "detail.timeline": "Timeline",
  "detail.ack": "Put away",
  "detail.ack.hint": "move it to history",
  "detail.ack.busy": "Putting away\u2026",
  "detail.ack.failed": "Could not put it away: {error}",
  "detail.acked": "Put away",
  "waiting.ack": "Put away",
  "waiting.ack.hint": "dealt with: move it from Waiting on you to history",
  "waiting.cancel": "Cancel task",
  "waiting.cancel.hint": "still open: cancelling stops its worker and moves it to Ended",
  "waiting.cancel.ask": "Cancel this task?",
  "waiting.cancel.confirm": "Yes, cancel",
  "waiting.cancel.keep": "Keep it",
  "waiting.busy": "Working\u2026",
  "waiting.failed": "Did not work: {error}",
  "answer.title": "Answer the worker",
  "answer.question": "It asks:",
  "answer.placeholder": "Your answer goes back to the worker that asked",
  "answer.send": "Send to worker",
  "answer.busy": "Sending\u2026",
  "answer.failed": "Not sent: {error}",
  "answer.done": "Sent: the worker carries on with your answer",
  "answer.local": "A DSH local task: answer it in its \u4F5C\u6218\u5BA4",
  "answers.title": "Questions and answers",
  "life.title": "Lifecycle",
  "life.phase": "Phase",
  "life.queue": "Queued",
  "life.claim": "Claimed, idle",
  "life.run": "Running",
  "life.waiting": "Waiting on you",
  "life.total": "Total",
  "life.due": "Due",
  "life.overdue": "Overdue",
  "life.delivered": "Delivered",
  "life.acked": "Put away",
  "life.archived": "Archived (read from the archive)",
  "life.loading": "Reading the timeline\u2026",
  "life.by": "by {by}",
  "phase.queued": "queued",
  "phase.claimed": "claimed",
  "phase.running": "running",
  "phase.waiting_input": "waiting on you",
  "phase.blocked": "blocked",
  "phase.completed": "completed",
  "phase.failed": "failed",
  "phase.cancelled": "cancelled",
  "unit.s": "{n} s",
  "unit.m": "{n} min",
  "unit.h": "{n} h",
  "unit.d": "{n} d",
  "metrics.title": "Metrics",
  "metrics.window": "last {n} h",
  "metrics.col.worker": "Executor",
  "metrics.col.tasks": "Tasks",
  "metrics.col.done": "Done / failed / open",
  "metrics.col.fail": "Fail rate",
  "metrics.col.ask": "Asked you",
  "metrics.col.fallback": "DSH fallback",
  "metrics.col.overdue": "Overdue",
  "metrics.col.queue": "Queue p50 / p90",
  "metrics.col.run": "Run p50 / p90",
  "metrics.total": "Total",
  "metrics.empty": "No tasks in this window",
  "metrics.note": "Counts tasks not yet archived (finished within the last {n} h).",
  "detail.session": "Session",
  "detail.session.load": "Show session ({n} entries)",
  "detail.session.more": "Read more",
  "detail.session.none": "No session was uploaded for this task.",
  "detail.session.loading": "Reading the session\u2026",
  "detail.session.full": "The session got too long; later entries were not kept.",
  "detail.session.shown": "{n} / {total}",
  "role.user": "task",
  "role.assistant": "executor",
  "role.tool": "tool",
  "role.note": "note",
  "role.system": "system",
  "desk.hint": "Everything comes from the cloud channel: tasks dispatched here and by other agents alike. Tokens and internal addresses are never shown."
};
var DICTIONARIES = { zh: { ...zh }, en: { ...en } };

// src/client/styles.ts
var STYLE_KEY = "dsh-client-ui-agent-hub/AgentHubPage.css";
var AGENT_HUB_CSS = `
.dah-page {
  --dah-accent: #4d6bfe;
  --dah-accent-soft: color-mix(in srgb, var(--dah-accent) 11%, transparent);
  --dah-text: var(--dsw-alias-label-primary, #0f1115);
  --dah-text-2: var(--dsw-alias-label-secondary, #61666b);
  --dah-text-3: var(--dsw-alias-label-tertiary, #81858c);
  --dah-line: var(--dsw-alias-border-l, #e1e5ee);
  --dah-base: var(--dsw-alias-bg-base, #fff);
  --dah-fill: var(--dsw-alias-bg-layer-1, #f9fafb);
  --dah-fill-2: var(--dsw-alias-bg-layer-2, #f5f7fa);
  --dah-hover: var(--dsw-alias-interactive-bg-hover, rgba(15, 17, 21, 0.05));
  --dah-ok: var(--dsw-alias-state-success-primary, #22c55e);
  --dah-warn: var(--dsw-alias-state-warn-primary, #f59e0b);
  --dah-bad: var(--dsw-alias-state-error-primary, #ec1313);
  --dah-idle: var(--dsw-alias-state-idle-primary, #d4d4d4);
  --dah-mono: var(--dsh-mono, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace);
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  background: var(--dah-base);
  color: var(--dah-text);
  font-family: var(--dsh-font, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif);
  font-size: 14px;
  line-height: 22px;
  container-type: inline-size;
  -webkit-font-smoothing: antialiased;
}
.dah-page *, .dah-page *::before, .dah-page *::after { box-sizing: border-box; }
.dah-page button, .dah-page select, .dah-page input { font: inherit; color: inherit; }
.dah-page input[type="checkbox"] { margin: 0; accent-color: var(--dah-accent); }
.dah-page input[type="checkbox"]:focus-visible { outline: 2px solid var(--dah-accent); outline-offset: 2px; }

.dah-page [data-tone="pending"] { --dah-tone: var(--dah-warn); }
.dah-page [data-tone="accepted"], .dah-page [data-tone="running"] { --dah-tone: var(--dah-accent); }
.dah-page [data-tone="completed"], .dah-page [data-tone="online"], .dah-page [data-tone="approved"] { --dah-tone: var(--dah-ok); }
.dah-page [data-tone="failed"], .dah-page [data-tone="dead"], .dah-page [data-tone="revoked"], .dah-page [data-tone="rejected"] { --dah-tone: var(--dah-bad); }
.dah-page [data-tone="cancelled"], .dah-page [data-tone="offline"], .dah-page [data-tone="expired"] { --dah-tone: var(--dah-idle); }

.dah-inner { width: 100%; max-width: 1100px; margin: 0 auto; padding: 0 24px 48px; display: flex; flex-direction: column; gap: 20px; }

/* ---------- header ---------- */
.dah-head { padding-top: 36px; display: flex; align-items: flex-end; gap: 16px; flex-wrap: wrap; }
.dah-head-text { flex: 1 1 320px; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.dah-title { margin: 0; font-size: 24px; line-height: 32px; font-weight: 600; letter-spacing: 0; }
.dah-sub { margin: 0; font-size: 13px; color: var(--dah-text-3); }
.dah-head-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.dah-updated { font-size: 12px; color: var(--dah-text-3); font-variant-numeric: tabular-nums; white-space: nowrap; }
.dah-check { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--dah-text-2); cursor: pointer; user-select: none; white-space: nowrap; }

/* ---------- buttons & selects ---------- */
.dah-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 38px; padding: 0 20px; border: 0; border-radius: 999px;
  background: var(--dah-hover); font-size: 13.5px; font-weight: 500; cursor: pointer; white-space: nowrap;
  transition: background 0.15s, opacity 0.15s;
}
.dah-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--dah-text) 10%, transparent); }
.dah-btn:focus-visible { outline: 2px solid var(--dah-accent); outline-offset: 2px; }
.dah-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.dah-btn[data-size="sm"] { height: 30px; padding: 0 14px; font-size: 12.5px; }
.dah-btn[data-icon="true"] { width: 30px; padding: 0; font-size: 16px; color: var(--dah-text-2); }
.dah-btn[data-tone="danger"] { color: var(--dah-bad); background: color-mix(in srgb, var(--dah-bad) 10%, transparent); }
.dah-btn[data-tone="danger"]:hover:not(:disabled) { background: color-mix(in srgb, var(--dah-bad) 16%, transparent); }
.dah-filters { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dah-select {
  height: 30px; max-width: 220px; padding: 0 10px 0 14px; border: 0; border-radius: 999px; background: var(--dah-fill);
  font-size: 12.5px; color: var(--dah-text-2); cursor: pointer; outline: none; transition: background 0.15s, box-shadow 0.15s;
}
.dah-select:hover { background: var(--dah-hover); }
.dah-select:focus-visible { box-shadow: 0 0 0 1.5px var(--dah-accent); }

/* ---------- alerts & notes ---------- */
.dah-alert {
  display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding: 12px 14px; border-radius: 14px;
  background: color-mix(in srgb, var(--dah-bad) 9%, var(--dah-base)); font-size: 13px; line-height: 20px; color: var(--dah-text);
}
.dah-alert[data-kind="warn"] { background: color-mix(in srgb, var(--dah-warn) 12%, var(--dah-base)); }
.dah-alert-title { font-weight: 600; }
.dah-alert .dah-btn { margin-top: 4px; background: var(--dah-base); }
.dah-page code { font-family: var(--dah-mono); font-size: 12px; padding: 1px 6px; border-radius: 6px; background: var(--dah-fill-2); }
.dah-note { margin: 0; font-size: 12.5px; line-height: 20px; color: var(--dah-text-3); }
.dah-foot { margin: 8px 0 0; text-align: center; font-size: 12.5px; line-height: 20px; color: var(--dah-text-3); }

/* ---------- overview: summary stats + status counts ---------- */
.dah-overview { display: flex; flex-direction: column; gap: 10px; }
.dah-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.dah-stat {
  display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: 16px 18px; border: 0; border-radius: 16px;
  background: var(--dah-fill); text-align: left; transition: background 0.15s;
}
button.dah-stat { cursor: pointer; }
button.dah-stat:hover { background: var(--dah-hover); }
.dah-stat[data-on="true"] { background: var(--dah-accent-soft); }
.dah-stat[data-on="true"] .dah-stat-value { color: var(--dah-accent); }
.dah-stat:focus-visible, .dah-state:focus-visible { outline: 2px solid var(--dah-accent); outline-offset: 2px; }
.dah-stat-label { display: flex; align-items: center; gap: 6px; font-size: 12px; line-height: 16px; color: var(--dah-text-3); white-space: nowrap; }
.dah-stat-value { font-family: var(--dah-mono); font-size: 28px; line-height: 36px; font-weight: 600; font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dah-stat-note { font-size: 12px; line-height: 16px; color: var(--dah-text-3); }
.dah-states { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 8px; }
.dah-state {
  display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: 10px 12px; border: 0; border-radius: 14px;
  background: var(--dah-fill); text-align: left; cursor: pointer; transition: background 0.15s;
}
.dah-state:hover { background: var(--dah-hover); }
.dah-state[data-on="true"] { background: var(--dah-accent-soft); }
.dah-state[data-on="true"] .dah-state-label { color: var(--dah-accent); }
.dah-state-label { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12px; line-height: 16px; color: var(--dah-text-3); white-space: nowrap; overflow: hidden; }
.dah-state-value { font-family: var(--dah-mono); font-size: 17px; line-height: 26px; font-weight: 600; font-variant-numeric: tabular-nums; }
.dah-state[data-zero="true"] .dah-state-value { color: var(--dah-text-3); font-weight: 500; }
.dah-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dah-tone, var(--dah-idle)); }

/* ---------- sections ---------- */
.dah-section { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.dah-section-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-height: 30px; }
.dah-section-title { margin: 0; font-size: 12px; line-height: 16px; font-weight: 500; color: var(--dah-text-3); }
.dah-count {
  display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border-radius: 999px; background: var(--dah-fill);
  font-size: 12px; line-height: 16px; color: var(--dah-text-2); font-variant-numeric: tabular-nums; white-space: nowrap;
}
.dah-count:empty { display: none; }
.dah-spacer { flex: 1 1 auto; }
.dah-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 28px 16px; text-align: center; font-size: 13px; line-height: 20px; color: var(--dah-text-3); }
.dah-empty[data-size="page"] { padding: 72px 16px; }
.dah-empty-icon { display: inline-flex; opacity: 0.55; }

/* ---------- tables: no grid lines, rounded hover rows ---------- */
.dah-table-wrap { overflow-x: auto; margin: 0 -12px; }
.dah-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13.5px; line-height: 22px; }
.dah-table th { padding: 4px 12px 6px; text-align: left; font-size: 12px; line-height: 16px; font-weight: 500; color: var(--dah-text-3); white-space: nowrap; background: transparent; }
.dah-table td { padding: 11px 12px; vertical-align: top; background: transparent; transition: background 0.15s; }
.dah-table tbody td:first-child { border-radius: 12px 0 0 12px; }
.dah-table tbody td:last-child { border-radius: 0 12px 12px 0; }
.dah-table tbody tr:hover > td { background: var(--dah-hover); }
.dah-row { cursor: pointer; }
.dah-row:focus-visible { outline: 2px solid var(--dah-accent); outline-offset: -2px; }
.dah-row[data-on="true"] > td, .dah-row[data-on="true"]:hover > td { background: var(--dah-accent-soft); }
.dah-row[data-on="true"] .dah-task-title { color: var(--dah-accent); font-weight: 600; }
.dah-task-title { font-weight: 500; }
.dah-id { font-family: var(--dah-mono); font-size: 12.5px; white-space: nowrap; }
.dah-num { font-family: var(--dah-mono); font-size: 13px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.dah-muted { color: var(--dah-text-3); }
.dah-nowrap { white-space: nowrap; }
.dah-clip { display: block; max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dah-sub-line { display: block; font-size: 12px; line-height: 18px; color: var(--dah-text-3); }
.dah-sub-line.dah-id { font-size: 12px; }
.dah-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.dah-chip {
  display: inline-flex; align-items: center; height: 26px; padding: 0 10px; border: 0; border-radius: 999px;
  background: var(--dah-fill); color: var(--dah-text-2); font-size: 12.5px; white-space: nowrap;
}
.dah-chip.dah-id { font-size: 12px; }
button.dah-chip { background: var(--dah-accent-soft); color: var(--dah-accent); cursor: pointer; transition: background 0.15s; }
button.dah-chip:hover { background: color-mix(in srgb, var(--dah-accent) 18%, transparent); }
button.dah-chip:focus-visible { outline: 2px solid var(--dah-accent); outline-offset: 1px; }
.dah-badge { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; line-height: 22px; white-space: nowrap; }
.dah-badge::before { content: ""; flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dah-tone, var(--dah-idle)); }
.dah-badge[data-tone="failed"], .dah-badge[data-tone="dead"], .dah-badge[data-tone="revoked"], .dah-badge[data-tone="rejected"] { color: var(--dah-bad); }
.dah-badge[data-pill="true"] { height: 26px; padding: 0 10px; border-radius: 999px; background: color-mix(in srgb, var(--dah-tone, var(--dah-idle)) 12%, var(--dah-base)); font-size: 12.5px; font-weight: 500; }
.dah-bar { display: block; width: 72px; height: 4px; margin-top: 2px; border-radius: 999px; background: var(--dah-fill-2); overflow: hidden; }
.dah-bar > i { display: block; height: 100%; border-radius: 999px; background: var(--dah-accent); transition: width 0.15s; }

/* ---------- task detail ---------- */
.dah-detail { display: flex; flex-direction: column; gap: 20px; margin-top: 8px; padding: 24px 26px; border-radius: 24px; background: var(--dah-fill); }
.dah-detail-head { display: flex; align-items: flex-start; gap: 12px; }
.dah-detail-title { flex: 1 1 auto; min-width: 0; margin: 0; display: flex; flex-direction: column; gap: 2px; font-size: 17px; line-height: 26px; font-weight: 600; overflow-wrap: anywhere; }
.dah-detail-title .dah-sub-line { font-weight: 400; }
.dah-meta { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 14px 20px; margin: 0; padding: 16px 18px; border-radius: 16px; background: var(--dah-base); }
.dah-meta div { min-width: 0; }
.dah-meta dt { font-size: 12px; line-height: 16px; color: var(--dah-text-3); }
.dah-meta dd { margin: 2px 0 0; font-size: 13.5px; line-height: 22px; overflow-wrap: anywhere; }
.dah-block { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.dah-block-title { margin: 0; font-size: 12px; line-height: 16px; font-weight: 500; color: var(--dah-text-3); }
.dah-block .dah-chip { background: var(--dah-base); }
.dah-text { font-size: 14px; line-height: 22px; overflow-wrap: anywhere; }
.dah-pre {
  margin: 0; padding: 12px 14px; border-radius: 14px; background: var(--dah-base); font-family: var(--dah-mono); font-size: 12px;
  line-height: 19px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 280px; overflow-y: auto;
}
.dah-result { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.dah-error-text { font-size: 13px; line-height: 20px; color: var(--dah-bad); }
.dah-files { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
.dah-files li { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-height: 40px; padding: 8px 14px; border-radius: 12px; background: var(--dah-base); font-size: 13px; line-height: 20px; }
.dah-history { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 2px; max-height: 320px; overflow-y: auto; }
.dah-history li { display: grid; grid-template-columns: 168px 120px minmax(0, 1fr); gap: 12px; padding: 6px 12px; border-radius: 12px; font-size: 13px; line-height: 20px; transition: background 0.15s; }
.dah-history li:hover { background: var(--dah-hover); }
.dah-history-time { font-family: var(--dah-mono); font-size: 12px; color: var(--dah-text-3); white-space: nowrap; }
.dah-history-event { font-family: var(--dah-mono); font-size: 12.5px; font-weight: 500; }

@container (max-width: 760px) {
  .dah-inner { padding: 0 16px 32px; }
  .dah-head { padding-top: 24px; }
  .dah-summary { grid-template-columns: minmax(0, 1fr); }
  .dah-states { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dah-detail { padding: 20px; }
  .dah-meta { grid-template-columns: minmax(0, 1fr); }
  .dah-history li { grid-template-columns: minmax(0, 1fr); gap: 0; }
  .dah-clip { max-width: 200px; }
}
@media (prefers-reduced-motion: reduce) {
  .dah-btn, .dah-select, .dah-stat, .dah-state, .dah-table td, .dah-chip, .dah-bar > i, .dah-history li { transition: none; }
}

/* ---------- embedded: the router board's \u300CAgent\u300D tab (about 420px) ----------
 * Same tokens and numbers as the page (docs/UI-STYLE.md); only density changes.
 * Every override is scoped to [data-embedded="true"], so the page is untouched,
 * and outranks the 760px container rules above, which also match at 420px. */
.dah-page[data-embedded="true"] { flex: 1 1 auto; min-height: 0; font-size: 13.5px; line-height: 20px; }
.dah-page[data-embedded="true"] .dah-inner { max-width: none; margin: 0; padding: 4px 12px 24px; gap: 12px; }

/* toolbar instead of the page title */
.dah-toolbar { display: flex; align-items: center; gap: 8px; min-height: 30px; }
.dah-toolbar .dah-check { font-size: 12.5px; }

/* three stat cells in one row */
.dah-page[data-embedded="true"] .dah-overview { gap: 8px; }
.dah-page[data-embedded="true"] .dah-summary { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.dah-page[data-embedded="true"] .dah-stat { padding: 10px 12px; border-radius: 14px; }
.dah-page[data-embedded="true"] .dah-stat-label { overflow: hidden; text-overflow: ellipsis; }
.dah-page[data-embedded="true"] .dah-stat-value { font-size: 17px; line-height: 26px; }

/* the seven statuses: one row of pills that scrolls sideways */
.dah-page[data-embedded="true"] .dah-states {
  display: flex; grid-template-columns: none; gap: 6px; margin: 0 -12px; padding: 0 12px 2px;
  overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: thin;
}
.dah-page[data-embedded="true"] .dah-state { flex: none; flex-direction: row; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border-radius: 999px; }
.dah-page[data-embedded="true"] .dah-state-label { overflow: visible; }
.dah-page[data-embedded="true"] .dah-state-value { font-size: 12.5px; line-height: 16px; }

/* foldable groups: caption button (caret, 12px tertiary title, count), tools, body */
.dah-group { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dah-group-head { display: flex; align-items: center; gap: 8px; min-height: 30px; }
.dah-group-toggle {
  flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 6px; height: 30px; margin-left: -8px; padding: 0 8px;
  border: 0; border-radius: 12px; background: transparent; color: var(--dah-text-3); font-size: 12px; line-height: 16px;
  font-weight: 500; text-align: left; cursor: pointer; transition: background 0.15s;
}
.dah-group-toggle:hover { background: var(--dah-hover); color: var(--dah-text-2); }
.dah-group-toggle:focus-visible { outline: 2px solid var(--dah-accent); outline-offset: -2px; }
.dah-caret { flex: none; width: 16px; height: 16px; transition: transform 0.15s; }
.dah-group-toggle[aria-expanded="true"] .dah-caret { transform: rotate(90deg); }
.dah-group-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dah-group-body { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.dah-page[data-embedded="true"] .dah-group-head .dah-select { flex: none; max-width: 140px; }
.dah-page[data-embedded="true"] .dah-filters { flex-wrap: nowrap; }
.dah-page[data-embedded="true"] .dah-filters .dah-select { flex: 1 1 0; min-width: 0; max-width: none; }

/* two-line rows instead of tables */
.dah-list { margin: 0 -8px; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 2px; }
.dah-item { display: flex; flex-direction: column; min-width: 0; }
.dah-item-row { display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: 8px; border-radius: 12px; transition: background 0.15s; }
.dah-item-row[role="button"] { cursor: pointer; }
.dah-item-row[role="button"]:hover { background: var(--dah-hover); }
.dah-item-row:focus-visible { outline: 2px solid var(--dah-accent); outline-offset: -2px; }
.dah-item[data-on="true"] > .dah-item-row, .dah-item[data-on="true"] > .dah-item-row:hover { background: var(--dah-accent-soft); }
.dah-item[data-on="true"] .dah-item-title { color: var(--dah-accent); font-weight: 600; }
.dah-item-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dah-item-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.5px; line-height: 20px; font-weight: 500; }
.dah-item-title.dah-id { font-size: 12.5px; }
.dah-item-meta, .dah-item-note { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; line-height: 18px; }
.dah-item-meta { color: var(--dah-text-3); font-variant-numeric: tabular-nums; }
.dah-item-note { color: var(--dah-text-2); }
.dah-item-note[data-tone="failed"] { color: var(--dah-bad); }
.dah-item-row .dah-chips { margin-top: 4px; }
.dah-item-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 0 8px 8px; }
.dah-item-row .dah-bar { width: 100%; margin: 4px 0 2px; }
.dah-page[data-embedded="true"] .dah-badge { flex: none; font-size: 12.5px; line-height: 20px; }

/* task detail opens inside the list, under its row */
.dah-item-detail { min-width: 0; padding: 4px 0 8px; }
.dah-page[data-embedded="true"] .dah-detail { gap: 14px; margin-top: 0; padding: 14px; border-radius: 16px; }
.dah-page[data-embedded="true"] .dah-detail-title { font-size: 14px; line-height: 22px; }
.dah-page[data-embedded="true"] .dah-meta { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 12px; padding: 12px; border-radius: 14px; }
.dah-page[data-embedded="true"] .dah-meta dd { font-size: 13px; line-height: 20px; }
.dah-page[data-embedded="true"] .dah-pre { max-height: 200px; }
.dah-page[data-embedded="true"] .dah-files li { min-height: 36px; padding: 6px 10px; }
.dah-page[data-embedded="true"] .dah-history li { grid-template-columns: minmax(0, 1fr); gap: 0; padding: 6px 8px; }

/* quieter states and notes */
.dah-page[data-embedded="true"] .dah-alert { padding: 10px 12px; font-size: 12.5px; line-height: 18px; }
.dah-page[data-embedded="true"] .dah-empty { padding: 20px 12px; }
.dah-page[data-embedded="true"] .dah-foot { margin: 4px 0 0; font-size: 12px; line-height: 18px; }

@media (prefers-reduced-motion: reduce) {
  .dah-group-toggle, .dah-caret, .dah-item-row { transition: none; }
}

/* ---------- worker presence (protocol v2 \xA79), page and embedded ----------
 * Tones: online = ok, pending = warn, offline / left = idle, revoked = bad
 * (the first three already map above); "warn" marks a presence requeue. */
.dah-page [data-tone="left"] { --dah-tone: var(--dah-idle); }
.dah-page [data-tone="warn"] { --dah-tone: var(--dah-warn); }
.dah-stat-of { margin-left: 2px; font-size: 0.64em; font-weight: 500; color: var(--dah-text-3); }
.dah-stat-note { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dah-count-note { font-size: 12px; line-height: 16px; font-weight: 400; color: var(--dah-text-3); font-variant-numeric: tabular-nums; white-space: nowrap; }
.dah-history li[data-tone="warn"] { background: color-mix(in srgb, var(--dah-warn) 12%, var(--dah-base)); }
.dah-history li[data-tone="warn"]:hover { background: color-mix(in srgb, var(--dah-warn) 18%, var(--dah-base)); }
.dah-history-flag { display: inline-flex; align-items: center; gap: 6px; margin-right: 8px; font-size: 12px; line-height: 20px; font-weight: 500; color: var(--dah-text-2); white-space: nowrap; }
.dah-history-flag::before { content: ""; flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dah-tone, var(--dah-warn)); }

/* ---------- \u8C03\u5EA6\u53F0: lanes, profile groups, DSH's own workers, session ---------- */
.dah-page [data-tone="self"] { --dah-tone: var(--dah-accent); }
.dah-badge[data-tone="self"] { color: var(--dah-accent); }
.dah-sub { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dah-sub + .dah-sub { margin-top: 6px; }
.dah-sub-head {
  display: flex; align-items: center; gap: 6px; min-height: 24px; padding: 0; border: 0; background: transparent;
  font-size: 12px; line-height: 16px; font-weight: 600; color: var(--dah-text-2); text-align: left;
}
.dah-sub-head .dah-count { font-weight: 400; color: var(--dah-text-3); font-variant-numeric: tabular-nums; }
.dah-sub-head[data-button="true"] { margin-left: -8px; padding: 0 8px; border-radius: 10px; cursor: pointer; transition: background 0.15s; }
.dah-sub-head[data-button="true"]:hover { background: var(--dah-hover); }
.dah-sub-head[data-button="true"]:focus-visible { outline: 2px solid var(--dah-accent); outline-offset: -2px; }
.dah-sub-head[aria-expanded="true"] .dah-caret { transform: rotate(90deg); }
.dah-sub[data-lane="waiting"] > .dah-sub-head { color: var(--dah-warn); }
.dah-item[data-kind="self"] .dah-item-row { background: color-mix(in srgb, var(--dah-accent) 5%, transparent); }
.dah-item-row .dah-chips .dah-chip:not(.dah-id) { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dah-item-note[data-tone="quiet"] { color: var(--dah-text-3); }
.dah-link {
  align-self: flex-start; height: 26px; margin-left: -8px; padding: 0 8px; border: 0; border-radius: 10px; background: transparent;
  font-size: 12px; color: var(--dah-text-3); cursor: pointer; transition: background 0.15s;
}
.dah-link:hover { background: var(--dah-hover); color: var(--dah-text-2); }
.dah-link:focus-visible { outline: 2px solid var(--dah-accent); outline-offset: -2px; }
.dah-tools { flex: none; display: inline-flex; align-items: center; gap: 6px; }
.dah-page[data-embedded="true"] .dah-tools .dah-select { max-width: 120px; }
.dah-session { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.dah-session-list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; max-height: 420px; overflow-y: auto; }
.dah-session-entry { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: 12px; background: var(--dah-fill); min-width: 0; }
.dah-session-entry[data-role="assistant"] { background: var(--dah-accent-soft); }
.dah-session-entry[data-role="tool"] { background: var(--dah-fill-2); }
.dah-session-who { font-size: 12px; line-height: 16px; font-weight: 600; color: var(--dah-text-2); }
.dah-session-text { margin: 0; font-family: var(--dah-mono); font-size: 12px; line-height: 18px; white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow-y: auto; }
.dah-session-foot { display: flex; align-items: center; gap: 10px; font-size: 12px; }
@media (prefers-reduced-motion: reduce) {
  .dah-sub-head[data-button="true"], .dah-link { transition: none; }
}
/* ---------- lifecycle: answer box, phases, metrics ---------- */
.dah-page [data-tone="waiting_input"], .dah-page [data-tone="waiting"], .dah-page [data-tone="blocked"] { --dah-tone: var(--dah-warn); }
.dah-page [data-tone="queued"] { --dah-tone: var(--dah-warn); }
.dah-page [data-tone="claimed"] { --dah-tone: var(--dah-accent); }
.dah-btn[data-tone="primary"] { color: #fff; background: var(--dah-accent); }
.dah-btn[data-tone="primary"]:hover:not(:disabled) { background: color-mix(in srgb, var(--dah-accent) 86%, #000); }
.dah-answer { padding: 14px 16px; border-radius: 16px; background: color-mix(in srgb, var(--dah-warn) 10%, var(--dah-base)); }
.dah-answer .dah-text b { margin-right: 6px; }
.dah-input {
  width: 100%; box-sizing: border-box; min-height: 72px; padding: 10px 12px; border: 0; border-radius: 12px; resize: vertical;
  background: var(--dah-base); color: var(--dah-text); font: inherit; font-size: 13.5px; line-height: 20px; outline: none;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--dah-text) 10%, transparent); transition: box-shadow 0.15s;
}
.dah-input:focus-visible { box-shadow: 0 0 0 1.5px var(--dah-accent); }
.dah-input:disabled { opacity: 0.6; }
.dah-row-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 8px; }
.dah-life { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }
.dah-metrics { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.dah-table td[data-tone="failed"] { color: var(--dah-bad); }
.dah-table tbody tr[data-total="true"] > td { border-top: 1px solid color-mix(in srgb, var(--dah-text) 10%, transparent); font-weight: 500; }
@media (prefers-reduced-motion: reduce) {
  .dah-input { transition: none; }
}
`;
function installStyles() {
  if (typeof document === "undefined") return;
  const selector = `style[data-plugin-css=${JSON.stringify(STYLE_KEY)}]`;
  if (document.querySelector(selector) !== null) return;
  const tag = document.createElement("style");
  tag.dataset["plugin"] = "dsh-client-ui-agent-hub";
  tag.dataset["pluginCss"] = STYLE_KEY;
  tag.textContent = AGENT_HUB_CSS;
  document.head.appendChild(tag);
}

// src/client/index.ts
var PANEL_ID = "agent-hub/page";
var BOARD_TAB_ID = "agent-hub";
var BOARD_TAB_ORDER = -100;
var FALLBACK_DELAY_MS = 3e3;
var BADGE_POLL_MS = 3e4;
var inject = ["slots", "locale"];
function apply(ctx) {
  installStyles();
  ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), "client-ui-agent-hub: dictionaries");
  const t = ctx.locale.bind(NS);
  const registry = boardTabs();
  let pending;
  let stranded;
  let reportedAt = 0;
  const report = (overview) => {
    reportedAt = Date.now();
    const count = overview.pending_requests;
    const nextPending = typeof count === "number" && Number.isFinite(count) && count > 0 ? count : void 0;
    let agents = 0;
    let tasks = 0;
    for (const agent of Array.isArray(overview.agents) ? overview.agents : []) {
      const status = agentStatus(agent);
      const held = Array.isArray(agent.running_tasks) ? agent.running_tasks.length : 0;
      if ((status === "offline" || status === "left") && held > 0) {
        agents += 1;
        tasks += held;
      }
    }
    const nextStranded = agents > 0 ? { agents, tasks } : void 0;
    const changed = nextPending !== pending || nextStranded?.agents !== stranded?.agents || nextStranded?.tasks !== stranded?.tasks;
    pending = nextPending;
    stranded = nextStranded;
    if (changed) registry.notify();
  };
  const flag = () => pending === void 0 && stranded !== void 0 ? t("board.flag.stranded", { n: stranded.agents, tasks: stranded.tasks }) : void 0;
  ctx.effect(() => registry.register({
    id: BOARD_TAB_ID,
    order: BOARD_TAB_ORDER,
    label: () => t("board.tab"),
    badge: () => pending,
    flag,
    Component: createAgentHubBoardTab(t, report)
  }), "client-ui-agent-hub: board tab");
  ctx.effect(() => {
    let alive = true;
    const tick = () => {
      if (!alive || !registry.hasConsumer()) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (Date.now() - reportedAt < BADGE_POLL_MS / 2) return;
      fetchOverview().then((overview) => {
        if (alive) report(overview);
      }, () => {
      });
    };
    const first = setTimeout(tick, FALLBACK_DELAY_MS);
    const timer = setInterval(tick, BADGE_POLL_MS);
    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(timer);
    };
  }, "client-ui-agent-hub: board tab badge");
  ctx.slots.inject("main", () => ctx.slots.register({
    name: "main",
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ t })
  }, AgentHubPage));
  ctx.effect(() => {
    let row;
    let timer;
    const install = () => {
      timer = void 0;
      if (registry.hasConsumer() || row !== void 0) return;
      row = ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
        name: "sidebar.panellist",
        id: PANEL_ID,
        order: -25,
        locale: NS,
        label: () => t("page.title")
      }, HubIcon));
    };
    const sync = () => {
      if (registry.hasConsumer()) {
        if (timer !== void 0) clearTimeout(timer);
        timer = void 0;
        if (row !== void 0) row();
        row = void 0;
        return;
      }
      if (row === void 0 && timer === void 0) timer = setTimeout(install, FALLBACK_DELAY_MS);
    };
    const stop = registry.subscribe(sync);
    sync();
    return () => {
      stop();
      if (timer !== void 0) clearTimeout(timer);
      if (row !== void 0) row();
    };
  }, "client-ui-agent-hub: sidebar fallback");
}

return module.exports}});
