import { BillPaidSchema, type BillPaidRequest, type BillsView, type BillView } from "@realentity/storm-shared";
import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from "@nestjs/common";
import { CurrentUser, type AuthenticatedUser } from "../auth/public.decorator";
import { ZodBodyPipe } from "../common/zod-body.pipe";
import { BillsService } from "./bills.service";

/** The Bills page (M23). */
@Controller("bills")
export class BillsController {
  constructor(private readonly bills: BillsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<BillsView> {
    return this.bills.list(user.userId);
  }

  @Put(":billId/paid")
  paid(
    @CurrentUser() user: AuthenticatedUser,
    @Param("billId", ParseUUIDPipe) billId: string,
    @Body(new ZodBodyPipe(BillPaidSchema)) body: BillPaidRequest,
  ): Promise<BillView> {
    return this.bills.setPaid(user.userId, billId, body.paid);
  }
}
