import { BadRequestException, type PipeTransform } from "@nestjs/common";
import { type z } from "zod";

/** Validates a request body with a shared zod schema. Error details name fields, never echo values. */
export class ZodBodyPipe<T extends z.ZodType> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    throw new BadRequestException({
      message: "Validation failed",
      errors: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
}
