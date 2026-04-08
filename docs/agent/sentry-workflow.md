# Sentry Workflow (Agent Notes)

Use these steps when asked to fetch recent Sentry issues or investigate a specific error.

## Guardrails (Must Follow)
- Do not modify code until the branch gate below is satisfied.
- If you are not on a `fix/sentry-<ISSUE_ID>` branch, stop and ask the user how to proceed.
- Always confirm the target issue ID before creating the branch.

## Latest Issues (Most Recent)
- Command: `sentry-cli issues list --org instapaytient --project <frontend-project-slug> --max-rows 20`
- Confirm the correct frontend project slug before running the command.
- Use `--query` only when you need time filtering (e.g., `firstSeen:-24h` or `firstSeen:>=2025-12-31`).
- If the user wants more, increase `--max-rows` or refine the query (e.g., `is:unresolved`).

## Issue Details
- Use the issue ID from the list, then fetch details with the Sentry API.
- Example approach:
  1) Read the auth token from `~/.sentryclirc` or `SENTRY_AUTH_TOKEN`.
  2) GET `https://sentry.io/api/0/issues/<ISSUE_ID>/` for metadata.
  3) GET `https://sentry.io/api/0/issues/<ISSUE_ID>/events/` and then `/events/<EVENT_ID>/` for the latest payload.
- After summarizing, ask whether the user wants to apply a fix/patch for the issue.

## Apply Fix / Patch (When Requested)
### Pre-Patch Gate (Required)
- Confirm the target issue and proposed fix with the user.
- Create a new branch from `staging` before any code edits:
  - `git checkout staging`
  - `git pull`
  - `git checkout -b fix/sentry-<ISSUE_ID>`
- Sanity check before edits:
  - `git status -sb`
  - `git rev-parse --abbrev-ref HEAD`
- Do not proceed if the branch name is not `fix/sentry-<ISSUE_ID>`. Ask the user to proceed or fix the branch.
- Required agent response before any edits: `Branch created: fix/sentry-<ISSUE_ID>`

### Patch Work (After Gate)
- Implement the fix, add/update tests as appropriate, and summarize the changes.
- Run relevant tests and ensure they pass before creating the PR.
- Commit with `./gitmark.sh` before creating the PR. Use Conventional Commits and model messages on these examples:
  - Feature:
    `./gitmark.sh "feat(instant-service): add instant service creation flow" "Introduced the instant service creation flow with validation, UI wiring, and client-side persistence. Enables merchants to configure and publish instant checkout offerings." src/features/instantService/create/useCreateInstantService.ts src/features/instantService/create/useCreateInstantServiceForm.ts`
  - Fix:
    `./gitmark.sh "fix(orders): guard against missing hydrated order data" "Added defensive checks to prevent runtime errors when order items reference missing data during hydration. Prevents client-side crashes during sort operations." src/features/orders/order.service.ts src/features/orders/list/useGetRecentOrders.ts`
  - Refactor:
    `./gitmark.sh "refactor(services): extract service mapping into shared utility" "Refactored service mapping into a centralized utility to improve reuse and maintainability without altering runtime behavior." src/features/services/_shared/services.mappers.ts src/features/services/services.service.ts`
  - Chore:
    `./gitmark.sh "chore(app): bump version to 1.0.86" "Incremented application version after stable deployment and UI updates." package.json`
  - Test:
    `./gitmark.sh "test(instant-service): add integration coverage for creation flow" "Added integration tests validating instant service creation, persistence, and response mapping." src/features/instantService/instantService.service.test.tsx`
  - Docs:
    `./gitmark.sh "docs(instant-service): document instant service flow" "Added high-level documentation describing instant service triggers, UI flow, and state lifecycle." docs/instant-service/overview.md`
  - Lock-In / Chapter Close:
    `./gitmark.sh "feat(instant-service): finalize instant service publishing flow" "Completed UI wiring for publishing instant services. Flow is validated, tested, and production-ready." src/features/instantService/instantService.service.ts src/features/instantService/share/useInstantServiceShareEmail.ts src/features/instantService/share/useInstantServiceShareSms.ts`
- Create a PR for the new branch with the proposed fix/patch and include:
  - Short description
  - Testing notes (commands run)
  - Affected modules (e.g., `src/payments/`, `src/auth/`)
- Use `gh` for GitHub operations (e.g., `gh pr create`).
- After creating the PR, report that the Sentry workflow is complete and share the PR link.

## Notes
- The `.env` load warning from `sentry-cli` can be ignored unless it blocks auth.
- Always summarize: title, culprit, first/last seen, count, and the relevant request payload or stack trace.
