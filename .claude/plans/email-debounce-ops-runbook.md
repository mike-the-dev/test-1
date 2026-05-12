# Email Debounce — Ops Runbook

Operational steps required to enable the email-reply debounce feature in production. The backend code is already shipped and gated behind a feature flag (default off). This document covers the AWS infrastructure setup and the safe rollout procedure.

**Read-time:** ~10 minutes.
**Execute-time:** ~30 minutes for AWS setup + 15 minutes for staged rollout.

---

## What this feature does (1-paragraph refresher)

Inbound emails to `assistant@reply.<domain>` no longer trigger an immediate LLM reply. Instead, each inbound email writes the user message to conversation history immediately, then sets/resets a 90-second debounce timer in AWS EventBridge Scheduler. When the timer fires, an internal endpoint generates ONE consolidated reply covering all outstanding user messages and sends it via email. If the user switches channels (web/SMS) mid-window, that channel's reply consumes all pending messages AND cancels the email schedule — no stale email reply ever lands.

---

## Prerequisites

- AWS account with permission to manage IAM, EventBridge, and Secrets Manager
- Existing prod deployment of `ai-chat-session-api` with a public HTTPS URL (e.g. `https://api.<domain>`)
- Ability to set env vars on prod and rotate secrets

---

## Step 1 — Generate the internal flush secret

This is the bearer token EventBridge will use to authenticate its callbacks to your app's internal flush endpoint.

Generate a cryptographically random 32+ character string. Any of these work:

```bash
# Option A: OpenSSL
openssl rand -base64 32

# Option B: Node
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# Option C: Python
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

Store the value as `INTERNAL_FLUSH_SECRET` in your prod secrets manager. **Do not commit this anywhere.**

---

## Step 2 — Create IAM roles in AWS

You need TWO roles. The app's role to manage schedules, and the scheduler's role to invoke the API Destination.

### 2a. Application IAM permissions

Attach this policy to your app's IAM principal (ECS task role, EC2 instance profile, Lambda role — whatever runs the NestJS app):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "scheduler:CreateSchedule",
        "scheduler:UpdateSchedule",
        "scheduler:DeleteSchedule",
        "scheduler:GetSchedule"
      ],
      "Resource": "arn:aws:scheduler:*:*:schedule/default/email-flush-*"
    },
    {
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::*:role/SchedulerInvokeApiDestinationRole"
    }
  ]
}
```

The `iam:PassRole` is needed because the app passes the scheduler's role ARN when creating each schedule.

### 2b. EventBridge Scheduler execution role

Create a NEW IAM role named (suggested) `SchedulerInvokeApiDestinationRole`.

**Trust relationship:**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "scheduler.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

**Inline policy:**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "events:InvokeApiDestination",
      "Resource": "arn:aws:events:*:*:api-destination/EmailFlushDestination/*"
    }
  ]
}
```

Record the role ARN — you'll set it as `SCHEDULER_ROLE_ARN` in app env.

---

## Step 3 — Create the EventBridge Connection (auth)

In the AWS Console: **EventBridge → API destinations → Connections → Create connection**.

- **Name:** `EmailFlushConnection`
- **Authorization type:** API Key
- **API key name:** `X-Internal-Auth`
- **API key value:** the `INTERNAL_FLUSH_SECRET` value from Step 1

Save. AWS creates a Secrets Manager secret automatically to store the value.

---

## Step 4 — Create the EventBridge API Destination

In the same console section: **API destinations → Create API destination**.

- **Name:** `EmailFlushDestination`
- **API destination endpoint:** `https://<your-prod-app-url>/internal/email-flush/*`
  (The `*` wildcard is required — EventBridge will substitute the session ULID.)
- **HTTP method:** `POST`
- **Invocation rate limit:** start with `1000` per second (well above expected volume)
- **Connection:** select `EmailFlushConnection` from Step 3

Save. Record the API Destination ARN — you'll set it as `SCHEDULER_API_DESTINATION_ARN` in app env.

---

## Step 5 — Set env vars in prod

Add or update these in your prod env:

| Variable | Value |
|---|---|
| `EMAIL_DEBOUNCE_ENABLED` | `false` ← **start disabled for safety** |
| `EMAIL_DEBOUNCE_WINDOW_SECONDS` | `90` (or your preferred window) |
| `INTERNAL_FLUSH_SECRET` | the secret from Step 1 |
| `SCHEDULER_BACKEND` | `real` |
| `SCHEDULER_ROLE_ARN` | the role ARN from Step 2b |
| `SCHEDULER_API_DESTINATION_ARN` | the API Destination ARN from Step 4 |
| `INTERNAL_FLUSH_URL` | `https://<your-prod-app-url>/internal/email-flush` (without the trailing wildcard) |

**Important:** `INTERNAL_FLUSH_SECRET` is required at boot — the app will fail to start if it's missing. This is deliberate; it's better than silently 401ing every callback in production.

---

## Step 6 — Deploy with the flag OFF

Deploy the new code to prod. Verify:

1. App boots successfully. Check logs for `Application listening on port` and absence of any "INTERNAL_FLUSH_SECRET is required" errors.
2. Send a test inbound email to `assistant@reply.<domain>`. Confirm the SYNCHRONOUS path still works exactly as it did before — reply lands in inbox, threading intact. The orchestrator IS in the code path even with the flag off; only the scheduler is bypassed.
3. Confirm no errors in CloudWatch / Sentry.

---

## Step 7 — Smoke test in staging (if available)

If you have a staging env, repeat Step 6 there with `EMAIL_DEBOUNCE_ENABLED=true` first.

1. Send one inbound email. Wait 90 seconds. Reply should arrive. Look for these structured log events in order:
   - `[event=schedule_created sessionUlid=... fireAt=...]`
   - `[event=reply_orchestrator_reply_sent sessionUlid=... channel=email]`
   - `[event=schedule_cancel_not_found sessionUlid=...]` (the schedule auto-deletes after firing, so the cancel-in-finally hits a not-found, which is expected)
2. Send TWO inbound emails 30 seconds apart. Confirm only ONE outbound reply, that it covers both inbound messages, and that it arrives ~90s after the SECOND email (not the first — the timer reset).
3. Send an inbound email, then open web chat and send a message within 60s. Confirm the web reply addresses BOTH (the email + the web message), and confirm the email schedule was cancelled by a `[event=schedule_cancelled ...]` log line.

If any of these fail in staging, do NOT proceed to prod. Investigate.

---

## Step 8 — Flip the flag in prod

Set `EMAIL_DEBOUNCE_ENABLED=true` in prod env. No code deploy needed — the flag is read at request time, not at boot.

Watch logs and metrics closely for the first hour:

- **Healthy signal:** `[event=schedule_created ...]` log lines on each inbound email, `[event=reply_orchestrator_reply_sent ...]` ~90s later, customer replies arriving in correct order with intact threading.
- **Unhealthy signals:**
  - 401s from EventBridge → secret mismatch between Connection and `INTERNAL_FLUSH_SECRET` env var
  - 404s from EventBridge → API Destination URL doesn't match the app's route
  - Missing replies → check for `[event=reply_orchestrator_no_op_no_outstanding ...]` (means the no-op short-circuit fired when it shouldn't have) or `[event=reply_orchestrator_cancel_failed ...]`
  - Threading broken (replies in new inbox threads instead of replying inline) → check for `[event=email_flush_missing_threading_context ...]` (means metadata wasn't persisted at inbound time)
  - LLM errors → existing Sentry alerts will surface these; cancel-in-finally ensures schedules don't linger

---

## Rollback

If anything looks wrong, flip `EMAIL_DEBOUNCE_ENABLED=false` in prod env. No code redeploy. The sync path resumes immediately for new inbound emails. Already-scheduled pending replies will still fire (they were scheduled before the flag flip), but no NEW schedules will be created.

To be extra thorough: after flipping the flag back, you can list and delete all pending schedules via:

```bash
aws scheduler list-schedules --name-prefix email-flush-
# For each schedule:
aws scheduler delete-schedule --name email-flush-<ulid>
```

But this isn't strictly necessary — pending schedules will fire as usual, and the orchestrator handles them correctly even if the flag is off.

---

## Cost expectations

EventBridge Scheduler pricing (as of 2026):
- **$1.00 per million state changes** (create + delete = 2 changes per email burst)
- **$1.00 per million invocations** (1 invocation per fired schedule)

At any realistic volume (e.g., 100K emails/month), this is well under $1/month total. Negligible.

CloudWatch logs from the orchestrator add some volume but are dominated by the existing app log lines.

---

## Monitoring recommendations

Add CloudWatch alarms or Sentry monitors for these structured log events:

- `[event=reply_orchestrator_cancel_failed ...]` — repeated occurrences indicate scheduler health issues
- `[event=email_flush_missing_threading_context ...]` — should never fire in normal operation; if it does, metadata isn't being persisted correctly
- `[event=internal_flush_auth_rejected ...]` — repeated rejections indicate a misconfigured Connection or someone probing the endpoint
- HTTP 5xx rate on `POST /internal/email-flush/*` — should be near zero
- Email inbound webhook rate vs orchestrator reply-sent rate — should track 1:1 over time (with the 90s delay built in)

---

## Known v1 limitations

- **Crash between `appendUserMessage` and `createOrResetEmailFlush`** leaves the user without a reply for that burst. Acknowledged trade-off. No monitoring or sweeper for this yet — add if it becomes a real problem in production.
- **No SendGrid webhook signature verification.** Anyone who knows the inbound webhook URL can forge an inbound email. Twilio inbound is signed; SendGrid is not yet. This is the highest-priority remaining security follow-up (separate from this feature).
- **AWS EventBridge Scheduler rate limit** is 1000 CreateSchedule/sec per account. Nowhere near our volume but worth knowing.
- **Cold-deploy race:** if you deploy a code change that affects the orchestrator behavior WHILE a schedule is pending, the schedule will fire against the new code. This is normally fine but is a theoretical edge case to be aware of during deploys.

---

## Questions or issues

Logs are the source of truth. Every meaningful event is structured (`[event=... sessionUlid=... ...]`) for easy grep in CloudWatch. The full plan + architectural reasoning is at `.claude/plans/email-debounce-cross-channel.md`.
