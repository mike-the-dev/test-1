---
name: Handling banned as-assertions at DynamoDB boundaries
description: How to handle the conflict between banned as-assertions and the DynamoDB SDK's NativeAttributeValue typing when reading records
type: feedback
---

When removing a banned `as` assertion at a DynamoDB boundary (e.g., `result.Item as SomeDomainType`), the least-violation approach is to use an explicit type annotation on the history/data variable itself (`const history: ChatSessionMessage[] = result.Item?.messages ?? []`) rather than `as`. This is a known friction point between the "no as" rule and the DynamoDB SDK's `Record<string, NativeAttributeValue>` typing. The explicit annotation allows TypeScript structural checking rather than unsafe casting.

**Why:** The `as` ban exists to prevent unsafe type assertions. At DynamoDB read boundaries, some explicit typing is unavoidable — a variable annotation is structurally checked whereas `as` bypasses all checks.

**How to apply:** At DynamoDB SDK boundaries only, prefer an explicit variable type annotation over an `as` cast. Remove the intermediate typed variable (e.g., `existingRecord`) and annotate the leaf variable directly.
