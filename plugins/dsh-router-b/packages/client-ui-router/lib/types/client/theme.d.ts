/**
 * Light and dark for the board and the workspace page.
 *
 * The person picks 跟随系统 (default), 白天 or 黑夜 in the panel header. The
 * choice is a per-browser convenience kept in `localStorage`; reading or writing
 * it never throws (private windows, blocked storage), and without it the panel
 * follows the system.
 *
 * "System" means: the host shell's own dark switch when it sets one
 * (`body[data-ds-dark-theme]`), otherwise the operating system's
 * `prefers-color-scheme`. Both are watched, so flipping either repaints at once.
 *
 * The effective theme is written as `data-theme="light|dark"` on the panel root;
 * every colour in the stylesheet hangs off that attribute (see BOARD_TOKENS_CSS).
 *
 * @module client-ui-router/theme
 */
/** What the person chose. */
export type ThemePref = 'auto' | 'light' | 'dark';
/** What is painted. */
export type ThemeMode = 'light' | 'dark';
export declare const THEME_STORAGE_KEY = "dshr.theme";
/** The stored choice; `auto` when absent, unreadable or unknown. */
export declare function readThemePref(): ThemePref;
/** Store a choice and tell every mounted panel. */
export declare function writeThemePref(pref: ThemePref): void;
/** The system's mode: the host's dark switch when present, else the OS preference. */
export declare function systemMode(): ThemeMode;
/** Resolve a choice to what is painted. */
export declare const resolveTheme: (pref: ThemePref, system: ThemeMode) => ThemeMode;
/**
 * The panel's theme: the stored choice, the mode it resolves to, and a setter.
 * Re-renders when the choice changes in another panel or the system flips.
 */
export declare function useBoardTheme(): {
    pref: ThemePref;
    mode: ThemeMode;
    setPref: (pref: ThemePref) => void;
};
/**
 * One icon button that cycles 跟随系统 → 白天 → 黑夜. Its tooltip names the
 * current choice and the next one.
 */
export declare function ThemeButton({ pref, setPref, t, className }: {
    readonly pref: ThemePref;
    readonly setPref: (pref: ThemePref) => void;
    readonly t: (key: string, values?: Record<string, string | number>) => string;
    readonly className: string;
}): import("react").JSX.Element;
