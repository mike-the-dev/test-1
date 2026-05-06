---
name: jest.mock factory hoisting — don't reference outer consts
description: jest.mock factories are hoisted above const declarations; referencing outer jest.fn() consts inside the factory causes "Cannot access before initialization"
type: feedback
---

`jest.mock` factories are hoisted to the top of the file by Babel/Jest, BEFORE any `const` declarations. Referencing an outer `const mockFn = jest.fn()` inside the factory will throw `ReferenceError: Cannot access 'mockFn' before initialization`.

The pattern that works: create the mock fn INSIDE the factory, attach it to the returned object, then retrieve it via `jest.requireMock("module").property` after.

```ts
jest.mock("some-module", () => {
  const fn = jest.fn().mockReturnValue({ method: jest.fn() });
  fn.staticMethod = jest.fn();
  return fn;
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockedModule = jest.requireMock("some-module");
const mockStaticMethod: jest.Mock = mockedModule.staticMethod;
```

**Why:** jest.mock hoisting is a Babel transform that moves the call before imports. This happens consistently for both default and named mocks.

**How to apply:** Any time you mock a module (twilio, crypto, etc.) and need to control/assert on individual functions inside the mock. Do NOT declare `const mockFn = jest.fn()` above `jest.mock(...)` and reference it in the factory.
