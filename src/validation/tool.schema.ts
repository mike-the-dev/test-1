import { z } from "zod";

export const saveUserFactInputSchema = z.object({
  key: z.string().min(1),
  value: z.string().min(1),
});

export type SaveUserFactInput = z.infer<typeof saveUserFactInputSchema>;

export const collectContactInfoInputSchema = z
  .object({
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
    email: z.string().email().optional(),
    phone: z.string().min(1).optional(),
    company: z.string().min(1).optional(),
  })
  .refine(
    (data) => Object.values(data).some((v) => v !== undefined),
    { message: "At least one contact field must be provided" },
  );

export type CollectContactInfoInput = z.infer<typeof collectContactInfoInputSchema>;

export const sendEmailInputSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1),
  body: z.string().min(1),
});

export type SendEmailInput = z.infer<typeof sendEmailInputSchema>;

export const listServicesInputSchema = z.object({}).strict();
export type ListServicesInput = z.infer<typeof listServicesInputSchema>;
