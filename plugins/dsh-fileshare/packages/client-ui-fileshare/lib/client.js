window.__ModuleLoader__.load({id:"dsh-client-ui-fileshare",factory:require=>{var module={exports:{}};var exports=module.exports;Object.defineProperty(exports,Symbol.toStringTag,{value:"Module"});
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

// src/client/FileshareIcon.tsx
var import_jsx_runtime = require("react/jsx-runtime");
function FileshareIcon({ size = 18, active = false }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("svg", { width: size, height: size, viewBox: "0 0 18 18", fill: "none", "aria-hidden": "true", style: { opacity: active ? 1 : 0.72 }, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M6 14V4m0 0L3 7m3-3 3 3M12 4v10m0 0-3-3m3 3 3-3", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round" }) });
}

// src/client/FilesharePage.tsx
var import_react = require("react");

// src/client/source.ts
var ROUTE_BASE = "/api/fileshare";
var SourceError = class extends Error {
  status;
  constructor(message, status) {
    super(message);
    this.name = "SourceError";
    this.status = status;
  }
};
async function call(path, payload, signal) {
  let response;
  try {
    response = await fetch(`${ROUTE_BASE}/${path}`, payload === void 0 ? { method: "GET", credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" }, signal } : {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json", "x-dsh-fileshare": "1" },
      body: JSON.stringify(payload),
      signal
    });
  } catch (error) {
    throw new SourceError(error instanceof Error ? error.message : String(error));
  }
  const text = await response.text();
  let body;
  try {
    body = text.trim() === "" ? void 0 : JSON.parse(text);
  } catch {
    body = void 0;
  }
  if (!response.ok) {
    const message = body?.error?.message;
    throw new SourceError(typeof message === "string" ? message : `HTTP ${response.status}`, response.status);
  }
  return body;
}
function fetchOverview(signal) {
  return call("links", void 0, signal);
}
function hello() {
  return call("hello", {});
}
function createDownload(input) {
  return call("create", { kind: "download", ...input });
}
function createUpload(input) {
  return call("create", { kind: "upload", ...input });
}
function revoke(id) {
  return call("revoke", { id });
}

// src/client/FilesharePage.tsx
var import_jsx_runtime2 = require("react/jsx-runtime");
var DOWNLOAD_TTLS = [15, 60, 1440, 10080];
var UPLOAD_TTLS = [30, 120, 1440];
var UPLOAD_SIZES = [100, 512, 2048];
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
function formatTime(iso) {
  const date = new Date(iso);
  return date.toLocaleString(void 0, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function fullUrl(created) {
  return created.url ?? created.path;
}
function CopyButton({ text, t, label }) {
  const [done, setDone] = (0, import_react.useState)(false);
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setDone(true);
      window.setTimeout(() => setDone(false), 1600);
    });
  };
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dsf-btn dsf-btn-sm", onClick: copy, children: done ? t("created.copied") : label ?? t("created.copy") });
}
function CreatedBox({ created, t }) {
  const text = fullUrl(created);
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dsf-created", role: "status", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dsf-created-title", children: created.url === null ? t("created.pathOnly") : t("created.title") }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dsf-created-url", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dsf-mono", children: text }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(CopyButton, { text, t }),
      created.url !== null && created.kind === "upload" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("a", { className: "dsf-btn dsf-btn-sm", href: created.url, target: "_blank", rel: "noreferrer noopener", children: t("created.open") }) : null
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dsf-created-note", children: t("created.once") })
  ] });
}
function FilesharePage({ t }) {
  const [overview, setOverview] = (0, import_react.useState)(void 0);
  const [loadError, setLoadError] = (0, import_react.useState)(void 0);
  const [filter, setFilter] = (0, import_react.useState)("active");
  const [urls, setUrls] = (0, import_react.useState)({});
  const [path, setPath] = (0, import_react.useState)("");
  const [shareTtl, setShareTtl] = (0, import_react.useState)(60);
  const [shareLimit, setShareLimit] = (0, import_react.useState)(0);
  const [shareResult, setShareResult] = (0, import_react.useState)(void 0);
  const [shareError, setShareError] = (0, import_react.useState)(void 0);
  const [dir, setDir] = (0, import_react.useState)("");
  const [uploadTtl, setUploadTtl] = (0, import_react.useState)(30);
  const [uploadMb, setUploadMb] = (0, import_react.useState)(512);
  const [uploadResult, setUploadResult] = (0, import_react.useState)(void 0);
  const [uploadError, setUploadError] = (0, import_react.useState)(void 0);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const inflight = (0, import_react.useRef)(null);
  const load = (0, import_react.useCallback)(() => {
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    fetchOverview(controller.signal).then(
      (next) => {
        setOverview(next);
        setLoadError(void 0);
      },
      (error) => {
        if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : String(error));
      }
    );
  }, []);
  (0, import_react.useEffect)(() => {
    load();
    const timer = window.setInterval(load, 15e3);
    return () => {
      window.clearInterval(timer);
      inflight.current?.abort();
    };
  }, [load]);
  const remember = (created) => {
    setUrls((previous) => ({ ...previous, [created.id]: fullUrl(created) }));
  };
  const onShare = async () => {
    setBusy(true);
    setShareError(void 0);
    try {
      const created = await createDownload({ path: path.trim(), ttlMinutes: shareTtl, ...shareLimit > 0 ? { maxDownloads: shareLimit } : {} });
      setShareResult(created);
      remember(created);
      load();
    } catch (error) {
      setShareError(t("error.action", { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(false);
    }
  };
  const onReceive = async () => {
    setBusy(true);
    setUploadError(void 0);
    try {
      const created = await createUpload({ ...dir.trim() !== "" ? { dir: dir.trim() } : {}, ttlMinutes: uploadTtl, maxMb: uploadMb });
      setUploadResult(created);
      remember(created);
      load();
    } catch (error) {
      setUploadError(t("error.action", { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(false);
    }
  };
  const onRevoke = async (id) => {
    try {
      await revoke(id);
    } catch (error) {
      setLoadError(t("error.action", { message: error instanceof Error ? error.message : String(error) }));
    }
    load();
  };
  const links = (overview?.links ?? []).filter((link) => filter === "all" || link.state === "active");
  const base = overview?.base ?? null;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dsf-page", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dsf-col", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("header", { className: "dsf-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h1", { className: "dsf-title", children: t("page.title") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dsf-sub", children: t("page.subtitle") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dsf-btn", onClick: load, children: t("page.refresh") })
    ] }),
    overview !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dsf-base", "data-missing": base === null ? "true" : "false", children: base === null ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: t("base.none") }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: t("base.label") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("b", { className: "dsf-mono", children: base }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: t(overview.baseSource === "config" ? "base.config" : "base.browser") })
    ] }) }) : null,
    loadError !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dsf-error", children: t("error.load", { message: loadError }) }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dsf-cards", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { className: "dsf-card", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h2", { className: "dsf-card-title", children: t("share.title") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dsf-card-sub", children: t("share.sub") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { className: "dsf-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dsf-label", children: t("share.path") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("input", { className: "dsf-input", value: path, placeholder: "/srv/project/out/report.zip", onChange: (event) => setPath(event.target.value) }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dsf-hint", children: t("share.path.hint") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dsf-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { className: "dsf-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dsf-label", children: t("share.ttl") }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("select", { className: "dsf-select", value: shareTtl, onChange: (event) => setShareTtl(Number(event.target.value)), children: DOWNLOAD_TTLS.map((value) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("option", { value, children: t(`ttl.${value}`) }, value)) })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { className: "dsf-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dsf-label", children: t("share.limit") }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("select", { className: "dsf-select", value: shareLimit, onChange: (event) => setShareLimit(Number(event.target.value)), children: [
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("option", { value: 0, children: t("share.limit.none") }),
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("option", { value: 1, children: t("share.limit.one") }),
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("option", { value: 5, children: t("share.limit.five") })
            ] })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dsf-btn", "data-primary": "true", disabled: busy || path.trim() === "", onClick: () => {
          void onShare();
        }, children: t("share.submit") }),
        shareError !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dsf-error", children: shareError }) : null,
        shareResult !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(CreatedBox, { created: shareResult, t }) : null
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { className: "dsf-card", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h2", { className: "dsf-card-title", children: t("receive.title") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dsf-card-sub", children: t("receive.sub") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { className: "dsf-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dsf-label", children: t("receive.dir") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("input", { className: "dsf-input", value: dir, placeholder: overview?.defaults.inboxDir ?? "", onChange: (event) => setDir(event.target.value) }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dsf-hint", children: t("receive.dir.hint", { inbox: overview?.defaults.inboxDir ?? "" }) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dsf-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { className: "dsf-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dsf-label", children: t("share.ttl") }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("select", { className: "dsf-select", value: uploadTtl, onChange: (event) => setUploadTtl(Number(event.target.value)), children: UPLOAD_TTLS.map((value) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("option", { value, children: t(`ttl.${value}`) }, value)) })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { className: "dsf-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dsf-label", children: t("receive.size") }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("select", { className: "dsf-select", value: uploadMb, onChange: (event) => setUploadMb(Number(event.target.value)), children: UPLOAD_SIZES.map((value) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("option", { value, children: value >= 1024 ? `${value / 1024} GB` : `${value} MB` }, value)) })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dsf-btn", "data-primary": "true", disabled: busy, onClick: () => {
          void onReceive();
        }, children: t("receive.submit") }),
        uploadError !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dsf-error", children: uploadError }) : null,
        uploadResult !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(CreatedBox, { created: uploadResult, t }) : null
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { className: "dsf-section", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dsf-section-head", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h2", { className: "dsf-section-title", children: t("list.title") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dsf-segmented", role: "tablist", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", role: "tab", className: "dsf-segment", "data-on": filter === "active" ? "true" : "false", onClick: () => setFilter("active"), children: t("list.active") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", role: "tab", className: "dsf-segment", "data-on": filter === "all" ? "true" : "false", onClick: () => setFilter("all"), children: t("list.all") })
        ] })
      ] }),
      links.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dsf-empty", children: t("list.empty") }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dsf-list", children: links.map((link) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(LinkRow, { link, url: urls[link.id], t, onRevoke }, link.id)) })
    ] }),
    overview !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { className: "dsf-section", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h2", { className: "dsf-section-title", children: t("roots.title") }),
      overview.roots.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dsf-empty", children: t("roots.none") }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dsf-roots", children: overview.roots.map((root) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dsf-mono", children: root }, root)) })
    ] }) : null
  ] }) });
}
function LinkRow({ link, url, t, onRevoke }) {
  const ended = link.state !== "active";
  const usage = link.kind === "download" ? link.maxDownloads !== null && link.maxDownloads !== void 0 ? t("list.downloadsOf", { count: link.downloads ?? 0, max: link.maxDownloads }) : t("list.downloads", { count: link.downloads ?? 0 }) : t("list.received", { count: link.files?.length ?? 0, max: link.maxFiles ?? 0, size: formatBytes(link.receivedBytes ?? 0) });
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dsf-item", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dsf-kind", "data-kind": link.kind, children: t(link.kind === "download" ? "list.kind.download" : "list.kind.upload") }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dsf-item-main", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "dsf-item-name", title: link.path, children: [
        link.name,
        link.size !== void 0 ? ` \xB7 ${formatBytes(link.size)}` : ""
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "dsf-item-meta", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dsf-state", "data-state": link.state, children: t(`list.state.${link.state}`) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: ended ? t("list.ended", { time: formatTime(link.revokedAt ?? link.expiresAt) }) : t("list.expires", { time: formatTime(link.expiresAt) }) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: usage }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: t(link.by === "page" ? "list.by.page" : "list.by.agent") }),
        link.note !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: link.note }) : null
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dsf-item-actions", children: [
      url !== void 0 && !ended ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(CopyButton, { text: url, t, label: t("list.copy") }) : null,
      !ended ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dsf-btn dsf-btn-sm", "data-danger": "true", onClick: () => {
        void onRevoke(link.id);
      }, children: t("list.revoke") }) : null
    ] }),
    link.kind === "upload" && (link.files?.length ?? 0) > 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dsf-files", children: link.files?.map((file) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "dsf-mono", children: [
      file.name,
      " \xB7 ",
      formatBytes(file.size)
    ] }, `${file.name}-${file.at}`)) }) : null
  ] });
}

// src/client/locales.ts
var NS = "fileshare";
var zh = {
  "page.nav": "\u6587\u4EF6\u4E2D\u8F6C",
  "page.title": "\u6587\u4EF6\u4E2D\u8F6C",
  "page.subtitle": "\u7ED9\u6587\u4EF6\u751F\u6210\u4E34\u65F6\u4E0B\u8F7D\u3001\u4E0A\u4F20\u94FE\u63A5\uFF0C\u4E0D\u7528\u518D scp\u3002\u94FE\u63A5\u5C31\u662F\u51ED\u8BC1\uFF0C\u8FC7\u671F\u6216\u64A4\u9500\u540E\u7ACB\u523B\u5931\u6548\u3002",
  "page.refresh": "\u5237\u65B0",
  "base.label": "\u94FE\u63A5\u5730\u5740",
  "base.config": "\u6765\u81EA\u914D\u7F6E",
  "base.browser": "\u6765\u81EA\u4F60\u8BBF\u95EE DSH \u7684\u5730\u5740",
  "base.none": "\u8FD8\u4E0D\u77E5\u9053\u5BF9\u5916\u5730\u5740\uFF0C\u94FE\u63A5\u53EA\u80FD\u7ED9\u51FA\u8DEF\u5F84\u3002\u5728 dsh-fileshare \u914D\u7F6E\u91CC\u8BBE publicBaseUrl\uFF0C\u6216\u4ECE\u5BF9\u5916\u57DF\u540D\u6253\u5F00\u4E00\u6B21 DSH\u3002",
  "share.title": "\u5206\u4EAB\u6587\u4EF6",
  "share.sub": "\u751F\u6210\u4E0B\u8F7D\u94FE\u63A5\uFF0C\u6D4F\u89C8\u5668\u6216 curl \u90FD\u80FD\u76F4\u63A5\u4E0B\u3002",
  "share.path": "\u6587\u4EF6\u8DEF\u5F84",
  "share.path.hint": "\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u8981\u5728\u5141\u8BB8\u7684\u6587\u4EF6\u5939\u91CC",
  "share.ttl": "\u6709\u6548\u671F",
  "share.limit": "\u6B21\u6570",
  "share.limit.none": "\u4E0D\u9650",
  "share.limit.one": "1 \u6B21",
  "share.limit.five": "5 \u6B21",
  "share.submit": "\u751F\u6210\u4E0B\u8F7D\u94FE\u63A5",
  "receive.title": "\u6536\u6587\u4EF6",
  "receive.sub": "\u751F\u6210\u4E0A\u4F20\u94FE\u63A5\uFF0C\u5BF9\u65B9\u62D6\u8FDB\u7F51\u9875\u6216 curl -T \u5C31\u80FD\u4F20\u4E0A\u6765\u3002",
  "receive.dir": "\u653E\u5230",
  "receive.dir.hint": "\u7559\u7A7A\u5C31\u653E\u8FDB\u6536\u4EF6\u7BB1 {inbox}",
  "receive.size": "\u5BB9\u91CF",
  "receive.submit": "\u751F\u6210\u4E0A\u4F20\u94FE\u63A5",
  "ttl.15": "15 \u5206\u949F",
  "ttl.30": "30 \u5206\u949F",
  "ttl.60": "1 \u5C0F\u65F6",
  "ttl.120": "2 \u5C0F\u65F6",
  "ttl.1440": "1 \u5929",
  "ttl.10080": "7 \u5929",
  "created.title": "\u94FE\u63A5\u5DF2\u751F\u6210",
  "created.once": "\u5B8C\u6574\u94FE\u63A5\u53EA\u663E\u793A\u8FD9\u4E00\u6B21\uFF0C\u5173\u6389\u9875\u9762\u540E\u5217\u8868\u91CC\u4E0D\u4F1A\u518D\u663E\u793A\u3002",
  "created.copy": "\u590D\u5236",
  "created.copied": "\u5DF2\u590D\u5236",
  "created.open": "\u6253\u5F00",
  "created.pathOnly": "\u8FD8\u4E0D\u77E5\u9053\u5BF9\u5916\u5730\u5740\uFF0C\u53EA\u80FD\u7ED9\u51FA\u8DEF\u5F84\uFF1A",
  "roots.title": "\u5141\u8BB8\u7684\u6587\u4EF6\u5939",
  "roots.none": "\u8FD8\u6CA1\u6709\u5141\u8BB8\u7684\u6587\u4EF6\u5939\u3002\u5728\u914D\u7F6E roots \u91CC\u52A0\uFF0C\u6216\u8BA9 agent \u5728\u5B83\u7684\u5DE5\u4F5C\u76EE\u5F55\u91CC\u5206\u4EAB\u4E00\u6B21\u3002",
  "list.title": "\u94FE\u63A5",
  "list.active": "\u6709\u6548",
  "list.all": "\u5168\u90E8",
  "list.empty": "\u8FD8\u6CA1\u6709\u94FE\u63A5\u3002",
  "list.revoke": "\u64A4\u9500",
  "list.copy": "\u590D\u5236\u94FE\u63A5",
  "list.kind.download": "\u4E0B\u8F7D",
  "list.kind.upload": "\u4E0A\u4F20",
  "list.state.active": "\u6709\u6548",
  "list.state.expired": "\u5DF2\u8FC7\u671F",
  "list.state.revoked": "\u5DF2\u64A4\u9500",
  "list.state.used-up": "\u5DF2\u7528\u5B8C",
  "list.expires": "{time} \u5230\u671F",
  "list.ended": "{time} \u7ED3\u675F",
  "list.downloads": "\u4E0B\u8F7D {count} \u6B21",
  "list.downloadsOf": "\u4E0B\u8F7D {count}/{max} \u6B21",
  "list.received": "\u6536\u5230 {count}/{max} \u4E2A \xB7 {size}",
  "list.by.agent": "agent \u751F\u6210",
  "list.by.page": "\u9875\u9762\u751F\u6210",
  "error.load": "\u8BFB\u53D6\u5931\u8D25\uFF1A{message}",
  "error.action": "\u64CD\u4F5C\u5931\u8D25\uFF1A{message}"
};
var en = {
  "page.nav": "File drop",
  "page.title": "File drop",
  "page.subtitle": "Temporary download and upload links, instead of scp. The link is the credential; it stops working when it expires or is revoked.",
  "page.refresh": "Refresh",
  "base.label": "Link address",
  "base.config": "from config",
  "base.browser": "from the address you use for DSH",
  "base.none": "No public address yet, so links are paths only. Set publicBaseUrl in the dsh-fileshare config, or open DSH once through its public address.",
  "share.title": "Share a file",
  "share.sub": "A download link for a browser or curl.",
  "share.path": "File path",
  "share.path.hint": "Absolute path inside an allowed folder",
  "share.ttl": "Lifetime",
  "share.limit": "Downloads",
  "share.limit.none": "Unlimited",
  "share.limit.one": "Once",
  "share.limit.five": "5 times",
  "share.submit": "Create download link",
  "receive.title": "Receive files",
  "receive.sub": "An upload link: drop files on the page, or curl -T.",
  "receive.dir": "Into",
  "receive.dir.hint": "Empty: the inbox {inbox}",
  "receive.size": "Capacity",
  "receive.submit": "Create upload link",
  "ttl.15": "15 min",
  "ttl.30": "30 min",
  "ttl.60": "1 hour",
  "ttl.120": "2 hours",
  "ttl.1440": "1 day",
  "ttl.10080": "7 days",
  "created.title": "Link created",
  "created.once": "The full link is shown only now; the list will not show it again.",
  "created.copy": "Copy",
  "created.copied": "Copied",
  "created.open": "Open",
  "created.pathOnly": "No public address yet, so only the path:",
  "roots.title": "Allowed folders",
  "roots.none": "No allowed folders yet. Add roots in the config, or let an agent share once from its working directory.",
  "list.title": "Links",
  "list.active": "Active",
  "list.all": "All",
  "list.empty": "No links yet.",
  "list.revoke": "Revoke",
  "list.copy": "Copy link",
  "list.kind.download": "Download",
  "list.kind.upload": "Upload",
  "list.state.active": "Active",
  "list.state.expired": "Expired",
  "list.state.revoked": "Revoked",
  "list.state.used-up": "Used up",
  "list.expires": "expires {time}",
  "list.ended": "ended {time}",
  "list.downloads": "{count} downloads",
  "list.downloadsOf": "{count}/{max} downloads",
  "list.received": "{count}/{max} files \xB7 {size}",
  "list.by.agent": "by an agent",
  "list.by.page": "from this page",
  "error.load": "Could not load: {message}",
  "error.action": "Failed: {message}"
};
var DICTIONARIES = { zh: { ...zh }, en: { ...en } };

// src/client/styles.ts
var STYLE_KEY = "dsh-client-ui-fileshare/page.css";
var FILESHARE_CSS = `
.dsf-page {
  --dsf-accent: #4d6bfe;
  --dsf-text: var(--dsw-alias-label-primary, #0f1115);
  --dsf-text-2: var(--dsw-alias-label-secondary, #61666b);
  --dsf-text-3: var(--dsw-alias-label-tertiary, #81858c);
  --dsf-base: var(--dsw-alias-bg-base, #fff);
  --dsf-fill: var(--dsw-alias-bg-layer-1, #f9fafb);
  --dsf-fill-2: var(--dsw-alias-bg-layer-2, #f5f7fa);
  --dsf-hover: var(--dsw-alias-interactive-bg-hover, rgba(15, 17, 21, 0.05));
  --dsf-ok: var(--dsw-alias-state-success-primary, #22c55e);
  --dsf-warn: var(--dsw-alias-state-warn-primary, #f59e0b);
  --dsf-bad: var(--dsw-alias-state-error-primary, #ec1313);
  --dsf-idle: var(--dsw-alias-state-idle-primary, #a3a3a3);
  --dsf-mono: var(--dsh-mono, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace);
  height: 100%; min-height: 0; overflow-y: auto; background: var(--dsf-base); color: var(--dsf-text);
  font-family: var(--dsh-font, -apple-system, "SF Pro Text", "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif);
  font-size: 14px; line-height: 22px; -webkit-font-smoothing: antialiased; container-type: inline-size;
}
.dsf-page *, .dsf-page *::before, .dsf-page *::after { box-sizing: border-box; }
.dsf-page button, .dsf-page input, .dsf-page select { font: inherit; color: inherit; }
.dsf-col { width: 100%; max-width: 1040px; margin: 0 auto; padding: 0 24px 56px; display: flex; flex-direction: column; gap: 24px; }
.dsf-mono { font-family: var(--dsf-mono); font-size: 12.5px; overflow-wrap: anywhere; }

.dsf-head { padding-top: 40px; display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.dsf-title { margin: 0; font-size: 28px; line-height: 36px; font-weight: 600; letter-spacing: -0.01em; }
.dsf-sub { margin: 4px 0 0; font-size: 14px; line-height: 21px; color: var(--dsf-text-2); max-width: 640px; }

.dsf-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 36px; padding: 0 16px; border: 0;
  border-radius: 999px; background: var(--dsf-hover); cursor: pointer; font-size: 13.5px; font-weight: 500; white-space: nowrap;
  transition: background .15s ease, opacity .15s ease;
}
.dsf-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--dsf-text) 9%, transparent); }
.dsf-btn:disabled { opacity: .5; cursor: default; }
.dsf-btn:focus-visible, .dsf-segment:focus-visible, .dsf-input:focus-visible, .dsf-select:focus-visible { outline: 2px solid var(--dsf-accent); outline-offset: 2px; }
.dsf-btn[data-primary="true"] { background: var(--dsf-accent); color: #fff; }
.dsf-btn[data-primary="true"]:hover:not(:disabled) { background: color-mix(in srgb, var(--dsf-accent) 88%, #000); }
.dsf-btn[data-danger="true"] { color: var(--dsf-bad); background: color-mix(in srgb, var(--dsf-bad) 10%, transparent); }
.dsf-btn-sm { height: 28px; padding: 0 12px; font-size: 12.5px; }

.dsf-base { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 12px 16px; border-radius: 14px; background: var(--dsf-fill); font-size: 13px; color: var(--dsf-text-2); }
.dsf-base[data-missing="true"] { background: color-mix(in srgb, var(--dsf-warn) 12%, var(--dsf-base)); }
.dsf-base b { color: var(--dsf-text); font-weight: 600; }

.dsf-cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.dsf-card { display: flex; flex-direction: column; gap: 14px; padding: 24px; border-radius: 20px; background: var(--dsf-fill); }
.dsf-card-title { margin: 0; font-size: 19px; line-height: 26px; font-weight: 600; }
.dsf-card-sub { margin: -8px 0 0; font-size: 13px; color: var(--dsf-text-2); }
.dsf-field { display: flex; flex-direction: column; gap: 6px; }
.dsf-label { font-size: 12.5px; font-weight: 600; color: var(--dsf-text-2); }
.dsf-hint { font-size: 12px; color: var(--dsf-text-3); overflow-wrap: anywhere; }
.dsf-row { display: flex; gap: 12px; flex-wrap: wrap; }
.dsf-row > .dsf-field { flex: 1 1 120px; }
.dsf-input, .dsf-select {
  height: 38px; padding: 0 14px; border: 0; border-radius: 12px; background: var(--dsf-base); min-width: 0; width: 100%;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--dsf-text) 8%, transparent);
}
.dsf-input { font-family: var(--dsf-mono); font-size: 13px; }
.dsf-card .dsf-btn[data-primary="true"] { align-self: flex-start; }

.dsf-created { display: flex; flex-direction: column; gap: 8px; padding: 14px 16px; border-radius: 14px; background: color-mix(in srgb, var(--dsf-accent) 8%, var(--dsf-base)); }
.dsf-created-title { font-weight: 600; font-size: 13.5px; }
.dsf-created-url { display: flex; gap: 8px; align-items: center; }
.dsf-created-url .dsf-mono { flex: 1; min-width: 0; padding: 8px 12px; border-radius: 10px; background: var(--dsf-base); user-select: all; }
.dsf-created-note { font-size: 12px; color: var(--dsf-text-3); }
.dsf-error { font-size: 13px; color: var(--dsf-bad); }

.dsf-section { display: flex; flex-direction: column; gap: 12px; }
.dsf-section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.dsf-section-title { margin: 0; font-size: 19px; font-weight: 600; }
.dsf-segmented { display: inline-flex; gap: 2px; padding: 3px; border-radius: 999px; background: var(--dsf-fill-2); }
.dsf-segment { height: 28px; padding: 0 14px; border: 0; border-radius: 999px; background: transparent; cursor: pointer; font-size: 13px; color: var(--dsf-text-2); }
.dsf-segment[data-on="true"] { background: var(--dsf-base); color: var(--dsf-accent); font-weight: 600; box-shadow: 0 1px 3px color-mix(in srgb, var(--dsf-text) 10%, transparent); }

.dsf-list { display: flex; flex-direction: column; border-radius: 18px; background: var(--dsf-fill); overflow: hidden; }
.dsf-item { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 4px 14px; align-items: center; padding: 14px 18px; }
.dsf-item + .dsf-item { box-shadow: inset 0 1px 0 color-mix(in srgb, var(--dsf-text) 6%, transparent); }
.dsf-kind { font-size: 11.5px; font-weight: 600; padding: 2px 9px; border-radius: 999px; background: var(--dsf-fill-2); color: var(--dsf-text-2); }
.dsf-kind[data-kind="upload"] { background: color-mix(in srgb, var(--dsf-accent) 12%, transparent); color: var(--dsf-accent); }
.dsf-item-main { display: flex; flex-direction: column; min-width: 0; }
.dsf-item-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsf-item-meta { font-size: 12.5px; color: var(--dsf-text-3); display: flex; gap: 4px 12px; flex-wrap: wrap; }
.dsf-item-actions { display: flex; gap: 8px; align-items: center; }
.dsf-state { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--dsf-text-2); }
.dsf-state::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--dsf-tone, var(--dsf-idle)); }
.dsf-state[data-state="active"] { --dsf-tone: var(--dsf-ok); }
.dsf-state[data-state="revoked"] { --dsf-tone: var(--dsf-bad); }
.dsf-files { grid-column: 2 / -1; display: flex; flex-direction: column; gap: 2px; font-size: 12.5px; color: var(--dsf-text-2); }
.dsf-empty { padding: 28px; text-align: center; color: var(--dsf-text-3); border-radius: 18px; background: var(--dsf-fill); }
.dsf-roots { display: flex; flex-direction: column; gap: 4px; }

@container (max-width: 760px) {
  .dsf-col { padding: 0 16px 40px; gap: 18px; }
  .dsf-head { padding-top: 24px; }
  .dsf-cards { grid-template-columns: minmax(0, 1fr); }
  .dsf-card { padding: 18px; }
  .dsf-item { grid-template-columns: minmax(0, 1fr) auto; }
  .dsf-kind { grid-column: 1 / -1; justify-self: start; }
  .dsf-files { grid-column: 1 / -1; }
}
`;
function installStyles() {
  if (typeof document === "undefined") return;
  const selector = `style[data-plugin-css=${JSON.stringify(STYLE_KEY)}]`;
  if (document.querySelector(selector) !== null) return;
  const tag = document.createElement("style");
  tag.dataset["plugin"] = "dsh-client-ui-fileshare";
  tag.dataset["pluginCss"] = STYLE_KEY;
  tag.textContent = FILESHARE_CSS;
  document.head.appendChild(tag);
}

// src/client/index.ts
var PANEL_ID = "fileshare/page";
var inject = ["slots", "locale"];
function apply(ctx) {
  installStyles();
  ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), "client-ui-fileshare: dictionaries");
  const t = ctx.locale.bind(NS);
  ctx.slots.inject("main", () => ctx.slots.register({
    name: "main",
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ t })
  }, FilesharePage));
  ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
    name: "sidebar.panellist",
    id: PANEL_ID,
    order: -24,
    locale: NS,
    label: () => t("page.nav")
  }, FileshareIcon));
  if (typeof window !== "undefined") {
    window.setTimeout(() => {
      hello().catch(() => void 0);
    }, 1500);
  }
}

return module.exports}});
