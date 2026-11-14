import { Module } from "@nestjs/common";
import { BindingsController } from "./bindings.controller";
import { BindingsService } from "./bindings.service";

/** M50: slots filled by credentials (by id) and settings. */
@Module({
  controllers: [BindingsController],
  providers: [BindingsService],
  exports: [BindingsService],
})
export class BindingsModule {}
