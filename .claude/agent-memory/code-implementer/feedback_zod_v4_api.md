---
name: Zod v4 API differences
description: Zod v4 (4.3.6) has API differences from v3 that affect schema definitions
type: feedback
---

This project uses Zod v4.3.6 (not v3). Key differences:

- `z.AnyZodObject` does not exist — use `z.ZodObject<Record<string, z.ZodTypeAny>>` as a return type instead
- `z.record()` requires TWO arguments: `z.record(z.string(), z.unknown())` — passing one arg throws a type error
- `z.enum()` still works but takes a plain tuple: `z.enum(options as [string, ...string[]])` for dynamic arrays

**Why:** Encountered these errors when building `buildOnboardingSchema` and `onboardingBodyWrapperSchema` with v3 assumptions.

**How to apply:** Any time you write a Zod schema in this repo, use the v4 API. Check v4 docs for unfamiliar methods.
