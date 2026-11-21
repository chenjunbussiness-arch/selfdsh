/**
 * Small formatting helpers shared by the panel's views.
 */
/**
 * Human-readable age of an ISO timestamp.
 * @param iso - timestamp to describe.
 * @param now - reference time, injectable for tests and deterministic renders.
 * @returns a short relative label such as `刚刚`, `6 分钟前`, `2 小时前`.
 */
export declare function relativeTime(iso: string | undefined, now?: number): string;
/**
 * Clock time of an ISO timestamp, for the header stamp.
 * @param iso - timestamp.
 * @returns `HH:MM:SS`, or an empty string when the value is not a timestamp.
 */
export declare function clockTime(iso: string): string;
/**
 * Elapsed seconds as a compact duration.
 * @param seconds - duration in seconds.
 * @returns `44s`, `5m18s`, or an empty string when absent.
 */
export declare function duration(seconds: number | undefined): string;
/**
 * Human-readable byte size.
 * @param bytes - size in bytes.
 * @returns `4.2 KB`, `812 B`, or an empty string when absent.
 */
export declare function bytes(bytes: number | undefined): string;
