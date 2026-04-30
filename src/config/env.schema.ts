import { z } from "zod";

export const envSchema = z
  .object({
    APP_ENV: z.enum(["local", "staging", "prod"]).default("local"),
    PORT: z.coerce.number().default(3000),
    DYNAMODB_REGION: z.string().min(1),
    DYNAMODB_ENDPOINT: z.string().optional(),
    DYNAMODB_TABLE_CONVERSATIONS: z.string().min(1),
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_MODEL: z.string().optional(),
    VOYAGE_API_KEY: z.string().optional(),
    VOYAGE_MODEL: z.string().optional(),
    SENDGRID_API_KEY: z.string().optional(),
    SENDGRID_FROM_EMAIL: z.string().optional(),
    SENDGRID_FROM_NAME: z.string().optional(),
    SENDGRID_REPLY_DOMAIN: z
      .string()
      .optional()
      .transform((value) => (value ? value.replace(/^@/, "") : value))
      .refine((value) => value === undefined || value === "" || /^[^\s@]+\.[^\s@]+$/.test(value), {
        message: "SENDGRID_REPLY_DOMAIN must be a valid domain (e.g. reply.example.com), not an email address",
      }),
    DYNAMODB_ACCOUNTS_DOMAIN_GSI_NAME: z.string().default("GSI1"),
    // z.preprocess runs before type-checking so the "true"/"false" string coercion
    // is unambiguous regardless of .default() placement. When the env var is absent,
    // preprocess receives undefined; undefined === "true" is false; z.boolean() accepts
    // false; .default(false) is a no-op.
    WEB_CHAT_CORS_ALLOW_ALL: z.preprocess((val) => val === "true", z.boolean()).default(false),
    CHECKOUT_BASE_URL_OVERRIDE: z.string().url().optional(),
    // Comma-separated list of origins (scheme://host[:port]) that bypass the
    // GSI-based account allowlist at CORS-check time. This is for the widget's
    // own deployment domain (e.g. "https://chat.instapaytient.com") since the
    // widget iframe's origin is NOT an allowlisted customer practice domain —
    // the practice's domain flows through the request body as `hostDomain`.
    WEB_CHAT_WIDGET_ORIGINS: z.string().optional(),
    QDRANT_URL: z.string().url(),
    QDRANT_API_KEY: z.string().optional(),
    REDIS_HOST: z.string().default("localhost"),
    REDIS_PORT: z.coerce.number().default(6379),
    SENTRY_DSN: z.string().url().optional(),
    SENTRY_ENVIRONMENT: z.string().optional(),
    SENTRY_RELEASE: z.string().optional(),
    SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).optional(),
    SLACK_WEBHOOK_URL: z.string().url().optional(),
    KB_INTERNAL_API_KEY: z.string().min(32),
  })
  .superRefine((data, ctx) => {
    if (data.WEB_CHAT_CORS_ALLOW_ALL === true && data.APP_ENV === "prod") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "WEB_CHAT_CORS_ALLOW_ALL must not be true in prod — this is a production safety guardrail",
        path: ["WEB_CHAT_CORS_ALLOW_ALL"],
      });
    }
  });

export type Env = z.infer<typeof envSchema>;
