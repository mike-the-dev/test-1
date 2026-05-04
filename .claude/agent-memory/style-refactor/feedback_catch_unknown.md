---
name: catch clause must use unknown type annotation
description: All catch clauses must annotate the error variable as unknown — catch (error: unknown) not catch (error)
type: feedback
---

All `catch` clauses in service files must use the `: unknown` annotation:

```ts
// BAD
} catch (pointerError) {

// GOOD
} catch (pointerError: unknown) {
```

**Why:** The codebase consistently uses `catch (errorVar: unknown)` across all services and tools. Without the annotation, TypeScript implicitly types the error as `any`, which weakens type safety. The subsequent `errorVar instanceof Error ? errorVar.name : "UnknownError"` pattern relies on the error being typed as `unknown` to force the instanceof check.

**How to apply:** Any new `catch` block added to service or tool files must have `: unknown` on the caught error variable. This applies everywhere — best-effort catches, top-level catches, nested catches.
