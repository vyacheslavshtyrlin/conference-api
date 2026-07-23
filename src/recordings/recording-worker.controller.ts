import { Body, Controller, Inject, Param, Post, UseGuards, ValidationPipe } from "@nestjs/common";
import { RecordingWorkerAuthGuard } from "./recording-worker-auth.guard.js";
import { CaptureFailureDto, SegmentCommitDto, SegmentUploadBatchDto } from "./recording-worker.dto.js";
import { RecordingWorkerService } from "./recording-worker.service.js";

const pipe = new ValidationPipe({ forbidNonWhitelisted: true, transform: true, whitelist: true });

@UseGuards(RecordingWorkerAuthGuard)
@Controller("internal/v1/recordings")
export class RecordingWorkerController {
  constructor(@Inject(RecordingWorkerService) private readonly recordings: RecordingWorkerService) {}

  @Post(":recordingId/segments/upload-batch")
  uploadBatch(@Param("recordingId") recordingId: string, @Body(pipe) body: SegmentUploadBatchDto) {
    return this.recordings.allocateSegments(recordingId, body.segments);
  }

  @Post(":recordingId/segments/commit")
  commit(@Param("recordingId") recordingId: string, @Body(pipe) body: SegmentCommitDto) {
    return this.recordings.commitSegment(recordingId, body);
  }

  @Post(":recordingId/fail")
  fail(@Param("recordingId") recordingId: string, @Body(pipe) body: CaptureFailureDto) {
    return this.recordings.failCapture(recordingId, body);
  }

  @Post(":recordingId/seal")
  seal(@Param("recordingId") recordingId: string) {
    return this.recordings.seal(recordingId);
  }
}
