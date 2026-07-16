import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller.js";
import { ReadyController } from "./ready.controller.js";
import { MetricsController } from "../observability/metrics.controller.js";

@Module({
  controllers: [HealthController, ReadyController, MetricsController],
})
export class HealthModule {}
