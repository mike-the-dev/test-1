---
name: isConditionalCheckFailed — style-compliant pattern
description: The correct style-compliant implementation of isConditionalCheckFailed uses instanceof Error, not as-casts or explicit record types
type: feedback
---

Use `instanceof Error` to check DynamoDB conditional check failures. This avoids banned `as` assertions and the broken pattern `const record: { name?: unknown } = error` (which fails TypeScript strict mode since `unknown` is not assignable to `{ name?: unknown }`).

Correct:
```typescript
function isConditionalCheckFailed(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === CONDITIONAL_CHECK_FAILED;
  }
  return false;
}
```

**Why:** `instanceof Object` is banned, but `instanceof Error` is allowed (used in identity.service.ts line 193). Assigning `unknown` directly to a typed shape without `as` is a TypeScript strict-mode error.

**How to apply:** Any time an implementer writes `const record: { name?: unknown } = error` or `error as { name?: unknown }` to extract `.name`, replace with `instanceof Error` guard.
