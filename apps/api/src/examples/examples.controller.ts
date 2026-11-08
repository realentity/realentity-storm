import { type ChecklistView, type SetupView } from "@realentity/storm-shared";
import { Controller, Get, Param, ParseUUIDPipe } from "@nestjs/common";
import { CurrentUser, type AuthenticatedUser } from "../auth/public.decorator";
import { ExamplesService } from "./examples.service";

/** M40: what the examples need (the gallery's cards), and an installed one's checklist (its App's page). */
@Controller("examples")
export class ExamplesController {
  constructor(private readonly examples: ExamplesService) {}

  @Get("setup")
  setup(@CurrentUser() user: AuthenticatedUser): Promise<SetupView> {
    return this.examples.setup(user.userId);
  }

  @Get("apps/:appId/checklist")
  checklist(@CurrentUser() user: AuthenticatedUser, @Param("appId", ParseUUIDPipe) appId: string): Promise<ChecklistView | null> {
    return this.examples.checklist(user.userId, appId);
  }
}
