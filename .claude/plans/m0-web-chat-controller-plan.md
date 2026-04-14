# M0 — Web Chat Controller: Implementation Plan

## Objective

Build the HTTP entry point that lets browser iframes embedded on client websites talk to the existing agent framework. Deliver two POST endpoints under `/chat/web`, dynamic CORS driven by per-account allowed-domain records in the existing DynamoDB table, and smoke-test wiring against the `lead_capture` agent. M0 covers the controller, origin allowlist service, and dynamic CORS only. No streaming, no auth, no rate limiting, no iframe UI, no new agent, no env var renames.

---

## Affected Files and Modules

### Create (new files)

| File | Purpose |
|------|---------|
| `src/types/WebChat.ts` | All request/response types for the web chat domain |
| `src/validation/web-chat.schema.ts` | Zod schemas for both endpoints |
| `src/pipes/webChatValidation.pipe.ts` | Generic `ZodValidationPipe` wrapping safeParse |
| `src/services/origin-allowlist.service.ts` | GSI1-backed origin check with TTL cache |
| `src/controllers/web-chat.controller.ts` | Thin controller for POST /chat/web/sessions and /messages |
| `src/controllers/web-chat.controller.spec.ts` | Unit tests for the controller |
| `src/services/origin-allowlist.service.spec.ts` | Unit tests for the allowlist service |

### Modify (existing files)

| File | Change |
|------|--------|
| `src/types/ChatAgent.ts` | Add `readonly displayName?: string` (additive, non-breaking) |
| `src/agents/lead-capture.agent.ts` | Set `displayName: "Lead Capture Assistant"` |
| `src/config/env.schema.ts` | Add `DYNAMODB_ACCOUNTS_DOMAIN_GSI_NAME` and `WEB_CHAT_CORS_ALLOW_ALL` with prod-guard refinement |
| `src/config/configuration.ts` | Surface both new env vars under `webChat` config key |
| `src/app.module.ts` | Register `WebChatController` in controllers, `OriginAllowlistService` in providers |
| `src/main.ts` | Resolve `OriginAllowlistService` from DI and wire dynamic CORS callback before `app.listen` |

### Review Only (no changes)

- `src/services/identity.service.ts` — confirmed signature: `lookupOrCreateSession(source: string, externalId: string, defaultAgentName: string): Promise<string>`
- `src/services/chat-session.service.ts` — confirmed signature: `handleMessage(sessionUlid: string, userMessage: string): Promise<string>`
- `src/agents/agent-registry.service.ts` — confirmed: `getByName(name: string): ChatAgent | null` (returns `null` for unknown agents)
- `src/providers/dynamodb.provider.ts` — confirmed: injection token is `DYNAMO_DB_CLIENT`, type is `DynamoDBDocumentClient`

---

## Dependencies and Architectural Considerations

- **DynamoDB client**: `OriginAllowlistService` must inject via `@Inject(DYNAMO_DB_CLIENT)` and use `DatabaseConfigService` for the table name — same pattern as `IdentityService` and `ChatSessionService`. No second `DynamoDBClient` instantiation.
- **CORS callback timing**: NestJS calls the `origin` callback on every request that includes an `Origin` header. The in-memory cache is what keeps this cheap — without it, every request would trigger a DynamoDB query.
- **`app.get()` before `enableCors`**: `main.ts` must call `app.get(OriginAllowlistService)` after `NestFactory.create` resolves (module is fully initialized) and before `app.enableCors(...)`. The service will be available because it is registered as a provider in `AppModule`.
- **Agent registry method**: The controller must call `agentRegistry.getByName(agentName)` (not the non-existent `getAgent`). Returns `null` for unknown agents — controller maps this to a `BadRequestException`.
- **No `AgentRegistryService` changes**: The controller accesses it via constructor injection. `AgentRegistryService` is already registered in `AppModule`.
- **Env schema validation**: The `envSchema` in `env.schema.ts` is passed to `validate` in `env.validation.ts`. A failed `.superRefine()` or `.refine()` will cause `validate()` to throw, crashing the process at startup — this is the intended prod-guardrail behavior.
- **Config typing**: `configuration.ts` uses raw `process.env` reads. Add a `webChat` section mirroring how `discord` and `sendgrid` sections are structured. `OriginAllowlistService` can also read env vars directly (as `DatabaseConfigService` does), or accept a config service — recommend a dedicated `WebChatConfigService` is out of scope for M0; read from `process.env` directly inside the service with documented defaults, consistent with how `DatabaseConfigService` reads `DYNAMODB_TABLE_CONVERSATIONS`.

---

## Step-by-Step Implementation Sequence

### 1. `src/types/ChatAgent.ts` — Add `displayName` field

Add `readonly displayName?: string` to the `ChatAgent` interface. This is purely additive; no existing code references `displayName` so nothing breaks.

- **Why first**: `LeadCaptureAgent` and the controller's fallback logic both depend on this field existing on the interface.
- **Done when**: `npx tsc --noEmit` passes with no errors.

---

### 2. `src/agents/lead-capture.agent.ts` — Set `displayName`

Add `readonly displayName = "Lead Capture Assistant"` to `LeadCaptureAgent`. This satisfies the updated `ChatAgent` interface.

- **Why here**: Depends on step 1. No other dependencies.
- **Done when**: `npx tsc --noEmit` passes; value is verifiable in unit test.

---

### 3. `src/config/env.schema.ts` — Add new env vars

Add two fields to `envSchema`:

```
DYNAMODB_ACCOUNTS_DOMAIN_GSI_NAME: z.string().default("GSI1")

WEB_CHAT_CORS_ALLOW_ALL: z.preprocess(val => val === "true", z.boolean()).default(false)
// Rationale: z.preprocess runs before type-checking, so the boolean coercion from the
// "true"/"false" string happens unconditionally. This avoids .default()/.transform()
// ordering ambiguity: when the env var is absent, preprocess receives undefined,
// undefined === "true" is false, z.boolean() accepts false, .default(false) is a
// no-op. When set to "true", preprocess converts to true. Any other string → false.
```

After both fields are defined, add a `.superRefine()` on the full schema object (not on individual fields) that checks: if `WEB_CHAT_CORS_ALLOW_ALL === true` and `APP_ENV === "prod"`, call `ctx.addIssue(...)`. This causes `validate()` to throw at startup, crashing the process — the intended prod guardrail.

Example `.superRefine` placement: chain it on the `z.object({...})` call directly, before the `export` of `envSchema`. This ensures `Env` type reflects the refined type.

- **Why here**: Both `configuration.ts` and `OriginAllowlistService` read from env; the schema must define defaults first.
- **Done when**: Schema compiles; a test with `APP_ENV=prod, WEB_CHAT_CORS_ALLOW_ALL=true` causes `validate()` to throw.

---

### 4. `src/config/configuration.ts` — Surface new vars

Add a `webChat` section:

```
webChat: {
  corsAllowAll: process.env.WEB_CHAT_CORS_ALLOW_ALL === "true",
  domainGsiName: process.env.DYNAMODB_ACCOUNTS_DOMAIN_GSI_NAME || "GSI1",
}
```

- **Why here**: Provides typed config access for `main.ts` CORS wiring. `OriginAllowlistService` may also read from this config object or from `process.env` directly — either is consistent with existing patterns. Direct `process.env` reads (like `DatabaseConfigService`) are preferred for simplicity.
- **Done when**: `npx tsc --noEmit` passes.

---

### 5. `src/types/WebChat.ts` — Define all domain types

All types for the web chat domain live here per project convention. Define:

```typescript
// Request types
export interface WebChatCreateSessionRequest {
  agentName: string;
  guestUlid: string;
}

export interface WebChatSendMessageRequest {
  sessionUlid: string;
  message: string;
}

// Response types
export interface WebChatCreateSessionResponse {
  sessionUlid: string;
  displayName: string;
}

export interface WebChatSendMessageResponse {
  reply: string;
}
```

All four types are prefixed with the domain name `WebChat` per the style-enforcer naming rule.

- **Why here**: Downstream files (schema, controller) depend on these. Types must exist before anything imports them.
- **Done when**: File compiles in isolation.

---

### 6. `src/validation/web-chat.schema.ts` — Zod schemas

Define two schemas and export inferred types:

```typescript
// ULID: 26-char Crockford base32 (0-9, A-Z excluding I, L, O, U)
const ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const createSessionSchema = z.object({
  agentName: z.string().min(1),
  guestUlid: z.string().regex(ulidRegex, "guestUlid must be a valid 26-character ULID"),
});

export const sendMessageSchema = z.object({
  sessionUlid: z.string().regex(ulidRegex, "sessionUlid must be a valid 26-character ULID"),
  message: z.string().min(1, "message must not be empty"),
});

export type CreateSessionBody = z.infer<typeof createSessionSchema>;
export type SendMessageBody = z.infer<typeof sendMessageSchema>;
```

Note: The inferred types (`CreateSessionBody`, `SendMessageBody`) are convenience aliases for the pipe. The authoritative domain types are in `src/types/WebChat.ts`. These two are schema-derived and live alongside the schema per the pattern in `tool.schema.ts`.

- **Why here**: The pipe depends on the schemas. Schemas must exist before the pipe can import them.
- **Done when**: File compiles; types match the `WebChat.ts` request interfaces.

---

### 7. `src/pipes/webChatValidation.pipe.ts` — Generic validation pipe

Implement a `ZodValidationPipe` using `PipeTransform`:

```typescript
import { PipeTransform, BadRequestException } from "@nestjs/common";
import { ZodSchema } from "zod";

export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown) {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      throw new BadRequestException(result.error.errors[0]?.message ?? "Validation failed");
    }

    return result.data;
  }
}
```

Key points:
- The error message must be sanitized — never echo raw user input, only schema-generated messages.
- `transform` returns the parsed (and coerced) data, not the raw input.
- The pipe is generic: it accepts any `ZodSchema` at construction time. Both endpoints use it with different schemas.
- Controller uses it as `@Body(new ZodValidationPipe(createSessionSchema))` — param-scoped, not global.

- **Why here**: Depends on Zod schemas from step 6. Controller depends on the pipe.
- **Done when**: File compiles; pipe correctly throws `BadRequestException` on schema failure.

---

### 8. `src/services/origin-allowlist.service.ts` — Origin allowlist with GSI query and TTL cache

#### Design

**Injection**:
```typescript
@Injectable()
export class OriginAllowlistService {
  constructor(
    @Inject(DYNAMO_DB_CLIENT) private readonly dynamoDb: DynamoDBDocumentClient,
    private readonly databaseConfig: DatabaseConfigService,
  ) {}
}
```

**Cache shape**:
```typescript
// Private field — not exported
private readonly cache = new Map<string, { allowed: boolean; expiresAt: number }>();
```

TTL constants (file-level, not exported):
```typescript
const POSITIVE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const NEGATIVE_TTL_MS = 1 * 60 * 1000; // 1 minute
```

**Normalization** (`normalizeOrigin(origin: string): string | null`):

The normalizer must be a private method (not exported). Logic:
1. Trim whitespace.
2. Attempt `new URL(origin)` — if this throws, return `null` (malformed origin).
3. Extract `hostname` (not `host` — `hostname` strips the port automatically).
4. Lowercase.
5. Return the normalized host string.

This handles all cases:
- `https://Shop.Example.com:443` → `shop.example.com`
- `http://localhost:3000` → `localhost`
- `https://example.com` → `example.com`
- IPv6: `http://[::1]:3000` — `URL.hostname` returns `[::1]`, lowercased `[::1]` — consistent, usable as a cache key and GSI suffix.
- Origin with path/query: `new URL()` on a value like `https://example.com/path` would succeed — `hostname` correctly extracts `example.com`. This is acceptable; malformed Origin headers with paths should still normalize safely.

**`isAllowed` method**:

```
async isAllowed(origin: string): Promise<boolean>
```

Steps:
1. Normalize origin → host. If normalization returns `null`, log `debug` with decision `denied (malformed)` and return `false`.
2. Check cache: if entry exists and `Date.now() < expiresAt`, return `entry.allowed`.
3. Query DynamoDB using `ExpressionAttributeNames` to alias `GSI1-PK` (the hyphen is a subtraction operator in DynamoDB expressions and must be aliased):

```ts
await this.dynamoClient.send(
  new QueryCommand({
    TableName: this.tableName,
    IndexName: this.gsiName,
    KeyConditionExpression: "#gsi1pk = :pk",
    FilterExpression: "#entity = :account",
    ExpressionAttributeNames: {
      "#gsi1pk": "GSI1-PK",
      "#entity": "entity",
    },
    ExpressionAttributeValues: {
      ":pk": `DOMAIN#${normalizedHost}`,
      ":account": "ACCOUNT",
    },
    Limit: 1,
  }),
);
```

   - `IndexName` comes from `process.env.DYNAMODB_ACCOUNTS_DOMAIN_GSI_NAME || "GSI1"` (the index name, not the attribute name).
   - `FilterExpression` restricts results to items where `entity === "ACCOUNT"`, excluding any non-account records that happen to share a `DOMAIN#...` key.
   - `Limit: 1` — one hit is sufficient.
   - Use `QueryCommand` only. **NO `ScanCommand` anywhere in this file.**

4. Inspect result in service code — do NOT encode the `is_active` check as a second `FilterExpression` (nested boolean, awkward in DynamoDB expressions):

```ts
const result = await this.dynamoClient.send(new QueryCommand({ ... }));
const account = result.Items?.[0];
const allowed = Boolean(account && account.status?.is_active === true);
this.cache.set(normalizedHost, { allowed, expiresAt: Date.now() + (allowed ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) });
return allowed;
```

   Both "no account found" and "account found but inactive" collapse to `allowed = false`. Negative results cache under the 1-minute TTL. Positive (active account matched) caches under the 5-minute TTL.

5. Log `debug`: normalized host and the decision (`allowed` or `denied`).

On DynamoDB error:
- Log at `error` level: `error.name` only — never `error.message` (may contain sensitive data).
- Return `false` (fail closed).
- **Do NOT write to the cache on error** — let the next request retry the DynamoDB call.

**Thundering herd**: Two concurrent requests for a cold origin will both miss the cache and fire two identical GSI queries. This is acceptable for M0. No promise-dedup layer.

**GSI attribute name vs. index name**: The attribute name aliased by `#gsi1pk` is `"GSI1-PK"` (hyphenated). The index name in `IndexName` is the value of `DYNAMODB_ACCOUNTS_DOMAIN_GSI_NAME` (default `"GSI1"`). These are separate concerns — do not confuse them.

- **Why here**: The controller depends on `AgentRegistryService`, not on `OriginAllowlistService`. The service can be built independently. It must be ready before module wiring (step 10).
- **Done when**: File compiles; unit tests cover all cases listed in the test plan.

---

### 9. `src/controllers/web-chat.controller.ts` — Thin controller

```typescript
@Controller("chat/web")
export class WebChatController {
  private readonly logger = new Logger(WebChatController.name);

  constructor(
    private readonly identityService: IdentityService,
    private readonly chatSessionService: ChatSessionService,
    private readonly agentRegistry: AgentRegistryService,
  ) {}
}
```

**POST /chat/web/sessions**:

```
@Post("sessions")
async createSession(
  @Body(new ZodValidationPipe(createSessionSchema)) body: CreateSessionBody,
): Promise<WebChatCreateSessionResponse>
```

Logic:
1. `const agent = this.agentRegistry.getByName(body.agentName)`.
2. If `agent === null`: throw `new BadRequestException(\`Unknown agent: ${body.agentName}\`)` — logged at `debug`, do NOT call `IdentityService`.
3. `const sessionUlid = await this.identityService.lookupOrCreateSession("web", body.guestUlid, body.agentName)`.
4. `const displayName = agent.displayName ?? agent.name`.
5. Log `debug`: `[agentName=... sessionUlid=...]`. Never log `guestUlid`.
6. Return `{ sessionUlid, displayName }`.

**POST /chat/web/messages**:

```
@Post("messages")
async sendMessage(
  @Body(new ZodValidationPipe(sendMessageSchema)) body: SendMessageBody,
): Promise<WebChatSendMessageResponse>
```

Logic:
1. `const reply = await this.chatSessionService.handleMessage(body.sessionUlid, body.message)`.
2. Log `debug`: `[sessionUlid=...]`. Never log `message` content or `reply` text.
3. Return `{ reply }`.

Controller must NOT:
- Make DynamoDB calls.
- Call Anthropic directly.
- Contain business logic.
- Log message content, reply text, or `guestUlid`.
- Inline any type definitions.

Error handling: Let exceptions from `IdentityService` and `ChatSessionService` bubble — NestJS default exception filter handles them. Only explicit `BadRequestException` is thrown by the controller itself (unknown agent).

- **Why here**: Depends on types (step 5), schemas (step 6), pipe (step 7), and all services. Controller is last before wiring.
- **Done when**: Unit tests pass (step 11); all orchestration calls go to the correct services with correct arguments.

---

### 10. `src/app.module.ts` — Register new controller and service

Add to `controllers` array: `WebChatController`
Add to `providers` array: `OriginAllowlistService`

Import both at the top of the file.

- **Why here**: Module registration must come after all source files are in place. `OriginAllowlistService` must be a provider so `app.get(OriginAllowlistService)` works in `main.ts`.
- **Done when**: App boots without errors; no "unknown dependency" injection errors.

---

### 11. `src/main.ts` — Wire dynamic CORS

Modify `bootstrap()`:

1. After `NestFactory.create(AppModule, ...)`, resolve the service:
   ```typescript
   const originAllowlistService = app.get(OriginAllowlistService);
   ```
2. Read env:
   ```typescript
   const isProd = process.env.APP_ENV === "prod";
   const corsAllowAll = process.env.WEB_CHAT_CORS_ALLOW_ALL === "true";
   ```
3. Call `app.enableCors` before `app.listen`:
   ```typescript
   app.enableCors({
     origin: async (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
       // Missing Origin header
       if (!origin) {
         callback(null, !isProd);
         return;
       }
       // Dev override
       if (corsAllowAll) {
         callback(null, true);
         return;
       }
       // Delegate to allowlist
       const allowed = await originAllowlistService.isAllowed(origin);
       callback(null, allowed);
     },
   });
   ```

**Behavior matrix**:

| `APP_ENV` | `WEB_CHAT_CORS_ALLOW_ALL` | Origin header | Result |
|-----------|--------------------------|---------------|--------|
| `local` | `false` | absent | allow (non-prod curl, same-origin) |
| `prod` | `false` | absent | reject |
| `local` | `true` | any | allow (dev override) |
| `prod` | `true` | — | app refuses to boot (env schema refinement) |
| any | `false` | present | delegate to `OriginAllowlistService.isAllowed()` |

The `corsAllowAll + prod` combination never reaches runtime because the schema parse fails at startup.

- **Why last in source sequence**: Depends on `OriginAllowlistService` being a registered provider (step 10).
- **Done when**: App boots; CORS headers are set correctly on test requests.

---

### 12. Specs

#### `src/controllers/web-chat.controller.spec.ts`

Test cases (all unit — mock `IdentityService`, `ChatSessionService`, `AgentRegistryService`):

1. **POST /sessions — unknown agentName returns 400**
   - `agentRegistry.getByName` returns `null`
   - Assert `BadRequestException` thrown
   - Assert `identityService.lookupOrCreateSession` was NOT called

2. **POST /sessions — valid request returns sessionUlid and displayName**
   - `agentRegistry.getByName` returns mock agent with `displayName: "Lead Capture Assistant"`
   - `identityService.lookupOrCreateSession` returns mock ULID
   - Assert response `{ sessionUlid, displayName: "Lead Capture Assistant" }`
   - Assert `lookupOrCreateSession` called with `("web", guestUlid, agentName)`

3. **POST /sessions — agent without displayName falls back to agent.name**
   - Mock agent has no `displayName` (undefined)
   - Assert response `{ displayName: agent.name }`

4. **POST /sessions — invalid guestUlid shape returns 400**
   - Body has `guestUlid: "not-a-ulid"`
   - Assert `BadRequestException` from pipe
   - Assert no service calls made

5. **POST /messages — valid request returns reply**
   - `chatSessionService.handleMessage` returns `"Hello"`
   - Assert response `{ reply: "Hello" }`
   - Assert `handleMessage` called with `(sessionUlid, message)`

6. **POST /messages — empty message returns 400**
   - Body has `message: ""`
   - Assert `BadRequestException` from pipe

Note: The pipe is param-scoped so it fires before the handler. Tests can invoke the controller method directly and separately test the pipe by calling `transform()` directly on a `ZodValidationPipe` instance.

#### `src/services/origin-allowlist.service.spec.ts`

Test cases (unit — mock `DynamoDBDocumentClient` via `DYNAMO_DB_CLIENT` token, mock `DatabaseConfigService`):

**Locked cases (must be present):**

1. **Active account match** — GSI returns `[{ entity: "ACCOUNT", status: { is_active: true } }]` → returns `true`, entry cached with positive TTL (5 min).
2. **Inactive account match** — GSI returns `[{ entity: "ACCOUNT", status: { is_active: false } }]` → returns `false`, entry cached with negative TTL (1 min).
3. **Account found, `status` field missing entirely** — GSI returns `[{ entity: "ACCOUNT" }]` (no `status` key) → returns `false` (defensive default), entry cached with negative TTL.
4. **Non-account entity returned by GSI** — GSI returns `[{ entity: "SESSION" }]` (FilterExpression should prevent this, but test defensively) → returns `false`, entry cached with negative TTL.
5. **Zero items returned** — GSI returns `Items: []` → returns `false`, entry cached with negative TTL.
6. **DynamoDB throws** — `send()` rejects → returns `false`, **no cache entry written** (next request must retry).

**Additional coverage:**

7. **Cache hit (positive)** — cache entry with `allowed: true, expiresAt: future` → returns `true`, no DynamoDB call.
8. **Cache hit (negative)** — cache entry with `allowed: false, expiresAt: future` → returns `false`, no DynamoDB call.
9. **Normalization: scheme stripped** — `"https://example.com"` → host `"example.com"` used as key.
10. **Normalization: uppercase normalized** — `"https://Shop.Example.com"` → host `"shop.example.com"`.
11. **Normalization: port stripped** — `"https://example.com:443"` → host `"example.com"`.
12. **TTL expiration: positive entry** — cache entry with `expiresAt: Date.now() - 1` → treated as miss, queries DynamoDB.
13. **TTL expiration: negative entry** — expired negative entry → treated as miss, queries DynamoDB.
14. **GSI index name from env** — assert `QueryCommand` was called with `IndexName` equal to `process.env.DYNAMODB_ACCOUNTS_DOMAIN_GSI_NAME` value.
15. **Malformed origin** — `"not-a-url"` → returns `false`, no DynamoDB call.
16. **`ExpressionAttributeNames` shape** — assert `QueryCommand` was called with `ExpressionAttributeNames: { "#gsi1pk": "GSI1-PK", "#entity": "entity" }` and matching `ExpressionAttributeValues` (verifies hyphenated attribute aliasing is present).

---

## Risks and Edge Cases

### High

**Missing Origin in prod** — browsers always send `Origin` on cross-origin requests, but direct server-to-server calls (health checks, curl, Postman) may not. The `!origin → reject in prod` behavior is correct but could block legitimate non-browser callers if they don't set `Origin`. Mitigation: document this behavior; non-browser integrations for M0 are out of scope.

**`GSI1-PK` attribute name and hyphen aliasing** — the DynamoDB attribute is `"GSI1-PK"` (hyphenated). Because `-` is a subtraction operator in DynamoDB expression syntax, the `KeyConditionExpression` MUST use `ExpressionAttributeNames` to alias it (as `"#gsi1pk"`). Omitting the alias causes a `ValidationException` at runtime. If the real index name differs from the env var value, queries return zero results silently — all origins denied. Mitigation: verify `GSI1-PK` attribute name and the real GSI index name against a live account record before implementing.

**Env schema refinement scope** — the `superRefine` on the schema must run AFTER both `WEB_CHAT_CORS_ALLOW_ALL` and `APP_ENV` have been parsed and transformed. Placement at the end of the `.object({...})` definition ensures this. If placed on a single field, it won't have access to `APP_ENV`. Implementation must use `.superRefine()` on the object, not `.refine()` on a single field.

### Medium

**Thundering herd on cold cache** — two simultaneous requests for an uncached origin fire two GSI queries. Both will write to the cache. This is accepted for M0 but means DynamoDB is hit twice. The second write overwrites the first with identical data — no correctness issue.

**IPv6 origin** — `http://[::1]:3000` → `URL.hostname` returns `[::1]`. This is a valid cache key and GSI suffix. If the account record has `GSI1PK = "DOMAIN#[::1]"`, it matches. If not, denied. Not expected in production but should not crash.

**Origin with path** — spec says `Origin` header should never include a path (RFC 6454). In practice some non-browser clients send malformed Origins with paths. `new URL("https://example.com/path").hostname` → `"example.com"` — the normalizer handles this correctly without special-casing.

**`AgentRegistryService` initialized after `WebChatController`** — `AgentRegistryService` uses `OnModuleInit` for auto-discovery. NestJS guarantees `OnModuleInit` runs after all providers are constructed. The controller calls `getByName` on HTTP requests (not at construction time), so there is no race. This is safe.

**`WEB_CHAT_CORS_ALLOW_ALL` coercion with `z.preprocess`** — the locked pattern is `z.preprocess(val => val === "true", z.boolean()).default(false)`. `z.preprocess` runs before type-checking so the string-to-boolean conversion is unambiguous regardless of where `.default()` falls. When the env var is absent, `preprocess` receives `undefined`; `undefined === "true"` is `false`; `z.boolean()` accepts `false`; `.default(false)` is a no-op. This avoids the ordering ambiguity of chaining `.transform()` with `.default()` on string schemas.

### Low

**Account doc without GSI1PK** — an account record that exists in the table but was created without the `GSI1PK` attribute will not appear in the GSI. The query returns zero results; the domain is denied. This is the correct fail-safe behavior.

**Cache memory growth** — the `Map` is unbounded. With many unique origins, memory grows. For M0 with a small number of client domains this is not an issue. A bounded LRU would be a future improvement.

**`displayName` on agents other than `LeadCaptureAgent`** — `displayName` is optional on `ChatAgent`. Any future agent that does not set it will fall back to `agent.name` in the controller. This is the correct behavior and requires no guard code beyond the `?? agent.name` fallback.

---

## Testing Strategy

**Unit tests only for M0.** No e2e tests. No integration tests hitting real DynamoDB.

**Controller spec** (`web-chat.controller.spec.ts`):
- Use `Test.createTestingModule` with mock providers for `IdentityService`, `ChatSessionService`, and `AgentRegistryService`.
- Test the pipe in isolation (`new ZodValidationPipe(schema).transform(value)`) to avoid needing a full HTTP stack.
- All 6 cases enumerated in step 12.

**Origin allowlist spec** (`origin-allowlist.service.spec.ts`):
- Mock `DynamoDBDocumentClient` using the `DYNAMO_DB_CLIENT` token — provide a jest mock with a `.send()` method.
- Mock `DatabaseConfigService` returning a fixed table name.
- Manipulate `Date.now()` via `jest.spyOn(Date, 'now')` for TTL expiry tests.
- Control `process.env.DYNAMODB_ACCOUNTS_DOMAIN_GSI_NAME` per test for the index name test.
- All 12 cases enumerated in step 12.

**Regression**: The existing `email-reply.service.spec.ts` and any other passing tests must not regress. The only shared files modified are `ChatAgent.ts` (additive), `env.schema.ts` (additive), `configuration.ts` (additive), `app.module.ts` (additive), and `main.ts` (CORS added before listen). None of these changes touch existing behavior paths.

---

## Implementation Recommendations

1. **`GSI1-PK` attribute name and aliasing**: The DynamoDB attribute is `"GSI1-PK"` (hyphen, not underscore or camelCase). Always use `ExpressionAttributeNames: { "#gsi1pk": "GSI1-PK" }` in the `QueryCommand` — omitting this alias causes a runtime `ValidationException`. Confirm the real index name in `.env` before implementing; the GSI index name (`IndexName`) and the item attribute name (`"GSI1-PK"`) are separate and must both be correct.

2. **Env schema Zod `.superRefine()` order**: In Zod, `.superRefine()` on an object schema receives the already-parsed object. Chain it directly after `.object({...})` — before any further `.transform()` or other chained calls — so `APP_ENV` and `WEB_CHAT_CORS_ALLOW_ALL` are both available in their fully parsed (boolean) forms. Use `z.preprocess(val => val === "true", z.boolean()).default(false)` for `WEB_CHAT_CORS_ALLOW_ALL`, not a `.transform()/.default()` chain.

3. **`ZodValidationPipe` is generic**: Build it to accept `ZodSchema` (the base class), not a specific schema type. Both endpoint schemas are structurally different but the pipe is identical. This avoids two separate pipe classes.

4. **No `else` statements**: Per style rules, all conditionals in the controller and service must use early returns. The `isAllowed` flow (normalize → cache check → query → cache write → return) naturally fits this pattern.

5. **Logging privacy in `main.ts`**: The CORS callback receives the raw `Origin` header value. Do not log the full origin string — it may contain path or query components (malformed clients). If logging the CORS decision, log only the normalized host from `OriginAllowlistService`, not the raw origin passed to the callback.

6. **`app.enableCors` must precede `app.listen`**: The current `main.ts` calls `listen` immediately after `NestFactory.create`. Insert `app.get(OriginAllowlistService)` and `app.enableCors(...)` between these two calls.

7. **Pipe error message sanitization**: `result.error.errors[0]?.message` is safe — it comes from the Zod schema definition, not from user input. The raw user value is never included in Zod's error message for `regex` or `min` validators.
