/**
 * Built-in sample board.
 *
 * Purpose: prove the panel's information design without waiting on the Host
 * half, and keep the panel honest when the router bundle is not installed. It is
 * also a live sandbox — publishing a demand and accepting/rejecting a reported
 * task really mutate this snapshot, so the interaction can be demonstrated end
 * to end before any Host code exists.
 *
 * Nothing here is a fallback for real data: `origin: 'mock'` is rendered in the
 * panel header, so a demo is never mistaken for a running router.
 */
import type { TaskState } from './contract.ts';
import type { BoardSource } from './source.ts';
/**
 * Build the in-memory sample source.
 * @returns a BoardSource backed by module state, safe to publish and verify against.
 */
export declare function createMockSource(): BoardSource;
/** Lane a task is rendered in; exposed for the store's counts. */
export declare function laneOf(state: TaskState): string;
