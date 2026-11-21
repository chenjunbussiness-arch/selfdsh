/**
 * The dispatch side: one worker per task, plus the acceptance check.
 *
 * The load-bearing decision is that this module uses the subagent *service*,
 * not the `subagent` tool:
 *
 * - `ctx.subagents.startActivation({ cwd })` takes an absolute directory, and
 *   `SubagentManager.resolveDirectory` uses it verbatim. The local materializer
 *   then calls `workingDirectory.set(child, cwd)` before the child's first turn,
 *   so the child's working-directory service value is the partition root even
 *   though `session.header.cwd` still records the parent's creation directory.
 *   (Verified in the running build: `dsh-subagent/lib/index.js` around the
 *   `resolveDirectory` and `materializeTracked` regions.) Sandbox policy reads
 *   the working-directory value first, so writes land inside the partition.
 * - The tool's own `cwd` parameter is not a stable API: it exists in the
 *   running 0.2.2-rc.3 and is gone from the 0.2.2-rc.5 `tool-subagent` source,
 *   while the *service* keeps `cwd` in both. Calling the service is what makes
 *   this package survive the next rc bump.
 * - The returned `result` promise settles after the child's teardown, which is
 *   the only supported way for a host plugin to learn how a child ended without
 *   parsing a session log.
 *
 * @module host-router/dispatch
 */
import { spawn } from 'node:child_process';
/** Join text blocks into the readable report a worker produced. */
export function textOf(blocks) {
    return blocks.map(block => block.text).join('\n').trim();
}
/**
 * Start one continuable child rooted in a partition.
 *
 * `delivery: 'parent'` is deliberate: the runtime then hands the child's closing
 * report to its creator as a user-role message, which is how the human-facing
 * session learns that a worker finished without polling anything. The router
 * reads the same result through {@link SubagentActivation.result} to close its
 * board row, so the two views cannot disagree about the stop reason.
 * @param subagents - the subagent seam.
 * @param spec - directory, prompt, parent, and routing choices.
 * @returns the activation handle for the started child.
 */
export async function startWorker(subagents, spec) {
    const activationSpec = {
        provider: spec.provider,
        label: spec.label,
        cwd: spec.cwd,
        prompt: [{ type: 'text', text: spec.prompt }],
        parent: spec.parent,
        signal: spec.signal,
        delivery: spec.delivery ?? 'parent',
        ...spec.preset === undefined ? {} : { agentPreset: spec.preset },
        ...spec.maxDepth === undefined ? {} : { maxDepth: spec.maxDepth },
        ...spec.agentOptions === undefined ? {} : { agentOptions: spec.agentOptions },
    };
    return await subagents.startActivation(activationSpec);
}
/**
 * Continue an existing worker session.
 *
 * This is the "续作" path: `sendMessage` restores a settled child from its
 * durable log when needed (cold resume) and delivers the text as a user-role
 * message, so a worker keeps its own history instead of starting over. It
 * requires the sender to be a live member of the same subagent tree, which is
 * why the router re-resolves the original dispatcher before calling.
 * @param subagents - the subagent seam.
 * @param sender - live agent that owns the child.
 * @param childId - durable child session id.
 * @param text - the follow-up instruction.
 * @param signal - caller cancellation.
 * @returns the accepted inbox message id.
 */
export async function continueWorker(subagents, sender, childId, text, signal) {
    return await subagents.sendMessage(sender, childId, [{ type: 'text', text }], { signal });
}
/**
 * Stop one child's current turn.
 *
 * `{ kind: 'user' }` is used on purpose: it is the trusted host operation the
 * seam documents for a human-initiated stop, and unlike the `ancestor` form it
 * does not require the original creator to be live — which matters precisely
 * when a cancel arrives after a restart.
 * @param subagents - the subagent seam.
 * @param childId - durable child session id.
 */
export function cancelWorker(subagents, childId) {
    subagents.interrupt(childId, { kind: 'user' });
}
/**
 * Run one command and collect its output.
 * @param command - shell command line, executed by the platform shell.
 * @param cwd - directory to run in.
 * @param timeoutMs - hard timeout; the child is killed when it expires.
 * @returns exit code plus combined output.
 */
function runCommand(command, cwd, timeoutMs) {
    return new Promise((settle) => {
        const child = spawn(command, {
            cwd,
            shell: true,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        const collect = (chunk) => {
            // Bound memory: a runaway build log must not become the board document.
            if (output.length < 64_000)
                output += chunk.toString('utf8');
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        const timer = setTimeout(() => {
            output += `\n[timed out after ${String(timeoutMs)} ms]`;
            child.kill();
        }, timeoutMs);
        child.on('error', (error) => {
            clearTimeout(timer);
            settle({ code: null, output: `${output}\n[spawn failed: ${error.message}]` });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            settle({ code, output });
        });
    });
}
/**
 * Decide whether a reported task is actually done.
 *
 * With no configured commands the answer is "unverified": the router records the
 * claim and says so, rather than promoting a worker's own word to done. With
 * commands, every one must exit 0; the first failure names itself so the human
 * reads one line instead of a wall of output.
 * @param commands - acceptance commands from the partition or the task.
 * @param cwd - directory to run them in.
 * @param timeoutMs - per-command timeout.
 * @returns the outcome, with the combined output bounded by {@link tail}.
 */
export async function runVerify(commands, cwd, timeoutMs) {
    if (commands.length === 0) {
        return { ok: false, output: '(no acceptance commands configured for this partition)' };
    }
    const parts = [];
    let failed;
    for (const command of commands) {
        const result = await runCommand(command, cwd, timeoutMs);
        parts.push(`$ ${command}\n${result.output.trim()}\n[exit ${String(result.code)}]`);
        if (result.code !== 0) {
            failed = command;
            break;
        }
    }
    return {
        ok: failed === undefined,
        output: parts.join('\n\n'),
        ...failed === undefined ? {} : { failed },
    };
}
//# sourceMappingURL=dispatch.js.map