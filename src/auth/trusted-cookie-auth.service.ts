import { HttpException, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  isAuthCookieEnabled,
  type ApiConfig,
} from "../config/api-config.js";
import { authNotConfigured } from "../rooms/room-errors.js";

type JwtHeader = {
  alg?: string;
  typ?: string;
};

type TrustedCookieJwtPayload = {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  name?: string;
  displayName?: string;
  avatarUrl?: string;
};

export type TrustedCookieIdentity = {
  kind: "authenticated";
  source: "trusted_cookie";
  externalSubject: string;
  displayName: string;
  avatarUrl?: string;
};

function decodeBase64UrlJson<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
}

function normalizeAudience(audience: string | string[] | undefined): string[] {
  if (Array.isArray(audience)) return audience;
  return audience ? [audience] : [];
}

@Injectable()
export class TrustedCookieAuthService {
  constructor(
    @Inject(ConfigService)
    private readonly config: ConfigService<ApiConfig, true>,
  ) {}

  assertConfigured(): void {
    this.getJwtConfig();
  }

  resolve(
    cookieHeader: string | string[] | undefined,
  ): TrustedCookieIdentity | undefined {
    if (!this.isEnabled()) {
      return undefined;
    }

    const token = this.extractCookieToken(cookieHeader);
    if (!token) {
      return undefined;
    }

    try {
      return this.verifyJwt(token);
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() >= 500) {
        throw error;
      }
      return undefined;
    }
  }

  private extractCookieToken(
    cookieHeader: string | string[] | undefined,
  ): string | undefined {
    const cookieName =
      this.config.get("AUTH_COOKIE_NAME", { infer: true }) ??
      "conference_identity";
    const headerValue = Array.isArray(cookieHeader)
      ? cookieHeader.join("; ")
      : cookieHeader;
    if (!headerValue) {
      return undefined;
    }

    for (const part of headerValue.split(";")) {
      const [rawName, ...rawValueParts] = part.trim().split("=");
      if (rawName !== cookieName) continue;
      const rawValue = rawValueParts.join("=");
      if (!rawValue) return undefined;
      try {
        return decodeURIComponent(rawValue);
      } catch {
        return rawValue;
      }
    }

    return undefined;
  }

  private verifyJwt(token: string): TrustedCookieIdentity {
    const { issuer, audience, secret } = this.getJwtConfig();
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid trusted cookie");

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    if (!encodedHeader || !encodedPayload || !encodedSignature)
      throw new Error("Invalid trusted cookie");

    const header = decodeBase64UrlJson<JwtHeader>(encodedHeader);
    const payload =
      decodeBase64UrlJson<TrustedCookieJwtPayload>(encodedPayload);
    if (header.alg !== "HS256") throw new Error("Invalid trusted cookie");

    this.assertSignature(
      `${encodedHeader}.${encodedPayload}`,
      encodedSignature,
      secret,
    );
    this.assertPayload(payload, issuer, audience);

    const displayName = (payload.displayName ?? payload.name ?? "").trim();
    if (!displayName || displayName.length > 80)
      throw new Error("Invalid trusted cookie");

    const identity: TrustedCookieIdentity = {
      kind: "authenticated",
      source: "trusted_cookie",
      externalSubject: payload.sub ?? "",
      displayName,
    };
    if (
      payload.avatarUrl &&
      payload.avatarUrl.length <= 512 &&
      isUrl(payload.avatarUrl)
    ) {
      identity.avatarUrl = payload.avatarUrl;
    }
    return identity;
  }

  private getJwtConfig(): { issuer: string; audience: string; secret: string } {
    const issuer = this.config.get("AUTH_COOKIE_JWT_ISSUER", { infer: true });
    const audience = this.config.get("AUTH_COOKIE_JWT_AUDIENCE", {
      infer: true,
    });
    const secret = this.config.get("AUTH_COOKIE_JWT_HS256_SECRET", {
      infer: true,
    });
    if (!issuer || !audience || !secret) {
      throw authNotConfigured();
    }
    return { issuer, audience, secret };
  }

  private isEnabled(): boolean {
    return isAuthCookieEnabled({
      AUTH_COOKIE_ENABLED: this.config.get("AUTH_COOKIE_ENABLED", {
        infer: true,
      }),
    });
  }

  private assertSignature(
    signingInput: string,
    signature: string,
    secret: string,
  ): void {
    const expected = createHmac("sha256", secret).update(signingInput).digest();
    const actual = Buffer.from(signature, "base64url");
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      throw new Error("Invalid trusted cookie");
    }
  }

  private assertPayload(
    payload: TrustedCookieJwtPayload,
    issuer: string,
    audience: string,
  ): void {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (payload.iss !== issuer) throw new Error("Invalid trusted cookie");
    if (!normalizeAudience(payload.aud).includes(audience))
      throw new Error("Invalid trusted cookie");
    if (!payload.sub || payload.sub.length > 160)
      throw new Error("Invalid trusted cookie");
    if (typeof payload.exp !== "number" || payload.exp <= nowSeconds)
      throw new Error("Invalid trusted cookie");
    if (payload.nbf !== undefined && payload.nbf > nowSeconds)
      throw new Error("Invalid trusted cookie");
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
