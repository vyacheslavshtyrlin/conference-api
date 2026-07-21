import { HttpException, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ApiConfig } from "../config/api-config.js";
import { integrationAuthNotConfigured, invalidIntegrationCredential } from "./integration-auth.errors.js";

type JwtHeader = {
  alg?: string;
  typ?: string;
};

type JwtPayload = {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
};

export type IntegrationCredential = {
  integrationId: string;
  subject: string;
};

function decodeBase64UrlJson<T>(value: string): T {
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  return JSON.parse(decoded) as T;
}

function normalizeAudience(audience: string | string[] | undefined): string[] {
  if (Array.isArray(audience)) return audience;
  return audience ? [audience] : [];
}

@Injectable()
export class IntegrationAuthService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<ApiConfig, true>) {}

  verifyBearerHeader(authorization: string | undefined): IntegrationCredential {
    const token = this.extractBearerToken(authorization);
    return this.verifyJwt(token);
  }

  private extractBearerToken(authorization: string | undefined): string {
    if (!authorization) throw invalidIntegrationCredential();

    const [scheme, token, ...extra] = authorization.trim().split(/\s+/);
    if (scheme !== "Bearer" || !token || extra.length > 0) {
      throw invalidIntegrationCredential();
    }

    return token;
  }

  private verifyJwt(token: string): IntegrationCredential {
    const credentials = this.config.get("INTEGRATION_JWT_CREDENTIALS_JSON", { infer: true });
    const maxTtlSeconds = this.config.get("INTEGRATION_JWT_MAX_TTL_SECONDS", { infer: true });

    if (!credentials?.length) {
      throw integrationAuthNotConfigured();
    }

    const parts = token.split(".");
    if (parts.length !== 3) throw invalidIntegrationCredential();

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    if (!encodedHeader || !encodedPayload || !encodedSignature) throw invalidIntegrationCredential();

    try {
      const header = decodeBase64UrlJson<JwtHeader>(encodedHeader);
      const payload = decodeBase64UrlJson<JwtPayload>(encodedPayload);
      if (header.alg !== "HS256") throw invalidIntegrationCredential();

      const integrationId = this.readIntegrationId(payload);
      const credentialConfig = credentials.find((credential) => credential.integrationId === integrationId);
      if (!credentialConfig) throw invalidIntegrationCredential();

      this.assertSignature(`${encodedHeader}.${encodedPayload}`, encodedSignature, credentialConfig.hs256Secret);
      this.assertPayload(payload, credentialConfig.issuer, credentialConfig.audience, maxTtlSeconds);

      return {
        integrationId,
        subject: integrationId,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw invalidIntegrationCredential();
    }
  }

  private assertSignature(signingInput: string, signature: string, secret: string): void {
    const expected = createHmac("sha256", secret).update(signingInput).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw invalidIntegrationCredential();
    }
  }

  private readIntegrationId(payload: JwtPayload): string {
    const subject = typeof payload.sub === "string" ? payload.sub : undefined;
    if (!subject) throw invalidIntegrationCredential();
    return subject;
  }

  private assertPayload(payload: JwtPayload, issuer: string, audience: string, maxTtlSeconds: number): void {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (payload.iss !== issuer) throw invalidIntegrationCredential();
    if (!normalizeAudience(payload.aud).includes(audience)) throw invalidIntegrationCredential();
    if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) throw invalidIntegrationCredential();
    if (typeof payload.iat !== "number" || payload.iat > nowSeconds || payload.exp <= payload.iat) {
      throw invalidIntegrationCredential();
    }
    if (payload.exp - payload.iat > maxTtlSeconds) throw invalidIntegrationCredential();
    if (payload.nbf !== undefined && payload.nbf > nowSeconds) throw invalidIntegrationCredential();
  }
}
