# Phase 3 — Chunker Utility: Implementation Plan

## Overview

This phase introduces a pure, synchronous text-chunking utility that splits a source string into ordered, overlapping character-based chunks suitable for embedding and vector storage. The chunker is the first stage of the Knowledge Base ingestion pipeline. It will be used by the Voyage embedding call in Phase 4 and by the Qdrant storage layer in Phase 5. In Phase 3 the chunker stands completely alone: no callers, no NestJS wiring, no external dependencies. The only deliverables are one types file, one implementation file, and one spec file.


## Affected Files / Modules

### Create

| File | Purpose |
|------|---------|
| `src/types/KnowledgeBase.ts` | New types file. Exports `Chunk`, `ChunkOptions`. Follows the same plain-interface pattern as `ChatAgent.ts`, `Tool.ts`, etc. |
| `src/utils/chunker/chunker.ts` | New utility. Exports `DEFAULT_TARGET_CHARS`, `DEFAULT_OVERLAP_CHARS`, and `chunkText`. Pure synchronous function; no imports beyond the two types above. |
| `src/utils/chunker/chunker.spec.ts` | New Jest spec. Covers all 11 required test cases. No mocking, no NestJS test scaffolding. |

### Modify

None. No existing file is touched.

### Delete

None.

### Review Only

| File | Reason to read |
|------|---------------|
| `src/types/ChatAgent.ts` | Reference for how a types file should be structured (plain interfaces, JSDoc comment at top, no imports). |
| `src/types/Tool.ts` | Reference for a multi-interface types file with brief JSDoc comments. |
| `src/utils/email/strip-quoted-reply.spec.ts` | Reference for Jest test style in this project (describe/it blocks, no beforeEach scaffolding, direct imports). |
| `CLAUDE.md` | Confirms `src/utils/<concern>/` subfolder convention and `src/types/` placement rule. |


## Algorithm Walkthrough

The algorithm is character-index-based and walks the source string with a mutable `position` pointer.

**Step 1 — Guard clause.**
Trim the source string. If the result is empty (the input was empty or whitespace-only), return `[]` immediately. All subsequent steps operate on the _original_ (untrimmed) source so that character offsets correspond to the original string's indices.

**Step 2 — Resolve options.**
Apply defaults: `targetChars = options?.targetChars ?? DEFAULT_TARGET_CHARS` and `overlapChars = options?.overlapChars ?? DEFAULT_OVERLAP_CHARS`. Initialize `position = 0` and `index = 0`.

**Step 3 — Iteration loop.**
Enter a `while (position < source.length)` loop.

**Step 4 — Compute tentative end.**
`let end = Math.min(position + targetChars, source.length)`.

**Step 5 — Boundary search (only when not already at the true end of the string).**
If `end < source.length`, search for the rightmost natural boundary within the boundary-preference window. The window spans from `position + Math.floor(targetChars * 0.75)` to `end` (inclusive of both endpoints, bounded so neither index is negative or exceeds `source.length`).

Search in this priority order, each time looking for the _rightmost_ occurrence within the window:

1. Paragraph break: `\n\n`
2. Sentence boundary: `. ` then `! ` then `? ` then `.\n` then `!\n` then `?\n`
3. Word boundary: ` ` (space) then `\n`

For each candidate, use `source.lastIndexOf(boundary, end)` and confirm the result is `>= windowStart`. For paragraph breaks and sentence boundaries, advance `end` past the matched delimiter so the boundary character(s) stay with the preceding chunk rather than beginning the next one. For a word boundary (space or newline), the index itself becomes the new `end` — the space is excluded from both chunks after the subsequent `.trim()`.

If a boundary is found (any tier), set `end` to the adjusted position and stop searching further tiers.

If no boundary is found in any tier, keep the original tentative `end` (hard-cut at `targetChars`).

**Step 6 — Extract and push chunk.**
Extract `const text = source.substring(position, end).trim()`. If `text` is non-empty, push:

```
{ text, index, startOffset: position, endOffset: end }
```

then increment `index`.

**Step 7 — Termination check.**
If `end >= source.length`, break out of the loop.

**Step 8 — Advance position.**
`position = Math.max(end - overlapChars, position + 1)`.

The `position + 1` floor is the critical termination guarantee. When `overlapChars >= end - position` (e.g., overlap is larger than the chunk that was actually produced, which can happen on pathological inputs or at the tail of a document), `end - overlapChars` would be `<= position`. Without the floor, position would not advance and the loop would spin forever. The floor ensures at least one character of progress per iteration.

**Step 9 — Repeat.**
Return to Step 3 until position reaches `source.length`.

### Boundary search helper — implementation note

The boundary search should be extracted into a named internal (non-exported) helper function, e.g. `findBoundary(source, windowStart, windowEnd)`, that returns the adjusted `end` value or `null` if no boundary was found. This keeps `chunkText` readable. The helper is not exported.


## Public API

All exported symbols live in two files:

### `src/types/KnowledgeBase.ts`

```typescript
/** A single chunk produced by chunkText(). */
export interface Chunk {
  /** The trimmed text content of this chunk. */
  text: string;
  /** Zero-based position of this chunk in the ordered sequence. */
  index: number;
  /** Character offset in the original source where this chunk begins (before trim). */
  startOffset: number;
  /** Character offset in the original source where this chunk ends (before trim). */
  endOffset: number;
}

/** Options for chunkText(). All fields are optional; defaults are applied inside the function. */
export interface ChunkOptions {
  /** Target chunk size in characters. Defaults to DEFAULT_TARGET_CHARS. */
  targetChars?: number;
  /** Number of characters to overlap between adjacent chunks. Defaults to DEFAULT_OVERLAP_CHARS. */
  overlapChars?: number;
}
```

### `src/utils/chunker/chunker.ts` — exported symbols

```typescript
export const DEFAULT_TARGET_CHARS = 2000;
export const DEFAULT_OVERLAP_CHARS = 200;
export function chunkText(source: string, options?: ChunkOptions): Chunk[]
```

Internal (non-exported) symbols:
- `findBoundary(source: string, windowStart: number, windowEnd: number): number | null` — returns adjusted `end` position or `null`.

### Import in `chunker.ts`

```typescript
import { Chunk, ChunkOptions } from '../../types/KnowledgeBase';
```


## Edge Case Matrix

| Case | Input | Expected behavior |
|------|-------|------------------|
| Empty string | `""` | Returns `[]` |
| Whitespace-only | `"   \n\n  "` | Returns `[]` (trimmed result is empty) |
| Source shorter than `targetChars` | 50-char string, default options | Returns exactly 1 chunk; `index=0`, `startOffset=0`, `endOffset=source.length`, `text` equals `source.trim()` |
| Source exactly `targetChars` | 2000-char string, default options | Returns exactly 1 chunk (the `end < source.length` condition is false on first iteration, so no boundary search; the termination check in Step 7 fires immediately) |
| Natural paragraph boundaries | Long text with `\n\n` every ~300 chars | At least one chunk boundary aligns with a `\n\n`; no mid-sentence hard-cut occurs near a paragraph break |
| Sentence boundaries, no paragraphs | Long text with `. ` but no `\n\n` | Chunk breaks fall on `. ` rather than mid-word |
| No boundaries at all | `"a".repeat(5000)` | Hard-cuts at exactly `targetChars` characters per chunk (except possibly the last); `text.length === DEFAULT_TARGET_CHARS` for all but the last |
| Overlap correctness | Any multi-chunk text | The suffix of chunk N appears as a prefix of chunk N+1 (modulo `.trim()` differences) |
| Sequential indices | Any multi-chunk text | `chunks.map(c => c.index)` deep-equals `[0, 1, 2, ..., n-1]` |
| Custom options honored | `{ targetChars: 500, overlapChars: 50 }` | All chunks except possibly the last have `text.length <= 500 + some_small_boundary_slack` |
| Pathological overlap | `"a".repeat(10000)`, `{ targetChars: 100, overlapChars: 200 }` | Function terminates (no infinite loop) and returns a non-empty array; the `position + 1` floor drives progress |
| Unicode / multi-byte chars | Text containing emoji or multi-byte sequences | Character offsets are JavaScript code-unit indices (as returned by `.length`, `.substring`, `String.prototype.indexOf`). Grapheme clusters are not handled. This is documented behavior, not a bug. |


## Step-by-Step Implementation Order

1. **Create `src/types/KnowledgeBase.ts`**
   - Define and export `Chunk` interface (4 fields: `text`, `index`, `startOffset`, `endOffset`).
   - Define and export `ChunkOptions` interface (2 optional fields: `targetChars`, `overlapChars`).
   - Add brief JSDoc comment above each interface (consistent with `Tool.ts` style).
   - No imports needed.
   - Done when: `npx tsc --noEmit` passes with no errors on this file.

2. **Create `src/utils/chunker/chunker.ts` — constants and imports**
   - Add the import of `Chunk` and `ChunkOptions` from `../../types/KnowledgeBase`.
   - Export `DEFAULT_TARGET_CHARS = 2000` and `DEFAULT_OVERLAP_CHARS = 200`.
   - Done when: file compiles cleanly with just these lines.

3. **Implement `findBoundary` helper (internal, non-exported)**
   - Signature: `function findBoundary(source: string, windowStart: number, windowEnd: number): number | null`.
   - Implements the three-tier boundary search described in the algorithm walkthrough.
   - Returns the adjusted `end` value, or `null` if nothing found.
   - Done when: isolated unit reasoning confirms it returns correct values for paragraph, sentence, and word boundaries, and returns `null` for a boundary-free window.

4. **Implement `chunkText` function**
   - Implement Steps 1–9 of the algorithm walkthrough using `findBoundary`.
   - Ensure the guard clause uses the trimmed source to decide whether to return `[]`, but the loop operates on the original source string.
   - Ensure `startOffset` and `endOffset` are set to the pre-trim `position` and `end` values, not the post-trim offsets.
   - Done when: manual trace of a 3-chunk example produces the expected array.

5. **Create `src/utils/chunker/chunker.spec.ts`**
   - Direct import: `import { chunkText, DEFAULT_TARGET_CHARS, DEFAULT_OVERLAP_CHARS } from './chunker'`.
   - No `import { Test } from '@nestjs/testing'`. Pure Jest only.
   - One top-level `describe('chunkText', ...)` block.
   - Implement all 11 test cases (see Testing Strategy below).
   - Done when: `npm test -- chunker` runs and all 11 pass.

6. **Run `npm run build` and `npm test`**
   - Both must be clean before declaring Phase 3 complete.


## Testing Strategy

All tests live in `src/utils/chunker/chunker.spec.ts` inside `describe('chunkText', () => { ... })`.

### Test 1 — Empty string returns `[]`
```
it('returns an empty array for an empty string', () => {
  expect(chunkText('')).toEqual([]);
});
```
Assertion: strict deep-equal to `[]`.

### Test 2 — Whitespace-only returns `[]`
```
it('returns an empty array for a whitespace-only string', () => {
  expect(chunkText('   \n\n   \t  ')).toEqual([]);
});
```
Assertion: strict deep-equal to `[]`.

### Test 3 — Source shorter than `DEFAULT_TARGET_CHARS` → single chunk
```
it('returns a single chunk for a source shorter than DEFAULT_TARGET_CHARS', () => {
  const source = 'Hello world. This is a short document.';
  const chunks = chunkText(source);
  expect(chunks).toHaveLength(1);
  expect(chunks[0].index).toBe(0);
  expect(chunks[0].startOffset).toBe(0);
  expect(chunks[0].endOffset).toBe(source.length);
  expect(chunks[0].text).toBe(source.trim());
});
```

### Test 4 — Source exactly `DEFAULT_TARGET_CHARS` → single chunk
```
it('returns a single chunk when source length equals DEFAULT_TARGET_CHARS', () => {
  const source = 'a'.repeat(DEFAULT_TARGET_CHARS);
  const chunks = chunkText(source);
  expect(chunks).toHaveLength(1);
  expect(chunks[0].text.length).toBe(DEFAULT_TARGET_CHARS);
});
```

### Test 5 — Paragraph breaks produce chunk boundaries aligned with `\n\n`
Build a source of ~6000 chars by joining paragraphs with `\n\n`. After chunking, for at least one adjacent pair `[chunkN, chunkN+1]`, assert that the original source at `chunkN.endOffset` contains `\n\n` (or the combined text of both chunks, when concatenated with `\n\n`, reconstructs the source region).

Pragmatic assertion approach: take the endOffset of chunk 0. Assert `source.substring(chunks[0].endOffset).trimStart()` starts where chunk 1's text begins — i.e., no mid-sentence word was cut. More directly: build paragraphs as known strings, run `chunkText`, then verify that `chunks[0].text` ends with the last sentence of a paragraph boundary, not mid-paragraph.

```
it('breaks on paragraph boundaries when available', () => {
  const paragraph = 'Word '.repeat(180).trim(); // ~900 chars
  const source = [paragraph, paragraph, paragraph, paragraph, paragraph].join('\n\n');
  const chunks = chunkText(source);
  expect(chunks.length).toBeGreaterThan(1);
  // At least one chunk ends cleanly at a paragraph break, not mid-word.
  // The text between chunk 0 and chunk 1 in the original source should contain \n\n.
  const gapStart = chunks[0].endOffset;
  const gapEnd = chunks[1].startOffset;
  const gap = source.substring(gapStart, gapEnd);
  expect(gap).toMatch(/\n\n/);
});
```

Note: `startOffset` and `endOffset` are the pre-trim window boundaries, so the `\n\n` separator lives in the gap between them when the break aligns with a paragraph boundary.

### Test 6 — Sentence breaks when no paragraph breaks exist
```
it('breaks on sentence boundaries when no paragraph breaks are present', () => {
  // Build ~5000 chars of text that uses '. ' but no \n\n.
  const sentence = 'The quick brown fox jumps over the lazy dog. ';
  const source = sentence.repeat(Math.ceil(5000 / sentence.length));
  const chunks = chunkText(source);
  expect(chunks.length).toBeGreaterThan(1);
  // Every chunk (except possibly the last) should end with a period+space or period
  // when we look at the raw source window, not mid-word.
  for (let i = 0; i < chunks.length - 1; i++) {
    const rawEnd = source.substring(chunks[i].endOffset - 2, chunks[i].endOffset);
    expect(rawEnd).toMatch(/\.\s?$/);
  }
});
```

### Test 7 — No boundaries → hard cuts at `DEFAULT_TARGET_CHARS`
```
it('hard-cuts at targetChars when no natural boundaries exist', () => {
  const source = 'a'.repeat(5000);
  const chunks = chunkText(source);
  // All chunks except the last must be exactly DEFAULT_TARGET_CHARS in text length.
  for (let i = 0; i < chunks.length - 1; i++) {
    expect(chunks[i].text.length).toBe(DEFAULT_TARGET_CHARS);
  }
  // Last chunk text length <= DEFAULT_TARGET_CHARS.
  expect(chunks[chunks.length - 1].text.length).toBeLessThanOrEqual(DEFAULT_TARGET_CHARS);
});
```

### Test 8 — Overlap: suffix of chunk N appears as prefix of chunk N+1

This is the most subtle assertion. The overlap guarantee comes from `position = max(end - overlapChars, position + 1)`. For the standard no-boundary case, the next chunk starts `overlapChars` chars before where the previous chunk ended. After `.trim()`, leading/trailing whitespace may consume a few characters, so allow a small slack of `DEFAULT_OVERLAP_CHARS * 0.1` (i.e., 20 chars).

```
it('adjacent chunks overlap by approximately DEFAULT_OVERLAP_CHARS characters', () => {
  const source = 'a'.repeat(5000); // no boundaries, predictable hard cuts
  const chunks = chunkText(source);
  expect(chunks.length).toBeGreaterThan(1);
  for (let i = 0; i < chunks.length - 1; i++) {
    const current = chunks[i].text;
    const next = chunks[i + 1].text;
    // The last DEFAULT_OVERLAP_CHARS chars of current should appear at the start of next.
    const overlapSuffix = current.slice(-DEFAULT_OVERLAP_CHARS);
    expect(next.startsWith(overlapSuffix)).toBe(true);
  }
});
```

For the boundary-aligned case (test 5's paragraph text), the overlap may differ slightly because the boundary search adjusts `end`. The test above uses the no-boundary source for precision.

### Test 9 — Chunk indices are sequential from 0
```
it('assigns sequential indices starting from 0', () => {
  const source = 'a'.repeat(5000);
  const chunks = chunkText(source);
  const indices = chunks.map(c => c.index);
  expect(indices).toEqual(Array.from({ length: chunks.length }, (_, i) => i));
});
```

### Test 10 — Custom options are honored
```
it('respects custom targetChars and overlapChars', () => {
  const source = 'Hello world. '.repeat(200); // ~2600 chars
  const chunks = chunkText(source, { targetChars: 500, overlapChars: 50 });
  // Allow small variance (~15%) for boundary alignment.
  const allowedMax = Math.ceil(500 * 1.15);
  for (const chunk of chunks) {
    expect(chunk.text.length).toBeLessThanOrEqual(allowedMax);
  }
  // Should produce more chunks than with default options.
  expect(chunks.length).toBeGreaterThan(1);
});
```

### Test 11 — Pathological input terminates
```
it('terminates without infinite loop when overlapChars >= targetChars', () => {
  // This would loop forever without the position + 1 floor.
  const chunks = chunkText('a'.repeat(10000), { targetChars: 100, overlapChars: 200 });
  // Just assert it ran and returned something.
  expect(Array.isArray(chunks)).toBe(true);
  expect(chunks.length).toBeGreaterThan(0);
});
```

No `jest.setTimeout` override is needed; if the floor is missing the test runner itself will hang, making the failure obvious.


## Out-of-Scope Confirmations

The following are explicitly **not** part of Phase 3:

- **No callers.** `chunkText` is not imported or called from any service, controller, tool, gateway, or module. Phase 4 will add the first caller.
- **No NestJS DI.** The chunker is a plain exported function, not an `@Injectable()` service class. No module registration.
- **No tokenizer dependency.** Character count only. Exact token counting is a Phase 7 concern.
- **No Unicode grapheme handling.** Offsets are JavaScript code-unit indices. Multi-byte characters and emoji will produce correct (if potentially non-grapheme-aligned) chunks. This is documented, not fixed.
- **No async.** The function is fully synchronous. No `Promise`, no `async/await`.
- **No logging.** No `console.log`, no NestJS `Logger`, no observability hooks.
- **No index barrel file.** Do not create `src/utils/chunker/index.ts` unless the project's existing utils barrel pattern requires it (currently `src/utils/email/` has no barrel). Keep the import path explicit: `../../utils/chunker/chunker`.
- **No modifications to existing types files.** `KnowledgeBase.ts` is a net-new file; no existing type file is touched.
- **No database or external service interaction.** This is a pure string transformation.
