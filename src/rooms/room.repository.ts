import { Inject, Injectable } from "@nestjs/common";
import { EMPTY_ROOM_TTL_SECONDS, type RoomMetadata } from "#contracts";
import { REDIS_CLIENT } from "../redis/redis.constants.js";
import type { RedisClient } from "../redis/redis.types.js";
import { getApiMetrics } from "../observability/api-metrics.service.js";
import { invalidToken, roomClosed, roomExpired, roomNotFound } from "./room-errors.js";

export type CreateRoomRecord = {
  roomId: string;
  slug: string;
  accessPolicy?: "link" | "approval" | "admission";
  mediaNodeId: string;
  signalingUrl: string;
  createdAt: string;
  expiresAt: string | null;
  recordingRequested?: boolean;
};

export type CreateIntegrationRoomRecord = {
  integrationId: string;
  externalRoomId: string;
  requestHash: string;
  recordingId?: string;
};

export type CreateRoomOptions = {
  integration?: CreateIntegrationRoomRecord;
};

export type RoomSessionRecord = {
  participantId: string;
  displayName: string | null;
  isCreator: boolean;
  tokenHash: string;
  createdAt: string;
  identity?: RoomSessionIdentityRecord;
};

export type RoomSessionIdentityRecord = {
  kind: "guest" | "authenticated";
  source: "anonymous" | "trusted_cookie" | "integration_admission" | "room_admission";
  integrationId?: string;
  externalSubject?: string;
  avatarUrl?: string;
};

export type IntegrationRoomOwnerRecord = {
  roomId: string;
  integrationId: string;
  externalRoomHash?: string;
  requestHash: string;
  createdAt: string;
  recordingId?: string;
};

export type AdmissionRecord = {
  roomId: string;
  integrationId?: string;
  codeHash: string;
  identity: {
    kind: "guest" | "authenticated";
    source: "integration_admission" | "room_admission";
    externalSubject?: string;
    displayName?: string | null;
    avatarUrl?: string;
  };
  roomControls: "creator" | "none";
  createdAt: string;
  expiresAt: string;
};

export type ConsumeAdmissionCommand = {
  codeHash: string;
  expectedRoomId?: string;
  session: RoomSessionRecord;
  sessionExpiresAt: string | null;
};

export type JoinRequestStatus = "pending" | "approved" | "denied";

export type JoinRequestRecord = {
  requestId: string;
  roomId: string;
  displayName: string;
  tokenHash: string;
  status: JoinRequestStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  decidedByParticipantId?: string;
  approvedParticipantId?: string;
  approvedTokenHash?: string;
  identity?: RoomSessionIdentityRecord;
};

export type RecordingControlState = "requested" | "capturing" | "finalizing";
export type RecordingActivationRecord = {
  activatedAt: string;
};

export abstract class RoomRepository {
  abstract createRoom(record: CreateRoomRecord, options?: CreateRoomOptions): Promise<RoomMetadata>;
  abstract getRoomById(roomId: string): Promise<RoomMetadata>;
  abstract getRoomBySlug(slug: string): Promise<RoomMetadata>;
  abstract getIntegrationRoomOwner(roomId: string): Promise<IntegrationRoomOwnerRecord | undefined>;
  abstract getIntegrationRoomOwnerByRecordingId(recordingId: string): Promise<IntegrationRoomOwnerRecord | undefined>;
  abstract getRecordingControlState(recordingId: string): Promise<RecordingControlState>;
  abstract activateRecording(
    recordingId: string,
    roomExpiresAt?: string | null
  ): Promise<"capturing" | "finalizing">;
  async getRecordingActivation(_recordingId: string): Promise<RecordingActivationRecord | undefined> {
    return undefined;
  }
  abstract closeRecordingInputs(recordingId: string): Promise<"finalizing" | "inactive">;
  abstract createAdmission(record: AdmissionRecord): Promise<void>;
  abstract consumeAdmission(command: ConsumeAdmissionCommand): Promise<{ room: RoomMetadata; session: RoomSessionRecord }>;
  abstract createJoinRequest(record: JoinRequestRecord, roomExpiresAt: string | null): Promise<void>;
  abstract getJoinRequest(roomId: string, requestId: string): Promise<JoinRequestRecord | undefined>;
  abstract listPendingJoinRequests(roomId: string): Promise<JoinRequestRecord[]>;
  abstract decideJoinRequest(
    roomId: string,
    requestId: string,
    status: "approved" | "denied",
    decidedByParticipantId: string
  ): Promise<JoinRequestRecord>;
  abstract fulfillApprovedJoinRequest(
    roomId: string,
    requestId: string,
    participantId: string,
    tokenHash: string,
    session: RoomSessionRecord,
    sessionExpiresAt: string | null
  ): Promise<JoinRequestRecord>;
  abstract getParticipantCount(roomId: string): Promise<number>;
  abstract hasLiveParticipant(roomId: string, participantId: string): Promise<boolean>;
  abstract saveRoomSession(roomId: string, session: RoomSessionRecord, roomExpiresAt: string | null): Promise<void>;
  abstract getRoomSession(roomId: string, participantId: string): Promise<RoomSessionRecord | undefined>;
  abstract findRoomSessionByTokenHash(roomId: string, tokenHash: string): Promise<RoomSessionRecord | undefined>;
}

@Injectable()
export class RedisRoomRepository extends RoomRepository {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: RedisClient) {
    super();
  }

  async createRoom(record: CreateRoomRecord, options: CreateRoomOptions = {}): Promise<RoomMetadata> {
    const room = parseRoomMetadata({
      ...record,
      status: "active",
      closedReason: null,
    });
    if (!room) {
      throw roomNotFound();
    }

    const ttlMs = getTtlMilliseconds(room.expiresAt);
    const integration = parseIntegrationRoomRecord(options.integration);
    const mapping = integration
      ? {
          roomId: room.roomId,
          integrationId: integration.integrationId,
           externalRoomHash: integration.externalRoomId,
           requestHash: integration.requestHash,
           createdAt: room.createdAt,
           recordingId: integration.recordingId,
        }
      : null;

    const rawResult = await this.recordRedis("create_room_atomic", () =>
      this.redis.eval(CREATE_ROOM_SCRIPT, {
        keys: [
          this.roomKey(room.roomId),
          this.slugKey(room.slug),
           integration ? this.integrationExternalRoomKey(integration.integrationId, integration.externalRoomId) : "",
           integration ? this.integrationRoomOwnerKey(room.roomId) : "",
           integration?.recordingId ? this.integrationRecordingKey(integration.recordingId) : "",
        ],
        arguments: [
          JSON.stringify(room),
          room.roomId,
          String(ttlMs ?? 0),
          integration ? "1" : "0",
           integration?.requestHash ?? "",
           mapping ? JSON.stringify(mapping) : "",
           integration?.recordingId ?? "",
        ],
      })
    );

    const result = parseCreateRoomScriptResult(rawResult);
    if (!result) {
      throw roomNotFound();
    }

    if (result.status === "created" || result.status === "existing") {
      const parsedRoom = parseRoomMetadata(JSON.parse(result.room) as unknown);
      if (!parsedRoom) {
        throw roomNotFound();
      }
      return parsedRoom;
    }

    if (result.status === "external_conflict") {
      throw new IntegrationRoomConflictError(result.status);
    }

    throw roomNotFound();
  }

  async getRoomById(roomId: string): Promise<RoomMetadata> {
    const raw = await this.recordRedis("get_room_metadata", () => this.redis.get(this.roomKey(roomId)));
    if (!raw) {
      throw roomNotFound();
    }

    let roomJson: unknown;
    try {
      roomJson = JSON.parse(raw) as unknown;
    } catch {
      throw roomNotFound();
    }

    const room = parseRoomMetadata(roomJson);
    if (!room) {
      throw roomNotFound();
    }

    if (room.expiresAt && new Date(room.expiresAt).getTime() <= Date.now()) {
      throw roomExpired();
    }

    return room;
  }

  async getRoomBySlug(slug: string): Promise<RoomMetadata> {
    const roomId = await this.recordRedis("get_room_slug", () => this.redis.get(this.slugKey(slug)));
    if (!roomId) {
      throw roomNotFound();
    }

    const raw = await this.recordRedis("get_room_metadata", () => this.redis.get(this.roomKey(roomId)));
    if (!raw) {
      throw roomNotFound();
    }

    let roomJson: unknown;
    try {
      roomJson = JSON.parse(raw) as unknown;
    } catch {
      throw roomNotFound();
    }

    const room = parseRoomMetadata(roomJson);
    if (!room) {
      throw roomNotFound();
    }

    if (room.expiresAt && new Date(room.expiresAt).getTime() <= Date.now()) {
      throw roomExpired();
    }

    return room;
  }

  async getIntegrationRoomOwner(roomId: string): Promise<IntegrationRoomOwnerRecord | undefined> {
    const raw = await this.recordRedis("get_integration_room_owner", () =>
      this.redis.get(this.integrationRoomOwnerKey(roomId))
    );
    return parseIntegrationRoomOwner(raw);
  }

  async getIntegrationRoomOwnerByRecordingId(recordingId: string): Promise<IntegrationRoomOwnerRecord | undefined> {
    const raw = await this.recordRedis("get_integration_recording_owner", () =>
      this.redis.get(this.integrationRecordingKey(recordingId))
    );
    return parseIntegrationRoomOwner(raw);
  }

  async getRecordingControlState(recordingId: string): Promise<RecordingControlState> {
    const result = await this.recordRedis("get_recording_control_state", () =>
      this.redis.eval(GET_RECORDING_CONTROL_STATE_SCRIPT, {
        keys: [this.recordingActivationKey(recordingId), this.recordingFinalizingKey(recordingId)],
        arguments: [],
      })
    );
    return parseRecordingControlState(result) ?? "requested";
  }

  override async getRecordingActivation(recordingId: string): Promise<RecordingActivationRecord | undefined> {
    const raw = await this.recordRedis("get_recording_activation", () =>
      this.redis.get(this.recordingActivationKey(recordingId))
    );
    return parseRecordingActivation(raw);
  }

  async activateRecording(
    recordingId: string,
    roomExpiresAt: string | null = null
  ): Promise<"capturing" | "finalizing"> {
    const ttlMs = getTtlMilliseconds(roomExpiresAt);
    const result = await this.recordRedis("activate_recording", () =>
      this.redis.eval(ACTIVATE_RECORDING_SCRIPT, {
        keys: [this.recordingActivationKey(recordingId), this.recordingFinalizingKey(recordingId)],
        arguments: [JSON.stringify({ activatedAt: new Date().toISOString() }), String(ttlMs ?? 0)],
      })
    );
    const state = parseRecordingControlState(result);
    return state === "finalizing" ? state : "capturing";
  }

  async closeRecordingInputs(recordingId: string): Promise<"finalizing" | "inactive"> {
    const result = await this.recordRedis("close_recording_inputs", () =>
      this.redis.eval(CLOSE_RECORDING_INPUTS_SCRIPT, {
        keys: [this.recordingActivationKey(recordingId), this.recordingFinalizingKey(recordingId)],
        arguments: [String(EMPTY_ROOM_TTL_SECONDS * 1_000)],
      })
    );
    return result === "finalizing" ? result : "inactive";
  }

  async createAdmission(record: AdmissionRecord): Promise<void> {
    const parsed = parseAdmissionRecord(record);
    const ttlMs = getTtlMilliseconds(parsed?.expiresAt ?? null);
    if (!parsed || !ttlMs) {
      throw invalidToken("Invalid admission code");
    }

    const rawResult = await this.recordRedis("create_admission_atomic", () =>
      this.redis.eval(CREATE_ADMISSION_SCRIPT, {
        keys: [
          this.admissionKey(parsed.codeHash),
          this.roomKey(parsed.roomId),
          this.integrationRoomOwnerKey(parsed.roomId),
        ],
        arguments: [JSON.stringify(parsed), String(ttlMs), parsed.integrationId ?? ""],
      })
    );

    const result = parseAdmissionScriptStatus(rawResult);
    if (result === "created") {
      return;
    }
    if (result === "room_closed") {
      throw roomClosed();
    }
    if (result === "forbidden") {
      throw invalidToken("Invalid admission code");
    }
    throw roomNotFound();
  }

  async consumeAdmission(command: ConsumeAdmissionCommand): Promise<{ room: RoomMetadata; session: RoomSessionRecord }> {
    const parsedSession = parseRoomSession(command.session);
    if (!parsedSession) {
      throw invalidToken("Invalid admission code");
    }

    const ttlMs = getTtlMilliseconds(command.sessionExpiresAt);
    if (!ttlMs) {
      throw invalidToken("Invalid admission code");
    }

    const rawResult = await this.recordRedis("consume_admission_atomic", () =>
      this.redis.eval(CONSUME_ADMISSION_SCRIPT, {
        keys: [this.admissionKey(command.codeHash), this.roomSessionTokenIndexKey(parsedSession.tokenHash)],
        arguments: [
          command.expectedRoomId ?? "",
          JSON.stringify(parsedSession),
          JSON.stringify({ participantId: parsedSession.participantId }),
          String(ttlMs),
        ],
      })
    );

    const result = parseConsumeAdmissionResult(rawResult);
    if (result?.status === "consumed") {
      const room = parseRoomMetadata(JSON.parse(result.room) as unknown);
      const session = parseRoomSession(JSON.parse(result.session) as unknown);
      if (!room || !session) {
        throw invalidToken("Invalid admission code");
      }
      return { room, session };
    }
    if (result?.status === "room_closed") {
      throw roomClosed();
    }
    throw invalidToken("Invalid admission code");
  }

  async createJoinRequest(record: JoinRequestRecord, roomExpiresAt: string | null): Promise<void> {
    const parsed = parseJoinRequest(record);
    const ttlMs = getTtlMilliseconds(minIsoDeadline(parsed?.expiresAt, roomExpiresAt));
    if (!parsed || !ttlMs) {
      throw invalidToken("Invalid join request");
    }

    await this.recordRedis("save_join_request", () =>
      this.redis.hSet(this.joinRequestsKey(parsed.roomId), parsed.requestId, JSON.stringify(parsed))
    );
    await this.recordRedis("expire_join_requests", () => this.redis.pExpire(this.joinRequestsKey(parsed.roomId), ttlMs));
  }

  async getJoinRequest(roomId: string, requestId: string): Promise<JoinRequestRecord | undefined> {
    const raw = await this.recordRedis("get_join_request", () =>
      this.redis.hGet(this.joinRequestsKey(roomId), requestId)
    );
    return parseSerializedJoinRequest(raw);
  }

  async listPendingJoinRequests(roomId: string): Promise<JoinRequestRecord[]> {
    const values = await this.recordRedis("list_join_requests", () => this.redis.hVals(this.joinRequestsKey(roomId)));
    const now = Date.now();
    return values
      .map(parseSerializedJoinRequest)
      .filter((request): request is JoinRequestRecord =>
        Boolean(request && request.status === "pending" && Date.parse(request.expiresAt) > now)
      )
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  }

  async decideJoinRequest(
    roomId: string,
    requestId: string,
    status: "approved" | "denied",
    decidedByParticipantId: string
  ): Promise<JoinRequestRecord> {
    const existing = await this.getJoinRequest(roomId, requestId);
    if (!existing || existing.status !== "pending" || Date.parse(existing.expiresAt) <= Date.now()) {
      throw invalidToken("Invalid join request");
    }

    const decided: JoinRequestRecord = {
      ...existing,
      status,
      decidedAt: new Date().toISOString(),
      decidedByParticipantId,
    };
    await this.recordRedis("save_join_request", () =>
      this.redis.hSet(this.joinRequestsKey(roomId), requestId, JSON.stringify(decided))
    );
    return decided;
  }

  async fulfillApprovedJoinRequest(
    roomId: string,
    requestId: string,
    participantId: string,
    tokenHash: string,
    session: RoomSessionRecord,
    sessionExpiresAt: string | null
  ): Promise<JoinRequestRecord> {
    const existing = await this.getJoinRequest(roomId, requestId);
    if (!existing || existing.status !== "approved" || Date.parse(existing.expiresAt) <= Date.now()) {
      throw invalidToken("Invalid join request");
    }
    if (existing.approvedParticipantId || existing.approvedTokenHash) {
      throw invalidToken("Join request already fulfilled");
    }

    const fulfilled: JoinRequestRecord = {
      ...existing,
      approvedParticipantId: participantId,
      approvedTokenHash: tokenHash,
    };
    await this.saveRoomSession(roomId, session, sessionExpiresAt);
    await this.recordRedis("save_join_request", () =>
      this.redis.hSet(this.joinRequestsKey(roomId), requestId, JSON.stringify(fulfilled))
    );
    return fulfilled;
  }

  async getParticipantCount(roomId: string): Promise<number> {
    const currentEpoch = await this.getCurrentMediaEpoch();
    if (!currentEpoch) {
      return 0;
    }

    const values = await this.recordRedis("get_participant_count", () =>
      this.redis.hVals(`room:${roomId}:participants`)
    );
    return values.filter((value) => hasCurrentMediaEpoch(value, currentEpoch)).length;
  }

  async hasLiveParticipant(roomId: string, participantId: string): Promise<boolean> {
    const raw = await this.recordRedis("get_live_participant", () =>
      this.redis.hGet(`room:${roomId}:participants`, participantId)
    );
    const currentEpoch = await this.getCurrentMediaEpoch();
    return Boolean(raw && currentEpoch && hasCurrentMediaEpoch(raw, currentEpoch));
  }

  async saveRoomSession(roomId: string, session: RoomSessionRecord, roomExpiresAt: string | null): Promise<void> {
    const parsed = parseRoomSession(session);
    if (!parsed) {
      throw roomNotFound();
    }

    const key = this.roomSessionsKey(roomId);
    const existingRaw = await this.recordRedis("get_room_session", () => this.redis.hGet(key, parsed.participantId));
    const existing = parseSerializedRoomSession(existingRaw);
    const tokenIndexKey = this.roomSessionTokenIndexKey(parsed.tokenHash);
    const existingTokenIndexTtlMs =
      existing && existing.tokenHash === parsed.tokenHash
        ? await this.recordRedis("get_room_session_token_index_ttl", () => this.redis.pTTL(tokenIndexKey))
        : undefined;
    if (existing && existing.tokenHash !== parsed.tokenHash) {
      await this.recordRedis("delete_room_session_token_index", () =>
        this.redis.del(this.roomSessionTokenIndexKey(existing.tokenHash))
      );
    }

    await this.recordRedis("save_room_session", () =>
      this.redis.hSet(key, parsed.participantId, JSON.stringify(parsed))
    );
    await this.recordRedis("save_room_session_token_index", () =>
      this.redis.set(
        tokenIndexKey,
        JSON.stringify({ roomId, participantId: parsed.participantId })
      )
    );

    const ttlMs = getTtlMilliseconds(roomExpiresAt);
    if (ttlMs) {
      await this.recordRedis("expire_room_sessions", () => this.redis.pExpire(key, ttlMs));
      await this.recordRedis("expire_room_session_token_index", () => this.redis.pExpire(tokenIndexKey, ttlMs));
    } else if (existingTokenIndexTtlMs && existingTokenIndexTtlMs > 0) {
      await this.recordRedis("expire_room_session_token_index", () =>
        this.redis.pExpire(tokenIndexKey, existingTokenIndexTtlMs)
      );
    }
  }

  async getRoomSession(roomId: string, participantId: string): Promise<RoomSessionRecord | undefined> {
    const raw = await this.recordRedis("get_room_session", () =>
      this.redis.hGet(this.roomSessionsKey(roomId), participantId)
    );
    if (!raw) {
      return undefined;
    }

    return parseSerializedRoomSession(raw);
  }

  async findRoomSessionByTokenHash(roomId: string, tokenHash: string): Promise<RoomSessionRecord | undefined> {
    const rawIndex = await this.recordRedis("find_room_session_by_token_hash", () =>
      this.redis.get(this.roomSessionTokenIndexKey(tokenHash))
    );
    const index = parseRoomSessionTokenIndex(rawIndex);
    if (!index || index.roomId !== roomId) {
      return undefined;
    }

    const rawSession = await this.recordRedis("get_room_session_by_token_index", () =>
      this.redis.hGet(this.roomSessionsKey(roomId), index.participantId)
    );
    if (!rawSession) {
      return undefined;
    }

    const session = parseSerializedRoomSession(rawSession);
    return session?.tokenHash === tokenHash ? session : undefined;
  }

  private roomKey(roomId: string): string {
    return `room:${roomId}`;
  }

  private slugKey(slug: string): string {
    return `room_slug:${slug}`;
  }

  private roomSessionsKey(roomId: string): string {
    return `room:${roomId}:sessions`;
  }

  private joinRequestsKey(roomId: string): string {
    return `room:${roomId}:join_requests`;
  }

  private roomSessionTokenIndexKey(tokenHash: string): string {
    return `room_session_token:${tokenHash}`;
  }

  private integrationExternalRoomKey(integrationId: string, externalRoomId: string): string {
    return `integration_room:${integrationId}:${externalRoomId}`;
  }

  private integrationRoomOwnerKey(roomId: string): string {
    return `integration_room_owner:${roomId}`;
  }

  private integrationRecordingKey(recordingId: string): string {
    return `integration_recording:${recordingId}`;
  }

  private recordingActivationKey(recordingId: string): string {
    return `recording_activation:${recordingId}`;
  }

  private recordingFinalizingKey(recordingId: string): string {
    return `recording_finalizing:${recordingId}`;
  }

  private admissionKey(codeHash: string): string {
    return `admission:${codeHash}`;
  }

  private async getCurrentMediaEpoch(): Promise<string | undefined> {
    const raw = await this.recordRedis("read_media_lease", () => this.redis.get("media:lease"));
    if (!raw) {
      return undefined;
    }

    try {
      const value = JSON.parse(raw) as unknown;
      if (
        !isRecord(value) ||
        typeof value.mediaEpoch !== "string" ||
        value.mediaEpoch.length === 0 ||
        typeof value.expiresAt !== "string" ||
        Number.isNaN(Date.parse(value.expiresAt)) ||
        Date.parse(value.expiresAt) <= Date.now()
      ) {
        return undefined;
      }
      return value.mediaEpoch;
    } catch {
      return undefined;
    }
  }

  private async recordRedis<T>(
    operation:
      | "create_room_metadata"
      | "create_room_slug"
      | "create_room_atomic"
      | "expire_room_metadata"
      | "expire_room_slug"
      | "get_room_slug"
      | "get_room_metadata"
      | "get_participant_count"
      | "get_live_participant"
      | "save_room_session"
      | "save_room_session_token_index"
      | "delete_room_session_token_index"
      | "expire_room_sessions"
      | "expire_room_session_token_index"
      | "get_room_session"
      | "find_room_session_by_token_hash"
      | "get_room_session_by_token_index"
      | "get_room_session_token_index_ttl"
      | "get_integration_room_owner"
      | "get_integration_recording_owner"
      | "get_recording_control_state"
      | "get_recording_activation"
      | "activate_recording"
      | "close_recording_inputs"
      | "create_admission_atomic"
      | "consume_admission_atomic"
      | "save_join_request"
      | "expire_join_requests"
      | "get_join_request"
      | "list_join_requests"
      | "read_media_lease",
    work: () => Promise<T>
  ): Promise<T> {
    const startedAt = performance.now();
    try {
      const result = await work();
      getApiMetrics().recordRedisOperation({
        operation,
        outcome: "success",
        durationMs: performance.now() - startedAt,
      });
      return result;
    } catch (error) {
      getApiMetrics().recordRedisOperation({
        operation,
        outcome: "error",
        durationMs: performance.now() - startedAt,
      });
      throw error;
    }
  }
}

export class IntegrationRoomConflictError extends Error {
  constructor(readonly kind: "external_conflict") {
    super(kind);
    this.name = "IntegrationRoomConflictError";
  }
}

const CREATE_ROOM_SCRIPT = `
local room_key = KEYS[1]
local slug_key = KEYS[2]
local external_key = KEYS[3]
local owner_key = KEYS[4]
local recording_key = KEYS[5]

local room_json = ARGV[1]
local room_id = ARGV[2]
local ttl_ms = tonumber(ARGV[3])
local has_integration = ARGV[4] == "1"
local request_hash = ARGV[5]
local mapping_json = ARGV[6]
local recording_id = ARGV[7]

local function encode_result(status, room)
  if room then
    return cjson.encode({ status = status, room = room })
  end
  return cjson.encode({ status = status })
end

local function get_existing_room(mapping_raw)
  local mapping = cjson.decode(mapping_raw)
  if mapping["requestHash"] ~= request_hash then
    return nil, "conflict"
  end
  local existing_room = redis.call("GET", "room:" .. mapping["roomId"])
  if existing_room then
    return existing_room, nil
  end
  return nil, nil
end

if has_integration then
  local external_raw = redis.call("GET", external_key)
  if external_raw then
    local existing_room, conflict = get_existing_room(external_raw)
    if conflict then
      return encode_result("external_conflict")
    end
    if existing_room then
      return encode_result("existing", existing_room)
    end
  end
end

if redis.call("EXISTS", room_key) == 1 or redis.call("EXISTS", slug_key) == 1 then
  return encode_result("room_conflict")
end

redis.call("SET", room_key, room_json)
redis.call("SET", slug_key, room_id)
if ttl_ms > 0 then
  redis.call("PEXPIRE", room_key, ttl_ms)
  redis.call("PEXPIRE", slug_key, ttl_ms)
end

if has_integration then
   redis.call("SET", external_key, mapping_json)
   redis.call("SET", owner_key, mapping_json)
   if recording_id ~= "" then
     redis.call("SET", recording_key, mapping_json)
   end
   if ttl_ms > 0 then
     redis.call("PEXPIRE", external_key, ttl_ms)
     redis.call("PEXPIRE", owner_key, ttl_ms)
     if recording_id ~= "" then
       redis.call("PEXPIRE", recording_key, ttl_ms)
     end
  end
end

return encode_result("created", room_json)
`;

const CREATE_ADMISSION_SCRIPT = `
local admission_key = KEYS[1]
local room_key = KEYS[2]
local owner_key = KEYS[3]

local admission_json = ARGV[1]
local ttl_ms = tonumber(ARGV[2])
local integration_id = ARGV[3]

local room_raw = redis.call("GET", room_key)
if not room_raw then
  return "room_not_found"
end

local room = cjson.decode(room_raw)
if room["status"] == "closed" then
  return "room_closed"
end

if integration_id ~= "" then
  local owner_raw = redis.call("GET", owner_key)
  if not owner_raw then
    return "forbidden"
  end

  local owner = cjson.decode(owner_raw)
  if owner["integrationId"] ~= integration_id then
    return "forbidden"
  end
end

redis.call("SET", admission_key, admission_json)
if ttl_ms > 0 then
  redis.call("PEXPIRE", admission_key, ttl_ms)
end

return "created"
`;

const GET_RECORDING_CONTROL_STATE_SCRIPT = `
if redis.call("EXISTS", KEYS[2]) == 1 then return "finalizing" end
if redis.call("EXISTS", KEYS[1]) == 1 then return "capturing" end
return "requested"
`;

const ACTIVATE_RECORDING_SCRIPT = `
if redis.call("EXISTS", KEYS[2]) == 1 then return "finalizing" end
if redis.call("EXISTS", KEYS[1]) == 0 then
  redis.call("SET", KEYS[1], ARGV[1])
  local ttl_ms = tonumber(ARGV[2])
  if ttl_ms > 0 then redis.call("PEXPIRE", KEYS[1], ttl_ms) end
end
return "capturing"
`;

const CLOSE_RECORDING_INPUTS_SCRIPT = `
if redis.call("EXISTS", KEYS[2]) == 1 then return "finalizing" end
if redis.call("EXISTS", KEYS[1]) == 0 then return "inactive" end
local max_ttl_ms = tonumber(ARGV[1])
local activation_ttl_ms = redis.call("PTTL", KEYS[1])
local ttl_ms = max_ttl_ms
if activation_ttl_ms > 0 and activation_ttl_ms < ttl_ms then
  ttl_ms = activation_ttl_ms
end
redis.call("SET", KEYS[2], "1")
redis.call("PEXPIRE", KEYS[1], ttl_ms)
redis.call("PEXPIRE", KEYS[2], ttl_ms)
return "finalizing"
`;

const CONSUME_ADMISSION_SCRIPT = `
local admission_key = KEYS[1]
local token_index_key = KEYS[2]

local expected_room_id = ARGV[1]
local session_json = ARGV[2]
local token_index_json = ARGV[3]
local session_ttl_ms = tonumber(ARGV[4])

local admission_raw = redis.call("GET", admission_key)
if not admission_raw then
  return cjson.encode({ status = "invalid" })
end

local admission_ttl_ms = redis.call("PTTL", admission_key)
if admission_ttl_ms <= 0 then
  return cjson.encode({ status = "invalid" })
end

local admission = cjson.decode(admission_raw)
if admission["consumedAt"] then
  return cjson.encode({ status = "invalid" })
end

if expected_room_id ~= "" and admission["roomId"] ~= expected_room_id then
  return cjson.encode({ status = "invalid" })
end

local room_key = "room:" .. admission["roomId"]
local room_raw = redis.call("GET", room_key)
if not room_raw then
  return cjson.encode({ status = "invalid" })
end

local room = cjson.decode(room_raw)
if room["status"] == "closed" then
  return cjson.encode({ status = "room_closed" })
end

local session = cjson.decode(session_json)
local admission_display_name = admission["identity"]["displayName"]
if admission_display_name ~= nil and admission_display_name ~= cjson.null then
  session["displayName"] = admission_display_name
else
  session["displayName"] = cjson.null
end
session["isCreator"] = admission["roomControls"] == "creator"
local session_identity = {
  kind = admission["identity"]["kind"],
  source = admission["identity"]["source"]
}
if admission["integrationId"] ~= nil and admission["integrationId"] ~= cjson.null then
  session_identity["integrationId"] = admission["integrationId"]
end
if admission["identity"]["externalSubject"] ~= nil and admission["identity"]["externalSubject"] ~= cjson.null then
  session_identity["externalSubject"] = admission["identity"]["externalSubject"]
end
if admission["identity"]["avatarUrl"] ~= nil and admission["identity"]["avatarUrl"] ~= cjson.null then
  session_identity["avatarUrl"] = admission["identity"]["avatarUrl"]
end
session["identity"] = session_identity
session_json = cjson.encode(session)
local room_sessions_key = "room:" .. admission["roomId"] .. ":sessions"
local token_index = cjson.decode(token_index_json)
token_index["roomId"] = admission["roomId"]

redis.call("HSET", room_sessions_key, session["participantId"], session_json)
redis.call("SET", token_index_key, cjson.encode(token_index))
local room_ttl_ms = redis.call("PTTL", room_key)
if room_ttl_ms > 0 and room_ttl_ms < session_ttl_ms then
  session_ttl_ms = room_ttl_ms
end
if admission_ttl_ms > 0 and admission_ttl_ms < session_ttl_ms then
  session_ttl_ms = admission_ttl_ms
end
if session_ttl_ms > 0 then
  redis.call("PEXPIRE", room_sessions_key, session_ttl_ms)
  redis.call("PEXPIRE", token_index_key, session_ttl_ms)
end

admission["consumedAt"] = string.format("%d", redis.call("TIME")[1])
redis.call("SET", admission_key, cjson.encode(admission))
redis.call("PEXPIRE", admission_key, admission_ttl_ms)

return cjson.encode({ status = "consumed", room = room_raw, session = session_json })
`;

function parseCreateRoomScriptResult(
  value: unknown
):
  | { status: "created" | "existing"; room: string }
  | { status: "external_conflict" | "room_conflict" }
  | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed) || typeof parsed.status !== "string") {
      return undefined;
    }
    if ((parsed.status === "created" || parsed.status === "existing") && typeof parsed.room === "string") {
      return { status: parsed.status, room: parsed.room };
    }
    if (
      parsed.status === "external_conflict" ||
      parsed.status === "room_conflict"
    ) {
      return { status: parsed.status };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function parseAdmissionScriptStatus(value: unknown): "created" | "room_not_found" | "room_closed" | "forbidden" | undefined {
  return value === "created" || value === "room_not_found" || value === "room_closed" || value === "forbidden"
    ? value
    : undefined;
}

function parseRecordingControlState(value: unknown): RecordingControlState | undefined {
  return value === "requested" || value === "capturing" || value === "finalizing" ? value : undefined;
}

function parseRecordingActivation(value: string | null | undefined): RecordingActivationRecord | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !isRecord(parsed) ||
      typeof parsed.activatedAt !== "string" ||
      Number.isNaN(Date.parse(parsed.activatedAt))
    ) {
      return undefined;
    }
    return { activatedAt: parsed.activatedAt };
  } catch {
    return undefined;
  }
}

function parseConsumeAdmissionResult(
  value: unknown
):
  | { status: "consumed"; room: string; session: string }
  | { status: "invalid" | "room_closed" }
  | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed) || typeof parsed.status !== "string") {
      return undefined;
    }
    if (parsed.status === "consumed" && typeof parsed.room === "string" && typeof parsed.session === "string") {
      return { status: parsed.status, room: parsed.room, session: parsed.session };
    }
    if (parsed.status === "invalid" || parsed.status === "room_closed") {
      return { status: parsed.status };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function parseIntegrationRoomRecord(value: CreateIntegrationRoomRecord | undefined): CreateIntegrationRoomRecord | undefined {
  if (!value) {
    return undefined;
  }
  if (
    value.integrationId.length === 0 ||
    value.externalRoomId.length === 0 ||
    value.requestHash.length === 0
  ) {
    return undefined;
  }
  if (value.recordingId !== undefined && (value.recordingId.length === 0 || !value.recordingId.startsWith("rec_"))) {
    return undefined;
  }
  return value;
}

function parseIntegrationRoomOwner(value: string | null | undefined): IntegrationRoomOwnerRecord | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !isRecord(parsed) ||
        typeof parsed.roomId !== "string" ||
        parsed.roomId.length === 0 ||
        typeof parsed.integrationId !== "string" ||
        parsed.integrationId.length === 0 ||
        (parsed.externalRoomHash !== undefined &&
          (typeof parsed.externalRoomHash !== "string" || parsed.externalRoomHash.length === 0)) ||
        typeof parsed.requestHash !== "string" ||
        parsed.requestHash.length === 0 ||
        (parsed.recordingId !== undefined &&
          (typeof parsed.recordingId !== "string" || parsed.recordingId.length === 0 || !parsed.recordingId.startsWith("rec_"))) ||
      typeof parsed.createdAt !== "string" ||
      Number.isNaN(Date.parse(parsed.createdAt))
    ) {
      return undefined;
    }

    return parsed as IntegrationRoomOwnerRecord;
  } catch {
    return undefined;
  }
}

function parseAdmissionRecord(value: unknown): AdmissionRecord | undefined {
  if (!isRecord(value) || !isRecord(value.identity)) {
    return undefined;
  }

  const admission = {
    roomId: value.roomId,
    integrationId: value.integrationId,
    codeHash: value.codeHash,
    identity: {
      kind: value.identity.kind,
      source: value.identity.source,
      externalSubject: value.identity.externalSubject,
      displayName: value.identity.displayName,
      avatarUrl: value.identity.avatarUrl,
    },
    roomControls: value.roomControls,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  };

  if (
    typeof admission.roomId !== "string" ||
    admission.roomId.length === 0 ||
    !(
      admission.integrationId === undefined ||
      (typeof admission.integrationId === "string" && admission.integrationId.length > 0)
    ) ||
    typeof admission.codeHash !== "string" ||
    admission.codeHash.length === 0 ||
    (admission.identity.kind !== "guest" && admission.identity.kind !== "authenticated") ||
    (admission.identity.source !== "integration_admission" && admission.identity.source !== "room_admission") ||
    !isOptionalUrl(admission.identity.avatarUrl) ||
    (admission.roomControls !== "creator" && admission.roomControls !== "none") ||
    typeof admission.createdAt !== "string" ||
    Number.isNaN(Date.parse(admission.createdAt)) ||
    typeof admission.expiresAt !== "string" ||
    Number.isNaN(Date.parse(admission.expiresAt))
  ) {
    return undefined;
  }

  if (admission.identity.source === "integration_admission") {
    if (
      typeof admission.integrationId !== "string" ||
      admission.integrationId.length === 0 ||
      typeof admission.identity.externalSubject !== "string" ||
      admission.identity.externalSubject.length === 0 ||
      admission.identity.externalSubject.length > 160 ||
      typeof admission.identity.displayName !== "string" ||
      admission.identity.displayName.trim().length === 0 ||
      admission.identity.displayName.length > 80
    ) {
      return undefined;
    }
  }

  if (admission.identity.source === "room_admission") {
    if (
      admission.integrationId !== undefined ||
      admission.identity.kind !== "guest" ||
      admission.identity.externalSubject !== undefined ||
      !(admission.identity.displayName === undefined || admission.identity.displayName === null) ||
      admission.roomControls !== "none"
    ) {
      return undefined;
    }
  }

  return admission as AdmissionRecord;
}

function parseRoomSession(value: unknown): RoomSessionRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const identity = parseRoomSessionIdentity(value.identity);
  if (value.identity !== undefined && !identity) {
    return undefined;
  }

  const session = {
    participantId: value.participantId,
    displayName: value.displayName,
    isCreator: value.isCreator,
    tokenHash: value.tokenHash,
    createdAt: value.createdAt,
    identity,
  };

  if (
    typeof session.participantId !== "string" ||
    session.participantId.length === 0 ||
    !(
      session.displayName === null ||
      (typeof session.displayName === "string" &&
        session.displayName.trim().length > 0 &&
        session.displayName.length <= 80)
    ) ||
    typeof session.isCreator !== "boolean" ||
    typeof session.tokenHash !== "string" ||
    session.tokenHash.length === 0 ||
    typeof session.createdAt !== "string" ||
    Number.isNaN(Date.parse(session.createdAt))
  ) {
    return undefined;
  }

  return session as RoomSessionRecord;
}

function parseRoomSessionIdentity(value: unknown): RoomSessionIdentityRecord | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }

  const identity = {
    kind: value.kind,
    source: value.source,
    integrationId: value.integrationId,
    externalSubject: value.externalSubject,
    avatarUrl: value.avatarUrl,
  };

  if (
    (identity.kind !== "guest" && identity.kind !== "authenticated") ||
    (identity.source !== "anonymous" &&
      identity.source !== "trusted_cookie" &&
      identity.source !== "integration_admission" &&
      identity.source !== "room_admission") ||
    !(identity.integrationId === undefined || (typeof identity.integrationId === "string" && identity.integrationId.length > 0)) ||
    !(
      identity.externalSubject === undefined ||
      (typeof identity.externalSubject === "string" &&
        identity.externalSubject.length > 0 &&
        identity.externalSubject.length <= 160)
    ) ||
    !isOptionalUrl(identity.avatarUrl)
  ) {
    return undefined;
  }

  if (
    identity.source === "integration_admission" &&
    (typeof identity.integrationId !== "string" ||
      identity.integrationId.length === 0 ||
      typeof identity.externalSubject !== "string" ||
      identity.externalSubject.length === 0)
  ) {
    return undefined;
  }

  if (
    identity.source === "trusted_cookie" &&
    (identity.kind !== "authenticated" ||
      identity.integrationId !== undefined ||
      typeof identity.externalSubject !== "string" ||
      identity.externalSubject.length === 0)
  ) {
    return undefined;
  }

  if (
    identity.source === "room_admission" &&
    (identity.integrationId !== undefined || identity.externalSubject !== undefined || identity.avatarUrl !== undefined)
  ) {
    return undefined;
  }

  return identity as RoomSessionIdentityRecord;
}

function parseSerializedRoomSession(value: string | null | undefined): RoomSessionRecord | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return parseRoomSession(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

function parseJoinRequest(value: unknown): JoinRequestRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const identity = parseRoomSessionIdentity(value.identity);
  if (value.identity !== undefined && !identity) {
    return undefined;
  }

  const request = {
    requestId: value.requestId,
    roomId: value.roomId,
    displayName: value.displayName,
    tokenHash: value.tokenHash,
    status: value.status,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    decidedAt: value.decidedAt,
    decidedByParticipantId: value.decidedByParticipantId,
    approvedParticipantId: value.approvedParticipantId,
    approvedTokenHash: value.approvedTokenHash,
    identity,
  };

  if (
    typeof request.requestId !== "string" ||
    request.requestId.length === 0 ||
    typeof request.roomId !== "string" ||
    request.roomId.length === 0 ||
    typeof request.displayName !== "string" ||
    request.displayName.trim().length === 0 ||
    request.displayName.length > 80 ||
    typeof request.tokenHash !== "string" ||
    request.tokenHash.length === 0 ||
    (request.status !== "pending" && request.status !== "approved" && request.status !== "denied") ||
    typeof request.createdAt !== "string" ||
    Number.isNaN(Date.parse(request.createdAt)) ||
    typeof request.expiresAt !== "string" ||
    Number.isNaN(Date.parse(request.expiresAt)) ||
    !isOptionalDateTime(request.decidedAt) ||
    !(request.decidedByParticipantId === undefined || (typeof request.decidedByParticipantId === "string" && request.decidedByParticipantId.length > 0)) ||
    !(request.approvedParticipantId === undefined || (typeof request.approvedParticipantId === "string" && request.approvedParticipantId.length > 0)) ||
    !(request.approvedTokenHash === undefined || (typeof request.approvedTokenHash === "string" && request.approvedTokenHash.length > 0))
  ) {
    return undefined;
  }

  return request as JoinRequestRecord;
}

function parseSerializedJoinRequest(value: string | null | undefined): JoinRequestRecord | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return parseJoinRequest(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

function parseRoomSessionTokenIndex(value: string | null | undefined): { roomId: string; participantId: string } | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !isRecord(parsed) ||
      typeof parsed.roomId !== "string" ||
      parsed.roomId.length === 0 ||
      typeof parsed.participantId !== "string" ||
      parsed.participantId.length === 0
    ) {
      return undefined;
    }

    return { roomId: parsed.roomId, participantId: parsed.participantId };
  } catch {
    return undefined;
  }
}

function getTtlMilliseconds(expiresAt: string | null): number | undefined {
  if (!expiresAt) {
    return undefined;
  }

  const ttlMs = new Date(expiresAt).getTime() - Date.now();
  return ttlMs > 0 ? ttlMs : undefined;
}

function minIsoDeadline(left: string | null | undefined, right: string | null | undefined): string | null {
  if (!left) return right ?? null;
  if (!right) return left;
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function parseRoomMetadata(value: unknown): RoomMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const room = {
    roomId: value.roomId,
    slug: value.slug,
    accessPolicy: value.accessPolicy ?? "link",
    mediaNodeId: value.mediaNodeId,
    signalingUrl: value.signalingUrl,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    status: value.status,
    closedReason: value.closedReason ?? null,
    recordingRequested: value.recordingRequested ?? false,
  };

  if (
    typeof room.roomId !== "string" ||
    room.roomId.length === 0 ||
    typeof room.slug !== "string" ||
    room.slug.length === 0 ||
    (room.accessPolicy !== "link" && room.accessPolicy !== "approval" && room.accessPolicy !== "admission") ||
    typeof room.mediaNodeId !== "string" ||
    room.mediaNodeId.length === 0 ||
    typeof room.signalingUrl !== "string" ||
    !isUrl(room.signalingUrl) ||
    typeof room.createdAt !== "string" ||
    Number.isNaN(Date.parse(room.createdAt)) ||
    !isExpiresAt(room.expiresAt) ||
    (room.status !== "active" && room.status !== "closed") ||
    !isClosedReason(room.closedReason) ||
    typeof room.recordingRequested !== "boolean"
  ) {
    return undefined;
  }

  return room as RoomMetadata;
}

function isExpiresAt(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && !Number.isNaN(Date.parse(value)));
}

function isClosedReason(value: unknown): value is RoomMetadata["closedReason"] {
  return (
    value === null ||
    value === "closed_by_creator" ||
    value === "empty_timeout" ||
    value === "server_shutdown" ||
    value === "media_server_error"
  );
}

function isOptionalDateTime(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && !Number.isNaN(Date.parse(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasCurrentMediaEpoch(value: string, mediaEpoch: string): boolean {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) && parsed.mediaEpoch === mediaEpoch && isRecord(parsed.participant);
  } catch {
    return false;
  }
}

function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function isOptionalUrl(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length <= 512 && isUrl(value));
}
