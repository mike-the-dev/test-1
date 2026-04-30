---
name: Redundant type annotations on let declarations
description: When a let variable's type is fully inferrable from its initializer, remove the annotation; when not (e.g., DDB boundary reads), keep it.
type: feedback
---

`let` declarations whose type is fully inferrable from their initializer must NOT have an explicit annotation (per the "no inline type annotations" rule). For example:

```ts
// BAD — TypeScript already infers string | undefined from budgetContext
let dynamicSystemContext: string | undefined = budgetContext;

// GOOD — annotation removed; inference is sufficient
let dynamicSystemContext = budgetContext;
```

DDB-boundary reads are an exception: `const customerId: string | null = metadataResult.Item?.customer_id ?? null` — the annotation is necessary because the DDB SDK returns `NativeAttributeValue | null` without it, which is too broad. The explicit annotation narrows to the domain type.

**Why:** The "no inline type annotations" rule exists to avoid redundant type noise. TypeScript's inference handles the common case. At DDB boundaries, the annotation is structural, not redundant.

**How to apply:** Before removing a `let` annotation, verify TypeScript would infer the exact same type. If it infers `NativeAttributeValue` or `any` instead of the domain type, the annotation is necessary. If it infers the same type, remove it.
