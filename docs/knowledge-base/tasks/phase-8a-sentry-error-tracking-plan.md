# Phase 8a — Sentry Error Tracking: Implementation Plan

## Overview

This plan adds `@sentry/nestjs` as the error-tracking backbone for the application. Sentry is initialized at the very top of `src/main.ts` (via a dedicated `src/instrument.ts` file imported before `NestFactory`) when `SENTRY_DSN` is present; it is a no-op when absent. All Sentry SDK calls are channeled through a project-controlled `SentryService` wrapper — making the SDK swappable and testable. A `SentryConfigService` exposes config values using the same typed-getter pattern as `AnthropicConfigService` and `DatabaseConfigService`. Manual `captureException` calls are added to every catch block in the Knowledge Base feature (VoyageService, KnowledgeBaseIngestionService, KnowledgeBaseEnrichmentService, KnowledgeBaseIngestionProcessor, QdrantProvider). PII is stripped via a `beforeSend` callback before any event reaches Sentry. `BadRequestException` is suppressed centrally in `beforeSend`. All existing log lines are preserved; Sentry capture is purely additive.

---

## Sentry SDK Verification Findings

**Source URLs consulted:**
- https://docs.sentry.io/platforms/javascript/guides/nestjs/
- https://github.com/getsentry/sentry-javascript/blob/develop/packages/nestjs/README.md
- https://docs.sentry.io/platforms/javascript/guides/nestjs/configuration/filtering/
- https://docs.sentry.io/platforms/javascript/enriching-events/scopes/
- https://registry.npmjs.org/@sentry/nestjs/latest

**Confirmed findings:**

### Package and version
```
@sentry/nestjs@10.50.0
```
Peer dependencies: `@nestjs/common ^8 || ^9 || ^10 || ^11` and `@nestjs/core` same range. This project uses NestJS 11 — fully supported.

### Initialization pattern
Sentry's NestJS docs require an `instrument.ts` file that calls `Sentry.init()`, which is then imported as the **first import** in `main.ts` — before `NestFactory` and before `AppModule`. This satisfies the "must be first" requirement that would otherwise be hard to guarantee with a top-of-function call when TypeScript hoists module-level imports.

```typescript
// src/instrument.ts
import * as Sentry from "@sentry/nestjs";
Sentry.init({ dsn, environment, release, tracesSampleRate: 0, beforeSend });
```

```typescript
// src/main.ts — first line
import "./instrument";
// then NestFactory, AppModule, etc.
```

### SentryModule and global exception filter
`SentryModule.forRoot()` must be added to `AppModule.imports`. It enables the automatic instrumentation that powers unhandled-exception capture from NestJS context.

`SentryGlobalFilter` is **not automatically applied** — it must be explicitly registered as an `APP_FILTER` provider in `AppModule`, placed **before** any other exception filters. Since this project has no existing global catch-all exception filter, `SentryGlobalFilter` is the right choice.

### `beforeSend` callback signature
```typescript
beforeSend(event: Sentry.Event, hint: Sentry.EventHint): Sentry.Event | null
```
- Return `null` to drop the event entirely (no send to Sentry).
- Return the (optionally mutated) `event` to allow it through.
- `hint.originalException` holds the original thrown value for `instanceof` checks.

### `captureException` with per-call context
Use `Sentry.withScope(callback)` to apply tags and extras to a single capture without affecting the global scope:
```typescript
Sentry.withScope((scope) => {
  scope.setTag("category", "voyage");
  scope.setTag("account_id", accountId);
  scope.setExtras({ statusCode });
  Sentry.captureException(error);
});
```
Alternatively, `Sentry.captureException(error, { tags: {...}, extra: {...} })` works as a second-argument options object — but `withScope` is the pattern the docs demonstrate for per-call isolation and is preferred.

---

## Affected Files and Modules

### Create
| File | Purpose |
|------|---------|
| `src/instrument.ts` | Sentry.init() call; the only place the SDK is initialized |
| `src/services/sentry-config.service.ts` | Typed config getters for Sentry env vars |
| `src/services/sentry.service.ts` | Wrapper service: captureException, captureMessage, addBreadcrumb |
| `src/services/sentry.service.spec.ts` | Unit tests for SentryService |

### Modify
| File | Change |
|------|--------|
| `src/main.ts` | Add `import "./instrument"` as the very first line |
| `src/app.module.ts` | Add `SentryModule.forRoot()` to imports; add `SentryGlobalFilter` as APP_FILTER; register `SentryConfigService` and `SentryService` as providers |
| `src/config/configuration.ts` | Add `sentry` key with dsn, environment, release, tracesSampleRate |
| `src/config/env.schema.ts` | Add four optional Sentry env var fields |
| `.env.local` | Append commented-out Sentry vars (no real DSN) |
| `src/services/voyage.service.ts` | Add sentryService.captureException() in the catch block |
| `src/services/knowledge-base-ingestion.service.ts` | Add sentryService.captureException() in six catch blocks |
| `src/services/knowledge-base-enrichment.service.ts` | Add sentryService.captureException() in the enrichChunk catch block |
| `src/processors/knowledge-base-ingestion.processor.ts` | Add sentryService.captureException() in the process() catch (non-BadRequest path only) |
| `src/providers/qdrant.provider.ts` | Inject SentryService; add sentryService.captureException() in the startup smoke-check catch |

### Review Only (no change)
- `src/services/anthropic-config.service.ts` — pattern reference for SentryConfigService
- `src/services/database-config.service.ts` — pattern reference for SentryConfigService
- `src/services/voyage-config.service.ts` — pattern reference

---

## Dependencies and Architectural Considerations

- **New npm dependency:** `@sentry/nestjs@10.50.0` (pin exactly, not `^`).
- **No new peer dependencies** beyond what NestJS 11 already provides.
- **`SentryModule` import path:** `@sentry/nestjs/setup` — this is a separate entrypoint from `@sentry/nestjs`; confirmed from the README.
- **`SentryGlobalFilter` import path:** `@sentry/nestjs/setup` — same subpackage.
- **`Sentry.init()` import path:** `@sentry/nestjs` — the main package export.
- **`SentryConfigService` cannot be injected into `instrument.ts`** — because `instrument.ts` runs before the NestJS DI container exists. The instrument file reads `process.env` directly. `SentryConfigService` is still created for use elsewhere (e.g., a health check or future introspection), but is not involved in init.
- **`SentryService` injection into `QdrantProvider`:** providers defined via `useFactory` receive their injected values as factory arguments. `SentryService` must be added to the `inject` array of `QdrantProvider` and as a parameter to `useFactory`.
- **No circular dependencies** — `SentryService` depends only on `SentryConfigService`; `SentryConfigService` depends only on `ConfigService`. Neither depends on KB services.
- **Configuration:** four new env vars, all optional.
- **Backward compatibility:** no schema changes, no API surface changes. The change is entirely additive.

---

## SentryConfigService Design

Mirror `AnthropicConfigService` / `DatabaseConfigService` exactly: injectable class, `ConfigService` in constructor, typed getters using `get()` for optional values and `getOrThrow()` for required ones. Since all Sentry config is optional (no DSN = no-op), every getter uses `get()`.

```
src/services/sentry-config.service.ts
```

Getters:
- `get dsn(): string | undefined` — reads `"sentry.dsn"`
- `get environment(): string` — reads `"sentry.environment"`, falls back to `"local"`
- `get release(): string | undefined` — reads `"sentry.release"`
- `get tracesSampleRate(): number` — reads `"sentry.tracesSampleRate"`, falls back to `0`

The `instrument.ts` file does NOT use this service — it reads `process.env` directly (the DI container does not yet exist at that point). `SentryConfigService` is provided in `AppModule` for any future use (introspection, logging at startup, etc.).

---

## SentryService Design

```
src/services/sentry.service.ts
```

### Constructor pattern
`SentryService` does NOT call `Sentry.init()`. Initialization happens in `instrument.ts`. `SentryService` wraps SDK calls only.

### No-op detection
At construction time, inspect whether `Sentry.isInitialized()` (the SDK function that returns true after `Sentry.init()` has run). Store as a private readonly boolean `isDsnConfigured`. All methods gate on this flag.

Alternatively, `SentryConfigService.dsn` can be checked: if falsy, no-op. Using `Sentry.isInitialized()` is more reliable since it ties directly to the actual SDK state.

### Public API

```typescript
captureException(
  error: unknown,
  context?: {
    tags?: Record<string, string>;
    extras?: Record<string, unknown>;
  }
): void
```
- No-ops when `!isDsnConfigured`.
- Calls `Sentry.withScope((scope) => { /* apply tags/extras */; Sentry.captureException(error); })`.
- Wrapped in a try/catch — if the SDK itself throws, log a warn and continue. Never re-throws. Fire-and-forget.

```typescript
captureMessage(
  message: string,
  level: "info" | "warning" | "error",
  context?: {
    tags?: Record<string, string>;
    extras?: Record<string, unknown>;
  }
): void
```
- No-ops when `!isDsnConfigured`.
- Calls `Sentry.withScope((scope) => { scope.setLevel(level); /* tags/extras */; Sentry.captureMessage(message); })`.
- Same try/catch guard.

```typescript
addBreadcrumb(message: string, category: string): void
```
- No-ops when `!isDsnConfigured`.
- Calls `Sentry.addBreadcrumb({ message, category })`.
- Same try/catch guard.

### Logger
`SentryService` has its own `private readonly logger = new Logger(SentryService.name)`. Used only for the internal "SDK call threw" warning case.

---

## `instrument.ts` Design

```
src/instrument.ts
```

Reads `process.env` directly (DI not available). If `SENTRY_DSN` is empty or unset, calls nothing — the SDK stays uninitialized and `Sentry.isInitialized()` returns false, which makes `SentryService` no-op.

```
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.APP_ENV ?? "local",
    release: process.env.SENTRY_RELEASE,           // undefined when unset — SDK ignores it
    tracesSampleRate: 0,                           // performance tracing out of scope
    beforeSend: buildBeforeSend(),                 // see PII scrubbing section
  });
}
```

`buildBeforeSend()` is a named function defined in `instrument.ts` (or imported from a co-located helper) that returns the `beforeSend` callback. Keeping it named (not inline) makes it testable in isolation.

---

## Initialization Placement in `main.ts`

```typescript
// MUST be first — before NestFactory and before AppModule load
import "./instrument";

import { NestFactory } from "@nestjs/core";
// ... rest of existing imports
```

No other changes to `main.ts` are required. The CORS setup, port binding, and `OriginAllowlistService` usage remain unchanged.

---

## `beforeSend` PII Scrubbing — Exact Algorithm

The `buildBeforeSend()` function returns a `(event, hint) => Event | null` callback. It performs two jobs: (1) filter out `BadRequestException`-class errors, (2) scrub PII keys from the event.

### Step 1: BadRequestException filter

```
function buildBeforeSend(): (event, hint) => Event | null {
  return (event, hint) => {
    // 1. Drop validation-class errors entirely.
    const originalException = hint?.originalException;
    if (originalException instanceof BadRequestException) {
      return null;
    }

    // 2. Scrub PII from the event in place.
    scrubEvent(event);

    return event;
  };
}
```

**Why `beforeSend` for `BadRequestException` filtering rather than per-call-site guards:**

Centralizing this in `beforeSend` means it catches `BadRequestException` from ALL code paths — both explicit `captureException` calls in services AND the auto-captured exceptions from `SentryGlobalFilter`. Per-call-site `if (error instanceof BadRequestException) return;` guards would only protect the manual capture points; a `BadRequestException` bubbling up through an unhandled path would still reach Sentry via the global filter. `beforeSend` is the only location that intercepts both paths.

The `instanceof BadRequestException` check in `instrument.ts` requires importing `BadRequestException` from `@nestjs/common`. This is acceptable — `instrument.ts` is a module that runs in the NestJS process where `@nestjs/common` is always available. The import does not create a circular dependency.

### Step 2: PII scrub algorithm

PII keys to remove from any level of the event object tree:

```
const PII_KEYS = new Set([
  "text",
  "message",
  "chunk_text",
  "enrichment",
  "email",
  "phone",
  "firstName",
  "lastName",
]);
```

**Algorithm (pseudocode):**

```
function scrubValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(scrubValue);
  }
  if (value !== null && typeof value === "object") {
    return scrubObject(value as Record<string, unknown>);
  }
  return value;
}

function scrubObject(obj: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(obj)) {
    if (PII_KEYS.has(key)) {
      obj[key] = "[Filtered]";     // redact, do not delete, preserves key presence for debugging
    } else {
      obj[key] = scrubValue(obj[key]);
    }
  }
  return obj;
}

function scrubEvent(event: Sentry.Event): void {
  // Walk the parts of the event that can carry user-supplied data.
  if (event.extra) {
    scrubObject(event.extra as Record<string, unknown>);
  }
  if (event.contexts) {
    scrubValue(event.contexts);
  }
  if (event.request?.data) {
    scrubValue(event.request.data);
  }
  if (event.breadcrumbs?.values) {
    for (const breadcrumb of event.breadcrumbs.values) {
      if (breadcrumb.data) {
        scrubObject(breadcrumb.data);
      }
      // message field on breadcrumbs: scrub only if it's a PII key scenario
      // Breadcrumb messages are developer-written strings, not user content — do not scrub.
    }
  }
}
```

**Mutation vs. deletion:** Replace PII values with the string `"[Filtered]"` rather than `delete`-ing the key. This preserves the key's presence in the Sentry event (making it obvious PII was there and was removed), and avoids subtle bugs where deletion of required fields breaks the event schema.

**Note on `message` key collision:** The `message` PII key targets `event.extra.message` and similar nested fields that would hold chat message content. The top-level `event.message` field (the Sentry event message, set by `captureMessage()`) is NOT a plain `message` key in `extra`/`contexts` — the walk starts from `event.extra`, `event.contexts`, etc., so the top-level event message is never touched.

---

## Module Registration

Changes to `src/app.module.ts`:

### Imports array — add:
```typescript
import { SentryModule } from "@sentry/nestjs/setup";
// Add to @Module imports:
SentryModule.forRoot(),
```

### Providers array — add:
```typescript
import { APP_FILTER } from "@nestjs/core";
import { SentryGlobalFilter } from "@sentry/nestjs/setup";
import { SentryConfigService } from "./services/sentry-config.service";
import { SentryService } from "./services/sentry.service";

// Add to providers (SentryGlobalFilter FIRST, before any other exception filters):
{
  provide: APP_FILTER,
  useClass: SentryGlobalFilter,
},
SentryConfigService,
SentryService,
```

**Important ordering:** The `APP_FILTER` entry for `SentryGlobalFilter` must appear first in the providers array relative to any other `APP_FILTER` entries. This project currently has no global exception filter, so position within the providers array is not critical — but place it first as a forward-compatible convention.

---

## Configuration Changes

### `src/config/configuration.ts` — add `sentry` key:
```typescript
sentry: {
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT ?? process.env.APP_ENV ?? "local",
  release: process.env.SENTRY_RELEASE,
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
},
```

### `src/config/env.schema.ts` — add four optional fields to the Zod schema:
```typescript
SENTRY_DSN: z.string().url().optional(),
SENTRY_ENVIRONMENT: z.string().optional(),
SENTRY_RELEASE: z.string().optional(),
SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).optional(),
```

### `.env.local` — append commented block:
```
# Sentry (optional — leave unset for local dev; Sentry is a no-op when DSN is absent)
# SENTRY_DSN=
# SENTRY_ENVIRONMENT=local
# SENTRY_RELEASE=
# SENTRY_TRACES_SAMPLE_RATE=0
```

---

## Per-Catch-Block Manual Capture Additions

For every catch block below, the pattern is: keep all existing log lines exactly as-is, then add the `this.sentryService.captureException(...)` call immediately after the logger call and before any `throw`.

All services listed receive `SentryService` injected via constructor DI. `QdrantProvider` receives it via factory injection.

### Tagging reference
| Catch block location | `category` tag | Additional tags when in scope |
|---|---|---|
| VoyageService | `"voyage"` | — (no account context at this layer) |
| ingestion service — writePendingRecord | `"ingestion-service"` | `account_id`, `document_id` |
| ingestion service — updateDocumentStatus | `"ingestion-service"` | `account_id`, `document_id` |
| ingestion service — lookupExistingDocument | `"ingestion-service"` | `account_id` |
| ingestion service — deleteQdrantPoints | `"qdrant"` | `account_id`, `document_id` |
| ingestion service — ensureCollection (check) | `"qdrant"` | — |
| ingestion service — ensureCollection (create) | `"qdrant"` | — |
| ingestion service — writeQdrantPoints | `"qdrant"` | `document_id` |
| ingestion service — writeDynamoRecord | `"ingestion-service"` | `document_id` |
| ingestion service — deleteDocument DDB delete | `"ingestion-service"` | `account_id`, `document_id` |
| enrichment service — enrichChunk | `"enrichment"` | `chunk_index` as extra |
| ingestion processor — process() catch | `"ingestion-processor"` | `account_id`, `document_id` |
| qdrant provider — startup smoke check | `"qdrant-startup"` | — |

---

### `src/services/voyage.service.ts`

Constructor DI addition:
```
constructor(
  private readonly voyageConfig: VoyageConfigService,
  private readonly sentryService: SentryService,   // ADD
) { ... }
```

Catch block (the single catch inside `embedTexts`):
```diff
  } catch (error) {
    if (error instanceof VoyageAIError) {
      const statusCode = error.statusCode ?? "unknown";
      this.logger.error(`Voyage API error [statusCode=${statusCode}]`);
+     this.sentryService.captureException(error, {
+       tags: { category: "voyage" },
+       extras: { statusCode },
+     });
      if (error.statusCode === 401) {
        throw new Error("Voyage API authentication failed — check VOYAGE_API_KEY");
      }
      if (error.statusCode === 429) {
        throw new Error("Voyage API rate limit exceeded");
      }
      throw new Error(`Voyage API call failed with status ${statusCode}`);
    }
    const errorName = error instanceof Error ? error.name : "UnknownError";
    this.logger.error(`Voyage call failed [errorType=${errorName}]`);
+   this.sentryService.captureException(error, {
+     tags: { category: "voyage" },
+   });
    throw new Error("Voyage API call failed due to a network or unknown error");
  }
```

Note: two capture calls — one inside the `VoyageAIError` branch, one in the fallthrough branch. Each is followed by a `throw`, so both paths report before rethrowing.

---

### `src/services/knowledge-base-enrichment.service.ts`

Constructor DI addition:
```
constructor(
  private readonly anthropicConfig: AnthropicConfigService,
  private readonly sentryService: SentryService,   // ADD
) { ... }
```

Catch block in `enrichChunk`:

The brief requires capturing each per-chunk failure with `chunk_failure_kind` tag. The three failure kinds:
- API call throws: `chunk_failure_kind=anthropic_error`
- Content block type wrong: `chunk_failure_kind=empty_response` (returned null via logger.warn, no throw — not a catch block; see note below)
- Missing sections: `chunk_failure_kind=parse_failure` (same — returned null via logger.warn, no throw)

The two non-exception paths (unexpected block type, missing sections) are currently `return null` branches inside the try block — they have no `error` object to pass to `captureException`. For these, use `captureMessage()` with `level: "warning"`:

```diff
  // Inside try block, unexpected block type branch:
  if (!block || block.type !== "text") {
    this.logger.warn(
      `Enrichment parse failure — unexpected content block type [chunkIndex=${chunkIndex} errorType=UnexpectedBlockType]`,
    );
+   this.sentryService.captureMessage(
+     `Enrichment parse failure — unexpected content block type`,
+     "warning",
+     { tags: { category: "enrichment", chunk_failure_kind: "empty_response" } },
+   );
    return null;
  }

  // Inside try block, missing sections branch:
  if (!rawText.includes("SUMMARY:") || ...) {
    this.logger.warn(
      `Enrichment parse failure — missing required sections [chunkIndex=${chunkIndex} errorType=ParseFailure]`,
    );
+   this.sentryService.captureMessage(
+     `Enrichment parse failure — missing required sections`,
+     "warning",
+     { tags: { category: "enrichment", chunk_failure_kind: "parse_failure" } },
+   );
    return null;
  }
```

```diff
  // Catch block (API call threw):
  } catch (error) {
    let errorType = error instanceof Error ? error.name : "UnknownError";
    if (error instanceof Anthropic.APIError) {
      errorType = `${error.constructor.name}(status=${error.status})`;
    }
    this.logger.warn(
      `Enrichment API call failed [chunkIndex=${chunkIndex} errorType=${errorType}]`,
    );
+   this.sentryService.captureException(error, {
+     tags: { category: "enrichment", chunk_failure_kind: "anthropic_error" },
+     extras: { chunkIndex },
+   });
    return null;
  }
```

---

### `src/services/knowledge-base-ingestion.service.ts`

Constructor DI addition:
```
constructor(
  @Inject(QDRANT_CLIENT) private readonly qdrantClient: QdrantClient,
  @Inject(DYNAMO_DB_CLIENT) private readonly dynamoDb: DynamoDBDocumentClient,
  private readonly voyageService: VoyageService,
  private readonly enrichmentService: KnowledgeBaseEnrichmentService,
  private readonly databaseConfig: DatabaseConfigService,
  private readonly sentryService: SentryService,   // ADD
) {}
```

**`writePendingRecord` catch:**
```diff
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    this.logger.error(
      `[errorType=${errorName} documentId=${documentId} accountId=${accountId}] Failed to write pending DynamoDB record`,
    );
+   this.sentryService.captureException(error, {
+     tags: { category: "ingestion-service", account_id: accountId, document_id: documentId },
+   });
    throw new InternalServerErrorException("Failed to record document metadata.");
  }
```

**`updateDocumentStatus` catch:**
```diff
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    this.logger.error(
      `[errorType=${errorName} accountId=${accountId} documentId=${documentId} status=${status}] Failed to update document status`,
    );
+   this.sentryService.captureException(error, {
+     tags: { category: "ingestion-service", account_id: accountId, document_id: documentId },
+   });
    throw new InternalServerErrorException("Failed to update document status.");
  }
```

**`lookupExistingDocument` catch:**
```diff
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    this.logger.error(
      `[errorType=${errorName} accountId=${accountId} externalId=${externalId}] Failed to query DynamoDB for existing document`,
    );
+   this.sentryService.captureException(error, {
+     tags: { category: "ingestion-service", account_id: accountId },
+   });
    throw new InternalServerErrorException("Knowledge base storage is temporarily unavailable.");
  }
```

**`deleteQdrantPoints` catch:**
```diff
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    this.logger.error(
      `[errorType=${errorName} accountId=${accountId} documentId=${documentId}] Failed to delete Qdrant points`,
    );
+   this.sentryService.captureException(error, {
+     tags: { category: "qdrant", account_id: accountId, document_id: documentId },
+   });
    throw new InternalServerErrorException("Knowledge base storage is temporarily unavailable.");
  }
```

**`ensureCollection` — collectionExists catch:**
```diff
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    this.logger.error(`[errorType=${errorName}] Failed to check Qdrant collection existence`);
+   this.sentryService.captureException(error, {
+     tags: { category: "qdrant" },
+   });
    throw new InternalServerErrorException("Knowledge base storage is temporarily unavailable.");
  }
```

**`ensureCollection` — createCollection catch:**
```diff
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("already exists")) {
      return;
    }
    const errorName = error instanceof Error ? error.name : "UnknownError";
    this.logger.error(`[errorType=${errorName}] Failed to create Qdrant collection`);
+   this.sentryService.captureException(error, {
+     tags: { category: "qdrant" },
+   });
    throw new InternalServerErrorException("Knowledge base storage is temporarily unavailable.");
  }
```

Note: the `already exists` branch is a benign race condition and should NOT be captured. The capture only happens after the `message.includes("already exists")` early-return guard.

**`writeQdrantPoints` catch:**
```diff
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    this.logger.error(
      `[errorType=${errorName} documentId=${documentId}] Failed to upsert Qdrant points`,
    );
+   this.sentryService.captureException(error, {
+     tags: { category: "qdrant", document_id: documentId },
+   });
    throw new InternalServerErrorException("Knowledge base storage is temporarily unavailable.");
  }
```

**`writeDynamoRecord` catch:**
```diff
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    this.logger.error(
      `[errorType=${errorName} documentId=${documentId}] Failed to write DynamoDB document record`,
    );
+   this.sentryService.captureException(error, {
+     tags: { category: "ingestion-service", document_id: documentId },
+   });
    throw new InternalServerErrorException("Failed to record document metadata.");
  }
```

**`deleteDocument` — DDB delete catch:**
```diff
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    this.logger.error(
      `[errorType=${errorName} accountId=${input.accountId} documentId=${documentId}] Failed to delete DynamoDB document record`,
    );
+   this.sentryService.captureException(error, {
+     tags: { category: "ingestion-service", account_id: input.accountId, document_id: documentId },
+   });
    throw new InternalServerErrorException("Failed to delete document metadata.");
  }
```

---

### `src/processors/knowledge-base-ingestion.processor.ts`

Constructor DI addition:
```
constructor(
  private readonly ingestionService: KnowledgeBaseIngestionService,
  private readonly sentryService: SentryService,   // ADD
) { super(); }
```

**`process()` catch block — non-BadRequest path only:**

The `isValidationFailure` branch throws `UnrecoverableError` — this IS a `BadRequestException` (by the `instanceof` check at the top). Do NOT capture it; `beforeSend` would also filter it, but the intent is clear. The capture belongs only to the non-validation path.

```diff
  } catch (error) {
    const isValidationFailure = error instanceof BadRequestException;
    const errorName = error instanceof Error ? error.name : "UnknownError";
    const isFinalAttempt = attempt >= KB_INGESTION_RETRY_ATTEMPTS;

    this.logger.error(
      `[documentId=${documentId} accountId=${accountId} errorType=${errorName} attempt=${attempt} isFinalAttempt=${isFinalAttempt}] Job failed`,
    );

    if (isValidationFailure) {
      await this.ingestionService.updateDocumentStatus(accountId, documentId, "failed", ERROR_SUMMARY_VALIDATION);
      throw new UnrecoverableError(ERROR_SUMMARY_VALIDATION);
    }

+   // Capture non-validation failures to Sentry. Only report on final attempt
+   // to avoid N duplicate reports for one job failure across retry attempts.
+   if (isFinalAttempt) {
+     this.sentryService.captureException(error, {
+       tags: { category: "ingestion-processor", account_id: accountId, document_id: documentId },
+       extras: { attempt, jobId: job.id },
+     });
      await this.ingestionService.updateDocumentStatus(accountId, documentId, "failed", ERROR_SUMMARY_GENERIC);
    }

    throw error;
  }
```

**Design note — capture on final attempt only:** Capturing on every attempt would produce up to `KB_INGESTION_RETRY_ATTEMPTS` duplicate events per job failure in Sentry. A single capture on the final attempt cleanly represents the definitive outcome. The `attempt` and `jobId` extras give enough context for triage.

**`onFailed` handler:** This is an `@OnWorkerEvent("failed")` callback fired after BullMQ exhausts retries. It is an informational log-only handler. Do NOT add a capture here — the final-attempt capture in `process()` already covers it. A second capture here would produce a duplicate.

---

### `src/providers/qdrant.provider.ts`

The `QdrantProvider` uses `useFactory`, not a class constructor. `SentryService` must be added to the factory's `inject` array and as a parameter.

```diff
  export const QdrantProvider = {
    provide: QDRANT_CLIENT,
    useFactory: async (
      config: QdrantConfigService,
+     sentryService: SentryService,   // ADD
    ): Promise<QdrantClient> => {
      const client = new QdrantClient({ ... });

      try {
        const result = await client.getCollections();
        Logger.log(
          `Qdrant connected [url=${config.url} collectionCount=${result.collections.length}]`,
          "QdrantProvider",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        Logger.warn(
          `Qdrant unreachable [url=${config.url} error=${message}]`,
          "QdrantProvider",
        );
+       sentryService.captureException(error, {
+         tags: { category: "qdrant-startup" },
+       });
      }

      return client;
    },
-   inject: [QdrantConfigService],
+   inject: [QdrantConfigService, SentryService],
  };
```

**Important:** `SentryService` must be registered in `AppModule` providers BEFORE `QdrantProvider` is resolved. Since both are registered in the same `AppModule`, NestJS resolves the injection graph correctly. No ordering concern — NestJS DI handles it.

**Critical consideration:** `QdrantProvider` is a startup provider. If `SentryService` is not yet initialized when Qdrant boots, the DI would fail. But because `SentryService` depends only on `SentryConfigService` (which depends on `ConfigService`, which is global), and `ConfigModule.forRoot` is the first import in `AppModule`, this resolves correctly.

---

## Step-by-Step Implementation Order

```
1. [npm] Install @sentry/nestjs@10.50.0
   - Why first: all downstream files import from it; TypeScript compilation requires the types
   - Done when: package.json has the pinned dependency; node_modules/@sentry/nestjs/ exists

2. [src/config/env.schema.ts] Add four Sentry env var fields to the Zod schema
   - Why here: validation runs at boot; schema must exist before configuration.ts is read
   - Done when: schema compiles cleanly; no validation error on boot without Sentry vars set

3. [src/config/configuration.ts] Add the sentry configuration key
   - Why here: SentryConfigService reads from this namespace
   - Done when: TypeScript compiles; sentry.dsn resolves to undefined when env var is absent

4. [src/services/sentry-config.service.ts] Create SentryConfigService
   - Why here: SentryService depends on it; must exist before SentryService
   - Done when: file compiles; getters return expected values given mock ConfigService

5. [src/instrument.ts] Create the Sentry.init() bootstrapper with buildBeforeSend()
   - Why here: must exist before main.ts is modified
   - Done when: file compiles; Sentry.init() is only called when SENTRY_DSN is set

6. [src/main.ts] Add import "./instrument" as the first line
   - Why here: ensures Sentry.init() fires before NestFactory.create resolves modules
   - Done when: app boots without error; Sentry.isInitialized() returns false when DSN is absent

7. [src/services/sentry.service.ts] Create SentryService
   - Why here: depends on types from @sentry/nestjs (step 1) and SentryConfigService (step 4)
   - Done when: service compiles; all three public methods are implemented; no-op when DSN absent

8. [src/app.module.ts] Register SentryModule.forRoot(), SentryGlobalFilter APP_FILTER, SentryConfigService, SentryService
   - Why here: DI graph must know about these before any provider that injects SentryService
   - Done when: app compiles and boots; Sentry global filter appears in NestJS filter chain

9. [src/providers/qdrant.provider.ts] Inject SentryService; add capture to startup catch
   - Why here: QdrantProvider is resolved during AppModule bootstrap; SentryService must be in the DI graph first (step 8)
   - Done when: provider resolves; startup warn still logs; captureException called on error

10. [src/services/voyage.service.ts] Add SentryService injection and captures in catch block
    - Why here: no dependencies beyond SentryService being in the DI graph
    - Done when: two captureException calls present; existing logger calls preserved

11. [src/services/knowledge-base-ingestion.service.ts] Add SentryService injection and captures in all 8 catch blocks
    - Why here: service is already in the DI graph; adding a new DI arg does not change the module
    - Done when: each catch block has a captureException call with correct category tag

12. [src/services/knowledge-base-enrichment.service.ts] Add SentryService injection; add captureException in catch and captureMessage in the two warn branches
    - Why here: same as above
    - Done when: all three failure paths report to Sentry; existing logger calls preserved

13. [src/processors/knowledge-base-ingestion.processor.ts] Add SentryService injection; add capture on final-attempt non-validation path
    - Why here: same
    - Done when: capture only fires on isFinalAttempt && !isValidationFailure

14. [.env.local] Append commented Sentry env var block
    - Why last: documentation; no code depends on it
    - Done when: four commented vars present; no real DSN committed

15. [src/services/sentry.service.spec.ts] Write unit tests
    - Why last: tests describe the behaviour of the completed implementation
    - Done when: all test cases pass without a real Sentry DSN
```

---

## Testing Strategy

### Unit tests: `src/services/sentry.service.spec.ts`

Mock `@sentry/nestjs` at the module level using Jest's `jest.mock()`:

```typescript
jest.mock("@sentry/nestjs", () => ({
  isInitialized: jest.fn(),
  withScope: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
}));
```

Test cases (target: ~12 tests):

**No-op behavior (DSN absent):**
- `captureException` does not call `Sentry.withScope` when `isInitialized()` returns false
- `captureMessage` does not call `Sentry.withScope` when `isInitialized()` returns false
- `addBreadcrumb` does not call `Sentry.addBreadcrumb` when `isInitialized()` returns false

**Active behavior (DSN present):**
- `captureException` calls `Sentry.withScope`; the scope callback sets the given tags; `Sentry.captureException` is called with the error
- `captureException` with no context arg does not throw
- `captureMessage` calls `Sentry.withScope`; scope sets level; `Sentry.captureMessage` called with the message
- `addBreadcrumb` calls `Sentry.addBreadcrumb` with message and category

**Safety:**
- `captureException` does not re-throw when `Sentry.withScope` itself throws (internal SDK error simulation)
- `captureMessage` does not re-throw when SDK throws

### `beforeSend` PII scrubbing tests

Because `buildBeforeSend` is a named exported function from `src/instrument.ts`, it can be unit-tested without instantiating Sentry at all:

```typescript
import { buildBeforeSend } from "../instrument"; // exported for testing
const beforeSend = buildBeforeSend();
```

Test cases (~8 tests):
- Returns `null` when `hint.originalException` is a `BadRequestException` instance
- Does NOT return `null` for a generic `Error`
- Scrubs `event.extra.message` → `"[Filtered]"`
- Scrubs `event.extra.text` → `"[Filtered]"`
- Scrubs `event.extra.chunk_text` → `"[Filtered]"`
- Scrubs `event.extra.email`, `phone`, `firstName`, `lastName`
- Does NOT scrub `event.extra.account_id`, `document_id`, `external_id`, `chunk_index`, `errorType`, `statusCode`
- Scrubs PII keys nested inside `event.contexts` (recursive walk verification)
- Returns the (mutated) event when no filter condition matches

### Existing service tests update requirement
`VoyageService`, `KnowledgeBaseIngestionService`, `KnowledgeBaseEnrichmentService`, and `KnowledgeBaseIngestionProcessor` specs must have `SentryService` provided as a mock in their `Test.createTestingModule` setup. The simplest mock: `{ provide: SentryService, useValue: { captureException: jest.fn(), captureMessage: jest.fn(), addBreadcrumb: jest.fn() } }`.

None of the existing test assertions break — the capture calls are additive and the mock swallows them silently.

---

## Risks and Edge Cases

**High — `beforeSend` itself throws:**
If `scrubEvent()` or the `BadRequestException` instanceof check throws, Sentry swallows the exception and drops the event silently. Mitigation: wrap the entire `beforeSend` body in a try/catch that returns the original (unscrubbed) event on failure and logs a warning — this is the "fail open" strategy (event is sent, possibly with PII) which is preferable to silently losing all events. Alternatively, fail closed (return null) and always log. Document the choice clearly; recommend fail-open with an internal Logger.warn.

**High — `instrument.ts` import is accidentally reordered:**
If a future developer or auto-formatter reorders imports in `main.ts` so that `"./instrument"` is no longer first, Sentry will be initialized after NestJS modules, potentially missing early exception contexts. Mitigation: add a comment above the import: `// MUST remain the first import — Sentry requires initialization before any other module loads.`

**Medium — Sentry rate limiting:**
The per-chunk enrichment path captures every failure. At sustained enrichment volume with Anthropic instability, this could generate a burst of events. Sentry's default rate limit is 5,000 events per minute (plan-dependent). Mitigation: the brief accepts this risk for now and explicitly notes that sampling can be added later if volume becomes an issue. The capture is correct behavior.

**Medium — `QdrantProvider` startup capture fires on every restart when Qdrant is down:**
In a rolling deploy or crash-loop scenario, every instance restart would fire a Sentry event if Qdrant is unreachable. Mitigation: this is the correct behavior (it's an operator-visible outage). The `beforeSend` filter does not affect it. If alert fatigue becomes an issue, Phase 8b's rate-limiting on Slack escalation handles it there.

**Medium — `account_id` tag contains a raw ULID value:**
Sentry tag values that look like random strings do not group naturally. This is acceptable — the grouping is by `document_id` or `error type`, and `account_id` is used for filtering within a tenant. No mitigation needed; by design.

**Low — `beforeSend` import of `BadRequestException` from `@nestjs/common` in `instrument.ts`:**
This creates a NestJS dependency in a file that runs before the NestJS app is created. The import is a type import resolved at module load time (not at runtime DI), so it is safe. `@nestjs/common` is always in `node_modules`. No issue.

**Low — `Sentry.isInitialized()` availability:**
Confirmed present in `@sentry/nestjs` (which re-exports the full `@sentry/core` surface). If a future major version removes it, `SentryService` falls back to checking `SentryConfigService.dsn` truthy. Document both options in the service file.

**Low — `SentryGlobalFilter` captures `InternalServerErrorException`:**
The KB services throw `InternalServerErrorException` in catch blocks, then also call `captureException` immediately before throwing. This means a single KB failure generates TWO Sentry events: one from the manual capture (with rich tags) and one from the global filter catching the rethrown `InternalServerErrorException` (with less context). Mitigation: the manual capture is the authoritative one. The global-filter duplicate is noise but not harmful. To suppress it, the implementer could add `InternalServerErrorException` to the `beforeSend` filter — but the brief does not call this out, and the duplicates are useful as a fallback. Leave as-is for now; flag for the user.

---

## Out-of-Scope Confirmations

The following are explicitly deferred and must NOT appear in the implementation:
- Slack alerting (Phase 8b)
- Performance tracing (`tracesSampleRate` set to 0 always)
- `Sentry.setUser()` — no user identification
- Source map upload — CI/build concern
- Manual captures outside KB feature code paths
- Sentry dashboard, alert rules, or project setup
- `@sentry/profiling-node` — not needed; no profiling
