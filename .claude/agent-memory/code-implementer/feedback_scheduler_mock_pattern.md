---
name: SchedulerClient mock pattern
description: How to mock @aws-sdk/client-scheduler in specs — use mockClient at module level, not inside beforeEach
type: feedback
---

Use `const schedulerMock = mockClient(SchedulerClient)` at module level (outside `describe`), same as DynamoDB mocking. Call `schedulerMock.reset()` in `beforeEach`. The mock patches the SchedulerClient prototype so it intercepts all sends from the service under test even when the service creates its own `new SchedulerClient(...)` in the constructor.

**Why:** `aws-sdk-client-mock` works by patching the prototype globally. Module-level declaration ensures the mock is registered before the NestJS module compiles.

**How to apply:** Every spec that tests a service that creates `new SchedulerClient(...)` internally (like `SchedulerService`) should follow this pattern.
