import { z } from "zod";

// 26-character Crockford base32: digits 0–9 and uppercase A–Z excluding I, L, O, U
const ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const createSessionSchema = z.object({
  agentName: z.string().min(1),
  guestUlid: z.string().regex(ulidRegex, "guestUlid must be a valid 26-character ULID"),
});

export const sendMessageSchema = z.object({
  sessionUlid: z.string().regex(ulidRegex, "sessionUlid must be a valid 26-character ULID"),
  message: z.string().min(1, "message must not be empty"),
});

export type CreateSessionBody = z.infer<typeof createSessionSchema>;
export type SendMessageBody = z.infer<typeof sendMessageSchema>;
