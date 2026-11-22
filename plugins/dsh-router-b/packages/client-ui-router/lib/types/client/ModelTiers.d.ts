/**
 * Left-sidebar block 「模型档位」.
 *
 * Collapsed: a full-width card summarising which model each difficulty tier
 * uses (初级 / 中级 / 高级) and whether automatic tier selection is on.
 * Expanded: a popover anchored above the card with, per tier, a model picker
 * grouped by provider, a reasoning-effort picker (when the model has efforts),
 * and a reset-to-default action, plus the 「自动按难度选择」 switch.
 *
 * Registered as its own `sidebar.footer.action` entry (`id: model-tiers`), so it
 * adds a row and replaces nobody. Reads and writes `GET|POST /api/router/tiers`
 * (host-router bridge). A save applies to the next dispatch; nothing reloads.
 */
/** Install the stylesheet once. */
export declare function installModelTierStyles(): void;
/** The sidebar block. `wide` is false in the collapsed rail, where it hides. */
export declare function ModelTiers({ wide }: {
    wide?: boolean;
}): import("react").JSX.Element | null;
