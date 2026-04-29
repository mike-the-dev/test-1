---
name: mrkdwn escape assertions in tests
description: When testing Slack mrkdwn output, assert escaped values (&amp; not &) — the escapeSlackMrkdwn helper transforms item names before interpolation
type: feedback
---

When writing test assertions against Slack block JSON rendered by `buildItemsText`, item names containing `&`, `<`, or `>` will be escaped in the output string. Assertions must match the escaped form.

Example: a fixture item named `"Bath & Groom"` produces `"Bath &amp; Groom"` in the blocks text. Asserting `toContain("Bath & Groom")` will fail.

**Why:** The `escapeSlackMrkdwn` module-scope helper (in `slack-alert.service.ts`) replaces `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;` before the item name is interpolated into the mrkdwn bullet string. This is intentional per the Phase 8b-followup design.

**How to apply:** Any test fixture that uses item names containing Slack mrkdwn control characters must assert against the escaped form, OR use names that contain no such characters (e.g., "Dog Walking", "Premium Bath") to keep assertions readable.
