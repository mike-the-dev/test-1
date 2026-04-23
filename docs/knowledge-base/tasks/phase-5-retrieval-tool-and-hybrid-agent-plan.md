# Phase 5 — Retrieval Tool + Hybrid LeadCapture Agent: Implementation Plan

---

## Overview

Phase 5 wires the Knowledge Base (built in Phases 1–4) into the agent layer. It introduces a new `lookup_knowledge_base` chat tool that embeds a natural-language query using `VoyageService.embedText()`, executes a vector similarity search in Qdrant scoped to the calling account, and returns the top-K matching text chunks. It then expands the existing `LeadCaptureAgent` into a hybrid assistant that answers visitor questions from KB content (policies, manuals, procedures) and the services catalog, while retaining the original contact-capture and email-confirmation flow. When complete, a client can conduct a grounded, document-backed conversation with the agent without any code changes to the ingestion pipeline or any other agent.

---

## Affected Files and Modules

### Create

| File | Purpose |
|------|---------|
| `src/tools/lookup-knowledge-base.tool.ts` | New `LookupKnowledgeBaseTool` class — the full retrieval tool. |
| `src/tools/lookup-knowledge-base.tool.spec.ts` | Unit test spec for the tool (mocks `VoyageService` and `QdrantClient`). |

### Modify

| File | Change |
|------|--------|
| `src/validation/tool.schema.ts` | Add `lookupKnowledgeBaseInputSchema` (zod) and its inferred type. |
| `src/types/KnowledgeBase.ts` | Add `KnowledgeBaseRetrievalChunk` interface and `KnowledgeBaseRetrievalResult` wrapper interface. |
| `src/agents/lead-capture.agent.ts` | Replace `systemPrompt` with hybrid version; update `allowedToolNames` to four-tool list. |
| `src/app.module.ts` | Import and register `LookupKnowledgeBaseTool` in the `providers` array. |

### Review Only (no changes)

| File | Why reviewed |
|------|-------------|
| `src/services/knowledge-base-ingestion.service.ts` | Confirms `KB_COLLECTION_NAME = "knowledge_base"`, account-filter shape, and payload field names written at ingest time. |
| `src/types/KnowledgeBase.ts` (existing portion) | `KnowledgeBasePointPayload` is the mapping input — existing fields must be read back correctly. |
| `src/services/voyage.service.ts` | Confirms `embedText(query: string): Promise<number[]>` signature and error-propagation contract. |
| `src/providers/qdrant.provider.ts` | Confirms `QDRANT_CLIENT` injection token. |
| `src/tools/chat-tool.decorator.ts` | Confirms `@ChatToolProvider()` decorator usage. |
| `src/types/Tool.ts` | Confirms `ChatTool` interface shape, `ChatToolExecutionContext`, and `ChatToolExecutionResult`. |

---

## Qdrant Search Verification Findings

### Source URLs

- GitHub JS client source (runtime default values): `https://github.com/qdrant/qdrant-js/blob/master/packages/js-client-rest/src/qdrant-client.ts`
- Qdrant filtering documentation: `https://qdrant.tech/documentation/concepts/filtering/`
- Installed package type declarations: `node_modules/@qdrant/js-client-rest/dist/types/qdrant-client.d.ts` and `node_modules/@qdrant/js-client-rest/dist/types/openapi/generated_schema.d.ts`

### Confirmed Search Signature

```typescript
client.search(
  collection_name: string,
  {
    vector: number[] | ...,       // required
    filter?: Filter,              // optional; used for per-account scoping
    limit?: number,               // optional; client wrapper defaults to 10
    offset?: number,              // optional; defaults to 0
    with_payload?: boolean | ..., // optional; see below
    with_vector?: boolean | ...,  // optional; defaults to false
    score_threshold?: number,     // optional; not used in Phase 5
    // ...additional fields omitted
  }
): Promise<Schemas['ScoredPoint'][]>
```

### `with_payload` Default — Important Discrepancy

The underlying REST API schema (`SearchRequest.with_payload`) documents the default as **`false`**. However, the `QdrantClient` JavaScript wrapper method explicitly destructures `with_payload = true` as its parameter default (confirmed in `node_modules/@qdrant/js-client-rest/dist/cjs/qdrant-client.js` line 169). **At the JS client level, payload is returned by default.**

Recommendation: Pass `with_payload: true` explicitly in the tool's Qdrant call anyway. This documents intent clearly and eliminates any ambiguity around SDK version drift or future wrapper changes.

### Filter Shape for Keyword-Indexed Field

```typescript
filter: {
  must: [
    {
      key: "account_ulid",
      match: { value: accountUlid }
    }
  ]
}
```

This is confirmed by both the Qdrant filtering documentation and the existing Phase 4 ingestion service's `ensurePayloadIndex` call which creates a `keyword` index on `account_ulid`. The filter type is `MatchValue` — a simple exact-string equality check.

### ScoredPoint Return Shape

From `generated_schema.d.ts`:

```typescript
interface ScoredPoint {
  id: ExtendedPointId;              // string | number (UUID in our case)
  version: number;
  score: number;                    // float — the similarity score
  payload?: Record<string, unknown> | null;  // the Qdrant payload object
  vector?: ...;                     // not requested; omit
  shard_key?: ...;                  // ignore
  order_value?: ...;                // ignore
}
```

**Key fields for the tool:**
- `score` — the cosine similarity score (float)
- `payload` — the `KnowledgeBasePointPayload`-shaped object written at ingest time

### Delta from Brief's Assumptions

No significant deltas. The brief's assumed filter shape `{ must: [{ key: "account_ulid", match: { value: accountUlid } }] }` is exactly correct. The `with_payload: true` the brief specifies as an explicit argument is good practice even though it is already the default.

---

## Tool Public Surface

### Zod Schema (`src/validation/tool.schema.ts`)

```typescript
export const lookupKnowledgeBaseInputSchema = z
  .object({
    query: z.string().min(1),
    top_k: z.number().int().min(1).max(20).optional(),
  })
  .strict();

export type LookupKnowledgeBaseInput = z.infer<typeof lookupKnowledgeBaseInputSchema>;
```

### JSON Schema (`inputSchema` property on the tool class)

```typescript
readonly inputSchema: ChatToolInputSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "The search query — pass the visitor's question or a rephrased version of it.",
    },
    top_k: {
      type: "integer",
      minimum: 1,
      maximum: 20,
      description: "Number of passages to return. Defaults to 5. Increase if the first results seem insufficient.",
    },
  },
  required: ["query"],
  additionalProperties: false,
};
```

### Tool Description String

```
"Return passages from the business's knowledge base (policies, manuals, procedures, guidelines, narrative documents) that semantically match a query. Use this tool for any factual question about how the business operates or what its policies are. Pass a version of the visitor's question as the query. Do NOT use this for pricing or service availability — use list_services for that. Returns the top-K matching passages with their source document title and a similarity score."
```

(Taken verbatim from the brief's Step 2 description example.)

### `execute` Method Signature

```typescript
async execute(input: unknown, context: ChatToolExecutionContext): Promise<ChatToolExecutionResult>
```

This matches the `ChatTool` interface in `src/types/Tool.ts` exactly.

---

## Tool Control Flow

The following numbered steps describe exactly what the `execute` method does, in order:

1. **Parse input with zod.** Call `lookupKnowledgeBaseInputSchema.safeParse(input)`. If `!parseResult.success`, return `{ result: \`Invalid input: ${parseResult.error.message}\`, isError: true }`. This runs first, before any context checks.

2. **Check account context.** If `!context.accountUlid`, return `{ result: "Missing account context — cannot look up knowledge base.", isError: true }`. Log: `this.logger.warn(\`lookup_knowledge_base missing account context [sessionUlid=${context.sessionUlid}]\`)`.

3. **Resolve `top_k`.** `const topK = parseResult.data.top_k ?? DEFAULT_TOP_K;` (where `DEFAULT_TOP_K = 5`).

4. **Embed the query.** Call `await this.voyageService.embedText(parseResult.data.query)`. This is inside a `try/catch`. On any thrown error, log `[errorType=<errorName>]` (the Error's `.name` property only — no message content, no stack), then return `{ result: "Knowledge base is temporarily unavailable. Please ask the visitor to try again in a moment.", isError: true }`.

5. **Search Qdrant.** Also inside the same `try/catch`, call:
   ```typescript
   await this.qdrantClient.search(KB_COLLECTION_NAME, {
     vector,
     filter: {
       must: [{ key: "account_ulid", match: { value: context.accountUlid } }],
     },
     limit: topK,
     with_payload: true,
   })
   ```
   On any thrown error, log `[errorType=<errorName>]` and return the same unavailability message with `isError: true`.

   Note: Both the Voyage call and the Qdrant call are wrapped in a single `try/catch`. The error handling response is the same for both.

6. **Map results.** Transform `ScoredPoint[]` to `KnowledgeBaseRetrievalChunk[]`. For each point:
   - `text` ← `point.payload.chunk_text`
   - `score` ← `point.score`
   - `document_title` ← `point.payload.document_title`
   - `document_ulid` ← `point.payload.document_ulid`
   - `chunk_index` ← `point.payload.chunk_index`

   Treat `payload` as `KnowledgeBasePointPayload` (cast). If a point has a null/missing payload, skip it (defensive guard — should not occur in practice since Qdrant was written with `satisfies KnowledgeBasePointPayload`).

7. **Log success.** `this.logger.debug(\`lookup_knowledge_base executed [sessionUlid=${context.sessionUlid} accountUlid=${context.accountUlid} query="..." topK=${topK} resultCount=${chunks.length}]\`)`. Do NOT include raw query text in the log — use query length or a truncated preview at most.

8. **Return.** `return { result: JSON.stringify({ chunks, count: chunks.length }) }`. No `isError` field when successful, including when `chunks` is empty.

---

## Type Additions

Add the following to `src/types/KnowledgeBase.ts` after the existing `KnowledgeBasePointPayload` interface. Add a section comment to keep the file organized.

```typescript
// ---------------------------------------------------------------------------
// Retrieval tool types (Phase 5)
// ---------------------------------------------------------------------------

/**
 * A single matched chunk returned by the lookup_knowledge_base tool.
 * This is the agent-facing DTO — it maps from KnowledgeBasePointPayload,
 * renaming chunk_text → text for cleaner agent consumption.
 */
export interface KnowledgeBaseRetrievalChunk {
  /** The text content of the matched chunk. */
  text: string;
  /** Cosine similarity score from Qdrant. Higher is more similar. */
  score: number;
  /** Title of the source document this chunk was extracted from. */
  document_title: string;
  /** ULID of the source document. */
  document_ulid: string;
  /** Zero-based position of this chunk within its source document. */
  chunk_index: number;
}

/** The JSON structure returned by the lookup_knowledge_base tool. */
export interface KnowledgeBaseRetrievalResult {
  chunks: KnowledgeBaseRetrievalChunk[];
  count: number;
}
```

`KnowledgeBasePointPayload` (already defined) is the INPUT to the mapping step. Do not redefine or duplicate it.

---

## Error Handling Strategy

All errors follow the established pattern from `list-services.tool.ts` and the Phase 4 ingestion service: log `errorType` only (the `Error.name` property), never raw error messages, never API keys, never stack traces.

| Error Scenario | Log Line | Return Value |
|----------------|----------|-------------|
| Zod parse failure | None (no log; it is caller input error) | `{ result: "Invalid input: <zod message>", isError: true }` |
| Missing `accountUlid` in context | `this.logger.warn(...)` with `[sessionUlid=...]` | `{ result: "Missing account context — cannot look up knowledge base.", isError: true }` |
| `VoyageService.embedText()` throws | `this.logger.error(\`lookup_knowledge_base Voyage error [errorType=${errorName}]\`)` | `{ result: "Knowledge base is temporarily unavailable. Please ask the visitor to try again in a moment.", isError: true }` |
| `qdrantClient.search()` throws | `this.logger.error(\`lookup_knowledge_base Qdrant error [errorType=${errorName}]\`)` | `{ result: "Knowledge base is temporarily unavailable. Please ask the visitor to try again in a moment.", isError: true }` |
| Zero results from Qdrant | No error logged — this is a valid success | `{ result: JSON.stringify({ chunks: [], count: 0 }) }` — `isError` NOT set |
| Point with null payload | Skip silently; log a single `warn` if any were skipped | Remaining chunks returned normally |

Note: The Phase 4 `VoyageService` already sanitizes its error messages before rethrowing. The tool must NOT assume the caught error is from Voyage directly — the try/catch may also catch Qdrant errors. Keep both wraps in the same block for simplicity, but log the correct context.

---

## Hybrid Prompt

The implementer must paste the hybrid `systemPrompt` string from the task brief (the fenced block under "Hybrid prompt contract" in STEP 2) **verbatim** into `src/agents/lead-capture.agent.ts`, replacing the entire existing `systemPrompt` value.

The implementer must NOT:
- Redesign, shorten, reword, or restructure the prompt.
- Apply any style-enforcer rules to the prompt string content itself.
- Remove or reorganize any section heading (CAPABILITIES, GUIDING PRINCIPLE, ROLE, TOOLS AVAILABLE TO YOU, GROUNDING DISCIPLINE, KNOWLEDGE-ANSWERING WORKFLOW, CONTACT-CAPTURE WORKFLOW, TONE, EMAIL TEMPLATE, BOUNDARIES / JAILBREAK RESISTANCE).

The style-refactor pass (Step 3) must also leave the prompt string untouched except for trivial Prettier-safe whitespace normalization inside template literals, if any.

The `allowedToolNames` array must be updated to exactly:

```typescript
readonly allowedToolNames: readonly string[] = [
  "collect_contact_info",
  "send_email",
  "list_services",
  "lookup_knowledge_base",
];
```

The `name`, `displayName`, `description`, and class decorator on `LeadCaptureAgent` are not changed.

---

## Step-by-Step Implementation Order

The implementer must follow this sequence. Steps 1 and 2 are prerequisite to all others. Steps 3–5 are independent and can be done in any order after step 2. Step 6 ties everything together.

### Step 1 — Add type definitions to `src/types/KnowledgeBase.ts`

- Append the `KnowledgeBaseRetrievalChunk` and `KnowledgeBaseRetrievalResult` interfaces after the existing `KnowledgeBasePointPayload` definition, under a new `// Retrieval tool types (Phase 5)` section comment.
- Do not modify any existing interface.
- Acceptance: TypeScript compiles `src/types/KnowledgeBase.ts` without error.

### Step 2 — Add zod schema to `src/validation/tool.schema.ts`

- Append `lookupKnowledgeBaseInputSchema` and its inferred `LookupKnowledgeBaseInput` type at the bottom of the file, following the pattern of the existing schemas.
- Schema: `z.object({ query: z.string().min(1), top_k: z.number().int().min(1).max(20).optional() }).strict()`
- Acceptance: TypeScript compiles without error; schema correctly accepts `{ query: "test" }` and `{ query: "test", top_k: 10 }`, and rejects `{}`, `{ query: "" }`, `{ query: "test", top_k: 0 }`, `{ query: "test", top_k: 21 }`, and `{ query: "test", unknown_key: "x" }`.

### Step 3 — Create `src/tools/lookup-knowledge-base.tool.ts`

- Mirror `list-services.tool.ts` structure exactly:
  - Same import ordering pattern (NestJS core → AWS SDK absent here → internal providers → types → validation → decorator).
  - Constants block at top: `KB_COLLECTION_NAME = "knowledge_base"`, `DEFAULT_TOP_K = 5`, `MAX_TOP_K = 20`.
  - `@ChatToolProvider()` then `@Injectable()` decorators (same order as `ListServicesTool`).
  - `implements ChatTool` on the class.
  - `private readonly logger = new Logger(LookupKnowledgeBaseTool.name)` as the first class member.
  - `readonly name`, `readonly description`, `readonly inputSchema` as class properties.
  - Constructor with `@Inject(QDRANT_CLIENT)` for the Qdrant client and `VoyageService` injected without `@Inject` (it is a regular NestJS provider).
  - `execute` method implementing the control flow in the order specified above.
- The tool does NOT inject `DatabaseConfigService` or `DynamoDBDocumentClient` — it only needs `QdrantClient` and `VoyageService`.
- Acceptance: File compiles. The tool correctly implements all members of the `ChatTool` interface.

### Step 4 — Update `src/agents/lead-capture.agent.ts`

- Replace the entire `readonly systemPrompt = \`...\`` value with the hybrid prompt from the task brief STEP 2 section "Hybrid prompt contract", verbatim.
- Update `readonly allowedToolNames` to the four-tool array.
- Do not change `name`, `displayName`, `description`, the class decorator, or the import block.
- Acceptance: File compiles. The `systemPrompt` contains the text "GROUNDING DISCIPLINE (CRITICAL)" and "KNOWLEDGE-ANSWERING WORKFLOW" (section markers that prove the full hybrid prompt was pasted). The `allowedToolNames` array has exactly four entries including `"lookup_knowledge_base"`.

### Step 5 — Register the tool in `src/app.module.ts`

- Add `import { LookupKnowledgeBaseTool } from "./tools/lookup-knowledge-base.tool";` to the imports block, grouped with the other tool imports alphabetically or by convention.
- Add `LookupKnowledgeBaseTool` to the `providers` array, grouped with the other tool classes (alongside `ListServicesTool`, `CollectContactInfoTool`, etc.).
- Acceptance: `npm run build` compiles cleanly.

### Step 6 — Create `src/tools/lookup-knowledge-base.tool.spec.ts`

- Write the unit tests (see Testing Strategy section below).
- The spec lives next to the tool source file, following the convention of other specs in `src/tools/`.
- Acceptance: `npm test` passes all tests in this file (8–10 tests). Full test suite passes.

---

## Risks and Edge Cases

### High

**Per-account filter missing.** If `context.accountUlid` is somehow empty-string (not `undefined`/`null` but `""`) and the guard only checks truthiness, the filter would carry an empty string as the account value. This would still be an account-scoped filter (matching no documents), but it is wrong behavior. The check `if (!context.accountUlid)` catches both falsy cases (`undefined`, `null`, `""`, `0`) which is correct — just confirm the guard uses `!context.accountUlid` not `context.accountUlid === undefined`.

**Cross-account data leak.** The most critical invariant: if the filter is accidentally omitted from the Qdrant search call, points from all accounts would be returned. The guard must prevent execution reaching the Qdrant call without `accountUlid`, and the Qdrant call must always include the filter. Code review (Step 5 in the overall task) should verify this as its top priority.

### Medium

**`KB_COLLECTION_NAME` constant duplication.** The ingestion service defines `const KB_COLLECTION_NAME = "knowledge_base"` as a module-local constant (not exported). The new tool must define its own copy. These two must match. The brief permits this and asks the implementer to flag it to the Step 5 reviewer. If they diverge, retrieval will silently search a non-existent collection. Mitigation: a shared `src/utils/knowledge-base/constants.ts` would be the clean solution, but that is out of scope for Phase 5 — the reviewer should add a comment in both files cross-referencing the other.

**`top_k` edge values.** `z.number().int().min(1).max(20)` must be enforced at the zod layer. The `DEFAULT_TOP_K = 5` and `MAX_TOP_K = 20` constants at the top of the tool file help a style reviewer verify at a glance that the magic numbers in the schema match the constants.

**Payload field nullability.** The Qdrant `ScoredPoint.payload` field is typed as `Record<string, unknown> | null | undefined`. The mapping step must handle this defensively. A point with a null payload should be skipped with a warning log rather than throwing a runtime error.

**Voyage vector length.** `VoyageService.embedText()` throws if the response is malformed (missing embedding field) — this is already handled inside `VoyageService`. The catch block in the tool will capture this and return the unavailability message. No additional guard is needed, but the test suite should include a "Voyage throws" case to verify the catch path.

### Low

**SDK version drift.** The `with_payload = true` default is confirmed in the installed version. If the SDK is upgraded, this default could change. Passing `with_payload: true` explicitly in the call eliminates this risk entirely.

**Zero-result semantics.** Qdrant returns an empty array `[]` when no points match — it does not throw. The tool returns `{ chunks: [], count: 0 }` as a success result. Claude's prompt instructs it to handle this gracefully ("say so honestly").

**Log verbosity on query content.** The bracketed log on success should not include the raw query text, which could contain PII. Log `queryLength` or omit the query entirely from the log line.

---

## Testing Strategy

### Spec file path

`src/tools/lookup-knowledge-base.tool.spec.ts`

### Mock setup pattern

- Mock `VoyageService` with a jest mock: `voyageService.embedText.mockResolvedValue([...vector...])`.
- Mock `QdrantClient` with a jest mock: `qdrantClient.search.mockResolvedValue([...scoredPoints...])`.
- Inject mocks via NestJS testing module or direct construction, mirroring other tool spec patterns in the project.

### Required test cases

1. **Happy path — default `top_k`.** Input `{ query: "what is the cancellation policy" }`. Assert: `embedText` called with that query. `search` called with `collection_name = "knowledge_base"`, `filter.must[0].match.value = context.accountUlid`, `limit = 5`. Return value is `{ result: JSON.stringify({ chunks: [...], count: N }) }`, no `isError`.

2. **Happy path — explicit `top_k`.** Input `{ query: "refund policy", top_k: 10 }`. Assert: `search` called with `limit = 10`.

3. **`top_k` passed through correctly.** Input `{ query: "emergency protocol", top_k: 1 }`. Assert: `search` called with `limit = 1`. Returns exactly 1 chunk.

4. **Result mapping.** `search` mock returns a single `ScoredPoint` with known payload fields. Assert: the returned `chunks[0]` has `text = payload.chunk_text`, `score = point.score`, `document_title = payload.document_title`, `document_ulid = payload.document_ulid`, `chunk_index = payload.chunk_index`.

5. **Zero results from Qdrant.** `search` mock returns `[]`. Assert: return value is `{ result: JSON.stringify({ chunks: [], count: 0 }) }`, no `isError` property.

6. **Missing `accountUlid`.** Context has `accountUlid: undefined`. Assert: return is `{ result: "Missing account context — cannot look up knowledge base.", isError: true }`. Neither `embedText` nor `search` is called.

7. **Invalid input — empty query.** Input `{ query: "" }`. Assert: return is `{ ..., isError: true }` with "Invalid input" in the result string. Neither `embedText` nor `search` is called.

8. **Invalid input — `top_k` out of range.** Input `{ query: "test", top_k: 0 }` and separately `{ query: "test", top_k: 21 }`. Assert: `isError: true`, validation error message. Neither service called.

9. **Invalid input — unknown key.** Input `{ query: "test", extra_field: "x" }`. Assert: `isError: true` (zod `.strict()` rejects unknown keys).

10. **Voyage throws.** `embedText` mock throws `new Error("Voyage API rate limit exceeded")`. Assert: return is `{ result: "Knowledge base is temporarily unavailable. Please ask the visitor to try again in a moment.", isError: true }`. `search` is NOT called (Voyage fails before Qdrant).

11. **Qdrant throws.** `embedText` mock resolves normally. `search` mock throws `new Error("connection refused")`. Assert: return is `{ result: "Knowledge base is temporarily unavailable. Please ask the visitor to try again in a moment.", isError: true }`.

---

## Out-of-Scope Confirmations

The following will NOT be implemented in Phase 5:

- No reranker on retrieval results.
- No score threshold / minimum-relevance filter (Phase 8 concern).
- No `document_ulid` filter argument on the tool (future).
- No retry logic for Voyage or Qdrant failures.
- No changes to `ShoppingAssistantAgent` or any other agent.
- No agent analytics or telemetry.
- No Claude enrichment at ingestion (Phase 7).
- No multi-turn query refinement.
- No export of `KB_COLLECTION_NAME` into a shared constants module (punted; flag to reviewer).

---

## Implementation Recommendations

**DI ordering in constructor.** The existing tool pattern puts `@Inject(TOKEN)` parameters first, then regular provider injections. The `LookupKnowledgeBaseTool` constructor should be:
```typescript
constructor(
  @Inject(QDRANT_CLIENT) private readonly qdrantClient: QdrantClient,
  private readonly voyageService: VoyageService,
) {}
```

**Payload cast.** The `ScoredPoint.payload` field is `Record<string, unknown> | null | undefined`. Cast it as `KnowledgeBasePointPayload` only after a truthy check:
```typescript
if (!point.payload) continue; // skip defensive case
const payload = point.payload as KnowledgeBasePointPayload;
```

**Single try/catch block.** Place both the `embedText` call and the `search` call inside one try/catch. The control flow (Voyage runs first, Qdrant runs second) means if Voyage throws, Qdrant never runs. The error response is identical for both failure types. This mirrors the `.catch()` chain used in `list-services.tool.ts` but expressed as a try/catch block since the operations are sequential.

**`inputSchema` properties.** The `ChatToolInputSchema.properties` field is typed as `unknown`. Define the object literal inline on the `inputSchema` class property as shown in the "Tool Public Surface" section. This is consistent with how the existing tools define `inputSchema` while giving Claude correct schema information.

**Constant naming.** `KB_COLLECTION_NAME`, `DEFAULT_TOP_K`, `MAX_TOP_K` — define these at module scope (above the class declaration), matching the `MAX_SERVICES` and `MAX_DESCRIPTION_LENGTH` pattern in `list-services.tool.ts`.

**App module insertion point.** In `src/app.module.ts`, insert `LookupKnowledgeBaseTool` in the `providers` array immediately after `ListServicesTool` to keep tool registrations grouped and approximately alphabetical.
