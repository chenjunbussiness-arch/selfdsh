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
/**
 * Older lines (still waiting) then newer ones, one per subject, the latest kept, in the
 * order their subjects last changed; at most `max` lines, with a note on how many were folded.
 */
export declare function mergeNoticeLines(older: readonly string[], newer: readonly string[], max?: number): string[];
/** The text of one 【进度提醒】 message. */
export declare function noticeText(lines: readonly string[]): string;
