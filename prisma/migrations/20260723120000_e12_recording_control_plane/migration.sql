CREATE TYPE "RecordingState" AS ENUM ('REQUESTED', 'CAPTURING', 'CAPTURED', 'COMPOSING', 'READY', 'FAILED', 'CANCELLED', 'EXPIRED');
CREATE TYPE "CompositionJobState" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');
CREATE TYPE "CallbackDeliveryState" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

CREATE TABLE "Recording" (
  "id" VARCHAR(128) PRIMARY KEY,
  "integrationId" VARCHAR(128) NOT NULL,
  "externalRoomHash" VARCHAR(128) NOT NULL,
  "requestFingerprint" VARCHAR(128) NOT NULL,
  "roomId" VARCHAR(128),
  "state" "RecordingState" NOT NULL DEFAULT 'REQUESTED',
  "requestedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "capturedAt" TIMESTAMPTZ,
  "readyAt" TIMESTAMPTZ,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "failureCode" VARCHAR(64),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX "Recording_integrationId_externalRoomHash_key" ON "Recording"("integrationId", "externalRoomHash");
CREATE UNIQUE INDEX "Recording_roomId_key" ON "Recording"("roomId");
CREATE INDEX "Recording_integrationId_id_idx" ON "Recording"("integrationId", "id");
CREATE INDEX "Recording_expiresAt_idx" ON "Recording"("expiresAt");

CREATE TABLE "RecordingSegment" (
  "id" TEXT PRIMARY KEY,
  "recordingId" VARCHAR(128) NOT NULL REFERENCES "Recording"("id") ON DELETE CASCADE,
  "generation" INTEGER NOT NULL,
  "sequence" INTEGER NOT NULL,
  "timelineStartMs" BIGINT NOT NULL,
  "timelineEndMs" BIGINT NOT NULL,
  "bytes" BIGINT NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "objectKey" VARCHAR(1024) NOT NULL,
  "contentType" VARCHAR(128) NOT NULL,
  "committedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "RecordingSegment_recordingId_generation_sequence_key" ON "RecordingSegment"("recordingId", "generation", "sequence");
CREATE INDEX "RecordingSegment_recordingId_generation_sequence_idx" ON "RecordingSegment"("recordingId", "generation", "sequence");

CREATE TABLE "CompositionJob" (
  "id" TEXT PRIMARY KEY,
  "recordingId" VARCHAR(128) NOT NULL REFERENCES "Recording"("id") ON DELETE CASCADE,
  "version" INTEGER NOT NULL,
  "state" "CompositionJobState" NOT NULL DEFAULT 'QUEUED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "leaseTokenHash" CHAR(64),
  "leaseExpiresAt" TIMESTAMPTZ,
  "lastError" VARCHAR(2048),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX "CompositionJob_recordingId_version_key" ON "CompositionJob"("recordingId", "version");
CREATE INDEX "CompositionJob_state_leaseExpiresAt_createdAt_idx" ON "CompositionJob"("state", "leaseExpiresAt", "createdAt");

CREATE TABLE "RecordingArtifact" (
  "id" TEXT PRIMARY KEY,
  "recordingId" VARCHAR(128) NOT NULL REFERENCES "Recording"("id") ON DELETE CASCADE,
  "compositionJobId" TEXT NOT NULL UNIQUE REFERENCES "CompositionJob"("id") ON DELETE RESTRICT,
  "objectKey" VARCHAR(1024) NOT NULL,
  "bytes" BIGINT NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "contentType" VARCHAR(128) NOT NULL,
  "durationSeconds" DECIMAL(12,3) NOT NULL,
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "frameRate" DECIMAL(8,3) NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "RecordingArtifact_recordingId_compositionJobId_key" ON "RecordingArtifact"("recordingId", "compositionJobId");

CREATE TABLE "CallbackDelivery" (
  "id" TEXT PRIMARY KEY,
  "recordingId" VARCHAR(128) NOT NULL REFERENCES "Recording"("id") ON DELETE CASCADE,
  "artifactId" TEXT NOT NULL REFERENCES "RecordingArtifact"("id") ON DELETE CASCADE,
  "eventType" VARCHAR(64) NOT NULL,
  "eventId" VARCHAR(128) NOT NULL UNIQUE,
  "state" "CallbackDeliveryState" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" VARCHAR(2048),
  "deliveredAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX "CallbackDelivery_recordingId_artifactId_eventType_key" ON "CallbackDelivery"("recordingId", "artifactId", "eventType");
CREATE INDEX "CallbackDelivery_state_nextAttemptAt_idx" ON "CallbackDelivery"("state", "nextAttemptAt");
