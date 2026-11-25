/**
 * 【进度提醒】 messages for the 作战室, kept to one at a time.
 *
 * The router posts progress notices into the anchor Agent's inbox. While the
 * anchor is busy those messages wait in its queue, and every new notice used
 * to add one more: a worker that kept re-reporting the same step filled the
 * queue with dozens of identical lines. Now a notice that has not been taken
 * yet is replaced by one message carrying the latest line per subject.
 */
/** First line of every progress notice message. */
export const NOTICE_HEAD = '【进度提醒】';
/** The lines of a 【进度提醒】 message, or undefined for any other message. */
export function noticeLinesOf(message) {
    if (message.role !== undefined && message.role !== 'user')
        return undefined;
    const parts = Array.isArray(message.content) ? message.content : [];
    const text = parts.map(part => (part !== null && typeof part === 'object' && typeof part.text === 'string') ? part.text : '').join('');
    if (!text.startsWith(NOTICE_HEAD))
        return undefined;
    return text.slice(NOTICE_HEAD.length).split('\n').map(line => line.replace(/^- /, '').trim()).filter(line => line !== '' && !line.startsWith('（另有 '));
}
/**
 * What a line is about: `「title」（agent）` for the cloud task lines, `任务 <id>` for the
 * router's own, the whole line otherwise. A newer line about the same thing replaces the older.
 */
export function noticeSubject(line) {
    const cloud = /^(?:云端新任务 |.+? 在本地开始 )?(「[^」]*」(?:（[^）]*）)?)/.exec(line);
    if (cloud?.[1] !== undefined)
        return cloud[1];
    const own = /^(?:挂起的)?任务 (\S+?)（/.exec(line);
    if (own?.[1] !== undefined)
        return `task:${own[1]}`;
    return line;
}
/**
 * Older lines (still waiting) then newer ones, one per subject, the latest kept, in the
 * order their subjects last changed; at most `max` lines, with a note on how many were folded.
 */
export function mergeNoticeLines(older, newer, max = 12) {
    const bySubject = new Map();
    for (const line of [...older, ...newer]) {
        const key = noticeSubject(line);
        bySubject.delete(key);
        bySubject.set(key, line);
    }
    const lines = [...bySubject.values()];
    if (lines.length <= max)
        return lines;
    const kept = lines.slice(lines.length - max);
    return [`（另有 ${String(lines.length - max)} 条较早的提醒已合并）`, ...kept];
}
/** The text of one 【进度提醒】 message. */
export function noticeText(lines) {
    return [NOTICE_HEAD, ...lines.map(line => `- ${line}`)].join('\n');
}
//# sourceMappingURL=notices.js.map