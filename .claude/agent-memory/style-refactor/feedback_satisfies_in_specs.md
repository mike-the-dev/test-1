---
name: satisfies for test stub typing in spec files
description: How to type spec-file stub constants without banned as-assertions or inline type annotations
type: feedback
---

When a spec-file constant needs a specific literal type (e.g., a `sourceType: "pdf"` union member or a result DTO shape), use `satisfies` instead of `as const` or an explicit type annotation:

```ts
// BAD — as const is banned
const STUB = { sourceType: "pdf" as const };

// BAD — inline type annotation is banned
const STUB: SomeInterface = { ... };

// GOOD — satisfies preserves literal types and checks completeness
const STUB = {
  sourceType: "pdf",
  ...
} satisfies SomeInterface;
```

`satisfies` is allowed in spec files because the "no inline satisfies" ban applies only to services, controllers, mappers, pipes, and utils.

**Why:** `as const` and explicit type annotations are banned. `satisfies` provides compile-time type checking while letting TypeScript infer the narrower literal types.

**How to apply:** Any spec file constant that holds test data matching a domain interface — use `satisfies DomainInterface` instead of `: DomainInterface =` or `field: "value" as const`.
