TASK OVERVIEW
Task name: Per-agent onboarding configuration (splash screen opt-in/opt-out)

Objective:
Make the splash + onboarding flow agent-driven. Today the embed always renders a splash that collects `budgetCents` regardless of which agent is selected — that made sense when `shopping_assistant` was the only production agent but is wrong for `lead_capture` (no use for budget) and any future agent that doesn't need pre-chat data collection. After this task, each `ChatAgent` declares its own splash configuration (one or more typed input fields, or `null` for no splash); the backend serves that contract through `POST /chat/web/sessions`; the embed renders accordingly; and a per-request Zod schema is dynamically derived from the agent's declared fields to validate the onboarding submission.

Relevant context:
- Affected core types: `src/types/ChatAgent.ts`, `src/types/SplashConfig.ts` (new), `src/types/OnboardingField.ts` (new), `src/types/ChatSession.ts`, `src/types/WebChat.ts`
- Affected services: `src/services/session.service.ts` (DDB read/write of `onboarding_data` map instead of `budget_cents` column), `src/services/anthropic.service.ts` or wherever the system prompt builder injects the budget value (today reads `budgetCents` from session; needs to read from `onboarding_data.budgetCents`)
- Affected controller: `src/controllers/web-chat.controller.ts` — `getOrCreateSession` response shape, `completeOnboarding` body shape and validation, plus a 400-rejection branch for agents whose `splash` is `null`
- Affected validation: `src/validation/web-chat.schema.ts` — the static `onboardingSchema` goes away; replaced by a per-request schema built from `agent.splash.fields`
- Affected agents: `src/agents/shopping-assistant.agent.ts` (gains `splash = { fields: [budget field] }`), `src/agents/lead-capture.agent.ts` (gains `splash = null`)
- New helper: `src/validation/buildOnboardingSchema.ts` — pure function `(fields: OnboardingField[]) => z.ZodSchema`. Builds a Zod object schema from the agent's declared fields.
- Tests: `src/controllers/web-chat.controller.spec.ts` (~30+ existing onboarding-related cases need updating), session.service spec, agent specs, plus new tests for the buildOnboardingSchema helper.
- The frontend embed is in a separate repo; THIS TASK changes the API shape and the frontend will need a coordinated update. The user has explicitly opted to ship the backend-first contract change cleanly with NO fallback or transition shape (no production data exists yet). A frontend handoff doc will be produced at the end of this task as a single-paste drop-in for the frontend agent.
- DDB session metadata convention (per memory: feedback_ddb_record_timestamps_convention.md): mutable docs carry `_createdAt_` + `_lastUpdated_`. Already on this record.
- Naming convention (per memory: feedback_id_not_ulid_naming.md): use `Id` suffix for new code. Existing `Ulid` references in this area can stay.

Architectural design (already locked in conversation with the user):

LAYER 1 — Agent declares onboarding via a typed contract
- `ChatAgent` interface gains `readonly splash: SplashConfig | null`. `null` means the agent does not want a splash; the embed goes straight to chat.
- `SplashConfig` shape: `{ fields: OnboardingField[] }`. The `fields` array represents one input per object, rendered top-to-bottom on the splash.
- `OnboardingField` is a discriminated union with three initial variants:
  - `{ kind: "budget"; key: "budgetCents"; label: string; required: boolean }`
  - `{ kind: "industry"; key: "industry"; label: string; options: string[]; required: boolean }`
  - `{ kind: "shortText"; key: string; label: string; required: boolean; maxLength: number }`
- `kind` drives frontend rendering. `key` is the property name written into `onboarding_data` after submission. `label` is the human-readable text shown to the user. `required` and `maxLength`/`options` drive both frontend UX and backend validation.
- Initial declarations:
  - shopping_assistant: `splash = { fields: [{ kind: "budget", key: "budgetCents", label: "What's your approximate budget?", required: true }] }`
  - lead_capture: `splash = null`

LAYER 2 — API surfaces the contract to the frontend
- `POST /chat/web/sessions` response gains two fields: `splash: SplashConfig | null` (copied verbatim from the agent) and `onboardingData: Record<string, unknown> | null` (the persisted map, or `null` for sessions where it isn't set yet). The current `budgetCents` field on the response goes away.
- `POST /chat/web/sessions/:sessionId/onboarding` body shape changes from `{ budgetCents: number }` to `{ onboardingData: Record<string, unknown> }`. Validation flow:
  1. Controller looks up the session, finds its `agentName`.
  2. Controller asks the registry for the agent.
  3. If `agent.splash === null` → return HTTP 400 with a clear message ("this agent has no onboarding").
  4. Otherwise call `buildOnboardingSchema(agent.splash.fields)` to construct a Zod object schema in that moment.
  5. Validate `body.onboardingData` against the freshly built schema. On failure → 400.
  6. On success → write the validated map into the session metadata's `onboarding_data` attribute.

LAYER 3 — Generic onboarding storage on DDB
- Session metadata record loses the top-level `budget_cents` attribute. Gains `onboarding_data: Record<string, unknown>` (a DDB Map) which holds all agent-supplied onboarding values keyed by the field's `key` property.
- For `splash: null` agents: `onboarding_data` is never written; `onboarding_completed_at` is also never written; the session goes from creation directly to kickoff and chat.
- The system prompt builder (today reads `budgetCents` from the session and injects "User context: shopping budget is approximately $X" into the prompt) becomes: read from `onboarding_data.budgetCents` if present; format and inject. Same logic, different attribute path.

Open decision points the arch-planner must resolve:
1. **Where does `splash` live on the `ChatAgent` interface — required or optional?** The user's intent is that EVERY agent makes an explicit choice. Recommend `required` (`splash: SplashConfig | null`, no `?`), so a new agent author must consciously decide rather than default to whatever TypeScript infers from omission. Confirm or override.
2. **Naming of the helper file — `buildOnboardingSchema.ts` or `onboarding-schema.builder.ts`?** Recommend the former for terseness and consistency with existing `src/utils/phone/normalizeToE164.ts` shape. Confirm or override.
3. **Where the helper lives — `src/validation/` or `src/utils/`?** It produces a Zod schema, so logically `src/validation/`. Confirm or override.
4. **Should the controller handle the 400 rejection inline or via a dedicated NestJS exception filter / guard?** Inline `throw new BadRequestException(...)` is the path of least resistance and matches existing patterns in this controller. Recommend inline. Confirm or override.
5. **The `OnboardingField` union — three variants today, but should we ship with all three or just `budget`?** The user only needs `budget` for the current production agent. The other two are scaffolding for future agents. Recommend defining all three in the union from day one (open the union, prove the architecture supports more than one variant via a couple of unit tests on the helper) but only USE `budget` in any agent declaration today. Confirm or override.
6. **Migration of the existing `budget_cents` attribute** — user has confirmed there is NO production data, so the migration question is moot. The DDB attribute simply changes shape on next write. The arch-planner must NOT plan any backfill, scan, or transition-shape code. Confirm by explicitly stating "no migration code planned."
7. **What happens to the existing static `onboardingSchema` Zod export?** It's referenced from the controller and from the controller spec. After this task, neither uses it. Recommend deleting it (along with `OnboardingBody` type if unused elsewhere). Confirm.
8. **Type for `onboarding_data` on the session record** — Map of `string → unknown`, or a typed shape? Recommend `Record<string, unknown>` at the storage/transport boundary since the contents are agent-specific and not statically known across all agents. The system prompt builder reads specific keys (`budgetCents`) and casts at the read site. Confirm.

Constraints already locked by the user:
- No production data exists yet — no migration code, no read-side fallback shape, no transition window. Clean cut.
- Frontend handoff doc to be produced at the END of this task as a single self-contained drop-in for the frontend agent. Not part of code changes.
- `splash: null` endpoint behavior on `POST /onboarding` is HTTP 400 with a clear error message.
- All `as const` usage forbidden — the user does not use that pattern. Use plain types.


STEP 1 — ARCHITECTURE PLANNING
Use the arch-planner agent to analyze the codebase and produce a structured implementation plan.

Task specifics for this plan:
Resolve every open decision point above and produce a step-by-step implementation order. The plan must answer:
- Exact file paths and shapes for the new types (`SplashConfig`, `OnboardingField`).
- Exact signature and location of `buildOnboardingSchema` and the structure of the schema it returns for each `OnboardingField` variant.
- The new request/response shapes for `POST /chat/web/sessions` and `POST /chat/web/sessions/:sessionId/onboarding`.
- The exact change to the `ChatSessionMetadataRecord` (or equivalent) DDB type — what attributes are removed, what attributes are added, what stays the same.
- Where in `session.service.ts` the read and write logic changes, and what the `getOrCreateSession` and `updateOnboarding` (or its replacement) signatures become.
- Where the system prompt builder reads onboarding values today and how that read changes.
- Each agent file's exact `splash` declaration.
- Test coverage strategy: which existing tests need updating, which new tests need adding, and at what level (unit vs integration vs e2e).

Requirements for the plan:
- identify affected files/modules
- outline step-by-step implementation order
- note dependencies and architectural considerations
- list risks or edge cases
- define testing strategy (specific new spec cases + which existing cases need updating)

Pause after producing the plan so I can review and approve it.


STEP 2 — IMPLEMENTATION
Use the code-implementer agent to implement the approved plan.

Implementation details for this task:
Follow the plan exactly. New types in `src/types/`, new helper in `src/validation/buildOnboardingSchema.ts`, agent declarations updated, controller flow rewritten, session service updated, system prompt builder updated, all spec files updated.

Implementation requirements:
- follow the plan produced by the arch-planner agent
- modify or create only the necessary files
- respect existing architecture and coding patterns
- focus on correctness first (style will be handled later)
- NO `as const` anywhere — the user does not use this pattern
- All new mutable DDB attributes carry `_createdAt_` + `_lastUpdated_` per project convention
- Use `Id` not `Ulid` suffix in any newly added identifiers


STEP 3 — STYLE REFACTOR
Use the style-refactor agent to refactor the implementation according to the rules defined in `.claude/instructions/style-enforcer.md`.

Style refactor specifics:
Standard pass. Pay particular attention to:
- New type files match existing patterns (`src/types/Account.ts`, `src/types/AccountChannel.ts`)
- New validation helper matches existing pure-helper patterns (`src/utils/phone/normalizeToE164.ts`)
- Controller handler structure matches existing `web-chat.controller.ts` conventions

Style requirements:
- apply all rules from style-enforcer.md
- improve readability, structure, and consistency
- align code with project conventions and standards
- do not change functionality or logic
- do not introduce new behavior


STEP 4 — TEST EXECUTION
Use the test-suite-runner agent to execute the project's test suite.

Testing context for this task:
Baseline before this task: 680/680 passing across 44 suites (master at HEAD after E.164 normalization shipped). This task touches ~30+ existing onboarding-related test cases AND adds new ones (buildOnboardingSchema helper, splash:null path, splash-with-fields path, agent declarations).

Testing requirements:
- run the project's standard test command
- report all failing tests clearly
- summarize results
- do not modify code or attempt fixes


STEP 5 — CODE REVIEW
Use the code-reviewer agent to review the implementation.

Review focus for this task:
- Does the `splash: SplashConfig | null` contract correctly express opt-in/opt-out at the agent layer? Is there any path where a `splash: null` agent could accidentally trigger an onboarding flow?
- Is `buildOnboardingSchema` a pure function with no side effects? Does it correctly handle every variant of `OnboardingField`? Does it correctly apply `required` (and the inverse, optional) at the Zod layer?
- Does the controller's per-request schema construction match the existing pattern of using Zod via NestJS validation pipes (or, if it diverges from that pattern, is the divergence justified and documented)?
- Did the migration from `budget_cents` (top-level attribute) to `onboarding_data` (Map) correctly update every read site, every write site, and every spec? Any orphaned references?
- Does the system prompt builder correctly handle the case where `onboarding_data` is absent (splash:null agents) — i.e., does it skip the user-context budget injection cleanly without throwing?
- Are the new spec cases comprehensive — at minimum covering: shopping_assistant happy path, lead_capture skips onboarding, splash:null agent rejects POST /onboarding with 400, dynamically built schema rejects invalid budget, dynamically built schema accepts valid budget, session response carries the splash contract for both agent types?
- Cross-channel implications: does email-cold-entry or SMS inbound (which create sessions for an account's default agent) correctly handle the `splash` contract for both shopping_assistant and lead_capture? Or is the splash a web-chat-only concept and channel-originated sessions skip it entirely?

Review requirements:
- verify correctness of the implementation
- confirm alignment with the architectural plan
- evaluate maintainability, security, and performance
- ensure style refactor did not alter functionality
- report issues using structured review feedback


============================================================
ARCH-PLANNER OUTPUT — APPROVED ARCHITECTURE (USE AS LAW)
============================================================

## Decision Point Resolutions

1. `splash` is **required**: `splash: SplashConfig | null` (no `?`). Forces every agent author to make an explicit choice.
2. Helper file: `src/validation/buildOnboardingSchema.ts`
3. Helper location: `src/validation/`
4. 400-rejection mechanism: inline `throw new BadRequestException("this agent has no onboarding")`
5. `OnboardingField` union: ship all three variants (`budget`, `industry`, `shortText`); only `budget` used in any agent declaration today
6. Migration: NO migration code. Clean cut. No production data exists.
7. Static `onboardingSchema`, `MAX_BUDGET_CENTS`, `OnboardingBody` exports: deleted from `src/validation/web-chat.schema.ts`
8. `onboarding_data` storage type: `Record<string, unknown>` at the storage and transport boundary

## Files Affected

**Create:**
- `src/types/SplashConfig.ts` — `OnboardingFieldBudget`, `OnboardingFieldIndustry`, `OnboardingFieldShortText`, `OnboardingField` union, `SplashConfig` interface
- `src/validation/buildOnboardingSchema.ts` — pure helper that converts `OnboardingField[]` to a Zod object schema
- `src/validation/buildOnboardingSchema.spec.ts` — unit tests

**Modify:**
- `src/types/ChatAgent.ts` — add `readonly splash: SplashConfig | null`
- `src/types/ChatSession.ts` — replace `budgetCents` with `onboardingData` in result interfaces; replace `budget_cents?: number` with `onboarding_data?: Record<string, unknown>` on the metadata record
- `src/types/WebChat.ts` — update `WebChatCreateSessionResponse`, `WebChatOnboardingRequest`, `WebChatOnboardingResponse`
- `src/agents/shopping-assistant.agent.ts` — add `readonly splash: SplashConfig = { fields: [{ kind: "budget", key: "budgetCents", label: "What's your approximate budget?", required: true }] }`
- `src/agents/lead-capture.agent.ts` — add `readonly splash = null`
- `src/services/session.service.ts` — change `lookupOrCreateSession` resume branch to read `onboarding_data` map; rename `updateOnboarding(sessionUlid, budgetCents)` to `updateOnboarding(sessionUlid, onboardingData: Record<string, unknown>)`; add new `getSessionMetadata(sessionUlid): Promise<{ agentName: string } | null>` method
- `src/services/chat-session.service.ts` — read `onboarding_data?.budgetCents` from the session metadata Map instead of top-level `budget_cents`
- `src/controllers/web-chat.controller.ts` — `createSession` returns `splash` + `onboardingData` instead of `budgetCents`; `completeOnboarding` rewritten to do session-metadata lookup → agent lookup → null-splash check → dynamic schema build → validate → call service
- `src/validation/web-chat.schema.ts` — delete `onboardingSchema`, `MAX_BUDGET_CENTS`, `OnboardingBody`; add `onboardingBodyWrapperSchema = z.object({ onboardingData: z.record(z.unknown()) })` and `OnboardingBodyWrapper` type
- `src/controllers/web-chat.controller.spec.ts` — update existing onboarding cases, add new cases (see test strategy below)
- `src/services/session.service.spec.ts` — update `updateOnboarding` and `lookupOrCreateSession` cases for new shape; add `getSessionMetadata` cases
- `src/services/chat-session.service.spec.ts` — update two budget-related cases
- `src/services/sms-reply.service.spec.ts`, `src/services/email-reply.service.spec.ts` — update fixture-only `budgetCents: null` → `onboardingData: null` in `lookupOrCreateSession` mock returns

## New Type Shapes

`src/types/SplashConfig.ts`:
```ts
export interface OnboardingFieldBudget {
  kind: "budget";
  key: "budgetCents";
  label: string;
  required: boolean;
}

export interface OnboardingFieldIndustry {
  kind: "industry";
  key: "industry";
  label: string;
  options: string[];
  required: boolean;
}

export interface OnboardingFieldShortText {
  kind: "shortText";
  key: string;
  label: string;
  required: boolean;
  maxLength: number;
}

export type OnboardingField =
  | OnboardingFieldBudget
  | OnboardingFieldIndustry
  | OnboardingFieldShortText;

export interface SplashConfig {
  fields: OnboardingField[];
}
```

## `buildOnboardingSchema` Behavior

Per-variant Zod schema produced:
- `kind: "budget"`, `required: true` → `z.number().int().positive().max(MAX_BUDGET_CENTS)` (where `MAX_BUDGET_CENTS = 100_000_000` defined locally)
- `kind: "budget"`, `required: false` → `.optional()` chained
- `kind: "industry"`, `required: true` → `z.enum([...field.options])`
- `kind: "industry"`, `required: false` → `.optional()` chained
- `kind: "shortText"`, `required: true` → `z.string().min(1).max(field.maxLength)`
- `kind: "shortText"`, `required: false` → `.max(field.maxLength).optional()` (no `.min(1)` when optional)
- Empty `fields` array → `z.object({})`
- Industry field with empty `options` array → throw `Error("OnboardingField 'industry' must have at least one option")` (developer-time guard)

Implementation note: build the shape with `const shape: Record<string, z.ZodTypeAny> = {}`, populate, then `z.object(shape)`. No `as` casts. Return type is `z.AnyZodObject` (or equivalent inferred shape).

## API Contract Changes

`POST /chat/web/sessions` response (`WebChatCreateSessionResponse`):
- REMOVE: `budgetCents: number | null`
- ADD: `splash: SplashConfig | null` (copied from `agent.splash`)
- ADD: `onboardingData: Record<string, unknown> | null` (the persisted map, or null)

`POST /chat/web/sessions/:sessionId/onboarding` request body (`WebChatOnboardingRequest`):
- REMOVE: `budgetCents: number`
- ADD: `onboardingData: Record<string, unknown>`

`POST /chat/web/sessions/:sessionId/onboarding` response (`WebChatOnboardingResponse`):
- REMOVE: `budgetCents: number`
- ADD: `onboardingData: Record<string, unknown>`

## DDB Shape Change (`ChatSessionMetadataRecord`)

- REMOVE: `budget_cents?: number`
- ADD: `onboarding_data?: Record<string, unknown>`
- All other fields unchanged.

## New `completeOnboarding` Controller Flow

1. `sessionService.getSessionMetadata(sessionUlid)` → `{ agentName } | null`
2. If null → throw `NotFoundException`
3. `agentRegistry.getByName(metadata.agentName)` → agent or null
4. If null → throw `BadRequestException("Session agent '${metadata.agentName}' is not registered.")`
5. If `agent.splash === null` → throw `BadRequestException("this agent has no onboarding")`
6. `const schema = buildOnboardingSchema(agent.splash.fields)`
7. `const parseResult = schema.safeParse(body.onboardingData)` — on failure, throw `BadRequestException` with formatted Zod error (match the existing `ZodValidationPipe` formatting from `src/pipes/webChatValidation.pipe.ts`)
8. `const result = await sessionService.updateOnboarding(sessionUlid, parseResult.data)` — pass the parsed (stripped) output, not raw body
9. Return `WebChatOnboardingResponse`

## System Prompt Builder Change (`src/services/chat-session.service.ts`)

Current logic reads `metadataResult.Item?.budget_cents` directly. Becomes:
```ts
const onboardingData: Record<string, unknown> | undefined = metadataResult.Item?.onboarding_data;
const rawBudget = onboardingData?.budgetCents;
const budgetCents = rawBudget !== undefined && rawBudget !== null && !Number.isNaN(Number(rawBudget))
  ? Number(rawBudget)
  : undefined;
const budgetContext = budgetCents !== undefined
  ? `User context: shopping budget is approximately $${Math.floor(budgetCents / 100)}.`
  : undefined;
```
Avoids `typeof` (style enforcer banned pattern). Same outcome string as before.

## Step-by-Step Implementation Order

1. Create `src/types/SplashConfig.ts`
2. Update `src/types/ChatAgent.ts` to require `splash`
3. Update `src/types/ChatSession.ts` (result interfaces + metadata record)
4. Update `src/types/WebChat.ts` (request/response types)
5. Create `src/validation/buildOnboardingSchema.ts`
6. Update `src/validation/web-chat.schema.ts` (delete deprecated exports, add `onboardingBodyWrapperSchema`)
7. Update `src/services/session.service.ts` (resume-branch read, `updateOnboarding` signature, new `getSessionMetadata`)
8. Update `src/services/chat-session.service.ts` (`onboarding_data` Map read)
9. Update `src/agents/shopping-assistant.agent.ts` (add splash declaration)
10. Update `src/agents/lead-capture.agent.ts` (add `splash = null`)
11. Update `src/controllers/web-chat.controller.ts` (`createSession` response + new `completeOnboarding` body)
12. Update `src/controllers/web-chat.controller.spec.ts` (existing cases + new cases)
13. Update `src/services/session.service.spec.ts` (existing cases + 3 new cases for `getSessionMetadata`)
14. Update `src/services/chat-session.service.spec.ts` (two existing cases + 1 new case)
15. Update `src/services/sms-reply.service.spec.ts` and `src/services/email-reply.service.spec.ts` (fixture-only)
16. Create `src/validation/buildOnboardingSchema.spec.ts` (13 new cases)

## Testing Strategy

### NEW spec file: `src/validation/buildOnboardingSchema.spec.ts` — 13 new cases
1. accepts a valid budget value
2. rejects a non-integer budget value
3. rejects zero for a required budget field
4. rejects a budget over the cap (`100_000_001`)
5. makes budget optional when `required: false`
6. accepts a valid industry selection
7. rejects an industry value not in options
8. makes industry optional when `required: false`
9. accepts a valid shortText value within maxLength
10. rejects a shortText value exceeding maxLength
11. makes shortText optional when `required: false`
12. returns an empty object schema for an empty fields array
13. throws when industry field has an empty options array

### EXISTING `web-chat.controller.spec.ts` updates
- Default `mockSessionService.lookupOrCreateSession` mock: `budgetCents: null` → `onboardingData: null`
- Every `mockAgentRegistry.getByName.mockReturnValue(...)` must include a `splash` property
- "returns sessionId, displayName, and onboarding nulls for a new session" — drop `budgetCents`, assert `splash: null`, `onboardingData: null`
- "falls back to agent.name when displayName is not set" — mock agent needs `splash`
- "does NOT fire slack alert when an existing session is resumed" — mock returns `onboardingData: { budgetCents: 50_000 }`
- "calls SessionService.updateOnboarding with the ULID and budgetCents" — rename, mock service returns `onboardingData: { budgetCents: 100_000 }`, assert call args match
- "maps ConditionalCheckFailedException to a 404" — primary 404 path now via `getSessionMetadata` returning null
- The four pipe tests for the onboarding body — keep wrapper-level tests, drop the budget-specific tests (now in `buildOnboardingSchema.spec.ts`)

### NEW `web-chat.controller.spec.ts` cases
1. createSession returns splash config for shopping_assistant agent
2. createSession returns splash: null for lead_capture agent
3. completeOnboarding returns 400 for an agent whose splash is null
4. completeOnboarding returns 404 when getSessionMetadata returns null
5. completeOnboarding rejects invalid budget via the dynamic schema
6. completeOnboarding validates and stores onboardingData for a shopping_assistant splash (happy path)
7. completeOnboarding rejects unknown agent stored on session metadata

### EXISTING `session.service.spec.ts` updates
- "(a) sessionId provided + METADATA exists" — mock `Item.budget_cents: 50_000` → `Item.onboarding_data: { budgetCents: 50_000 }`. Assert `result.onboardingData` equals `{ budgetCents: 50_000 }`.
- "writes onboarding_completed_at and budget_cents" — rename, change call from `service.updateOnboarding(SESSION_ULID, 100_000)` to `service.updateOnboarding(SESSION_ULID, { budgetCents: 100_000 })`. Assert `UpdateExpression` contains `onboarding_data = :data`. Assert `:data` equals `{ budgetCents: 100_000 }`. Assert `result.onboardingData` equals `{ budgetCents: 100_000 }`.
- "echoes kickoff_completed_at from METADATA read-back" — update call signature.

### NEW `session.service.spec.ts` cases
1. getSessionMetadata returns agentName when METADATA record exists
2. getSessionMetadata returns null when METADATA record does not exist
3. getSessionMetadata issues GetCommand with correct PK and SK

### EXISTING `chat-session.service.spec.ts` updates
- "passes a dynamic system context with budget when budget_cents is set on METADATA" — `Item.budget_cents: 100_000` → `Item.onboarding_data: { budgetCents: 100_000 }`
- "omits the dynamic system context when budget_cents is not set" — rename description, mock has no `onboarding_data` key

### NEW `chat-session.service.spec.ts` case
1. omits dynamic system context when onboarding_data is present but has no budgetCents key

### `sms-reply.service.spec.ts` and `email-reply.service.spec.ts`
- All `budgetCents: null` → `onboardingData: null` in `lookupOrCreateSession` mock returns. Fixture-only.

## Risks & Edge Cases (acknowledged, no code change needed)

- **Channel-originated sessions (SMS/email) bypass splash entirely** — splash is web-chat-only. SMS/email sessions for `shopping_assistant` will never inject a budget context. Acknowledged limitation.
- **Cold-deploy race** between `createSession` (returns splash A) and `POST /onboarding` (validates against splash B if a deploy mid-session changes the agent). Cold-deploy edge case, not a real production risk today.
- **`industry` with empty `options`** — developer-time guard throws when the helper is called.
- **`completeOnboarding` no longer relies on DDB `ConditionExpression` for session-existence** — `getSessionMetadata` returning null is the primary 404 path; the existing `ConditionalCheckFailedException` handling stays as a defensive fallback.

============================================================
END ARCH-PLANNER OUTPUT
============================================================


STEP 6 (post-loop, orchestrator-driven, NOT a sub-agent step) — FRONTEND HANDOFF DOC
After the test suite is green and the code-reviewer has signed off, the orchestrator produces a single-file frontend handoff doc as a Markdown drop-in. Contents:
- The new API contract (request/response shapes for `POST /chat/web/sessions` and `POST /chat/web/sessions/:sessionId/onboarding`).
- The full `OnboardingField` union with all variants and which `kind` values are valid today.
- The render-time logic the embed needs (if `splash === null` → skip; otherwise iterate `splash.fields` and render one input per `kind`).
- The submission-time logic (POST `{ onboardingData: { ...keysFromFields } }`; on 400 → handle the error).
- The transition-state logic (none — clean cut, no fallback).
- The display-time logic post-submission (read `onboardingData` from session response if needed; otherwise just transition to chat).

This handoff doc is the user's single-paste artifact for the frontend agent to consume. It is produced ONCE at the end and lives at `.claude/plans/per-agent-onboarding-frontend-handoff.md`.
