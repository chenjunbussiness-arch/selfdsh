/**
 * Reading credential status for the rail's API-key block.
 *
 * The block never asks for a secret and never receives one: the Host's
 * `credentials.describe(refs)` answers one projectCredentialInfo per reference —
 * `{ configured, source?, writable, masked? }` — and deliberately has no read
 * path for the value (`PKG(dsh-api-settings-controller)\src\credentials.ts:45-52,84-91`).
 * So the rail can say "已配置 / 未配置" and cannot say anything else, which is
 * exactly the amount of truth a status row should carry.
 */
import type { CredentialView } from './contract.ts';
/**
 * Narrow one `credentials.describe` answer into view rows.
 *
 * The wire shape is `Record<ref, CredentialInfo>`; a ref the Host did not answer
 * is dropped rather than assumed missing, because "the Host did not report it"
 * and "it is not configured" are different facts.
 * @param refs - the references that were asked about, in display order.
 * @param value - decoded Remote value.
 * @returns rows for the answered refs, empty when the payload is not a record.
 */
export declare function asCredentialViews(refs: readonly string[], value: unknown): CredentialView[];
