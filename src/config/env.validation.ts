import { envSchema } from "./env.schema";

export const validate = (config: Record<string, unknown>) => {
  const result = envSchema.safeParse(config);

  if (!result.success) {
    console.error("Invalid environment variables", result.error.format());
    throw new Error("Config validation failed");
  }

  return result.data;
};
