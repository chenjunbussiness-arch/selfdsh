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
  "page.title": "\u5BC6\u94A5\u4E0E\u63D2\u4EF6",
  "page.nav": "\u5BC6\u94A5",
  "page.subtitle": "\u7BA1\u7406\u672C\u673A\u4FDD\u9669\u5E93\u3001DSH \u51ED\u636E\u548C\u63D2\u4EF6\u9700\u8981\u7684\u914D\u7F6E\u3002\u503C\u53EA\u80FD\u5199\u5165\uFF0C\u4E0D\u80FD\u8BFB\u51FA\u3002",
  "notice.title": "\u53EA\u5199\u4E0D\u8BFB",
  "notice.body": "\u5728\u8FD9\u91CC\u53EF\u4EE5\u65B0\u5EFA\u3001\u66F4\u6362\u548C\u5220\u9664\u5BC6\u94A5\uFF0C\u4F46\u4EFB\u4F55\u63A5\u53E3\u90FD\u4E0D\u4F1A\u8FD4\u56DE\u660E\u6587\u3002\u4FDD\u9669\u5E93\u91CC\u7684\u5BC6\u94A5\u53EA\u80FD\u901A\u8FC7 secret_* \u5DE5\u5177\u4F7F\u7528\uFF1Asecret_exec \u6CE8\u5165\u73AF\u5883\u53D8\u91CF\uFF0Csecret_http \u5728\u8BF7\u6C42\u91CC\u7528 {placeholder} \u5360\u4F4D\u7B26\u3002",
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
  "empty.missing.hint": "\u70B9\u300C\u65B0\u5EFA\u5BC6\u94A5\u300D\u5B58\u5165\u7B2C\u4E00\u4E2A\uFF0C\u4FDD\u9669\u5E93\u4F1A\u81EA\u52A8\u521B\u5EFA\u3002\u4E5F\u53EF\u4EE5\u7528 ingest-file.mjs \u6279\u91CF\u5BFC\u5165\u3002",
  "empty.vault.title": "\u4FDD\u9669\u5E93\u662F\u7A7A\u7684",
  "empty.vault.hint": "\u70B9\u300C\u65B0\u5EFA\u5BC6\u94A5\u300D\u5B58\u5165\u7B2C\u4E00\u4E2A\uFF08\u5EFA\u8BAE\u540C\u65F6\u5199\u63CF\u8FF0\u548C\u6807\u7B7E\uFF09\u3002",
  "empty.filter.title": "\u6CA1\u6709\u5339\u914D\u7684\u5BC6\u94A5",
  "empty.filter.hint": "\u6362\u4E2A\u5173\u952E\u5B57\u6216\u6807\u7B7E\u8BD5\u8BD5\u3002\u6CE8\u610F\uFF1A\u641C\u7D22\u53EA\u5339\u914D\u540D\u79F0\u548C\u63CF\u8FF0\uFF0C\u4E0D\u5339\u914D\u503C\u3002",
  "error.title": "\u8BFB\u4E0D\u5230\u5BC6\u94A5\u770B\u677F\u6570\u636E",
  "error.hint": "\u5BBF\u4E3B\u4FA7\u7684\u63A5\u53E3 /api/secrets/* \u6CA1\u6709\u6B63\u5E38\u54CD\u5E94\u3002\u9875\u9762\u5176\u4F59\u90E8\u5206\u4E0D\u53D7\u5F71\u54CD\u3002",
  "error.unauthorized": "\u767B\u5F55\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55\u540E\u518D\u8BD5\u3002",
  "error.unavailable": "\u767B\u5F55\u670D\u52A1\u6682\u4E0D\u53EF\u7528\uFF0C\u6216 dsh-host-secrets \u6CA1\u6709\u6302\u8F7D\u770B\u677F\u63A5\u53E3\u3002",
  "retry": "\u91CD\u8BD5",
  "tab.vault": "\u4FDD\u9669\u5E93",
  "tab.credentials": "DSH \u51ED\u636E",
  "tab.plugins": "\u63D2\u4EF6",
  "tab.aria": "\u5207\u6362\u89C6\u56FE",
  "col.actions": "\u64CD\u4F5C",
  "action.new": "\u65B0\u5EFA\u5BC6\u94A5",
  "action.replace": "\u6362\u503C",
  "action.edit": "\u7F16\u8F91",
  "action.rename": "\u6539\u540D",
  "action.delete": "\u5220\u9664",
  "action.set": "\u8BBE\u7F6E",
  "action.change": "\u66F4\u6362",
  "action.clear": "\u6E05\u9664",
  "action.cancel": "\u53D6\u6D88",
  "action.save": "\u4FDD\u5B58",
  "action.saving": "\u4FDD\u5B58\u4E2D\u2026",
  "action.show": "\u663E\u793A",
  "action.hide": "\u9690\u85CF",
  "action.close": "\u5173\u95ED",
  "field.name": "\u540D\u79F0",
  "field.name.hint": "\u5B57\u6BCD\u3001\u6570\u5B57\u3001\u4E0B\u5212\u7EBF\u3001\u70B9\u3001\u51CF\u53F7\uFF0C\u4EE5\u5B57\u6BCD\u6216\u4E0B\u5212\u7EBF\u5F00\u5934",
  "field.value": "\u503C",
  "field.value.hint": "\u4FDD\u5B58\u540E\u65E0\u6CD5\u518D\u67E5\u770B\uFF0C\u53EA\u80FD\u66F4\u6362",
  "field.value.keep": "\u7559\u7A7A\u8868\u793A\u4E0D\u6539\u503C",
  "field.description": "\u63CF\u8FF0",
  "field.tags": "\u6807\u7B7E",
  "field.tags.hint": "\u7528\u7A7A\u683C\u6216\u9017\u53F7\u5206\u9694",
  "field.to": "\u65B0\u540D\u79F0",
  "field.overwrite": "\u540C\u540D\u5DF2\u5B58\u5728\u65F6\u8986\u76D6",
  "sheet.create": "\u65B0\u5EFA\u5BC6\u94A5",
  "sheet.replace": "\u66F4\u6362 {name} \u7684\u503C",
  "sheet.edit": "\u7F16\u8F91 {name}",
  "sheet.rename": "\u7ED9 {name} \u6539\u540D",
  "sheet.delete": "\u5220\u9664 {name}\uFF1F",
  "sheet.delete.body": "\u5220\u9664\u540E\u65E0\u6CD5\u6062\u590D\u3002\u7528\u5230\u5B83\u7684 secret_exec / secret_http \u8C03\u7528\u4F1A\u5931\u8D25\u3002",
  "sheet.credential": "\u8BBE\u7F6E {name}",
  "sheet.credential.clear": "\u6E05\u9664 {name}\uFF1F",
  "sheet.credential.clear.body": "\u6E05\u9664\u7684\u662F DSH \u51ED\u636E\u5E93\u91CC\u4FDD\u5B58\u7684\u503C\uFF1B\u5982\u679C\u8FDB\u7A0B\u73AF\u5883\u53D8\u91CF\u91CC\u4E5F\u6709\uFF0C\u4ECD\u4F1A\u751F\u6548\u3002",
  "sheet.hub": "\u8BBE\u7F6E {name}",
  "done.saved": "\u5DF2\u4FDD\u5B58 {name}",
  "done.deleted": "\u5DF2\u5220\u9664 {name}",
  "done.renamed": "\u5DF2\u6539\u540D\u4E3A {name}",
  "done.cleared": "\u5DF2\u6E05\u9664 {name}",
  "error.save": "\u6CA1\u6709\u4FDD\u5B58\uFF1A{message}",
  "cred.title": "DSH \u51ED\u636E",
  "cred.sub": "\u5B58\u5728 DSH \u81EA\u5DF1\u7684\u51ED\u636E\u5E93\u91CC\uFF08<DSH home>/.credentials.yaml\uFF09\uFF0C\u6A21\u578B\u548C\u63D2\u4EF6\u6309\u540D\u79F0\u8BFB\u53D6\u3002\u4FEE\u6539\u7ACB\u5373\u751F\u6548\uFF0C\u4E0D\u7528\u91CD\u542F\u3002",
  "cred.unavailable": "\u8FD9\u4E2A DSH \u6CA1\u6709\u6302\u8F7D\u51ED\u636E\u5E93\uFF0C\u53EA\u80FD\u5728\u542F\u52A8 DSH \u7684\u73AF\u5883\u91CC\u8BBE\u7F6E\u8FD9\u4E9B\u53D8\u91CF\u3002",
  "cred.usedBy": "\u7528\u4E8E {plugins}",
  "cred.status.set": "\u5DF2\u914D\u7F6E",
  "cred.status.unset": "\u672A\u914D\u7F6E",
  "cred.source.file": "\u51ED\u636E\u5E93",
  "cred.source.env": "\u8FDB\u7A0B\u73AF\u5883\u53D8\u91CF",
  "cred.source.user-env": "<DSH home>/.env",
  "cred.source.project-env": "\u5DE5\u4F5C\u76EE\u5F55 .env",
  "cred.source.unknown": "\u65E0\u6CD5\u786E\u8BA4",
  "cred.envWins": "\u5982\u679C\u542F\u52A8 DSH \u7684\u73AF\u5883\u91CC\u4E5F\u8BBE\u4E86\u540C\u540D\u53D8\u91CF\uFF0C\u90A3\u4E2A\u503C\u4F18\u5148\u3002",
  "cred.ref.DEEPSEEK_API_KEY": "DeepSeek \u6A21\u578B API key",
  "cred.ref.EXA_API_KEY": "Exa \u7F51\u9875\u641C\u7D22 API key",
  "cred.ref.GITHUB_TOKEN": "GitHub token\uFF1A\u5F00 PR\u3001\u67E5\u68C0\u67E5\u7ED3\u679C",
  "cred.ref.GITEA_TOKEN": "Gitea token\uFF1A\u5F00 PR\u3001\u67E5\u68C0\u67E5\u7ED3\u679C",
  "plugins.title": "\u63D2\u4EF6",
  "plugins.sub": "\u672C\u673A profile \u91CC\u7684 selfdsh \u63D2\u4EF6\uFF0C\u4EE5\u53CA\u6BCF\u4E2A\u63D2\u4EF6\u9700\u8981\u7684\u914D\u7F6E\u3002",
  "plugins.profile": "\u5F53\u524D profile\uFF1A{name}",
  "plugins.profiles": "profile\uFF1A{names}",
  "plugins.noProfile": "\u6CA1\u6709\u627E\u5230 profile",
  "plugins.installed": "\u5DF2\u5B89\u88C5",
  "plugins.notInstalled": "\u672A\u5B89\u88C5",
  "plugins.nothingNeeded": "\u4E0D\u9700\u8981\u5BC6\u94A5",
  "plugins.required": "\u5FC5\u9700",
  "plugins.optional": "\u53EF\u9009",
  "plugins.kind.credential": "DSH \u51ED\u636E",
  "plugins.kind.hub": "\u4E2D\u67A2\u8FDE\u63A5",
  "plugins.kind.vault-key": "\u4FDD\u9669\u5E93\u4E3B\u5BC6\u94A5",
  "plugins.vaultKey.hint": "\u5728\u542F\u52A8 DSH \u7684\u73AF\u5883\u91CC\uFF0C\u6216 <DSH home>/secrets.env \u91CC\u8BBE\u7F6E\u3002\u8FD9\u91CC\u4E0D\u80FD\u4FEE\u6539\uFF0C\u6539\u4E86\u4F1A\u6253\u4E0D\u5F00\u5DF2\u6709\u4FDD\u9669\u5E93\u3002",
  "plugins.ready": "\u5DF2\u5C31\u7EEA",
  "plugins.missing": "\u7F3A {count} \u9879",
  "plugin.dsh-router-b": "\u4F5C\u6218\u5BA4\u8DEF\u7531\uFF1A\u5206\u533A\u7ECF\u7406\u3001\u5DE5\u4EBA\u3001\u5FEB\u4EFB\u52A1",
  "plugin.dsh-agent-hub": "agent \u4E2D\u67A2\uFF1A\u6CE8\u518C\u3001\u62C9\u53D6\u4EFB\u52A1\u3001\u8C03\u5EA6\u5176\u4ED6 agent",
  "plugin.dsh-secrets": "\u672C\u673A\u52A0\u5BC6\u4FDD\u9669\u5E93",
  "plugin.dsh-egress": "\u51FA\u53E3\uFF1A\u65E0\u5934\u6D4F\u89C8\u5668\u63A7\u5236",
  "plugin.dsh-vpn": "VPN \u8FDE\u63A5\u7BA1\u7406",
  "plugin.dsh-token-stats": "token \u7528\u91CF\u7EDF\u8BA1",
  "hub.title": "\u4E2D\u67A2\u5730\u5740",
  "hub.sub": "\u5199\u5728 {file}\u3002\u670D\u52A1\u5668\u5730\u5740\u53D8\u4E86\u5728\u8FD9\u91CC\u6539\uFF0Cagent-hub \u4E0B\u6B21\u8BF7\u6C42\u5C31\u7528\u65B0\u5730\u5740\uFF0C\u4E0D\u7528\u91CD\u542F\u3002",
  "hub.shadowed": "\u8FDB\u7A0B\u73AF\u5883\u53D8\u91CF\u91CC\u4E5F\u8BBE\u4E86\uFF0C\u73AF\u5883\u53D8\u91CF\u4F18\u5148",
  "hub.notSet": "\u672A\u8BBE\u7F6E",
  "hub.hidden": "\u5DF2\u4FDD\u5B58\uFF08\u4E0D\u663E\u793A\uFF09",
  "hub.key.DSH_HUB_URL": "\u4E2D\u67A2 URL",
  "hub.key.DSH_HUB_TOKEN": "\u63A7\u5236\u7AEF token",
  "hub.key.DSH_HUB_PROXY": "\u4EE3\u7406",
  "hub.url.hint": "\u4F8B\u5982 https://hub.example.com:7891",
  "hub.proxy.hint": "http://\u4E3B\u673A:\u7AEF\u53E3\uFF0C\u6216 env\uFF08\u7528\u7CFB\u7EDF\u4EE3\u7406\uFF09\u3001direct\uFF08\u76F4\u8FDE\uFF09"
};
var en = {
  "page.title": "Secrets & plugins",
  "page.nav": "Secrets",
  "page.subtitle": "Manage the local vault, DSH credentials and what each plugin needs. Values can be written, never read back.",
  "notice.title": "Write-only",
  "notice.body": "You can create, replace and delete secrets here, but no route ever returns a value. Vault secrets are used only through the secret_* tools: secret_exec injects them as environment variables, secret_http fills {placeholder} placeholders.",
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
  "empty.missing.hint": "Use New secret to store the first one; the vault is created then. ingest-file.mjs can bulk-import as well.",
  "empty.vault.title": "The vault is empty",
  "empty.vault.hint": "Use New secret to store the first one (a description and tags help later).",
  "empty.filter.title": "No matching secrets",
  "empty.filter.hint": "Try another keyword or tag. Search matches names and descriptions, never values.",
  "error.title": "Secrets dashboard data is unreachable",
  "error.hint": "The host-side routes /api/secrets/* did not answer. The rest of the page is unaffected.",
  "error.unauthorized": "Your login has expired. Sign in again and retry.",
  "error.unavailable": "The login service is unavailable, or dsh-host-secrets did not mount the dashboard routes.",
  "retry": "Retry",
  "tab.vault": "Vault",
  "tab.credentials": "DSH credentials",
  "tab.plugins": "Plugins",
  "tab.aria": "Switch view",
  "col.actions": "Actions",
  "action.new": "New secret",
  "action.replace": "Replace",
  "action.edit": "Edit",
  "action.rename": "Rename",
  "action.delete": "Delete",
  "action.set": "Set",
  "action.change": "Change",
  "action.clear": "Clear",
  "action.cancel": "Cancel",
  "action.save": "Save",
  "action.saving": "Saving\u2026",
  "action.show": "Show",
  "action.hide": "Hide",
  "action.close": "Close",
  "field.name": "Name",
  "field.name.hint": "Letters, digits, _ . -; starts with a letter or _",
  "field.value": "Value",
  "field.value.hint": "Cannot be viewed after saving, only replaced",
  "field.value.keep": "Leave empty to keep the value",
  "field.description": "Description",
  "field.tags": "Tags",
  "field.tags.hint": "Separate with spaces or commas",
  "field.to": "New name",
  "field.overwrite": "Overwrite an existing secret with that name",
  "sheet.create": "New secret",
  "sheet.replace": "Replace the value of {name}",
  "sheet.edit": "Edit {name}",
  "sheet.rename": "Rename {name}",
  "sheet.delete": "Delete {name}?",
  "sheet.delete.body": "This cannot be undone. secret_exec / secret_http calls that use it will fail.",
  "sheet.credential": "Set {name}",
  "sheet.credential.clear": "Clear {name}?",
  "sheet.credential.clear.body": "This clears the value in the DSH credential store; a process environment variable of the same name still applies.",
  "sheet.hub": "Set {name}",
  "done.saved": "Saved {name}",
  "done.deleted": "Deleted {name}",
  "done.renamed": "Renamed to {name}",
  "done.cleared": "Cleared {name}",
  "error.save": "Not saved: {message}",
  "cred.title": "DSH credentials",
  "cred.sub": "Kept in DSH's own credential store (<DSH home>/.credentials.yaml); models and plugins read them by name. Changes apply at once, no restart.",
  "cred.unavailable": "This DSH mounts no credential store; set these variables in the environment that starts DSH.",
  "cred.usedBy": "Used by {plugins}",
  "cred.status.set": "Set",
  "cred.status.unset": "Not set",
  "cred.source.file": "credential store",
  "cred.source.env": "process environment",
  "cred.source.user-env": "<DSH home>/.env",
  "cred.source.project-env": "working-directory .env",
  "cred.source.unknown": "unknown",
  "cred.envWins": "A variable of the same name in the environment that starts DSH takes precedence.",
  "cred.ref.DEEPSEEK_API_KEY": "DeepSeek model API key",
  "cred.ref.EXA_API_KEY": "Exa web search API key",
  "cred.ref.GITHUB_TOKEN": "GitHub token: open PRs, read checks",
  "cred.ref.GITEA_TOKEN": "Gitea token: open PRs, read checks",
  "plugins.title": "Plugins",
  "plugins.sub": "selfdsh plugins in the local profile and what each one needs.",
  "plugins.profile": "Profile: {name}",
  "plugins.profiles": "Profiles: {names}",
  "plugins.noProfile": "No profile found",
  "plugins.installed": "Installed",
  "plugins.notInstalled": "Not installed",
  "plugins.nothingNeeded": "Needs no secrets",
  "plugins.required": "required",
  "plugins.optional": "optional",
  "plugins.kind.credential": "DSH credential",
  "plugins.kind.hub": "hub connection",
  "plugins.kind.vault-key": "vault master key",
  "plugins.vaultKey.hint": "Set in the environment that starts DSH or in <DSH home>/secrets.env. Not editable here: changing it would lock the existing vault.",
  "plugins.ready": "Ready",
  "plugins.missing": "{count} missing",
  "plugin.dsh-router-b": "War-room router: partition managers, workers, quick tasks",
  "plugin.dsh-agent-hub": "Agent hub: registration, task pull, scheduling other agents",
  "plugin.dsh-secrets": "Local encrypted vault",
  "plugin.dsh-egress": "Egress: headless browser control",
  "plugin.dsh-vpn": "VPN connections",
  "plugin.dsh-token-stats": "Token usage stats",
  "hub.title": "Hub address",
  "hub.sub": "Stored in {file}. When the server address moves, change it here; agent-hub uses it on its next request, no restart.",
  "hub.shadowed": "Also set in the process environment, which wins",
  "hub.notSet": "Not set",
  "hub.hidden": "Saved (hidden)",
  "hub.key.DSH_HUB_URL": "Hub URL",
  "hub.key.DSH_HUB_TOKEN": "Controller token",
  "hub.key.DSH_HUB_PROXY": "Proxy",
  "hub.url.hint": "e.g. https://hub.example.com:7891",
  "hub.proxy.hint": "http://host:port, or env (system proxy), direct"
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
var import_react2 = require("react");

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

// src/client/Manage.tsx
var import_react = require("react");
var import_react_dom = require("react-dom");

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
async function getJson(url, signal, payload) {
  let response;
  try {
    response = await fetch(url, payload === void 0 ? { method: "GET", credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" }, signal } : {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json", "x-dsh-secrets": "1" },
      body: JSON.stringify(payload),
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
function postJson(path, body) {
  return getJson(`${BRIDGE_BASE}${path}`, void 0, body);
}
function fetchCredentials(signal) {
  return getJson(`${BRIDGE_BASE}/credentials`, signal);
}
function fetchPlugins(signal) {
  return getJson(`${BRIDGE_BASE}/plugins`, signal);
}
function vaultSet(body) {
  return postJson("/vault/set", body);
}
function vaultDescribe(body) {
  return postJson("/vault/describe", body);
}
function vaultRename(body) {
  return postJson("/vault/rename", body);
}
function vaultDelete(name) {
  return postJson("/vault/delete", { name });
}
function credentialSet(ref, value) {
  return postJson("/credentials/set", { ref, value });
}
function credentialUnset(ref) {
  return postJson("/credentials/unset", { ref });
}
function hubSet(name, value) {
  return postJson("/hub/set", { name, value });
}
function hubUnset(name) {
  return postJson("/hub/unset", { name });
}

// src/client/Manage.tsx
var import_jsx_runtime2 = require("react/jsx-runtime");
var USED_BY = {
  DEEPSEEK_API_KEY: "dsh-router-b",
  EXA_API_KEY: "dsh-router-b",
  GITHUB_TOKEN: "dsh-router-b",
  GITEA_TOKEN: "dsh-router-b"
};
function usedBy(t, ref) {
  const plugin = USED_BY[ref];
  return plugin === void 0 ? "" : t("cred.usedBy", { plugins: plugin });
}
var messageOf = (error) => error instanceof Error ? error.message : String(error);
function tx(t, key, fallback, values) {
  const text = t(key, values);
  return text === key || text === "" ? fallback : text;
}
function parseTags(text) {
  return [...new Set(text.split(/[\s,，]+/).map((tag) => tag.trim()).filter((tag) => tag !== ""))];
}
function useDocument(load) {
  const [state, setState] = (0, import_react.useState)({ busy: true });
  const ticket = (0, import_react.useRef)(0);
  const inflight = (0, import_react.useRef)(null);
  const run = (0, import_react.useCallback)(() => {
    const mine = ticket.current + 1;
    ticket.current = mine;
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    setState((previous) => ({ ...previous, busy: true }));
    load(controller.signal).then(
      (data) => {
        if (mine === ticket.current) setState({ data, busy: false });
      },
      (error) => {
        if (mine !== ticket.current) return;
        const status = error instanceof BridgeError ? error.status : void 0;
        setState((previous) => ({ data: previous.data, busy: false, error: { message: messageOf(error), status } }));
      }
    );
  }, [load]);
  (0, import_react.useEffect)(() => {
    run();
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") run();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      inflight.current?.abort();
      ticket.current += 1;
    };
  }, [run]);
  return { data: state.data, error: state.error, busy: state.busy, reload: run };
}
function Layer({ children }) {
  if (typeof document === "undefined") return null;
  return (0, import_react_dom.createPortal)(/* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dss-layer", children }), document.body);
}
function Sheet({ t, title, onClose, children }) {
  const panel = (0, import_react.useRef)(null);
  (0, import_react.useEffect)(() => {
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const first = panel.current?.querySelector('input, textarea, button[data-primary="true"]');
    first?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Layer, { children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dss-sheet-backdrop", onMouseDown: (event) => {
    if (event.target === event.currentTarget) onClose();
  }, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dss-sheet", role: "dialog", "aria-modal": "true", "aria-label": title, ref: panel, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dss-sheet-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h2", { className: "dss-sheet-title", children: title }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dss-icon-btn", "aria-label": t("action.close"), onClick: onClose, children: "\xD7" })
    ] }),
    children
  ] }) }) });
}
function SecretInput({ t, value, onChange, placeholder, id }) {
  const [shown, setShown] = (0, import_react.useState)(false);
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dss-secret-input", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      "input",
      {
        id,
        className: "dss-input",
        type: shown ? "text" : "password",
        value,
        placeholder,
        autoComplete: "new-password",
        spellCheck: false,
        autoCapitalize: "off",
        onChange: (event) => {
          onChange(event.target.value);
        }
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dss-input-toggle", onClick: () => {
      setShown(!shown);
    }, children: shown ? t("action.hide") : t("action.show") })
  ] });
}
function Field({ label, hint, htmlFor, children }) {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dss-field", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("label", { className: "dss-field-label", htmlFor, children: label }),
    children,
    hint !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-field-hint", children: hint })
  ] });
}
function useSubmit(t, run, onDone) {
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)(void 0);
  const submit = (event) => {
    event?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(void 0);
    run().then(
      (message) => {
        setBusy(false);
        onDone(message);
      },
      (failure) => {
        setBusy(false);
        setError(t("error.save", { message: messageOf(failure) }));
      }
    );
  };
  return { busy, error, submit };
}
function SheetActions({ t, busy, label, danger, onCancel, disabled }) {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dss-sheet-actions", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dss-btn", onClick: onCancel, children: t("action.cancel") }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "submit", className: "dss-btn", "data-primary": danger === true ? void 0 : "true", "data-danger": danger === true ? "true" : void 0, disabled: busy || disabled === true, children: busy ? t("action.saving") : label })
  ] });
}
function VaultSheet({ t, mode, onClose, onDone }) {
  const item = mode.kind === "create" ? void 0 : mode.item;
  const [name, setName] = (0, import_react.useState)("");
  const [value, setValue] = (0, import_react.useState)("");
  const [description, setDescription] = (0, import_react.useState)(item?.description ?? "");
  const [tags, setTags] = (0, import_react.useState)(item?.tags.join(" ") ?? "");
  const [to, setTo] = (0, import_react.useState)(item?.name ?? "");
  const [overwrite, setOverwrite] = (0, import_react.useState)(false);
  const { busy, error, submit } = useSubmit(t, async () => {
    switch (mode.kind) {
      case "create": {
        await vaultSet({ name: name.trim(), value, ...description.trim() === "" ? {} : { description: description.trim() }, tags: parseTags(tags) });
        return t("done.saved", { name: name.trim() });
      }
      case "replace":
        await vaultSet({ name: mode.item.name, value });
        return t("done.saved", { name: mode.item.name });
      case "edit":
        await vaultDescribe({ name: mode.item.name, description: description.trim(), tags: parseTags(tags) });
        return t("done.saved", { name: mode.item.name });
      case "rename":
        await vaultRename({ from: mode.item.name, to: to.trim(), overwrite });
        return t("done.renamed", { name: to.trim() });
      case "delete":
        await vaultDelete(mode.item.name);
        return t("done.deleted", { name: mode.item.name });
    }
  }, onDone);
  const title = mode.kind === "create" ? t("sheet.create") : t(`sheet.${mode.kind}`, { name: mode.item.name });
  let body;
  let ready = true;
  if (mode.kind === "delete") {
    body = /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dss-sheet-text", children: t("sheet.delete.body") });
  } else if (mode.kind === "rename") {
    ready = to.trim() !== "" && to.trim() !== mode.item.name;
    body = /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Field, { label: t("field.to"), hint: t("field.name.hint"), htmlFor: "dss-f-to", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("input", { id: "dss-f-to", className: "dss-input dss-mono", value: to, spellCheck: false, autoComplete: "off", onChange: (event) => {
        setTo(event.target.value);
      } }) }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { className: "dss-check", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("input", { type: "checkbox", checked: overwrite, onChange: (event) => {
          setOverwrite(event.target.checked);
        } }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: t("field.overwrite") })
      ] })
    ] });
  } else {
    const showValue = mode.kind === "create" || mode.kind === "replace";
    const showMeta = mode.kind === "create" || mode.kind === "edit";
    ready = (mode.kind !== "create" || name.trim() !== "") && (!showValue || value !== "");
    body = /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
      mode.kind === "create" && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Field, { label: t("field.name"), hint: t("field.name.hint"), htmlFor: "dss-f-name", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("input", { id: "dss-f-name", className: "dss-input dss-mono", value: name, spellCheck: false, autoComplete: "off", onChange: (event) => {
        setName(event.target.value);
      } }) }),
      showValue && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Field, { label: t("field.value"), hint: t("field.value.hint"), htmlFor: "dss-f-value", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(SecretInput, { t, id: "dss-f-value", value, onChange: setValue }) }),
      showMeta && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Field, { label: t("field.description"), htmlFor: "dss-f-desc", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("textarea", { id: "dss-f-desc", className: "dss-input dss-textarea", value: description, rows: 2, onChange: (event) => {
          setDescription(event.target.value);
        } }) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Field, { label: t("field.tags"), hint: t("field.tags.hint"), htmlFor: "dss-f-tags", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("input", { id: "dss-f-tags", className: "dss-input", value: tags, spellCheck: false, autoComplete: "off", onChange: (event) => {
          setTags(event.target.value);
        } }) })
      ] })
    ] });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Sheet, { t, title, onClose, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("form", { className: "dss-sheet-form", onSubmit: submit, children: [
    body,
    error !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dss-sheet-error", role: "alert", children: error }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      SheetActions,
      {
        t,
        busy,
        disabled: !ready,
        danger: mode.kind === "delete",
        label: mode.kind === "delete" ? t("action.delete") : t("action.save"),
        onCancel: onClose
      }
    )
  ] }) });
}
function CredentialSheet({ t, refName, clear, onClose, onDone }) {
  const [value, setValue] = (0, import_react.useState)("");
  const { busy, error, submit } = useSubmit(t, async () => {
    if (clear) {
      await credentialUnset(refName);
      return t("done.cleared", { name: refName });
    }
    await credentialSet(refName, value);
    return t("done.saved", { name: refName });
  }, onDone);
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Sheet, { t, title: clear ? t("sheet.credential.clear", { name: refName }) : t("sheet.credential", { name: refName }), onClose, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("form", { className: "dss-sheet-form", onSubmit: submit, children: [
    clear ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dss-sheet-text", children: t("sheet.credential.clear.body") }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Field, { label: t("field.value"), hint: t("field.value.hint"), htmlFor: "dss-f-cred", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(SecretInput, { t, id: "dss-f-cred", value, onChange: setValue }) }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dss-sheet-text", children: t("cred.envWins") })
    ] }),
    error !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dss-sheet-error", role: "alert", children: error }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(SheetActions, { t, busy, disabled: !clear && value.trim() === "", danger: clear, label: clear ? t("action.clear") : t("action.save"), onCancel: onClose })
  ] }) });
}
function HubSheet({ t, item, onClose, onDone }) {
  const [value, setValue] = (0, import_react.useState)(item.secret ? "" : item.value ?? "");
  const [clearing, setClearing] = (0, import_react.useState)(false);
  const { busy, error, submit } = useSubmit(t, async () => {
    if (clearing) {
      await hubUnset(item.key);
      return t("done.cleared", { name: item.key });
    }
    await hubSet(item.key, value.trim());
    return t("done.saved", { name: item.key });
  }, onDone);
  const hint = item.key === "DSH_HUB_URL" ? t("hub.url.hint") : item.key === "DSH_HUB_PROXY" ? t("hub.proxy.hint") : t("field.value.hint");
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Sheet, { t, title: t("sheet.hub", { name: tx(t, `hub.key.${item.key}`, item.key) }), onClose, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("form", { className: "dss-sheet-form", onSubmit: submit, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Field, { label: item.key, hint, htmlFor: "dss-f-hub", children: item.secret ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(SecretInput, { t, id: "dss-f-hub", value, onChange: setValue }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("input", { id: "dss-f-hub", className: "dss-input dss-mono", value, spellCheck: false, autoComplete: "off", onChange: (event) => {
      setValue(event.target.value);
    } }) }),
    item.shadowed && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dss-sheet-text", children: t("hub.shadowed") }),
    error !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dss-sheet-error", role: "alert", children: error }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dss-sheet-actions", children: [
      item.source === "file" && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "submit", className: "dss-btn dss-btn-left", "data-danger": "true", disabled: busy, onClick: () => {
        setClearing(true);
      }, children: t("action.clear") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dss-btn", onClick: onClose, children: t("action.cancel") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "submit", className: "dss-btn", "data-primary": "true", disabled: busy || value.trim() === "", onClick: () => {
        setClearing(false);
      }, children: busy ? t("action.saving") : t("action.save") })
    ] })
  ] }) });
}
function StatusDot({ tone }) {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-dot", "data-state": tone, "aria-hidden": "true" });
}
function sourceText(t, source) {
  return tx(t, `cred.source.${source ?? "unknown"}`, source ?? t("cred.source.unknown"));
}
function LoadState({ t, error, onRetry }) {
  if (error === void 0) return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dss-empty", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-empty-hint", children: t("loading") }) });
  const hint = error.status === 401 || error.status === 403 ? t("error.unauthorized") : error.status === 503 ? t("error.unavailable") : t("error.hint");
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dss-empty", "data-bad": "true", role: "alert", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-empty-title", children: t("error.title") }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-empty-hint", children: hint }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-empty-hint", children: t("detail", { message: error.message }) }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dss-btn", "data-primary": "true", onClick: onRetry, children: t("retry") })
  ] });
}
function SectionHead({ t, title, sub, busy, generatedAt, onRefresh }) {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dss-section-head", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dss-head-text", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h2", { className: "dss-section-title", children: title }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dss-sub", children: sub })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dss-head-actions", children: [
      generatedAt !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-updated", children: t("updatedAt", { time: formatClock(generatedAt) }) }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dss-btn", disabled: busy, onClick: onRefresh, children: busy && generatedAt !== void 0 ? t("refreshing") : t("refresh") })
    ] })
  ] });
}
function CredentialsTab({ t, toast }) {
  const doc = useDocument(fetchCredentials);
  const [sheet, setSheet] = (0, import_react.useState)(void 0);
  const close = (0, import_react.useCallback)(() => {
    setSheet(void 0);
  }, []);
  const done = (message) => {
    setSheet(void 0);
    toast("ok", message);
    doc.reload();
  };
  const data = doc.data;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { className: "dss-section", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(SectionHead, { t, title: t("cred.title"), sub: t("cred.sub"), busy: doc.busy, generatedAt: data?.generatedAt, onRefresh: doc.reload }),
    data === void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(LoadState, { t, error: doc.busy ? void 0 : doc.error, onRetry: doc.reload }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
      !data.available && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dss-banner", "data-tone": "locked", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dss-banner-text", children: t("cred.unavailable") }) }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dss-list", children: data.items.map((item) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dss-list-row", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(StatusDot, { tone: item.configured ? "ok" : "idle" }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dss-list-main", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("code", { className: "dss-list-name", children: item.ref }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-list-sub", children: tx(t, `cred.ref.${item.ref}`, usedBy(t, item.ref)) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-list-state", children: item.configured ? `${t("cred.status.set")} \xB7 ${sourceText(t, item.source)}` : t("cred.status.unset") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dss-row-actions", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dss-btn dss-btn-sm", disabled: !data.available, onClick: () => {
            setSheet({ ref: item.ref, clear: false });
          }, children: item.configured ? t("action.change") : t("action.set") }),
          item.configured && item.source === "file" && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dss-btn dss-btn-sm", "data-danger": "true", onClick: () => {
            setSheet({ ref: item.ref, clear: true });
          }, children: t("action.clear") })
        ] })
      ] }, item.ref)) })
    ] }),
    sheet !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(CredentialSheet, { t, refName: sheet.ref, clear: sheet.clear, onClose: close, onDone: done })
  ] });
}
function NeedRow({ t, need, hub, onSetCredential, onSetHub }) {
  const tone = need.configured ? "ok" : need.required ? "warn" : "idle";
  let detail;
  if (need.kind === "vault-key") detail = t("plugins.vaultKey.hint");
  else if (need.kind === "hub" && hub !== void 0) {
    detail = !hub.configured ? t("hub.notSet") : hub.secret ? t("hub.hidden") : hub.value ?? "";
    if (hub.shadowed) detail = `${detail} \xB7 ${t("hub.shadowed")}`;
  } else detail = need.configured ? sourceText(t, need.source) : t("cred.status.unset");
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dss-need", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(StatusDot, { tone }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dss-need-main", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "dss-need-name", children: [
        need.kind === "hub" ? tx(t, `hub.key.${need.key}`, need.key) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("code", { children: need.key }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-need-tag", children: need.required ? t("plugins.required") : t("plugins.optional") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-need-detail", "data-mono": need.kind === "hub" && hub?.secret !== true && hub?.configured === true ? "true" : void 0, children: detail })
    ] }),
    need.kind === "credential" && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dss-btn dss-btn-sm", onClick: () => {
      onSetCredential(need.key);
    }, children: need.configured ? t("action.change") : t("action.set") }),
    need.kind === "hub" && hub !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dss-btn dss-btn-sm", onClick: () => {
      onSetHub(hub);
    }, children: hub.configured ? t("action.change") : t("action.set") })
  ] });
}
function PluginCard({ t, plugin, hub, onSetCredential, onSetHub }) {
  const missing = plugin.needs.filter((need) => need.required && !need.configured).length;
  const hubByKey = new Map(hub.items.map((item) => [item.key, item]));
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("article", { className: "dss-card", "data-installed": plugin.installed, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("header", { className: "dss-card-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dss-card-title-wrap", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h3", { className: "dss-card-title", children: plugin.id }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dss-card-sub", children: tx(t, `plugin.${plugin.id}`, "") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dss-chip", "data-tone": plugin.installed ? missing === 0 ? "unlocked" : "locked" : "missing", children: !plugin.installed ? t("plugins.notInstalled") : missing === 0 ? t("plugins.ready") : t("plugins.missing", { count: missing }) })
    ] }),
    plugin.id === "dsh-agent-hub" && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dss-card-note", children: t("hub.sub", { file: hub.file }) }),
    plugin.needs.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dss-card-note", children: t("plugins.nothingNeeded") }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dss-needs", children: plugin.needs.map((need) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(NeedRow, { t, need, hub: hubByKey.get(need.key), onSetCredential, onSetHub }, need.key)) })
  ] });
}
function PluginsTab({ t, toast }) {
  const doc = useDocument(fetchPlugins);
  const [credential, setCredential] = (0, import_react.useState)(void 0);
  const [hubItem, setHubItem] = (0, import_react.useState)(void 0);
  const close = (0, import_react.useCallback)(() => {
    setCredential(void 0);
    setHubItem(void 0);
  }, []);
  const done = (message) => {
    close();
    toast("ok", message);
    doc.reload();
  };
  const data = doc.data;
  let sub = t("plugins.sub");
  if (data !== void 0) {
    const running = data.profiles.find((profile) => profile.running);
    const where = running !== void 0 ? t("plugins.profile", { name: running.name }) : data.profiles.length === 0 ? t("plugins.noProfile") : t("plugins.profiles", { names: data.profiles.map((profile) => profile.name).join(", ") });
    sub = `${sub} ${where}`;
  }
  const plugins = data === void 0 ? [] : [...data.plugins.filter((plugin) => plugin.installed), ...data.plugins.filter((plugin) => !plugin.installed)];
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { className: "dss-section", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(SectionHead, { t, title: t("plugins.title"), sub, busy: doc.busy, generatedAt: data?.generatedAt, onRefresh: doc.reload }),
    data === void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(LoadState, { t, error: doc.busy ? void 0 : doc.error, onRetry: doc.reload }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dss-cards", children: plugins.map((plugin) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(PluginCard, { t, plugin, hub: data.hub, onSetCredential: setCredential, onSetHub: setHubItem }, plugin.id)) }),
    credential !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(CredentialSheet, { t, refName: credential, clear: false, onClose: close, onDone: done }),
    hubItem !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(HubSheet, { t, item: hubItem, onClose: close, onDone: done })
  ] });
}

// src/client/SecretsPage.tsx
var import_jsx_runtime3 = require("react/jsx-runtime");
var TABS = ["vault", "credentials", "plugins"];
var TAB_KEY = "dsh-secrets.tab";
var PLACEHOLDER = "${secret:NAME}";
var SEARCH_DEBOUNCE_MS = 250;
var LOCK_HINTS = {
  "key-missing": "locked.key-missing",
  "decrypt-failed": "locked.decrypt-failed",
  "key-invalid": "locked.key-invalid",
  "key-source-mismatch": "locked.key-source-mismatch"
};
function useDashboard(filter) {
  const [state, setState] = (0, import_react2.useState)({ busy: true });
  const ticket = (0, import_react2.useRef)(0);
  const inflight = (0, import_react2.useRef)(null);
  const current = (0, import_react2.useRef)(filter);
  current.current = filter;
  const load = (0, import_react2.useCallback)((wanted) => {
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
  (0, import_react2.useEffect)(() => {
    load({ tag, query });
  }, [load, tag, query]);
  (0, import_react2.useEffect)(() => {
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
  const reload = (0, import_react2.useCallback)(() => {
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
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("section", { className: "dss-notice", role: "note", "aria-label": t("notice.title"), children: [
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dss-notice-icon", children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(LockIcon, { size: 20 }) }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dss-notice-body", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dss-notice-title", children: t("notice.title") }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "dss-notice-text", children: t("notice.body", { placeholder: PLACEHOLDER }) }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "dss-notice-text", children: t("notice.fingerprint") })
    ] })
  ] });
}
function VaultLine({ t, vault, summary }) {
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dss-status", children: [
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dss-chip", "data-tone": vault.state, children: t(`vault.state.${vault.state}`) }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { children: t(`vault.keySource.${vault.keySource}`) }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dss-status-key", "data-ok": vault.keyConfigured, children: vault.keyConfigured ? t("vault.key.configured") : t("vault.key.missing") }),
    vault.state === "unlocked" && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(import_jsx_runtime3.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dss-status-sep", "aria-hidden": "true", children: "\xB7" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { children: t("vault.count", { total: summary.total }) }),
      summary.lastUpdatedAt !== null && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { title: summary.lastUpdatedAt, children: t("vault.lastUpdated", { time: formatDateTime(summary.lastUpdatedAt) }) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dss-status-path", title: vault.path, children: t("vault.path", { path: vault.path }) })
  ] });
}
function VaultProblem({ t, vault }) {
  const code = vault.error?.code ?? "";
  const locked = vault.state === "locked";
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("section", { className: "dss-banner", "data-tone": vault.state, role: "alert", children: [
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dss-banner-title", children: locked ? t("locked.title") : t("error.vault.title") }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "dss-banner-text", children: locked ? t(LOCK_HINTS[code] ?? "locked.generic") : t("error.hint") }),
    vault.error !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "dss-banner-detail", children: t("detail", { message: vault.error.message }) })
  ] });
}
function Row({ t, item, activeTag, onTag, onAction }) {
  const times = t("cell.times", {
    created: formatDateTime(item.createdAt),
    updated: formatDateTime(item.updatedAt),
    meta: formatDateTime(item.metaUpdatedAt)
  });
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("tr", { children: [
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("td", { className: "dss-cell-name", children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("code", { children: item.name }) }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("td", { className: "dss-cell-desc", children: item.description === "" ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dss-muted", children: t("cell.noDescription") }) : item.description }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("td", { className: "dss-cell-tags", children: item.tags.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dss-muted", children: t("cell.noTags") }) : /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dss-cell-tags-list", children: item.tags.map((tag) => /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
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
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("td", { className: "dss-cell-fp", children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("code", { children: item.fingerprint }) }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("td", { className: "dss-cell-len", children: t("cell.length", { count: item.length }) }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("td", { className: "dss-cell-time", title: times, children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { children: formatDateTime(item.updatedAt) }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dss-muted", children: ageText(t, item.updatedAt) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("td", { className: "dss-cell-actions", children: /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dss-row-actions", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "dss-btn dss-btn-sm", onClick: () => {
        onAction({ kind: "replace", item });
      }, children: t("action.replace") }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "dss-btn dss-btn-sm", onClick: () => {
        onAction({ kind: "edit", item });
      }, children: t("action.edit") }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "dss-btn dss-btn-sm", onClick: () => {
        onAction({ kind: "rename", item });
      }, children: t("action.rename") }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "dss-btn dss-btn-sm", "data-danger": "true", onClick: () => {
        onAction({ kind: "delete", item });
      }, children: t("action.delete") })
    ] }) })
  ] });
}
function VaultTab({ t, toast }) {
  const [sheet, setSheet] = (0, import_react2.useState)(void 0);
  const [tag, setTag] = (0, import_react2.useState)(void 0);
  const [queryInput, setQueryInput] = (0, import_react2.useState)("");
  const [query, setQuery] = (0, import_react2.useState)("");
  (0, import_react2.useEffect)(() => {
    const timer = window.setTimeout(() => {
      setQuery(queryInput.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [queryInput]);
  const { state, reload } = useDashboard({ tag, query: query === "" ? void 0 : query });
  const closeSheet = (0, import_react2.useCallback)(() => {
    setSheet(void 0);
  }, []);
  const sheetDone = (message) => {
    setSheet(void 0);
    toast("ok", message);
    reload();
  };
  const data = state.data;
  const summary = data?.summary;
  const list = data?.list;
  const vault = summary?.vault;
  const filtering = tag !== void 0 || query !== "";
  const clear = (0, import_react2.useCallback)(() => {
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
      body = /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dss-empty", "data-bad": "true", role: "alert", children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dss-empty-title", children: t("error.title") }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dss-empty-hint", children: hint }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dss-empty-hint", children: t("detail", { message: state.error.message }) }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "dss-btn", "data-primary": "true", onClick: reload, children: t("retry") })
      ] });
    } else {
      body = /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: "dss-empty", children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dss-empty-hint", children: t("loading") }) });
    }
  } else if (vault.state === "locked" || vault.state === "error") {
    body = /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(VaultProblem, { t, vault });
  } else if (vault.state === "missing") {
    body = /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dss-empty", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dss-empty-title", children: t("empty.missing.title") }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dss-empty-hint", children: t("empty.missing.hint") }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "dss-btn", "data-primary": "true", onClick: () => {
        setSheet({ kind: "create" });
      }, children: t("action.new") })
    ] });
  } else if (list.total === 0) {
    body = /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dss-empty", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dss-empty-title", children: t("empty.vault.title") }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dss-empty-hint", children: t("empty.vault.hint") }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "dss-btn", "data-primary": "true", onClick: () => {
        setSheet({ kind: "create" });
      }, children: t("action.new") })
    ] });
  } else {
    body = /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(import_jsx_runtime3.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dss-toolbar", children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
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
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dss-tags-row", role: "group", "aria-label": t("filter.tags.aria"), children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("button", { type: "button", className: "dss-filter", "data-on": tag === void 0, onClick: () => {
            setTag(void 0);
          }, children: [
            t("filter.all"),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dss-filter-count", children: summary.total })
          ] }),
          tagChips.map((chip) => /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
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
                /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dss-filter-count", children: chip.count })
              ]
            },
            chip.tag
          ))
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dss-toolbar-foot", children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { children: t("filter.matched", { matched: list.matched, total: list.total }) }),
          summary.untagged > 0 && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { children: t("filter.untagged", { count: summary.untagged }) }),
          filtering && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "dss-link", onClick: clear, children: t("filter.clear") })
        ] })
      ] }),
      list.items.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dss-empty", children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dss-empty-title", children: t("empty.filter.title") }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dss-empty-hint", children: t("empty.filter.hint") }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "dss-btn", onClick: clear, children: t("filter.clear") })
      ] }) : /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: "dss-table-wrap", children: /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("table", { className: "dss-table", children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("thead", { children: /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("tr", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("th", { scope: "col", children: t("col.name") }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("th", { scope: "col", children: t("col.description") }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("th", { scope: "col", children: t("col.tags") }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("th", { scope: "col", children: t("col.fingerprint") }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("th", { scope: "col", children: t("col.length") }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("th", { scope: "col", children: t("col.updated") }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("th", { scope: "col", children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dss-sr", children: t("col.actions") }) })
        ] }) }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("tbody", { children: list.items.map((item) => /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(Row, { t, item, activeTag: tag, onTag: setTag, onAction: setSheet }, item.name)) })
      ] }) })
    ] });
  }
  const canWrite = vault !== void 0 && vault.state !== "locked" && vault.state !== "error";
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("section", { className: "dss-section", children: [
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dss-section-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dss-head-text", children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("h2", { className: "dss-section-title", children: t("tab.vault") }),
        vault !== void 0 && summary !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(VaultLine, { t, vault, summary })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dss-head-actions", children: [
        data !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "dss-updated", children: t("updatedAt", { time: formatClock(data.list.generatedAt) }) }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "dss-btn", disabled: state.busy, onClick: reload, children: state.busy && data !== void 0 ? t("refreshing") : t("refresh") }),
        canWrite && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "dss-btn", "data-primary": "true", onClick: () => {
          setSheet({ kind: "create" });
        }, children: t("action.new") })
      ] })
    ] }),
    data !== void 0 && state.error !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("section", { className: "dss-banner", "data-tone": "error", role: "status", children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "dss-banner-text", children: t("stale", { message: state.error.message, time: formatClock(data.list.generatedAt) }) }) }),
    body,
    sheet !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(VaultSheet, { t, mode: sheet, onClose: closeSheet, onDone: sheetDone })
  ] });
}
function initialTab() {
  try {
    const saved = window.localStorage.getItem(TAB_KEY);
    if (saved !== null && TABS.includes(saved)) return saved;
  } catch {
  }
  return "vault";
}
function SecretsPage({ t }) {
  const [tab, setTab] = (0, import_react2.useState)(initialTab);
  const [toastState, setToastState] = (0, import_react2.useState)(void 0);
  const toastId = (0, import_react2.useRef)(0);
  const choose = (next) => {
    setTab(next);
    try {
      window.localStorage.setItem(TAB_KEY, next);
    } catch {
    }
  };
  const toast = (0, import_react2.useCallback)((tone, text) => {
    toastId.current += 1;
    setToastState({ tone, text, id: toastId.current });
  }, []);
  (0, import_react2.useEffect)(() => {
    if (toastState === void 0) return void 0;
    const timer = window.setTimeout(() => {
      setToastState(void 0);
    }, 3200);
    return () => {
      window.clearTimeout(timer);
    };
  }, [toastState]);
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dss-page", children: [
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dss-col", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("header", { className: "dss-head", children: /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "dss-head-text", children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("h1", { className: "dss-title", children: t("page.title") }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "dss-sub", children: t("page.subtitle") })
      ] }) }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: "dss-segmented", role: "tablist", "aria-label": t("tab.aria"), children: TABS.map((name) => /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": tab === name,
          className: "dss-segment",
          "data-on": tab === name,
          onClick: () => {
            choose(name);
          },
          children: t(`tab.${name}`)
        },
        name
      )) }),
      tab === "vault" && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(Notice, { t }),
      tab === "vault" && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(VaultTab, { t, toast }),
      tab === "credentials" && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(CredentialsTab, { t, toast }),
      tab === "plugins" && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(PluginsTab, { t, toast })
    ] }),
    toastState !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(Layer, { children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: "dss-toast", "data-tone": toastState.tone, role: "status", children: toastState.text }, toastState.id) })
  ] });
}

// src/client/styles.ts
var STYLE_KEY = "dsh-client-ui-secrets/SecretsPage.css";
var SECRETS_CSS = `
.dss-page, .dss-layer {
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
  --dss-idle: var(--dsw-alias-state-idle-primary, #d4d4d4);
  --dss-mono: var(--dsh-mono, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace);
  --dss-shadow: 0 0 0 0.5px color-mix(in srgb, var(--dss-text) 12%, transparent), 0 12px 40px color-mix(in srgb, var(--dss-text) 14%, transparent);
  color: var(--dss-text);
  font-family: var(--dsh-font, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif);
  font-size: 14px;
  line-height: 22px;
  -webkit-font-smoothing: antialiased;
}
.dss-page { height: 100%; min-height: 0; overflow-y: auto; background: var(--dss-base); container-type: inline-size; }
/* Sheets and toasts are portalled to <body> inside .dss-layer (same tokens). */
.dss-layer { position: fixed; inset: 0; z-index: 1000; pointer-events: none; }
.dss-layer > * { pointer-events: auto; }
.dss-page *, .dss-page *::before, .dss-page *::after, .dss-layer *, .dss-layer *::before, .dss-layer *::after { box-sizing: border-box; }
.dss-page button, .dss-page input, .dss-page textarea, .dss-layer button, .dss-layer input, .dss-layer textarea { font: inherit; color: inherit; }
.dss-col { width: 100%; max-width: 1100px; margin: 0 auto; padding: 0 24px 56px; display: flex; flex-direction: column; gap: 20px; }
.dss-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.dss-mono, .dss-page code, .dss-layer code { font-family: var(--dss-mono); font-size: 12.5px; }

/* ---------- head ---------- */
.dss-head { padding-top: 40px; display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.dss-head-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dss-title { margin: 0; font-size: 24px; line-height: 32px; font-weight: 600; letter-spacing: 0; }
.dss-sub { margin: 0; font-size: 13px; line-height: 20px; color: var(--dss-text-3); }
.dss-head-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dss-updated { font-size: 12px; color: var(--dss-text-3); }

/* ---------- buttons ---------- */
.dss-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 38px; padding: 0 16px; border: 0;
  border-radius: 999px; background: var(--dss-hover); cursor: pointer; font-size: 13.5px; font-weight: 500; white-space: nowrap;
  transition: background 0.15s ease, opacity 0.15s ease;
}
.dss-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--dss-text) 9%, transparent); }
.dss-btn:disabled { opacity: 0.5; cursor: default; }
.dss-btn:focus-visible, .dss-segment:focus-visible, .dss-filter:focus-visible, .dss-tag:focus-visible, .dss-icon-btn:focus-visible, .dss-input-toggle:focus-visible {
  outline: 2px solid var(--dss-accent); outline-offset: 2px;
}
.dss-btn[data-primary="true"] { background: var(--dss-accent); color: #fff; }
.dss-btn[data-primary="true"]:hover:not(:disabled) { background: color-mix(in srgb, var(--dss-accent) 88%, #000); }
.dss-btn[data-danger="true"] { background: color-mix(in srgb, var(--dss-bad) 12%, transparent); color: var(--dss-bad); }
.dss-btn[data-danger="true"]:hover:not(:disabled) { background: color-mix(in srgb, var(--dss-bad) 18%, transparent); }
.dss-btn-sm { height: 30px; padding: 0 12px; font-size: 12.5px; }
.dss-icon-btn {
  width: 30px; height: 30px; border: 0; border-radius: 999px; background: var(--dss-hover); cursor: pointer;
  font-size: 18px; line-height: 30px; color: var(--dss-text-2);
}
.dss-link { border: 0; background: none; padding: 0; color: var(--dss-accent); cursor: pointer; font-size: 12px; }

/* ---------- segmented control ---------- */
.dss-segmented { display: inline-flex; align-self: flex-start; gap: 2px; padding: 3px; border-radius: 999px; background: var(--dss-fill-2); max-width: 100%; overflow-x: auto; }
.dss-segment {
  height: 32px; padding: 0 18px; border: 0; border-radius: 999px; background: transparent; cursor: pointer;
  font-size: 13.5px; color: var(--dss-text-2); white-space: nowrap; transition: background 0.15s ease, color 0.15s ease;
}
.dss-segment:hover { color: var(--dss-text); }
.dss-segment[data-on="true"] {
  background: var(--dss-base); color: var(--dss-accent); font-weight: 600;
  box-shadow: 0 0 0 0.5px color-mix(in srgb, var(--dss-text) 10%, transparent), 0 1px 3px color-mix(in srgb, var(--dss-text) 10%, transparent);
}

/* ---------- sections ---------- */
.dss-section { display: flex; flex-direction: column; gap: 16px; }
.dss-section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px 16px; flex-wrap: wrap; }
.dss-section-title { margin: 0; font-size: 17px; line-height: 26px; font-weight: 600; }

/* ---------- write-only notice ---------- */
.dss-notice { display: flex; gap: 12px; padding: 16px 18px; border-radius: 14px; background: color-mix(in srgb, var(--dss-warn) 12%, var(--dss-base)); }
.dss-notice-icon { flex: none; color: color-mix(in srgb, var(--dss-warn) 85%, var(--dss-text)); margin-top: 1px; }
.dss-notice-body { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dss-notice-title { font-weight: 600; font-size: 14px; color: color-mix(in srgb, var(--dss-warn) 60%, var(--dss-text)); }
.dss-notice-text { margin: 0; font-size: 13px; line-height: 20px; color: var(--dss-text-2); }

/* ---------- vault status ---------- */
.dss-status { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 14px; font-size: 12.5px; color: var(--dss-text-2); }
.dss-chip {
  display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 11px; border-radius: 999px; flex: none;
  background: color-mix(in srgb, var(--dss-tone, var(--dss-idle)) 14%, transparent);
  color: color-mix(in srgb, var(--dss-tone, var(--dss-idle)) 70%, var(--dss-text)); font-weight: 600; font-size: 12.5px;
}
.dss-chip::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--dss-tone, var(--dss-idle)); }
.dss-page [data-tone="unlocked"] { --dss-tone: var(--dss-ok); }
.dss-page [data-tone="missing"] { --dss-tone: var(--dss-idle); }
.dss-page [data-tone="locked"] { --dss-tone: var(--dss-warn); }
.dss-page [data-tone="error"] { --dss-tone: var(--dss-bad); }
.dss-status-sep { color: var(--dss-text-3); }
.dss-status-path { font-family: var(--dss-mono); font-size: 12px; color: var(--dss-text-3); overflow-wrap: anywhere; }
.dss-status-key[data-ok="false"] { color: var(--dss-warn); }

/* ---------- banners ---------- */
.dss-banner { display: flex; flex-direction: column; gap: 4px; padding: 14px 18px; border-radius: 14px; background: var(--dss-fill); }
.dss-banner[data-tone] { background: color-mix(in srgb, var(--dss-tone) 10%, var(--dss-base)); }
.dss-banner-title { font-weight: 600; }
.dss-banner-text { margin: 0; font-size: 13px; color: var(--dss-text-2); }
.dss-banner-detail { margin: 0; font-family: var(--dss-mono); font-size: 12px; color: var(--dss-text-3); overflow-wrap: anywhere; }

/* ---------- toolbar ---------- */
.dss-toolbar { display: flex; flex-direction: column; gap: 10px; }
.dss-search, .dss-input {
  width: 100%; height: 40px; padding: 0 14px; border: 0; border-radius: 12px; background: var(--dss-fill-2);
  outline: none; font-size: 13.5px; transition: box-shadow 0.15s ease;
}
.dss-search { max-width: 420px; }
.dss-search:focus, .dss-input:focus { box-shadow: inset 0 0 0 1.5px var(--dss-accent); }
.dss-textarea { height: auto; min-height: 64px; padding: 10px 14px; resize: vertical; line-height: 20px; }
.dss-tags-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.dss-filter {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 12px; border: 0; border-radius: 999px;
  background: var(--dss-fill-2); cursor: pointer; font-size: 12.5px;
}
.dss-filter:hover { background: var(--dss-hover); }
.dss-filter[data-on="true"] { background: var(--dss-accent-soft); color: var(--dss-accent); font-weight: 600; }
.dss-filter-count { color: var(--dss-text-3); font-variant-numeric: tabular-nums; }
.dss-filter[data-on="true"] .dss-filter-count { color: inherit; opacity: 0.75; }
.dss-toolbar-foot { display: flex; align-items: center; gap: 12px; font-size: 12px; color: var(--dss-text-3); }

/* ---------- table (no grid lines; whole-row rounded hover) ---------- */
.dss-table-wrap { overflow-x: auto; border-radius: 24px; background: var(--dss-fill); padding: 8px; }
.dss-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; }
.dss-table th {
  text-align: left; font-weight: 500; font-size: 12px; color: var(--dss-text-3); padding: 8px 12px; white-space: nowrap;
}
.dss-table td { padding: 11px 12px; vertical-align: top; }
.dss-table tbody tr td:first-child { border-radius: 12px 0 0 12px; }
.dss-table tbody tr td:last-child { border-radius: 0 12px 12px 0; }
.dss-table tbody tr:hover td { background: var(--dss-hover); }
.dss-cell-name code { font-weight: 600; font-size: 13px; overflow-wrap: anywhere; }
.dss-cell-desc { min-width: 180px; max-width: 380px; color: var(--dss-text-2); overflow-wrap: anywhere; white-space: pre-wrap; }
.dss-cell-tags { min-width: 110px; }
.dss-cell-tags-list { display: flex; flex-wrap: wrap; gap: 4px; }
.dss-tag {
  height: 22px; padding: 0 9px; border: 0; border-radius: 999px; background: var(--dss-base); color: var(--dss-text-2);
  font-size: 12px; cursor: pointer;
}
.dss-tag:hover { background: var(--dss-hover); }
.dss-tag[data-on="true"] { background: var(--dss-accent-soft); color: var(--dss-accent); }
.dss-cell-fp code { padding: 2px 8px; border-radius: 999px; background: var(--dss-base); letter-spacing: 0.04em; white-space: nowrap; }
.dss-cell-len { white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--dss-text-2); }
.dss-cell-time { white-space: nowrap; font-variant-numeric: tabular-nums; }
.dss-cell-time span { display: block; }
.dss-cell-actions { width: 1%; }
.dss-row-actions { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: nowrap; }
.dss-table .dss-row-actions { opacity: 0.55; transition: opacity 0.15s ease; }
.dss-table tbody tr:hover .dss-row-actions, .dss-table .dss-row-actions:focus-within { opacity: 1; }
.dss-table .dss-btn-sm { background: var(--dss-base); }
.dss-table .dss-btn-sm[data-danger="true"] { background: color-mix(in srgb, var(--dss-bad) 12%, var(--dss-base)); }
.dss-muted { color: var(--dss-text-3); }
.dss-cell-time .dss-muted { font-size: 12px; line-height: 17px; }

/* ---------- list rows (credentials) ---------- */
.dss-list { display: flex; flex-direction: column; gap: 2px; padding: 8px; border-radius: 24px; background: var(--dss-fill); }
.dss-list-row { display: flex; align-items: center; gap: 12px; min-height: 56px; padding: 8px 12px; border-radius: 12px; transition: background 0.15s ease; }
.dss-list-row:hover { background: var(--dss-hover); }
.dss-list-main { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.dss-list-name { font-weight: 600; font-size: 13px; overflow-wrap: anywhere; }
.dss-list-sub { font-size: 12.5px; color: var(--dss-text-3); }
.dss-list-state { font-size: 12.5px; color: var(--dss-text-2); white-space: nowrap; }
.dss-list-row .dss-btn-sm { background: var(--dss-base); }
.dss-list-row .dss-btn-sm[data-danger="true"] { background: color-mix(in srgb, var(--dss-bad) 12%, var(--dss-base)); }
.dss-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dss-idle); }
.dss-dot[data-state="ok"] { background: var(--dss-ok); }
.dss-dot[data-state="warn"] { background: var(--dss-warn); }
.dss-dot[data-state="bad"] { background: var(--dss-bad); }

/* ---------- plugin cards ---------- */
.dss-cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.dss-card { display: flex; flex-direction: column; gap: 14px; padding: 24px 26px; border-radius: 24px; background: var(--dss-fill); }
.dss-card[data-installed="false"] { opacity: 0.62; }
.dss-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.dss-card-title-wrap { min-width: 0; }
.dss-card-title { margin: 0; font-size: 17px; line-height: 26px; font-weight: 600; font-family: var(--dss-mono); }
.dss-card-sub { margin: 2px 0 0; font-size: 13px; line-height: 20px; color: var(--dss-text-2); }
.dss-card-note { margin: 0; font-size: 12.5px; line-height: 19px; color: var(--dss-text-3); overflow-wrap: anywhere; }
.dss-needs { display: flex; flex-direction: column; gap: 2px; margin: 0 -10px; }
.dss-need { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 12px; }
.dss-need:hover { background: var(--dss-hover); }
.dss-need-main { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.dss-need-name { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; flex-wrap: wrap; }
.dss-need-tag { font-size: 11.5px; font-weight: 500; color: var(--dss-text-3); }
.dss-need-detail { font-size: 12.5px; color: var(--dss-text-3); overflow-wrap: anywhere; }
.dss-need-detail[data-mono="true"] { font-family: var(--dss-mono); font-size: 12px; color: var(--dss-text-2); }
.dss-need .dss-btn-sm { background: var(--dss-base); }

/* ---------- sheet ---------- */
.dss-sheet-backdrop {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 24px;
  background: color-mix(in srgb, var(--dss-text) 28%, transparent); animation: dss-fade 0.15s ease;
}
.dss-sheet {
  width: 100%; max-width: 460px; max-height: calc(100% - 24px); overflow-y: auto; padding: 22px 24px 24px; border-radius: 24px;
  background: var(--dss-base); color: var(--dss-text); box-shadow: var(--dss-shadow);
}
.dss-sheet-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.dss-sheet-title { margin: 0; font-size: 17px; line-height: 26px; font-weight: 600; overflow-wrap: anywhere; }
.dss-sheet-form { display: flex; flex-direction: column; gap: 14px; }
.dss-sheet-text { margin: 0; font-size: 13px; line-height: 20px; color: var(--dss-text-2); }
.dss-sheet-error { margin: 0; padding: 10px 14px; border-radius: 12px; font-size: 13px; background: color-mix(in srgb, var(--dss-bad) 9%, var(--dss-base)); color: var(--dss-bad); overflow-wrap: anywhere; }
.dss-sheet-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
.dss-btn-left { margin-right: auto; }
.dss-field { display: flex; flex-direction: column; gap: 6px; }
.dss-field-label { font-size: 12px; color: var(--dss-text-3); font-weight: 500; }
.dss-field-hint { font-size: 12px; color: var(--dss-text-3); }
.dss-secret-input { position: relative; }
.dss-secret-input .dss-input { padding-right: 64px; font-family: var(--dss-mono); }
.dss-input-toggle {
  position: absolute; top: 5px; right: 5px; height: 30px; padding: 0 12px; border: 0; border-radius: 999px;
  background: var(--dss-base); cursor: pointer; font-size: 12px; color: var(--dss-text-2);
}
.dss-check { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--dss-text-2); cursor: pointer; }
.dss-check input { accent-color: var(--dss-accent); width: 16px; height: 16px; }

/* ---------- toast ---------- */
.dss-toast {
  position: absolute; left: 50%; bottom: 28px; transform: translateX(-50%); max-width: calc(100% - 32px);
  padding: 10px 18px; border-radius: 999px; background: var(--dss-base); box-shadow: var(--dss-shadow);
  font-size: 13.5px; font-weight: 500; animation: dss-rise 0.2s ease;
}
.dss-toast[data-tone="ok"]::before { content: "\u2713 "; color: var(--dss-ok); }
.dss-toast[data-tone="bad"] { color: var(--dss-bad); }

/* ---------- empty / error / loading ---------- */
.dss-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 56px 16px; text-align: center; }
.dss-empty-title { font-weight: 600; font-size: 15px; }
.dss-empty-hint { max-width: 520px; font-size: 13px; color: var(--dss-text-3); }
.dss-empty .dss-btn { margin-top: 10px; }
.dss-empty[data-bad="true"] .dss-empty-title { color: var(--dss-bad); }

@keyframes dss-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes dss-rise { from { opacity: 0; transform: translate(-50%, 6px); } to { opacity: 1; transform: translate(-50%, 0); } }

@container (max-width: 760px) {
  .dss-col { padding: 0 16px 40px; gap: 16px; }
  .dss-head { padding-top: 24px; }
  .dss-cards { grid-template-columns: minmax(0, 1fr); }
  .dss-card { padding: 20px; }
  .dss-cell-desc { min-width: 150px; }
  .dss-list-row { flex-wrap: wrap; }
  .dss-list-state { order: 3; width: 100%; padding-left: 20px; white-space: normal; }
  .dss-row-actions { flex-wrap: wrap; }
  .dss-table .dss-row-actions { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .dss-btn, .dss-segment, .dss-list-row, .dss-input, .dss-search, .dss-table .dss-row-actions { transition: none; }
  .dss-sheet-backdrop, .dss-toast { animation: none; }
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
