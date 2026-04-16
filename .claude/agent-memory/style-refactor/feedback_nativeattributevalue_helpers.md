---
name: NativeAttributeValue array helpers for DynamoDB tool files
description: Pattern for handling Array.isArray and as-casts on DynamoDB NativeAttributeValue arrays in tool files
type: feedback
---

When a tool reads array fields from a DynamoDB record (e.g., `service.variants`, `service.images`), use centralized helper functions rather than inline `Array.isArray()` or `as` casts:

- `toRecordArray(value: NativeAttributeValue | undefined): Record<string, NativeAttributeValue>[]` — for arrays of objects (variants, options)
- `toNativeArray(value: NativeAttributeValue | undefined): NativeAttributeValue[]` — for arrays of scalars (images as strings)

These helpers follow the same pattern as `toRecordArray` in `list-services.tool.ts`. They use a single controlled `as` cast at the helper boundary (acceptable at DynamoDB read boundaries per the as-assertions memory) plus an `isInteger(length)` guard.

**Why:** `Array.isArray()` is banned. `as` casts are banned except at DynamoDB SDK boundaries. Centralizing array coercion in named helpers keeps the execute() method clean and consistent across tool files.

**How to apply:** Any time a tool file reads a potentially-array DynamoDB field, import `NativeAttributeValue` from `@aws-sdk/lib-dynamodb` and define these helpers at the top of the file (before the class, after the constants).
