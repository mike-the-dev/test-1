# Phase 7b — Claude Enrichment at Ingestion: Architecture Plan

**Status:** Awaiting orchestrator approval before implementation begins.

---

## Overview

Phase 7b inserts a Claude enrichment step into the document ingestion pipeline so that every chunk is paired with a generated summary, likely customer questions, and key terms before being embedded by Voyage. The combined text (`chunk_text` + enrichment) becomes the input to `Voyage.embedTexts`, producing vectors that sit closer to the natural-language query neighborhood in embedding space. Enrichment output is also stored in the Qdrant point payload for audit and debugging. If enrichment fails for an individual chunk, the pipeline falls back to embedding just `chunk_text` for that chunk and continues. The new `KnowledgeBaseEnrichmentService` follows the same structural pattern as `VoyageService`: constructor DI, Logger, named constants, sanitized errors, no API key leakage. No new npm dependencies are introduced.

---

## Affected Files and Modules

**Create**
- `src/services/knowledge-base-enrichment.service.ts` — new service; owns the prompt constant, the Anthropic SDK call, response parsing, and per-chunk failure isolation
- `src/services/knowledge-base-enrichment.service.spec.ts` — full unit test suite for the new service

**Modify**
- `src/types/KnowledgeBase.ts` — add `enrichment?: string` to `KnowledgeBasePointPayload`
- `src/services/knowledge-base-ingestion.service.ts` — inject `KnowledgeBaseEnrichmentService`; add enrichment step between chunker output and `voyageService.embedTexts`; pass per-chunk enrichment result into `writeQdrantPoints`; update `writeQdrantPoints` signature and payload construction
- `src/services/knowledge-base-ingestion.service.spec.ts` — add `mockEnrichmentService` to the test module; update existing assertions that inspect Qdrant point payloads; add new test cases for enrichment paths
- `src/app.module.ts` — add `KnowledgeBaseEnrichmentService` to providers array
- `docs/knowledge-base/data-flows.md` — insert enrichment step into Flow 1 and Flow 3; update the cost section

**Review Only**
- `src/services/anthropic-config.service.ts` — confirms `apiKey` and `model` getters; no changes needed
- `src/services/anthropic.service.ts` — confirms SDK instantiation pattern; not used by the enrichment service directly

---

## Anthropic SDK Verification Findings

Verified directly from the installed `@anthropic-ai/sdk` package at `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts`.

### Call signature for non-streaming, non-tool, single-response

```typescript
client.messages.create(body: MessageCreateParamsNonStreaming): APIPromise<Message>
```

`MessageCreateParamsNonStreaming` extends `MessageCreateParamsBase` with `stream: false`. The fields relevant to this phase:

| Field | Type | Required | Notes |
|---|---|---|---|
| `model` | `string` | yes | Model identifier |
| `max_tokens` | `number` | yes | Hard ceiling |
| `messages` | `Array<MessageParam>` | yes | `[{ role: 'user', content: string }]` is the simplest legal shape |
| `system` | `string \| Array<TextBlockParam>` | no | **Top-level argument**, not nested inside messages |
| `tools` | `Array<Tool>` | no | Omit entirely for non-tool calls |
| `stream` | `boolean` | no | Omit or set `false` to get a non-streaming `Message` response |

Source: `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts` lines 1802–1942 and 2060.

### Response shape

```typescript
interface Message {
  content: Array<ContentBlock>;  // ContentBlock = TextBlock | ToolUseBlock
  stop_reason: StopReason | null;
  // ...
}

interface TextBlock {
  type: 'text';
  text: string;
  citations: Array<TextCitation> | null;
}
```

For a non-tool call, `response.content` will contain exactly one `TextBlock`. Text extraction:

```typescript
const block = response.content[0];
if (block.type !== 'text') { /* treat as parse failure */ }
const rawText = block.text;
```

Source: `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts` lines 541–640, 875–886.

### Error classes

The SDK exports typed error classes from `node_modules/@anthropic-ai/sdk/core/error.d.ts`:

| Class | HTTP status |
|---|---|
| `APIError` | base; has `.status: number`, `.type: ErrorType \| null` |
| `RateLimitError` | 429 |
| `AuthenticationError` | 401 |
| `APIConnectionError` | network-level (no status) |
| `InternalServerError` | 500 |

The `.type` field on `APIError` is the API-level error type string (e.g. `"rate_limit_error"`). Safe to log `.status` and `.type`. Never log `.error` (contains full API response body which may include context from the request).

Import path for the catch block:

```typescript
import Anthropic from "@anthropic-ai/sdk";
// Anthropic.APIError, Anthropic.RateLimitError, etc.
```

---

## Service Design

### File: `src/services/knowledge-base-enrichment.service.ts`

**Named exported constants** (all at the top of the file, before the class):

```typescript
export const ENRICHMENT_CONCURRENCY_CAP = 5;

export const ENRICHMENT_MAX_TOKENS = 400;

// If switching to Haiku in a future phase, change this constant.
// Haiku costs ~6× less per token but may produce lower-quality enrichment.
export const ENRICHMENT_PROMPT = `...` // see Prompt Finalization section below

// Exported so tests can assert it is used verbatim.
```

**Class shape**:

```typescript
@Injectable()
export class KnowledgeBaseEnrichmentService {
  private readonly logger = new Logger(KnowledgeBaseEnrichmentService.name);
  private readonly client: Anthropic;

  constructor(private readonly anthropicConfig: AnthropicConfigService) {
    this.client = new Anthropic({ apiKey: this.anthropicConfig.apiKey });
  }

  async enrichChunk(chunkText: string): Promise<string | null>
}
```

**Public API surface**: one method only — `enrichChunk(chunkText: string): Promise<string | null>`.

- Returns the enrichment string (the three-section plain-text block) on success.
- Returns `null` on any failure: API error, network error, parse failure, missing content block.
- The caller (`KnowledgeBaseIngestionService`) owns the fallback logic. The enrichment service never throws — it always returns `string | null`.

**Why a new service rather than extending `AnthropicService`**:
`AnthropicService.sendMessage` is built around the chat-conversation contract: it takes `ChatSessionMessage[]`, `ChatToolDefinition[]`, builds `TextBlockParam[]` with `cache_control`, and returns `ChatAnthropicResponse` with a content-block array. That interface is wrong for enrichment. Adding a second method to `AnthropicService` would either force enrichment to work through the chat-response type system (noisy) or require a second, largely parallel code path inside the same class that serves two unrelated concerns. A dedicated service is cleaner, independently testable, and directly mirrors the pattern established by `VoyageService` (each external API gets its own injectable service).

**Why not use `AnthropicConfigService.model` for enrichment**: `AnthropicConfigService.model` is the correct model to use — the brief locks Sonnet for this phase and that is the configured default. The enrichment service reads `this.anthropicConfig.model` in the SDK call, exactly as `AnthropicService` does. No change to `AnthropicConfigService`.

---

## Concurrency Design

No new npm dependencies. The concurrency cap is implemented as a small inline helper function — a Promise-pool that keeps at most `ENRICHMENT_CONCURRENCY_CAP` promises in flight at any time.

**Helper pattern** (proposed as a private static method or a standalone unexported function in the enrichment service file):

```
async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  cap: number,
): Promise<T[]>
```

Implementation strategy: maintain a Set of active promises. When the Set reaches `cap`, `await Promise.race(active)` to wait for the first to finish before starting the next.

Concrete shape:

```typescript
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  cap: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  const active = new Set<Promise<void>>();

  for (let i = 0; i < tasks.length; i++) {
    const index = i;
    const p: Promise<void> = tasks[index]().then((value) => {
      results[index] = value;
      active.delete(p);
    });
    active.add(p);

    if (active.size >= cap) {
      await Promise.race(active);
    }
  }

  await Promise.all(active);
  return results;
}
```

This function is placed at module scope in `knowledge-base-enrichment.service.ts` (not exported). The ingestion service calls it through `KnowledgeBaseEnrichmentService.enrichAllChunks` (see Pipeline Integration below) or the ingestion service itself calls `runWithConcurrency` — the cleaner encapsulation is to keep concurrency inside the enrichment service entirely, exposing a single `enrichAllChunks(chunks: KnowledgeBaseChunk[]): Promise<Array<string | null>>` method that wraps `enrichChunk` with the cap applied. This keeps the ingestion service's `ingestDocument` free of concurrency wiring.

**Revised public API**:

```typescript
// Primary call used by ingestion:
async enrichAllChunks(chunks: KnowledgeBaseChunk[]): Promise<Array<string | null>>

// Used by enrichAllChunks internally; also independently testable:
async enrichChunk(chunkText: string): Promise<string | null>
```

`enrichAllChunks` wraps each chunk's `enrichChunk` call as a `() => Promise<string | null>` thunk, passes the array to `runWithConcurrency`, and returns the results array (index-aligned with the input chunks array).

---

## Prompt Finalization

### Final prompt constant

```typescript
export const ENRICHMENT_PROMPT = `You are preparing knowledge base content for semantic vector search. A customer-facing AI assistant will use vector search to find relevant passages when answering visitor questions about a business.

Read the passage below and generate enrichment text that will be embedded alongside the original passage. The goal is to make the combined vector match a wider range of natural customer query phrasings while preserving the passage's meaning.

Generate exactly three sections in this format. Use no markdown, no code blocks, no extra headings:

SUMMARY:
<one to two sentences rephrasing the passage in plain, customer-friendly language>

QUESTIONS:
- <question a customer might ask whose answer is in this passage>
- <question>
- <question>
- <optional question>
- <optional question>

KEY TERMS:
<comma-separated list of 5 to 10 words or short phrases a customer might use, including informal synonyms>

PASSAGE:
`;
```

The passage text is appended to this constant at call time: `ENRICHMENT_PROMPT + chunkText`.

**Deviations from the brief's starting point and justifications**:

1. "vector retrieval" → "vector search" — slightly more natural phrasing, same meaning.
2. "structured list of input messages" removed — not relevant to what Claude needs to know.
3. "no markdown, no code blocks" simplified to one instruction rather than two — reduces token count slightly without losing meaning.
4. "5–10 words a customer might use" reworded to "5 to 10 words or short phrases" — the word "phrases" handles the case where the key term is multi-word (e.g., "same-day service"), which is common in real KB content.
5. The PASSAGE section label is retained as the final line of the constant so `ENRICHMENT_PROMPT + chunkText` is valid without any join logic.
6. The `<optional question 4>` / `<optional question 5>` notation is replaced with a single bullet example — Claude understands optionality from context and the placeholder syntax can confuse some outputs into literally including angle-bracket text.
7. Instruction to produce "exactly three sections" added — this helps the parser know to reject outputs that produce a different structure.

The three-section structure (SUMMARY / QUESTIONS / KEY TERMS) is unchanged per the brief's constraint.

---

## Response Parsing

After receiving `response.content[0]`, the service validates Claude's output:

**Step 1 — content block type check**
```
if content[0].type !== 'text' → return null (log: unexpected content block type)
```

**Step 2 — section presence check**
Parse `block.text` by locating the three section headers. Use `indexOf` with the exact strings `'SUMMARY:'`, `'QUESTIONS:'`, `'KEY TERMS:'`. If any is missing → return null (log: missing section).

**Step 3 — extract enrichment text**
The enrichment stored in the payload and concatenated for embedding is the full raw text returned by Claude (everything from "SUMMARY:" onward). This is the cleanest approach:
- No lossy transformation.
- The full structured block is readable in the Qdrant payload for debugging.
- The embedding captures the entire generated content, not just fragments.

Do NOT attempt to parse individual questions or terms into structured data — the brief does not require that and it adds fragility.

**Parse failure behavior**: log at `warn` level with `[chunkIndex=N errorType=ParseFailure]` and return `null`. The caller falls back to embedding just `chunk_text`.

---

## Type Additions

**Modification to `src/types/KnowledgeBase.ts`**:

Add one optional field to `KnowledgeBasePointPayload`:

```typescript
export interface KnowledgeBasePointPayload {
  account_id: string;
  document_id: string;
  document_title: string;
  external_id: string;
  chunk_index: number;
  chunk_text: string;
  start_offset: number;
  end_offset: number;
  source_type: KnowledgeBaseSourceType;
  /** ISO-8601 */
  _createdAt_: string;
  /** Claude-generated enrichment text (SUMMARY + QUESTIONS + KEY TERMS). Present only when enrichment succeeded for this chunk. */
  enrichment?: string;
}
```

No other type changes. The `KnowledgeBaseRetrievalChunk` type (what the retrieval tool returns to Claude) is unchanged — it maps from `chunk_text` only.

---

## Pipeline Integration

### Current call flow in `ingestDocument`

```
chunks = chunkText(input.text)          // Step 5a
embeddings = voyageService.embedTexts(chunks.map(c => c.text))  // Step 5b
ensureCollection()                       // Step 5c
ensurePayloadIndex()                     // Step 5d
[delete old points if update]            // Step 6
writeQdrantPoints(...)                   // Step 7
writeDynamoRecord(...)                   // Step 8
```

### Modified call flow

```
chunks = chunkText(input.text)                           // Step 5a (unchanged)
enrichments = enrichmentService.enrichAllChunks(chunks)  // Step 5b NEW
textsToEmbed = chunks.map((chunk, i) =>                  // Step 5c NEW
  enrichments[i] !== null
    ? `${chunk.text}\n\n${enrichments[i]}`
    : chunk.text
)
embeddings = voyageService.embedTexts(textsToEmbed)      // Step 5d (was 5b)
ensureCollection()                                       // Step 5e (unchanged)
ensurePayloadIndex()                                     // Step 5f (unchanged)
[delete old points if update]                            // Step 6 (unchanged)
writeQdrantPoints(..., enrichments)                      // Step 7 — new param
writeDynamoRecord(...)                                   // Step 8 (unchanged)
```

**Per-chunk failure isolation** — the control structure is in `enrichAllChunks` and the `textsToEmbed` mapping. Because `enrichChunk` catches all errors internally and returns `null`, and `enrichAllChunks` collects results index-aligned, the `enrichments` array is always `(string | null)[]` with length === `chunks.length`. The fallback path is a simple conditional in the `textsToEmbed` map. The ingestion service never sees a thrown error from enrichment.

**All-chunks-fail path**: after `enrichAllChunks` resolves, the ingestion service counts failed chunks:

```typescript
const failedCount = enrichments.filter((e) => e === null).length;
if (failedCount === chunks.length) {
  this.logger.warn(
    `All chunk enrichments failed — embedding without enrichment [documentId=${documentId} chunkCount=${chunks.length} failedCount=${failedCount}]`,
  );
} else if (failedCount > chunks.length / 2) {
  this.logger.warn(
    `Majority of chunk enrichments failed [documentId=${documentId} chunkCount=${chunks.length} failedCount=${failedCount}]`,
  );
}
```

This warning is logged after `enrichAllChunks` completes. Ingestion then continues normally — no throw.

**`writeQdrantPoints` signature change**:

```typescript
private async writeQdrantPoints(
  documentId: string,
  input: KnowledgeBaseIngestDocumentInput,
  chunks: KnowledgeBaseChunk[],
  embeddings: number[][],
  enrichments: Array<string | null>,  // NEW parameter
  createdAt: string,
): Promise<void>
```

In the payload construction inside `writeQdrantPoints`:

```typescript
payload: {
  account_id: input.accountId,
  document_id: documentId,
  document_title: input.title,
  external_id: input.externalId,
  chunk_index: chunk.index,
  chunk_text: chunk.text,
  start_offset: chunk.startOffset,
  end_offset: chunk.endOffset,
  source_type: input.sourceType,
  _createdAt_: createdAt,
  ...(enrichments[index] !== null ? { enrichment: enrichments[index] } : {}),
} satisfies KnowledgeBasePointPayload,
```

The spread conditional ensures `enrichment` is absent (not `undefined`, not empty string) when enrichment failed for that chunk.

---

## Step-by-Step Implementation Sequence

**1. `src/types/KnowledgeBase.ts`** — Add `enrichment?: string` to `KnowledgeBasePointPayload`.
- Why first: downstream code (`writeQdrantPoints`) uses `satisfies KnowledgeBasePointPayload`. TypeScript will error if the new field is present in the value before it exists in the type. Establishing the type first makes every subsequent step clean.
- Done when: `npm run build` compiles this file without errors.

**2. `src/services/knowledge-base-enrichment.service.ts`** — Create the new service.
- Contents:
  - Module-scope unexported `runWithConcurrency<T>` helper function (per the concurrency design above).
  - `export const ENRICHMENT_CONCURRENCY_CAP = 5`
  - `export const ENRICHMENT_MAX_TOKENS = 400`
  - `export const ENRICHMENT_PROMPT = ...` (per the prompt finalization section)
  - `KnowledgeBaseEnrichmentService` class with `enrichChunk` and `enrichAllChunks` methods.
- `enrichChunk` implementation:
  - Call `this.client.messages.create({ model: this.anthropicConfig.model, max_tokens: ENRICHMENT_MAX_TOKENS, system: undefined, messages: [{ role: 'user', content: ENRICHMENT_PROMPT + chunkText }] })` — no `system`, no `tools`, `stream` omitted.
  - In the try block: extract `response.content[0]`, type-check, run the two-step section validation, return the trimmed text on success.
  - In the catch block: identify error type safely (`error instanceof Anthropic.APIError ? error.status : 'unknown'`), log with `[chunkIndex=... errorType=...]` (note: `enrichChunk` doesn't know the chunk index — the index is logged by `enrichAllChunks` or the ingestion layer; see below), return `null`. Do NOT rethrow.
- `enrichAllChunks` implementation:
  - Map each chunk to a thunk: `() => this.enrichChunk(chunk.text)`.
  - Pass the thunk array and `ENRICHMENT_CONCURRENCY_CAP` to `runWithConcurrency`.
  - Return the result array.
  - For per-chunk error logging that includes chunk index, `enrichChunk` receives only the text; the wrapper in `enrichAllChunks` can log the index when it detects a `null` result if desired, OR pass `chunkIndex` as a second parameter to `enrichChunk` for logging purposes only. Recommendation: add `chunkIndex: number` as a second parameter to `enrichChunk` so error log lines include `[chunkIndex=N]`.
- Done when: `npm run build` compiles the file without errors.

**3. `src/services/knowledge-base-enrichment.service.spec.ts`** — Write full unit test suite.
- See Testing Strategy section for the complete list of cases.
- Done when: all new tests pass.

**4. `src/services/knowledge-base-ingestion.service.ts`** — Inject and integrate.
- Constructor: add `private readonly enrichmentService: KnowledgeBaseEnrichmentService` parameter.
- `ingestDocument`: insert enrichment step (per Pipeline Integration above), build `textsToEmbed`, add the failure-count warning logic, update `writeQdrantPoints` call to pass `enrichments`.
- `writeQdrantPoints`: add `enrichments: Array<string | null>` parameter; update payload construction with the conditional spread.
- Done when: `npm run build` compiles without errors.

**5. `src/services/knowledge-base-ingestion.service.spec.ts`** — Update existing tests and add new cases.
- Add `mockEnrichmentService` to the module providers.
- Update `mockVoyageService.embedTexts` assertion in the existing happy-path test to expect combined texts (when enrichment succeeds).
- Add new test cases per Testing Strategy.
- Done when: all tests pass.

**6. `src/app.module.ts`** — Add `KnowledgeBaseEnrichmentService` to providers.
- Done when: `npm run build` succeeds; app bootstraps without injection errors.

**7. `docs/knowledge-base/data-flows.md`** — Update Flow 1 and Flow 3 diagrams and cost sections.
- Exact text specified in the Data-Flows Doc Updates section below.
- Done when: doc accurately reflects the new step ordering.

---

## Risks and Edge Cases

**High — Synchronous ingestion latency for large documents**
A 100-chunk document at 5-way concurrency requires ~20 serial batches of 5 Claude calls each. At roughly 3–5 seconds per call (typical Sonnet p50 latency), this is 60–100 seconds of wall-clock time before the HTTP response returns. The upstream control-panel API's own HTTP client timeout may be shorter than this. Phase 7b accepts this risk explicitly; Phase 7c adds the async queue. The orchestrator should flag this to the user before approval: what is the upstream client's HTTP timeout for `POST /knowledge-base/documents`?

Mitigation for this phase: log elapsed time at each enrichment batch so operators can observe latency in logs. The existing end-of-ingestion `durationMs` log captures total time.

**High — Anthropic rate limit mid-ingestion**
If a 50-chunk document trips the Anthropic rate limit at chunk 30, chunks 30–49 will return `null` enrichments. Those chunks get embedded with `chunk_text` only. The ingestion completes, but retrieval quality is degraded for roughly the second half of the document. There is no retry logic in this phase (that would add queue complexity). The majority-failure warning log will fire.

Mitigation: the brief has accepted this. Operators can re-ingest the document (which is idempotent) once the rate limit window clears.

**Medium — Malformed Claude output**
Claude may occasionally produce output that does not contain all three section headers, especially for very short chunks (< 50 characters) or chunks containing mostly boilerplate text (page numbers, headers, footers). The parse check handles this by returning `null`, but retrieval quality will be reduced for those specific chunks.

Mitigation: the chunker already trims whitespace. Consider whether the chunker should emit a minimum-length threshold to skip very short chunks. This is out of scope for 7b but worth noting.

**Medium — `enrichment` being empty string vs absent**
The conditional spread `...(enrichments[index] !== null ? { enrichment: enrichments[index] } : {})` ensures `enrichment` is absent on failure, not `""`. If Claude ever returns an empty response (which the parse check catches), the field will also be absent. The Phase 5 reviewer should confirm the `satisfies KnowledgeBasePointPayload` check still compiles with the optional field conditionally present.

**Low — All-chunks-fail scenario behavior**
If all chunks fail enrichment, the document is still ingested with unenriched vectors. The DDB record gets `status: "ready"` — there is no separate `status: "enrichment_failed"` in this phase. An operator has no programmatic way to detect which documents need re-enrichment other than inspecting Qdrant payloads for absent `enrichment` fields. This is acceptable for Phase 7b but should be noted as a monitoring gap.

**Low — `enrichAllChunks` result array alignment**
The `runWithConcurrency` helper must preserve index alignment between the input thunks and the output results. The implementation uses `results[index] = value` with a closure over `index`, which preserves alignment even when tasks resolve out of order. The test for this should verify alignment explicitly.

---

## Testing Strategy

### New test file: `src/services/knowledge-base-enrichment.service.spec.ts`

The test module provides `AnthropicConfigService` (mocked) and mocks the `@anthropic-ai/sdk` default export at the module level to control `client.messages.create`.

**Test cases**:

1. **Happy path — returns trimmed enrichment string**
   Setup: `messages.create` resolves with `content: [{ type: 'text', text: 'SUMMARY:\nSome summary\n\nQUESTIONS:\n- Q1\n\nKEY TERMS:\nterm1, term2' }]`.
   Assert: `enrichChunk('chunk text')` resolves to the trimmed text string (not `null`).

2. **Prompt is included verbatim in the SDK call**
   Assert: the `messages[0].content` argument passed to `messages.create` equals `ENRICHMENT_PROMPT + 'chunk text'`.

3. **Model and max_tokens are correct**
   Assert: `model` equals the value returned by the config mock; `max_tokens` equals `ENRICHMENT_MAX_TOKENS`.

4. **No system prompt, no tools**
   Assert: the call args do not include `system` and do not include `tools`.

5. **Parse failure — SUMMARY missing → returns null**
   Setup: `messages.create` resolves with content block text that lacks `'SUMMARY:'`.
   Assert: returns `null`.

6. **Parse failure — QUESTIONS missing → returns null**
   Setup: similar, missing `'QUESTIONS:'`.
   Assert: returns `null`.

7. **Parse failure — KEY TERMS missing → returns null**
   Setup: similar, missing `'KEY TERMS:'`.
   Assert: returns `null`.

8. **Parse failure — content[0] is not a text block → returns null**
   Setup: `messages.create` resolves with `content: [{ type: 'tool_use', id: '...', name: '...', input: {} }]`.
   Assert: returns `null`.

9. **API error (RateLimitError) → returns null, does not throw**
   Setup: `messages.create` rejects with a `RateLimitError` (status 429).
   Assert: `enrichChunk(...)` resolves to `null` (does not reject).

10. **Network error → returns null, does not throw**
    Setup: `messages.create` rejects with a generic `Error('network')`.
    Assert: resolves to `null`.

11. **enrichAllChunks — all succeed, returns index-aligned results**
    Setup: 3 chunks, each `enrichChunk` returns distinct enrichment strings.
    Assert: result array has length 3, each entry matches the expected string at that index.

12. **enrichAllChunks — one chunk fails, others succeed**
    Setup: 3 chunks; chunk index 1 fails (mock rejects on the second call).
    Assert: result is `['enrich0', null, 'enrich2']`.

13. **enrichAllChunks — concurrency cap respected (no more than 5 inflight calls)**
    Setup: 10 chunks; intercept calls with a counter that tracks concurrent inflight promises (using a manual Promise resolver queue).
    Assert: max concurrent calls at any point is <= `ENRICHMENT_CONCURRENCY_CAP`.

14. **enrichAllChunks — empty chunk array → returns []**
    Assert: resolves to `[]`, `messages.create` never called.

### Updates to `src/services/knowledge-base-ingestion.service.spec.ts`

**Add to test module setup**:
- `mockEnrichmentService = { enrichAllChunks: jest.fn() }`
- Default happy-path setup: `mockEnrichmentService.enrichAllChunks.mockResolvedValue(['enrich0', 'enrich1', 'enrich2'])` (aligned with `STUB_CHUNKS`).
- Provide `KnowledgeBaseEnrichmentService` using `mockEnrichmentService`.

**Update existing tests that assert on `embedTexts` call args**:
- `"calls embedTexts with the chunk texts in chunker order"` — this assertion becomes wrong. Update to assert that `embedTexts` is called with the combined texts: `['chunk one\n\nenrich0', 'chunk two\n\nenrich1', 'chunk three\n\nenrich2']`.

**New test cases to add**:

15. **All enrichments succeed — combined text passed to embedTexts**
    Assert `mockVoyageService.embedTexts` called with `['chunk one\n\nenrich0', 'chunk two\n\nenrich1', 'chunk three\n\nenrich2']`.

16. **All enrichments succeed — enrichment field present in every Qdrant point payload**
    Assert each point's `payload.enrichment` equals the corresponding enrichment string.
    Assert `payload.chunk_text` is unchanged (still the original chunk text, not the combined text).

17. **Single-chunk enrichment failure — that chunk embedded with chunk_text only**
    Setup: `enrichAllChunks` returns `['enrich0', null, 'enrich2']`.
    Assert `embedTexts` called with `['chunk one\n\nenrich0', 'chunk two', 'chunk three\n\nenrich2']`.
    Assert point 1's payload does NOT have an `enrichment` field.
    Assert points 0 and 2 DO have `enrichment` fields.

18. **Single-chunk enrichment failure — rest of ingestion completes (status: ready)**
    Setup: same as above.
    Assert: `ingestDocument` resolves with `status: 'ready'`.

19. **All-chunks enrichment failure — ingestion completes, all chunks embedded with chunk_text only**
    Setup: `enrichAllChunks` returns `[null, null, null]`.
    Assert: `embedTexts` called with `['chunk one', 'chunk two', 'chunk three']`.
    Assert: no Qdrant point has an `enrichment` field.
    Assert: `ingestDocument` resolves with `status: 'ready'` (does not throw).

20. **All-chunks enrichment failure — warns loudly**
    Setup: same as above.
    Assert: a `logger.warn` call was made containing `failedCount` equal to chunk count.

21. **enrichment field absent (not empty string) for failed chunk**
    Setup: `enrichAllChunks` returns `[null, 'enrich1', 'enrich2']`.
    Assert: `upsertArgs.points[0].payload` does not have property `enrichment` (use `expect(p0.payload).not.toHaveProperty('enrichment')`).

22. **chunk_text field is unchanged regardless of enrichment outcome**
    Assert for all points: `payload.chunk_text === chunk.text` (not the combined text).

---

## Data-Flows Doc Updates

**Target file:** `docs/knowledge-base/data-flows.md`

**Change 1 — Update the "Current state" header line**:

Current:
```
**Current state**: Phases 1–5 + Phase 6 (benchmark) + Phase 7a (update + delete + naming alignment).
```

Replace with:
```
**Current state**: Phases 1–5 + Phase 6 (benchmark) + Phase 7a (update + delete + naming alignment) + Phase 7b (Claude enrichment at ingestion).
```

**Change 2 — Flow 1 diagram**: insert step 6 (Claude enrichment) between the existing step 5 (Chunker) and step 6 (Voyage embed), renumbering the remaining steps:

Replace the current steps 5–11 block with:

```
│  5. Chunker (pure local) — text → array of chunks               │
│        ↓                                                        │
│  6. Claude enrichment (one call per chunk, 5-way cap)           │
│       Per-chunk: SUMMARY + QUESTIONS + KEY TERMS ───────► Anthropic API
│       ←──── enrichment text (or null on failure)                │
│       Combined text = chunk_text + "\n\n" + enrichment          │
│       On failure: embed chunk_text only (graceful degradation)  │
│        ↓                                                        │
│  7. Voyage.embedTexts(combined texts) ────────► Voyage API      │
│        ←──── vectors[] (1024 dims each)                         │
│        ↓                                                        │
│  8. Ensure Qdrant collection exists ──────────► Qdrant          │
│        ↓                                                        │
│  9. Ensure account_id payload index ──────────► Qdrant          │
│        ↓                                                        │
│ 10. Upsert points (one per chunk)  ────────────► Qdrant         │
│       payload includes chunk_text + enrichment (if present)     │
│        ↓                                                        │
│ 11. PutItem (DDB record) ──────────────────────► DynamoDB       │
│        ↓                                                        │
│ 12. Return { document_id, chunk_count, status,                  │
│              _createdAt_, _lastUpdated_ }                       │
```

**Change 3 — Flow 1 cost section**: replace the existing cost note with:

```
**Cost (per ingestion, one-time):**
- Claude enrichment: ~$0.005 per chunk (~700 input + ~200 output tokens at Sonnet pricing)
  - 15-chunk document: ~$0.07
  - 25-chunk document: ~$0.13
  - 150-chunk document: ~$0.75
- Voyage embeddings: ~$0.04 per 300-page document (input text is now slightly longer but cost change is negligible)
- Qdrant + DynamoDB writes: negligible
```

**Change 4 — Flow 3 diagram**: same renumbering of steps 4–10, inserting Claude enrichment between "Chunker → new chunks" and "Voyage.embedTexts → new vectors":

Replace steps 4–10 with:

```
│  4. Chunker → new chunks                                        │
│        ↓                                                        │
│  5. Claude enrichment (one call per chunk, 5-way cap) ──► Anthropic API
│       Combined text = chunk_text + "\n\n" + enrichment          │
│       On failure: embed chunk_text only                         │
│        ↓                                                        │
│  6. Voyage.embedTexts → new vectors  ─────────► Voyage API     │
│        ↓                                                        │
│  7. Ensure collection + index (idempotent, no-op)               │
│        ↓                                                        │
│  8. Qdrant DELETE points where                                  │
│       account_id = X AND document_id = Y                        │
│       wait: true  ← critical for ordering                       │
│        ↓                                                        │
│  9. Qdrant UPSERT new points                                    │
│        ↓                                                        │
│ 10. DDB PutItem (replaces existing record at same PK+SK)        │
│        ↓                                                        │
│ 11. Return { document_id, chunk_count, status,                  │
│              _createdAt_ (preserved),                           │
│              _lastUpdated_ (now) }                              │
```

---

## Out-of-Scope Confirmations

The following are explicitly not implemented in Phase 7b:

- Async ingestion queue (Redis + Bull) — Phase 7c
- Reranker on retrieval — future Approach 3
- Per-document or per-account enrichment opt-out flag
- Multi-vector per chunk (separate vectors for summary, questions, terms)
- Storing enrichment in DynamoDB (Qdrant payload only)
- Migration of already-ingested chunks (re-ingestion via Phase 7a update path)
- Showing enrichment to Claude at retrieval time (retrieval tool returns `chunk_text` unchanged)
- Switching to Haiku (documented as a future cost lever in the `ENRICHMENT_PROMPT` constant comment, not implemented)
- Retry logic for rate-limited chunks

---

## Implementation Recommendations

**For the code-implementer**:

- Mirror `voyage.service.ts` exactly in structural terms: constructor, logger, named constants declared before the class, error handling inside try/catch that returns `null` rather than throwing.
- The `runWithConcurrency` helper should be a module-scope function (not exported, not a class method). This makes it independently unit-testable by importing the module in tests.
- The `satisfies KnowledgeBasePointPayload` on the point payload in `writeQdrantPoints` will catch any field naming mistakes at compile time — keep it.
- The conditional spread `...(enrichments[index] !== null ? { enrichment: enrichments[index] } : {})` is the idiomatic way to produce an optionally absent field. Do not use `enrichment: enrichments[index] ?? undefined` — TypeScript's `satisfies` will flag that as assigning `string | null` to `string | undefined`.
- Add `KnowledgeBaseEnrichmentService` to `app.module.ts` providers in alphabetical position relative to the existing Knowledge Base services.
- The spec file for ingestion will need `randomUUID` reset after each test to remain stable — the existing pattern in `beforeEach` already handles this; just ensure the mock count is correct after adding enrichment-related calls (enrichment does not call `randomUUID`, so the existing mock counts are unaffected).
- Do not add `Co-Authored-By:` to the commit.
