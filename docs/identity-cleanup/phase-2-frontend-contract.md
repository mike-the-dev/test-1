# Phase 2 frontend contract — session ID storage

**Audience:** Widget / frontend engineers.
**Backend change:** The IDENTITY translation table is removed. The browser now stores the session ID directly instead of a "guest ULID" that the backend translated internally. ALL web-chat endpoints now use `sessionId` on the wire (request bodies, path params, response fields) — there is no longer any `sessionUlid` field name on the public API.
**Backend deploy required first:** Yes. The widget change should go live after the backend is deployed.

---

## localStorage key

Store the session ID under:

```
instapaytient_chat_session_id
```

Replace any previous key used for `guestUlid`. On first load after deploy, if the widget finds a value under the old key but nothing under the new key, treat it as if no session is stored (mint a new one). The old key and value can be left or deleted — the backend will not look up the old value.

---

## POST /chat/web/sessions

Creates a new session or resumes an existing one.

### Request body

```json
{
  "agentName": "lead_capture",
  "accountUlid": "A#01ARYZ3NDEKTSV4RRFFQ69G5FA",
  "sessionId": "01ARZ3NDEKTSV4RRFFQ69G5FAV"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `agentName` | string | Yes | Agent name for the session. |
| `accountUlid` | string | Yes | The embed account ID in `A#<ULID>` format — comes from `data-account-ulid` in the embed snippet. |
| `sessionId` | string | No | The session ID previously returned by this endpoint and stored in localStorage. Must be a valid 26-character ULID if provided. Omit (or do not send the field) if no stored session exists. |

**Request without stored session:**
```json
{
  "agentName": "lead_capture",
  "accountUlid": "A#01ARYZ3NDEKTSV4RRFFQ69G5FA"
}
```

**Request with stored session:**
```json
{
  "agentName": "lead_capture",
  "accountUlid": "A#01ARYZ3NDEKTSV4RRFFQ69G5FA",
  "sessionId": "01ARZ3NDEKTSV4RRFFQ69G5FAV"
}
```

### Response body

HTTP 200 in all success cases.

```json
{
  "sessionId": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "displayName": "Instapaytient Assistant",
  "onboardingCompletedAt": null,
  "kickoffCompletedAt": null,
  "budgetCents": null
}
```

| Field | Type | Notes |
|---|---|---|
| `sessionId` | string | The session ID to store in localStorage and use in all subsequent requests. If the request provided a `sessionId` that resolved, this is the same value. If a new session was minted, this is a new value — **store it, overwriting any previous value**. |
| `displayName` | string | Agent display name for the chat UI. |
| `onboardingCompletedAt` | string \| null | ISO 8601 timestamp if onboarding was completed; null otherwise. |
| `kickoffCompletedAt` | string \| null | ISO 8601 timestamp if the kickoff greeting was sent; null otherwise. |
| `budgetCents` | number \| null | Budget collected during onboarding; null if not yet collected. |

### Behavior matrix

| Situation | Backend behavior | Frontend action |
|---|---|---|
| No `sessionId` sent | Backend mints a new session. | Store the returned `sessionId` in localStorage. |
| `sessionId` sent and resolves to a real session | Backend returns that session's state. | `sessionId` in response equals what you sent. No action needed (already stored). |
| `sessionId` sent but does not resolve (stale, forged, or from a different environment) | Backend mints a new session. | Store the returned `sessionId` in localStorage, overwriting the old value. |
| `sessionId` sent but not a valid ULID format | Backend returns HTTP 400. | Clear localStorage, retry the request without `sessionId`. |

### Always overwrite localStorage after this call

The simplest safe behavior: always write the returned `sessionId` to localStorage after a successful response, regardless of whether you sent one. This handles both the "new session" and "stale session replaced" cases without branching in the widget.

---

## POST /chat/web/messages

Send a user message and receive the agent's reply.

### Request body

```json
{
  "sessionId": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "message": "Hello"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `sessionId` | string | Yes | The session ID stored in localStorage — must be a valid 26-character ULID. |
| `message` | string | Yes | The user's message. |

---

## GET /chat/web/sessions/:sessionId/messages

Fetch the full conversation history for a session.

Path parameter: `:sessionId` (renamed from `:sessionUlid`). Use the stored session ID as the value.

Example: `GET /chat/web/sessions/01ARZ3NDEKTSV4RRFFQ69G5FAV/messages`

---

## POST /chat/web/sessions/:sessionId/onboarding

Record completion of the onboarding flow.

Path parameter: `:sessionId` (renamed from `:sessionUlid`).

### Response body

```json
{
  "sessionId": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "onboardingCompletedAt": "2026-04-30T12:00:00.000Z",
  "kickoffCompletedAt": null,
  "budgetCents": 50000
}
```

---

## POST /chat/web/embed/authorize

No change. Request and response are unaffected.

---

## Migration note for existing pre-production widgets

There is no production user data. Any widget currently storing a `guestUlid` in localStorage will start a fresh session on first load after deploy — the backend will mint a new session and return a new `sessionId`. This is acceptable for pre-production. No migration script is needed.

The widget code update covers:
1. Read/write the new localStorage key (`instapaytient_chat_session_id`).
2. Rename request/response field names from `sessionUlid` to `sessionId` in the create-session call AND the messages call.
3. Rename path-param field names from `sessionUlid` to `sessionId` in the GET messages and POST onboarding calls.

---

## Out of scope

- `accountUlid` in the request body — unchanged (existing wire contract, predates this rename pass).
- Embed-authorize endpoint — unchanged.
- Email inbound/outbound — unchanged.
