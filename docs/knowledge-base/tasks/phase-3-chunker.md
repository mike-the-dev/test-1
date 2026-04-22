TASK OVERVIEW
Task name: Phase 3 — Chunker utility

Objective:
Create a pure, synchronous Node.js utility that takes a string of source text and returns it split into ordered, overlapping chunks suitable for embedding and storage. This function is the first stage of the Knowledge Base ingestion pipeline: its output feeds Voyage for embedding in Phase 4 and is written to Qdrant alongside its vectors. When this phase is done, the chunker is callable from anywhere in the codebase, has thorough unit tests, and has no callers yet (it will be wired into the ingestion pipeline in Phase 4).

Relevant context:
- This is a NestJS + TypeScript API. The project's convention is that pure utilities live in `src/utils/` grouped in subfolders by concern (see `CLAUDE.md`). All types and interfaces live in `src/types/` — never inline in utils.
- No new npm dependencies. The chunker must be implemented with standard-library string operations only.
- The chunker is called **once per document** at ingestion time. Performance matters but is not the dominant concern; correctness and natural-boundary preservation matter more.
- Chunking strategy: **character-based approximation with natural-boundary preservation.**
  - Target size: ~2000 characters per chunk (approximately 500 tokens for English — the industry default for retrieval-oriented chunking).
  - Overlap: ~200 characters between adjacent chunks (approximately 50 tokens).
  - The chunker prefers to break on natural boundaries (paragraph breaks, then sentence breaks, then word breaks) when a suitable boundary exists within a reasonable window near the target size. Only if no boundary is found does it hard-cut.
  - These defaults are chosen at the repo level; the function accepts optional overrides for test-ability and future tuning.
- The Chunk type will also be used in Phase 4 (the ingestion service) and Phase 5 (the retrieval tool). Place it in `src/types/KnowledgeBase.ts` (new file) so both phases can import the same shape.
- No tokenizer dependency. Character count is an approximation; we accept ~20% variance in actual token count per chunk. If we later decide exact token counting is worth the dependency weight, that is a Phase 7 hardening concern, not a Phase 3 blocker.


STEP 1 — ARCHITECTURE PLANNING
Use the arch-planner agent to analyze the codebase and produce a structured implementation plan.

Task specifics for this plan:
- Review `CLAUDE.md` for folder-organization conventions (`src/utils/<concern>/` pattern, type placement in `src/types/`).
- Scan `src/utils/` to see what subfolder conventions already exist (there may or may not be any utils yet — either way, establish `src/utils/chunker/` cleanly).
- Design the chunker's public API:
  - Function signature: `chunkText(source: string, options?: ChunkOptions): Chunk[]` — synchronous, returns an array even for empty input.
  - `Chunk` interface (in `src/types/KnowledgeBase.ts`): `{ text: string; index: number; startOffset: number; endOffset: number }`.
  - `ChunkOptions` interface (in the same file): `{ targetChars?: number; overlapChars?: number }` — both optional, with sane defaults applied inside the function.
  - Named constants for defaults (`DEFAULT_TARGET_CHARS = 2000`, `DEFAULT_OVERLAP_CHARS = 200`) exported from the chunker module so tests can reference them.
- Specify the chunking algorithm clearly enough that an implementer can write it without re-deriving:
  1. If the source is empty or whitespace-only after trimming, return `[]`.
  2. Walk the source with a moving `position` pointer. Each iteration, compute a tentative `end = min(position + targetChars, source.length)`.
  3. If `end < source.length`, search within the last ~25% of the chunk (i.e. between `position + targetChars * 0.75` and `end`) for the rightmost natural boundary in preference order: paragraph break (`\n\n`), then sentence boundary (`. `, `! `, `? `, `.\n`, `!\n`, `?\n`), then word boundary (` ` or newline). If one is found within the window, adjust `end` to break there.
  4. Extract `source.substring(position, end).trim()`. If non-empty, push as a chunk with monotonically increasing `index`.
  5. If `end >= source.length`, terminate.
  6. Advance: `position = max(end - overlapChars, position + 1)`. The `position + 1` floor prevents infinite loops when overlap ≥ chunk size due to a pathological input.
- Define edge cases the plan must cover:
  - Empty string → `[]`
  - Whitespace-only string → `[]`
  - Source shorter than `targetChars` → single chunk with `startOffset: 0`, `endOffset: source.length`
  - Source with no natural boundaries (e.g., 10,000 character run-on without whitespace) → falls back to hard-cuts at targetChars
  - `targetChars` and `overlapChars` overrides are honored
  - `overlapChars >= targetChars` (pathological) — handled by the `position + 1` floor; resulting chunks will overlap heavily, but the function terminates
  - Unicode / multi-byte characters — string methods are code-unit-based. Document this explicitly but do not try to handle graphemes; it is out of scope.
- Define the testing strategy: a single spec file (`src/utils/chunker/chunker.spec.ts`) covering at minimum the cases listed in Step 2 below. No NestJS test scaffolding is needed — pure Jest unit tests.

Requirements for the plan:
- identify affected files/modules
- outline step-by-step implementation order
- note dependencies and architectural considerations (there should be none new — this is std-lib only)
- list risks or edge cases
- define testing strategy (file paths, per-test intent, mocking approach — should be none)

Pause after producing the plan so I can review and approve it.


STEP 2 — IMPLEMENTATION
Use the code-implementer agent to implement the approved plan.

Implementation details for this task:
- Create `src/types/KnowledgeBase.ts` with `Chunk` and `ChunkOptions` interfaces as specified in the plan.
- Create `src/utils/chunker/chunker.ts` with:
  - `export const DEFAULT_TARGET_CHARS = 2000;`
  - `export const DEFAULT_OVERLAP_CHARS = 200;`
  - `export function chunkText(source: string, options?: ChunkOptions): Chunk[]` implementing the algorithm in the plan.
  - Keep it pure and synchronous. No `async`, no side effects, no logging.
- Create `src/utils/chunker/chunker.spec.ts` covering at minimum all of these cases. Every one of these tests must exist, named clearly. Miss any and remediation will be required.
  1. Empty string returns an empty array.
  2. Whitespace-only string returns an empty array.
  3. Source shorter than `DEFAULT_TARGET_CHARS` returns a single chunk whose `text` equals the trimmed source, `index` is 0, `startOffset` is 0, `endOffset` is `source.length`.
  4. Source exactly at `DEFAULT_TARGET_CHARS` returns a single chunk.
  5. Long source with paragraph breaks produces multiple chunks, and at least one chunk boundary aligns with a paragraph break (`\n\n`) rather than mid-sentence.
  6. Long source with sentence boundaries but no paragraph breaks produces chunks that mostly break on `. ` rather than mid-word.
  7. Long source with no boundaries at all (e.g. 5000 `"a"` characters) produces chunks of length exactly `DEFAULT_TARGET_CHARS` (except possibly the last).
  8. Consecutive chunks overlap by at least `DEFAULT_OVERLAP_CHARS - some-small-slack` characters (assert by checking that the suffix of chunk `N` appears as a prefix of chunk `N+1`, allowing for trim differences).
  9. Chunk indices are sequential starting from 0 (`chunks.map(c => c.index)` equals `[0, 1, 2, ...]`).
  10. Custom `targetChars` and `overlapChars` overrides are honored — passing `{ targetChars: 500, overlapChars: 50 }` produces chunks no larger than ~500 characters (allow small variance for boundary preservation).
  11. Pathological input: `chunkText("a".repeat(10000), { targetChars: 100, overlapChars: 200 })` terminates (no infinite loop) and returns chunks — asserts finite-time completion, not a specific output count.
- No callers. Do NOT wire the chunker into any service, controller, agent, or tool — that is Phase 4.
- Run `npm run build` and `npm test` before returning. Both must be clean. If any new test fails, fix the implementation (not the test).

Implementation requirements:
- follow the plan produced by the arch-planner agent
- modify or create only the necessary files
- respect existing architecture and coding patterns
- focus on correctness first (style will be handled later)


STEP 3 — STYLE REFACTOR
Use the style-refactor agent to refactor the implementation according to the rules defined in `.claude/instructions/style-enforcer.md`.

Style refactor specifics:
- Readability matters more than cleverness in the chunker algorithm — resist condensing clear conditionals into one-liners.
- No `any`, no magic numbers outside the exported constants, no dead code.
- Helper functions (e.g., boundary finding) should be named clearly and live in the same file — do not split across multiple files for such a small module.
- Keep exported symbols to exactly what's needed by callers: `chunkText`, `DEFAULT_TARGET_CHARS`, `DEFAULT_OVERLAP_CHARS`. Don't export internal helpers.

Style requirements:
- apply all rules from style-enforcer.md
- improve readability, structure, and consistency
- align code with project conventions and standards
- do not change functionality or logic
- do not introduce new behavior


STEP 4 — TEST EXECUTION
Use the test-suite-runner agent to execute the project's test suite.

Testing context for this task:
- Run `npm run build` to confirm types are clean.
- Run `npm test`. Expected: all 11 chunker tests pass plus all 244 previously-passing tests. Total should be 255. Report the exact numbers.

Testing requirements:
- run the project's standard test command
- report all failing tests clearly
- summarize results
- do not modify code or attempt fixes


STEP 5 — CODE REVIEW
Use the code-reviewer agent to review the implementation.

Review focus for this task:
- Algorithmic correctness of the chunking logic — especially boundary preservation, overlap correctness, and termination on pathological inputs.
- Edge-case coverage in the spec — are all 11 cases actually meaningful and asserting the right thing, or are any of them tautological?
- Export surface — is the public API exactly the three exports above, nothing more?
- Placement — `Chunk` / `ChunkOptions` in `src/types/KnowledgeBase.ts`, functions in `src/utils/chunker/chunker.ts`, consistent with CLAUDE.md conventions.
- No accidental callers — grep `chunkText` and confirm the only references are in the chunker file and its spec.

Review requirements:
- verify correctness of the implementation
- confirm alignment with the architectural plan
- evaluate maintainability, security, and performance
- ensure style refactor did not alter functionality
- report issues using structured review feedback
