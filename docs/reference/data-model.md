# Data model

All persistent state lives in a single DynamoDB table. The table name is read from `DYNAMODB_TABLE_CONVERSATIONS`.

---

## Why single-table

Every access pattern this service needs is keyed by either the session ULID or an external identity. A single-table design lets us group everything about one session under a common partition key (`CHAT_SESSION#<ulid>`) so that reading the full state of a session is one `Query`, not a fan-out across tables.

No GSIs are used today. If future features need a non-session access pattern (e.g. "all sessions for a tenant") we will add a GSI rather than a second table.

---

## Record types

### `IDENTITY#<source>#<externalId>` — `IDENTITY#<source>#<externalId>`

Maps an external channel-specific ID to a session ULID.

| Field | Notes |
|---|---|
| `PK`, `SK` | Both set to `IDENTITY#<source>#<externalId>`. |
| `sessionUlid` | The session this identity points at. |
| `createdAt` | ISO 8601 timestamp. |

Written by `IdentityService.lookupOrCreateSession(...)` using a conditional put (only if the item does not already exist) to handle race conditions when two messages arrive nearly simultaneously.

Type: `ChatSessionIdentityRecord` in `src/types/ChatSession.ts`.

---

### `CHAT_SESSION#<ulid>` — `METADATA`

One per session. Holds the agent binding and session-level timestamps.

| Field | Notes |
|---|---|
| `PK` | `CHAT_SESSION#<ulid>` |
| `SK` | `METADATA` |
| `source` | The channel where the session was born (`discord`, `email`, ...). Informational. |
| `agentName` | The agent bound to this session (`lead_capture`, ...). Optional on legacy records; `DEFAULT_AGENT_NAME` is used as a fallback. |
| `createdAt` | Preserved via `if_not_exists`. |
| `lastMessageAt` | Refreshed on every inbound message. |

Written initially by `IdentityService`, then patched on every message by `ChatSessionService.handleMessage(...)`.

Type: `ChatSessionMetadataRecord` in `src/types/ChatSession.ts`.

---

### `CHAT_SESSION#<ulid>` — `MESSAGE#<ulid>`

One record per message turn. Many per session.

| Field | Notes |
|---|---|
| `PK` | `CHAT_SESSION#<ulid>` |
| `SK` | `MESSAGE#<ulid>` — ULID generated at write time, so messages sort chronologically by SK. |
| `role` | `"user"` or `"assistant"`. |
| `content` | JSON-stringified `ChatContentBlock[]` — see [concepts: content block](./concepts.md#content-block). |
| `createdAt` | ISO 8601 timestamp. |

Reads: `ChatSessionService` loads up to `MAX_HISTORY_MESSAGES = 50` via a `Query` with `ScanIndexForward: false` (newest first) and then reverses client-side so the history is in chronological order for the model.

Legacy: `content` may be a plain string on very old records; the loader catches the `JSON.parse` failure and wraps the string in a single `text` block.

Type: `ChatSessionMessageRecord` in `src/types/ChatSession.ts`.

---

### `CHAT_SESSION#<ulid>` — `USER_CONTACT_INFO`

One per session (per agent that uses it). Holds contact fields collected by the `collect_contact_info` tool.

| Field | Notes |
|---|---|
| `PK` | `CHAT_SESSION#<ulid>` |
| `SK` | `USER_CONTACT_INFO` |
| Short-name fields | Written by the tool — e.g. first name, last name, email, phone, company. |
| `createdAt` | Preserved via `if_not_exists`. |
| `updatedAt` | Refreshed on every update. |

The `collect_contact_info` tool uses a dynamic `UpdateCommand` so it only writes the fields the model actually provided — call it multiple times during a conversation to build the profile up.

---

### `CHAT_SESSION#<ulid>` — `USER_FACT#<key>`

One record per fact, written by the `save_user_fact` tool. Used for stable, long-term memory the model wants to remember across turns.

| Field | Notes |
|---|---|
| `PK` | `CHAT_SESSION#<ulid>` |
| `SK` | `USER_FACT#<key>` — `key` is a snake_case identifier supplied by the model. |
| `value` | Free-form string. |
| `updatedAt` | ISO 8601 timestamp. |

Note: today these records exist but are not automatically loaded into the prompt context. A future feature will surface them to the agent at conversation start.

---

### `EMAIL_INBOUND#<hash>` — `EMAIL_INBOUND#<hash>`

Dedupe record for inbound email replies.

| Field | Notes |
|---|---|
| `PK`, `SK` | Both set to `EMAIL_INBOUND#<hash>` — the hash is derived from the inbound message ID. |
| `sessionUlid` | The session the reply was routed to. |
| `processedAt` | ISO 8601 timestamp. |

Written by `EmailReplyService` with a conditional put: if the record already exists, the inbound payload is treated as a duplicate and dropped. SendGrid occasionally retries webhook deliveries, so this check is important.

Type: `EmailReplyRecord` in `src/types/EmailReply.ts`.

---

## Access patterns at a glance

| What we need | How we get it |
|---|---|
| Look up session for an external user | `GetCommand` on `IDENTITY#<source>#<externalId>` |
| Load session metadata | `GetCommand` on `CHAT_SESSION#<ulid>` / `METADATA` |
| Load recent messages | `QueryCommand` on `PK = CHAT_SESSION#<ulid> AND begins_with(SK, "MESSAGE#")` with `ScanIndexForward: false, Limit: 50` |
| Write a new message | `PutCommand` with SK `MESSAGE#<newUlid>` |
| Update metadata after a turn | `UpdateCommand` with `SET createdAt = if_not_exists(createdAt, :now), lastMessageAt = :now` |
| Incrementally upsert contact info | `UpdateCommand` on `USER_CONTACT_INFO` with a dynamically built `UpdateExpression` |
| Dedupe inbound email | Conditional `PutCommand` on `EMAIL_INBOUND#<hash>` |

---

## Things to know before extending the model

- **Never change a PK/SK pattern in place.** DynamoDB has no renames. If a record shape changes, introduce a new SK prefix and a read-time fallback, then migrate.
- **Key prefixes are load-bearing.** `begins_with(SK, "MESSAGE#")` is how message queries work. If you introduce a new per-session record, give it a distinct SK prefix that does not collide.
- **ULIDs are monotonic.** That is why `MESSAGE#<ulid>` sorts chronologically without needing a separate timestamp column in the key.
- **Prefer `UpdateCommand` over `PutCommand` for existing records.** Partial updates with `if_not_exists` preserve fields you are not touching. A `PutCommand` will clobber the entire item.
