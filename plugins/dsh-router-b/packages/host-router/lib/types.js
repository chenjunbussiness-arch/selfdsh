/**
 * The host-plugin contract this package binds to, declared structurally.
 *
 * Why these types are local rather than imported from `@deepseek-ai/*`:
 *
 * - The runtime and the source checkout in this workspace are different rc
 *   builds (running desktop 0.2.2-rc.3 / cordis 4.1.0, checkout 0.2.2-rc.5).
 *   Importing the checkout's sources would type-check against the wrong build,
 *   and it would drag that whole project graph into this package's program.
 * - Every field below was read out of the *running* build's bundled JavaScript
 *   (`.../app.asar/dsh/node_modules/@deepseek-ai/dsh-subagent/lib/index.js` and
 *   `dsh-tool-subagent/lib/index.js`) rather than guessed from a README, so the
 *   shapes track the API this plugin actually calls. `README.md` records the
 *   exact call sites.
 *
 * The narrow structural surface is also the point: this plugin only needs the
 * subagent seam, a tool registry, an event bus, and a logger. Anything wider
 * would be an unverified assumption.
 *
 * @module host-router/types
 */
export {};
//# sourceMappingURL=types.js.map