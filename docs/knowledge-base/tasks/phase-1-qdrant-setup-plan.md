# Phase 1 — Qdrant Local Setup and NestJS Client Module: Implementation Plan

## Overview

This phase adds Qdrant as a local-development dependency via Docker Compose and wires it into the NestJS application as a typed, injectable client. The deliverables are: a `docker-compose.yml` at the repo root for running Qdrant locally, a `QdrantConfigService` that reads `QDRANT_URL` and `QDRANT_API_KEY` from the config namespace, a `QdrantProvider` that constructs the SDK client and performs a non-throwing startup smoke check, env-schema additions, and a new `qdrant` namespace in `configuration.ts`. No collections are created, no data is written or read beyond the smoke-check `getCollections()` call. This is purely connectivity and DI plumbing — the foundation that Phase 3+ will build on.

---

## Affected Files / Modules

### Create

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Qdrant service for local development (port 6333, named volume) |
| `src/services/qdrant-config.service.ts` | Typed config service — mirrors `DatabaseConfigService` exactly |
| `src/services/qdrant-config.service.spec.ts` | Unit tests for `QdrantConfigService` |
| `src/providers/qdrant.provider.ts` | Qdrant client provider — mirrors `DynamoDBProvider` exactly |
| `src/providers/qdrant.provider.spec.ts` | Unit tests for the provider factory (success + failure smoke-check branches) |

### Modify

| File | Change |
|------|--------|
| `src/config/env.schema.ts` | Add `QDRANT_URL` (required, URL string) and `QDRANT_API_KEY` (optional string) |
| `src/config/configuration.ts` | Add `qdrant` namespace with `url` and `apiKey` fields |
| `src/app.module.ts` | Register `QdrantConfigService` and `QdrantProvider` in the providers array |
| `.env.local` | Append `QDRANT_URL=http://localhost:6333` and a commented-out `QDRANT_API_KEY=` line |

### Review Only (no changes)

| File | Why |
|------|-----|
| `src/providers/dynamodb.provider.ts` | Reference pattern for provider shape |
| `src/services/database-config.service.ts` | Reference pattern for config service shape |
| `src/config/env.validation.ts` | Unchanged — delegates entirely to `env.schema.ts` via `envSchema.safeParse` |

---

## SDK Verification Findings

Verified via live GitHub README at `https://github.com/qdrant/qdrant-js` (fetched 2026-04-21).

| Property | Value |
|----------|-------|
| npm package name | `@qdrant/js-client-rest` |
| Current stable version | **1.17.0** (released 2026-02-19) |
| Constructor — local | `new QdrantClient({ url: 'http://127.0.0.1:6333' })` |
| Constructor — with API key | `new QdrantClient({ url: '...', apiKey: '<key>' })` |
| Smoke check method | `await client.getCollections()` — returns `{ collections: CollectionDescription[] }` |
| Node.js requirement | >= 18.0.0 (project uses Node 22 per `@types/node ^22` — compatible) |
| Peer dependencies | None declared |
| Module format | Ships ESM and CJS |

**Constructor option field names confirmed:** `url` (string) and `apiKey` (optional string). No delta from what the task brief assumed.

Source: `https://github.com/qdrant/qdrant-js`

---

## Step-by-Step Implementation Order

### 1. Install the npm package

**What:** Add `@qdrant/js-client-rest@^1.17.0` to `dependencies` in `package.json`, run `npm install`, commit `package-lock.json`.

**Where:** repo root

**Why first:** All subsequent files import from this package. TypeScript will reject the imports until the package is installed and its types are present.

**Done when:** `npm install` exits cleanly; `node_modules/@qdrant/js-client-rest` exists; `package-lock.json` reflects the new entry.

---

### 2. Add the `qdrant` namespace to `src/config/configuration.ts`

**What:** Append a `qdrant` key to the configuration object returned by the factory function, following the exact same pattern as `database`, `anthropic`, and `discord`:

```
qdrant: {
  url: process.env.QDRANT_URL || '',
  apiKey: process.env.QDRANT_API_KEY,
},
```

**Where:** `src/config/configuration.ts`

**Why here:** `QdrantConfigService` will read from `qdrant.url` and `qdrant.apiKey` via `ConfigService`. The namespace must exist before that service can be written or tested.

**Done when:** The file compiles. The `qdrant` key is present and has `url: string` and `apiKey: string | undefined` fields.

---

### 3. Add env-var validation to `src/config/env.schema.ts`

**What:** Add two fields to the `envSchema` Zod object:

- `QDRANT_URL`: `z.string().url()` — required, must be a valid URL.
- `QDRANT_API_KEY`: `z.string().optional()` — absent for local, present in prod.

**Where:** `src/config/env.schema.ts`

**Why here:** Boot-time validation must fail fast if `QDRANT_URL` is missing or malformed. `env.validation.ts` already delegates entirely to `envSchema.safeParse`, so no changes are needed there.

**Done when:** Adding `QDRANT_URL=not-a-url` to the env causes startup to log `Invalid environment variables` and throw. Removing `QDRANT_URL` entirely does the same. A valid URL passes silently.

---

### 4. Create `src/services/qdrant-config.service.ts`

**What:** An `@Injectable()` class that wraps `ConfigService` with typed getters — one for each field in the `qdrant` namespace. Mirror `DatabaseConfigService` exactly:

- `get url(): string` — uses `configService.getOrThrow<string>('qdrant.url', { infer: true })`
- `get apiKey(): string | undefined` — uses `configService.get<string>('qdrant.apiKey', { infer: true })`

**Where:** `src/services/qdrant-config.service.ts`

**Why here:** The provider (step 5) depends on this service. Establishing it before the provider keeps the dependency graph clean.

**Done when:** The file compiles without errors. Getter names are `url` and `apiKey`.

---

### 5. Create `src/providers/qdrant.provider.ts`

**What:** Export a `const QDRANT_CLIENT = 'QDRANT_CLIENT'` injection token and a `QdrantProvider` object shaped identically to `DynamoDBProvider`:

```
export const QdrantProvider = {
  provide: QDRANT_CLIENT,
  useFactory: async (config: QdrantConfigService): Promise<QdrantClient> => {
    const client = new QdrantClient({
      url: config.url,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    });

    try {
      const result = await client.getCollections();
      this.logger.log(
        `Qdrant connected [url=${config.url} collectionCount=${result.collections.length}]`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Qdrant unreachable [url=${config.url} error=${message}]`);
    }

    return client;
  },
  inject: [QdrantConfigService],
};
```

**Important note on logging:** `useFactory` is a plain function, not a class method, so `this.logger` is not available. The implementer must use NestJS's `Logger` class directly (static methods `Logger.log()` and `Logger.warn()` with a context string, e.g. `'QdrantProvider'`). This is consistent with how `DynamoDBProvider`'s factory handles any logging needs and is the established NestJS pattern for provider factories.

**Why here:** Depends on `QdrantConfigService` (step 4) and the installed SDK (step 1).

**Done when:** The factory is `async`, returns a `QdrantClient`, never throws (errors are caught and logged), and the injection token is exported as a `const`.

---

### 6. Register in `src/app.module.ts`

**What:** Add two imports and two providers:

- Import: `QdrantConfigService` from `./services/qdrant-config.service`
- Import: `QdrantProvider` from `./providers/qdrant.provider`
- Add both to the `providers` array, adjacent to `DatabaseConfigService` and `DynamoDBProvider`

**Where:** `src/app.module.ts`

**Why here:** NestJS DI will not resolve `QDRANT_CLIENT` unless the provider is registered. Registration comes after the provider is defined (step 5).

**Done when:** `npm run build` succeeds. `npm run start:dev` logs either `Qdrant connected` or `Qdrant unreachable` at startup, and the app does not crash in either case.

---

### 7. Update `.env.local`

**What:** Append to the existing `.env.local` file (do not overwrite):

```
# Qdrant
QDRANT_URL=http://localhost:6333
# QDRANT_API_KEY=
```

**Where:** `.env.local`

**Why here:** Without this, the Zod schema will reject `QDRANT_URL` as missing at boot time for local development. The env-var validation added in step 3 requires it.

**Done when:** `npm run start:dev` no longer throws a config validation error on `QDRANT_URL`.

---

### 8. Create `docker-compose.yml`

**What:** A minimal Docker Compose file at the repo root with a single `qdrant` service:

```yaml
services:
  qdrant:
    image: qdrant/qdrant:latest
    ports:
      - "6333:6333"
    volumes:
      - qdrant_data:/qdrant/storage

volumes:
  qdrant_data:
```

**Where:** repo root (`docker-compose.yml`)

**Why here:** Provides the local Qdrant instance that the smoke check will connect to. The named volume `qdrant_data` survives `docker compose down` and preserves dev data between restarts.

**Done when:** `docker compose up -d` starts Qdrant and `curl http://localhost:6333/readyz` returns `{ "title": "qdrant - vector search engine" }` (or similar health response). Starting the app with Qdrant running produces `Qdrant connected [url=http://localhost:6333 collectionCount=0]`.

---

### 9. Write unit tests: `src/services/qdrant-config.service.spec.ts`

**What:** A Jest spec using `@nestjs/testing` `Test.createTestingModule`. Provide a mock `ConfigService` using `useValue` with a `jest.fn()` for `get` and `getOrThrow`. Assert:

1. `url` getter calls `configService.getOrThrow` with `'qdrant.url'`
2. `apiKey` getter calls `configService.get` with `'qdrant.apiKey'`
3. `url` getter returns the mocked string
4. `apiKey` getter returns `undefined` when the mock returns `undefined`
5. `apiKey` getter returns the mocked key string when present

**Where:** `src/services/qdrant-config.service.spec.ts`

**Why here:** Verifies the config service reads from the correct namespaced keys. No live Qdrant required.

**Done when:** `npm test` runs this spec with all 5 assertions passing.

---

### 10. Write unit tests: `src/providers/qdrant.provider.spec.ts`

**What:** A Jest spec that mocks `@qdrant/js-client-rest` using `jest.mock()` and tests the `useFactory` function in isolation. Two branches:

**Success branch:**
- Mock `QdrantClient` constructor
- Mock `client.getCollections()` to resolve `{ collections: [] }`
- Invoke `QdrantProvider.useFactory` with a mock config
- Assert the returned value is the mock client instance
- Assert `Logger.log` was called with a string matching `Qdrant connected` and containing the URL

**Failure branch:**
- Mock `client.getCollections()` to reject with `new Error('connection refused')`
- Invoke `QdrantProvider.useFactory`
- Assert the promise resolves (does NOT throw/reject)
- Assert `Logger.warn` was called with a string matching `Qdrant unreachable` and containing the URL and error message

**Where:** `src/providers/qdrant.provider.spec.ts`

**Why here:** The no-throw guarantee on the failure branch is the most critical behavior contract. This spec locks it in without requiring a live Qdrant instance.

**Done when:** `npm test` runs this spec with both branches passing and the failure branch confirms the factory resolves rather than rejects.

---

## Dependencies and Architectural Considerations

### NestJS DI and async factory

`DynamoDBProvider.useFactory` is synchronous. `QdrantProvider.useFactory` must be `async` because it `await`s `client.getCollections()`. NestJS handles async factory functions natively — the DI container awaits the resolved value before injecting it downstream. No `async: true` flag or special module configuration is needed; the factory's async signature is sufficient.

### Config loading order

`ConfigModule.forRoot` with `isGlobal: true` is already registered in `AppModule`. `QdrantConfigService` reads from `ConfigService` which depends on `ConfigModule` being initialized. Because `ConfigModule` is global and appears first in the `imports` array, this dependency is satisfied before any provider factory runs.

### Optional `apiKey` and spread pattern

The `QdrantClient` constructor accepts `apiKey` as an optional field. The recommended pattern is a conditional spread: `{ url, ...(apiKey ? { apiKey } : {}) }`. This avoids passing `apiKey: undefined` to the constructor, which may behave differently from omitting the field entirely depending on the SDK version's internal type guards.

### `Logger` in provider factory

NestJS `Logger` can be used statically inside a plain factory function. The context string `'QdrantProvider'` should be passed as the second argument so log output is identifiable. The log format must match the project's established key=value bracketed style (confirmed from `list-services.tool.ts`): `[key=value key2=value2]` within the message string.

### `env.validation.ts` is a pass-through

`src/config/env.validation.ts` is a one-liner that calls `envSchema.safeParse`. All validation logic lives in `src/config/env.schema.ts`. Only the schema file needs to change.

---

## Risks and Edge Cases

### HIGH — Qdrant unreachable on startup (local dev without Docker running)

**Risk:** If a developer runs `npm run start:dev` without `docker compose up`, the `getCollections()` call will throw a connection-refused error.

**Mitigation:** The `useFactory` wraps the call in `try/catch`. On error, it logs a `warn` line and returns the client instance anyway. The app starts successfully either way. This is an explicit requirement from the task brief and must be verified by the failure-branch unit test (step 10).

---

### HIGH — `QDRANT_URL` missing from `.env.local` after pull

**Risk:** A developer who pulls the branch but hasn't updated their `.env.local` will see `Config validation failed` at startup because `QDRANT_URL` is now required by the Zod schema.

**Mitigation:** Step 7 adds `QDRANT_URL=http://localhost:6333` to `.env.local`. The README or onboarding docs (out of scope here) should note the new env var. The Zod error message will name the missing field, making the fix self-evident.

---

### MEDIUM — SDK version drift

**Risk:** `^1.17.0` in `package.json` allows minor bumps. If Qdrant releases a breaking change in a minor version (unlikely but possible pre-2.0), the constructor signature or `getCollections` return shape could change.

**Mitigation:** Pin to `^1.17.0` (caret allows patch + minor). The provider spec mocks the SDK, so test breakage on a real API change would appear only at runtime, not in CI. Consider pinning to an exact version (`1.17.0`) if tighter control is preferred — flag this as a judgment call for the implementer.

---

### MEDIUM — TypeScript strict-mode compatibility with SDK types

**Risk:** The SDK may export types that conflict with the project's `strict: true` tsconfig (e.g., implicit `any` in return types, or `collections` field typed differently than expected).

**Mitigation:** The smoke check only accesses `result.collections.length`. This is a safe, minimal surface. If TypeScript complains about the return type, the implementer should check `QdrantClient`'s type declarations for `getCollections()` and type the result explicitly.

---

### LOW — Named Docker volume persisting stale data across collection schema changes

**Risk:** In Phase 3, when collection schemas are defined, stale volume data from earlier dev sessions could cause unexpected behavior.

**Mitigation:** Not a concern for this phase. Noted for future reference: `docker compose down -v` removes the named volume if a clean slate is needed.

---

### LOW — `apiKey: undefined` vs. omitting `apiKey`

**Risk:** Passing `apiKey: undefined` explicitly to the `QdrantClient` constructor may differ in behavior from omitting the field, depending on how the SDK handles it internally.

**Mitigation:** Use the conditional spread pattern in step 5 to avoid passing `undefined`.

---

## Testing Strategy

### Unit test: `src/services/qdrant-config.service.spec.ts`

- Uses `@nestjs/testing` `Test.createTestingModule`
- `ConfigService` is provided via `useValue` with `jest.fn()` mocks for `get` and `getOrThrow`
- No live Qdrant, no network calls
- Assertions: correct config keys are read, correct values are returned, `getOrThrow` is called for required `url`, `get` is called for optional `apiKey`

Pattern to follow: `src/services/origin-allowlist.service.spec.ts` — it shows the exact `buildMockConfigService` pattern with `jest.fn().mockReturnValue(...)` for `ConfigService`.

### Unit test: `src/providers/qdrant.provider.spec.ts`

- Uses `jest.mock('@qdrant/js-client-rest')` to replace the SDK module
- Tests the `useFactory` function directly (not via NestJS testing module — the factory is a plain function)
- `QdrantConfigService` is provided as a plain mock object `{ url: 'http://localhost:6333', apiKey: undefined }`
- `Logger.log` and `Logger.warn` are spied on via `jest.spyOn`
- Two describe blocks: `on successful getCollections()` and `when getCollections() rejects`
- Critical assertion in failure branch: `await expect(QdrantProvider.useFactory(mockConfig)).resolves.toBeDefined()` — confirms no throw

No live Qdrant is required for any test. No integration tests are planned for this phase.

### Regression areas to re-test manually

- `npm run build` — TypeScript compilation must be clean
- `npm test` — all existing specs must continue to pass (no regressions from schema changes)
- `npm run start:dev` with Qdrant running (via `docker compose up -d`) — log line `Qdrant connected [url=http://localhost:6333 collectionCount=0]`
- `npm run start:dev` without Qdrant running — log line `Qdrant unreachable [url=http://localhost:6333 error=...]`, app continues to start

---

## Out-of-Scope Confirmations

The following will NOT be done in this phase:

- No `client.createCollection()` calls anywhere
- No `client.upsert()` or any document ingestion
- No `client.search()` or any retrieval
- No `QdrantModule` — the provider is registered directly in `AppModule.providers`, matching the DynamoDB pattern
- No Qdrant calls from any controller, tool, agent, or service other than the provider factory's smoke check
- No collection schema definitions
- No Voyage embedding integration (that is Phase 2, running in parallel)
- No production Qdrant Cloud configuration (only the env-var interface is established here)
- No integration or e2e tests requiring a live Qdrant instance
