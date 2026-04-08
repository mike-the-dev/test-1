---
name: Domain type prefixing in ChatSession.ts
description: All types in src/types/ChatSession.ts must be prefixed with ChatSession, including IdentityRecord → ChatSessionIdentityRecord
type: project
---

All interfaces and types in `src/types/ChatSession.ts` must carry the `ChatSession` prefix per the domain-prefixing rule. During the channel-agnostic chat session refactor, `IdentityRecord` was renamed to `ChatSessionIdentityRecord` to comply.

**Why:** The style guide requires all types in a domain types file to be prefixed with the domain name so they are unambiguous when imported across the codebase.

**How to apply:** When adding new types to `src/types/ChatSession.ts`, always prefix with `ChatSession`. Applies to records, DTOs, enums, and any other type shape in that file.
