# Operations

How to run the service, what it needs to be configured, and what to watch.

---

## Environment variables

Validated at boot by `src/config/env.schema.ts`. Typed access goes through the per-concern config services under `src/services/*-config.service.ts`.

### App

| Var | Required | Default | Notes |
|---|---|---|---|
| `APP_ENV` | No | `local` | One of `local`, `staging`, `prod`. Controls log verbosity. |
| `PORT` | No | `3000` | HTTP port. |

### DynamoDB

| Var | Required | Default | Notes |
|---|---|---|---|
| `DYNAMODB_REGION` | Yes | — | AWS region (e.g. `us-east-1`). |
| `DYNAMODB_ENDPOINT` | No | `http://localhost:8000` in local/dev | Custom endpoint — useful for DynamoDB Local. Leave unset in prod. |
| `DYNAMODB_TABLE_CONVERSATIONS` | Yes | — | The single-table name. See [data-model.md](./data-model.md). |

### Anthropic

| Var | Required | Default | Notes |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Yes (for chat) | — | API key from console.anthropic.com. |
| `ANTHROPIC_MODEL` | No | `claude-opus-4-6` | Override to hot-swap models without code changes. |

### Discord

| Var | Required | Default | Notes |
|---|---|---|---|
| `DISCORD_BOT_TOKEN` | No | — | If unset, the Discord adapter stays idle; the rest of the app continues to work. |
| `DISCORD_GUILD_ID` | No | — | Optional scoping for testing. |

### SendGrid / Email

| Var | Required | Default | Notes |
|---|---|---|---|
| `SENDGRID_API_KEY` | No | — | If unset, email sending fails loudly when attempted. |
| `SENDGRID_FROM_EMAIL` | No | — | Fallback sender when reply domain is not set. |
| `SENDGRID_FROM_NAME` | No | — | Display name. |
| `SENDGRID_REPLY_DOMAIN` | No | — | Enables the per-session inbound reply loop. See [channels/email.md](./channels/email.md). Domain format is validated; a leading `@` is stripped automatically. |

---

## Local development

1. Install deps: `npm install`.
2. Copy `.env.local` (not committed) with the vars you need. At minimum: `DYNAMODB_REGION`, `DYNAMODB_TABLE_CONVERSATIONS`, and `ANTHROPIC_API_KEY`. Add channel creds as needed.
3. Run the app: `npm run start:local`.

`start:local` is the canonical local command — it wires config to local/dev resources. Do **not** use `npm run start:dev` for local development; reach for `start:local`.

### DynamoDB Local (optional)

For fully-offline development:

```bash
docker run -p 8000:8000 amazon/dynamodb-local
```

Set `DYNAMODB_ENDPOINT=http://localhost:8000` in `.env.local`. You will need to create the table manually (matching the single-table layout in [data-model.md](./data-model.md)) on first run.

---

## Runtime topology

The app is a single NestJS process that simultaneously:

- Serves HTTP (port `PORT`) — currently just the SendGrid inbound webhook and any future HTTP entry points.
- Holds an open websocket to the Discord gateway via `DiscordService`.
- Makes outbound calls to Anthropic, DynamoDB, and SendGrid.

There is no background worker, no queue, no secondary process. Scaling horizontally is straightforward for the HTTP side — Discord gateway connections require a singleton or sharding strategy if you run more than one replica.

---

## Logging

- Log level is driven by `APP_ENV`. `prod` logs `log | warn | error`. Non-prod adds `debug | verbose`.
- Every service uses NestJS's built-in `Logger` scoped to the class name.
- Important log lines in `ChatSessionService` include `[sessionUlid=... iteration=... historySize=...]` for the tool loop and `Stored messages [sessionUlid=... count=...]` after persistence. Search by `sessionUlid` when triaging a single conversation.

---

## Observability hooks that don't exist yet

This is a short list of things you will probably want to add before running this at volume:

- Metrics for: tool-loop iterations per request, average Anthropic latency, tool error rate, inbound email outcomes.
- Sentry wiring for exceptions (the org has a Sentry workflow — see `docs/agent/sentry-workflow.md`).
- A health endpoint beyond the default Nest one that verifies DynamoDB and Anthropic connectivity.

None of these are blockers today. Call them out in any roadmap work.

---

## Deployment notes

Deployment has not been documented yet — the production target is whatever the Instapaytient platform standardizes on. Until that is settled, treat deployment as environment-specific and keep the env vars above as the contract.

If you are adding deployment config (Dockerfile, CI workflow, IaC), document it here when you do, and link back to it from the root [README.md](../README.md).

---

## Security considerations

- **Secrets live in env vars.** Never commit `.env*` files. SendGrid and Anthropic keys grant real billable capability.
- **Tool allowlist is the security boundary.** A jailbroken model cannot invoke a tool that is not in the agent's `allowedToolNames`. Do not add tools to an agent's allowlist unless you specifically want that agent to have them.
- **Inbound email sender validation.** `EmailReplyService` checks that the `from` address of an inbound reply matches the session's stored contact email. This prevents a stranger who guesses a session ULID from hijacking the conversation. Do not bypass this check.
- **No PII in logs.** The current log lines include `sessionUlid`, which is safe. Avoid adding log statements that dump raw message content, contact fields, or email bodies.
