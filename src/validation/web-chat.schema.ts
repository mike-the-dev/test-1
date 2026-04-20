import { z } from "zod";

// 26-character Crockford base32: digits 0–9 and uppercase A–Z excluding I, L, O, U
const ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// Account ULID as sent by the widget: the DynamoDB PK form "A#<26-char-ulid>".
// The "A#" prefix is what the customer pastes into their embed snippet as
// data-account-ulid. The controller strips it before calling the account
// lookup; downstream code works with the raw ULID only.
const accountUlidRegex = /^A#[0-9A-HJKMNP-TV-Z]{26}$/;

// Strict bare hostname: labels separated by dots, letters/digits/hyphens only.
// Rejects schemes ("://"), ports (":8080"), paths ("/foo"), query strings ("?x"),
// and empty strings. Each label must start and end with an alphanumeric character.
const parentDomainRegex =
  /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$/;

// Generous upper bound: 100,000,000 cents = $1,000,000. Rejects obvious abuse
// without constraining legit medical-spa budgets.
const MAX_BUDGET_CENTS = 100_000_000;

export const createSessionSchema = z.object({
  agentName: z.string().min(1),
  guestUlid: z.string().regex(ulidRegex, "guestUlid must be a valid 26-character ULID"),
  accountUlid: z
    .string()
    .regex(accountUlidRegex, "accountUlid must be an A#-prefixed 26-character ULID"),
});

export const sendMessageSchema = z.object({
  sessionUlid: z.string().regex(ulidRegex, "sessionUlid must be a valid 26-character ULID"),
  message: z.string().min(1, "message must not be empty"),
});

export const onboardingSchema = z.object({
  budgetCents: z
    .number()
    .int("budgetCents must be an integer")
    .positive("budgetCents must be positive")
    .max(MAX_BUDGET_CENTS, "budgetCents exceeds the maximum allowed value"),
});

export const sessionUlidParamSchema = z
  .string()
  .regex(ulidRegex, "sessionUlid must be a valid 26-character ULID");

export const embedAuthorizeSchema = z.object({
  accountUlid: z
    .string()
    .regex(accountUlidRegex, "accountUlid must be an A#-prefixed 26-character ULID"),
  parentDomain: z
    .string()
    .regex(parentDomainRegex, "parentDomain must be a bare hostname (no scheme, port, or path)"),
});

export type CreateSessionBody = z.infer<typeof createSessionSchema>;
export type SendMessageBody = z.infer<typeof sendMessageSchema>;
export type OnboardingBody = z.infer<typeof onboardingSchema>;
export type EmbedAuthorizeBody = z.infer<typeof embedAuthorizeSchema>;
