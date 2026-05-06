---
name: SDK error property extraction without as-casts
description: How to extract SDK-specific error properties (code, moreInfo) from unknown catch clauses without using banned as or typeof patterns
type: feedback
---

When a third-party SDK (Twilio, SendGrid, etc.) throws errors that extend `Error` with extra properties (e.g., `code`, `moreInfo`), the correct extraction pattern is:

1. Define an interface in `src/types/<Domain>.ts` that `extends Error` with the extra properties as optional (e.g., `SmsTwilioSdkError extends Error { code?: number | string; moreInfo?: string }`).
2. In the catch block, narrow with `instanceof Error` first (early return for non-Error case).
3. After narrowing, declare a typed local variable with explicit annotation: `const sdkError: SmsTwilioSdkError = error` — this works because `Error` is structurally assignable to `SmsTwilioSdkError` when all extra properties are optional.
4. Access `sdkError.code` / `sdkError.moreInfo` safely.

This avoids `as`, `typeof`, and `in` while preserving all SDK-specific log fields.

**Why:** The banned patterns (`as`, `typeof x === "object"`, `in`) can't be used to access extra SDK properties from `unknown`. The `instanceof Error` narrowing + interface-with-optional-extras pattern is the only fully compliant path.

**How to apply:** Any time a service catches SDK errors and logs extra properties beyond `name`. Define the interface in `src/types/`, import it, and use the structured narrowing pattern.
