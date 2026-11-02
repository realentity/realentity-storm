import { Module } from "@nestjs/common";
import { PipelinesModule } from "../pipelines/pipelines.module";
import { PricesController } from "./prices.controller";
import { PricesService } from "./prices.service";

@Module({
  imports: [PipelinesModule],
  controllers: [PricesController],
  providers: [PricesService],
})
export class PricesModule {}
