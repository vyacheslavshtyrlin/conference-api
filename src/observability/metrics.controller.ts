import { Controller, Get, Header } from "@nestjs/common";
import { getApiMetrics } from "./api-metrics.service.js";

@Controller("metrics")
export class MetricsController {
  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  metricsText(): string {
    return getApiMetrics().renderPrometheus();
  }
}
