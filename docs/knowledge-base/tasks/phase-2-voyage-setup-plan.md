# Phase 2 — Voyage AI Embedding Service: Implementation Plan

## Overview

This phase adds a typed NestJS embedding service that wraps the Voyage AI API. The deliverable is two new files — `VoyageConfigService` and `VoyageService` — that mirror the established `AnthropicConfigService` / `AnthropicService` pattern exactly. The service exposes two public methods: `embedText` for single-string embedding and `embedTexts` for batch embedding with transparent auto-splitting. Supporting changes land in `configuration.ts`, `env.schema.ts`, `app.module.ts`, and `.env.local`. No callers are wired in this phase; the service stands alone. When complete, `npm run build` passes clean, all unit tests pass, and the service is ready for Phase 4 (ingestion) and Phase 5 (retrieval) to consume.

---

## SDK / API Verification Findings

**Sources consulted:**
- https://docs.voyageai.com/docs/embeddings
- https://docs.voyageai.com/reference/embeddings-api
- https://github.com/voyage-ai/typescript-sdk
- https://raw.githubusercontent.com/voyage-ai/typescript-sdk/main/src/api/types/EmbedResponse.ts
- https://raw.githubusercontent.com/voyage-ai/typescript-sdk/main/src/api/types/EmbedResponseDataItem.ts
- npm search (web search, npmjs.com 403 for direct access)

### Official JS/TS SDK: confirmed

An official TypeScript SDK exists and is maintained by Voyage AI.

| Property | Value |
|---|---|
| npm package | `voyageai` |
| Current stable version | `0.2.1` |
| GitHub | `https://github.com/voyage-ai/typescript-sdk` |
| Node requirement | >= 18.0.0 (project uses `@types/node@^22`, so no constraint) |
| Direct dependency | `node-fetch@^2.7.0` |
| Optional peer deps | `@huggingface/transformers@^3.8.0`, `onnxruntime-node@>=1.17.0` (not needed for text embedding) |

### Client constructor

```typescript
import { VoyageAIClient } from "voyageai";
const client = new VoyageAIClient({ apiKey: "..." });
```

### Embed method call shape

```typescript
await client.embed({
  input: string | string[],
  model: string,
  // optional:
  input_type?: "query" | "document" | null,
  output_dimension?: number,
  output_dtype?: "float" | "int8" | "uint8" | "binary" | "ubinary",
  truncation?: boolean,
  encoding_format?: null | "base64",
})
```

### Response type (from SDK source)

```typescript
interface EmbedResponse {
  object?: string;         // always "list"
  data?: EmbedResponseDataItem[];
  model?: string;
  usage?: EmbedResponseUsage;
}

interface EmbedResponseDataItem {
  object?: string;         // always "embedding"
  embedding?: number[];    // the vector
  index?: number;          // position in the input array
}
```

### Error type

The SDK throws `VoyageAIError` with `.statusCode`, `.message`, `.body`, and `.rawResponse` properties. The SDK has built-in retry logic for 408, 429, and 5xx — **this must be disabled** by passing `maxRetries: 0` when constructing the client so Phase 2 owns none of that behavior (retry is explicitly out of scope and will be added later).

### Deltas from task brief assumptions

| Assumption in brief | Live doc reality | Impact |
|---|---|---|
| Max batch size = 128 | **Max batch size = 1,000** (texts per request) | `VOYAGE_MAX_BATCH` constant should be `1000`, not `128`. Batch-splitting will only fire for inputs > 1,000, which is rare but must still be correct. |
| Output dimension for voyage-3-large = 1024 | **Confirmed: default 1,024** (also supports 256, 512, 2048 via `output_dimension` param) | No change needed; plan uses 1024 as the documented default. |
| input_type values: "document" / "query" | **Confirmed**: `"document"`, `"query"`, or `null` | No change to design. |

The 128 → 1000 delta is the only material correction. It doesn't change the implementation pattern, only the constant value.

---

## Affected Files and Modules

### Create

| File | Purpose |
|---|---|
| `src/services/voyage-config.service.ts` | Typed config service, mirrors `anthropic-config.service.ts`; exposes `apiKey` and `model` getters over `ConfigService` |
| `src/services/voyage.service.ts` | Core embedding service; wraps `VoyageAIClient`, implements `embedText` and `embedTexts` with batch splitting |
| `src/services/voyage-config.service.spec.ts` | Unit tests for `VoyageConfigService` |
| `src/services/voyage.service.spec.ts` | Unit tests for `VoyageService` |

### Modify

| File | Change |
|---|---|
| `src/config/configuration.ts` | Add `voyage` namespace with `apiKey` and `model` fields |
| `src/config/env.schema.ts` | Add `VOYAGE_API_KEY` (optional string, not required at boot — absent key is acceptable in local dev without the feature) and `VOYAGE_MODEL` (optional string) |
| `src/app.module.ts` | Import and register `VoyageConfigService` and `VoyageService` as providers |
| `.env.local` | Add placeholder lines `VOYAGE_API_KEY=` and `# VOYAGE_MODEL=voyage-3-large` |
| `package.json` + `package-lock.json` | Add `voyageai@0.2.1` as a production dependency |

### Review Only (no changes)

| File | Why read |
|---|---|
| `src/services/anthropic.service.ts` | Structural reference for `VoyageService` |
| `src/services/anthropic-config.service.ts` | Structural reference for `VoyageConfigService` |
| `src/services/anthropic.service.spec.ts` | Test pattern reference |

---

## Service Public API Design

### VoyageConfigService

```typescript
@Injectable()
export class VoyageConfigService {
  constructor(private readonly configService: ConfigService) {}

  get apiKey(): string | undefined {
    return this.configService.get<string>("voyage.apiKey", { infer: true });
  }

  get model(): string {
    return this.configService.getOrThrow<string>("voyage.model", { infer: true });
  }
}
```

Exact mirror of `AnthropicConfigService`. `apiKey` returns `string | undefined` (absent in local dev is acceptable). `model` uses `getOrThrow` because the config namespace provides a default, so it will never actually throw under normal operation.

### VoyageService

```typescript
@Injectable()
export class VoyageService {
  private readonly logger = new Logger(VoyageService.name);
  private readonly client: VoyageAIClient;

  constructor(private readonly voyageConfig: VoyageConfigService) {
    this.client = new VoyageAIClient({
      apiKey: this.voyageConfig.apiKey,
      maxRetries: 0,     // retry is out of scope; callers decide
    });
  }

  async embedText(text: string): Promise<number[]> {
    // delegates entirely to embedTexts to avoid a separate code path
    const results = await this.embedTexts([text]);
    return results[0];
  }

  async embedTexts(texts: readonly string[]): Promise<number[][]> {
    // batch-splitting, validation, logging, error handling live here
    // see batch-splitting algorithm section below
  }
}
```

Key design decisions:
- `embedText` delegates to `embedTexts([text])[0]` — one code path for the actual API call.
- `texts` parameter is `readonly string[]` to signal the method does not mutate the input.
- Return types are plain `number[][]` — no SDK types leak into the public API.
- `maxRetries: 0` on the SDK client disables built-in retry so this phase has no hidden retry behavior.

---

## Batch-Splitting Algorithm

**Named constant:** `VOYAGE_MAX_BATCH = 1000` (verified from live docs)

### Algorithm (prose)

```
embedTexts(texts):
  1. If texts.length === 0, return [] immediately. No API call.

  2. If texts.length <= VOYAGE_MAX_BATCH:
       make one API call with all texts
       extract embeddings from response.data[], sort by .index to guarantee order
       return the number[][] in input order

  3. If texts.length > VOYAGE_MAX_BATCH:
       split texts into chunks of size VOYAGE_MAX_BATCH
       for each chunk (sequentially, not parallel):
         make one API call
         extract + sort embeddings as in step 2
         append to accumulator array
       return concatenated accumulator
```

### Edge cases

| Input | Behavior |
|---|---|
| `[]` (empty) | Returns `[]` immediately, zero API calls |
| `texts.length === VOYAGE_MAX_BATCH` (exactly 1000) | Single API call, no splitting |
| `texts.length === VOYAGE_MAX_BATCH + 1` (1001) | Two API calls: first with 1000 items, second with 1 item; results concatenated in input order |
| Very large input (e.g. 5000 texts) | Five sequential calls of 1000 each; results concatenated in order |

### Order preservation

The SDK response includes `.index` on each `EmbedResponseDataItem`. After each API call, sort `response.data` by `.index` before extracting `.embedding`. This guarantees order even if the API returns items out of sequence.

### Chunking helper (pseudocode)

```
function chunk<T>(array: readonly T[], size: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size))
  }
  return result
}
```

This is a pure utility function. It should live inline in `voyage.service.ts` as a private module-level function (not exported), following the same convention as `trimPrice` in `list-services.tool.ts`.

---

## Step-by-Step Implementation Order

1. **Install the SDK**
   - What: Run `npm install voyageai@0.2.1` in the project root
   - Where: `package.json` + `package-lock.json`
   - Why first: All subsequent files import from `voyageai`; TypeScript types are needed before writing the service
   - Done when: `package.json` shows `"voyageai": "0.2.1"` under `dependencies`; `node_modules/voyageai` exists; `npm run build` does not fail on a missing module

2. **Extend `src/config/env.schema.ts`**
   - What: Add `VOYAGE_API_KEY: z.string().optional()` and `VOYAGE_MODEL: z.string().optional()` to the Zod schema object
   - Where: `src/config/env.schema.ts`, inside the `.object({...})` call, after the existing `ANTHROPIC_MODEL` line
   - Why here: Config validation runs at boot before any service initializes; schema must be in place before `configuration.ts` reads the vars
   - Done when: The schema compiles and TypeScript's inferred `Env` type includes `VOYAGE_API_KEY` and `VOYAGE_MODEL` as optional strings

3. **Extend `src/config/configuration.ts`**
   - What: Add a `voyage` namespace to the configuration factory object
     ```
     voyage: {
       apiKey: process.env.VOYAGE_API_KEY,
       model: process.env.VOYAGE_MODEL || "voyage-3-large",
     }
     ```
   - Where: `src/config/configuration.ts`, after the `anthropic` block
   - Why here: `VoyageConfigService` reads `voyage.apiKey` and `voyage.model` via `ConfigService`; the namespace must exist before the service is written
   - Done when: The config file compiles; `voyage.model` defaults to `"voyage-3-large"` when `VOYAGE_MODEL` is unset

4. **Create `src/services/voyage-config.service.ts`**
   - What: Create the config service, mirroring `anthropic-config.service.ts` exactly in structure
   - Where: New file at `src/services/voyage-config.service.ts`
   - Why here: `VoyageService` depends on `VoyageConfigService`; config service must exist before the main service
   - Done when: File compiles; `apiKey` getter returns `string | undefined`; `model` getter uses `getOrThrow`

5. **Create `src/services/voyage.service.ts`**
   - What: Create the embedding service with `embedText`, `embedTexts`, the `chunkArray` helper, and the `VOYAGE_MAX_BATCH` constant
   - Where: New file at `src/services/voyage.service.ts`
   - Why here: Depends on `VoyageConfigService` (step 4) and the `voyageai` package (step 1)
   - Done when: File compiles; `embedText` calls `embedTexts([text])` and returns `[0]`; `embedTexts` handles empty, single-batch, and multi-batch paths; error handling wraps the SDK call in a try/catch

6. **Register both services in `src/app.module.ts`**
   - What: Add `VoyageConfigService` and `VoyageService` to the `providers` array; add corresponding import statements
   - Where: `src/app.module.ts`
   - Why here: Services are not available for DI injection until registered; done after the services exist so the import paths resolve
   - Done when: `npm run build` succeeds; no "unknown provider" errors at startup

7. **Update `.env.local`**
   - What: Append placeholder lines: `VOYAGE_API_KEY=` and `# VOYAGE_MODEL=voyage-3-large`
   - Where: `.env.local`
   - Why here: Developers cloning the repo need to know which vars to populate; done late since it is not a code dependency
   - Done when: File has both lines; no real key is committed

8. **Write `src/services/voyage-config.service.spec.ts`**
   - What: Unit tests for `VoyageConfigService`
   - Where: `src/services/voyage-config.service.spec.ts`
   - Why here: Tests written after the service exists so they can be verified to pass
   - Done when: Three test cases pass (see Testing Strategy)

9. **Write `src/services/voyage.service.spec.ts`**
   - What: Unit tests for `VoyageService` with the SDK mocked
   - Where: `src/services/voyage.service.spec.ts`
   - Why here: Written last; depends on all previous steps being complete so the mock shape is known
   - Done when: All five test cases pass (see Testing Strategy); zero live API calls

---

## Dependencies and Architectural Considerations

### DI wiring

`VoyageConfigService` depends on `ConfigService` (global, provided by `ConfigModule.forRoot`). `VoyageService` depends on `VoyageConfigService`. Both are registered in `AppModule.providers` exactly like their Anthropic siblings — flat in the providers array, no sub-module needed.

### Config loading order

NestJS `ConfigModule` loads env vars synchronously before any provider is instantiated. The `voyage` namespace in `configuration.ts` is read at module load time via the factory function, so `VoyageConfigService` will always see the resolved value.

### SDK `node-fetch` dependency

`voyageai@0.2.1` declares `node-fetch@^2.7.0` as a direct dependency. The project runs on Node 22 (`@types/node@^22`), which has a built-in `fetch`. There is no conflict — `node-fetch` is bundled inside `voyageai` and does not affect the application's native `fetch`. No action needed.

### Optional peer deps

`@huggingface/transformers` and `onnxruntime-node` are declared as optional peer deps of `voyageai`. They are only needed for local inference features (tokenizer counting). We do not use those features. Do not install them.

### Retry behavior

The SDK defaults to 2 retries. We must pass `maxRetries: 0` to the `VoyageAIClient` constructor so that retry behavior is not silently active during Phase 2. The task brief explicitly calls retry out of scope.

### TypeScript strictness

The project runs strict TypeScript. `EmbedResponseDataItem.embedding` is typed as `number[] | undefined`. The service must handle the case where `embedding` is missing from a response item (treat as a fatal malformed-response error, not a silent skip).

---

## Error Handling Strategy

All SDK calls are wrapped in a `try/catch` in `embedTexts`. Errors are categorized and re-thrown as typed `Error` instances with safe messages (no API key, no raw response body that might contain the key).

### Error categories

| Condition | SDK behavior | Service behavior | Log level |
|---|---|---|---|
| Auth failure (401) | Throws `VoyageAIError` with `statusCode: 401` | Re-throw `Error("Voyage API authentication failed — check VOYAGE_API_KEY")` | `logger.error` with `statusCode` only |
| Rate limit (429) | Throws `VoyageAIError` with `statusCode: 429` (SDK retries by default, but we set `maxRetries: 0`) | Re-throw `Error("Voyage API rate limit exceeded — caller should back off")` | `logger.warn` with `statusCode` |
| Network failure (no response) | Throws a non-`VoyageAIError` (e.g. `FetchError`, `TypeError`) | Re-throw `Error("Voyage API network failure: <error.message>")` | `logger.error` |
| 5xx server error | Throws `VoyageAIError` with `statusCode >= 500` | Re-throw `Error("Voyage API server error [statusCode=5xx]")` | `logger.error` with `statusCode` |
| Malformed response (missing `.data` or `.embedding`) | No SDK error thrown — returns a partial object | Throw `Error("Voyage API returned malformed response — missing embedding data")` | `logger.error` |

### API key safety rules

- `voyageConfig.apiKey` must never appear in any log line — not even partially.
- Caught error objects must not be logged raw (e.g. `logger.error(error)`) because `error.body` may echo the request, which may contain the key indirectly. Log `error.message` and `error.statusCode` only.
- No public getter or method on `VoyageService` should expose the API key.

### Log line format

Follow the existing `key=value` bracketed format from the codebase. Examples:

```
Voyage embedding request [model=voyage-3-large batchSize=42]
Voyage embedding complete [model=voyage-3-large count=42]
Voyage API error [statusCode=429]
```

---

## Testing Strategy

### `src/services/voyage-config.service.spec.ts`

Mock `ConfigService` with a plain object (same pattern as `AnthropicService` spec). Three test cases:

1. `apiKey` getter returns the value from `ConfigService.get`
2. `model` getter returns the value from `ConfigService.getOrThrow`
3. `model` getter returns `"voyage-3-large"` when the env var is absent (default from `configuration.ts` ensures `getOrThrow` never actually throws in normal operation — but the test confirms the getter path works)

### `src/services/voyage.service.spec.ts`

Mock the `voyageai` SDK at the module level using `jest.mock("voyageai", ...)` — the same pattern used in `anthropic.service.spec.ts` which uses `jest.mock("@anthropic-ai/sdk", ...)`. Five test cases:

1. **`embedText` returns a single vector** — call `embedText("hello")`, assert result equals the mocked `embedding` array from `response.data[0].embedding`
2. **`embedTexts` with N < batch limit makes one API call** — pass 3 texts, assert `client.embed` was called once with all 3 in `input`
3. **`embedTexts` with N > batch limit makes multiple sequential calls** — pass 1001 texts (mock returns generic vectors), assert `client.embed` was called twice (first call with 1000, second with 1), assert the result array has 1001 entries in the correct order
4. **Empty input returns `[]` without calling the SDK** — call `embedTexts([])`, assert `client.embed` was never called, assert return value is `[]`
5. **Auth failure throws a safe error** — mock `client.embed` to throw a `VoyageAIError`-like object with `statusCode: 401`, assert the thrown error message does NOT contain the API key string

### Mocking approach

```typescript
const mockEmbed = jest.fn();

jest.mock("voyageai", () => ({
  VoyageAIClient: jest.fn().mockImplementation(() => ({
    embed: mockEmbed,
  })),
}));
```

This mirrors the exact pattern in `anthropic.service.spec.ts` where the SDK default export is mocked at the module level.

### No live API calls

All tests use mocked responses. The `VOYAGE_API_KEY` env var is never set in the test environment. Tests must pass in CI where no real key exists.

---

## Risks and Edge Cases

### High

**SDK response `embedding` field is optional in the type.** `EmbedResponseDataItem.embedding` is typed as `number[] | undefined`. If the field is missing for any item, the service must detect this and throw a malformed-response error rather than silently returning `undefined` entries in the output array. The implementer must include an explicit guard.

**Mitigation:** After extracting `response.data`, iterate over items and throw if any `item.embedding` is undefined before returning.

### Medium

**Batch limit delta (128 → 1000).** The task brief assumed 128; live docs confirm 1000. If the implementer relies on memory or the brief without reading the plan, they may use 128. The constant `VOYAGE_MAX_BATCH = 1000` is named explicitly in the plan to make this unambiguous.

**Mitigation:** Plan states the correct value and its source. The code review step (Step 5) is instructed to verify the SDK version matches the arch-planner's confirmed value.

**Built-in SDK retry.** `voyageai@0.2.1` retries automatically on 429 and 5xx unless `maxRetries: 0` is set. Forgetting this parameter means retry logic is silently active, contradicting the phase's explicit out-of-scope declaration.

**Mitigation:** Plan calls out `maxRetries: 0` explicitly in the constructor step. Code review step should verify this.

### Low

**`VOYAGE_API_KEY` missing in local dev.** The brief acknowledges this is acceptable. The env schema marks the var as optional. `VoyageConfigService.apiKey` returns `undefined`. The `VoyageAIClient` constructor accepts `undefined` for `apiKey`. Calls will fail with a 401 at runtime, which is the correct behavior — the service is not usable without a key.

**Token budget limit.** The Voyage API enforces a 120K token limit per batch call, separate from the 1000-text count limit. For very long texts, a batch of fewer than 1000 items could still exceed the token budget. This phase does not handle this case. It is an acceptable risk given Phase 2 scope — document as a known follow-up item for Phase 4.

**`response.data` order.** The API may return items in a different order than submitted. The plan's algorithm sorts by `.index` before extracting embeddings. The implementer must not skip this sort.

---

## Out-of-Scope Confirmations

The following are explicitly NOT part of Phase 2:

- No callers wired anywhere (`VoyageService` is not injected into any controller, agent, tool, or other service)
- No integration with ingestion pipeline (Phase 4)
- No integration with retrieval / RAG (Phase 5)
- No retry logic — `VoyageService` throws on failure; callers decide what to do
- No caching of embeddings
- No `input_type` parameter exposed to callers (hardcoded to `"document"` internally; overloads come in a later phase)
- No `output_dimension` parameter — Phase 2 always uses the model default (1024 for `voyage-3-large`)
- No Nest CLI command or REPL script for manual smoke testing (the brief mentioned it as optional; it is out of scope for the automated plan)
- No changes to any existing controller, service, agent, or tool
