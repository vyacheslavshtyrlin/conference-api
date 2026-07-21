import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ApiConfig } from "../config/api-config.js";

type JoinTokenPayload = {
  roomId: string;
  participantId: string;
  displayName: string;
  isCreator: boolean;
  exp: number;
};

@Injectable()
export class RoomTokenService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<ApiConfig, true>) {}

  createRoomSessionToken(): string {
    return randomBytes(32).toString("base64url");
  }

  createAdmissionCode(): string {
    return randomBytes(32).toString("base64url");
  }

  hashAdmissionCode(code: string): string {
    return createHash("sha256").update(code).digest("base64url");
  }

  hashRoomSessionToken(token: string): string {
    return createHmac("sha256", this.roomSessionTokenSecret()).update(token).digest("base64url");
  }

  isRoomSessionTokenValid(token: string | undefined, expectedHash: string): boolean {
    if (!token) {
      return false;
    }

    const actualHash = this.hashRoomSessionToken(token);
    const actual = Buffer.from(actualHash);
    const expected = Buffer.from(expectedHash);

    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  createJoinToken(payload: Omit<JoinTokenPayload, "exp">): string {
    const exp = Math.floor(Date.now() / 1000) + this.joinTokenTtlSeconds();
    const encodedHeader = this.base64UrlJson({ alg: "HS256", typ: "JWT" });
    const encodedPayload = this.base64UrlJson({ ...payload, exp });
    const signature = this.sign(`${encodedHeader}.${encodedPayload}`, this.joinTokenSecret());

    return `${encodedHeader}.${encodedPayload}.${signature}`;
  }

  private base64UrlJson(value: unknown): string {
    return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  }

  private sign(input: string, secret: string): string {
    return createHmac("sha256", secret).update(input).digest("base64url");
  }

  private roomSessionTokenSecret(): string {
    return this.config.get("ROOM_SESSION_TOKEN_SECRET", { infer: true }) ?? this.joinTokenSecret();
  }

  private joinTokenSecret(): string {
    return this.config.get("JOIN_TOKEN_SECRET", { infer: true });
  }

  private joinTokenTtlSeconds(): number {
    const raw = Number(this.config.get("JOIN_TOKEN_TTL_SECONDS", { infer: true }));
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 300;
  }
}
