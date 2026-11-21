/**
 * The host-plugin contract this package binds to, declared structurally.
 *
 * Same rule as `dsh-host-router`: no `@deepseek-ai/*` import at runtime or in
 * types, because the compatibility preflight in `dsh-app-boot` treats such a
 * peer as a hard version lock. Every shape below was read from the running
 * 0.2.2-rc.3 build (see `docs/API-0.2.2-rc.3.md` in dsh-router-b:
 * `ctx.tools.register`, `ctx.inject(['webServer'], …)`, `webServer.register`).
 *
 * @module host-vpn/types
 */
export {};
