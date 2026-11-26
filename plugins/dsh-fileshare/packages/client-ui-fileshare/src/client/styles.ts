/**
 * Page stylesheet, per docs/UI-STYLE.md: one accent, no hairline borders
 * (layers by fill and spacing), pill buttons, colours from the shell's
 * `--dsw-alias-*` tokens so light and dark follow the shell. Prefix `dsf-`.
 */

const STYLE_KEY = 'dsh-client-ui-fileshare/page.css'

export const FILESHARE_CSS = `
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
`

export function installStyles(): void {
  if (typeof document === 'undefined') return
  const selector = `style[data-plugin-css=${JSON.stringify(STYLE_KEY)}]`
  if (document.querySelector(selector) !== null) return
  const tag = document.createElement('style')
  tag.dataset['plugin'] = 'dsh-client-ui-fileshare'
  tag.dataset['pluginCss'] = STYLE_KEY
  tag.textContent = FILESHARE_CSS
  document.head.appendChild(tag)
}
