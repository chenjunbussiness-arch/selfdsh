/**
 * Left-sidebar block 「模型档位」: one select per difficulty tier plus the
 * 「自动按难度选择」 switch. Registered as its own `sidebar.footer.action` entry
 * (`id: model-tiers`), so it adds a row and replaces nobody.
 *
 * Reads and writes `GET|POST /api/router/tiers` (host-router bridge). A save
 * applies to the next dispatch; nothing needs a reload.
 */
/** Install the stylesheet once. */
export declare function installModelTierStyles(): void;
/** The sidebar block. `wide` is false in the collapsed rail, where it hides. */
export declare function ModelTiers({ wide }: {
    wide?: boolean;
}): import("react/jsx-runtime").JSX.Element | null;
