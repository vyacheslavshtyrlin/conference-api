import { describe, expect, it, vi } from "vitest";
import { RecordingCleanupService } from "./recording-cleanup.service.js";

describe("RecordingCleanupService", () => {
  it("expires the recording and removes its final artifact and committed S3 segments", async () => {
    const recording = {
      id: "rec_1",
      artifacts: [{ objectKey: "final/rec_1/artifact.mp4" }],
      segments: [
        { objectKey: "raw/rec_1/generations/1/segments/1.webm" },
        { objectKey: "raw/rec_1/generations/1/segments/2.webm" },
      ],
      callbackDeliveries: [],
    };
    const prisma = {
      recording: { findMany: vi.fn().mockResolvedValue([recording]), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      callbackDelivery: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      $transaction: vi.fn(async (work: (tx: unknown) => Promise<void>) => work(prisma)),
    };
    const storage = { delete: vi.fn().mockResolvedValue(undefined) };
    const config = { get: vi.fn().mockReturnValue(true) };
    const service = new RecordingCleanupService(prisma as never, storage as never, config as never);

    await service.run();

    expect(prisma.recording.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ include: expect.objectContaining({ artifacts: true, segments: true }) }),
    );
    expect(prisma.recording.updateMany).toHaveBeenCalledOnce();
    expect(storage.delete).toHaveBeenCalledTimes(3);
    expect(storage.delete).toHaveBeenCalledWith("final/rec_1/artifact.mp4");
    expect(storage.delete).toHaveBeenCalledWith("raw/rec_1/generations/1/segments/1.webm");
    expect(storage.delete).toHaveBeenCalledWith("raw/rec_1/generations/1/segments/2.webm");
  });

  it("continues cleanup when an idempotent object delete reports an error", async () => {
    const prisma = {
      recording: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "rec_1",
            artifacts: [{ objectKey: "final/rec_1/artifact.mp4" }],
            segments: [{ objectKey: "raw/rec_1/generations/1/segments/1.webm" }],
            callbackDeliveries: [],
          },
        ]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      callbackDelivery: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      $transaction: vi.fn(async (work: (tx: unknown) => Promise<void>) => work(prisma)),
    };
    const storage = { delete: vi.fn().mockRejectedValue(new Error("object already removed")) };
    const service = new RecordingCleanupService(prisma as never, storage as never, { get: vi.fn().mockReturnValue(true) } as never);

    await expect(service.run()).resolves.toBeUndefined();
    expect(storage.delete).toHaveBeenCalledTimes(2);
  });
});
