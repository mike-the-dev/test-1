---
name: dynamicSystemContext must be declared before the tool loop
description: Any variable that feeds into AnthropicService.sendMessage and needs to be set by pre-loop logic MUST be declared before the while loop in handleMessage
type: feedback
---

In `chat-session.service.ts handleMessage`, the `dynamicSystemContext` variable was originally declared INSIDE the while loop (recalculated each iteration). This pattern breaks any pre-loop loader that needs to set the value before the first Anthropic call.

**Why:** If the declaration stays inside the loop, the first iteration's assignment silently overwrites whatever the loader set before the loop, discarding the continuation context entirely. No TypeScript error — pure silent behavioral bug.

**How to apply:** When adding any pre-loop logic that needs to influence the Anthropic call (system context, messages array), ensure the relevant variables are declared with `let` BEFORE the loader block AND before `let iteration = 0`. The while loop body should only READ the pre-computed values, not re-declare them.
