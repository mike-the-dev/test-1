# Channel: Email

Outbound email and the inbound reply loop.

Files:
- `src/services/email.service.ts` — outbound via SendGrid SDK.
- `src/controllers/sendgrid-webhook.controller.ts` — inbound webhook endpoint.
- `src/services/email-reply.service.ts` — inbound processing.
- `src/services/sendgrid-config.service.ts` — typed env access.

---

## What email can do today

The system can:

1. **Send a confirmation email** mid-conversation as a tool call (via the `send_email` tool → `EmailService`).
2. **Receive the recipient's reply** via a SendGrid Inbound Parse webhook, route it back to the original session, and continue the conversation — the model's next response goes out as a threaded reply to the same thread.

The result is that the conversation continues seamlessly across reply threads with no loss of context.

---

## Outbound

### Sender address encoding

When the `send_email` tool is invoked, `EmailService.send(...)` builds the `From` address like this:

- If `SENDGRID_REPLY_DOMAIN` is set, sender is `<sessionUlid>@<SENDGRID_REPLY_DOMAIN>`.
- Otherwise, sender is `SENDGRID_FROM_EMAIL`.

Encoding the session ULID into the local part of the sender address is the trick that makes the inbound reply loop work without a database lookup: when the user hits Reply, their reply's `To:` address contains the ULID, and we route off that directly.

### Threading headers

Outbound messages include RFC 5322 threading hints:

- `Message-ID` — a unique ID generated per outbound message.
- `In-Reply-To` / `References` — set when continuing a thread (e.g. replying to an inbound user email).

This keeps Gmail, Outlook, and Apple Mail grouping the thread correctly.

### Required env

| Env var | Required | Notes |
|---|---|---|
| `SENDGRID_API_KEY` | Yes (if email is enabled) | SendGrid API key with Mail Send permission. |
| `SENDGRID_FROM_EMAIL` | Yes | Fallback sender address when reply domain is not set. |
| `SENDGRID_FROM_NAME` | Optional | Friendly display name for the sender. |
| `SENDGRID_REPLY_DOMAIN` | Optional | Domain used for per-session sender encoding (see below). Validated as a domain; a leading `@` is stripped. |

---

## Inbound

### Endpoint

`POST /webhooks/sendgrid/inbound` — registered by `SendgridWebhookController`. SendGrid posts a multipart form body containing the parsed email fields (`to`, `from`, `text`, `subject`, `html`, `headers`, etc.).

The controller is a thin pass-through; all logic is in `EmailReplyService.processInboundReply(...)`.

### Processing steps

For every accepted inbound email:

1. **Extract the session ULID.** The `to` field looks like `<sessionUlid>@<replyDomain>`. The local part is the session ULID. If the local part is not a valid ULID or the domain does not match `SENDGRID_REPLY_DOMAIN`, the email is rejected as malformed.
2. **Validate the sender.** Look up the session's `USER_CONTACT_INFO` record; the `from` email must match the stored contact email. This prevents someone spoofing a reply to a known session ULID. If the sender does not match, the email is rejected.
3. **Dedupe.** SendGrid occasionally delivers webhooks more than once. Hash the inbound `Message-ID` header, then perform a conditional `PutCommand` on `EMAIL_INBOUND#<hash>` — if it already exists, drop the email as a duplicate.
4. **Strip quoted reply text.** Pull out the user's actual new content, discarding the quoted prior thread.
5. **Continue the conversation.** Call `ChatSessionService.handleMessage(sessionUlid, bodyText)` — the core does not know this message came from email. It runs the tool loop as usual.
6. **Reply by email.** The core's response string is sent back to the original sender via `EmailService.send(...)` with `In-Reply-To` / `References` headers set so it threads cleanly in the user's inbox.

Outcomes are typed as `EmailReplyInboundProcessOutcome` (`src/types/EmailReply.ts`):

- `processed` — handed off to the core.
- `duplicate` — seen this message before; dropped.
- `rejected_unknown_session` — local part was not a valid session ULID we know about.
- `rejected_sender_mismatch` — sender did not match the session's stored contact.
- `rejected_malformed` — couldn't parse the envelope at all.

---

## DNS and SendGrid setup

Inbound requires MX routing to SendGrid:

1. Pick a reply subdomain — e.g. `reply.yourdomain.com`.
2. Add an MX record on that subdomain pointing at `mx.sendgrid.net` (priority 10).
3. In SendGrid → Settings → Inbound Parse, add a host:
   - **Subdomain**: `reply`
   - **Receiving Domain**: `yourdomain.com`
   - **Destination URL**: `https://<your-host>/webhooks/sendgrid/inbound`
   - Leave the spam-check and raw-MIME toggles at their defaults unless you specifically want them.
4. Set `SENDGRID_REPLY_DOMAIN=reply.yourdomain.com` in the environment.

Once MX propagates, any email sent to `<anything>@reply.yourdomain.com` hits SendGrid, which POSTs the parsed body to your webhook.

For local development, tunnel the webhook via `ngrok` (or similar) and put the tunnel URL into the Inbound Parse host's Destination URL. SendGrid does not care that the URL is public as long as it can reach it.

---

## Multi-tenant / per-client reply domains

The reply domain is a single env var today, but the architecture supports per-client domains without code changes to the core — the session ULID is the routing key, not the domain. If a client wants `reply.clientdomain.com` instead of your default, point their MX record at `mx.sendgrid.net`, register a second Inbound Parse host in SendGrid pointing at the same webhook URL, and the existing inbound handler will route correctly as long as it recognizes both hosts.

(The current `EmailReplyService` only validates against `SENDGRID_REPLY_DOMAIN`. Extending it to a list of allowed domains is a small change when the need arises.)

---

## Testing locally (inbound)

1. Start the app: `npm run start:local`.
2. Tunnel the webhook: `ngrok http 3000`.
3. Update the SendGrid Inbound Parse host's Destination URL to the ngrok URL + `/webhooks/sendgrid/inbound`.
4. Trigger an outbound `send_email` call (use the web chat widget and walk through `lead_capture` until it sends the confirmation).
5. From your real inbox, hit Reply.
6. The webhook should fire within a few seconds; the model's reply should land back in your inbox.

Watch the app logs for the processing outcome (`processed`, `duplicate`, etc.) if something goes wrong.

---

## Known gotchas

- **MX TTL.** New MX records can take up to 24 hours to propagate. If inbound isn't working right after setup, wait and retry.
- **SendGrid verified sender.** Outbound `From` addresses must be on a domain you have authenticated with SendGrid (SPF/DKIM). If you change `SENDGRID_REPLY_DOMAIN`, you need to authenticate the new domain.
- **Gmail "via" warnings.** If you see a `via sendgrid.net` subtext in Gmail, DKIM/SPF for the reply domain has not been set up. Add the SendGrid-provided records.
- **Subject lines on replies.** The model does not control the outbound subject on a reply — `EmailService` reuses the inbound subject (prefixed with `Re:` if absent) to keep threading clean.
