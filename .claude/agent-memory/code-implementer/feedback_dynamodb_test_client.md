---
name: DynamoDB test client construction
description: How to correctly provide a DynamoDBDocumentClient in NestJS unit tests with aws-sdk-client-mock
type: feedback
---

Use `DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }))` when providing the mock DynamoDB client in NestJS test modules. The `aws-sdk-client-mock` `mockClient(DynamoDBDocumentClient)` call intercepts at the class level (patches prototype), so any real instance will be intercepted.

Do NOT use `DynamoDBDocumentClient.from({} as never)` — this fails at runtime because the underlying `@smithy/smithy-client` constructor requires a valid config with a `protocol` property.

**Why:** Discovered when both `identity.service.spec.ts` and `chat-session.service.spec.ts` failed with `TypeError: Cannot destructure property 'protocol' of 'config' as it is undefined`.

**How to apply:** Any time you write a NestJS unit test that provides `DYNAMO_DB_CLIENT`, construct the value as `DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }))` and import `DynamoDBClient` from `@aws-sdk/client-dynamodb`.
