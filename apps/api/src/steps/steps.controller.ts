import { type JsonSchema, type StepTypeView, type TriggerDataView } from "@realentity/storm-shared";
import { StepCatalog, TRIGGER_DATA, WEBHOOK_DATA } from "@realentity/storm-steps";
import { Controller, Get } from "@nestjs/common";
import { z } from "zod";

/**
 * The step catalog, for the review screen (descriptions, side effects) and the step builder (M36-T1): each step's
 * input and output as JSON Schema, from the same schemas the compiler checks.
 */
@Controller("steps")
export class StepsController {
  private readonly views: StepTypeView[];
  private readonly triggerData: TriggerDataView = {
    events: Object.fromEntries(Object.entries(TRIGGER_DATA).map(([event, schema]) => [event, schemaOf(schema, "output")])),
    webhook: schemaOf(WEBHOOK_DATA, "output"),
  };

  constructor(catalog: StepCatalog) {
    // The catalog changes only with a deploy: made once.
    this.views = catalog.list().map((step) => ({
      type: step.type,
      description: step.description,
      sideEffect: step.sideEffect,
      headed: step.headed === true,
      category: step.type.split(".")[0],
      input: schemaOf(step.input, "input"),
      output: schemaOf(step.output, "output"),
      llmOutput: step.llmOutput === true,
      targets: { ...(step.targets ?? {}) },
      pageFields: [...(step.pageFields ?? [])],
      primary: [...(step.primary ?? [])],
      entities: (step.entities ?? []).map((e) => ({ type: e.type, mine: e.mine ?? false })),
      credentials: Array.isArray(step.acceptsCredentials)
        ? [...(step.acceptsCredentials as readonly string[])]
        : step.acceptsCredentials === true,
    }));
  }

  @Get()
  list(): StepTypeView[] {
    return this.views;
  }

  /** M36-T4: what {{trigger}} holds for each event and for a webhook. */
  @Get("triggers")
  triggers(): TriggerDataView {
    return this.triggerData;
  }
}

/** As it is written (`input`: defaults optional) or as the step gives it (`output`); what JSON Schema can't say is "any". */
function schemaOf(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  const { $schema: _, ...json } = z.toJSONSchema(schema, { io, unrepresentable: "any" }) as JsonSchema;
  return json;
}
