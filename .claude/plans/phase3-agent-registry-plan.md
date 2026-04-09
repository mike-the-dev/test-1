# Phase 3 — AgentRegistry with Auto-Discovery and the LeadCaptureAgent

## Objective

Introduce a `ChatAgent` abstraction so that each chat session is bound to a named, purpose-specific agent configuration. Each agent defines a system prompt and an `allowedToolNames` whitelist. Build `AgentRegistryService` to auto-discover agents exactly as `ToolRegistryService` discovers tools (NestJS `DiscoveryService` + `Reflector`, `onModuleInit`, `@ChatAgentProvider()` decorator). Build `LeadCaptureAgent` as the first concrete agent. Rewire `ChatSessionService` to load the bound agent from session metadata, use the agent's system prompt, and filter the tool definitions passed to Anthropic to only those in the agent's allowlist. Persist the agent name on session creation via `IdentityService`; read it back in `ChatSessionService`. Default to `"lead_capture"` for backward compatibility with pre-phase-3 sessions that have no `agentName` attribute in DynamoDB.

---

## Affected Files and Modules

### Create
- `src/types/ChatAgent.ts` — new `ChatAgent` interface
- `src/agents/chat-agent.decorator.ts` — `@ChatAgentProvider()` marker decorator
- `src/agents/lead-capture.agent.ts` — first concrete agent implementation
- `src/agents/agent-registry.service.ts` — auto-discovery registry, mirrors `ToolRegistryService`

### Modify
- `src/types/ChatSession.ts` — add optional `agentName?: string` to `ChatSessionMetadataRecord`
- `src/services/identity.service.ts` — add `defaultAgentName: string` third parameter to `lookupOrCreateSession`; persist it to metadata on new session creation only
- `src/services/discord.service.ts` — pass `"lead_capture"` as the third argument to `lookupOrCreateSession` at both call sites; define `const DISCORD_DEFAULT_AGENT_NAME = "lead_capture"` at the top of the file
- `src/services/chat-session.service.ts` — inject `AgentRegistryService`; load agent from session metadata; replace hardcoded `SYSTEM_PROMPT` constant with agent's prompt; filter tool definitions by `allowedToolNames`; add defense-in-depth allowlist check inside the tool loop; add agent resolution log line
- `src/app.module.ts` — import and register `AgentRegistryService` and `LeadCaptureAgent` as providers
- `src/services/chat-session.service.spec.ts` — update to mock `AgentRegistryService`, stub the new `GetCommand` for metadata lookup, and update the `mockToolRegistry.getDefinitions` assertions to account for filtering
- `src/services/identity.service.spec.ts` — update all `lookupOrCreateSession` call sites to pass a third argument (`"lead_capture"` or any test string); add a test verifying `agentName` is written to the metadata `UpdateCommand`

### Delete
- Nothing is deleted. The hardcoded `SYSTEM_PROMPT` constant in `chat-session.service.ts` is removed as dead code when the agent-based prompt replaces it.

### Review Only
- `src/tools/tool-registry.service.ts` — canonical pattern to replicate
- `src/tools/chat-tool.decorator.ts` — canonical decorator pattern to replicate
- `src/tools/save-user-fact.tool.ts` — canonical `@ChatToolProvider()` usage example
- `src/types/Tool.ts` — reference for how the parallel `ChatAgent` interface should be structured

---

## Dependencies and Architectural Considerations

### External libraries / APIs
- No new npm packages. `DiscoveryService` and `Reflector` are already available from `@nestjs/core` (already imported in `ToolRegistryService`). `GetCommand` is already available from `@aws-sdk/lib-dynamodb` (already imported in `IdentityService`).

### Internal service dependencies
- `AgentRegistryService` depends on `DiscoveryService` and `Reflector` — both already wired via `DiscoveryModule` in `app.module.ts`.
- `ChatSessionService` gains a new dependency on `AgentRegistryService`. No circular dependency risk.
- `IdentityService` gains a new parameter on its public method — both callers (`DiscordService` at two call sites in the raw-packet handler and `messageCreate` handler) must be updated together.

### DynamoDB schema
- `ChatSessionMetadataRecord` (`PK: CHAT_SESSION#<ulid>`, `SK: METADATA`) gains a new optional string attribute `agentName`.
- New sessions will have it set by `IdentityService` at creation time via the existing `UpdateCommand` (add `agentName` to the `SET` expression and `ExpressionAttributeValues`).
- Existing sessions without `agentName` are handled in `ChatSessionService` by defaulting to `"lead_capture"`.
- No DynamoDB migration required — the attribute is additive and optional.

### Configuration / environment variables
- None. Agent names are code constants, not environment config.

### Backward compatibility
- Sessions in DynamoDB created before Phase 3 have no `agentName` attribute. `ChatSessionService` must handle a missing or undefined value by defaulting to `"lead_capture"` before querying `AgentRegistryService`.
- The `ToolRegistryService` is not modified. It continues to hold all three tool registrations and its `getDefinitions()` output is the full list that `ChatSessionService` then filters down.

### `as const` prohibition
- The style enforcer explicitly bans all `as` type assertions including `as const` (style-enforcer.md line 33).
- `LeadCaptureAgent.allowedToolNames` must use the explicit readonly annotation form: `readonly allowedToolNames: readonly string[] = ["collect_contact_info", "send_email"]`.

---

## Step-by-Step Implementation Sequence

```
1. [File: src/types/ChatAgent.ts] — Create the ChatAgent interface

   What: Export a `ChatAgent` interface with four readonly members:
     - `name: string` (snake_case agent identifier)
     - `description: string` (human-readable summary)
     - `systemPrompt: string` (full prompt sent to Claude)
     - `allowedToolNames: readonly string[]` (tool name whitelist)
   Add a doc comment stating: "Each registered agent is a contract: the registry trusts that any provider
   marked with @ChatAgentProvider() implements this interface correctly."

   Why first: All downstream files (decorator, agent class, registry, service) depend on this type.

   Done when: `npx tsc --noEmit` compiles cleanly on this file alone; no type errors.

2. [File: src/types/ChatSession.ts] — Add optional agentName to ChatSessionMetadataRecord

   What: Add `agentName?: string` as an optional field on the `ChatSessionMetadataRecord` interface.
   Keep it optional so existing DynamoDB records without the attribute deserialize cleanly.

   Why here: Must exist before `IdentityService` and `ChatSessionService` reference the attribute name
   in their DynamoDB operations. Changing the type first ensures compile-time safety.

   Done when: `ChatSessionMetadataRecord` has `agentName?: string`; TypeScript compiles cleanly.

3. [File: src/agents/chat-agent.decorator.ts] — Create the @ChatAgentProvider() marker decorator

   What: Mirror `src/tools/chat-tool.decorator.ts` exactly:
     - Export `CHAT_AGENT_METADATA = "chat_agent"` string constant
     - Export `ChatAgentProvider = () => SetMetadata(CHAT_AGENT_METADATA, true)`
   Add the doc comment verbatim from the spec:
   "Marks a class as a chat agent that will be auto-discovered by AgentRegistryService during
   onModuleInit. Any class decorated with @ChatAgentProvider() and added to AppModule providers
   will be collected and made available through the agent registry."

   Why here: The agent class (step 4) and registry (step 5) both import from this file; it must exist first.

   Done when: File compiles; `CHAT_AGENT_METADATA` is exported; `ChatAgentProvider` returns a decorator factory.

4. [File: src/agents/lead-capture.agent.ts] — Create the LeadCaptureAgent class

   What:
   - Apply `@ChatAgentProvider()` first, then `@Injectable()` (decorator order matters — same as `SaveUserFactTool` pattern with `@ChatToolProvider()` then `@Injectable()`)
   - Implement `ChatAgent` interface
   - `readonly name = "lead_capture"`
   - `readonly description = "Collects visitor contact information and sends a confirmation email summarizing the collected details."`
   - `readonly systemPrompt` — a multi-line template literal string. Copy the EXACT content from
     PROMPT_DISCOVERY_SERVICE.md lines 82–113 verbatim. Do NOT summarize, shorten, or paraphrase.
     The prompt is the product of careful prompt engineering.
   - `readonly allowedToolNames: readonly string[] = ["collect_contact_info", "send_email"]`
     NOTE: Do NOT use `as const` — it is prohibited by the style enforcer.
     Use the explicit readonly type annotation instead.
   - Empty constructor (no injected dependencies; agent is a pure configuration object)

   Why here: The registry (step 5) will discover this class. It must be compilable before the registry
   is written to avoid import errors. The agent class has no dependencies of its own.

   Done when: Class compiles, implements `ChatAgent` fully, `allowedToolNames` has no `as const`.

5. [File: src/agents/agent-registry.service.ts] — Create the AgentRegistryService

   What: Mirror `src/tools/tool-registry.service.ts` exactly, substituting agent concepts for tool concepts:
   - `@Injectable()` class implementing `OnModuleInit`
   - Constructor injects `DiscoveryService` and `Reflector`
   - `private agents: ChatAgent[] = []`
   - `private readonly logger = new Logger(AgentRegistryService.name)`
   - `onModuleInit(): void` with the same readable multi-stage filter chain as `ToolRegistryService`:
     1. `const wrappers = this.discoveryService.getProviders()`
     2. `const agentWrappers = wrappers.filter(...)` — filter to defined `metatype` AND `reflector.get(CHAT_AGENT_METADATA, metatype) === true`
     3. `const discovered = agentWrappers.map((wrapper) => wrapper.instance)`
     4. `const validInstances = discovered.filter((instance) => instance !== null && instance !== undefined)`
     5. `this.agents = validInstances`
     6. Log: `Discovered chat agents [count=<n> names=<comma-separated names>]`
     7. If count === 0, log warn: "No chat agents discovered. Verify that agent classes are decorated with @ChatAgentProvider() and registered in AppModule providers."
   - `getAll(): ChatAgent[]` — returns `this.agents`
   - `getByName(name: string): ChatAgent | null` — returns matching agent or null (do NOT throw on not-found)
   - No `as` casts anywhere

   Why here: Depends on `ChatAgent` type (step 1) and `CHAT_AGENT_METADATA` (step 3). Must exist before
   `ChatSessionService` (step 7) can inject it.

   Done when: Service compiles; `getByName` returns null for unknown names; mirrors `ToolRegistryService` structure.

6. [File: src/services/identity.service.ts] — Add defaultAgentName parameter

   What:
   - Update `lookupOrCreateSession(source: string, externalId: string): Promise<string>` signature to
     `lookupOrCreateSession(source: string, externalId: string, defaultAgentName: string): Promise<string>`
   - The new parameter is used ONLY in the new-session branch (cache miss path)
   - In the existing `UpdateCommand` for the metadata record, add `agentName` to the `SET` expression:
     - Add `, agentName = if_not_exists(agentName, :agentName)` to the `UpdateExpression`
     - Add `":agentName": defaultAgentName` to `ExpressionAttributeValues`
   - The `satisfies ChatSessionMetadataRecord` constraint on `metadataItem` now covers `agentName`
     since step 2 made it optional — the satisfies check will still compile cleanly
   - Do NOT touch the existing-session (cache hit) branch — agent name on existing sessions is immutable

   Why here: Depends on `ChatSessionMetadataRecord` having `agentName?` (step 2). Must be updated before
   `DiscordService` (step 7) calls it with the new signature.

   Done when: Method signature updated; `agentName` written to DynamoDB `UpdateCommand` on new sessions only; TypeScript compiles.

7. [File: src/services/discord.service.ts] — Pass default agent name to identityService

   What:
   - Add `const DISCORD_DEFAULT_AGENT_NAME = "lead_capture";` near the top of the file (after imports,
     before the class declaration)
   - Update BOTH `lookupOrCreateSession` call sites in `onModuleInit` (raw-packet DM handler AND
     `messageCreate` guild message handler) to pass `DISCORD_DEFAULT_AGENT_NAME` as the third argument:
     `await this.identityService.lookupOrCreateSession("discord", authorId, DISCORD_DEFAULT_AGENT_NAME)`
   - No other changes

   Why here: Depends on `IdentityService` (step 6) accepting the new parameter. Both call sites must be
   updated atomically to avoid TypeScript errors.

   Done when: Both call sites pass three arguments; TypeScript compiles with no errors.

8. [File: src/services/chat-session.service.ts] — Wire agent resolution and tool filtering

   What (detailed):

   a) Add `AgentRegistryService` to constructor injection:
      ```
      constructor(
        @Inject(DYNAMO_DB_CLIENT) private readonly dynamoDb: DynamoDBDocumentClient,
        private readonly anthropicService: AnthropicService,
        private readonly databaseConfig: DatabaseConfigService,
        private readonly toolRegistry: ToolRegistryService,
        private readonly agentRegistry: AgentRegistryService,
      ) {}
      ```

   b) Add import for `GetCommand` from `@aws-sdk/lib-dynamodb` (it is not yet imported here).

   c) Remove the `SYSTEM_PROMPT` constant entirely (lines 17-18 in current file). It is now dead code.

   d) At the start of `handleMessage`, BEFORE loading message history, add an agent resolution block:
      - Issue a `GetCommand` for `{ PK: "CHAT_SESSION#<sessionUlid>", SK: "METADATA" }` against the
        conversations table
      - Extract `agentName` from `result.Item?.agentName`. If missing, undefined, or empty string,
        set `agentName = "lead_capture"` (backward compatibility default)
      - Call `this.agentRegistry.getByName(agentName)` to resolve the agent config
      - If null: log warn `Agent not found, falling back to default [sessionUlid=... agentName=...]`,
        then try `this.agentRegistry.getByName("lead_capture")`
      - If the fallback is ALSO null: throw a fatal Error — "AgentRegistryService has no lead_capture agent registered. This is a misconfiguration."
      - Log at `log` level: `Agent resolved [sessionUlid=<sessionUlid> agentName=<agent.name> toolCount=<filteredCount>]`
        NOTE: log toolCount AFTER filtering (see step e). This log line must come before the tool loop
        but after filtering is computed.

   e) Build filtered tool definitions:
      - `const allDefinitions = this.toolRegistry.getDefinitions()`
      - `const filteredDefinitions = allDefinitions.filter((def) => agent.allowedToolNames.includes(def.name))`
      - Replace `const toolDefinitions = this.toolRegistry.getDefinitions()` (current line 94) with the
        above two lines.
      - Pass `filteredDefinitions` to `anthropicService.sendMessage(...)` on every loop iteration
        (current code already passes `toolDefinitions` — just rename/replace the variable)

   f) Add defense-in-depth check inside the tool loop, before dispatching to `toolRegistry.execute`:
      In the `toolUseBlocks.map(async (block) => {...})` callback, before calling
      `this.toolRegistry.execute(block.name, ...)`:
      - Check `if (!agent.allowedToolNames.includes(block.name))`:
        - Log warn: `Tool not in agent allowlist [sessionUlid=... agentName=... toolName=...]`
        - Return `buildToolResultBlock(block.id, "Tool not available for this agent: " + block.name, true)`
        - Do NOT call `toolRegistry.execute`
      - If it passes, call `toolRegistry.execute` as before

   g) The agent resolution log line (step d) should log `toolCount` — compute it after filtering:
      `this.logger.log('Agent resolved [sessionUlid=${sessionUlid} agentName=${agent.name} toolCount=${filteredDefinitions.length}]')`

   Privacy rules:
   - Do NOT log systemPrompt, agent.description, tool names, tool input/output, or user message content
   - Log only: sessionUlid, agentName, toolCount, iteration counts, timings

   Why here: Depends on `AgentRegistryService` existing (step 5) and `ChatAgent` type (step 1).
   This is the most involved change and must be last among service changes.

   Done when:
   - `SYSTEM_PROMPT` constant is gone
   - Agent resolved from DynamoDB metadata before the tool loop
   - `filteredDefinitions` passed to every `sendMessage` call
   - Defense-in-depth check present in tool loop
   - Agent resolution log line present
   - TypeScript compiles cleanly

9. [File: src/app.module.ts] — Register new providers

   What:
   - Add imports at top:
     `import { AgentRegistryService } from "./agents/agent-registry.service";`
     `import { LeadCaptureAgent } from "./agents/lead-capture.agent";`
   - Add `LeadCaptureAgent` and `AgentRegistryService` to the `providers` array
   - No other changes (DiscoveryModule is already imported; no new modules needed)

   Why last among production code: All implementation files must exist and compile before the module
   wires them together.

   Done when: Module compiles; `npm run start:dev` shows both discovery log lines on startup.

10. [File: src/services/identity.service.spec.ts] — Update tests for new signature

    What:
    - All existing `service.lookupOrCreateSession("discord", "...")` calls must gain a third argument.
      Use `"lead_capture"` as the value (or any string — only the schema matters for most tests)
    - Add one new test asserting that on a cache miss, the `UpdateCommand` for the metadata record
      includes `agentName` in the `SET` expression and the correct value in `ExpressionAttributeValues`
    - The test "writes the initial METADATA record with source on a cache miss" can be extended or
      duplicated to cover `agentName` persistence

    Done when: All identity service tests pass with the updated signature.

11. [File: src/services/chat-session.service.spec.ts] — Update tests for agent resolution

    What:
    - Add a mock for `AgentRegistryService`:
      ```
      const mockAgentRegistry = {
        getByName: jest.fn(),
      };
      ```
    - Add `AgentRegistryService` to the `TestingModule` providers with `useValue: mockAgentRegistry`
    - In `beforeEach`, set up `mockAgentRegistry.getByName` to return a stub agent with:
      - `name: "lead_capture"`
      - `allowedToolNames: ["save_user_fact", "collect_contact_info", "send_email"]` (all three, so
        existing tool-use tests do not break due to filtering)
      - `systemPrompt: "test prompt"`
    - Add a `GetCommand` mock stub for the metadata lookup (return `{ Item: { agentName: "lead_capture" } }`).
      This requires importing `GetCommand` into the spec and configuring `ddbMock.on(GetCommand)`.
    - NOTE: The existing test "passes tool definitions from ToolRegistry to each Anthropic call" asserts
      `calledTools === fakeDefs` (reference equality). After the change, `ChatSessionService` filters the
      definitions, so `calledTools` will be a new array. Update this test to assert the filtered content
      matches rather than using `toBe`. Since the stub agent allows all three tool names and the mock
      returns `fakeDefs`, the test can instead assert `expect(calledTools).toEqual(fakeDefs)`.
    - All other existing tests should pass without change once the `GetCommand` stub and `AgentRegistryService`
      mock are added.

    Done when: All 39 existing tests pass; no regressions.
```

---

## Risks and Edge Cases

### High

**1. Missing agentName in DynamoDB metadata (pre-Phase-3 sessions)**
- Impact: `ChatSessionService` receives `undefined` from `result.Item?.agentName`. If not handled,
  `agentRegistry.getByName(undefined)` will return null and the service will error.
- Mitigation: Explicitly check for missing/undefined/empty before calling `getByName`. Default to
  `"lead_capture"` unconditionally when the attribute is absent.

**2. Agent name in metadata does not match any registered agent**
- Impact: `getByName` returns null; if not handled, subsequent property access throws.
- Mitigation: Two-step fallback: warn and try `"lead_capture"`. If that also returns null, throw a
  fatal error with a clear misconfiguration message. This prevents silent failures where Claude
  receives no system prompt.

**3. `ChatSessionService` spec reference-equality assertion on tool definitions**
- Impact: The test `expect(calledTools).toBe(fakeDefs)` will fail because filtering produces a new
  array even when all tools pass the filter.
- Mitigation: Update the assertion to `toEqual` (deep equality). Documented in step 11.

**4. Two `lookupOrCreateSession` call sites in `discord.service.ts`**
- Impact: If only one call site is updated, TypeScript will error on the other. Easy to miss the
  raw-packet DM handler since it's separate from the `messageCreate` handler.
- Mitigation: Step 7 explicitly calls out BOTH call sites. The implementing agent must update both.

### Medium

**5. Defense-in-depth check could break multi-tool responses**
- Impact: If Claude returns a tool_use block for a disallowed tool alongside allowed ones in the same
  response, the current design returns an error result for the disallowed tool and proceeds normally
  for allowed ones. This is the intended behavior (return error tool_result, do not execute).
- Mitigation: The `toolUseBlocks.map` already handles each block independently. The defense-in-depth
  check replaces the `execute` call with an error result for that specific block only.

**6. Empty allowedToolNames array**
- Impact: A future agent with `allowedToolNames: []` would pass the filter with zero definitions.
  Anthropic API call with empty tools array is valid (Claude responds as a pure text model).
- Mitigation: No mitigation needed — this is valid and intentional behavior per the spec.

**7. `satisfies ChatSessionMetadataRecord` in IdentityService may need updating**
- Impact: The `metadataItem` object is constructed and then used in the `satisfies` check. However,
  `agentName` is NOT set on `metadataItem` itself — it is passed to the `UpdateCommand` via
  `ExpressionAttributeValues`. Since `agentName` is optional on `ChatSessionMetadataRecord`, the
  `satisfies` check will continue to compile without `agentName` on the literal. No code change needed
  to the `metadataItem` literal itself.
- Note: The `UpdateCommand` `SET` expression must be updated to include `agentName` even though
  `metadataItem` does not carry it.

### Low

**8. Decorator order on LeadCaptureAgent**
- Impact: If `@Injectable()` is applied before `@ChatAgentProvider()`, the NestJS Reflector may not
  find the metadata correctly in all edge cases.
- Mitigation: The spec and the `SaveUserFactTool` example both show `@ChatToolProvider()` first, then
  `@Injectable()`. Follow the same order: `@ChatAgentProvider()` then `@Injectable()`.

**9. Agent names are stringly-typed**
- Impact: Typos in `"lead_capture"` across `LeadCaptureAgent.name`, `IdentityService` default, and
  `ChatSessionService` fallback will silently mismatch at runtime.
- Mitigation: The hardcoded default `"lead_capture"` appears in three places: `LeadCaptureAgent.name`,
  the fallback in `ChatSessionService`, and `DISCORD_DEFAULT_AGENT_NAME`. A future refactor could
  export a constant from `lead-capture.agent.ts` for reuse, but that is out of scope for this phase.

---

## Testing Strategy

### Unit tests (automated, part of `npm test`)

**identity.service.spec.ts updates (step 10):**
- Update all existing `lookupOrCreateSession` call signatures to three arguments
- Add: "writes agentName to the METADATA UpdateCommand on a cache miss" — assert that the
  `UpdateCommand` `ExpressionAttributeValues` includes `":agentName"` and the value equals the
  third argument passed

**chat-session.service.spec.ts updates (step 11):**
- Add `AgentRegistryService` mock to test module
- Add `GetCommand` stub returning `{ Item: { agentName: "lead_capture" } }`
- Update the `toBe(fakeDefs)` assertion to `toEqual(fakeDefs)`
- Optionally add: "returns error tool_result for tool not in agent allowlist" — set the mock agent
  `allowedToolNames` to `["collect_contact_info"]`, mock Anthropic to return a `tool_use` block for
  `"save_user_fact"`, assert that `toolRegistry.execute` is NOT called and the second Anthropic call
  receives a tool_result with `is_error: true`

**Baseline:** All 39 existing tests must continue to pass.

### Manual end-to-end verification (post-implementation, run by the user)

Follow the 17-step verification sequence in PROMPT_DISCOVERY_SERVICE.md (lines 282–323) exactly.
Critical checkpoints:
1. Startup logs show `[AgentRegistryService] Discovered chat agents [count=1 names=lead_capture]`
2. First Discord message logs `Agent resolved [sessionUlid=... agentName=lead_capture toolCount=2]`
   — `toolCount=2` is the critical assertion (not 3)
3. Claude responds in-character as a lead capture assistant
4. `save_user_fact` is never dispatched for a `lead_capture` session
5. DynamoDB `CHAT_SESSION#<ulid>` / `METADATA` record has `agentName: "lead_capture"`
6. No `USER_FACT#*` records appear

---

## Implementation Recommendations

**Follow the ToolRegistryService pattern with zero deviation.** The `AgentRegistryService` should read as a near-copy of `ToolRegistryService` with `Tool` → `Agent` substitutions. Reviewers will compare them side by side — any structural divergence will be flagged.

**Agent system prompt: copy verbatim.** The content in PROMPT_DISCOVERY_SERVICE.md lines 82–113 is the exact prompt. Copy it character-for-character as a multi-line template literal. Do not reformat, reword, or shorten any section. The spec is explicit on this point.

**Do not use `as const`.** Style enforcer bans all `as` assertions including `as const`. Use `readonly allowedToolNames: readonly string[] = [...]`.

**The `ChatSessionService` metadata GetCommand is a NEW DynamoDB call per message.** It fetches `PK: CHAT_SESSION#<sessionUlid>`, `SK: METADATA`. This is separate from the `QueryCommand` that loads message history. The spec acknowledges this extra call is acceptable. In tests, `ddbMock.on(GetCommand)` must be stubbed or the tests will fail on unmocked calls.

**Update both Discord call sites.** `discord.service.ts` has two separate `lookupOrCreateSession` calls — one in the `raw` packet handler (for DMs) and one in the `messageCreate` handler (for guild messages). Both must receive `DISCORD_DEFAULT_AGENT_NAME` as the third argument.

**Incremental compilation check.** After each file is written (steps 1–9), run `npx tsc --noEmit` to catch integration errors early rather than accumulating them.

**No new folders needed.** The `src/agents/` folder is new. Create it when writing the first file in step 3. The `src/types/` folder already exists; `src/services/` already exists.
