TASK OVERVIEW
Task name: Phase 7b — Claude enrichment at ingestion (Approach 2's quality lift)

Objective:
Insert a Claude enrichment step into the ingestion pipeline so that each chunk gets paired with a Claude-generated summary plus likely customer questions plus key terms. The combined text (original chunk + enrichment) is what gets embedded by Voyage. The result: chunk vectors land closer to the customer-language neighborhood in embedding space, dramatically lifting retrieval scores on the kind of natural-language queries that customers actually send. This is the "Approach 2 complete" milestone from the original architecture — the moment the platform's retrieval quality stops being good and starts being best-in-class.

When this phase is done:
- Every chunk written to Qdrant carries enrichment text in its payload.
- The Voyage embedding for each chunk is computed over the combined `chunk_text + enrichment` text.
- Existing tests still pass; new tests cover the enrichment path AND its fallback (single-chunk enrichment failure does not fail the whole ingestion).
- A re-run of the 10 benchmark questions against the dog-walking KB shows measurably higher top-K cosine similarity scores compared to the Phase 6 baseline.

Relevant context:
- This phase modifies the Phase 4 ingestion service. Phase 5's retrieval tool, the hybrid agent prompt, and Phase 7a's update/delete machinery are unchanged structurally — they just get higher-quality vectors to work with.
- Read `docs/knowledge-base/data-flows.md` for the current ingestion flow. Phase 7b inserts a new step between "chunker" and "Voyage embed" in Flow 1 and Flow 3. The data-flows doc must be updated as part of this phase.
- The existing `src/services/anthropic.service.ts` is structured around the chat-conversation use case (system prompt + history + tools). Phase 7b's enrichment is a different shape: single-shot prompt + user message → plain text response, no tools, no caching. The plan should decide whether to extend AnthropicService with a new method or build a small new service that uses the underlying `@anthropic-ai/sdk` directly. Recommendation: a new dedicated service, since enrichment has its own concerns (prompt design, structured-output parsing, per-chunk failure tolerance).
- The existing `AnthropicConfigService` is reused (no changes needed for Phase 7b — same API key, same default model).
- We already use Sonnet as the default Anthropic model in this repo. Phase 7b uses Sonnet for enrichment too — Haiku is a documented future cost lever, but NOT implemented in this phase.

Key contracts (locked by the user before this brief — do not relitigate):

**Enrichment scope:**
- Always-on per chunk. No per-document or per-account opt-out flag in v1.
- One Claude call per chunk. No batching across chunks (Anthropic's API is per-call).
- Concurrent chunk processing using `Promise.all` with a concurrency cap of **5** (a small custom helper, NOT a new dependency). This caps inflight Claude calls so we don't hammer rate limits. A 15-chunk document at 5-way parallelism completes enrichment in roughly 9–15 seconds; a 100-chunk document completes in roughly 60–100 seconds (still synchronous in this phase — Phase 7c adds the Redis queue if/when sync becomes too slow).

**Embedding strategy:**
- For each chunk, the text passed to `Voyage.embedTexts` is the **combined** string:
  ```
  ${chunk.text}

  ${enrichment}
  ```
  (chunk text, blank line, enrichment text). Single vector per chunk — same as today, no multi-vector explosion.
- The embedding represents both the chunk's literal content AND its customer-language paraphrases. This is the whole mechanism behind the score lift.

**Qdrant payload:**
- New optional field `enrichment: string` added to `KnowledgeBasePointPayload`. Stored alongside `chunk_text` for audit and debugging — so we can always inspect what Claude generated and what was actually embedded.
- `chunk_text` field is UNCHANGED. The retrieval tool still returns `chunk_text` (mapped to `text`) to Claude at query time. Claude does NOT see the enrichment at retrieval — it sees the original passage. The enrichment exists only to influence vector position; once retrieval is done, the original text is what gets reasoned over.

**Per-chunk enrichment failure handling:**
- If Claude enrichment fails for a single chunk (rate limit, network blip, malformed response, anything), the service must:
  1. Log the failure with the bracketed `[key=value]` format including `chunkIndex` and `errorType`. NEVER log the raw error object or the API key.
  2. Fall back to embedding just the `chunk_text` for that chunk (omit enrichment from the payload — leave the field absent).
  3. Continue ingestion of remaining chunks.
- This is "graceful degradation" — a single bad chunk should not block a 100-chunk ingestion. The unenriched chunk still contributes a usable vector; we just lose the score lift on that one chunk's content.
- If MORE than half the chunks fail enrichment (an unambiguous Anthropic-side outage), the entire ingestion should still complete — log loudly with a high-severity message indicating widespread enrichment failure, but don't throw. The DDB record for the document gets written normally; an operator can re-trigger the upstream POST later to retry enrichment.

**Enrichment prompt:**
- Stored as a single named exported constant in the new enrichment service file.
- The arch-planner should propose a final prompt; the brief offers this starting point:
  ```
  You are preparing knowledge base content for semantic vector retrieval. A customer-facing AI agent will use vector search to find relevant passages when answering visitor questions about a business.

  Read the passage below and generate enrichment text that will be combined with the original passage and embedded together. The goal is to make the embedded vector match a wider range of natural customer query phrasings while preserving the original passage's meaning.

  Generate three sections in this exact format (no markdown, no code blocks):

  SUMMARY:
  <one or two sentences in plain customer-friendly language>

  QUESTIONS:
  - <question 1 a customer might ask whose answer is in this passage>
  - <question 2>
  - <question 3>
  - <optional question 4>
  - <optional question 5>

  KEY TERMS:
  <comma-separated list of 5–10 words a customer might use, including informal synonyms>

  PASSAGE:
  <chunk text here>
  ```
- The arch-planner is encouraged to refine the prompt for clarity and brevity, but must preserve the three-section structure (SUMMARY / QUESTIONS / KEY TERMS) and the plain-text output format.

**Cost model (locked):**
- Default Claude model: Sonnet (matches the rest of the repo).
- Per-chunk enrichment cost: roughly 700 input tokens + 200 output tokens ≈ $0.005.
- Per-document cost: chunks × $0.005. The dog-walking employee manual (15 chunks) costs ~$0.07 to enrich. A typical 50-page client manual (~25 chunks) costs ~$0.13. A 300-page reference (~150 chunks) costs ~$0.75. All one-time per ingestion.
- Haiku as a future cost lever: documented in the constants file as a comment, but NOT implemented in Phase 7b. Switching to Haiku would cut these by ~6×.

Out of scope for Phase 7b:
- Async queue (Redis + Bull) — Phase 7c.
- Reranker on retrieval results — future Approach 3.
- Per-document or per-account opt-out flag for enrichment — future.
- Multi-vector per chunk (separate vectors for chunk + summary + each question) — future, only if data shows it's worth the storage cost.
- Storing enrichment in DynamoDB — only stored in Qdrant payload.
- Migration of existing already-ingested chunks to add enrichment — those will be re-enriched naturally on next document update via Phase 7a's idempotent re-ingest.
- Showing enrichment to Claude at retrieval time — never.
- Switching to Haiku — documented as a future lever, not implemented.


STEP 1 — ARCHITECTURE PLANNING
Use the arch-planner agent to analyze the codebase and produce a structured implementation plan.

Task specifics for this plan:

1. Read the brief in full. Read `docs/knowledge-base/data-flows.md` to understand the current pipeline shape Phase 7b modifies.

2. Study the existing patterns the new code must mirror:
   - `src/services/anthropic.service.ts` — current Anthropic SDK usage. Decide whether the new enrichment service uses AnthropicService internally or instantiates the SDK directly. Justify the choice.
   - `src/services/anthropic-config.service.ts` — confirms how API key + model are read.
   - `src/services/voyage.service.ts` — pattern for an external-API service that handles batching, errors, and sanitization.
   - `src/services/knowledge-base-ingestion.service.ts` — the existing pipeline you're modifying. Particularly the `ingestDocument` method's step ordering — your enrichment step inserts between "chunker output" and "Voyage embed call."
   - Log-line format: bracketed `[key=value key=value]` everywhere.

3. Verify the Anthropic SDK's current API for non-tool, non-streaming, single-response calls against live docs. Specifically:
   - The `messages.create({ model, max_tokens, system, messages })` signature when `tools` is omitted.
   - How to extract a plain-text response when there's only one content block.
   - Source: `https://docs.anthropic.com/en/api/messages`.

4. Produce a detailed implementation plan covering ALL of these sections:
   - **Overview** — one paragraph.
   - **Affected files / modules** — comprehensive list with one-line note per file.
   - **Anthropic SDK verification findings** — the exact call shape you confirmed, including how the response's text content is extracted. Cite source URLs.
   - **Service design** — exact public API surface for the new `KnowledgeBaseEnrichmentService`. Recommend ONE public method, e.g., `enrichChunk(chunkText: string): Promise<string | null>` that returns the enrichment text on success or `null` on failure. The caller (ingestion service) handles the fallback logic per the brief's contract.
   - **Concurrency design** — exact code shape for the 5-way concurrency cap. Use a custom inline helper (no `p-limit` or other dep). Reference existing repo patterns if any equivalent helper exists; otherwise propose a small Promise-based one.
   - **Prompt finalization** — your refined version of the SUMMARY/QUESTIONS/KEY TERMS prompt, as it will appear in the code as an exported constant. Justify any deviations from the brief's starting point.
   - **Response parsing** — how the service validates that Claude returned the expected three-section format. On parse failure, treat as a per-chunk failure (return `null`).
   - **Type additions** — exact TypeScript shapes for any new interfaces. The `KnowledgeBasePointPayload.enrichment?: string` addition specifically.
   - **Pipeline integration** — exact diff to `KnowledgeBaseIngestionService.ingestDocument`. Where the enrichment step inserts, how its results flow into the embedding step, how the per-chunk failure path falls back to embedding just `chunk_text`.
   - **Step-by-step implementation order** — file-by-file, granular enough that the code-implementer can execute without re-thinking.
   - **Risks and edge cases** — at minimum: Anthropic rate limit during a large ingestion, malformed Claude output, all-chunks-fail scenario, the impact on ingestion latency (synchronous; this phase doesn't add the queue).
   - **Testing strategy** — list every new test case AND every existing test that needs an updated assertion. Cover:
     - Happy path: enrichment succeeds for all chunks, combined text is embedded.
     - Single-chunk failure: enrichment fails for chunk N, that chunk is embedded with just `chunk_text` (no enrichment in payload), other chunks embed normally.
     - All-chunks-fail: ingestion still completes, all chunks embed with just `chunk_text`, loud warning logged.
     - Prompt is included verbatim in the call.
     - Concurrency cap is respected (no more than 5 inflight Claude calls).
   - **Data-flows doc updates** — exactly what to add to `docs/knowledge-base/data-flows.md` to reflect the new enrichment step in Flow 1 and Flow 3.
   - **Out-of-scope confirmations.**

5. Write your plan to `docs/knowledge-base/tasks/phase-7b-claude-enrichment-plan.md`.

6. Return a concise summary (under 500 words) including: (a) path to the plan file, (b) 4–6 key decisions you made, (c) any risks or unknowns the orchestrator should flag to the user before approval — especially around the concurrency cap, prompt finalization, and the synchronous-ingest latency for large documents.

Pause after producing the plan so the orchestrator can get user approval before Step 2.


STEP 2 — IMPLEMENTATION
Use the code-implementer agent to implement the approved plan.

Implementation details for this task:
- Create the new enrichment service. Mirror the existing service structure (constructor DI, logger, named exported constants for the prompt and concurrency cap).
- Insert the enrichment step into `KnowledgeBaseIngestionService.ingestDocument` per the plan's exact instructions.
- Add `enrichment?: string` to `KnowledgeBasePointPayload`.
- Update the data-flows doc to reflect the new ingestion shape.
- Run `npm run build` and `npm test` before returning. Both must be clean. Total tests should be 323 + new (estimate ~6–10 new for enrichment paths).
- Commit on master. Suggested subject: `feat(kb): add Claude enrichment at ingestion for retrieval-quality lift`. **Do NOT add `Co-Authored-By:` or credit Claude.**

Implementation requirements:
- follow the plan produced by the arch-planner agent
- modify or create only the necessary files
- respect existing architecture and coding patterns
- focus on correctness first (style will be handled later)


STEP 3 — STYLE REFACTOR
Use the style-refactor agent to refactor the implementation according to the rules defined in `.claude/instructions/style-enforcer.md`.

Style refactor specifics:
- The new enrichment service must be structurally indistinguishable from `voyage.service.ts` in pattern (constructor, logger, error handling, log format).
- Named constants for the prompt template, concurrency cap, model name (or read from existing AnthropicConfigService — the plan decides).
- Bracketed `[key=value]` log format everywhere.
- API keys must NEVER appear in any log message.
- No `any`, no inline type annotations TypeScript can infer, no dead code, no placeholder comments.

Style requirements:
- apply all rules from style-enforcer.md
- improve readability, structure, and consistency
- align code with project conventions and standards
- do not change functionality or logic
- do not introduce new behavior


STEP 4 — TEST EXECUTION
Use the test-suite-runner agent to execute the project's test suite.

Testing context for this task:
- Run `npm run build` first.
- Run `npm test`. Baseline before this phase: 323 tests passing. Phase 7b adds tests for the enrichment service AND the ingestion service's integration with it.
- Report exact pass/fail counts.
- If any failure exists, classify: enrichment-service bug, ingestion-integration bug, fallback-path bug, concurrency-cap bug, prompt/parsing bug, or unrelated regression.

Testing requirements:
- run the project's standard test command
- report all failing tests clearly
- summarize results
- do not modify code or attempt fixes


STEP 5 — CODE REVIEW
Use the code-reviewer agent to review the implementation.

Review focus for this task:
- **Per-chunk failure isolation**: a single Claude call failure does not cascade. The chunk falls back to embedding just `chunk_text`, the rest of the document continues. Verify by reading the actual control flow.
- **Concurrency cap respected**: at no point are more than 5 Claude calls inflight simultaneously. Check the implementation pattern.
- **API key never logged**: search every catch block, every log call, every thrown error message — confirm the API key never appears.
- **Embedded text is the combined `chunk_text + enrichment`** when enrichment succeeded, OR just `chunk_text` when enrichment failed. The actual text passed to `Voyage.embedTexts` must reflect this branching.
- **Qdrant payload's `enrichment` field is present only when enrichment succeeded** for that specific chunk. Absent (not empty string, absent) when it failed.
- **Retrieval is unchanged**: the lookup tool still returns `chunk_text` (not enrichment) to Claude. Verify by reading the retrieval tool code.
- **Pipeline ordering preserved**: the enrichment step inserts between chunker output and Voyage embed call. The Phase 7a update path (delete-old-chunks-then-write-new) still works correctly with enrichment in the loop.
- **Data-flows doc updated** to reflect the new ingestion shape.
- **Out-of-scope respected**: no Redis, no async queue, no reranker, no per-document opt-out, no Haiku switch, no migration of existing chunks.
- **Prompt is the exact final prompt from the plan** — not subtly mutated by the implementer.

Review requirements:
- verify correctness of the implementation
- confirm alignment with the architectural plan
- evaluate maintainability, security, and performance
- ensure style refactor did not alter functionality
- report issues using structured review feedback
