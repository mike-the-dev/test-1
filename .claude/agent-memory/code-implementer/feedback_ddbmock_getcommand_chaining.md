---
name: aws-sdk-client-mock GetCommand chaining
description: When mocking multiple sequential DDB GetItem calls, all resolvesOnce must be chained on ONE .on(GetCommand) call — separate calls override each other
type: feedback
---

Do NOT set up multiple DDB mock responses for the same command type with separate `.on(GetCommand)` calls:

```ts
// WRONG — second call overrides first, first response is never returned
ddbMock.on(GetCommand).resolvesOnce({ Item: accountRecord });
ddbMock.on(GetCommand).resolvesOnce({ Item: sessionMetadata });
```

Always chain all `resolvesOnce` calls on a single `.on(GetCommand)`:

```ts
// CORRECT — responses returned in order
ddbMock
  .on(GetCommand)
  .resolvesOnce({ Item: accountRecord })
  .resolvesOnce({ Item: sessionMetadata })
  .resolvesOnce({ Item: contactInfo });
```

**Why:** aws-sdk-client-mock's `.on()` returns the same mock instance but a new call to `.on(GetCommand)` resets the response queue — last-call wins. This caused 10 test failures in the multi-tenant-channel-routing phase where account record lookup + prior session lookup were separate `.on()` calls.

**How to apply:** Whenever a service under test calls DDB multiple times with the same command type (GetCommand is the most common), set up the full response sequence in one chained call in the test.
