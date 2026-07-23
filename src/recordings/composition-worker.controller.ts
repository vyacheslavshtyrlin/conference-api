import { Body, Controller, Headers, Inject, Param, Post, Query, UseGuards } from "@nestjs/common";
import { CompositionWorkerAuthGuard } from "./recording-worker-auth.guard.js";
import { CompositionWorkerService } from "./composition-worker.service.js";
import { ArtifactDto, CompositionFailureDto } from "./recording-worker.dto.js";

@UseGuards(CompositionWorkerAuthGuard)
@Controller("internal/v1/composition-jobs")
export class CompositionWorkerController {
  constructor(@Inject(CompositionWorkerService) private readonly jobs: CompositionWorkerService) {}
  @Post("claim") claim() { return this.jobs.claim(); }
  @Post(":jobId/heartbeat") heartbeat(@Param("jobId") jobId: string, @Headers("x-composition-lease") lease: string) { return this.jobs.heartbeat(jobId, lease); }
  @Post(":jobId/segments") segments(@Param("jobId") jobId: string, @Headers("x-composition-lease") lease: string, @Query("cursor") cursor?: string) { return this.jobs.segments(jobId, lease, cursor); }
  @Post(":jobId/output-upload") output(@Param("jobId") jobId: string, @Headers("x-composition-lease") lease: string, @Body() body: ArtifactDto) { return this.jobs.allocateOutput(jobId, lease, body); }
  @Post(":jobId/complete") complete(@Param("jobId") jobId: string, @Headers("x-composition-lease") lease: string, @Body() body: ArtifactDto) { return this.jobs.complete(jobId, lease, body); }
  @Post(":jobId/fail") fail(@Param("jobId") jobId: string, @Headers("x-composition-lease") lease: string, @Body() body: CompositionFailureDto) { return this.jobs.fail(jobId, lease, body); }
}
