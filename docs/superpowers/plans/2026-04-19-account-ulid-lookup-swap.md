# Account ULID Lookup Swap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `hostDomain` body field (resolved via GSI1 `DOMAIN#<host>` query) with an `accountUlid` body field (resolved via direct `GetItem` on `A#<ulid>`) on `POST /chat/web/sessions`.

**Architecture:** The widget already sends `accountUlid` in the body (frontend shipped ahead of backend). The backend currently ignores it and falls back to the Origin header. This plan updates the backend to read `accountUlid` from the body, drop the `hostDomain` field entirely, and validate the account via a direct `GetItem` on `{ PK: A#<ulid>, SK: A#<ulid> }` rather than a GSI query. The existing CORS-layer Origin allowlist (`main.ts`) is out of scope and stays unchanged.

**Tech Stack:** NestJS, TypeScript (strict), Zod (`web-chat.schema.ts`), AWS SDK v3 DynamoDB Document Client, Jest + `aws-sdk-client-mock`.

**Out of scope (deferred to a follow-up PR):**
- `Referer` header check on `/embed`
- `Content-Security-Policy: frame-ancestors`
- The `allowedEmbedOrigins: string[]` field on account documents
- Any CORS changes in `main.ts`

---

## File Structure

**Modified files (no new files):**

- `src/validation/web-chat.schema.ts` — drop `hostDomain` field + regex, add `accountUlid` field + regex (required)
- `src/types/WebChat.ts` — drop `hostDomain?: string`, add `accountUlid: string` (required)
- `src/services/origin-allowlist.service.ts` — add `verifyAccountActive(accountUlid: string)` method using `GetCommand`; add a second cache map keyed by ULID
- `src/controllers/web-chat.controller.ts` — drop `@Headers("origin")`, drop `hostDomain` fallback logic, drop `body.hostDomain`/`origin` branching, call `verifyAccountActive(body.accountUlid)` instead of `resolveAccountForOrigin(...)`
- `src/services/origin-allowlist.service.spec.ts` — add test suite for `verifyAccountActive`
- `src/controllers/web-chat.controller.spec.ts` — delete `hostDomain`/origin-fallback tests, add `accountUlid`-based tests

Each task below is TDD-structured: write a failing test, watch it fail, write the minimal code to pass, confirm green, commit.

---

### Task 1: Validation schema — swap `hostDomain` for `accountUlid`

**Files:**
- Modify: `src/validation/web-chat.schema.ts`
- Test: no separate test file; schema is exercised through controller tests in Task 4. We run `tsc` as the immediate verification gate.

- [ ] **Step 1: Edit `src/validation/web-chat.schema.ts` — remove `hostDomain` field and regex, add `accountUlid` field and regex**

Replace the entire file contents with:

```ts
import { z } from "zod";

// 26-character Crockford base32: digits 0–9 and uppercase A–Z excluding I, L, O, U
const ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// Account ULID as sent by the widget: the DynamoDB PK form "A#<26-char-ulid>".
// The "A#" prefix is what the customer pastes into their embed snippet as
// data-account-ulid. The controller strips it before calling the account
// lookup; downstream code works with the raw ULID only.
const accountUlidRegex = /^A#[0-9A-HJKMNP-TV-Z]{26}$/;

export const createSessionSchema = z.object({
  agentName: z.string().min(1),
  guestUlid: z.string().regex(ulidRegex, "guestUlid must be a valid 26-character ULID"),
  accountUlid: z
    .string()
    .regex(accountUlidRegex, "accountUlid must be an A#-prefixed 26-character ULID"),
});

export const sendMessageSchema = z.object({
  sessionUlid: z.string().regex(ulidRegex, "sessionUlid must be a valid 26-character ULID"),
  message: z.string().min(1, "message must not be empty"),
});

export type CreateSessionBody = z.infer<typeof createSessionSchema>;
export type SendMessageBody = z.infer<typeof sendMessageSchema>;
```

- [ ] **Step 2: Run the TypeScript compiler to surface callsites that still reference `hostDomain`**

Run: `npx tsc --noEmit`

Expected: compile errors at `src/controllers/web-chat.controller.ts` (references `body.hostDomain`) and `src/types/WebChat.ts` mismatch. These are resolved in Tasks 2 and 4. Do not commit yet — the tree is in a broken state. Proceed to Task 2.

---

### Task 2: Update `WebChat` types

**Files:**
- Modify: `src/types/WebChat.ts`

- [ ] **Step 1: Edit `src/types/WebChat.ts` — drop `hostDomain?`, add `accountUlid`**

Replace the file contents with:

```ts
export interface WebChatCreateSessionRequest {
  agentName: string;
  guestUlid: string;
  accountUlid: string;
}

export interface WebChatSendMessageRequest {
  sessionUlid: string;
  message: string;
}

export interface WebChatCreateSessionResponse {
  sessionUlid: string;
  displayName: string;
}

export interface WebChatSendMessageResponse {
  reply: string;
}
```

- [ ] **Step 2: Run `tsc` — confirm only controller-level errors remain**

Run: `npx tsc --noEmit`

Expected: errors localized to `src/controllers/web-chat.controller.ts`. Do not commit yet. Proceed to Task 3 before touching the controller (we need the new service method in place first).

---

### Task 3: Add `verifyAccountActive` to `OriginAllowlistService` (TDD)

**Files:**
- Modify: `src/services/origin-allowlist.service.ts`
- Test: `src/services/origin-allowlist.service.spec.ts`

The method signature:

```ts
async verifyAccountActive(accountUlid: string): Promise<string | null>
```

**Contract:**
- Input: the raw 26-character ULID (caller strips the `A#` prefix before invoking).
- Returns: the input ULID if the account document exists and `status.is_active === true`; otherwise `null`.
- Uses `GetCommand` on `{ PK: "A#<ulid>", SK: "A#<ulid>" }` (confirmed doc shape from `identity.service.ts:44` and `create-guest-cart.tool.ts:573`).
- Caches positive results for 5 minutes, negative results for 1 minute — mirroring `resolveAccountForOrigin`.
- Cache is a separate `Map` from the origin cache (`ulidCache`) so keys cannot collide.
- On DynamoDB error: returns `null` and does **not** write to cache (so the next call retries).

- [ ] **Step 1: Add the first failing test — active account returns the ULID and caches**

Edit `src/services/origin-allowlist.service.spec.ts`. Add an import for `GetCommand`:

```ts
import { DynamoDBDocumentClient, QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
```

Then append a new top-level `describe` block inside `describe("OriginAllowlistService", () => { ... })`, right after the existing `describe("GSI query shape", ...)`:

```ts
describe("verifyAccountActive", () => {
  it("returns the ulid for an active account and caches with positive TTL", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { PK: `A#${ACCOUNT_ULID}`, SK: `A#${ACCOUNT_ULID}`, entity: "ACCOUNT", status: { is_active: true } },
    });

    const dateSpy = jest.spyOn(Date, "now");
    dateSpy.mockReturnValue(1_000_000);

    const result = await service.verifyAccountActive(ACCOUNT_ULID);
    expect(result).toBe(ACCOUNT_ULID);

    // Second call must not hit DynamoDB (cache hit)
    ddbMock.reset();
    const result2 = await service.verifyAccountActive(ACCOUNT_ULID);
    expect(result2).toBe(ACCOUNT_ULID);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npx jest src/services/origin-allowlist.service.spec.ts -t "verifyAccountActive" --no-coverage`

Expected: FAIL with `TypeError: service.verifyAccountActive is not a function` or similar.

- [ ] **Step 3: Implement `verifyAccountActive` minimally — active-case only**

Edit `src/services/origin-allowlist.service.ts`. Add `GetCommand` to the imports:

```ts
import { DynamoDBDocumentClient, QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
```

Add a second cache map as a class property (right after the existing `private readonly cache` line):

```ts
  private readonly ulidCache = new Map<string, OriginAllowlistCacheEntry>();
```

Add the new method to the class (place it immediately after `resolveAccountForOrigin`, before `normalizeOrigin`):

```ts
  async verifyAccountActive(accountUlid: string): Promise<string | null> {
    const cached = this.ulidCache.get(accountUlid);

    if (cached !== undefined && Date.now() < cached.expiresAt) {
      this.logger.debug(`Account check: cache hit [accountUlid=${accountUlid} active=${cached.accountUlid !== null}]`);
      return cached.accountUlid;
    }

    const tableName = this.databaseConfig.conversationsTable;
    const pk = `A#${accountUlid}`;

    try {
      const result = await this.dynamoClient.send(
        new GetCommand({
          TableName: tableName,
          Key: { PK: pk, SK: pk },
        }),
      );

      const item = result.Item;

      if (!item || item.entity !== "ACCOUNT" || item.status?.is_active !== true) {
        this.ulidCache.set(accountUlid, { accountUlid: null, expiresAt: Date.now() + NEGATIVE_TTL_MS });
        this.logger.debug(`Account check: denied [accountUlid=${accountUlid}]`);
        return null;
      }

      this.ulidCache.set(accountUlid, { accountUlid, expiresAt: Date.now() + POSITIVE_TTL_MS });
      this.logger.debug(`Account check: resolved [accountUlid=${accountUlid}]`);
      return accountUlid;
    } catch (error: unknown) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      this.logger.error(`Account check: DynamoDB error [errorType=${errorName}]`);
      return null;
    }
  }
```

- [ ] **Step 4: Run the test and confirm green**

Run: `npx jest src/services/origin-allowlist.service.spec.ts -t "verifyAccountActive" --no-coverage`

Expected: PASS.

- [ ] **Step 5: Add remaining `verifyAccountActive` tests (inactive, missing, non-account, error, negative cache, positive-TTL expiry)**

Append these inside the same `describe("verifyAccountActive", ...)` block:

```ts
  it("returns null for an inactive account and caches with negative TTL", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { PK: `A#${ACCOUNT_ULID}`, SK: `A#${ACCOUNT_ULID}`, entity: "ACCOUNT", status: { is_active: false } },
    });

    const result = await service.verifyAccountActive(ACCOUNT_ULID);
    expect(result).toBeNull();

    ddbMock.reset();
    const result2 = await service.verifyAccountActive(ACCOUNT_ULID);
    expect(result2).toBeNull();
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it("returns null when no Item is found and caches with negative TTL", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const result = await service.verifyAccountActive(ACCOUNT_ULID);
    expect(result).toBeNull();

    ddbMock.reset();
    const result2 = await service.verifyAccountActive(ACCOUNT_ULID);
    expect(result2).toBeNull();
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it("returns null when Item exists but entity is not ACCOUNT (defensive)", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { PK: `A#${ACCOUNT_ULID}`, SK: `A#${ACCOUNT_ULID}`, entity: "SESSION", status: { is_active: true } },
    });

    const result = await service.verifyAccountActive(ACCOUNT_ULID);
    expect(result).toBeNull();
  });

  it("returns null and does NOT cache when DynamoDB throws", async () => {
    const dbError = Object.assign(new Error("Service unavailable"), { name: "ServiceUnavailableException" });
    ddbMock.on(GetCommand).rejects(dbError);

    const result = await service.verifyAccountActive(ACCOUNT_ULID);
    expect(result).toBeNull();

    // Next request must retry DynamoDB (no cache entry written)
    ddbMock.reset();
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    await service.verifyAccountActive(ACCOUNT_ULID);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(1);
  });

  it("re-queries DynamoDB after positive TTL (5 min) expires", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { PK: `A#${ACCOUNT_ULID}`, SK: `A#${ACCOUNT_ULID}`, entity: "ACCOUNT", status: { is_active: true } },
    });

    const dateSpy = jest.spyOn(Date, "now");
    dateSpy.mockReturnValue(1_000_000);

    await service.verifyAccountActive(ACCOUNT_ULID);

    dateSpy.mockReturnValue(1_000_000 + 5 * 60 * 1000 + 1);
    ddbMock.reset();
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    await service.verifyAccountActive(ACCOUNT_ULID);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(1);
  });

  it("uses GetCommand with Key { PK: A#<ulid>, SK: A#<ulid> } against the conversations table", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    await service.verifyAccountActive(ACCOUNT_ULID);

    const calls = ddbMock.commandCalls(GetCommand);
    expect(calls[0].args[0].input).toEqual({
      TableName: TABLE_NAME,
      Key: { PK: `A#${ACCOUNT_ULID}`, SK: `A#${ACCOUNT_ULID}` },
    });
  });
```

- [ ] **Step 6: Run the full `origin-allowlist.service.spec.ts` suite**

Run: `npx jest src/services/origin-allowlist.service.spec.ts --no-coverage`

Expected: all tests PASS (existing `resolveAccountForOrigin` tests + new `verifyAccountActive` tests).

- [ ] **Step 7: Commit Tasks 1–3 as a single unit**

The tree has been in a broken state since Task 1; `tsc` still fails at the controller. But the service-level changes are self-contained and the tests are all green for the new method. Commit them together with the schema and types so git history stays clean:

```bash
git add src/validation/web-chat.schema.ts src/types/WebChat.ts src/services/origin-allowlist.service.ts src/services/origin-allowlist.service.spec.ts
git commit -m "feat(web-chat): add verifyAccountActive lookup and accountUlid schema field"
```

Note: `tsc` is still broken at this commit (controller still references the old `body.hostDomain`). Task 4 fixes that immediately after. If that bothers you, squash Tasks 1–4 into one commit at the end instead.

---

### Task 4: Update `WebChatController` to use `body.accountUlid` (TDD)

**Files:**
- Modify: `src/controllers/web-chat.controller.ts`
- Test: `src/controllers/web-chat.controller.spec.ts`

- [ ] **Step 1: Rewrite the controller spec to match the new contract**

Replace `src/controllers/web-chat.controller.spec.ts` entirely with:

```ts
import { BadRequestException, InternalServerErrorException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";

import { AgentRegistryService } from "../agents/agent-registry.service";
import { ChatSessionService } from "../services/chat-session.service";
import { IdentityService } from "../services/identity.service";
import { OriginAllowlistService } from "../services/origin-allowlist.service";
import { ZodValidationPipe } from "../pipes/webChatValidation.pipe";
import { createSessionSchema, sendMessageSchema } from "../validation/web-chat.schema";
import { WebChatController } from "./web-chat.controller";

const VALID_GUEST_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const VALID_SESSION_ULID = "01BX5ZZKBKACTAV9WEVGEMMVS1";
const VALID_ACCOUNT_ULID = "01ACCOUNTULID00000000000000";
const VALID_ACCOUNT_ULID_WITH_PREFIX = `A#${VALID_ACCOUNT_ULID}`;
const AGENT_NAME = "lead_capture";

const mockIdentityService = {
  lookupOrCreateSession: jest.fn(),
};

const mockChatSessionService = {
  handleMessage: jest.fn(),
};

const mockAgentRegistry = {
  getByName: jest.fn(),
};

const mockOriginAllowlistService = {
  resolveAccountForOrigin: jest.fn(),
  verifyAccountActive: jest.fn(),
};

describe("WebChatController", () => {
  let controller: WebChatController;

  beforeEach(async () => {
    jest.clearAllMocks();

    mockOriginAllowlistService.verifyAccountActive.mockResolvedValue(VALID_ACCOUNT_ULID);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebChatController],
      providers: [
        { provide: IdentityService, useValue: mockIdentityService },
        { provide: ChatSessionService, useValue: mockChatSessionService },
        { provide: AgentRegistryService, useValue: mockAgentRegistry },
        { provide: OriginAllowlistService, useValue: mockOriginAllowlistService },
      ],
    }).compile();

    controller = module.get<WebChatController>(WebChatController);
  });

  describe("POST /sessions — createSession", () => {
    it("throws BadRequestException for unknown agentName without calling IdentityService", async () => {
      mockAgentRegistry.getByName.mockReturnValue(null);

      await expect(
        controller.createSession({
          agentName: "unknown_agent",
          guestUlid: VALID_GUEST_ULID,
          accountUlid: VALID_ACCOUNT_ULID_WITH_PREFIX,
        }),
      ).rejects.toThrow(BadRequestException);

      expect(mockIdentityService.lookupOrCreateSession).not.toHaveBeenCalled();
    });

    it("returns sessionUlid and displayName on valid request with displayName set", async () => {
      mockAgentRegistry.getByName.mockReturnValue({ name: AGENT_NAME, displayName: "Lead Capture Assistant" });
      mockIdentityService.lookupOrCreateSession.mockResolvedValue(VALID_SESSION_ULID);

      const result = await controller.createSession({
        agentName: AGENT_NAME,
        guestUlid: VALID_GUEST_ULID,
        accountUlid: VALID_ACCOUNT_ULID_WITH_PREFIX,
      });

      expect(result).toEqual({ sessionUlid: VALID_SESSION_ULID, displayName: "Lead Capture Assistant" });
      expect(mockIdentityService.lookupOrCreateSession).toHaveBeenCalledWith(
        "web",
        VALID_GUEST_ULID,
        AGENT_NAME,
        VALID_ACCOUNT_ULID,
      );
    });

    it("falls back to agent.name when displayName is not set", async () => {
      mockAgentRegistry.getByName.mockReturnValue({ name: AGENT_NAME, displayName: undefined });
      mockIdentityService.lookupOrCreateSession.mockResolvedValue(VALID_SESSION_ULID);

      const result = await controller.createSession({
        agentName: AGENT_NAME,
        guestUlid: VALID_GUEST_ULID,
        accountUlid: VALID_ACCOUNT_ULID_WITH_PREFIX,
      });

      expect(result.displayName).toBe(AGENT_NAME);
    });

    it("strips the A# prefix from body.accountUlid before calling verifyAccountActive", async () => {
      mockAgentRegistry.getByName.mockReturnValue({ name: AGENT_NAME, displayName: "X" });
      mockIdentityService.lookupOrCreateSession.mockResolvedValue(VALID_SESSION_ULID);

      await controller.createSession({
        agentName: AGENT_NAME,
        guestUlid: VALID_GUEST_ULID,
        accountUlid: VALID_ACCOUNT_ULID_WITH_PREFIX,
      });

      expect(mockOriginAllowlistService.verifyAccountActive).toHaveBeenCalledWith(VALID_ACCOUNT_ULID);
      expect(mockOriginAllowlistService.verifyAccountActive).not.toHaveBeenCalledWith(VALID_ACCOUNT_ULID_WITH_PREFIX);
    });

    it("throws InternalServerErrorException when verifyAccountActive returns null", async () => {
      mockAgentRegistry.getByName.mockReturnValue({ name: AGENT_NAME, displayName: "X" });
      mockOriginAllowlistService.verifyAccountActive.mockResolvedValue(null);

      await expect(
        controller.createSession({
          agentName: AGENT_NAME,
          guestUlid: VALID_GUEST_ULID,
          accountUlid: VALID_ACCOUNT_ULID_WITH_PREFIX,
        }),
      ).rejects.toThrow(InternalServerErrorException);

      expect(mockIdentityService.lookupOrCreateSession).not.toHaveBeenCalled();
    });

    it("pipe rejects body missing accountUlid", () => {
      const pipe = new ZodValidationPipe(createSessionSchema);

      expect(() =>
        pipe.transform({ agentName: AGENT_NAME, guestUlid: VALID_GUEST_ULID }),
      ).toThrow(BadRequestException);
    });

    it("pipe rejects accountUlid missing the A# prefix", () => {
      const pipe = new ZodValidationPipe(createSessionSchema);

      expect(() =>
        pipe.transform({ agentName: AGENT_NAME, guestUlid: VALID_GUEST_ULID, accountUlid: VALID_ACCOUNT_ULID }),
      ).toThrow(BadRequestException);
    });

    it("pipe rejects accountUlid with a wrong-length ULID segment", () => {
      const pipe = new ZodValidationPipe(createSessionSchema);

      expect(() =>
        pipe.transform({ agentName: AGENT_NAME, guestUlid: VALID_GUEST_ULID, accountUlid: "A#TOO_SHORT" }),
      ).toThrow(BadRequestException);
    });

    it("pipe rejects invalid guestUlid shape", () => {
      const pipe = new ZodValidationPipe(createSessionSchema);

      expect(() =>
        pipe.transform({
          agentName: AGENT_NAME,
          guestUlid: "not-a-ulid",
          accountUlid: VALID_ACCOUNT_ULID_WITH_PREFIX,
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe("POST /messages — sendMessage", () => {
    it("returns reply on valid request", async () => {
      mockChatSessionService.handleMessage.mockResolvedValue("Hello from the assistant.");

      const result = await controller.sendMessage({ sessionUlid: VALID_SESSION_ULID, message: "Hi there" });

      expect(result).toEqual({ reply: "Hello from the assistant." });
      expect(mockChatSessionService.handleMessage).toHaveBeenCalledWith(VALID_SESSION_ULID, "Hi there");
    });

    it("throws BadRequestException for empty message (pipe)", () => {
      const pipe = new ZodValidationPipe(sendMessageSchema);

      expect(() =>
        pipe.transform({ sessionUlid: VALID_SESSION_ULID, message: "" }),
      ).toThrow(BadRequestException);
    });
  });
});
```

- [ ] **Step 2: Run the controller spec to confirm it fails (controller signature still takes `origin`)**

Run: `npx jest src/controllers/web-chat.controller.spec.ts --no-coverage`

Expected: the tests compile and run but FAIL because `controller.createSession` still takes a `(origin, body)` signature. You'll see errors like `Cannot read properties of undefined` or mismatched mock expectations.

- [ ] **Step 3: Rewrite the controller to drop `hostDomain`/origin fallback and use `body.accountUlid`**

Replace `src/controllers/web-chat.controller.ts` entirely with:

```ts
import { BadRequestException, Body, Controller, InternalServerErrorException, Logger, Post } from "@nestjs/common";

import { AgentRegistryService } from "../agents/agent-registry.service";
import { ZodValidationPipe } from "../pipes/webChatValidation.pipe";
import { ChatSessionService } from "../services/chat-session.service";
import { IdentityService } from "../services/identity.service";
import { OriginAllowlistService } from "../services/origin-allowlist.service";
import { WebChatCreateSessionResponse, WebChatSendMessageResponse } from "../types/WebChat";
import { createSessionSchema, sendMessageSchema } from "../validation/web-chat.schema";
import type { CreateSessionBody, SendMessageBody } from "../validation/web-chat.schema";

@Controller("chat/web")
export class WebChatController {
  private readonly logger = new Logger(WebChatController.name);

  constructor(
    private readonly identityService: IdentityService,
    private readonly chatSessionService: ChatSessionService,
    private readonly agentRegistry: AgentRegistryService,
    private readonly originAllowlistService: OriginAllowlistService,
  ) {}

  @Post("sessions")
  async createSession(
    @Body(new ZodValidationPipe(createSessionSchema)) body: CreateSessionBody,
  ): Promise<WebChatCreateSessionResponse> {
    const agent = this.agentRegistry.getByName(body.agentName);

    if (agent === null) {
      throw new BadRequestException(`Unknown agent: ${body.agentName}`);
    }

    // Schema guarantees body.accountUlid matches /^A#<26-char-ulid>$/; strip
    // the "A#" so downstream services receive the raw ULID. The prefix exists
    // only in the embed snippet and on the wire.
    const rawAccountUlid = body.accountUlid.slice(2);

    const accountUlid = await this.originAllowlistService.verifyAccountActive(rawAccountUlid);

    if (accountUlid === null) {
      throw new InternalServerErrorException("Unable to resolve account for request.");
    }

    const sessionUlid = await this.identityService.lookupOrCreateSession("web", body.guestUlid, body.agentName, accountUlid);
    const displayName = agent.displayName ?? agent.name;

    this.logger.debug(
      `Session created [agentName=${body.agentName} sessionUlid=${sessionUlid} accountUlid=${accountUlid} source=accountUlid]`,
    );

    return { sessionUlid, displayName };
  }

  @Post("messages")
  async sendMessage(
    @Body(new ZodValidationPipe(sendMessageSchema)) body: SendMessageBody,
  ): Promise<WebChatSendMessageResponse> {
    const reply = await this.chatSessionService.handleMessage(body.sessionUlid, body.message);

    this.logger.debug(`Message handled [sessionUlid=${body.sessionUlid}]`);

    return { reply };
  }
}
```

- [ ] **Step 4: Run the controller spec to confirm green**

Run: `npx jest src/controllers/web-chat.controller.spec.ts --no-coverage`

Expected: all tests PASS.

- [ ] **Step 5: Run `tsc` to confirm the whole tree typechecks**

Run: `npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`

Expected: every suite PASSES. If anything else in the repo referenced `hostDomain` (search: `grep -r hostDomain src/`), it will have surfaced here — fix and rerun.

- [ ] **Step 7: Commit Task 4**

```bash
git add src/controllers/web-chat.controller.ts src/controllers/web-chat.controller.spec.ts
git commit -m "feat(web-chat): swap hostDomain body field for accountUlid on session create"
```

---

### Task 5: Local smoke test against a real DynamoDB account

**Files:** none modified — this task verifies the change works end-to-end against a real DynamoDB document.

- [ ] **Step 1: Start the backend in dev mode**

Run: `npm run start:dev`

Expected: logs show `Application listening on port 8081` (or the configured port).

- [ ] **Step 2: Send a `createSession` request with a valid account ULID**

In a second terminal, replace `<ULID>` below with a real active account ULID from your dev DynamoDB (the frontend logs showed `A#01K2XR5G6G22TB71SJCA823ESB` — use that one if it is still active):

```bash
curl -i -X POST http://localhost:8081/chat/web/sessions \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d '{"agentName":"shopping_assistant","guestUlid":"01ARZ3NDEKTSV4RRFFQ69G5FAV","accountUlid":"A#<ULID>"}'
```

Expected: `HTTP/1.1 201 Created` with a JSON body containing `sessionUlid` and `displayName`. The backend log should include `Account check: resolved [accountUlid=<ULID>]` and `Session created [... source=accountUlid]`.

- [ ] **Step 3: Send a request with an invalid account ULID to confirm rejection**

```bash
curl -i -X POST http://localhost:8081/chat/web/sessions \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d '{"agentName":"shopping_assistant","guestUlid":"01ARZ3NDEKTSV4RRFFQ69G5FAV","accountUlid":"A#00000000000000000000000000"}'
```

Expected: `HTTP/1.1 500 Internal Server Error` with `"Unable to resolve account for request."`. Log: `Account check: denied [accountUlid=00000000000000000000000000]`.

- [ ] **Step 4: Send a request missing `accountUlid` to confirm schema rejection**

```bash
curl -i -X POST http://localhost:8081/chat/web/sessions \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d '{"agentName":"shopping_assistant","guestUlid":"01ARZ3NDEKTSV4RRFFQ69G5FAV"}'
```

Expected: `HTTP/1.1 400 Bad Request` with a Zod validation error citing `accountUlid`.

- [ ] **Step 5: Send the same active-ULID request twice to confirm cache hit on the second call**

Repeat the Step 2 curl command a second time. In the backend log, the second request should show `Account check: cache hit [accountUlid=<ULID> active=true]` instead of `resolved`. This confirms `ulidCache` is wired correctly.

- [ ] **Step 6: Stop the dev server; no code commit for this task.**

---

## Self-Review Checklist

Before handing off:

- [ ] Every spec requirement maps to a task (schema swap → Task 1; types → Task 2; service method → Task 3; controller rewrite → Task 4; smoke test → Task 5).
- [ ] No placeholders (`TODO`, `TBD`, "add error handling", "similar to above") anywhere in the plan.
- [ ] Method names and signatures match across tasks: `verifyAccountActive(accountUlid: string): Promise<string | null>` is used consistently in Task 3's implementation, Task 4's controller, and Task 4's spec mock.
- [ ] The `A#` prefix handling is explicit: schema allows it (Task 1), controller strips it (Task 4), service receives the raw ULID (Task 3).
- [ ] CORS middleware in `main.ts` is untouched — out-of-scope note is honored.
- [ ] No Referer / CSP work in this plan — deferred per the project memory.
