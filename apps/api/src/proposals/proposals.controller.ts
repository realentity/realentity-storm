import {
  ApproveProposalSchema,
  PROPOSAL_STATUSES,
  RejectProposalSchema,
  type ApproveProposalRequest,
  type ProposalStatusName,
  type ProposalView,
  type RejectProposalRequest,
} from "@ai-me/shared";
import { Body, Controller, Get, HttpCode, Param, ParseEnumPipe, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { CurrentUser, type AuthenticatedUser } from "../auth/public.decorator";
import { ZodBodyPipe } from "../common/zod-body.pipe";
import { ProposalsService } from "./proposals.service";

const STATUS = Object.fromEntries(PROPOSAL_STATUSES.map((s) => [s, s]));

@Controller("proposals")
export class ProposalsController {
  constructor(private readonly proposals: ProposalsService) {}

  /** The inbox: proposals waiting for me by default. */
  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query("status", new ParseEnumPipe(STATUS, { optional: true })) status?: ProposalStatusName,
  ): Promise<ProposalView[]> {
    return this.proposals.list(user.userId, status ?? "PENDING_REVIEW");
  }

  @Get(":proposalId")
  get(@CurrentUser() user: AuthenticatedUser, @Param("proposalId", ParseUUIDPipe) proposalId: string): Promise<ProposalView> {
    return this.proposals.get(user.userId, proposalId);
  }

  @Post(":proposalId/approve")
  @HttpCode(200)
  approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param("proposalId", ParseUUIDPipe) proposalId: string,
    @Body(new ZodBodyPipe(ApproveProposalSchema)) body: ApproveProposalRequest,
  ): Promise<ProposalView> {
    return this.proposals.approve(user.userId, proposalId, body);
  }

  @Post(":proposalId/reject")
  @HttpCode(200)
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param("proposalId", ParseUUIDPipe) proposalId: string,
    @Body(new ZodBodyPipe(RejectProposalSchema)) body: RejectProposalRequest,
  ): Promise<ProposalView> {
    return this.proposals.reject(user.userId, proposalId, body.reason);
  }

  @Post(":proposalId/undo-reject")
  @HttpCode(200)
  undoReject(@CurrentUser() user: AuthenticatedUser, @Param("proposalId", ParseUUIDPipe) proposalId: string): Promise<ProposalView> {
    return this.proposals.undoReject(user.userId, proposalId);
  }
}
