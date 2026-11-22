/**
 * Difficulty tiers: decide how hard a routed task is, then pick the model route
 * its child runs on.
 *
 * Three tiers, `easy | medium | hard`, each bound to one `{provider, model,
 * reasoningEffort?}` route. Order of decision for one task:
 *
 * 1. explicit — `route_task({ tier })` or a `[tier:hard]` marker in the text;
 * 2. rules — read-only / modify / large-change keywords, file count, build+UI;
 * 3. LLM — one short call on the easy-tier route, answering `easy|medium|hard`;
 * 4. fallback — `medium`.
 *
 * The configuration lives in `<boardDir>/tiers.json` and is written by the
 * panel (`POST /api/router/tiers`). Only what the user saved is stored; the
 * defaults are recomputed from the live model list, so a provider added later
 * shows up without a migration.
 *
 * @module host-router/tier
 */
/** The three difficulty tiers. */
export type Tier = 'easy' | 'medium' | 'hard';
/** All tiers, cheapest first. */
export declare const TIERS: readonly Tier[];
/** One model route. */
export interface TierRoute {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string;
}
/** How the tier of one task was decided. */
export type TierSource = 'explicit' | 'rule' | 'llm' | 'fallback';
/** One classification. */
export interface TierDecision {
    readonly tier: Tier;
    readonly source: TierSource;
    readonly reason: string;
}
/**
 * Model of every partition manager.
 *
 * - absent or `'strongest'`: the saved `hard` route, else the strongest model the
 *   runtime advertises (see `strongestRoute`), at its highest reasoning effort;
 * - `'inherit'`: the dispatcher's own model (the old behaviour);
 * - a route: exactly that model.
 */
export type ManagerModel = 'strongest' | 'inherit' | TierRoute;
/** Persisted user choice. */
export interface TierSettings {
    /** `false` means every task inherits the dispatcher's model (the old behaviour). */
    readonly auto: boolean;
    readonly tiers: Partial<Record<Tier, TierRoute>>;
    /** Manager model; absent means `'strongest'`. Applies whether or not `auto` is on. */
    readonly manager?: ManagerModel;
}
/** One model offered to the panel. */
export interface ModelOption {
    readonly provider: string;
    readonly providerName: string;
    readonly model: string;
    readonly name: string;
    readonly efforts?: readonly string[];
}
/** Is this a tier name? */
export declare function isTier(value: unknown): value is Tier;
/**
 * Read an explicit `[tier:x]` marker.
 * @param text - task text.
 * @returns the tier, or undefined when no marker is present.
 */
export declare function tierTagOf(text: string): Tier | undefined;
/**
 * Rule-only classification.
 * @param text - task text.
 * @param files - files the task names, when given.
 * @returns a decision, or undefined when the rules cannot tell.
 */
export declare function classifyByRules(text: string, files?: readonly string[]): TierDecision | undefined;
/** One LLM call: system + prompt in, text out. */
export type TierModelCall = (route: TierRoute, system: string, prompt: string) => Promise<string>;
/**
 * Full classification: explicit, rules, LLM, fallback.
 * @param input - task text, files, and an explicit tier when given.
 * @param llm - one LLM call on the easy route, or undefined when unavailable.
 * @param easyRoute - the easy-tier route used for the LLM call.
 * @returns the decision; never throws.
 */
export declare function classifyTier(input: {
    readonly text: string;
    readonly files?: readonly string[];
    readonly tier?: string;
}, llm: TierModelCall | undefined, easyRoute: TierRoute | undefined): Promise<TierDecision>;
/**
 * Default routes from the live model list.
 * @param models - every advertised model.
 * @param fallback - the profile default selection.
 * @returns one route per tier.
 */
export declare function defaultTiers(models: readonly ModelOption[], fallback: TierRoute | undefined): Record<Tier, TierRoute | undefined>;
/** Higher is stronger: flagship wording up, cheap wording down. */
export declare function strength(name: string): number;
/** The largest version number in a model name (`claude-opus-5.5` -> 5.5), 0 when none. */
export declare function versionOf(name: string): number;
/**
 * The strongest advertised model, at its highest reasoning effort.
 *
 * Ranked by flagship wording, then version number, then how many reasoning
 * efforts it offers. Ties keep the profile's default model when it is among
 * them, so an install with one family and no flagship wording simply keeps its
 * default. Returns the fallback when nothing is advertised.
 */
export declare function strongestRoute(models: readonly ModelOption[], fallback: TierRoute | undefined): TierRoute | undefined;
/** Raise a route to the highest reasoning effort its model offers. */
export declare function atTopEffort(route: TierRoute, models: readonly ModelOption[]): TierRoute;
/**
 * Resolve the manager's model route and say where it came from.
 * @returns `route` undefined means inherit the dispatcher's model.
 */
export declare function managerRouteOf(settings: TierSettings, models: readonly ModelOption[], fallback: TierRoute | undefined): {
    readonly route?: TierRoute;
    readonly source: 'saved' | 'hard' | 'strongest' | 'inherit';
};
/** Durable tier settings in one JSON file. */
export declare class TierStore {
    private readonly file;
    private settings;
    private constructor();
    /** Open (or start) the settings file. */
    static open(file: string): Promise<TierStore>;
    /** Current saved settings. */
    get(): TierSettings;
    /** Replace and persist. */
    set(next: TierSettings): Promise<TierSettings>;
}
/** Validate a settings document; unknown fields are dropped. */
export declare function normaliseSettings(raw: Partial<TierSettings> | undefined): TierSettings;
/** Validate a manager model choice; anything unreadable means the default. */
export declare function normaliseManager(raw: unknown): ManagerModel | undefined;
