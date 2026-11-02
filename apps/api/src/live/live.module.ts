import { Module } from "@nestjs/common";
import { StepsModule } from "../steps/steps.module";
import { LiveController } from "./live.controller";
import { LiveService } from "./live.service";

@Module({
  imports: [StepsModule],
  controllers: [LiveController],
  providers: [LiveService],
})
export class LiveModule {}
