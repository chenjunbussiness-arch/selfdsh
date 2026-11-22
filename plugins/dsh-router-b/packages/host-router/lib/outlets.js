/**
 * Outlets: the things an agent does that leave the sandbox or cannot be undone.
 *
 * Every outlet call is classified, checked against the partition's policy, and
 * written to an audit log. A call the policy says needs a human does not run:
 * it becomes an approval the panel shows as a card, and only a human's 同意
 * runs it, once. Nothing here offers "always allow": an approval covers the one
 * action it describes.
 *
 * Kinds:
 *   git      push a work branch, open or update a pull request    (reversible)
 *   merge    merge a pull request                                  (needs a human, always)
 *   ops      a shell command on the server, by risk level          (read / change / danger)
 *   browser  headless screenshot or page text of a URL             (read-only)
 *
 * Files: `<boardDir>/approvals.json` (the queue) and `<boardDir>/audit/<yyyy-mm>.jsonl`.
 *
 * @module host-router/outlets
 */
import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
/** Defaults: git and browser run, ops run but danger asks, merge always asks. */
export const DEFAULT_POLICY = { git: 'allow', ops: 'allow', browser: 'allow' };
const TRIM = 4000;
const trim = (text, limit = TRIM) => text.length <= limit ? text : `${text.slice(0, limit)}\n…[${String(text.length - limit)} more characters]`;
// ---------------------------------------------------------------------------
// ops classification
// ---------------------------------------------------------------------------
/** Commands that only look. Matched against each segment of a pipeline. */
const READ_ONLY = [
    /^(ls|ll|cat|head|tail|less|more|wc|stat|file|du|df|free|uptime|whoami|id|date|hostname|pwd|env|printenv|which|type|echo|ps|top -b|pgrep|lsof|ss|netstat|ip (a|addr|r|route|link)|ping|dig|nslookup|host|traceroute|grep|egrep|rg|find|sort|uniq|cut|awk|sed -n|jq|tree|md5sum|sha256sum|ffprobe|mediainfo|exiftool)\b/,
    /^journalctl\b/,
    /^systemctl (status|is-active|is-enabled|list-units|list-timers|cat|show)\b/,
    /^docker (ps|images|logs|inspect|stats --no-stream|compose (ps|logs|config))\b/,
    /^nginx -[tT]\b/,
    /^(curl|wget)\b(?!.*\s-(X|-request)\s*(POST|PUT|PATCH|DELETE))(?!.*\s(-d|--data|-F|--form|-T|--upload-file|-o|-O|--output)\b)/,
    /^git (status|log|diff|show|branch|remote -v|rev-parse|fetch)\b/,
    /^openssl (x509|s_client)\b/,
    /^certbot certificates\b/,
];
/** Commands that cannot be taken back or take a service down. */
/** A command word in command position: line start, after a separator, or after sudo/xargs/exec/nohup. */
const AT = String.raw `(?:^|[;&|(]\s*|\b(?:sudo|xargs|exec|nohup|time)\s+(?:-\S+\s+)*)`;
const cmd = (words, rest = String.raw `\b`) => new RegExp(`${AT}(?:${words})${rest}`);
const DANGER = [
    cmd('rm|rmdir|shred|unlink'),
    cmd('mkfs(?:\\.\\w+)?|fdisk|parted|wipefs|dd'),
    cmd('reboot|shutdown|poweroff|halt|init [06]'),
    /\bsystemctl\s+(stop|disable|mask|kill|restart)\b/,
    /\bservice\s+\S+\s+(stop|restart)\b/,
    /\bdocker\s+(rm|rmi|kill|stop|system prune|volume rm|network rm|compose down)\b/,
    cmd('kill|pkill|killall'),
    /\bgit\s+(push\s+.*(--force|-f)\b|reset --hard|clean -[a-z]*f|branch -D)/,
    cmd('iptables|ufw|nft|firewall-cmd'),
    cmd('userdel|passwd|chpasswd|visudo'),
    /\bchmod\s+(-R\s+)?[0-7]*7[0-7]*\s+\//,
    /\bchown\s+-R\b/,
    /\bcrontab\s+-r\b/,
    cmd('truncate'),
    /(^|[^>])>\s*\/(etc|var|usr|boot|srv)\//,
    /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE)\b/i,
    /\bmv\s+.*\s\/(etc|var|usr|boot)\b/,
    /\bfind\b.*\s-delete\b/,
];
/**
 * Risk level of a shell command.
 *
 * `read` only when every segment of every pipeline is a known read-only
 * command; anything that matches a danger pattern (built-in or the partition's
 * own) is `danger`; everything else is `change`.
 */
export function classifyCommand(command, extraDanger = []) {
    const text = command.trim();
    if (text === '')
        return 'change';
    const extra = extraDanger.flatMap((source) => { try {
        return [new RegExp(source)];
    }
    catch {
        return [];
    } });
    if ([...DANGER, ...extra].some(re => re.test(text)))
        return 'danger';
    if (/\bsudo\b/.test(text))
        return 'change';
    // Redirections that write and command substitution are never read-only.
    if (/(^|[^0-9&])>{1,2}(?!\s*&?\/dev\/null)|`|\$\(/.test(text))
        return 'change';
    const segments = text.split(/\|\||&&|;|\|/).map(segment => segment.trim()).filter(segment => segment !== '');
    return segments.every(segment => READ_ONLY.some(re => re.test(segment))) ? 'read' : 'change';
}
/** Whether a host is allowed by a browser allowlist. */
export function hostAllowed(host, allow) {
    if (allow === undefined || allow.length === 0)
        return true;
    const name = host.toLowerCase();
    return allow.some((rule) => {
        const entry = rule.toLowerCase().trim();
        if (entry.startsWith('*.'))
            return name === entry.slice(2) || name.endsWith(entry.slice(1));
        return name === entry;
    });
}
// ---------------------------------------------------------------------------
// approval queue and audit
// ---------------------------------------------------------------------------
/** Pending approvals older than this expire (the agent has long moved on). */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
const KEEP_SETTLED = 200;
/** The approval queue plus the audit log, persisted under the board directory. */
export class OutletStore {
    dir;
    items = [];
    chain = Promise.resolve();
    seq = 0;
    constructor(dir) {
        this.dir = dir;
    }
    /** Open (or create) the store in `dir`. */
    static async open(dir) {
        const store = new OutletStore(dir);
        await mkdir(join(dir, 'audit'), { recursive: true });
        try {
            const raw = JSON.parse(await readFile(join(dir, 'approvals.json'), 'utf8'));
            store.items = Array.isArray(raw.items) ? raw.items : [];
        }
        catch {
            store.items = [];
        }
        return store;
    }
    /** Every approval, newest first. */
    list() {
        return [...this.items].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    }
    pending() {
        return this.list().filter(item => item.state === 'pending');
    }
    get(id) {
        return this.items.find(item => item.id === id);
    }
    /** Queue a new approval and audit it as `asked`. */
    async request(input, now = new Date()) {
        this.seq += 1;
        const approval = {
            ...input,
            id: `ap-${now.getTime().toString(36)}${this.seq.toString(36)}`,
            state: 'pending',
            createdAt: now.toISOString(),
        };
        this.items.push(approval);
        await this.persist();
        await this.audit({ kind: input.kind, partition: input.partition, ...input.taskId === undefined ? {} : { taskId: input.taskId }, action: input.action, target: input.target, outcome: 'asked', by: 'agent', detail: input.reason });
        return approval;
    }
    /** Change one approval. */
    async patch(id, change) {
        const index = this.items.findIndex(item => item.id === id);
        if (index < 0)
            throw new Error(`unknown approval "${id}"`);
        const next = { ...this.items[index], ...change };
        this.items[index] = next;
        await this.persist();
        return next;
    }
    /** Expire pending approvals past the TTL; returns the ones it expired. */
    async expire(now = Date.now()) {
        const stale = this.items.filter(item => item.state === 'pending' && now - Date.parse(item.createdAt) > APPROVAL_TTL_MS);
        for (const item of stale) {
            await this.patch(item.id, { state: 'expired', decidedAt: new Date(now).toISOString() });
            await this.audit({ kind: item.kind, partition: item.partition, ...item.taskId === undefined ? {} : { taskId: item.taskId }, action: item.action, target: item.target, outcome: 'expired', by: 'router' });
        }
        return stale;
    }
    /** Append one audit line to this month's file. */
    async audit(entry, now = new Date()) {
        const line = { at: now.toISOString(), ...entry, ...entry.detail === undefined ? {} : { detail: trim(entry.detail, 600) } };
        const file = join(this.dir, 'audit', `${now.toISOString().slice(0, 7)}.jsonl`);
        this.chain = this.chain.then(() => appendFile(file, `${JSON.stringify(line)}\n`, 'utf8')).catch(() => { });
        await this.chain;
    }
    /** The newest audit lines, newest first. */
    async recentAudit(limit = 100) {
        const now = new Date();
        const months = [now, new Date(now.getFullYear(), now.getMonth() - 1, 15)].map(date => date.toISOString().slice(0, 7));
        const out = [];
        for (const month of months) {
            try {
                const text = await readFile(join(this.dir, 'audit', `${month}.jsonl`), 'utf8');
                for (const line of text.split('\n')) {
                    if (line.trim() === '')
                        continue;
                    try {
                        out.push(JSON.parse(line));
                    }
                    catch { /* a torn line */ }
                }
            }
            catch { /* no file that month */ }
        }
        return out.sort((left, right) => right.at.localeCompare(left.at)).slice(0, limit);
    }
    async persist() {
        // Keep every pending item and the newest settled ones.
        const settled = this.items.filter(item => item.state !== 'pending')
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
        if (settled.length > KEEP_SETTLED) {
            const drop = new Set(settled.slice(KEEP_SETTLED).map(item => item.id));
            this.items = this.items.filter(item => !drop.has(item.id));
        }
        const body = JSON.stringify({ version: 1, items: this.items }, null, 2);
        this.chain = this.chain.then(async () => {
            const file = join(this.dir, 'approvals.json');
            const temp = `${file}.${String(process.pid)}.tmp`;
            await writeFile(temp, body, 'utf8');
            await rename(temp, file);
        });
        await this.chain;
    }
}
/** Run a program without a shell. */
export function run(file, args, cwd, timeoutMs = 60_000) {
    return new Promise((settle) => {
        execFile(file, [...args], { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
            const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
            settle({ code, stdout: trim(String(stdout)), stderr: trim(String(stderr) || (error !== null && code === null ? error.message : '')) });
        });
    });
}
/** Run one command line through the platform shell (ops). */
export function runShell(command, cwd, timeoutMs = 120_000) {
    const windows = process.platform === 'win32';
    return run(windows ? 'cmd.exe' : '/bin/sh', windows ? ['/d', '/s', '/c', command] : ['-c', command], cwd, timeoutMs);
}
/** Read the current branch and uncommitted paths. */
export async function gitFacts(cwd) {
    const head = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    if (head.code !== 0)
        throw new Error(`not a git checkout: ${head.stderr.trim() || head.stdout.trim()}`);
    const status = await run('git', ['status', '--porcelain'], cwd);
    return {
        branch: head.stdout.trim(),
        dirty: status.stdout.split('\n').map(line => line.trim()).filter(line => line !== ''),
    };
}
/** A branch name the router may push: no default branch, nothing odd. */
export function pushableBranch(branch, defaultBranch) {
    if (branch === 'HEAD')
        return 'detached HEAD: check out a work branch first';
    if (branch === defaultBranch || branch === 'main' || branch === 'master')
        return `refusing to push "${branch}": work on a branch and open a pull request`;
    if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes('..') || branch.startsWith('-'))
        return `branch name "${branch}" is not allowed`;
    return undefined;
}
/** Branch name a request's workers share: `dsh/<root id>`. */
export const requestBranch = (rootId) => `dsh/${rootId.replace(/[^A-Za-z0-9._-]+/g, '-')}`;
//# sourceMappingURL=outlets.js.map