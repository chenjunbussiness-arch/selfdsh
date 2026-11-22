/**
 * Main-panel stand-in for the old Routing page.
 *
 * The Sidebar row selects a main panel by key, so a row cannot run a custom
 * action directly. This panel is that action: on mount it opens the 作战室
 * Session, which selects the conversation panel and unmounts this one.
 *
 * @module client-ui-router/warroom-redirect
 */
/** Props supplied by the main-panel registration. */
export interface WarRoomRedirectProps {
    readonly t: (key: string) => string;
    readonly open: () => void;
}
/**
 * Open the war-room chat as soon as this panel shows.
 * @param props - translate and the open action.
 * @returns a short placeholder with a manual button.
 */
export declare function WarRoomRedirect({ t, open }: WarRoomRedirectProps): import("react").JSX.Element;
