import { z } from "zod";

// Account ULID as sent by the control-panel API: the DynamoDB PK form "A#<26-char-ulid>".
// The controller strips the "A#" prefix before passing the raw ULID to the service.
// This mirrors the convention in web-chat.schema.ts / WebChatController exactly.
const accountUlidRegex = /^A#[0-9A-HJKMNP-TV-Z]{26}$/;

export const ingestDocumentSchema = z.object({
  accountUlid: z
    .string()
    .regex(accountUlidRegex, "accountUlid must be an A#-prefixed 26-character ULID"),
  externalId: z.string().min(1, "externalId must not be empty"),
  title: z.string().min(1, "title must not be empty"),
  text: z.string().min(1, "text must not be empty"),
  sourceType: z.enum(["pdf", "csv", "docx", "txt", "html"], {
    message: "sourceType must be one of: pdf, csv, docx, txt, html",
  }),
  mimeType: z.string().optional(),
});

export type IngestDocumentBody = z.infer<typeof ingestDocumentSchema>;
