# Per-Agent Onboarding — Frontend Handoff

This doc is a single self-contained drop-in for the frontend agent. The backend (this repo, `ai-chat-session-api`) just shipped per-agent onboarding configuration — the splash screen is now agent-driven. The embed must be updated to consume the new contract.

**Status:** backend deployed at commit covering the per-agent onboarding feature. No production data exists, so this is a clean cut — no transition shape, no fallback, no compatibility window. The frontend can deploy independently whenever it's ready.

---

## What changed at a glance

- **Before:** every session of every agent ran through a hardcoded splash that collected `budgetCents`. The embed always rendered the splash regardless of which agent was selected.
- **After:** each agent declares its own splash configuration in the backend. The embed reads that configuration from the session-creation response and renders accordingly. Agents that don't need a splash skip it entirely and go straight to chat.
- **Two agents today:**
  - `shopping_assistant` — has a splash that asks for budget. (Same UX as before, just driven by the backend now.)
  - `lead_capture` — no splash. Embed should NOT render a splash for this agent.

---

## API Contract — what the embed must consume

### `POST /chat/web/sessions` — create or resume a session

**Request body** — UNCHANGED.

```ts
{
  agentName: string;     // e.g. "shopping_assistant" or "lead_capture"
  sessionId?: string;    // optional ULID for resuming a prior session
  parentDomain?: string; // unchanged
}
```

**Response body** — TWO FIELDS CHANGED:

```ts
{
  sessionId: string;
  displayName: string;
  onboardingCompletedAt: string | null;
  kickoffCompletedAt: string | null;
  splash: SplashConfig | null;          // NEW — drives splash rendering
  onboardingData: Record<string, unknown> | null; // NEW — replaces budgetCents
}
```

The old top-level `budgetCents: number | null` field is **gone**.

`splash` is the source of truth for whether the embed renders a splash and what it renders. `onboardingData` is the persisted map of values the user submitted (or `null` for a fresh session that hasn't completed onboarding).

### `POST /chat/web/sessions/:sessionId/onboarding` — submit splash data

**Request body** — CHANGED:

```ts
// Before
{ budgetCents: number }

// After
{ onboardingData: Record<string, unknown> }
```

**Response body** — CHANGED:

```ts
{
  sessionId: string;
  onboardingCompletedAt: string;
  kickoffCompletedAt: string | null;
  onboardingData: Record<string, unknown>;  // replaces budgetCents
}
```

**Error responses:**
- `404 Not Found` — session ULID does not exist
- `400 Bad Request` with body `"this agent has no onboarding"` — the embed called this endpoint for an agent whose `splash` is `null`. This indicates a frontend bug — the embed should never call this endpoint when the session response said `splash === null`.
- `400 Bad Request` with a Zod-formatted error message — the submitted `onboardingData` failed validation against the agent's declared fields.

---

## Type Definitions — copy-paste into the frontend

```ts
export interface SplashConfigOnboardingFieldBudget {
  kind: "budget";
  key: "budgetCents";
  label: string;
  required: boolean;
}

export interface SplashConfigOnboardingFieldIndustry {
  kind: "industry";
  key: "industry";
  label: string;
  options: string[];
  required: boolean;
}

export interface SplashConfigOnboardingFieldShortText {
  kind: "shortText";
  key: string;
  label: string;
  required: boolean;
  maxLength: number;
}

export type SplashConfigOnboardingField =
  | SplashConfigOnboardingFieldBudget
  | SplashConfigOnboardingFieldIndustry
  | SplashConfigOnboardingFieldShortText;

export interface SplashConfig {
  fields: SplashConfigOnboardingField[];
}
```

Today only the `budget` variant is used in any agent declaration. The other two variants exist in the type union to support future agents — the embed should be prepared to render all three.

---

## Render-Time Logic

After receiving the response from `POST /chat/web/sessions`:

```ts
if (response.splash === null) {
  // Skip splash entirely. Go straight to chat (or whatever the post-splash flow is).
  goToChat();
} else {
  // Render the splash. Iterate response.splash.fields and render one input per field.
  renderSplash(response.splash.fields);
}
```

For each field in `splash.fields`, render based on `kind`:

- `kind: "budget"` → currency input with `$` prefix and number formatting. Submit value as a number representing cents (e.g., user types $500.00 → submit `50000`). Required-ness from `field.required` controls submit-button enabled state.
- `kind: "industry"` → dropdown with one `<option>` per entry in `field.options`. Submit value is the selected string.
- `kind: "shortText"` → plain text input with `maxLength={field.maxLength}` enforced on the input. Submit value is the typed string.

For every field type, the human-readable question text is `field.label`. No translation table, no copy file — render exactly what the backend declared.

---

## Submission Flow

After the user fills the splash:

1. Build the submission payload as a flat object keyed by each field's `key` property:

```ts
// Example for shopping_assistant (single budget field)
const onboardingData = {
  [field.key]: typedValue,  // e.g., budgetCents: 50000
};

// Example for a hypothetical agent with multiple fields
const onboardingData = {
  budgetCents: 50000,
  industry: "retail",
};
```

2. POST to `/chat/web/sessions/:sessionId/onboarding`:

```ts
fetch(`/chat/web/sessions/${sessionId}/onboarding`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ onboardingData }),
});
```

3. On success (200), the response includes `onboardingCompletedAt` and the persisted `onboardingData` map. Transition to chat.

4. On 400 Zod error, surface the error message to the user and let them correct the field. The error message will describe which field is invalid.

5. On 404, the session has expired or is invalid — start a fresh session.

---

## Required-ness Enforcement

The backend enforces required-ness via Zod. The frontend should ALSO enforce it on the submit button (disable until all `required: true` fields have a value). The two enforcement points exist for UX reasons (immediate feedback) and security reasons (defense in depth) — both should agree because both come from the same `field.required` declaration.

If `field.required === false` and the user leaves it blank, omit the key from `onboardingData` entirely (don't submit `null` or `""`). Zod's `.optional()` accepts `undefined`, which means the key is absent.

---

## Edge Cases

**Resuming a session with completed onboarding.** If the response has `onboardingCompletedAt !== null` AND `onboardingData !== null`, the user has already completed onboarding for this session. Skip the splash even if `splash !== null` — they've already filled it out.

**Resuming a session for a `splash: null` agent.** `onboardingCompletedAt` will be `null` and `onboardingData` will be `null`. Skip the splash, go straight to chat. Do not call `POST /onboarding`.

**A field type the embed doesn't recognize.** If the backend ships a future `kind` the embed doesn't yet have a renderer for, render a generic text input as a fallback (or display an error and disable the splash). Don't crash. The discriminated union is open; the frontend should fail gracefully.

**Empty `splash.fields` array.** If `splash` is non-null but `splash.fields` is empty, render the splash container with nothing in it and a "Continue" button. Submitting `{ onboardingData: {} }` will succeed. (This case shouldn't arise in practice — it's a misconfigured agent — but handle it gracefully.)

---

## Decision Notes

- **Per-agent splash phrasing.** Each agent's `field.label` is its own. shopping_assistant's budget question reads "What's your approximate budget?". A future medical-spa-specific agent could phrase the same `kind: "budget"` field as "What's your treatment budget?". Don't hardcode any wording on the frontend — render whatever the backend declared.
- **Cross-channel sessions skip splash entirely.** Sessions originated via SMS or email never go through the splash; that's a web-chat-only concept. A returning customer who first contacted via SMS and later opens the web chat WILL see the splash on their first web visit (the system doesn't know who they are at session-creation time). The cross-channel identity match happens mid-chat via `collect_contact_info`, not at session creation.
- **No backwards compatibility.** No production data exists, so the embed can hard-cut to the new contract. There's no transition window, no `budgetCents`-fallback path, no shape-detection.

---

## Test Cases the Frontend Should Cover

1. Create session for `shopping_assistant` → response has `splash: { fields: [budget field] }` → splash renders with the budget question → user submits → onboarding completes → transition to chat.
2. Create session for `lead_capture` → response has `splash: null` → splash does NOT render → user goes straight to chat.
3. Resume a session for `shopping_assistant` that has already completed onboarding → response has `onboardingCompletedAt !== null` and `onboardingData !== null` → splash does NOT render → user resumes chat.
4. Submit invalid budget (e.g., zero or negative) → 400 with Zod error → embed surfaces the error and lets user correct.
5. Submit to onboarding endpoint for a `splash: null` agent (manually triggered, e.g., via dev tools) → 400 "this agent has no onboarding". This indicates a frontend bug; no user-facing handling needed.

---

## Questions or Issues

If anything in this contract is unclear or doesn't match what the embed needs, ping the backend session — the backend repo is `ai-chat-session-api` at the per-agent onboarding commit. Backend convention is the contract; the embed adapts to it.
