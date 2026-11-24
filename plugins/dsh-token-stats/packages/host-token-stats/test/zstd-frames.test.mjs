/**
 * Regression tests for the concatenated-frame session-log reader.
 *
 * The bug these guard against: one-shot `zstdDecompressSync(wholeFile)` returns
 * only the FIRST frame of `session.v4.jsonl.zstd` (the one-line session header),
 * so a whole session log parsed as zero usage events. `readZstdFrames` must walk
 * every frame and decompress them one at a time.
 *
 * Fixtures are built in-memory from synthetic lines with `zstdCompressSync`; no
 * real session data is read or stored here. Correctness against real logs is
 * covered by the artifacts probe `probe-usage-store.mjs` / `equivalence-check.mjs`.
 *
 * Run: node --test test          (from packages/host-token-stats)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

import { parseSessionBytes } from '../scanner.js'
import { readZstdFrames, scanZstdFrames } from '../zstd-frames.js'

/** One synthetic usage event line (fields the scanner reads). */
function usageLine(time, inputTokens, outputTokens, cacheReadTokens = 0) {
  return `${JSON.stringify({
    type: 'assistant/message',
    time,
    data: { usage: { inputTokens, outputTokens, cacheReadTokens } },
  })}\n`
}

/** One synthetic model-selection line. */
function modelLine(model) {
  return `${JSON.stringify({ type: 'request/context', data: { model } })}\n`
}

/** One synthetic session header line, as the real logs start with. */
function headerLine() {
  return `${JSON.stringify({ type: 'session', data: { id: 'test-session' } })}\n`
}

/** Compress one batch into its own independently decodable frame. */
function frame(text) {
  return zstdCompressSync(Buffer.from(text, 'utf8'))
}

const DAY_MS = 24 * 60 * 60 * 1000
const NOON_UTC = Date.parse('2026-01-02T04:00:00.000Z')

test('first frame holds only the header; usage lives in later frames', () => {
  // Exactly the shape that used to return zero usage: frame 1 = header, then batches.
  const buffer = Buffer.concat([
    frame(headerLine()),
    frame(modelLine('test/model') + usageLine(NOON_UTC, 100, 7, 900)),
    frame(usageLine(NOON_UTC + 1000, 20, 3)),
  ])

  // The old whole-buffer call sees one frame and therefore zero usage events.
  const firstFrameOnly = readZstdFrames(buffer.subarray(0, scanZstdFrames(buffer).frames[0].end))
  assert.equal(firstFrameOnly.frames, 1)
  assert.equal(parseSessionBytes(buffer.subarray(0, scanZstdFrames(buffer).frames[0].end)).usageEvents, 0)

  // The patched reader sees them all.
  const decoded = readZstdFrames(buffer)
  assert.equal(decoded.frames, 3)
  assert.equal(decoded.decodedFrames, 3)
  assert.equal(decoded.failedFrames, 0)
  assert.equal(decoded.tornBytes, 0)

  const aggregate = parseSessionBytes(buffer)
  assert.equal(aggregate.usageEvents, 2)
  assert.equal(aggregate.failedFrames, 0)
  const billed = [...aggregate.days.values()].reduce((sum, day) => sum + day.billed, 0)
  assert.equal(billed, 100 + 7 + 900 + 20 + 3)
  // Model selection is carried from the frame it appeared in to later frames.
  assert.deepEqual([...aggregate.days.values()][0].models.get('test/model'), billed)
})

test('single-frame log still parses exactly like the whole-buffer call', () => {
  const text = headerLine() + modelLine('test/one') + usageLine(NOON_UTC, 5, 1)
  const single = frame(text)

  assert.equal(readZstdFrames(single).frames, 1)
  assert.equal(readZstdFrames(single).text, text)
  assert.equal(parseSessionBytes(single).usageEvents, 1)
  // Whole-buffer decompression is equivalent for a single frame.
  assert.equal(zstdDecompressSync(single).toString('utf8'), text)
})

test('empty file is empty text, not an error', () => {
  const decoded = readZstdFrames(Buffer.alloc(0))
  assert.deepEqual([decoded.text, decoded.frames, decoded.decodedFrames, decoded.failedFrames], ['', 0, 0, 0])
  assert.equal(parseSessionBytes(Buffer.alloc(0)).usageEvents, 0)
})

test('a torn tail frame is dropped and counted, the complete frames still count', () => {
  const complete = frame(headerLine() + modelLine('test/torn') + usageLine(NOON_UTC, 10, 2))
  const tail = frame(usageLine(NOON_UTC + 5, 99, 99))
  const torn = Buffer.concat([complete, tail.subarray(0, Math.floor(tail.length / 2))])

  const decoded = readZstdFrames(torn)
  assert.equal(decoded.frames, 1)
  assert.ok(decoded.tornBytes > 0)
  assert.equal(parseSessionBytes(torn).usageEvents, 1)

  // A tail of fewer than 4 bytes is torn too, not corrupt.
  const tiny = Buffer.concat([complete, Buffer.from([0x28, 0xb5])])
  assert.ok(readZstdFrames(tiny).tornBytes >= 2)
})

test('a corrupt stretch after a good frame is skipped and reported, not thrown', () => {
  const good = frame(headerLine() + modelLine('test/corrupt') + usageLine(NOON_UTC, 4, 1))
  const damaged = Buffer.concat([good, Buffer.from('not a zstd frame at all')])

  const decoded = readZstdFrames(damaged)
  assert.equal(decoded.frames, 1)
  assert.equal(decoded.decodedFrames, 1)
  assert.ok(decoded.corruptAt !== null)
  assert.match(String(decoded.corruptReason), /invalid frame magic/)
  assert.equal(parseSessionBytes(damaged).usageEvents, 1)
})

test('a file with no readable frame at all rejects so the caller can count it as failed', () => {
  assert.throws(() => readZstdFrames(Buffer.from('definitely not zstd')), /no complete frame/)
  assert.throws(() => parseSessionBytes(Buffer.from('definitely not zstd')))
})

test('scanZstdFrames keeps the upstream strict behaviour', () => {
  const good = frame(headerLine())
  assert.deepEqual(scanZstdFrames(good).frames, [{ start: 0, end: good.length }])
  assert.throws(() => scanZstdFrames(Buffer.from('garbage!')), /invalid frame magic/)
  assert.equal(scanZstdFrames(Buffer.concat([good, Buffer.from([0x28])])).tornStart, good.length)
  // maxFrames limits the scan to a prefix (metadata-only readers).
  const two = Buffer.concat([good, frame(usageLine(NOON_UTC, 1, 1))])
  assert.equal(scanZstdFrames(two, 1).frames.length, 1)
})
