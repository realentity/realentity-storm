import { type StepTypeView } from "@ai-me/shared";
import { StepCatalog } from "@ai-me/steps";
import { Controller, Get } from "@nestjs/common";

/** The step catalog, for the review screen (descriptions, side effects). */
@Controller("steps")
export class StepsController {
  constructor(private readonly catalog: StepCatalog) {}

  @Get()
  list(): StepTypeView[] {
    return this.catalog.list().map((step) => ({
      type: step.type,
      description: step.description,
      sideEffect: step.sideEffect,
      headed: step.headed === true,
    }));
  }
}
