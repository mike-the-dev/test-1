import { z } from "zod";

export const saveUserFactInputSchema = z.object({
  key: z.string().min(1),
  value: z.string().min(1),
});

export type SaveUserFactInput = z.infer<typeof saveUserFactInputSchema>;
