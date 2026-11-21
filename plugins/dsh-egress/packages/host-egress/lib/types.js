/**
 * The host-plugin contract this package binds to, declared structurally.
 *
 * Same convention as `dsh-host-router`: no `@deepseek-ai/*` import at runtime or
 * for types, so the package type-checks and loads on any DSH build. Shapes were
 * read from the running build (`ctx.tools.register`, `ctx.inject(['webServer'])`,
 * `webServer.register({ kind, path, handler })`).
 *
 * @module host-egress/types
 */
export {};
