---
name: crypto createHash spy pattern in Jest
description: Dynamic import of crypto to spy on createHash fails in Jest without --experimental-vm-modules — use static import and behavior assertions instead
type: feedback
---

Dynamic `await import("crypto")` inside a test body throws "A dynamic import callback was invoked without --experimental-vm-modules" in Jest. Even with a static `import * as cryptoModule from "crypto"`, spying on `createHash` won't intercept the tool's already-destructured binding (`import { createHash } from "crypto"`).

**Why:** Jest's module system doesn't re-wire already-resolved named imports when you spy on the module namespace object.

**How to apply:** Instead of spying on `createHash`, assert the observable behavior that proves it was never called. For the "attempts checked before hash" invariant, assert that no `UpdateCommand` was issued — the attempts-increment UpdateCommand only fires after a hash comparison fails, so its absence proves no comparison was made.
