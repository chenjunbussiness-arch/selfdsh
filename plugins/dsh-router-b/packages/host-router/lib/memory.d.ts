/**
 * Partition memory: what a partition's manager knows across requests.
 *
 * A manager is a fresh child per request, so on its own it starts every request
 * with no idea what the partition did before. This module is the durable part
 * that makes the chain `routing -> manager -> session -> worker` behave like one
 * bot per partition:
 *
 * - a **work log**: one entry per finished task (who, what it did, which files,
 *   what was left, which session), written by the router when a row settles;
 * - **notes**: standing facts about the partition (conventions, pitfalls,
 *   decisions) written by the manager with `partition_memory` or by a human
 *   from the panel;
 * - a **session roster** and a **transcript reader**, so a manager can see every
 *   worker session of its partition and read what one of them actually did.
 *
 * One JSON document per partition under `<boardDir>/memory/<name>.json`. Writes
 * go through a per-file chain and a temp file, like the board.
 *
 * @module host-router/memory
 */
import type { RouterTask, TaskState } from './board.ts';
import type { SessionEventLike } from './types.ts';
/** Who wrote a note. */
export type NoteAuthor = 'manager' | 'human' | 'router';
/** One standing fact about a partition. */
export interface MemoryNote {
    readonly id: string;
    readonly at: string;
    readonly text: string;
    readonly by: NoteAuthor;
    /** Task the note came out of, when a manager wrote it during a request. */
    readonly taskId?: string;
}
/** One finished task, as the partition remembers it. */
export interface WorkEntry {
    readonly at: string;
    readonly taskId: string;
    /** Request (root task) this row belonged to. */
    readonly rootId?: string;
    readonly level: 'manager' | 'worker';
    readonly subject: string;
    readonly state: TaskState;
    readonly summary?: string;
    readonly touched?: readonly string[];
    readonly left?: string;
    readonly error?: string;
    readonly sessionId?: string;
    readonly model?: string;
}
/** Whole memory of one partition, as persisted. */
export interface PartitionMemory {
    readonly version: 1;
    readonly notes: readonly MemoryNote[];
    readonly log: readonly WorkEntry[];
}
/** Limits that keep the document (and the manager prompt) bounded. */
export declare const NOTE_LIMIT = 80;
export declare const NOTE_TEXT_LIMIT = 600;
export declare const LOG_LIMIT = 300;
/** File-system-safe stem for a partition name. */
export declare function memoryFileStem(partition: string): string;
/** Build the work-log entry for one settled row. */
export declare function entryOf(task: RouterTask, rootId?: string): WorkEntry;
/** Durable per-partition memory. One instance per plugin activation. */
export declare class MemoryStore {
    private readonly dir;
    private readonly docs;
    private readonly writing;
    private constructor();
    /**
     * Open the memory directory and load the given partitions.
     * @param dir - `<boardDir>/memory`.
     * @param partitions - partition names to load now; others load on first use.
     */
    static open(dir: string, partitions?: readonly string[]): Promise<MemoryStore>;
    private fileOf;
    private load;
    /** Current memory of one partition (loads it on first use). */
    read(partition: string): Promise<PartitionMemory>;
    /** Synchronous view of an already-loaded partition; empty when not loaded yet. */
    peek(partition: string): PartitionMemory;
    /**
     * Record one settled row. A row recorded again (retried, resumed) replaces its
     * earlier entry, so the log holds the latest outcome once.
     */
    record(partition: string, entry: WorkEntry): Promise<void>;
    /**
     * Fill an empty work log from rows that settled before memory existed.
     * Does nothing when the partition already has a log.
     * @returns how many entries were written.
     */
    seed(partition: string, entries: readonly WorkEntry[]): Promise<number>;
    /** Add one note; returns it. */
    addNote(partition: string, text: string, by: NoteAuthor, taskId?: string): Promise<MemoryNote>;
    /** Remove one note; returns whether it existed. */
    removeNote(partition: string, id: string): Promise<boolean>;
    private save;
}
/** Short relative age, for prompts. */
export declare function ageOf(at: string, now?: number): string;
/** One work-log entry as one prompt line. */
export declare function workLine(entry: WorkEntry, now?: number): string;
/**
 * The partition's worker sessions, newest first: open ones always, then the
 * most recent settled ones up to `limit`.
 */
export declare function sessionRoster(tasks: readonly RouterTask[], limit?: number, now?: number): string[];
/**
 * Text a manager gets about its partition before the request: notes, recent
 * work, and the worker sessions it can read or continue.
 */
export declare function memoryBrief(memory: PartitionMemory, tasks: readonly RouterTask[], options?: {
    readonly logLimit?: number;
    readonly rosterLimit?: number;
    readonly now?: number;
}): string;
/** Text of the content blocks of one message-shaped payload. */
export declare function textBlocks(content: unknown): string;
/** Short argument preview for a tool call line. */
export declare function argumentPreview(value: unknown): string;
/**
 * Render the end of a session log as a readable transcript.
 *
 * Reads message-shaped events (`data.message.{role,content}` or
 * `data.{role,content}`), tool calls and their results, and turn ends. Unknown
 * event types are skipped, so a newer harness only loses detail, never breaks.
 * @param events - the session log.
 * @param last - how many rendered entries to keep from the end.
 * @param textLimit - cut for each message body.
 */
export declare function renderTranscript(events: readonly SessionEventLike[], last?: number, textLimit?: number): string[];
