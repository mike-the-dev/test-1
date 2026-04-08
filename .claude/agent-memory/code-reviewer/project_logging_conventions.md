---
name: Structured Logging Conventions
description: Logging patterns, privacy rules, and log level config established by the structured logging implementation
type: project
---

NestJS Logger-based structured logging is in place across all four core services and main.ts.

**Logger field placement:** `private readonly logger = new Logger(ServiceName.name)` must be the FIRST class field in every service.

**Log level gating:** `APP_ENV=prod` → `["log", "warn", "error"]`. Any other value → full set including `debug` and `verbose`. Controlled via `process.env.APP_ENV` at NestFactory.create time (before DI is available). Variable typed as `LogLevel[]` — no `as` assertion.

**Log message format:** Inline `key=value` pairs in square brackets (e.g., `[sessionUlid=${sessionUlid} historySize=${history.length}]`). NOT JSON. NOT colon-separated.

**Privacy rules (absolute):** NEVER log `userMessage`, `reply`/`replyText`, `message.content` (Discord), `firstBlock.text` (Anthropic), API keys, or bot tokens. Allowed: `.length`, counts, IDs (snowflakes, ULIDs), model names, source strings, error objects.

**Discord ready event:** `client.once("ready", ...)` registered BEFORE `client.login()`. `client.user?.tag` only accessed inside the ready handler, not after login() resolves.

**Try/catch pattern:** Services that can throw (chat-session, anthropic) log the error AND re-throw. Never log-and-swallow. DiscordService outer catch is the user-facing recovery layer.

**Why:** Operational visibility in dev, quiet in prod, and strict privacy around user message content (core product requirement).

**How to apply:** Flag any new log statement that could include user-generated content. Verify logger field is first in class. Flag any `console.*` in src/services/.
