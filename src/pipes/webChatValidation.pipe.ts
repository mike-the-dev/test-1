import { BadRequestException, PipeTransform } from "@nestjs/common";
import { ZodSchema } from "zod";

export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown): unknown {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      const firstIssue = result.error?.issues?.[0];
      const reason = firstIssue?.message ?? "Invalid request payload";
      throw new BadRequestException(reason);
    }

    return result.data;
  }
}
