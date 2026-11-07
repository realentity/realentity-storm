import {
  type AppMapView,
  AddFieldRequestSchema,
  AppCheckRequestSchema,
  AppImportRequestSchema,
  DraftTypeRequestSchema,
  DraftTypeSampleRequestSchema,
  EntityQuerySchema,
  SaveAppRequestSchema,
  type AddFieldRequest,
  type AppCheckRequest,
  type AppCheckView,
  type AppDetailView,
  type AppDriftView,
  type AppImportRequest,
  type AppImportResult,
  type AppSummaryView,
  type DraftTypeRequest,
  type DraftTypeSampleRequest,
  type DraftTypeView,
  type EntityListView,
  type EntityQuery,
  type SaveAppRequest,
} from "@ai-me/shared";
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from "@nestjs/common";
import { CurrentUser, type AuthenticatedUser } from "../auth/public.decorator";
import { ZodBodyPipe } from "../common/zod-body.pipe";
import { AppImportsService } from "./app-imports.service";
import { AppsService } from "./apps.service";

/** Apps (M30): their definitions and versions, the entities of their types, a type drafted from a run. */
@Controller("apps")
export class AppsController {
  constructor(
    private readonly apps: AppsService,
    private readonly imports: AppImportsService,
  ) {}

  /** M33: what a hand-built page kept, moved into this App. */
  @Post(":appId/import")
  move(
    @CurrentUser() user: AuthenticatedUser,
    @Param("appId", ParseUUIDPipe) appId: string,
    @Body(new ZodBodyPipe(AppImportRequestSchema)) body: AppImportRequest,
  ): Promise<AppImportResult> {
    return this.imports.move(user.userId, appId, body);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<AppSummaryView[]> {
    return this.apps.list(user.userId);
  }

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodBodyPipe(SaveAppRequestSchema)) body: SaveAppRequest,
  ): Promise<AppDetailView> {
    return this.apps.create(user.userId, body.source);
  }

  /** M35-T1: a draft App checked as I edit it; nothing is saved. */
  @Post("check")
  check(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodBodyPipe(AppCheckRequestSchema)) body: AppCheckRequest,
  ): Promise<AppCheckView> {
    return this.apps.check(user.userId, body);
  }

  @Post("draft-type")
  draftType(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodBodyPipe(DraftTypeRequestSchema)) body: DraftTypeRequest,
  ): Promise<DraftTypeView> {
    return this.apps.draftType(user.userId, body);
  }

  /** M35-T4: a type drafted from a sample I paste. */
  @Post("draft-type/sample")
  draftTypeFromSample(@Body(new ZodBodyPipe(DraftTypeSampleRequestSchema)) body: DraftTypeSampleRequest): DraftTypeView {
    return this.apps.draftTypeFromSample(body.sample);
  }

  /** M37-T4: how the App and its pipelines connect. */
  @Get(":appId/map")
  map(@CurrentUser() user: AuthenticatedUser, @Param("appId", ParseUUIDPipe) appId: string): Promise<AppMapView> {
    return this.apps.map(user.userId, appId);
  }

  @Get(":appId")
  get(@CurrentUser() user: AuthenticatedUser, @Param("appId", ParseUUIDPipe) appId: string): Promise<AppDetailView> {
    return this.apps.get(user.userId, appId);
  }

  @Put(":appId")
  save(
    @CurrentUser() user: AuthenticatedUser,
    @Param("appId", ParseUUIDPipe) appId: string,
    @Body(new ZodBodyPipe(SaveAppRequestSchema)) body: SaveAppRequest,
  ): Promise<AppDetailView> {
    return this.apps.save(user.userId, appId, body.source);
  }

  /** M34-T4: fields the entities have that their types don't name. */
  @Get(":appId/drift")
  drift(@CurrentUser() user: AuthenticatedUser, @Param("appId", ParseUUIDPipe) appId: string): Promise<AppDriftView[]> {
    return this.apps.drift(user.userId, appId);
  }

  @Post(":appId/drift")
  addField(
    @CurrentUser() user: AuthenticatedUser,
    @Param("appId", ParseUUIDPipe) appId: string,
    @Body(new ZodBodyPipe(AddFieldRequestSchema)) body: AddFieldRequest,
  ): Promise<AppDetailView> {
    return this.apps.addField(user.userId, appId, body);
  }

  @Get(":appId/types/:type/entities")
  entities(
    @CurrentUser() user: AuthenticatedUser,
    @Param("appId", ParseUUIDPipe) appId: string,
    @Param("type") type: string,
    @Query(new ZodBodyPipe(EntityQuerySchema)) query: EntityQuery,
  ): Promise<EntityListView> {
    return this.apps.entities(user.userId, appId, type, query);
  }
}
