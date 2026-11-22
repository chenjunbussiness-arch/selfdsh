/**
 * Workspace view of the partitions: what files each partition holds, and
 * whether the partition configuration itself has problems.
 *
 * The panel's 工作区 page reads one directory level per request
 * (`GET /api/router/files?partition=&path=`), so a large tree costs nothing
 * until someone opens it. Every entry says whether the partition's
 * include/exclude globs put it in scope, which is the same rule a worker's
 * brief tells it to respect.
 *
 * Safety: the path is relative to the partition root, may not climb out of it
 * (`..`, absolute paths, or a symlink that resolves elsewhere), and only names,
 * kinds, sizes and times are returned — never file contents.
 *
 * @module host-router/files
 */
import type { Partition } from './config.ts';
/** Names never listed: VCS internals and dependency trees are noise here. */
export declare const HIDDEN_NAMES: ReadonlySet<string>;
/** Most entries one listing returns; the rest are counted, not sent. */
export declare const MAX_ENTRIES = 500;
/** One file or directory in a listing. */
export interface FileEntry {
    readonly name: string;
    /** Path relative to the partition root, `/`-separated. */
    readonly path: string;
    readonly kind: 'dir' | 'file' | 'link';
    readonly size?: number;
    readonly modifiedAt?: string;
    /**
     * Whether the partition's globs put it in scope. For a directory: false only
     * when an exclude glob removes the whole directory.
     */
    readonly inScope: boolean;
}
/** One directory level of one partition. */
export interface FileListing {
    readonly partition: string;
    readonly root: string;
    /** The listed directory, relative to the root (`''` for the root). */
    readonly path: string;
    readonly entries: readonly FileEntry[];
    /** Entries left out past {@link MAX_ENTRIES}. */
    readonly omitted: number;
    readonly include: readonly string[];
    readonly exclude: readonly string[];
}
/** A request the listing refuses, with the HTTP status that fits it. */
export declare class FileListError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string, message: string);
}
/**
 * Normalise a requested relative path, refusing anything that could leave the root.
 * @returns the `/`-separated relative path, `''` for the root.
 */
export declare function safeRelative(raw: string | undefined): string;
/**
 * List one directory level of one partition.
 * @param partition - the normalised partition.
 * @param rawPath - directory relative to the partition root.
 */
export declare function listPartitionDir(partition: Partition, rawPath: string | undefined): Promise<FileListing>;
/** One configuration problem a person should fix. */
export interface PartitionProblem {
    readonly partition: string;
    readonly level: 'error' | 'warning';
    readonly message: string;
}
/**
 * Check the partition layout once at boot: missing roots, roots that are not
 * directories, and roots nested inside each other (allowed — the deeper root
 * wins a file — but worth seeing, because two managers then share files).
 */
export declare function partitionProblems(partitions: readonly Partition[]): Promise<readonly PartitionProblem[]>;
