---
name: Phase 8c KB auth — codebase findings
description: Key facts discovered during Phase 8c arch-planning that are non-obvious from reading the code
type: project
---

There is exactly one /knowledge-base/* controller: KnowledgeBaseController (src/controllers/knowledge-base.controller.ts), with three routes: POST, GET, DELETE on /knowledge-base/documents. No second KB controller exists.

The controller spec (knowledge-base.controller.spec.ts) calls controller methods directly — it does NOT use supertest or HTTP dispatch. Guards do not execute in direct-call tests. The correct test strategy is: mock the guard in the testing module (always-pass), add a Reflect.getMetadata("__guards__", KnowledgeBaseController) assertion to verify the decoration exists, and cover all guard rejection paths in the guard's own spec.

No request-logging middleware exists in this project (src/middleware/ does not exist). No header redaction is needed in middleware — only in the Sentry beforeSend scrubber.

The env validation chain uses Zod (not Joi). The validate function in src/config/env.validation.ts wraps envSchema.safeParse().

No Swagger/OpenAPI setup exists — @nestjs/swagger is not in package.json.
