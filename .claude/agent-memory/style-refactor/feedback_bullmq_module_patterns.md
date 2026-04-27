---
name: BullMQ module patterns in NestJS app.module.ts
description: Style rules for BullMQ module registration and queue constants in this codebase
type: feedback
---

Queue name strings must be extracted to a named constant in `src/utils/knowledge-base/constants.ts` and imported everywhere they appear (app.module.ts, controller, processor, controller spec). Never inline the queue name as a magic string.

`BullModule.forRootAsync({ useFactory: ... })` must use a block-body arrow function, not a parenthesized object return — the parenthesized return `=> ({ ... })` is banned by the style enforcer.

**Why:** Parenthesized object returns are a blanket ban in the style enforcer. Shared constants avoid drift between the processor's `@Processor(NAME)` decorator, the controller's `@InjectQueue(NAME)`, `BullModule.registerQueue({ name: NAME })`, and `getQueueToken(NAME)` in specs.

**How to apply:** When adding or reviewing BullMQ code, check all four sites (processor decorator, controller inject, module registration, spec token) use the same exported constant.
