/**
 * Declarative file partitions and task-to-partition routing.
 *
 * A partition is a named set of files: one absolute `root`, optional include and
 * exclude globs relative to it, and the operational knobs the dispatch side
 * needs (concurrency, preset, acceptance commands, standing brief). Everything
 * here is pure — no Cordis, no filesystem, no clock — so the routing rules are
 * testable without booting a harness. That matters: a wrong route silently sends
 * work into the wrong repository, and no agent inside the worker can notice.
 *
 * @module host-router/config
 */
import { isAbsolute, resolve } from 'node:path';
import { REPORT_INSTRUCTION } from "./report.js";
/**
 * Defaults for {@link CredentialRefConfig}.
 *
 * Both names are the ones the running build actually resolves: `DEEPSEEK_API_KEY`
 * (`dsh-llm-deepseek-api-key/src/config.ts:25`) and `EXA_API_KEY`
 * (`dsh-web-search-exa/lib/index.js:146`). Listing another provider is a config
 * change, not a code change.
 */
export const DEFAULT_CREDENTIAL_REFS = [
    { id: 'deepseek', ref: 'DEEPSEEK_API_KEY', label: 'DeepSeek' },
    { id: 'exa', ref: 'EXA_API_KEY', label: 'Exa' },
];
/**
 * Default prompt-side context ceiling, in tokens.
 *
 * 256k, not the model's window: quality, not capacity, is the binding limit.
 * A session that has already spent 256k prompt tokens on its own history is
 * re-reading more than it is thinking, which is the observed way a worker
 * "forgets what it was doing" while still having room left in the window.
 */
export const DEFAULT_CONTEXT_LIMIT = 262_144;
/** Raised for configuration a deployment must fix, not for a task-level mistake. */
export class PartitionConfigError extends Error {
    constructor(message) {
        super(`host-router config: ${message}`);
        this.name = 'PartitionConfigError';
    }
}
/** Raised when a task cannot be attributed to exactly one partition. */
export class RouteError extends Error {
    candidates;
    constructor(message, candidates = []) {
        super(message);
        this.candidates = candidates;
        this.name = 'RouteError';
    }
}
/** Paths compare case-insensitively on Windows, where a drive letter has two spellings. */
const CASE_INSENSITIVE = process.platform === 'win32';
/** Convert Windows separators to POSIX so a glob means one thing on every host. */
export function toPosix(path) {
    return path.replace(/\\/g, '/');
}
/**
 * Translate one glob to a regular expression.
 *
 * The syntax is deliberately small: `**` crosses separators, `*` and `?` do not,
 * everything else is literal. It is not minimatch — a partition config that needs
 * brace expansion or negation is expressing something this router should model
 * explicitly instead.
 * @param pattern - glob relative to a partition root.
 * @returns an anchored regular expression.
 */
export function globToRegExp(pattern) {
    const normalised = toPosix(pattern).replace(/^\.\//, '');
    let source = '';
    for (let index = 0; index < normalised.length; index++) {
        const char = normalised[index];
        if (char === '*') {
            if (normalised[index + 1] === '*') {
                // `**/` may match zero directories so `**/*.ts` also matches `a.ts`.
                if (normalised[index + 2] === '/') {
                    source += '(?:.*/)?';
                    index += 2;
                }
                else {
                    source += '.*';
                    index += 1;
                }
            }
            else {
                source += '[^/]*';
            }
            continue;
        }
        if (char === '?') {
            source += '[^/]';
            continue;
        }
        source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${source}$`, CASE_INSENSITIVE ? 'i' : '');
}
/** The relative POSIX path of `candidate` under `dir`, or undefined when outside. */
export function relativeUnder(dir, candidate) {
    const base = toPosix(dir).replace(/\/+$/, '');
    const target = toPosix(candidate);
    const baseCmp = CASE_INSENSITIVE ? base.toLowerCase() : base;
    const targetCmp = CASE_INSENSITIVE ? target.toLowerCase() : target;
    if (targetCmp === baseCmp)
        return '';
    if (!targetCmp.startsWith(`${baseCmp}/`))
        return undefined;
    return target.slice(base.length + 1);
}
/** Whether one absolute file path is a member of the partition. */
export function containsFile(partition, file) {
    const relative = relativeUnder(partition.dir, file);
    if (relative === undefined)
        return false;
    const include = partition.include ?? ['**'];
    if (!include.some(pattern => globToRegExp(pattern).test(relative)))
        return false;
    const exclude = partition.exclude ?? [];
    return !exclude.some(pattern => globToRegExp(pattern).test(relative));
}
/**
 * Validate and normalise the partition list.
 *
 * Validation is eager and fatal: a partition with a relative root, a duplicate
 * name, or zero slots would otherwise fail per task, at the moment a worker is
 * already supposed to start. The error names the offending field so a deployment
 * fixes config instead of guessing.
 * @param partitions - raw configuration list.
 * @param defaults - router-level defaults applied to every partition.
 * @returns normalised partitions in configuration order.
 * @throws {PartitionConfigError} on any invalid entry.
 */
export function normalisePartitions(partitions, defaults) {
    if (partitions.length === 0) {
        throw new PartitionConfigError('at least one partition is required');
    }
    const names = new Set();
    const result = [];
    for (const partition of partitions) {
        if (typeof partition.name !== 'string' || partition.name.trim() === '') {
            throw new PartitionConfigError('every partition needs a non-empty name');
        }
        if (names.has(partition.name)) {
            throw new PartitionConfigError(`duplicate partition name "${partition.name}"`);
        }
        names.add(partition.name);
        if (typeof partition.root !== 'string' || !isAbsolute(partition.root)) {
            throw new PartitionConfigError(`partition "${partition.name}" needs an absolute root`);
        }
        const slots = partition.workers ?? defaults.workers;
        if (!Number.isInteger(slots) || slots < 0) {
            throw new PartitionConfigError(`partition "${partition.name}" needs workers >= 0 (0 = unlimited)`);
        }
        for (const pattern of [...partition.include ?? [], ...partition.exclude ?? []]) {
            if (typeof pattern !== 'string' || pattern === '') {
                throw new PartitionConfigError(`partition "${partition.name}" has an empty glob`);
            }
        }
        if (partition.network !== undefined
            && partition.network !== 'intranet'
            && partition.network !== 'internet'
            && partition.network !== 'offline') {
            throw new PartitionConfigError(`partition "${partition.name}" has network "${String(partition.network)}"; `
                + 'expected intranet, internet, or offline');
        }
        result.push({
            ...partition,
            dir: resolve(partition.root),
            slots,
            managerEnabled: partition.manager ?? defaults.manager,
        });
    }
    return result;
}
/** Deepest partition whose membership contains `file`; nesting resolves to the tighter root. */
export function partitionOfFile(partitions, file) {
    return partitions
        .filter(partition => containsFile(partition, file))
        .sort((left, right) => right.dir.length - left.dir.length)[0];
}
/**
 * Score free text against one partition.
 *
 * Signals are coarse and additive so a human can predict the outcome: a named
 * partition wins, a literal path inside it is strong, keyword hits rank the rest.
 * Nothing here guesses by similarity — a confident wrong route is worse than a
 * question.
 * @param partition - candidate partition.
 * @param text - the human's task text.
 * @returns a non-negative score; zero means "no evidence".
 */
export function scoreText(partition, text, extraKeywords = []) {
    const haystack = text.toLowerCase();
    let score = 0;
    if (haystack.includes(partition.name.toLowerCase()))
        score += 4;
    const seen = new Set();
    for (const keyword of [...partition.keywords ?? [], ...extraKeywords]) {
        const needle = keyword.toLowerCase();
        if (needle === '' || seen.has(needle))
            continue;
        seen.add(needle);
        if (haystack.includes(needle))
            score += 2;
    }
    for (const token of text.split(/[\s"'`()<>[\]{},;]+/)) {
        if (!isAbsolute(token))
            continue;
        if (containsFile(partition, token))
            score += 6;
        else if (relativeUnder(partition.dir, token) !== undefined)
            score += 3;
    }
    return score;
}
/**
 * Resolve a task to exactly one partition.
 *
 * Precedence is explicit name, then explicit files, then free text, then the
 * configured default. Ambiguity is an error rather than a coin flip: two
 * partitions tied on evidence means the config cannot answer, and a wrong guess
 * costs a whole worker session in the wrong repository.
 * @param partitions - normalised partitions.
 * @param input - explicit partition name, explicit files, or free text.
 * @param fallback - configured default partition name, if any.
 * @returns the decision plus its evidence trail.
 * @throws {RouteError} when the target is unknown, ambiguous, or unstated.
 */
export function resolveRoute(partitions, input, fallback, extraKeywords) {
    if (input.partition !== undefined) {
        const named = partitions.find(partition => partition.name === input.partition);
        if (named === undefined) {
            throw new RouteError(`unknown partition "${input.partition}"`, partitions.map(entry => entry.name));
        }
        return { partition: named, reason: 'explicit', because: [`named "${named.name}"`] };
    }
    const files = input.files ?? [];
    if (files.length > 0) {
        const owners = new Set();
        const evidence = [];
        for (const file of files) {
            if (!isAbsolute(file))
                throw new RouteError(`file "${file}" is not an absolute path`);
            const owner = partitionOfFile(partitions, file);
            if (owner === undefined) {
                throw new RouteError(`no partition contains "${file}"`, partitions.map(entry => entry.name));
            }
            owners.add(owner.name);
            evidence.push(`${file} -> ${owner.name}`);
        }
        if (owners.size > 1) {
            throw new RouteError(`files span several partitions (${[...owners].join(', ')}); split the task`, [...owners]);
        }
        const ownerName = [...owners][0];
        const owner = partitions.find(partition => partition.name === ownerName);
        if (owner === undefined)
            throw new RouteError('internal: resolved owner disappeared');
        return { partition: owner, reason: 'files', because: evidence };
    }
    const text = input.text ?? '';
    const scored = partitions
        .map(partition => ({ partition, score: scoreText(partition, text, extraKeywords?.(partition) ?? []) }))
        .filter(entry => entry.score > 0)
        .sort((left, right) => right.score - left.score);
    const best = scored[0];
    if (best !== undefined) {
        const tied = scored.filter(entry => entry.score === best.score);
        if (tied.length > 1) {
            throw new RouteError(`text matches ${tied.map(entry => entry.partition.name).join(' and ')} equally; name one`, tied.map(entry => entry.partition.name));
        }
        return {
            partition: best.partition,
            reason: 'auto',
            because: [`score ${String(best.score)} from name/keyword/path evidence`],
        };
    }
    if (fallback !== undefined) {
        const named = partitions.find(partition => partition.name === fallback);
        if (named === undefined) {
            throw new RouteError(`default partition "${fallback}" does not exist`, partitions.map(entry => entry.name));
        }
        return { partition: named, reason: 'default', because: [`no evidence; default "${named.name}"`] };
    }
    throw new RouteError('no partition matched; pass partition or files, or configure defaultPartition', partitions.map(entry => entry.name));
}
/** Default unique keyword score that routes without the LLM: one name hit or two keyword hits. */
export const DEFAULT_AUTO_ROUTE_MIN_SCORE = 4;
/** Smallest classifier confidence the router accepts. */
export const CLASSIFIER_MIN_CONFIDENCE = 0.5;
/**
 * Directory names too generic to count as routing evidence. A top-level
 * `docs/` or `tools/` exists in several partitions and says nothing about
 * which one a request means.
 */
const GENERIC_DIRS = new Set([
    'docs', 'doc', 'tools', 'tool', 'scripts', 'script', 'deploy', 'memory', 'context', 'agents',
    'messages', 'todo', 'skills', 'proto', 'packages', 'platform', 'dashboard', 'ledger', 'src', 'lib',
    'test', 'tests', 'tmp', 'output', 'workspace', 'locale', 'subscriptions',
]);
/**
 * Top-level directory names that are specific enough to act as keywords.
 * @param dirs - one partition's top-level directory names.
 * @returns lower-cased names, generic and dot/underscore-prefixed ones removed.
 */
export function directoryKeywords(dirs) {
    return dirs
        .map(dir => dir.trim().toLowerCase())
        .filter(dir => dir.length >= 4 && !dir.startsWith('.') && !dir.startsWith('_') && !GENERIC_DIRS.has(dir));
}
/**
 * Build the classifier prompt.
 * @param partitions - normalised partitions.
 * @param text - the demand text.
 * @param topDirs - partition name -> top-level directory names.
 * @returns system and user prompt text.
 */
export function buildClassifierPrompt(partitions, text, topDirs = {}) {
    const system = [
        'You route software tasks to exactly one project partition of a workspace.',
        'Read the partition descriptions and their top-level directories, then decide which partition the task is about.',
        'Answer with one JSON object and nothing else:',
        '{"partition":"<partition name>|none","confidence":<0..1>,"reason":"<one short sentence>"}',
        'Use "none" with low confidence when no partition fits. Do not invent partition names.',
    ].join('\n');
    const blocks = partitions.map((partition) => {
        const dirs = topDirs[partition.name] ?? [];
        return [
            `- name: ${partition.name}`,
            `  root: ${partition.dir}`,
            `  description: ${partition.description?.trim() || '(none)'}`,
            ...(partition.keywords?.length ?? 0) > 0 ? [`  keywords: ${partition.keywords.join(', ')}`] : [],
            `  top-level directories: ${dirs.length === 0 ? '(unknown)' : dirs.slice(0, 80).join(', ')}`,
        ].join('\n');
    });
    const prompt = ['Partitions:', ...blocks, '', 'Task:', text.slice(0, 4000)].join('\n');
    return { text, system, prompt };
}
/**
 * Parse and validate the classifier's raw answer.
 * @param raw - model text; may wrap the JSON in prose or a code fence.
 * @param partitions - legal partition names.
 * @returns the verdict.
 * @throws {Error} naming exactly what was wrong with the answer.
 */
export function parseClassifierOutput(raw, partitions) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start)
        throw new Error(`classifier answered no JSON object: ${JSON.stringify(raw.slice(0, 160))}`);
    let value;
    try {
        value = JSON.parse(raw.slice(start, end + 1));
    }
    catch (error) {
        throw new Error(`classifier JSON did not parse: ${error instanceof Error ? error.message : String(error)}`);
    }
    const record = value;
    if (typeof record.partition !== 'string')
        throw new Error('classifier JSON has no string "partition"');
    const confidence = typeof record.confidence === 'number' ? record.confidence : Number(record.confidence);
    if (!Number.isFinite(confidence))
        throw new Error('classifier JSON has no numeric "confidence"');
    const partition = record.partition.trim();
    if (partition !== 'none' && !partitions.some(entry => entry.name === partition)) {
        throw new Error(`classifier named unknown partition "${partition}"`);
    }
    return {
        partition,
        confidence: Math.max(0, Math.min(1, confidence)),
        reason: typeof record.reason === 'string' ? record.reason.trim().slice(0, 300) : '',
    };
}
/** Reject after `ms`, so a hung model call cannot hold a publish request. */
function withTimeout(promise, ms) {
    return new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => { reject(new Error(`classifier timed out after ${String(ms)} ms`)); }, ms);
        promise.then((value) => { clearTimeout(timer); resolvePromise(value); }, (error) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); });
    });
}
/**
 * Resolve a task to one partition, asking an LLM when keywords cannot decide.
 *
 * Order: explicit partition, then files, then a unique keyword score of at
 * least `minScore`, then the classifier. When the classifier is unavailable,
 * fails, or is unsure, the keyword rules of {@link resolveRoute} decide, and a
 * resulting error says why the classifier did not.
 * @param partitions - normalised partitions.
 * @param input - explicit partition name, explicit files, or free text.
 * @param options - classifier, directory hints, thresholds, default partition.
 * @returns the decision plus its evidence trail.
 * @throws {RouteError} when nothing can decide.
 */
export async function resolveRouteSmart(partitions, input, options = {}) {
    const topDirs = options.topDirs ?? {};
    const extra = (partition) => directoryKeywords(topDirs[partition.name] ?? []);
    if (input.partition !== undefined || (input.files ?? []).length > 0) {
        return resolveRoute(partitions, input, options.fallback, extra);
    }
    const text = input.text ?? '';
    const minScore = options.minScore ?? DEFAULT_AUTO_ROUTE_MIN_SCORE;
    const scored = partitions
        .map(partition => ({ partition, score: scoreText(partition, text, extra(partition)) }))
        .sort((left, right) => right.score - left.score);
    const best = scored[0];
    const unique = best !== undefined && best.score > 0 && scored.filter(entry => entry.score === best.score).length === 1;
    if (best !== undefined && unique && best.score >= minScore) {
        return {
            partition: best.partition,
            reason: 'auto',
            because: [`score ${String(best.score)} from name/keyword/path evidence`],
        };
    }
    let llmProblem;
    if (options.classifier === undefined) {
        llmProblem = 'LLM classifier unavailable';
    }
    else {
        try {
            const request = buildClassifierPrompt(partitions, text, topDirs);
            const raw = await withTimeout(options.classifier(request), options.timeoutMs ?? 20_000);
            const verdict = parseClassifierOutput(raw, partitions);
            const chosen = partitions.find(entry => entry.name === verdict.partition);
            if (chosen !== undefined && verdict.confidence >= CLASSIFIER_MIN_CONFIDENCE) {
                return {
                    partition: chosen,
                    reason: 'llm',
                    because: [`llm confidence ${verdict.confidence.toFixed(2)}: ${verdict.reason || '(no reason given)'}`],
                };
            }
            llmProblem = `LLM classifier answered "${verdict.partition}" with confidence ${verdict.confidence.toFixed(2)}`
                + ` (needs ${String(CLASSIFIER_MIN_CONFIDENCE)}): ${verdict.reason}`;
        }
        catch (error) {
            llmProblem = `LLM classifier failed: ${error instanceof Error ? error.message : String(error)}`;
        }
    }
    try {
        const decision = resolveRoute(partitions, input, options.fallback, extra);
        return { ...decision, because: [...decision.because, llmProblem] };
    }
    catch (error) {
        if (error instanceof RouteError)
            throw new RouteError(`${error.message} (${llmProblem})`, error.candidates);
        throw error;
    }
}
/**
 * What each declared network means for the worker holding the brief.
 *
 * Phrased as an instruction plus a fallback: a worker that cannot reach a host
 * should say which host and stop, not silently try a public mirror or a VPN.
 */
const NETWORK_BRIEF = {
    intranet: 'Network: this partition is reached over the intranet VPN. If a host is unreachable, name it '
        + 'and stop; do not retry through public mirrors or a different route.',
    internet: 'Network: this partition needs public internet. Do not assume an intranet host is reachable, '
        + 'and do not route traffic through the VPN.',
    offline: 'Network: this partition builds offline. Do not fetch dependencies or call any network '
        + 'service; if the task needs one, stop and report which one.',
};
/**
 * The standing brief a worker receives before its task body.
 *
 * A worker is a fresh session with no memory of the conversation that produced
 * the task, so the partition's identity, its acceptance command, and the
 * reporting contract all travel in the prompt. Completion is phrased as a
 * request for evidence, never as an assertion the worker may make about itself:
 * the router decides acceptance, not the worker.
 * @param partition - the partition the worker runs in.
 * @param options - whether acceptance commands are configured and will be run.
 * @returns the brief text.
 */
export function partitionBrief(partition, options) {
    const lines = [
        `You are a worker for the "${partition.name}" partition of this workspace.`,
        `Your working directory is already ${partition.dir}. Treat it as the whole of your scope: do not edit files outside it.`,
        '',
        'Progress checklist (hard requirement; the task board reads it live):',
        '- Before any other tool call, call `todo_write` with a plan of 3 to 8 concrete steps.',
        '- Update it with `todo_write` immediately each time a step finishes: mark that step completed and the next one in_progress.',
        '- Exactly one step is in_progress at any time.',
        '- Before your final answer, call `todo_write` once more with every step completed.',
    ];
    if (partition.include !== undefined) {
        lines.push(`Member files are selected by: ${partition.include.join(', ')}.`);
    }
    if (partition.exclude !== undefined && partition.exclude.length > 0) {
        lines.push(`Files outside scope: ${partition.exclude.join(', ')}.`);
    }
    if (partition.brief !== undefined && partition.brief.trim() !== '') {
        lines.push('', 'Standing instructions for this partition:', partition.brief.trim());
    }
    if (partition.network !== undefined) {
        lines.push('', NETWORK_BRIEF[partition.network]);
    }
    if (partition.git !== undefined) {
        const gitRules = [
            partition.git.branch === undefined
                ? undefined
                : `Work on branch "${partition.git.branch}". Create it from the current HEAD if it does not exist.`,
            'Never switch branches, never reset, never clean, never force-push: this working tree is shared '
                + 'with a human and with other agents, and those operations move work that is not yours.',
            partition.git.rule,
        ].filter((rule) => rule !== undefined && rule.trim() !== '');
        if (gitRules.length > 0)
            lines.push('', 'Git rules for this partition:', ...gitRules);
    }
    if (options.verify && partition.verify !== undefined && partition.verify.length > 0) {
        lines.push('', 'Acceptance is decided by these commands, run afterwards in your working directory:', ...partition.verify.map(command => `  ${command}`), 'Run them yourself before answering, and report their exact output rather than a summary.');
    }
    lines.push('', 'DSH itself (hard rule): never write a host plugin\'s `lib/` directly (for example', '`dsh-router-b/packages/host-router/lib`) and never stop or restart DSH. DSH loads `lib/` at boot and', 'rewriting it while it runs can unload the plugin. Build host code with', '`/srv/workspace/deepseek-harness/dsh-router-b/scripts/safe-build-host.sh` (it writes `lib.next/`), and say', 'in your report that a restart is needed; the human runs `scripts/safe-restart.sh`. Client bundles', '(`client-ui-*/lib/client.js`) are safe to rebuild.', '', 'Screenshots: when the task involves a web page or a UI, take screenshots as evidence. The command', '`/srv/workspace/bin/screenshot <url> <out.png> [--full] [--wait ms]` launches a headless browser for one', 'capture and exits (the host has little memory: never keep a browser running). Save every image under', `\`${partition.dir}/.dsh-artifacts/${options.taskId ?? '<task-id>'}/\` (create the directory first),`, 'and list each absolute image path in your report.', '', ...REPORT_INSTRUCTION, '', 'Only report what you actually observed (command output, page text, files you checked).');
    return lines.join('\n');
}
//# sourceMappingURL=config.js.map