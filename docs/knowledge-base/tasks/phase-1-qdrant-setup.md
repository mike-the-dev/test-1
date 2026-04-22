TASK OVERVIEW
Task name: Phase 1 — Qdrant local setup and NestJS client module

Objective:
Add Qdrant as a local-development dependency via Docker Compose, create a typed NestJS provider that exposes a Qdrant client instance to the rest of the app, and verify connectivity with a startup smoke check. This is foundation-only work. No document ingestion, no retrieval, no collection creation for the knowledge base yet — those land in Phase 3+. When this phase is done, the app should build, tests should pass, and a single `npm run start:dev` should log that it successfully reached Qdrant.

Relevant context:
- This is a NestJS + TypeScript API. The primary datastore is DynamoDB; we are adding Qdrant alongside it specifically for vector storage of document chunks in a future Knowledge Base feature.
- The broader KB feature architecture: per-account isolation (every Qdrant query will filter by `account_ulid`), chunked document text with Voyage embeddings (Voyage integration is Phase 2, parallel with this one), Claude enrichment at ingestion (Phase 7). None of that is in this phase's scope — flagged only so you understand what this infrastructure is for.
- The existing pattern for wrapping an external client as a NestJS provider lives in `src/providers/dynamodb.provider.ts`. Study it and mirror it. The existing pattern for a typed config service reading from `@nestjs/config` lives in `src/services/database-config.service.ts`. Mirror it as well.
- Qdrant runs as a single container locally using the official image. Default port is 6333. Local URL: `http://localhost:6333`. No auth for local dev. Production will use Qdrant Cloud with an API key (same env-var interface; `QDRANT_API_KEY` should be optional and omitted for local).
- The official Qdrant JS client is `@qdrant/js-client-rest`. **The arch-planner MUST verify the latest version and exact API shape against the current Qdrant JS SDK docs (use context7 or WebFetch — `https://qdrant.tech/documentation/frameworks/nodejs/` and the package's npm page) before finalizing the plan. Training-data knowledge of Qdrant SDKs is unreliable.**
- The project's env-file loading happens in `src/app.module.ts` via `ConfigModule.forRoot` with `envFilePath: [.env.${APP_ENV||"local"}, .env]`. Env validation is at `src/config/env.validation.ts`.


STEP 1 — ARCHITECTURE PLANNING
Use the arch-planner agent to analyze the codebase and produce a structured implementation plan.

Task specifics for this plan:
- Confirm the exact npm package, current version, and typed API surface of `@qdrant/js-client-rest` via live docs (not training data).
- Define the env-var interface: `QDRANT_URL` (required), `QDRANT_API_KEY` (optional — present in prod, absent in local).
- Design `src/services/qdrant-config.service.ts` following `database-config.service.ts` exactly in structure (getters reading from `ConfigService.getOrThrow`/`get`).
- Design `src/providers/qdrant.provider.ts` following `dynamodb.provider.ts` exactly: exported injection token (e.g. `QDRANT_CLIENT`) + a provider object that constructs the client from the config service.
- Decide where the startup smoke check lives — most natural home is the provider's `useFactory` doing a `client.getCollections()` call and logging the result. It must NOT throw if Qdrant is unreachable (local dev convenience), but it MUST log a clear warning that includes the URL being tried.
- Add a minimal `docker-compose.yml` at the repo root exposing Qdrant on 6333, using the official image `qdrant/qdrant:latest`. Volume mount for persistence is optional — recommend including a named volume so dev data survives container restarts.
- Update `src/config/env.validation.ts` so `QDRANT_URL` is validated (string, URL shape) and `QDRANT_API_KEY` is an optional string.
- Update the env-file loading in the configuration module (`src/config/configuration.ts`) so a new `qdrant` namespace is exposed (following the same pattern as `database` and `anthropic`).
- Register `QdrantConfigService` and `QdrantProvider` in `src/app.module.ts`.
- **Do NOT create any Qdrant collections in this phase.** No `client.createCollection` calls anywhere. That belongs to Phase 3/4.

Requirements for the plan:
- identify affected files/modules
- outline step-by-step implementation order
- note dependencies and architectural considerations
- list risks or edge cases (especially: Qdrant unreachable on startup, SDK version drift, env-var misconfiguration)
- define testing strategy (unit tests for `QdrantConfigService`, a mock-based spec for the provider factory, no integration test yet)

Pause after producing the plan so I can review and approve it.


STEP 2 — IMPLEMENTATION
Use the code-implementer agent to implement the approved plan.

Implementation details for this task:
- Add `@qdrant/js-client-rest` to `package.json` dependencies at the version confirmed by the arch-planner. Run `npm install` and commit the lockfile.
- Create `docker-compose.yml` at the repo root containing only the `qdrant` service.
- Create `src/services/qdrant-config.service.ts` mirroring `src/services/database-config.service.ts` in shape and style.
- Create `src/providers/qdrant.provider.ts` mirroring `src/providers/dynamodb.provider.ts` in shape and style. Export an injection token (e.g. `QDRANT_CLIENT`). The provider's `useFactory` performs a non-throwing `getCollections()` smoke call and logs either `Qdrant connected [url=... collectionCount=N]` on success or `Qdrant unreachable [url=... error=...]` on failure. The app must still start either way.
- Update `src/config/configuration.ts` to expose a `qdrant` namespace with `url` and `apiKey` fields.
- Update `src/config/env.validation.ts` to validate `QDRANT_URL` (required URL string) and `QDRANT_API_KEY` (optional string).
- Register both the provider and the config service in `src/app.module.ts` providers array, adjacent to the DynamoDB equivalents.
- Add `QDRANT_URL=http://localhost:6333` (and a commented-out `QDRANT_API_KEY=`) to `.env.local` if that file exists. Do not overwrite other env vars.

Implementation requirements:
- follow the plan produced by the arch-planner agent
- modify or create only the necessary files
- respect existing architecture and coding patterns
- focus on correctness first (style will be handled later)


STEP 3 — STYLE REFACTOR
Use the style-refactor agent to refactor the implementation according to the rules defined in `.claude/instructions/style-enforcer.md`.

Style refactor specifics:
- `QdrantConfigService` and `QdrantProvider` must be structurally indistinguishable in style from their DynamoDB siblings. Read `src/services/database-config.service.ts` and `src/providers/dynamodb.provider.ts` first and use them as the reference.
- No `any`, no magic strings for the injection token (declare as `const` at module top and export).
- Log lines should follow the existing key=value bracketed format used elsewhere in the codebase (see `list-services.tool.ts` or `tool-registry.service.ts` for the style).
- No dead code, no unused imports, no placeholder comments.

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
- Run `npm test` to confirm unit tests pass. Expected new tests: a spec for `QdrantConfigService` that mocks `ConfigService` and asserts URL/API-key reads, plus a spec for the provider factory that mocks `@qdrant/js-client-rest` and verifies the smoke-check path (success + failure branches both log correctly and never throw).
- Do not attempt to run Qdrant locally as part of the test run. All specs must be fully mocked.

Testing requirements:
- run the project's standard test command
- report all failing tests clearly
- summarize results
- do not modify code or attempt fixes


STEP 5 — CODE REVIEW
Use the code-reviewer agent to review the implementation.

Review focus for this task:
- Does the Qdrant provider / config pattern match the DynamoDB provider / config pattern exactly? Any drift is a bug.
- Is env validation complete and defensively typed? Is `QDRANT_API_KEY` correctly optional?
- Does the startup smoke check refuse to crash the app when Qdrant is down? (Critical — local dev must still work without a running Qdrant.)
- Is the Docker Compose minimal, correct image, correct port, and does it avoid committing any secrets?
- Are there any accidental calls to `createCollection`, `upsert`, `search`, or any other Qdrant operation beyond `getCollections()`? There should be zero. This phase is connectivity only.

Review requirements:
- verify correctness of the implementation
- confirm alignment with the architectural plan
- evaluate maintainability, security, and performance
- ensure style refactor did not alter functionality
- report issues using structured review feedback
