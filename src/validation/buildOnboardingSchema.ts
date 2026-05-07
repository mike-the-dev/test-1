import { z } from "zod";

import { SplashConfigOnboardingField } from "../types/SplashConfig";

const MAX_BUDGET_CENTS = 100_000_000;

export function buildOnboardingSchema(fields: SplashConfigOnboardingField[]): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const field of fields) {
    if (field.kind === "budget") {
      const base = z.number().int().positive().max(MAX_BUDGET_CENTS);
      shape[field.key] = field.required ? base : base.optional();
      continue;
    }

    if (field.kind === "industry") {
      if (field.options.length === 0) {
        throw new Error("OnboardingField 'industry' must have at least one option");
      }
      const enumSchema = z.enum(field.options as [string, ...string[]]);
      shape[field.key] = field.required ? enumSchema : enumSchema.optional();
      continue;
    }

    if (field.kind === "shortText") {
      const base = field.required
        ? z.string().min(1).max(field.maxLength)
        : z.string().max(field.maxLength).optional();
      shape[field.key] = base;
    }
  }

  return z.object(shape);
}
