/**
 * Live output of one worker: its session log cut into segments a person can
 * scan while the worker runs.
 *
 * One segment per tool call (the command and what it printed), one per
 * assistant message, one per turn end. A segment is marked as an error when the
 * tool reported one or its output reads like a failure, so the panel can paint
 * it red and offer 停止 / 改派 right there.
 *
 * @module host-router/live
 */
import { argumentPreview, textBlocks } from "./memory.js";
const BODY_LIMIT = 4000;
/** Output that reads like a failure. */
const FAILURE = /(^|\n)\s*(error|fatal|failed|exception|traceback)\b|\bexit (code|status) [1-9]|\bcommand not found\b|\bpermission denied\b|\bno such file or directory\b|\bENOENT\b|\bEACCES\b|\bECONNREFUSED\b|\bnpm ERR!/i;
const cut = (text) => text.length <= BODY_LIMIT ? text : `…${text.slice(-BODY_LIMIT)}`;
/** The most readable title of a tool call: its command line when it has one. */
function callTitle(data) {
    const name = typeof data?.['name'] === 'string' ? data['name'] : 'tool';
    const args = data?.['arguments'];
    if (args !== null && typeof args === 'object') {
        for (const key of ['command', 'cmd', 'script', 'path', 'file_path', 'url', 'query']) {
            const value = args[key];
            if (typeof value === 'string' && value.trim() !== '')
                return `${name}: ${value.trim().replace(/\s+/g, ' ').slice(0, 240)}`;
        }
    }
    return `${name} ${argumentPreview(args)}`.trimEnd();
}
/** Whether a tool result says it failed. */
function resultFailed(data, body) {
    if (data?.['isError'] === true || data?.['is_error'] === true || data?.['error'] !== undefined && data['error'] !== null)
        return true;
    const exit = data?.['output']?.exitCode ?? data?.['exitCode'];
    if (typeof exit === 'number' && exit !== 0)
        return true;
    return FAILURE.test(body);
}
/**
 * Cut a session log into live segments.
 * @param events - the session log, oldest first.
 * @param after - only segments whose `seq` is greater (incremental reads).
 * @param last - keep at most this many segments from the end.
 */
export function liveSegments(events, after = -1, last = 60) {
    const out = [];
    const open = new Map();
    for (const event of events) {
        const data = event.data;
        if (event.type === 'tool/call') {
            const callId = typeof data?.['id'] === 'string' ? data['id'] : typeof data?.['callId'] === 'string' ? data['callId'] : `seq-${String(event.seq)}`;
            open.set(callId, out.length);
            out.push({ seq: event.seq, kind: 'command', title: callTitle(data), body: '', error: false, at: event.time, running: true });
            continue;
        }
        if (event.type === 'tool/result') {
            const callId = typeof data?.['id'] === 'string' ? data['id'] : typeof data?.['callId'] === 'string' ? data['callId'] : undefined;
            const index = callId !== undefined && open.has(callId)
                ? open.get(callId)
                : [...out.keys()].reverse().find(i => out[i].kind === 'command' && out[i].running === true);
            const body = textBlocks(data?.['output'] ?? data?.['content']) || argumentPreview(data?.['output'] ?? data?.['result']);
            const failed = resultFailed(data, body);
            if (index === undefined) {
                out.push({ seq: event.seq, kind: 'command', title: 'result', body: cut(body), error: failed, at: event.time });
            }
            else {
                const segment = out[index];
                out[index] = { seq: segment.seq, kind: 'command', title: segment.title, body: cut(body), error: failed, at: segment.at };
                if (callId !== undefined)
                    open.delete(callId);
            }
            continue;
        }
        if (event.type === 'turn/end') {
            const reason = data?.['reason']?.kind;
            const kind = typeof reason === 'string' ? reason : 'unknown';
            out.push({ seq: event.seq, kind: 'end', title: kind, body: '', error: kind === 'error' || kind === 'aborted', at: event.time });
            continue;
        }
        if (event.type === 'assistant/attempt')
            continue;
        const message = (data?.['message'] ?? data);
        if (message === undefined || message === null || typeof message !== 'object')
            continue;
        const role = typeof message.role === 'string' ? message.role : event.type.startsWith('assistant/') ? 'assistant' : undefined;
        if (role !== 'assistant')
            continue;
        const text = textBlocks(message.content);
        if (text === '')
            continue;
        out.push({ seq: event.seq, kind: 'message', title: 'assistant', body: cut(text), error: false, at: event.time });
    }
    return out.filter(segment => segment.seq > after || segment.running === true).slice(-Math.max(1, last));
}
//# sourceMappingURL=live.js.map