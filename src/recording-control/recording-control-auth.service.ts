import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ApiConfig } from "../config/api-config.js";
import { invalidToken } from "../rooms/room-errors.js";

type JwtHeader = { alg?: string };
type JwtPayload = { iss?: string; aud?: string | string[]; sub?: string; exp?: number; iat?: number; nbf?: number };

@Injectable()
export class RecordingControlAuthService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<ApiConfig, true>) {}

  verifyBearerHeader(authorization: string | string[] | undefined): void {
    const value = Array.isArray(authorization) ? authorization[0] : authorization;
    const [scheme, token, ...extra] = value?.trim().split(/\s+/) ?? [];
    if (scheme !== "Bearer" || !token || extra.length > 0) throw invalidToken("Invalid recording control credential");

    const secret = this.config.get("RECORDING_CONTROL_JWT_HS256_SECRET", { infer: true });
    if (!secret) throw invalidToken("Invalid recording control credential");

    const [encodedHeader, encodedPayload, encodedSignature, ...rest] = token.split(".");
    if (!encodedHeader || !encodedPayload || !encodedSignature || rest.length > 0) {
      throw invalidToken("Invalid recording control credential");
    }

    try {
      const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as JwtHeader;
      const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as JwtPayload;
      const expected = createHmac("sha256", secret).update(`${encodedHeader}.${encodedPayload}`).digest();
      const actual = Buffer.from(encodedSignature, "base64url");
      const now = Math.floor(Date.now() / 1_000);
      const audiences = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
      if (
        header.alg !== "HS256" ||
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected) ||
        payload.iss !== "conference-signaling" ||
        !audiences.includes("conference-recording-control") ||
        payload.sub !== "signaling" ||
        typeof payload.iat !== "number" ||
        typeof payload.exp !== "number" ||
        payload.iat > now ||
        payload.exp <= now ||
        payload.exp <= payload.iat ||
        payload.exp - payload.iat > 300 ||
        (payload.nbf !== undefined && payload.nbf > now)
      ) {
        throw invalidToken("Invalid recording control credential");
      }
    } catch {
      throw invalidToken("Invalid recording control credential");
    }
  }
}
