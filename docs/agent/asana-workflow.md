# Asana Workflow (Agent Notes)

Use these steps when asked to fetch recent Asana tasks or investigate a specific task.

## Guardrails (Must Follow)
- Do not modify code until the branch gate below is satisfied.
- Listing tasks and fetching task details are allowed on any branch.
- Do not run any git commands until the user selects a task and gives the green light to proceed.
- If you are not on a `feat/asana-<TASK_ID>` or `fix/asana-<TASK_ID>` branch, stop and ask the user how to proceed.
- Always confirm the target task ID before creating the branch.

## Latest Tasks (Most Recent)
- Command:
  - `./scripts/asana/list-board.sh`
- To target a specific project:
  - `./scripts/asana/list-board.sh --project <PROJECT_GID>`
- Increase the task list size:
  - `./scripts/asana/list-board.sh --limit 100`
- After running the list command, print the output for the user and ask which task to inspect.
- Do not proceed without sharing the list output (tasks + GIDs) in the response.

## Task Details
- Use the task GID from the list, then fetch details:
  - `./scripts/asana/task-details.sh <TASK_GID>`
- For more comments:
  - `./scripts/asana/task-details.sh <TASK_GID> --comments-limit 50`
- Use the Description and Custom Fields as the primary requirements context before starting any work.
- After summarizing, ask whether the user wants to apply a fix/patch or build the feature.

## Apply Fix / Patch (When Requested)
### Pre-Patch Gate (Required)
- Confirm the target task and proposed fix with the user.
- Create a new branch from `staging` before any code edits:
  - `git checkout staging`
  - `git pull`
  - `git checkout -b fix/asana-<TASK_ID>` or `git checkout -b feat/asana-<TASK_ID>`
- Sanity check before edits:
  - `git status -sb`
  - `git rev-parse --abbrev-ref HEAD`
- Do not proceed if the branch name is not `feat/asana-<TASK_ID>` or `fix/asana-<TASK_ID>`. Ask the user to proceed or fix the branch.
- Required agent response before any edits: `Branch created: <branch-name>`

### Patch Work (After Gate)
- Implement the fix, add/update tests as appropriate, and summarize the changes.
- Run relevant tests and ensure they pass before creating the PR.
- Commit with `./gitmark.sh` before creating the PR. Use Conventional Commits and model messages on these examples:
  - Feature:
    `./gitmark.sh "feat(instant-service): add instant checkout service creation" "Introduced instant checkout service creation flow with full validation, service wiring, and persistence. Enables merchants to configure and publish instant checkout offerings." src/features/instantService/instantService.service.ts src/features/instantService/create/page.tsx`
  - Fix:
    `./gitmark.sh "fix(cart): guard against missing hydrated service data" "Added defensive checks to prevent runtime errors when cart items reference services that are not fully hydrated. Prevents backend 500s during sort operations." src/services/cart/cart.service.ts`
  - Refactor:
    `./gitmark.sh "refactor(stripe): extract MCC mapping into shared utility" "Refactored MCC code mapping into a centralized utility to improve reuse and maintainability without altering runtime behavior." src/utils/mccCodes.all.ts src/services/stripe.service.ts`
  - Chore:
    `./gitmark.sh "chore(app): bump version to 1.0.86" "Incremented application version after stable deployment and service updates." src/app.service.ts`
  - Test:
    `./gitmark.sh "test(instant-service): add integration coverage for creation flow" "Added integration tests validating instant checkout service creation, persistence, and response mapping." src/features/instantService/instantService.service.integration.test.tsx`
  - Docs:
    `./gitmark.sh "docs(payouts): document payout scheduler execution flow" "Added high-level documentation describing payout scheduler triggers, queue flow, and execution lifecycle." docs/payouts/scheduler.md`
  - Lock-In / Chapter Close:
    `./gitmark.sh "feat(stripe): finalize MCC update flow for connected accounts" "Completed controller and service wiring for updating MCC codes on Stripe connected accounts. Flow is validated, tested, and production-ready." src/controllers/stripe.controller.ts src/services/stripe.service.ts src/utils/mccCodes.all.ts`
- Create a PR for the new branch with the proposed fix/patch and include:
  - Short description
  - Testing notes (commands run)
  - Affected modules (e.g., `src/payments/` or `src/auth/`)
- Use `gh` for GitHub operations (e.g., `gh pr create`).
- After creating the PR, report that the Asana workflow is complete and share the PR link.

## Notes
- These scripts auto-load the repo-root `.env` for `ASANA_TOKEN`.
- Always summarize: title, status, assignee, due date, last updated, and key details from notes/comments.
