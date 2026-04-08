# 1. Feature
./gitmark.sh "feat(instant-service): add instant checkout service creation" \
"Introduced instant checkout service creation flow with full validation, service wiring, and persistence. Enables merchants to configure and publish instant checkout offerings." \
src/features/instantService/instantService.service.ts \
src/features/instantService/create/page.tsx

# 2. Fix
./gitmark.sh "fix(cart): guard against missing hydrated service data" \
"Added defensive checks to prevent runtime errors when cart items reference services that are not fully hydrated. Prevents backend 500s during sort operations." \
src/services/cart/cart.service.ts

# 3. Refactor
./gitmark.sh "refactor(stripe): extract MCC mapping into shared utility" \
"Refactored MCC code mapping into a centralized utility to improve reuse and maintainability without altering runtime behavior." \
src/utils/mccCodes.all.ts \
src/services/stripe.service.ts

# 4. Chore
./gitmark.sh "chore(app): bump version to 1.0.86" \
"Incremented application version after stable deployment and service updates." \
src/app.service.ts

# 5. Test
./gitmark.sh "test(instant-service): add integration coverage for creation flow" \
"Added integration tests validating instant checkout service creation, persistence, and response mapping." \
src/features/instantService/instantService.service.integration.test.tsx

# 6. Docs
./gitmark.sh "docs(payouts): document payout scheduler execution flow" \
"Added high-level documentation describing payout scheduler triggers, queue flow, and execution lifecycle." \
docs/payouts/scheduler.md

# 7. Lock-In / Chapter Close
./gitmark.sh "feat(stripe): finalize MCC update flow for connected accounts" \
"Completed controller and service wiring for updating MCC codes on Stripe connected accounts. Flow is validated, tested, and production-ready." \
src/controllers/stripe.controller.ts \
src/services/stripe.service.ts \
src/utils/mccCodes.all.ts

# 8. Stash (WIP Preservation)
git stash push -m "wip: instant service integration tests (mid-validation)"