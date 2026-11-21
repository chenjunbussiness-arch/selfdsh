window.__ModuleLoader__.load({id:"dsh-client-ui-vpn",factory:require=>{var module={exports:{}};var exports=module.exports;Object.defineProperty(exports,Symbol.toStringTag,{value:"Module"});
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

// src/client/controller.ts
function intervalFor(snapshot) {
  if (snapshot === void 0) return 3e3;
  if (snapshot.status.status === "connecting") return 1200;
  if (snapshot.status.status === "connected") return 4e3;
  return 8e3;
}
var VpnController = class {
  constructor(source) {
    this.source = source;
  }
  state = { loading: true, busy: false };
  listeners = /* @__PURE__ */ new Set();
  timer;
  unsubscribe;
  disposed = false;
  generation = 0;
  getSnapshot = () => this.state;
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  set(next) {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }
  /** Read once and schedule the next read. */
  async load() {
    const generation = ++this.generation;
    try {
      const snapshot = await this.source.read();
      if (this.disposed || generation !== this.generation) return;
      this.state = { ...this.state, snapshot, loading: false, busy: this.state.busy };
      delete this.state.error;
      for (const listener of this.listeners) listener();
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
    this.schedule();
  }
  schedule() {
    if (this.disposed) return;
    if (this.timer !== void 0) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.load();
    }, intervalFor(this.state.snapshot));
  }
  /** Start reading and listening to the source. */
  start() {
    this.disposed = false;
    this.unsubscribe = this.source.subscribe(() => {
      void this.load();
    });
    void this.load();
  }
  /** Stop timers and listeners. */
  dispose() {
    this.disposed = true;
    if (this.timer !== void 0) clearTimeout(this.timer);
    this.unsubscribe?.();
  }
  async act(run) {
    this.set({ busy: true });
    try {
      await run();
      await this.load();
      return void 0;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally {
      this.set({ busy: false });
    }
  }
  save(input) {
    return this.act(() => this.source.save(input));
  }
  remove(id) {
    return this.act(() => this.source.remove(id));
  }
  connect(id) {
    return this.act(() => this.source.connect(id));
  }
  disconnect() {
    return this.act(() => this.source.disconnect());
  }
};

// src/client/locales.ts
var NS = "vpn.page";
var zh = {
  "page.title": "VPN",
  "page.subtitle": "\u8FDE\u5185\u7F51 git \u7528\u7684\u96A7\u9053\u3002\u53EA\u6709\u4F60\u5217\u51FA\u7684\u7F51\u6BB5\u548C\u4E3B\u673A\u8D70 VPN\uFF0C\u9ED8\u8BA4\u8DEF\u7531\u4E0D\u4F1A\u88AB\u6539\u52A8\u3002",
  "badge.mock": "\u793A\u4F8B\u6570\u636E",
  "badge.mock.hint": "\u5BBF\u4E3B\u4FA7\u7684 VPN \u6865\u6CA1\u6709\u54CD\u5E94\uFF0C\u4E0B\u9762\u662F\u5185\u7F6E\u793A\u4F8B\u6570\u636E",
  "badge.stale": "\u5BBF\u4E3B\u6682\u65F6\u8BFB\u4E0D\u5230\uFF0C\u4EE5\u4E0B\u662F\u4E0A\u6B21\u7ED3\u679C",
  "load.error": "\u8BFB\u53D6\u5931\u8D25\uFF1A{message}",
  "load.loading": "\u6B63\u5728\u8BFB\u53D6\u2026",
  "state.disconnected": "\u672A\u8FDE\u63A5",
  "state.connecting": "\u8FDE\u63A5\u4E2D",
  "state.connected": "\u5DF2\u8FDE\u63A5",
  "state.failed": "\u8FDE\u63A5\u5931\u8D25",
  "state.disconnected.hint": "\u9009\u4E00\u4E2A\u914D\u7F6E\uFF0C\u70B9\u300C\u8FDE\u63A5\u300D\u3002",
  "state.connecting.hint": "\u6B63\u5728\u5EFA\u7ACB\u96A7\u9053\uFF0C\u901A\u5E38\u51E0\u79D2\u3002",
  "state.connected.hint": "\u53EA\u6709\u4E0B\u9762\u8FD9\u4E9B\u76EE\u6807\u8D70\u96A7\u9053\uFF0C\u5176\u4F59\u6D41\u91CF\u7167\u65E7\u3002",
  "state.failed.hint": "\u96A7\u9053\u5DF2\u88AB\u62C6\u9664\uFF0C\u7F51\u7EDC\u6CA1\u6709\u6539\u52A8\u3002",
  "stat.ip": "\u96A7\u9053 IP",
  "stat.iface": "\u63A5\u53E3",
  "stat.uptime": "\u5DF2\u8FDE\u63A5",
  "stat.pid": "\u8FDB\u7A0B",
  "stat.none": "\u2014",
  "routes.title": "\u8D70\u96A7\u9053\u7684\u76EE\u6807",
  "routes.none": "\u5C1A\u672A\u6DFB\u52A0\u8DEF\u7531",
  "watchdog.title": "\u770B\u95E8\u72D7",
  "watchdog.idle": "\u672A\u542F\u52A8",
  "watchdog.watching": "\u89C2\u5BDF\u4E2D\uFF0C\u8FD8\u5269 {seconds} \u79D2",
  "watchdog.passed": "\u5DF2\u901A\u8FC7\uFF1A\u9ED8\u8BA4\u8DEF\u7531\u672A\u53D8\uFF0C\u672C\u673A DSH \u4E0E\u516C\u7F51\u63A2\u6D4B\u53EF\u8FBE",
  "watchdog.tripped": "\u5DF2\u89E6\u53D1\u5E76\u65AD\u5F00\uFF1A{reason}",
  "action.connect": "\u8FDE\u63A5",
  "action.connect.profile": "\u8FDE\u63A5 {name}",
  "action.disconnect": "\u65AD\u5F00",
  "action.connecting": "\u8FDE\u63A5\u4E2D\u2026",
  "action.disconnecting": "\u65AD\u5F00\u4E2D\u2026",
  "action.edit": "\u7F16\u8F91",
  "action.new": "\u65B0\u5EFA\u914D\u7F6E",
  "action.save": "\u4FDD\u5B58",
  "action.saving": "\u4FDD\u5B58\u4E2D\u2026",
  "action.cancel": "\u53D6\u6D88",
  "action.delete": "\u5220\u9664",
  "action.delete.confirm": "\u518D\u70B9\u4E00\u6B21\u786E\u8BA4\u5220\u9664",
  "action.refresh": "\u5237\u65B0",
  "action.failed": "\u64CD\u4F5C\u5931\u8D25\uFF1A{message}",
  "install.missing.title": "\u670D\u52A1\u5668\u4E0A\u6CA1\u6709\u5B89\u88C5 openfortivpn",
  "install.missing.body": "\u8FDE\u63A5\u524D\u5148\u5728\u670D\u52A1\u5668\u4E0A\u6267\u884C\u4E0B\u9762\u7684\u547D\u4EE4\uFF08\u63D2\u4EF6\u4E0D\u4F1A\u66FF\u4F60\u5B89\u88C5\uFF09\uFF1A",
  "install.copy": "\u590D\u5236",
  "install.old": "openfortivpn {version} \u592A\u65E7\uFF0C\u4E0D\u652F\u6301 token \u94FE\u63A5\uFF08\u9700\u8981 1.18 \u53CA\u4EE5\u4E0A\uFF09\u3002",
  "install.pppd": "\u7F3A\u5C11 pppd\uFF1Aapt-get install -y ppp",
  "profiles.title": "\u914D\u7F6E",
  "profiles.empty": "\u8FD8\u6CA1\u6709\u914D\u7F6E\u3002\u65B0\u5EFA\u4E00\u4E2A\uFF0C\u586B\u597D\u7F51\u5173\u548C\u8981\u8D70\u96A7\u9053\u7684\u76EE\u6807\u3002",
  "profiles.targets": "{count} \u4E2A\u76EE\u6807",
  "profiles.secret.missing": "\u672A\u8BBE\u7F6E\u5BC6\u7801",
  "type.password": "\u8D26\u53F7\u5BC6\u7801",
  "type.token-url": "token \u94FE\u63A5",
  "type.custom": "\u81EA\u5B9A\u4E49\u547D\u4EE4",
  "form.title.new": "\u65B0\u5EFA\u914D\u7F6E",
  "form.title.edit": "\u7F16\u8F91\u914D\u7F6E",
  "form.name": "\u540D\u79F0",
  "form.type": "\u8BA4\u8BC1\u65B9\u5F0F",
  "form.host": "\u7F51\u5173\u5730\u5740",
  "form.port": "\u7AEF\u53E3",
  "form.username": "\u8D26\u53F7",
  "form.password": "\u5BC6\u7801",
  "form.password.set": "\u5DF2\u914D\u7F6E\uFF0C\u7559\u7A7A\u5219\u4FDD\u7559",
  "form.url": "token \u94FE\u63A5",
  "form.url.hint": "\u5F62\u5982 https://host:port/path?token=xxx\u3002\u6574\u6761\u94FE\u63A5\u90FD\u6309\u673A\u5BC6\u4FDD\u5B58\uFF0C\u4FDD\u5B58\u540E\u4E0D\u4F1A\u518D\u663E\u793A\u3002",
  "form.url.set": "\u5DF2\u914D\u7F6E\uFF0C\u7559\u7A7A\u5219\u4FDD\u7559",
  "form.realm": "Realm\uFF08\u53EF\u9009\uFF09",
  "form.cert": "\u53D7\u4FE1\u8BC1\u4E66\u6307\u7EB9 sha256\uFF08\u53EF\u9009\uFF09",
  "form.cert.hint": "\u7F51\u5173\u7528\u81EA\u7B7E\u8BC1\u4E66\u65F6\u586B\uFF1B\u8FDE\u63A5\u5931\u8D25\u7684\u65E5\u5FD7\u91CC\u4F1A\u7ED9\u51FA\u6307\u7EB9\u3002",
  "form.targets": "\u8D70\u96A7\u9053\u7684\u76EE\u6807",
  "form.targets.hint": "\u6BCF\u884C\u4E00\u4E2A\uFF1ACIDR\uFF0810.20.0.0/16\uFF09\u3001\u5355\u4E2A IP \u6216\u4E3B\u673A\u540D\u3002\u5FC5\u586B\u3002\u4E0D\u63A5\u53D7 0.0.0.0/0\u3001::/0 \u548C\u6BD4 /8 \u66F4\u5BBD\u7684\u7F51\u6BB5\u3002",
  "form.dns": "\u8BA9 VPN \u6539\u5199 /etc/resolv.conf\uFF08\u9ED8\u8BA4\u5173\u95ED\uFF0C\u5185\u7F51\u57DF\u540D\u5EFA\u8BAE\u76F4\u63A5\u5199 IP\uFF09",
  "form.command": "\u547D\u4EE4\uFF08\u6BCF\u884C\u4E00\u4E2A\u53C2\u6570\uFF0C\u7B2C\u4E00\u884C\u662F\u53EF\u6267\u884C\u6587\u4EF6\u7684\u7EDD\u5BF9\u8DEF\u5F84\uFF09",
  "form.command.hint": "{url} \u4F1A\u88AB\u66FF\u6362\u6210\u4E0B\u9762\u7684\u94FE\u63A5\u3002\u547D\u4EE4\u7531\u4F60\u81EA\u5DF1\u8D1F\u8D23\uFF0C\u63D2\u4EF6\u53EA\u7BA1\u8D77\u505C\u548C\u8131\u654F\u3002",
  "form.secret.write-only": "\u53EA\u5199\uFF1A\u4FDD\u5B58\u540E\u8F93\u5165\u6846\u4F1A\u6E05\u7A7A\uFF0C\u670D\u52A1\u5668\u4E0D\u4F1A\u56DE\u4F20\u3002",
  "form.error": "{message}",
  "logs.title": "\u65E5\u5FD7",
  "logs.empty": "\u8FD8\u6CA1\u6709\u65E5\u5FD7",
  "logs.hint": "\u6700\u8FD1 {count} \u884C\uFF0C\u5BC6\u7801\u3001token\u3001cookie \u5DF2\u66FF\u6362\u4E3A ***"
};
var en = {
  "page.title": "VPN",
  "page.subtitle": "The tunnel used to reach the internal git server. Only the targets you list go through the VPN; the default route is never changed.",
  "badge.mock": "Sample data",
  "badge.mock.hint": "The host VPN bridge did not answer; this is built-in sample data",
  "badge.stale": "The host cannot be read right now; showing the last result",
  "load.error": "Read failed: {message}",
  "load.loading": "Loading\u2026",
  "state.disconnected": "Disconnected",
  "state.connecting": "Connecting",
  "state.connected": "Connected",
  "state.failed": "Failed",
  "state.disconnected.hint": "Pick a profile and press Connect.",
  "state.connecting.hint": "Bringing the tunnel up, usually a few seconds.",
  "state.connected.hint": "Only the targets below use the tunnel; everything else is unchanged.",
  "state.failed.hint": "The tunnel was torn down; nothing on the network was changed.",
  "stat.ip": "Tunnel IP",
  "stat.iface": "Interface",
  "stat.uptime": "Uptime",
  "stat.pid": "Process",
  "stat.none": "\u2014",
  "routes.title": "Routed through the tunnel",
  "routes.none": "No routes yet",
  "watchdog.title": "Watchdog",
  "watchdog.idle": "Not running",
  "watchdog.watching": "Watching, {seconds}s left",
  "watchdog.passed": "Passed: default route unchanged, local DSH and the public probe are reachable",
  "watchdog.tripped": "Tripped and disconnected: {reason}",
  "action.connect": "Connect",
  "action.connect.profile": "Connect {name}",
  "action.disconnect": "Disconnect",
  "action.connecting": "Connecting\u2026",
  "action.disconnecting": "Disconnecting\u2026",
  "action.edit": "Edit",
  "action.new": "New profile",
  "action.save": "Save",
  "action.saving": "Saving\u2026",
  "action.cancel": "Cancel",
  "action.delete": "Delete",
  "action.delete.confirm": "Click again to delete",
  "action.refresh": "Refresh",
  "action.failed": "Failed: {message}",
  "install.missing.title": "openfortivpn is not installed on the server",
  "install.missing.body": "Run this on the server before connecting (the plugin does not install anything):",
  "install.copy": "Copy",
  "install.old": "openfortivpn {version} is too old for token URLs (1.18 or newer is required).",
  "install.pppd": "pppd is missing: apt-get install -y ppp",
  "profiles.title": "Profiles",
  "profiles.empty": "No profiles yet. Create one with the gateway and the targets that should use the tunnel.",
  "profiles.targets": "{count} targets",
  "profiles.secret.missing": "No password set",
  "type.password": "Password",
  "type.token-url": "Token URL",
  "type.custom": "Custom command",
  "form.title.new": "New profile",
  "form.title.edit": "Edit profile",
  "form.name": "Name",
  "form.type": "Authentication",
  "form.host": "Gateway host",
  "form.port": "Port",
  "form.username": "Username",
  "form.password": "Password",
  "form.password.set": "Configured; leave empty to keep",
  "form.url": "Token URL",
  "form.url.hint": "Like https://host:port/path?token=xxx. The whole URL is stored as a secret and is never shown again.",
  "form.url.set": "Configured; leave empty to keep",
  "form.realm": "Realm (optional)",
  "form.cert": "Trusted certificate sha256 (optional)",
  "form.cert.hint": "Needed for a self-signed gateway; a failed connection logs the digest to use.",
  "form.targets": "Targets through the tunnel",
  "form.targets.hint": "One per line: CIDR (10.20.0.0/16), a single IP or a host name. Required. 0.0.0.0/0, ::/0 and anything wider than /8 are refused.",
  "form.dns": "Let the VPN rewrite /etc/resolv.conf (off by default; prefer IP addresses for internal hosts)",
  "form.command": "Command (one argument per line; the first is an absolute path)",
  "form.command.hint": "{url} is replaced by the link below. You own what the command does; the plugin only starts, stops and redacts.",
  "form.secret.write-only": "Write-only: the field is cleared after saving and the server never sends it back.",
  "form.error": "{message}",
  "logs.title": "Log",
  "logs.empty": "No log lines yet",
  "logs.hint": "Last {count} lines; passwords, tokens and cookies are replaced by ***"
};
var DICTIONARIES = { zh, en };

// src/client/mock.ts
var MIN = 6e4;
function sampleProfiles(now) {
  const day = 24 * 60 * MIN;
  return [
    {
      id: "p-1a2b3c4d",
      name: "\u516C\u53F8\u5185\u7F51 git",
      type: "password",
      host: "vpn.corp.example",
      port: 443,
      username: "zhanglei",
      realm: "",
      trustedCert: "",
      targets: ["10.20.0.0/16", "git.corp.example"],
      setDns: false,
      command: [],
      secretConfigured: true,
      createdAt: new Date(now - 9 * day).toISOString(),
      updatedAt: new Date(now - 2 * day).toISOString()
    },
    {
      id: "p-5e6f7a8b",
      name: "\u8FD0\u7EF4\u7F51\u5173\uFF08token \u94FE\u63A5\uFF09",
      type: "token-url",
      host: "gw.ops.example",
      port: 10443,
      username: "",
      realm: "",
      trustedCert: "0000000000000000000000000000000000000000000000000000000000000000",
      targets: ["192.168.100.0/24", "10.30.0.15"],
      setDns: false,
      command: [],
      secretConfigured: true,
      createdAt: new Date(now - 5 * day).toISOString(),
      updatedAt: new Date(now - 5 * day).toISOString()
    },
    {
      id: "p-9c0d1e2f",
      name: "\u6D4B\u8BD5\u73AF\u5883\uFF08\u5F85\u914D\u7F6E\uFF09",
      type: "password",
      host: "vpn.lab.example",
      port: 8443,
      username: "ci-bot",
      realm: "lab",
      trustedCert: "",
      targets: ["198.18.0.0/20"],
      setDns: false,
      command: [],
      secretConfigured: false,
      createdAt: new Date(now - day).toISOString(),
      updatedAt: new Date(now - day).toISOString()
    }
  ];
}
function sampleLogs(now, state) {
  const at = (secondsAgo) => new Date(now - secondsAgo * 1e3).toISOString();
  const head = [
    { t: at(4300), level: "info", text: '\u8FDE\u63A5 "\u516C\u53F8\u5185\u7F51 git"\uFF08password\uFF09' },
    { t: at(4299), level: "out", text: "INFO:   Connected to gateway." },
    { t: at(4298), level: "out", text: "INFO:   Authenticated." },
    { t: at(4298), level: "out", text: "INFO:   Remote gateway has allocated a VPN." },
    { t: at(4297), level: "out", text: "INFO:   Interface ppp0 is UP." },
    { t: at(4297), level: "out", text: "INFO:   Got addresses: [10.8.0.6], ns [10.8.0.1]" },
    { t: at(4297), level: "out", text: "INFO:   Tunnel is up and running." }
  ];
  if (state === "connecting") return head.slice(0, 3).map((line, index) => ({ ...line, t: at(6 - index * 2) }));
  if (state === "failed") {
    return [
      { t: at(41), level: "info", text: '\u8FDE\u63A5 "\u516C\u53F8\u5185\u7F51 git"\uFF08password\uFF09' },
      { t: at(40), level: "out", text: "INFO:   Connected to gateway." },
      { t: at(39), level: "out", text: "ERROR:  Could not authenticate to gateway. Please check the username and password." },
      { t: at(39), level: "error", text: "\u5931\u8D25\uFF1Aauthentication failed: check the account, password and realm" }
    ];
  }
  if (state === "disconnected") return [];
  return [
    ...head,
    { t: at(4296), level: "info", text: "route added: 10.20.0.0/16 -> ppp0" },
    { t: at(4296), level: "info", text: "route added: 10.20.30.40/32 -> ppp0" },
    { t: at(4295), level: "info", text: "\u5DF2\u8FDE\u63A5\uFF1B\u52A0\u4E86 2 \u6761\u8DEF\u7531\uFF0C\u9ED8\u8BA4\u8DEF\u7531\u672A\u52A8" },
    { t: at(4265), level: "info", text: "\u770B\u95E8\u72D7\u901A\u8FC7\uFF0830s\uFF09" },
    { t: at(300), level: "out", text: "DEBUG:  password = ***" }
  ];
}
function createMockSource(scenario = "connected") {
  const now0 = Date.now();
  let profiles = sampleProfiles(now0);
  let state = scenario;
  let activeId = profiles[0]?.id;
  let connectedAt = now0 - 72 * MIN;
  let error = scenario === "failed" ? "authentication failed: check the account, password and realm" : void 0;
  const listeners = /* @__PURE__ */ new Set();
  let timer;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const status = () => {
    const profile = profiles.find((entry) => entry.id === activeId);
    const up = state === "connected";
    return {
      status: state,
      ...state === "disconnected" || profile === void 0 ? {} : { profileId: profile.id, profileName: profile.name },
      ...up ? { iface: "ppp0", ip: "10.8.0.6", connectedAt: new Date(connectedAt).toISOString(), uptimeSeconds: Math.round((Date.now() - connectedAt) / 1e3), pid: 31877 } : {},
      ...state === "connecting" ? { iface: "ppp0", pid: 31877 } : {},
      ...error === void 0 ? {} : { error },
      routes: up ? ["10.20.0.0/16", "10.20.30.40/32"] : [],
      watchdog: up ? { state: "passed" } : state === "failed" ? { state: "idle" } : { state: state === "connecting" ? "idle" : "idle" },
      install: { installed: true, version: "1.20.0", cookieSupport: true, pppd: true, hint: "" },
      allowCustom: false,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
  };
  return {
    origin: "mock",
    async read() {
      return { fetchedAt: (/* @__PURE__ */ new Date()).toISOString(), status: status(), profiles, logs: sampleLogs(Date.now(), state), origin: "mock" };
    },
    async save(input) {
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const existing = profiles.find((entry) => entry.id === input.id);
      const next = {
        id: existing?.id ?? `p-${Math.random().toString(16).slice(2, 10)}`,
        name: input.name,
        type: input.type,
        host: input.host ?? existing?.host ?? "",
        port: input.port ?? 443,
        username: input.username ?? "",
        realm: input.realm ?? "",
        trustedCert: input.trustedCert ?? "",
        targets: input.targets,
        setDns: input.setDns,
        command: input.command ?? [],
        secretConfigured: (input.secret ?? "") !== "" || existing?.secretConfigured === true,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      profiles = existing === void 0 ? [...profiles, next] : profiles.map((entry) => entry.id === next.id ? next : entry);
      notify();
      return next;
    },
    async remove(id) {
      profiles = profiles.filter((entry) => entry.id !== id);
      notify();
    },
    async connect(id) {
      activeId = id;
      state = "connecting";
      error = void 0;
      notify();
      timer = setTimeout(() => {
        state = "connected";
        connectedAt = Date.now();
        notify();
      }, 2500);
    },
    async disconnect() {
      if (timer !== void 0) clearTimeout(timer);
      state = "disconnected";
      error = void 0;
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

// src/client/source.ts
var BRIDGE_BASE = "/api/vpn";
function errorMessageOf(body) {
  if (typeof body !== "object" || body === null) return void 0;
  const error = body.error;
  if (typeof error !== "object" || error === null) return void 0;
  const message = error.message;
  return typeof message === "string" ? message : void 0;
}
async function requestJson(doFetch, url, init) {
  const response = await doFetch(url, { credentials: "same-origin", ...init });
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
    throw new Error(errorMessageOf(body) ?? (text.trim() === "" ? response.statusText : `HTTP ${String(response.status)}`));
  }
  return body;
}
function jsonBody(method, value) {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(value ?? {}) };
}
function asStatus(value) {
  if (typeof value !== "object" || value === null || typeof value.status !== "string") {
    throw new Error("GET /api/vpn/status returned a payload that is not a status document");
  }
  return value;
}
function createHttpSource(options = {}) {
  const base = options.base ?? BRIDGE_BASE;
  const doFetch = options.fetchImpl ?? (typeof fetch === "function" ? fetch : void 0);
  let live = false;
  const need = () => {
    if (doFetch === void 0) throw new Error("this environment has no fetch(); the VPN bridge is unreachable");
    return doFetch;
  };
  return {
    origin: "host",
    async read() {
      try {
        const f = need();
        const [status, profiles, logs] = await Promise.all([
          requestJson(f, `${base}/status`),
          requestJson(f, `${base}/profiles`),
          requestJson(f, `${base}/logs?limit=200`)
        ]);
        live = true;
        return {
          fetchedAt: (/* @__PURE__ */ new Date()).toISOString(),
          status: asStatus(status),
          profiles: profiles.profiles ?? [],
          logs: logs.lines ?? [],
          origin: "host"
        };
      } catch (error) {
        if (live || options.fallback === void 0) throw error;
        const sample = await options.fallback.read();
        return { ...sample, staleSince: (/* @__PURE__ */ new Date()).toISOString() };
      }
    },
    async save(input) {
      const body = await requestJson(need(), `${base}/profile`, jsonBody("PUT", input));
      return body.profile;
    },
    async remove(id) {
      await requestJson(need(), `${base}/profile?id=${encodeURIComponent(id)}`, { method: "DELETE", headers: { "content-type": "application/json" } });
    },
    async connect(id) {
      await requestJson(need(), `${base}/connect`, jsonBody("POST", { id }));
    },
    async disconnect() {
      await requestJson(need(), `${base}/disconnect`, jsonBody("POST", {}));
    },
    subscribe() {
      return () => {
      };
    }
  };
}
function resolveSource() {
  return createHttpSource({ fallback: createMockSource("connected") });
}

// src/client/styles.ts
var STYLE_KEY = "dsh-client-ui-vpn/VpnPage.css";
var VPN_CSS = `
.dshv-page {
  --dshv-accent: #4d6bfe;
  --dshv-accent-soft: color-mix(in srgb, var(--dshv-accent) 11%, transparent);
  --dshv-text: var(--dsw-alias-label-primary, #0f1115);
  --dshv-text-2: var(--dsw-alias-label-secondary, #61666b);
  --dshv-text-3: var(--dsw-alias-label-tertiary, #81858c);
  --dshv-line: var(--dsw-alias-border-l, #e1e5ee);
  --dshv-base: var(--dsw-alias-bg-base, #fff);
  --dshv-fill: var(--dsw-alias-bg-layer-1, #f9fafb);
  --dshv-fill-2: var(--dsw-alias-bg-layer-2, #f5f7fa);
  --dshv-hover: var(--dsw-alias-interactive-bg-hover, rgba(15, 17, 21, 0.05));
  --dshv-ok: var(--dsw-alias-state-success-primary, #22c55e);
  --dshv-warn: var(--dsw-alias-state-warn-primary, #f59e0b);
  --dshv-bad: var(--dsw-alias-state-error-primary, #ec1313);
  --dshv-idle: var(--dsw-alias-state-idle-primary, #d4d4d4);
  --dshv-mono: var(--dsh-mono, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace);
  display: grid;
  grid-template-columns: 272px minmax(0, 1fr);
  height: 100%;
  min-height: 0;
  background: var(--dshv-base);
  color: var(--dshv-text);
  font-family: var(--dsh-font, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif);
  font-size: 14px;
  line-height: 22px;
  container-type: inline-size;
  -webkit-font-smoothing: antialiased;
}
.dshv-page *, .dshv-page *::before, .dshv-page *::after { box-sizing: border-box; }
.dshv-page button, .dshv-page input, .dshv-page textarea { font: inherit; color: inherit; }
.dshv-page [data-tone="connected"] { --dshv-tone: var(--dshv-ok); }
.dshv-page [data-tone="connecting"] { --dshv-tone: var(--dshv-accent); }
.dshv-page [data-tone="failed"] { --dshv-tone: var(--dshv-bad); }
.dshv-page [data-tone="disconnected"] { --dshv-tone: var(--dshv-idle); }

/* ---------- left rail ---------- */
.dshv-rail { display: flex; flex-direction: column; min-height: 0; background: var(--dshv-fill); }
.dshv-rail-head { display: flex; align-items: center; justify-content: space-between; padding: 22px 16px 8px 22px; }
.dshv-rail-title { font-size: 12px; color: var(--dshv-text-3); font-weight: 500; }
.dshv-rail-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 0 10px 12px; display: flex; flex-direction: column; gap: 2px; }
.dshv-profile {
  display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 10px; border: 0; border-radius: 12px;
  background: transparent; text-align: left; cursor: pointer;
}
.dshv-profile:hover { background: var(--dshv-hover); }
.dshv-profile[data-on="true"] { background: var(--dshv-accent-soft); }
.dshv-profile:focus-visible { outline: 2px solid var(--dshv-accent); outline-offset: -2px; }
.dshv-profile-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dshv-tone, transparent); }
.dshv-profile-main { min-width: 0; flex: 1 1 auto; }
.dshv-profile-name { display: block; font-size: 13.5px; line-height: 20px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshv-profile[data-on="true"] .dshv-profile-name { color: var(--dshv-accent); font-weight: 600; }
.dshv-profile-sub { display: block; font-size: 12px; line-height: 17px; color: var(--dshv-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshv-profile-sub[data-warn="true"] { color: var(--dshv-warn); }
.dshv-rail-empty { padding: 10px 12px; font-size: 13px; color: var(--dshv-text-3); }
.dshv-rail-foot { padding: 6px 10px 16px; }
.dshv-new {
  display: flex; align-items: center; gap: 8px; width: 100%; height: 38px; padding: 0 10px; border: 0; border-radius: 12px;
  background: transparent; color: var(--dshv-accent); font-size: 13.5px; font-weight: 500; cursor: pointer;
}
.dshv-new:hover { background: var(--dshv-accent-soft); }

/* ---------- main column ---------- */
.dshv-main { min-width: 0; min-height: 0; overflow-y: auto; }
.dshv-col { width: 100%; max-width: 820px; margin: 0 auto; padding: 0 24px 48px; display: flex; flex-direction: column; gap: 20px; }
.dshv-head { padding-top: 36px; display: flex; flex-direction: column; gap: 4px; }
.dshv-head-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.dshv-title { margin: 0; font-size: 24px; line-height: 32px; font-weight: 600; letter-spacing: 0; }
.dshv-sub { margin: 0; font-size: 13px; color: var(--dshv-text-3); }
.dshv-badge {
  display: inline-flex; align-items: center; height: 22px; padding: 0 9px; border-radius: 999px;
  background: color-mix(in srgb, var(--dshv-warn) 16%, transparent); color: color-mix(in srgb, var(--dshv-warn) 80%, var(--dshv-text));
  font-size: 12px; font-weight: 500;
}
.dshv-note { margin: 0; font-size: 12.5px; color: var(--dshv-text-3); }

/* ---------- status card ---------- */
.dshv-card {
  --dshv-tone: var(--dshv-idle);
  display: flex; flex-direction: column; gap: 18px; padding: 24px 26px; border-radius: 24px;
  background: color-mix(in srgb, var(--dshv-tone) 7%, var(--dshv-fill));
}
.dshv-card-top { display: flex; align-items: center; gap: 18px; }
.dshv-orb {
  position: relative; flex: none; width: 52px; height: 52px; border-radius: 50%;
  background: color-mix(in srgb, var(--dshv-tone) 18%, transparent);
}
.dshv-orb::after {
  content: ""; position: absolute; inset: 15px; border-radius: 50%; background: var(--dshv-tone);
}
.dshv-card[data-tone="connecting"] .dshv-orb::before {
  content: ""; position: absolute; inset: 0; border-radius: 50%; border: 2px solid var(--dshv-tone); opacity: 0.5;
  animation: dshv-pulse 1.4s ease-out infinite;
}
@keyframes dshv-pulse { from { transform: scale(0.7); opacity: 0.7; } to { transform: scale(1.35); opacity: 0; } }
.dshv-card-text { min-width: 0; flex: 1 1 auto; }
.dshv-state { margin: 0; font-size: 28px; line-height: 36px; font-weight: 600; color: var(--dshv-text); }
.dshv-card[data-tone="connected"] .dshv-state { color: color-mix(in srgb, var(--dshv-ok) 70%, var(--dshv-text)); }
.dshv-card[data-tone="failed"] .dshv-state { color: var(--dshv-bad); }
.dshv-card-sub { margin: 0; font-size: 13.5px; color: var(--dshv-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshv-card-actions { flex: none; display: flex; align-items: center; gap: 8px; }

.dshv-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 38px; padding: 0 20px; border: 0; border-radius: 999px;
  background: var(--dshv-hover); font-size: 13.5px; font-weight: 500; cursor: pointer; white-space: nowrap;
  transition: background 0.15s, opacity 0.15s;
}
.dshv-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--dshv-text) 10%, transparent); }
.dshv-btn:focus-visible { outline: 2px solid var(--dshv-accent); outline-offset: 2px; }
.dshv-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.dshv-btn[data-kind="primary"] { background: var(--dshv-accent); color: #fff; }
.dshv-btn[data-kind="primary"]:hover:not(:disabled) { background: color-mix(in srgb, var(--dshv-accent) 88%, #000); }
.dshv-btn[data-kind="danger"] { background: color-mix(in srgb, var(--dshv-bad) 12%, transparent); color: var(--dshv-bad); }
.dshv-btn[data-kind="danger"]:hover:not(:disabled) { background: color-mix(in srgb, var(--dshv-bad) 20%, transparent); }
.dshv-btn[data-size="sm"] { height: 30px; padding: 0 14px; font-size: 12.5px; }

.dshv-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.dshv-stat { padding: 12px 14px; border-radius: 14px; background: var(--dshv-base); }
.dshv-stat-label { display: block; font-size: 12px; line-height: 16px; color: var(--dshv-text-3); }
.dshv-stat-value { display: block; margin-top: 2px; font-family: var(--dshv-mono); font-size: 14px; line-height: 22px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.dshv-block { display: flex; flex-direction: column; gap: 8px; }
.dshv-block-title { font-size: 12px; color: var(--dshv-text-3); font-weight: 500; }
.dshv-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.dshv-chip { display: inline-flex; align-items: center; height: 26px; padding: 0 10px; border-radius: 999px; background: var(--dshv-base); font-family: var(--dshv-mono); font-size: 12.5px; }
.dshv-chip[data-quiet="true"] { font-family: inherit; color: var(--dshv-text-3); }

.dshv-watch { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--dshv-text-2); }
.dshv-watch-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dshv-idle); }
.dshv-watch[data-state="watching"] .dshv-watch-dot { background: var(--dshv-accent); }
.dshv-watch[data-state="passed"] .dshv-watch-dot { background: var(--dshv-ok); }
.dshv-watch[data-state="tripped"] .dshv-watch-dot { background: var(--dshv-bad); }
.dshv-watch[data-state="tripped"] { color: var(--dshv-bad); }

.dshv-alert {
  display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border-radius: 14px;
  background: color-mix(in srgb, var(--dshv-bad) 9%, var(--dshv-base)); font-size: 13px; color: var(--dshv-text);
}
.dshv-alert[data-kind="warn"] { background: color-mix(in srgb, var(--dshv-warn) 12%, var(--dshv-base)); }
.dshv-alert-title { font-weight: 600; }
.dshv-alert pre { margin: 0; padding: 10px 12px; border-radius: 10px; background: var(--dshv-fill); font-family: var(--dshv-mono); font-size: 12px; line-height: 19px; white-space: pre-wrap; word-break: break-all; }
.dshv-alert-row { display: flex; align-items: flex-start; gap: 8px; }
.dshv-alert-row > pre { flex: 1 1 auto; }

/* ---------- form ---------- */
.dshv-form { display: flex; flex-direction: column; gap: 16px; padding: 24px 26px; border-radius: 24px; background: var(--dshv-base); box-shadow: 0 0 0 0.5px var(--dshv-line), 0 4px 18px rgba(15, 17, 21, 0.06); }
.dshv-form-title { margin: 0; font-size: 17px; line-height: 26px; font-weight: 600; }
.dshv-grid { display: grid; grid-template-columns: minmax(0, 1fr) 120px; gap: 14px; }
.dshv-grid[data-cols="2"] { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.dshv-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dshv-label { font-size: 12.5px; color: var(--dshv-text-2); font-weight: 500; }
.dshv-hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--dshv-text-3); }
.dshv-input {
  width: 100%; min-height: 40px; padding: 8px 12px; border: 0; border-radius: 12px; background: var(--dshv-fill);
  font-size: 14px; outline: none; transition: box-shadow 0.15s;
}
.dshv-input:focus { box-shadow: 0 0 0 1.5px var(--dshv-accent); }
.dshv-input::placeholder { color: var(--dshv-text-3); }
.dshv-input[data-mono="true"] { font-family: var(--dshv-mono); font-size: 13px; }
textarea.dshv-input { resize: vertical; line-height: 22px; min-height: 84px; }
.dshv-seg { display: inline-flex; padding: 3px; gap: 2px; border-radius: 999px; background: var(--dshv-fill); align-self: flex-start; }
.dshv-seg button { height: 30px; padding: 0 16px; border: 0; border-radius: 999px; background: transparent; font-size: 13px; color: var(--dshv-text-2); cursor: pointer; }
.dshv-seg button[aria-checked="true"] { background: var(--dshv-base); color: var(--dshv-accent); font-weight: 600; box-shadow: 0 1px 3px rgba(15, 17, 21, 0.12); }
.dshv-seg button:focus-visible { outline: 2px solid var(--dshv-accent); }
.dshv-check { display: flex; align-items: flex-start; gap: 10px; font-size: 13px; color: var(--dshv-text-2); cursor: pointer; }
.dshv-check input { margin-top: 4px; accent-color: var(--dshv-accent); }
.dshv-form-foot { display: flex; align-items: center; gap: 8px; padding-top: 4px; }
.dshv-form-foot .dshv-spacer { flex: 1 1 auto; }
.dshv-form-error { margin: 0; font-size: 13px; color: var(--dshv-bad); }

/* ---------- log ---------- */
.dshv-log { display: flex; flex-direction: column; gap: 8px; }
.dshv-log-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.dshv-log-body {
  max-height: 280px; min-height: 96px; overflow-y: auto; padding: 12px 14px; border-radius: 16px; background: var(--dshv-fill);
  font-family: var(--dshv-mono); font-size: 12px; line-height: 19px;
}
.dshv-log-line { display: flex; gap: 10px; white-space: pre-wrap; word-break: break-all; }
.dshv-log-time { flex: none; color: var(--dshv-text-3); }
.dshv-log-line[data-level="out"] { color: var(--dshv-text-2); }
.dshv-log-line[data-level="warn"] { color: var(--dshv-warn); }
.dshv-log-line[data-level="error"] { color: var(--dshv-bad); }
.dshv-log-empty { color: var(--dshv-text-3); font-family: inherit; font-size: 13px; }

@container (max-width: 760px) {
  .dshv-page { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
  .dshv-rail { max-height: 220px; }
  .dshv-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dshv-card-top { flex-wrap: wrap; }
  .dshv-grid, .dshv-grid[data-cols="2"] { grid-template-columns: minmax(0, 1fr); }
}
@media (prefers-reduced-motion: reduce) {
  .dshv-btn, .dshv-input { transition: none; }
  .dshv-card[data-tone="connecting"] .dshv-orb::before { animation: none; }
}
`;
function installStyles() {
  if (typeof document === "undefined") return;
  const selector = `style[data-plugin-css=${JSON.stringify(STYLE_KEY)}]`;
  if (document.querySelector(selector) !== null) return;
  const tag = document.createElement("style");
  tag.dataset["plugin"] = "dsh-client-ui-vpn";
  tag.dataset["pluginCss"] = STYLE_KEY;
  tag.textContent = VPN_CSS;
  document.head.appendChild(tag);
}

// src/client/VpnIcon.tsx
var import_jsx_runtime = require("react/jsx-runtime");
function VpnIcon({ size = 18, active = false }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { width: size, height: size, viewBox: "0 0 18 18", fill: "none", "aria-hidden": "true", style: { opacity: active ? 1 : 0.72 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M9 1.8 14.6 4v4.6c0 3.3-2.3 5.7-5.6 7.3C5.700 14.300 3.400 11.900 3.400 8.600V4z", stroke: "currentColor", strokeWidth: "1.4", strokeLinejoin: "round" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("circle", { cx: "9", cy: "7.700", r: "1.500", fill: "currentColor" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M9 9.200v2.400", stroke: "currentColor", strokeWidth: "1.400", strokeLinecap: "round" })
  ] });
}

// src/client/VpnPage.tsx
var import_react2 = require("react");

// src/client/format.ts
function formatUptime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor(total % 3600 / 60);
  const s = total % 60;
  const two = (value) => String(value).padStart(2, "0");
  return h > 0 ? `${String(h)}h ${two(m)}m ${two(s)}s` : m > 0 ? `${String(m)}m ${two(s)}s` : `${String(s)}s`;
}
function formatClock(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const two = (value) => String(value).padStart(2, "0");
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

// src/client/ProfileForm.tsx
var import_react = require("react");
var import_jsx_runtime2 = require("react/jsx-runtime");
function blankForm(type) {
  return { name: "", type, host: "", port: "443", username: "", realm: "", trustedCert: "", targets: "", setDns: false, command: "", secret: "", secretConfigured: false };
}
function formFrom(profile) {
  return {
    id: profile.id,
    name: profile.name,
    type: profile.type,
    host: profile.host,
    port: String(profile.port),
    username: profile.username,
    realm: profile.realm,
    trustedCert: profile.trustedCert,
    targets: profile.targets.join("\n"),
    setDns: profile.setDns,
    command: profile.command.join("\n"),
    secret: "",
    secretConfigured: profile.secretConfigured
  };
}
function toInput(form) {
  const lines = (text) => text.split(/\r?\n|,/).map((entry) => entry.trim()).filter((entry) => entry !== "");
  return {
    ...form.id === void 0 ? {} : { id: form.id },
    name: form.name.trim(),
    type: form.type,
    targets: lines(form.targets),
    setDns: form.setDns,
    ...form.type === "password" ? { host: form.host.trim(), port: Number(form.port), username: form.username.trim(), realm: form.realm.trim() } : {},
    ...form.type === "custom" ? { command: form.command.split(/\r?\n/).map((entry) => entry.trim()).filter((entry) => entry !== "") } : { trustedCert: form.trustedCert.trim() },
    ...form.type === "password" ? { trustedCert: form.trustedCert.trim() } : {},
    ...form.secret === "" ? {} : { secret: form.secret }
  };
}
function ProfileForm(props) {
  const { t } = props;
  const [form, setForm] = (0, import_react.useState)(props.initial);
  const [error, setError] = (0, import_react.useState)();
  const [confirmDelete, setConfirmDelete] = (0, import_react.useState)(false);
  const set = (patch) => {
    setForm((current) => ({ ...current, ...patch }));
  };
  const types = props.allowCustom ? ["password", "token-url", "custom"] : ["password", "token-url"];
  const editing = form.id !== void 0;
  const submit = async (event) => {
    event.preventDefault();
    setError(void 0);
    const message = await props.onSave(toInput(form));
    if (message === void 0) set({ secret: "" });
    else setError(message);
  };
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("form", { className: "dshv-form", onSubmit: (event) => {
    void submit(event);
  }, autoComplete: "off", "data-type": form.type, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h2", { className: "dshv-form-title", children: editing ? t("form.title.edit") : t("form.title.new") }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshv-field", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("label", { className: "dshv-label", htmlFor: "dshv-name", children: t("form.name") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("input", { id: "dshv-name", className: "dshv-input", value: form.name, maxLength: 64, onChange: (event) => {
        set({ name: event.target.value });
      } })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshv-field", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshv-label", id: "dshv-type-label", children: t("form.type") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dshv-seg", role: "radiogroup", "aria-labelledby": "dshv-type-label", children: types.map((type) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", role: "radio", "aria-checked": form.type === type, onClick: () => {
        set({ type });
      }, children: t(`type.${type}`) }, type)) })
    ] }),
    form.type === "password" && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshv-grid", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshv-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("label", { className: "dshv-label", htmlFor: "dshv-host", children: t("form.host") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("input", { id: "dshv-host", className: "dshv-input", "data-mono": "true", value: form.host, placeholder: "vpn.example.com", onChange: (event) => {
            set({ host: event.target.value });
          } })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshv-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("label", { className: "dshv-label", htmlFor: "dshv-port", children: t("form.port") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("input", { id: "dshv-port", className: "dshv-input", "data-mono": "true", inputMode: "numeric", value: form.port, onChange: (event) => {
            set({ port: event.target.value });
          } })
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshv-grid", "data-cols": "2", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshv-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("label", { className: "dshv-label", htmlFor: "dshv-user", children: t("form.username") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("input", { id: "dshv-user", className: "dshv-input", autoComplete: "off", value: form.username, onChange: (event) => {
            set({ username: event.target.value });
          } })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshv-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("label", { className: "dshv-label", htmlFor: "dshv-pass", children: t("form.password") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            "input",
            {
              id: "dshv-pass",
              className: "dshv-input",
              type: "password",
              autoComplete: "new-password",
              value: form.secret,
              placeholder: form.secretConfigured ? t("form.password.set") : "",
              onChange: (event) => {
                set({ secret: event.target.value });
              }
            }
          )
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshv-grid", "data-cols": "2", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshv-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("label", { className: "dshv-label", htmlFor: "dshv-realm", children: t("form.realm") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("input", { id: "dshv-realm", className: "dshv-input", value: form.realm, onChange: (event) => {
            set({ realm: event.target.value });
          } })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshv-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("label", { className: "dshv-label", htmlFor: "dshv-cert", children: t("form.cert") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("input", { id: "dshv-cert", className: "dshv-input", "data-mono": "true", value: form.trustedCert, placeholder: "a1b2c3d4e5f6\u2026", onChange: (event) => {
            set({ trustedCert: event.target.value });
          } })
        ] })
      ] })
    ] }),
    form.type === "token-url" && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshv-field", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("label", { className: "dshv-label", htmlFor: "dshv-url", children: t("form.url") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "input",
          {
            id: "dshv-url",
            className: "dshv-input",
            "data-mono": "true",
            type: "password",
            autoComplete: "new-password",
            value: form.secret,
            placeholder: form.secretConfigured ? t("form.url.set") : "https://host:port/path?token=\u2026",
            onChange: (event) => {
              set({ secret: event.target.value });
            }
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dshv-hint", children: t("form.url.hint") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshv-field", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("label", { className: "dshv-label", htmlFor: "dshv-cert2", children: t("form.cert") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("input", { id: "dshv-cert2", className: "dshv-input", "data-mono": "true", value: form.trustedCert, onChange: (event) => {
          set({ trustedCert: event.target.value });
        } }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dshv-hint", children: t("form.cert.hint") })
      ] })
    ] }),
    form.type === "custom" && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshv-field", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("label", { className: "dshv-label", htmlFor: "dshv-cmd", children: t("form.command") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("textarea", { id: "dshv-cmd", className: "dshv-input", "data-mono": "true", value: form.command, onChange: (event) => {
          set({ command: event.target.value });
        } }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dshv-hint", children: t("form.command.hint") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshv-field", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("label", { className: "dshv-label", htmlFor: "dshv-url2", children: t("form.url") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("input", { id: "dshv-url2", className: "dshv-input", "data-mono": "true", type: "password", autoComplete: "new-password", value: form.secret, placeholder: form.secretConfigured ? t("form.url.set") : "", onChange: (event) => {
          set({ secret: event.target.value });
        } })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshv-field", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("label", { className: "dshv-label", htmlFor: "dshv-targets", children: t("form.targets") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("textarea", { id: "dshv-targets", className: "dshv-input", "data-mono": "true", value: form.targets, placeholder: "10.20.0.0/16\ngit.corp.example", onChange: (event) => {
        set({ targets: event.target.value });
      } }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dshv-hint", children: t("form.targets.hint") })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { className: "dshv-check", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("input", { type: "checkbox", checked: form.setDns, onChange: (event) => {
        set({ setDns: event.target.checked });
      } }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: t("form.dns") })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dshv-hint", children: t("form.secret.write-only") }),
    error !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dshv-form-error", role: "alert", children: t("form.error", { message: error }) }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshv-form-foot", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "submit", className: "dshv-btn", "data-kind": "primary", disabled: props.busy, children: props.busy ? t("action.saving") : t("action.save") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dshv-btn", onClick: props.onCancel, children: t("action.cancel") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshv-spacer" }),
      props.onDelete !== void 0 && editing && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "button",
        {
          type: "button",
          className: "dshv-btn",
          "data-kind": "danger",
          disabled: props.busy,
          onClick: () => {
            if (!confirmDelete) {
              setConfirmDelete(true);
              return;
            }
            void props.onDelete?.().then((message) => {
              if (message !== void 0) setError(message);
            });
          },
          children: confirmDelete ? t("action.delete.confirm") : t("action.delete")
        }
      )
    ] })
  ] });
}

// src/client/VpnPage.tsx
var import_jsx_runtime3 = require("react/jsx-runtime");
function useUptime(status) {
  const [now, setNow] = (0, import_react2.useState)(() => Date.now());
  const live = status?.status === "connected";
  (0, import_react2.useEffect)(() => {
    if (!live) return void 0;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1e3);
    return () => {
      clearInterval(timer);
    };
  }, [live]);
  if (!live || status?.connectedAt === void 0) return status?.uptimeSeconds;
  const since = Date.parse(status.connectedAt);
  return Number.isFinite(since) ? Math.max(0, Math.round((now - since) / 1e3)) : status.uptimeSeconds;
}
function VpnPage({ controller, t, initialEdit }) {
  const state = (0, import_react2.useSyncExternalStore)(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const snapshot = state.snapshot;
  const status = snapshot?.status;
  const profiles = snapshot?.profiles ?? [];
  const [selectedId, setSelectedId] = (0, import_react2.useState)(void 0);
  const [editing, setEditing] = (0, import_react2.useState)(void 0);
  const [actionError, setActionError] = (0, import_react2.useState)();
  const seeded = (0, import_react2.useRef)(false);
  (0, import_react2.useEffect)(() => {
    controller.start();
    return () => {
      controller.dispose();
    };
  }, [controller]);
  (0, import_react2.useEffect)(() => {
    if (snapshot === void 0) return;
    if (selectedId === void 0 || !profiles.some((profile) => profile.id === selectedId)) {
      setSelectedId(snapshot.status.profileId ?? profiles[0]?.id);
    }
    if (!seeded.current && initialEdit !== void 0) {
      seeded.current = true;
      if (initialEdit.mode === "new") setEditing(blankForm(initialEdit.type));
      else {
        const target = profiles.find((profile) => profile.id === initialEdit.id);
        if (target !== void 0) setEditing(formFrom(target));
      }
    }
  }, [snapshot, profiles, selectedId, initialEdit]);
  const selected = (0, import_react2.useMemo)(() => profiles.find((profile) => profile.id === selectedId), [profiles, selectedId]);
  const uptime = useUptime(status);
  const current = status?.status ?? "disconnected";
  const running = current === "connecting" || current === "connected";
  const install = status?.install;
  const blockedByInstall = selected !== void 0 && selected.type !== "custom" && install !== void 0 && (!install.installed || selected.type === "token-url" && !install.cookieSupport);
  const run = async (action) => {
    setActionError(void 0);
    const message = await action();
    if (message !== void 0) setActionError(message);
  };
  const logRef = (0, import_react2.useRef)(null);
  const lastLog = snapshot?.logs[snapshot.logs.length - 1]?.t;
  (0, import_react2.useEffect)(() => {
    const element = logRef.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [lastLog]);
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dshv-page", children: [
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("aside", { className: "dshv-rail", "aria-label": t("profiles.title"), children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: "dshv-rail-head", children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dshv-rail-title", children: t("profiles.title") }) }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dshv-rail-scroll", children: [
        profiles.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "dshv-rail-empty", children: t("profiles.empty") }),
        profiles.map((profile) => {
          const isActive = status?.profileId === profile.id && current !== "disconnected";
          return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
            "button",
            {
              type: "button",
              className: "dshv-profile",
              "data-on": profile.id === selectedId,
              "data-tone": isActive ? current : void 0,
              onClick: () => {
                setSelectedId(profile.id);
                setEditing(void 0);
              },
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dshv-profile-dot", "aria-hidden": "true" }),
                /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { className: "dshv-profile-main", children: [
                  /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dshv-profile-name", children: profile.name }),
                  /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dshv-profile-sub", "data-warn": !profile.secretConfigured && profile.type !== "custom", children: !profile.secretConfigured && profile.type !== "custom" ? t("profiles.secret.missing") : `${t(`type.${profile.type}`)} \xB7 ${t("profiles.targets", { count: profile.targets.length })}` })
                ] })
              ]
            },
            profile.id
          );
        })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: "dshv-rail-foot", children: /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("button", { type: "button", className: "dshv-new", onClick: () => {
        setEditing(blankForm("password"));
      }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { "aria-hidden": "true", children: "\uFF0B" }),
        t("action.new")
      ] }) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("main", { className: "dshv-main", children: /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dshv-col", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("header", { className: "dshv-head", children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dshv-head-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("h1", { className: "dshv-title", children: t("page.title") }),
          snapshot?.origin === "mock" && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dshv-badge", title: t("badge.mock.hint"), children: t("badge.mock") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "dshv-sub", children: t("page.subtitle") }),
        snapshot?.staleSince !== void 0 && snapshot.origin === "mock" && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "dshv-note", children: t("badge.mock.hint") }),
        state.error !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "dshv-form-error", role: "alert", children: t("load.error", { message: state.error }) })
      ] }),
      status === void 0 && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "dshv-note", children: t("load.loading") }),
      status !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("section", { className: "dshv-card", "data-tone": current, "aria-live": "polite", children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dshv-card-top", children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dshv-orb", "aria-hidden": "true" }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dshv-card-text", children: [
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "dshv-state", children: t(`state.${current}`) }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("p", { className: "dshv-card-sub", children: [
              running || current === "failed" ? status.profileName ?? selected?.name ?? "" : selected?.name ?? t(`state.${current}.hint`),
              (running || current === "failed") && ` \xB7 ${t(`state.${current}.hint`)}`
            ] })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dshv-card-actions", children: [
            selected !== void 0 && !running && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "dshv-btn", onClick: () => {
              setEditing(formFrom(selected));
            }, children: t("action.edit") }),
            running ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "dshv-btn", "data-kind": "danger", disabled: state.busy, onClick: () => {
              void run(() => controller.disconnect());
            }, children: current === "connecting" ? t("action.disconnect") : t("action.disconnect") }) : /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
              "button",
              {
                type: "button",
                className: "dshv-btn",
                "data-kind": "primary",
                disabled: state.busy || selected === void 0 || !selected.secretConfigured && selected.type !== "custom" || blockedByInstall,
                onClick: () => {
                  if (selected !== void 0) void run(() => controller.connect(selected.id));
                },
                children: selected === void 0 ? t("action.connect") : t("action.connect.profile", { name: selected.name })
              }
            )
          ] })
        ] }),
        actionError !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "dshv-form-error", role: "alert", children: t("action.failed", { message: actionError }) }),
        current === "failed" && status.error !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: "dshv-alert", role: "alert", children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dshv-alert-title", children: status.error }) }),
        install !== void 0 && !install.installed && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dshv-alert", "data-kind": "warn", children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dshv-alert-title", children: t("install.missing.title") }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { children: t("install.missing.body") }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dshv-alert-row", children: [
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("pre", { children: install.hint }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "dshv-btn", "data-size": "sm", onClick: () => {
              void navigator.clipboard?.writeText(install.hint);
            }, children: t("install.copy") })
          ] })
        ] }),
        install?.installed === true && !install.cookieSupport && selected?.type === "token-url" && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: "dshv-alert", "data-kind": "warn", children: t("install.old", { version: install.version }) }),
        install?.installed === true && !install.pppd && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: "dshv-alert", "data-kind": "warn", children: t("install.pppd") }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dshv-stats", children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dshv-stat", children: [
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dshv-stat-label", children: t("stat.ip") }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dshv-stat-value", children: status.ip ?? t("stat.none") })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dshv-stat", children: [
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dshv-stat-label", children: t("stat.iface") }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dshv-stat-value", children: status.iface ?? t("stat.none") })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dshv-stat", children: [
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dshv-stat-label", children: t("stat.uptime") }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dshv-stat-value", children: uptime === void 0 ? t("stat.none") : formatUptime(uptime) })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dshv-stat", children: [
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dshv-stat-label", children: t("stat.pid") }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dshv-stat-value", children: status.pid === void 0 ? t("stat.none") : String(status.pid) })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dshv-block", children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dshv-block-title", children: t("routes.title") }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: "dshv-chips", children: status.routes.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dshv-chip", "data-quiet": "true", children: t("routes.none") }) : status.routes.map((route) => /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dshv-chip", children: route }, route)) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dshv-watch", "data-state": status.watchdog.state, children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dshv-watch-dot", "aria-hidden": "true" }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("b", { children: t("watchdog.title") }),
            " \xB7 ",
            status.watchdog.state === "watching" ? t("watchdog.watching", { seconds: status.watchdog.secondsLeft ?? 0 }) : status.watchdog.state === "tripped" ? t("watchdog.tripped", { reason: status.watchdog.reason ?? "" }) : t(`watchdog.${status.watchdog.state}`)
          ] })
        ] })
      ] }),
      editing !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
        ProfileForm,
        {
          t,
          initial: editing,
          allowCustom: status?.allowCustom === true,
          busy: state.busy,
          onCancel: () => {
            setEditing(void 0);
          },
          onSave: async (input) => {
            const message = await controller.save(input);
            if (message === void 0) setEditing(void 0);
            return message;
          },
          ...editing.id === void 0 ? {} : {
            onDelete: async () => {
              const message = await controller.remove(editing.id ?? "");
              if (message === void 0) {
                setEditing(void 0);
                setSelectedId(void 0);
              }
              return message;
            }
          }
        },
        editing.id ?? `new-${editing.type}`
      ),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("section", { className: "dshv-log", children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dshv-log-head", children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dshv-block-title", children: t("logs.title") }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dshv-hint", children: t("logs.hint", { count: 200 }) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: "dshv-log-body", ref: logRef, role: "log", "aria-live": "off", children: (snapshot?.logs.length ?? 0) === 0 ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dshv-log-empty", children: t("logs.empty") }) : snapshot?.logs.map((line, index) => /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dshv-log-line", "data-level": line.level, children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dshv-log-time", children: formatClock(line.t) }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { children: line.text })
        ] }, `${line.t}-${String(index)}`)) })
      ] })
    ] }) })
  ] });
}

// src/client/index.ts
var PANEL_ID = "vpn/page";
var inject = ["slots", "locale"];
function apply(ctx) {
  installStyles();
  ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), "client-ui-vpn: dictionaries");
  const t = ctx.locale.bind(NS);
  const controller = new VpnController(resolveSource());
  ctx.slots.inject("main", () => ctx.slots.register({
    name: "main",
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ controller, t })
  }, VpnPage));
  ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
    name: "sidebar.panellist",
    id: PANEL_ID,
    order: -30,
    locale: NS,
    label: () => t("page.title")
  }, VpnIcon));
}

return module.exports}});
