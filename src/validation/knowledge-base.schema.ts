import { z } from "zod";

// Account ID as sent by the control-panel API: the DynamoDB PK form "A#<26-char-ulid>".
// The controller strips the "A#" prefix before passing the raw ULID to the service.
// This mirrors the convention in web-chat.schema.ts / WebChatController exactly.
const accountIdRegex = /^A#[0-9A-HJKMNP-TV-Z]{26}$/;

export const ingestDocumentSchema = z.object({
  account_id: z
    .string()
    .regex(accountIdRegex, "account_id must be an A#-prefixed 26-character ULID"),
  external_id: z.string().min(1, "external_id must not be empty"),
  title: z.string().min(1, "title must not be empty"),
  text: z.string().min(1, "text must not be empty"),
  source_type: z.enum(["pdf", "csv", "docx", "txt", "html"], {
    message: "source_type must be one of: pdf, csv, docx, txt, html",
  }),
  mime_type: z.string().optional(),
});

export type IngestDocumentBody = z.infer<typeof ingestDocumentSchema>;

export const deleteDocumentSchema = z.object({
  account_id: z
    .string()
    .regex(accountIdRegex, "account_id must be an A#-prefixed 26-character ULID"),
  external_id: z.string().min(1, "external_id must not be empty"),
});

export type DeleteDocumentBody = z.infer<typeof deleteDocumentSchema>;

export const getDocumentSchema = z.object({
  account_id: z
    .string()
    .regex(accountIdRegex, "account_id must be an A#-prefixed 26-character ULID"),
  external_id: z.string().min(1, "external_id must not be empty"),
});

export type GetDocumentQuery = z.infer<typeof getDocumentSchema>;
