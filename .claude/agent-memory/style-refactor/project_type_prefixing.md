---
name: Domain type prefixing in types files
description: All types in src/types/ must be prefixed with the domain name (e.g. ChatSession, EmailReply)
type: project
---

All interfaces and types in any `src/types/<Domain>.ts` file must carry the domain prefix. Examples:
- `src/types/ChatSession.ts`: `ChatSessionIdentityRecord`, `ChatSessionMetadataRecord`, etc.
- `src/types/EmailReply.ts`: `EmailReplySendGridInboundFormFields`, `EmailReplyInboundProcessOutcome`, `EmailReplyParsedInboundReply`, etc.

Bare names like `SendGridInboundFormFields` or `InboundProcessOutcome` are non-compliant even if they feel self-describing.

**Why:** The style guide requires all types in a domain types file to be prefixed with the domain name so they are unambiguous when imported across the codebase.

**How to apply:** When adding new types to any `src/types/` file, always prefix with the domain name. Applies to records, DTOs, enums, interfaces, and type aliases in that file.
