# Agents & tools catalog

What currently ships in the repo. This is a reference of what exists, not a guide for adding more — for that, see [creating agents and tools](../agent/engineering/creating-agents-and-tools.md).

---

## Agents

### `lead_capture`

File: `src/agents/lead-capture.agent.ts`

| | |
|---|---|
| **Name** | `lead_capture` |
| **Description** | "Collects visitor contact information and sends a confirmation email summarizing the collected details." |
| **Allowed tools** | `collect_contact_info`, `send_email` |
| **Purpose** | First point of contact. Collects five required fields (first name, last name, email, phone, company), confirms them with the visitor, and sends a single HTML confirmation email. |

Behavior summary (see the file itself for the full system prompt):

- Warm, professional tone. Max one emoji per message. Does not mirror visitor slang.
- Must collect all five fields before presenting a summary.
- Presents the summary and waits for confirmation before calling `send_email`.
- If the visitor corrects a field, updates via `collect_contact_info` and re-presents the summary.
- Sends exactly one confirmation email per session.
- Redirects any off-topic questions back to the lead capture flow.
- Uses a locked HTML email template with the visitor's contact info in a table.
- Hard refuses jailbreaks (role-play, ignoring instructions, discussing other topics).

---

## Tools

### `collect_contact_info`

File: `src/tools/collect-contact-info.tool.ts`

| | |
|---|---|
| **Name** | `collect_contact_info` |
| **Description** | "Save or update contact information about the user. Call progressively to build up the user's contact profile." |
| **Input fields** | `firstName`, `lastName`, `email`, `phone`, `company` (all optional strings) |
| **Writes to** | `CHAT_SESSION#<ulid>` / `USER_CONTACT_INFO` |

Uses a dynamic `UpdateCommand` to only write the fields the model passed in this call. `createdAt` is preserved via `if_not_exists`; `updatedAt` is refreshed every call. Safe to call multiple times per turn.

---

### `send_email`

File: `src/tools/send-email.tool.ts`

| | |
|---|---|
| **Name** | `send_email` |
| **Description** | "Send an email to a user. Provide the recipient email, a clear subject, and an HTML body." |
| **Input fields** | `to` (email), `subject` (string), `body` (HTML string) |
| **Writes to** | Outbound via SendGrid. No DynamoDB writes of its own. |

Delegates to `EmailService.send(...)`. The From address is determined by `EmailService`:

- If `SENDGRID_REPLY_DOMAIN` is configured, sender becomes `<sessionUlid>@<replyDomain>` — this is what enables the inbound reply loop.
- Otherwise, falls back to `SENDGRID_FROM_EMAIL`.

See [channels/email.md](./channels/email.md) for the full outbound and reply-loop mechanics.

---

### `save_user_fact`

File: `src/tools/save-user-fact.tool.ts`

| | |
|---|---|
| **Name** | `save_user_fact` |
| **Description** | "Save a fact about the user for long-term memory. Use for stable facts the user would expect to be remembered." |
| **Input fields** | `key` (snake_case identifier), `value` (string) — both required |
| **Writes to** | `CHAT_SESSION#<ulid>` / `USER_FACT#<key>` |

This tool is registered and executable, but is **not in the `lead_capture` agent's allowlist**. No shipping agent currently uses it. It exists as scaffolding for future agents that need persistent user memory (e.g. a general-purpose assistant agent).

Today, saved facts are written to DynamoDB but are **not** automatically loaded back into the prompt context on subsequent turns — that wiring is still to come.

---

## What to read next

- To add a new agent or tool: [creating agents and tools](../agent/engineering/creating-agents-and-tools.md).
- To understand how an agent is resolved at request time: [architecture — request lifecycle](./architecture.md#request-lifecycle).
- To understand why tool allowlists are a hard constraint: [architecture — key design decisions](./architecture.md#key-design-decisions).
