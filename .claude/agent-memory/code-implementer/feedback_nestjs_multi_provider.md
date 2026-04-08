---
name: NestJS 11 multi-provider pattern
description: NestJS 11 does not support multi:true on custom token providers — use useFactory to collect instances into an array instead
type: feedback
---

NestJS v11 does not include `multi` in the `Provider` type interface. `{ provide: TOKEN, useClass: Foo, multi: true }` causes a TypeScript compile error (`Object literal may only specify known properties, and 'multi' does not exist in type 'Provider'`).

**Why:** NestJS does not replicate Angular's multi-provider pattern at the type level in v11.

**How to apply:** When registering a collection of injectable instances under a shared token (e.g., tools, interceptors, validators), use the `useFactory` pattern instead:

```ts
SaveUserFactTool,
{
  provide: CHAT_TOOLS_TOKEN,
  useFactory: (saveUserFact: SaveUserFactTool) => {
    return [saveUserFact];
  },
  inject: [SaveUserFactTool],
},
```

Each concrete class must also be registered as a standalone provider so it can be injected into the factory.
