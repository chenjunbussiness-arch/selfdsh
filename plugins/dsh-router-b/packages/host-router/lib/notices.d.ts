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
export declare const NOTICE_HEAD = "\u3010\u8FDB\u5EA6\u63D0\u9192\u3011";
/** A pending inbox message as far as the notices need it. */
export interface NoticeMessage {
    readonly id?: unknown;
    readonly role?: unknown;
    readonly content?: unknown;
}
/** The lines of a 【进度提醒】 message, or undefined for any other message. */
export declare function noticeLinesOf(message: NoticeMessage): string[] | undefined;
/**
 * What a line is about: `「title」（agent）` for the cloud task lines, `任务 <id>` for the
 * router's own, the whole line otherwise. A newer line about the same thing replaces the older.
 */
export declare function noticeSubject(line: string): string;
/** Whether a notice line says its subject finished or was cancelled: an open question about it is moot. */
export declare function closesSubject(line: string): boolean;
/** Whether a notice line waits on the human. */
export declare function isAskLine(line: string): boolean;
/**
 * Older lines (still waiting) then newer ones, one per subject, the latest kept, in the
 * order their subjects last changed; at most `max` lines, with a note on how many were folded.
 * A line that waits on the human ({@link isAskLine}) is kept beside later progress about the
 * same subject; only a newer question or the subject finishing replaces it. Questions are
 * never folded away.
 */
export declare function mergeNoticeLines(older: readonly string[], newer: readonly string[], max?: number): string[];
/** Closing line of a notice that carries questions: what the 作战室 has to do with them. */
export declare const ASK_FOOTER = "\uFF08\u5E26\u300C\u9700\u8981\u4F60\u51B3\u5B9A / \u9700\u8981\u56DE\u7B54 / \u5361\u4F4F\u4E86 / \u6CA1\u6709\u52A8\u9759\u300D\u7684\u6761\u76EE\u5728\u7B49\u7528\u6237\uFF1A\u6309\u89C4\u5219 8 \u76F4\u63A5\u95EE\u7528\u6237\u3002\uFF09";
/** The text of one 【进度提醒】 message. */
export declare function noticeText(lines: readonly string[]): string;
