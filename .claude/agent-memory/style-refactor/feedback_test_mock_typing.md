---
name: Test mock typing without as-assertions
description: How to type test mock objects so jest.fn() methods are accessible without banned `as jest.Mock` casts
type: feedback
---

When a mock object is built with `jest.fn()` fields and later needs `.mockRejectedValue()` / `.mockResolvedValue()` calls, do NOT cast with `as jest.Mock`. Instead:

1. Remove the explicit return type from the factory function (e.g., `const makeMockTool = (name: string)` not `: ChatTool`)
2. Let TypeScript infer the return type including `jest.Mock` field types
3. Declare the variable as `ReturnType<typeof makeMockTool>` instead of the interface type

**Why:** `as jest.Mock` is a banned `as` assertion. The inferred type from `jest.fn()` already includes the `.mock*` methods — the cast was only needed because the return type was annotated as the interface (which doesn't have those methods).

**How to apply:** Any time a test spec declares `let mockX: SomeInterface` and assigns from a factory that uses `jest.fn()`, and later calls `.mockRejectedValue` etc. — switch to `ReturnType<typeof factoryFn>`.
