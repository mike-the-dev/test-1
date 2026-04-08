import { z } from "zod";

export const envSchema = z.object({
  APP_ENV: z.enum(["local", "staging", "prod"]).default("local"),
  PORT: z.coerce.number().default(3000),
  DYNAMODB_REGION: z.string().min(1),
  DYNAMODB_ENDPOINT: z.string().optional(),
  DYNAMODB_TABLE_CONVERSATIONS: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().optional(),
  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_GUILD_ID: z.string().optional(),
  SENDGRID_API_KEY: z.string().optional(),
  SENDGRID_FROM_EMAIL: z.string().optional(),
  SENDGRID_FROM_NAME: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;
