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
    return text.slice(NOTICE_HEAD.length).split('\n').map(line => line.replace(/^- /, '').trim()).filter(line => line !== '' && !line.startsWith('（另有 ') && line !== ASK_FOOTER);
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
 * Words that mark a line as waiting on the human (a question, a stop, no progress).
 * Such a line is never replaced by a later progress line about the same subject:
 * the 作战室 has to put it to the user, and a "进度" line arriving a minute later
 * used to wipe the question out before anyone read it.
 */
const ASK_RE = /需要你决定|需要回答|卡住了|没法开始|没法继续|没有动静|需要你处理|等你决定/;
/** Lines that close a subject: an open question about it is moot then. */
const DONE_RE = /^「[^」]*」(?:（[^）]*）)? (?:完成|已取消)|^任务 \S+?（.*）(?:已完成|已取消)/;
/** Whether a notice line waits on the human. */
export function isAskLine(line) {
    return ASK_RE.test(line);
}
/**
 * Older lines (still waiting) then newer ones, one per subject, the latest kept, in the
 * order their subjects last changed; at most `max` lines, with a note on how many were folded.
 * A line that waits on the human ({@link isAskLine}) is kept beside later progress about the
 * same subject; only a newer question or the subject finishing replaces it. Questions are
 * never folded away.
 */
export function mergeNoticeLines(older, newer, max = 12) {
    const bySubject = new Map();
    for (const line of [...older, ...newer]) {
        const subject = noticeSubject(line);
        const ask = isAskLine(line);
        const key = ask ? `ask:${subject}` : subject;
        if (!ask && DONE_RE.test(line))
            bySubject.delete(`ask:${subject}`);
        bySubject.delete(key);
        bySubject.set(key, line);
    }
    const entries = [...bySubject.entries()];
    if (entries.length <= max)
        return entries.map(([, line]) => line);
    const asks = entries.filter(([key]) => key.startsWith('ask:')).length;
    const room = Math.max(0, max - asks);
    let others = entries.length - asks;
    const kept = [];
    for (const [key, line] of entries) {
        if (key.startsWith('ask:'))
            kept.push(line);
        else if (others-- <= room)
            kept.push(line);
    }
    return [`（另有 ${String(entries.length - kept.length)} 条较早的提醒已合并）`, ...kept];
}
/** Closing line of a notice that carries questions: what the 作战室 has to do with them. */
export const ASK_FOOTER = '（带「需要你决定 / 需要回答 / 卡住了 / 没有动静」的条目在等用户：按规则 8 直接问用户。）';
/** The text of one 【进度提醒】 message. */
export function noticeText(lines) {
    const body = [NOTICE_HEAD, ...lines.map(line => `- ${line}`)];
    if (lines.some(isAskLine))
        body.push(ASK_FOOTER);
    return body.join('\n');
}
//# sourceMappingURL=notices.js.map