# Phase 8c — Internal-API Authentication: Implementation Plan

---

## Overview

This phase locks down the `/knowledge-base/*` HTTP surface by adding a shared-secret guard that every server-to-server request must pass. A new `InternalApiKeyGuard` implements NestJS's `CanActivate` interface and performs constant-time comparison of the `X-Internal-API-Key` request header against the value of the `KB_INTERNAL_API_KEY` environment variable using `crypto.timingSafeEqual`. The guard is injected with a new `InternalApiAuthConfigService` that follows the existing typed-getter config service pattern exactly. `KB_INTERNAL_API_KEY` is added to `env.schema.ts` as a required field with `min(32)` validation so the app refuses to boot when it is absent or too short. The guard is applied at the controller class level — not the method level — on the single existing `/knowledge-base/*` controller (`KnowledgeBaseController`). The existing Sentry `beforeSend` scrubber in `src/instrument.ts` is extended to redact the `x-internal-api-key` header from any captured event's request context. All existing controller-level tests for `KnowledgeBaseController` are updated to provide the guard's mock in the testing module and to include at least one test verifying that requests without the header return 401. No middleware changes are required — there is no request-logging middleware that logs full headers.

---

## NestJS Guard Verification Findings

**NestJS version in use:** `@nestjs/common ^11.0.1` (package.json line 29). NestJS 11 guard semantics are identical to v10 for this use case.

**CanActivate contract:**
```typescript
interface CanActivate {
  canActivate(context: ExecutionContext): boolean | Promise<boolean> | Observable<boolean>;
}
```
- Return `true` to allow the request through.
- Return `false` or throw an exception to block it. Throwing `UnauthorizedException` produces the standard `{ "statusCode": 401, "message": "Unauthorized" }` response body — that is the exact shape the brief requires.
- `context.switchToHttp().getRequest<Request>()` returns the underlying Express `Request` object, from which `request.headers['x-internal-api-key']` retrieves the header value as `string | string[] | undefined`. Express normalizes all header names to lowercase, so `x-internal-api-key` is the correct key regardless of how the caller capitalizes it.

**Multiple guards on one controller:** `@UseGuards(GuardA, GuardB)` on the class declaration applies both in order. NestJS short-circuits on the first falsy return or thrown exception — GuardB never runs if GuardA rejects. For v1 this is fine; future controllers can combine `InternalApiKeyGuard` with other guards by listing them in `@UseGuards(...)`.

**Controller-level vs. method-level:** `@UseGuards()` on the class applies to every handler on that controller automatically — including methods added in the future. This is the correct application site for v1.

**Sources consulted:**
- https://docs.nestjs.com/guards (official NestJS Guards documentation)

---

## Node `crypto.timingSafeEqual` Verification Findings

**Node version:** `@types/node ^22.10.7` is in devDependencies, indicating Node 22. `crypto.timingSafeEqual` semantics are unchanged across all recent Node LTS versions.

**Key facts:**
- Signature: `crypto.timingSafeEqual(a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView): boolean`
- **Throws `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` when `a.byteLength !== b.byteLength`.** The guard MUST check lengths before calling this function.
- Correct input construction: `Buffer.from(value, 'utf8')` for both the header value and the configured secret.
- Returns `true` when the buffers are identical, `false` when they differ (after performing the constant-time comparison in full regardless of early-mismatch).
- Imported from Node's built-in `crypto` module — no npm package required.

**Length check guard precedes `timingSafeEqual`:**
```
if (incoming.length !== configured.length) → reject (no comparison)
```
This matches the brief's locked contract exactly: length mismatch → `UnauthorizedException`, no `timingSafeEqual` call.

---

## Affected Files and Modules

### Create
| File | Purpose |
|------|---------|
| `src/guards/internal-api-key.guard.ts` | The reusable `InternalApiKeyGuard` implementing `CanActivate` |
| `src/guards/internal-api-key.guard.spec.ts` | Unit tests for the guard — missing header, wrong length, wrong content, correct header, timing-safe comparison is used |
| `src/services/internal-api-auth-config.service.ts` | Typed config service exposing `KB_INTERNAL_API_KEY` via `ConfigService` |
| `src/services/internal-api-auth-config.service.spec.ts` | Minimal spec confirming the getter delegates to `ConfigService` |

### Modify
| File | Change |
|------|--------|
| `src/config/env.schema.ts` | Add `KB_INTERNAL_API_KEY: z.string().min(32)` (required, no `.optional()`) |
| `src/config/configuration.ts` | Add `internalApiAuth: { key: process.env.KB_INTERNAL_API_KEY }` namespace |
| `src/instrument.ts` | Extend `scrubEvent()` to redact `x-internal-api-key` from `event.request.headers` |
| `src/services/sentry.service.spec.ts` | Add test confirming `x-internal-api-key` is scrubbed from event request headers via `buildBeforeSend` |
| `src/controllers/knowledge-base.controller.ts` | Add `@UseGuards(InternalApiKeyGuard)` at the class level |
| `src/controllers/knowledge-base.controller.spec.ts` | Add `InternalApiKeyGuard` mock to testing module; add one test per protected route asserting 401 when header is absent; update any existing request-based tests to include the header |
| `src/app.module.ts` | Add `InternalApiAuthConfigService` to providers; `InternalApiKeyGuard` is NOT registered as a global provider — it is `@Injectable()` and is instantiated by NestJS's DI when the controller's guard array is resolved, so it needs to be in a module's providers |
| `.env.local` | Set `KB_INTERNAL_API_KEY` to a clearly-fake but min-32-char local dev value (developer-managed file, not committed) |

### Review Only (no change)
| File | Reason |
|------|--------|
| `src/services/anthropic-config.service.ts` | Pattern reference for `InternalApiAuthConfigService` |
| `src/services/sentry-config.service.ts` | Pattern reference for `InternalApiAuthConfigService` |
| `src/controllers/web-chat.controller.ts` | Must NOT be touched — iframe-facing auth model is separate |
| `src/controllers/sendgrid-webhook.controller.ts` | Must NOT be touched — not a server-to-server KB endpoint |

---

## Dependencies and Architectural Considerations

- **No new npm packages.** `crypto` is a Node built-in. `@nestjs/common` (already a dependency) provides `CanActivate`, `ExecutionContext`, `UnauthorizedException`, `UseGuards`, `Injectable`, `Logger`.
- **Env validation uses Zod.** Confirmed in `src/config/env.schema.ts` — the project uses `zod` (not Joi). New field follows the existing Zod pattern exactly.
- **`InternalApiKeyGuard` needs to be in a providers array** so NestJS DI can resolve its constructor injection of `InternalApiAuthConfigService`. The correct location is `src/app.module.ts`. This is consistent with how `SentryGlobalFilter` and all other injectable providers are registered.
- **No middleware logs request headers.** `src/middleware/` does not exist in this codebase. `src/main.ts` has no `app.use()` calls for request logging middleware. No header redaction is needed outside of the Sentry scrubber.
- **No Swagger/OpenAPI setup exists.** No `@nestjs/swagger` in `package.json`. Swagger additions are out of scope and moot.
- **`KB_INTERNAL_API_KEY` must be set in `.env.local`** to a clearly-fake, min-32-char local dev value before the schema change is applied — otherwise the app will refuse to boot locally. The `.env.local` file is developer-managed (gitignored) and is the developer's responsibility.
- **HTTPS-only is an infrastructure assumption.** The guard does not verify TLS — that is enforced at the deployment layer (load balancer / reverse proxy). This assumption is documented in the guard source code comments.
- **Per-account isolation is unaffected.** The guard answers only "is this caller trusted?" The `account_id` field in request bodies continues to answer "which account?" — both checks are orthogonal and independently enforced.
- **Backward compatibility.** The only API surface change is that unauthenticated callers of `/knowledge-base/*` now receive 401 instead of being served. The upstream ecommerce API (the sole current caller) must be updated to send the `X-Internal-API-Key` header — this is an operations concern, not in scope for this phase, but must be communicated.

---

## `InternalApiAuthConfigService` Design

Mirror `SentryConfigService` / `AnthropicConfigService` exactly. The key getter uses `getOrThrow` because env validation guarantees presence — no `| undefined` return type is needed.

File: `src/services/internal-api-auth-config.service.ts`

```
@Injectable()
export class InternalApiAuthConfigService {
  constructor(private readonly configService: ConfigService) {}

  get key(): string {
    return this.configService.getOrThrow<string>("internalApiAuth.key", { infer: true });
  }
}
```

- Class name: `InternalApiAuthConfigService`
- Config namespace key: `"internalApiAuth.key"` (matches the `configuration.ts` addition below)
- Getter name: `key` (parallels `anthropic.apiKey` → `AnthropicConfigService.apiKey`, but here the namespace is `internalApiAuth` and the leaf is `key`)
- Return type: `string` (non-optional — validated at boot)

---

## `InternalApiKeyGuard` Design

File: `src/guards/internal-api-key.guard.ts`

```
import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { Request } from "express";
import { timingSafeEqual } from "crypto";

import { InternalApiAuthConfigService } from "../services/internal-api-auth-config.service";

const HEADER_NAME = "x-internal-api-key";

// This guard protects all server-to-server endpoints (currently: /knowledge-base/*).
// Apply it at the controller class level with @UseGuards(InternalApiKeyGuard).
// Adding a future server-to-server controller = one decorator. Replacing the secret
// model (per-partner registry, mTLS, etc.) = swap this implementation behind the
// same interface — no caller changes required.
//
// Deployment assumption: HTTPS is enforced at the infrastructure layer (load balancer /
// reverse proxy). This guard does not verify TLS — that is an infrastructure concern.
@Injectable()
export class InternalApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(InternalApiKeyGuard.name);

  constructor(private readonly config: InternalApiAuthConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const path = request.path;
    const rawHeader = request.headers[HEADER_NAME];

    // HTTP headers can be duplicated (array) — take only the first value if so.
    const incoming = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

    if (!incoming) {
      this.logger.warn(
        `[event=internal_auth_rejected reason=missing_header path=${path}]`,
      );
      throw new UnauthorizedException();
    }

    if (!this.isValidKey(incoming)) {
      this.logger.warn(
        `[event=internal_auth_rejected reason=invalid_key path=${path}]`,
      );
      throw new UnauthorizedException();
    }

    return true;
  }

  private isValidKey(incoming: string): boolean {
    const configured = this.config.key;

    const incomingBuffer = Buffer.from(incoming, "utf8");
    const configuredBuffer = Buffer.from(configured, "utf8");

    // timingSafeEqual throws when buffer lengths differ — reject early to avoid
    // the exception and to avoid leaking length information via error type.
    if (incomingBuffer.byteLength !== configuredBuffer.byteLength) {
      return false;
    }

    return timingSafeEqual(incomingBuffer, configuredBuffer);
  }
}
```

Key design points:
- `UnauthorizedException()` with no arguments produces `{ "statusCode": 401, "message": "Unauthorized" }` — identical for missing and wrong header (no enumeration hint to attackers).
- The header value never appears in any log line, error message, or thrown exception.
- `isValidKey` is a named private method — narrow, independently unit-testable with `jest.spyOn`.
- Logger is bracketed `[key=value]` format matching the codebase convention.
- Array header handling: Express can return an array when a header appears multiple times — take the first value to avoid TypeScript type confusion. The constant-time comparison still applies to that value.

---

## Env-Loader Changes

### `src/config/env.schema.ts`

Add one required field to the `.object({...})` block (alongside existing fields):

```
KB_INTERNAL_API_KEY: z.string().min(32),
```

No `.optional()`. No `.default()`. The `min(32)` validates that the secret is at least 32 characters — real secrets generated via `openssl rand -base64 48` will be 64 characters. Boot will fail with a clear validation error if absent or too short, consistent with the locked contract.

Placement: after the `SLACK_WEBHOOK_URL` line (end of the object, before `.superRefine`).

### `src/config/configuration.ts`

Add the new namespace after the `slack` key:

```typescript
internalApiAuth: {
  key: process.env.KB_INTERNAL_API_KEY,
},
```

Full block added after line 56 (`slack: { ... }`), before the closing `});`.

### `.env.local`

The developer must ensure `KB_INTERNAL_API_KEY` is set to a clearly-fake, min-32-char local dev value (e.g., `local-dev-only-replace-in-real-envs-aaaaaaaaa` — 46 characters, unambiguously not a real secret). This must be in place at the same time as the schema change, because the schema change immediately enforces the `min(32)` constraint at boot.

`.env.local` is gitignored and developer-managed; the implementer does not commit changes to it.

---

## Sentry `beforeSend` Extension — Exact Change

File: `src/instrument.ts`

The existing `scrubEvent` function currently handles `event.extra`, `event.contexts`, `event.request.data` (set to `undefined`), and `event.breadcrumbs`. The new requirement adds: redact `x-internal-api-key` from `event.request.headers`.

Current `scrubEvent` body near the `event.request` block:
```typescript
  if (event.request) {
    event.request.data = undefined;
  }
```

Replace with:
```typescript
  if (event.request) {
    event.request.data = undefined;

    // Redact the internal API key header from any captured event's request context.
    // Never let the shared secret reach Sentry, even if a future capture path
    // accidentally includes full request context.
    if (event.request.headers) {
      const headers = event.request.headers as Record<string, string>;
      if (headers["x-internal-api-key"]) {
        headers["x-internal-api-key"] = "[Filtered]";
      }
    }
  }
```

Design notes:
- `event.request.headers` is typed as `{ [key: string]: string } | undefined` in the Sentry SDK (`@sentry/types`). The cast to `Record<string, string>` is safe for read/write.
- Use `"[Filtered]"` (replace, not delete) consistent with the existing PII scrubbing convention in this file.
- The key is already normalized to lowercase by Express before Sentry captures it — `"x-internal-api-key"` (lowercase) is the correct lookup.
- This change is additive to `scrubEvent` and does not affect any other scrubbing behavior.

---

## Per-Controller Decoration Plan

There is exactly **one** controller serving `/knowledge-base/*` routes:

**`src/controllers/knowledge-base.controller.ts`** — `KnowledgeBaseController`

Routes protected (all three need the guard; it is applied at the class level so all are covered by one decoration):
- `POST /knowledge-base/documents` — `ingestDocument()`
- `GET /knowledge-base/documents` — `getDocument()`
- `DELETE /knowledge-base/documents` — `deleteDocument()`

Decoration to add at the class level (line 32, the `@Controller("knowledge-base")` line):

```typescript
@UseGuards(InternalApiKeyGuard)
@Controller("knowledge-base")
export class KnowledgeBaseController {
```

Import to add at the top of the file:
```typescript
import { UseGuards } from "@nestjs/common";
import { InternalApiKeyGuard } from "../guards/internal-api-key.guard";
```

Note: `UseGuards` is already importable from the existing `@nestjs/common` import block — add it to the destructured list rather than adding a second import statement.

**Explicitly NOT decorated (out of scope):**
- `src/controllers/web-chat.controller.ts` — iframe-facing, different auth model
- `src/controllers/sendgrid-webhook.controller.ts` — not a KB endpoint

---

## Module Registration

File: `src/app.module.ts`

Add `InternalApiAuthConfigService` to the providers array alongside the existing service registrations. Add `InternalApiKeyGuard` as well — it is `@Injectable()` and has a constructor dependency (`InternalApiAuthConfigService`), so NestJS DI must know about it.

New import lines to add at the top of `app.module.ts`:
```typescript
import { InternalApiAuthConfigService } from "./services/internal-api-auth-config.service";
import { InternalApiKeyGuard } from "./guards/internal-api-key.guard";
```

In the `providers` array, add after `SlackAlertService`:
```typescript
InternalApiAuthConfigService,
InternalApiKeyGuard,
```

No change to the `imports` array. No change to the `controllers` array.

---

## Existing Test Fixture / Mock Migration

### The problem

`KnowledgeBaseController.spec.ts` uses `Test.createTestingModule` with a partial module (only the controller, a mock ingestion service, and a mock queue). It calls controller methods directly — e.g., `controller.ingestDocument(VALID_BODY)` — bypassing NestJS's HTTP dispatch layer entirely. This means:

**The guard does not execute at all in the existing tests.** The tests call the controller method directly, not via an HTTP request through the NestJS pipeline. Adding `@UseGuards(InternalApiKeyGuard)` to the controller class does NOT cause the existing tests to start returning 401.

However, the testing module will fail to compile if `InternalApiKeyGuard` is in the controller's guard metadata but the DI container cannot resolve `InternalApiAuthConfigService`. The implementer must add the guard (and its dependency) to the testing module's providers.

### Required change to `src/controllers/knowledge-base.controller.spec.ts`

**Step 1: Add providers to the testing module.**

In the `beforeEach` where `Test.createTestingModule` is called, add two new providers:

```typescript
{
  provide: InternalApiAuthConfigService,
  useValue: { key: "test-internal-api-key-32chars-aaaaa" },
},
{
  provide: InternalApiKeyGuard,
  useValue: { canActivate: jest.fn().mockReturnValue(true) },
},
```

This stubs both the config service and the guard. The guard mock always returns `true`, so existing tests continue to exercise controller logic unaffected.

**Step 2: Add import statements at the top.**
```typescript
import { InternalApiAuthConfigService } from "../services/internal-api-auth-config.service";
import { InternalApiKeyGuard } from "../guards/internal-api-key.guard";
```

**Step 3: Add a new `describe` block that verifies the guard decoration is in place.**

Because the test module uses direct method calls (not HTTP dispatch), the only way to test "401 when header is absent" at this layer is to test the guard separately (in its own spec) and to test that the decoration metadata exists on the class. Add:

```typescript
describe("guard decoration — @UseGuards(InternalApiKeyGuard) is applied at the class level", () => {
  it("has InternalApiKeyGuard in the controller's guard metadata", () => {
    const guards: unknown[] = Reflect.getMetadata("__guards__", KnowledgeBaseController);
    expect(guards).toContain(InternalApiKeyGuard);
  });
});
```

This test verifies the decoration is in place without needing HTTP dispatch. It uses `Reflect.getMetadata` with the NestJS internal key `__guards__` — the same key used in the existing `HTTP_CODE_METADATA` decorator-metadata tests that are already in this spec.

**Note on the "one 401 test per controller" requirement from the brief:** The brief says "add at least one test per controller verifying that requests WITHOUT the header return 401." Given that this spec uses direct method calls (not `supertest`/HTTP dispatch), the most correct approach is the guard-decoration metadata test above plus the full guard unit test suite in `internal-api-key.guard.spec.ts`. The implementation plan does NOT introduce a full `supertest` HTTP integration test — that would require a much larger testing-module change (full app compilation) and is disproportionate to the risk being mitigated. The guard spec covers all rejection scenarios exhaustively. If the orchestrator disagrees, this is a design decision point — see the risks section.

---

## Step-by-Step Implementation Order

```
1. [src/config/env.schema.ts] Add KB_INTERNAL_API_KEY: z.string().min(32) to the Zod schema
   - Why first: env validation runs at boot; all downstream compilation and test runs depend
     on the schema being consistent with the env var being present
   - Done when: file compiles cleanly; validation error at boot when var is absent or < 32 chars

2. [.env.local] Ensure KB_INTERNAL_API_KEY is set to a clearly-fake 32+ char value
   - Why immediately after step 1: the schema change enforces min(32) at boot; an unset or
     short value blocks local startup. Developer-managed file (gitignored) — not part of the commit
   - Done when: value is at least 32 characters, clearly a local-dev placeholder, not a real secret

3. [src/config/configuration.ts] Add internalApiAuth: { key: process.env.KB_INTERNAL_API_KEY } namespace
   - Why here: InternalApiAuthConfigService reads from this namespace; must exist before service is created
   - Done when: TypeScript compiles; internalApiAuth.key resolves to the env var value

4. [src/services/internal-api-auth-config.service.ts] Create InternalApiAuthConfigService
   - Why here: InternalApiKeyGuard depends on it; must exist before the guard
   - Done when: file compiles; key getter returns the configured value

5. [src/services/internal-api-auth-config.service.spec.ts] Write config service tests
   - Why here: immediately after the service — verify the getter works before the guard depends on it
   - Done when: getter delegates to ConfigService.getOrThrow; test passes

6. [src/guards/internal-api-key.guard.ts] Create InternalApiKeyGuard
   - Why here: depends on InternalApiAuthConfigService (step 4); all config is now in place
   - Done when: file compiles; missing-header, wrong-length, and wrong-content paths throw
     UnauthorizedException; correct header returns true; no key value in log lines

7. [src/guards/internal-api-key.guard.spec.ts] Write guard unit tests
   - Why here: immediately after the guard — before applying it anywhere
   - Done when: all five test scenarios pass (see Testing Strategy below)

8. [src/instrument.ts] Extend scrubEvent to redact x-internal-api-key from event.request.headers
   - Why here: Sentry protection should be in place before the guard can generate events that
     include the header
   - Done when: scrubEvent replaces the header value with "[Filtered]" when present

9. [src/services/sentry.service.spec.ts] Add test for x-internal-api-key scrubbing
   - Why here: immediately after the instrument change
   - Done when: test confirms buildBeforeSend redacts the header in a synthetic event

10. [src/app.module.ts] Add InternalApiAuthConfigService and InternalApiKeyGuard to providers
    - Why here: DI graph must know about both before the controller guard is resolved
    - Done when: app compiles and boots without DI errors

11. [src/controllers/knowledge-base.controller.ts] Add @UseGuards(InternalApiKeyGuard) at class level
    - Why last among production-code changes: the guard is now fully built, tested, registered, and
      the Sentry scrubber is extended; applying it here is safe
    - Done when: @UseGuards(InternalApiKeyGuard) appears on the class, above @Controller("knowledge-base")

12. [src/controllers/knowledge-base.controller.spec.ts] Add guard mock to testing module + decoration metadata test
    - Why last: the guard decoration (step 11) must exist before the metadata test can find it
    - Done when: testing module compiles with the guard mock; new describe block asserting
      InternalApiKeyGuard is in __guards__ metadata passes; all prior tests still pass
```

---

## Testing Strategy

### `src/guards/internal-api-key.guard.spec.ts` (new file)

Mock `InternalApiAuthConfigService` using `Test.createTestingModule` with `useValue: { key: "test-internal-api-key-32chars-aaaaa" }`. Mock `ExecutionContext` to return a fake Express `Request` object with controllable `headers` and `path`.

Test cases (~8 tests):

**Missing header → 401:**
- `request.headers['x-internal-api-key']` is `undefined` → throws `UnauthorizedException`
- `request.headers['x-internal-api-key']` is `""` (empty string) → throws `UnauthorizedException` (falsy check)

**Wrong length → 401, no timingSafeEqual call:**
- Header present but shorter than configured secret → throws `UnauthorizedException`; verify `crypto.timingSafeEqual` is NOT called (spy on it, assert `.not.toHaveBeenCalled()`)

**Wrong content (same length) → 401, timingSafeEqual IS called:**
- Header is same length as configured secret but wrong characters → throws `UnauthorizedException`; verify `crypto.timingSafeEqual` WAS called (spy on it, assert `.toHaveBeenCalledTimes(1)`)

**Correct header → returns true:**
- Header matches configured secret exactly → returns `true`; verify no exception thrown

**timingSafeEqual is the comparison primitive:**
- Spy on `crypto.timingSafeEqual`; confirm it is called (not `===` on string values) when lengths match

**Logger.warn is called on rejection (not on success):**
- Wrong header → `Logger.warn` is called with a string containing `[event=internal_auth_rejected`
- Correct header → `Logger.warn` is NOT called

**Header value never in log output:**
- Spy on `Logger.warn`; confirm the actual key value (`"test-internal-api-key-32chars-aaaaa"`) does not appear in any logged string

### `src/services/internal-api-auth-config.service.spec.ts` (new file)

```typescript
// Simple spec: mock ConfigService; verify key getter calls getOrThrow("internalApiAuth.key")
```

Test cases (~2 tests):
- `key` getter returns the value from `ConfigService.getOrThrow("internalApiAuth.key", ...)`
- `key` getter uses `getOrThrow` not `get` (i.e., it would throw if the key were absent rather than returning undefined)

### `src/services/sentry.service.spec.ts` — extension to existing `buildBeforeSend` describe block

Add one new test to the existing `buildBeforeSend — PII scrubbing and event filtering` describe block:

```typescript
it("scrubs x-internal-api-key from event.request.headers → [Filtered]", () => {
  const event: ErrorEvent = {
    type: undefined,
    request: {
      headers: {
        "x-internal-api-key": "some-secret-value-here-that-should-not-appear",
        "content-type": "application/json",
      },
    },
  };

  const result = beforeSend(event, makeHint(new Error("some error")));

  expect(result).not.toBeNull();
  const headers = (result!.request!.headers as Record<string, string>);
  expect(headers["x-internal-api-key"]).toBe("[Filtered]");
  expect(headers["content-type"]).toBe("application/json"); // non-secret headers unchanged
});
```

### `src/controllers/knowledge-base.controller.spec.ts` — additions

Add a new `describe("guard decoration", ...)` block with the `Reflect.getMetadata("__guards__", KnowledgeBaseController)` assertion (described above). Add the two new providers to the `Test.createTestingModule` call. All existing tests continue to pass unchanged.

---

## Risks and Edge Cases

**High — local startup fails if `KB_INTERNAL_API_KEY` in `.env.local` is unset or shorter than 32 characters when the schema change applies.**
The schema change enforces `min(32)` at boot. The developer must ensure `.env.local` has a 32+ char value in place before pulling the schema change locally. `.env.local` is gitignored and developer-managed. Mitigation: steps 1 and 2 in the implementation order are explicitly sequential, and the implementer should communicate the env-var requirement clearly.

**High — Existing tests fail to compile if guard DI is not resolved.**
After `@UseGuards(InternalApiKeyGuard)` is on the controller, any `Test.createTestingModule` that includes `KnowledgeBaseController` without providing `InternalApiAuthConfigService` and `InternalApiKeyGuard` will throw at test compilation time. Mitigation: step 12 in the implementation order explicitly updates the testing module before tests are run.

**Medium — Guard rejection path does not use `timingSafeEqual` for length mismatches.**
This is intentional and correct — `timingSafeEqual` throws on unequal lengths. The guard short-circuits to `return false` in `isValidKey` before calling `timingSafeEqual`. A future reviewer might flag this as "you skipped constant-time comparison" — document it clearly in the code comment that the length mismatch rejection itself reveals no useful information to an attacker (they already know the header was wrong), and that the constant-time comparison only matters for same-length candidates.

**Medium — Future contributor adds a new route or controller to `/knowledge-base/*` and forgets the decoration.**
Mitigation: the code comment on `InternalApiKeyGuard` (in the guard file) explicitly documents the convention ("add a future controller = one decorator"). A test that asserts the decoration exists via `Reflect.getMetadata` on every KB controller class is the stronger mitigation — added to `knowledge-base.controller.spec.ts` in step 12. For v1 this is sufficient; a directory-scanning test that auto-discovers all KB controllers is noted as a future enhancement.

**Medium — HTTPS-only assumption not enforced in code.**
The guard assumes the `X-Internal-API-Key` header is transmitted over TLS. If the deployment infrastructure does not enforce HTTPS, the shared secret is exposed in transit. Mitigation: this assumption is explicitly documented in the guard's code comment. The plan does not add TLS enforcement — that is an infrastructure concern and is explicitly out of scope per the brief.

**Low — Array-valued header edge case.**
Express returns `string | string[] | undefined` for `request.headers[name]`. The guard takes the first element if it is an array. An attacker who sends multiple `X-Internal-API-Key` headers gains no advantage — only the first is compared. This is defensive and correct behavior.

**Low — `KB_INTERNAL_API_KEY` in CI environments.**
The brief states all environments (including CI) must have the var set. CI test runs that do NOT set `KB_INTERNAL_API_KEY` will fail at boot with a Zod validation error before any tests run. This is the intended behavior. Teams running CI must add this env var to their CI secrets. Flag this as a deployment-communication item for the orchestrator.

**Low — No `timingSafeEqual` test across all possible header array shapes.**
The guard takes `rawHeader[0]` for array-shaped headers. The spec tests `undefined`, string, and string-with-wrong-content — but not the `string[]` array shape. Adding one array-header test case is advisable but not required for v1. Noted here for the implementer's awareness.

---

## Out-of-Scope Confirmations

The following are explicitly not included in this plan:
- mTLS or any TLS-layer authentication
- Per-partner key registry, key rotation tooling, or in-app key management
- JWT verification for upstream user tokens
- Direct user authentication on this API
- Rate limiting, IP allowlisting, or any other request-shape constraint
- Touching `/chat/web/*` controllers in any way
- Generating, distributing, or rotating the actual secret value
- OpenAPI / Swagger security scheme additions (no Swagger is present in this project)
- Any change to `src/controllers/sendgrid-webhook.controller.ts`
- Any change to `src/main.ts` (no middleware setup needed)
- Any new npm package installation
