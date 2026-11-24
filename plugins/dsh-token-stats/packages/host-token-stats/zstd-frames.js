/**
 * Zstandard frame primitives for DSH's concatenated-frame session logs.
 *
 * WHY THIS EXISTS
 * ---------------
 * `session.v4.jsonl.zstd` is not a single Zstandard frame. The JSONL persistence
 * backend appends one independently decompressable, checksummed frame per header
 * and per durable event batch, so the file is a *concatenation* of frames. Node's
 * one-shot `zstdDecompressSync(buffer)` stops after the FIRST frame — which is
 * always the one-line session header — so feeding it a whole session log returns
 * one `session` event and no usage at all. Frames must be located structurally and
 * decompressed one at a time.
 *
 * PROVENANCE
 * ----------
 * The structural walk is a port of the Harness' own reader,
 * `@deepseek-ai/dsh-session-persistence-jsonl`:
 *   - `src/zstd.ts:48-104`                `scanZstdFrames()`
 *   - `src/zstd-public-decoder.ts:20-29`  one `zstdDecompressSync` per frame
 *
 * ADDED ON TOP OF THAT PORT
 *   - skippable frames (`0x184D2A50`..`0x184D2A5F`) are skipped, not rejected;
 *   - `readZstdFrames()` is tolerant: corrupt or torn structures and individual
 *     frames that fail checksum validation are counted and skipped instead of
 *     aborting the read. Only a non-empty file that yields *no* plaintext at all
 *     still rejects, so the caller can count it as a failed file and keep the
 *     previous good aggregate instead of silently reporting zero usage.
 *
 * @module host-token-stats/zstd-frames
 */

import { zstdDecompressSync } from 'node:zlib'

/** Zstandard frame magic number. */
export const ZSTD_MAGIC = 0xfd2fb528

/** Skippable-frame magic mask: `0x184D2A50` through `0x184D2A5F`. */
const SKIPPABLE_MASK = 0xfffffff0

/** Skippable-frame base magic. */
const SKIPPABLE_MAGIC = 0x184d2a50

/**
 * Walk a concatenated Zstandard stream and return every structurally complete frame.
 *
 * Byte ranges only: no block is decompressed here. A stream that ends inside its
 * final frame reports that frame's start as `tornStart` instead of failing, which
 * is how a log caught mid-append is recognised.
 *
 * @param {Buffer} buffer - bytes present in the session artifact.
 * @param {number} [maxFrames] - stop after this many complete frames.
 * @returns {{ frames: Array<{ start: number, end: number }>, tornStart?: number, skippedBytes?: number }}
 *   complete frame ranges, an incomplete final frame start when EOF interrupts one,
 *   and the byte count of skipped skippable frames.
 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  return scanZstdStream(buffer, maxFrames, false)
}

/**
 * Decompress each frame of a structurally scanned stream. Mirrors
 * `PublicZstdFrameDecoder.decode()`: one `zstdDecompressSync` call per frame.
 *
 * @param {Buffer} buffer - the same bytes the ranges were scanned from.
 * @param {ReadonlyArray<{ start: number, end: number }>} frames - complete frame ranges.
 * @yields {Buffer} one frame plaintext per range.
 */
export function* decodeZstdFrames(buffer, frames) {
  for (const { start, end } of frames) {
    try {
      yield zstdDecompressSync(buffer.subarray(start, end))
    } catch (error) {
      throw new Error(`corrupt Zstandard session log: frame at byte ${start} failed validation`, { cause: error })
    }
  }
}

/**
 * Read a whole concatenated-frame session log as text.
 *
 * Tolerant by design: a torn tail, a corrupt stretch or a frame that fails to
 * decompress is counted and skipped, never thrown, so one damaged file cannot
 * abort a whole scan round. Empty files are empty text (not an error).
 *
 * @param {Buffer} buffer - raw `.jsonl.zstd` bytes.
 * @returns {{ text: string, frames: number, decodedFrames: number, failedFrames: number, tornBytes: number, skippedBytes: number, corruptAt: number | null, corruptReason: string | null }}
 *   concatenated plaintext plus the frame statistics of this read.
 * @throws {Error} when a non-empty buffer yields no plaintext at all.
 */
export function readZstdFrames(buffer) {
  if (buffer.length === 0) {
    return { text: '', frames: 0, decodedFrames: 0, failedFrames: 0, tornBytes: 0, skippedBytes: 0, corruptAt: null, corruptReason: null }
  }
  const scan = scanZstdStream(buffer, Number.POSITIVE_INFINITY, true)
  const chunks = []
  let failedFrames = 0
  for (const range of scan.frames) {
    try {
      chunks.push(zstdDecompressSync(buffer.subarray(range.start, range.end)))
    } catch {
      failedFrames += 1
    }
  }
  if (chunks.length === 0) {
    const at = scan.corruptAt ?? scan.tornStart ?? 0
    throw new Error(`corrupt Zstandard session log: no complete frame in ${buffer.length} bytes (first problem at byte ${at})`)
  }
  return {
    // Every frame holds whole JSONL lines (verified: no frame of 11,004 sampled across
    // 25 real session logs lacked a trailing newline), so plain concatenation is lossless.
    text: Buffer.concat(chunks).toString('utf8'),
    frames: scan.frames.length,
    decodedFrames: chunks.length,
    failedFrames,
    tornBytes: scan.tornStart === undefined ? 0 : buffer.length - scan.tornStart,
    skippedBytes: scan.skippedBytes ?? 0,
    corruptAt: scan.corruptAt ?? null,
    corruptReason: scan.corruptReason ?? null,
  }
}

/**
 * The shared walk behind `scanZstdFrames` and `readZstdFrames`.
 *
 * @param {Buffer} buffer - concatenated bytes.
 * @param {number} maxFrames - complete-frame limit.
 * @param {boolean} tolerant - report structural damage instead of throwing.
 * @returns {{ frames: Array<{ start: number, end: number }>, tornStart?: number, skippedBytes: number, corruptAt?: number, corruptReason?: string }}
 *   scan result; `tolerant` adds the corruption fields.
 */
function scanZstdStream(buffer, maxFrames, tolerant) {
  /** @type {Array<{ start: number, end: number }>} */
  const frames = []
  let skippedBytes = 0
  let offset = 0

  /** EOF inside the current structure: incomplete, not corrupt. */
  const torn = (start) => ({ frames, tornStart: start, skippedBytes })

  /** Structurally invalid bytes: reject when strict, report when tolerant. */
  const bad = (at, reason) => {
    if (!tolerant) throw new Error(`corrupt Zstandard session log: ${reason}`)
    return { frames, corruptAt: at, corruptReason: reason, skippedBytes }
  }

  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return torn(start)
    const magic = buffer.readUInt32LE(offset)
    if ((magic & SKIPPABLE_MASK) === SKIPPABLE_MAGIC) {
      // Skippable frame: 4-byte magic + 4-byte little-endian payload size, no data we need.
      if (buffer.length - offset < 8) return torn(start)
      const end = offset + 8 + buffer.readUInt32LE(offset + 4)
      if (end > buffer.length) return torn(start)
      skippedBytes += end - offset
      offset = end
      continue
    }
    if (magic !== ZSTD_MAGIC) return bad(offset, `invalid frame magic at byte ${offset}`)
    offset += 4

    if (offset === buffer.length) return torn(start)
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) return bad(offset - 1, `reserved frame-header bit at byte ${offset - 1}`)

    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return torn(start)
    offset += remainingHeaderBytes

    for (;;) {
      if (buffer.length - offset < 3) return torn(start)
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) return bad(offset - 3, `reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return torn(start)
      offset += payloadBytes
      if (lastBlock) break
    }

    if (checksum) {
      if (buffer.length - offset < 4) return torn(start)
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames, skippedBytes }
  }

  return { frames, skippedBytes }
}
