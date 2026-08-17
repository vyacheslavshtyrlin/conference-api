import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ApiConfig } from "../config/api-config.js";

export type ObjectIdentity = {
  objectKey: string;
  bytes: number;
  sha256: string;
  contentType: string;
};

@Injectable()
export class RecordingStorageService {
  private readonly client: S3Client;
  private readonly publicClient: S3Client;

  constructor(@Inject(ConfigService) private readonly config: ConfigService<ApiConfig, true>) {
    const options = {
      region: this.config.get("RECORDING_S3_REGION", { infer: true }),
      forcePathStyle: this.config.get("RECORDING_S3_FORCE_PATH_STYLE", { infer: true }),
      credentials: {
        accessKeyId: this.config.get("RECORDING_S3_ACCESS_KEY_ID", { infer: true }) ?? "",
        secretAccessKey: this.config.get("RECORDING_S3_SECRET_ACCESS_KEY", { infer: true }) ?? "",
      },
    };
    this.client = new S3Client({ ...options, endpoint: this.config.get("RECORDING_S3_ENDPOINT", { infer: true }) });
    this.publicClient = new S3Client({ ...options, endpoint: this.config.get("RECORDING_S3_PUBLIC_ENDPOINT", { infer: true }) ?? this.config.get("RECORDING_S3_ENDPOINT", { infer: true }) });
  }

  async allocatePut(identity: ObjectIdentity): Promise<{ url: string; expiresAt: string }> {
    const expiresIn = this.config.get("RECORDING_S3_PRESIGN_TTL_SECONDS", { infer: true });
    const command = new PutObjectCommand({
      Bucket: this.bucket(),
      Key: identity.objectKey,
      ContentType: identity.contentType,
      ContentLength: identity.bytes,
      Metadata: { sha256: identity.sha256 },
    });
    return {
      url: await getSignedUrl(this.client, command, { expiresIn }),
      expiresAt: new Date(Date.now() + expiresIn * 1_000).toISOString(),
    };
  }

  async allocateGet(objectKey: string): Promise<{ url: string; expiresAt: string }> {
    const expiresIn = this.config.get("RECORDING_S3_PRESIGN_TTL_SECONDS", { infer: true });
    return {
      url: await getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket(), Key: objectKey }), { expiresIn }),
      expiresAt: new Date(Date.now() + expiresIn * 1_000).toISOString(),
    };
  }

  async allocateIntegrationGet(objectKey: string): Promise<{ url: string; expiresAt: string }> {
    const expiresIn = this.config.get("RECORDING_S3_PRESIGN_TTL_SECONDS", { infer: true });
    return {
      url: await getSignedUrl(this.publicClient, new GetObjectCommand({ Bucket: this.bucket(), Key: objectKey }), { expiresIn }),
      expiresAt: new Date(Date.now() + expiresIn * 1_000).toISOString(),
    };
  }

  async verify(identity: ObjectIdentity): Promise<void> {
    const object = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket(), Key: identity.objectKey }));
    if (
      object.ContentLength !== identity.bytes ||
      object.ContentType !== identity.contentType ||
      object.Metadata?.sha256 !== identity.sha256 ||
      (object.ChecksumSHA256 && object.ChecksumSHA256 !== Buffer.from(identity.sha256, "hex").toString("base64"))
    ) {
      throw new Error("storage object identity verification failed");
    }
  }

  async delete(objectKey: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket(), Key: objectKey }));
  }

  signUpload(payload: Record<string, unknown>): string {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${body}.${this.sign(body)}`;
  }

  verifyUpload(token: string): Record<string, unknown> | undefined {
    const [body, signature, ...rest] = token.split(".");
    if (!body || !signature || rest.length > 0 || !safeEqual(signature, this.sign(body))) return undefined;
    try {
      const value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
      return typeof value.exp === "number" && value.exp * 1_000 >= Date.now() ? value : undefined;
    } catch {
      return undefined;
    }
  }

  randomLease(): string {
    return randomBytes(32).toString("base64url");
  }

  private bucket(): string {
    return this.config.get("RECORDING_S3_BUCKET", { infer: true }) ?? "";
  }

  private sign(value: string): string {
    return createHmac("sha256", this.config.get("RECORDING_CAPTURE_SERVICE_SECRET", { infer: true }) ?? "")
      .update(value)
      .digest("base64url");
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
