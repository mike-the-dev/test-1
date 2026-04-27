---
name: Test mock typing without as-assertions
description: How to type test mock objects so jest.fn() methods are accessible without banned `as jest.Mock` casts
type: feedback
---

When a mock object is built with `jest.fn()` fields and later needs `.mockRejectedValue()` / `.mockResolvedValue()` calls, do NOT cast with `as jest.Mock`. Instead:

1. Remove the explicit return type from the factory function (e.g., `const makeMockTool = (name: string)` not `: ChatTool`)
2. Let TypeScript infer the return type including `jest.Mock` field types
3. Declare the variable as `ReturnType<typeof makeMockTool>` instead of the interface type

**For class constructor mocks** (`jest.mock("some-module")` + auto-mock): use `jest.mocked(SomeClass)` instead of `SomeClass as jest.MockedClass<typeof SomeClass>`. The `jest.mocked()` helper is the type-safe, cast-free alternative and returns the same `jest.MockedClass` type.

**For `mockImplementation` return value**: when the mock implementation returns a partial object that doesn't fully satisfy the class type (e.g., `{ getCollections: mockFn }` for a class with many methods), simply omit the `as unknown as ClassName` cast — `mockImplementation`'s callback is typed loosely enough (`() => any`) to accept a plain partial object.

**For passing `Pick<T, K>` where T is expected**: when `Pick<T, "x" | "y">` covers all properties of T (i.e., the class only has x and y), remove the `as T` cast — TypeScript structural typing accepts the Pick type directly. The cast was defensive, not required.

**Why:** `as jest.Mock`, `as unknown as ClassName`, and `as SomeClass` are all banned `as` assertions. Jest's own `jest.mocked()` and the loose `mockImplementation` callback type provide type-safe alternatives without assertions.

**How to apply:** Any time a test spec declares `let mockX: SomeInterface` and assigns from a factory that uses `jest.fn()`, and later calls `.mockRejectedValue` etc. — switch to `ReturnType<typeof factoryFn>`. For class mocks, use `jest.mocked(TheClass)` instead of `TheClass as jest.MockedClass<typeof TheClass>`.
