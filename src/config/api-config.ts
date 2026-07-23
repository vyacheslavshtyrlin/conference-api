import { z } from "zod";

const defaultJoinTokenSecret = "change-me-for-local-development";

const falseByDefaultBooleanStringSchema = z.preprocess((value) => {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean().default(false));

const integrationJwtCredentialSchema = z.object({
  integrationId: z.string().trim().min(1).max(128),
  issuer: z.string().trim().min(1).max(512),
  audience: z.string().trim().min(1).max(512),
  hs256Secret: z.string().min(32),
  recordingCallback: z.object({
    baseUrl: z.string().url(),
    hs256Secret: z.string().min(32),
  }).optional(),
});

const integrationJwtCredentialsSchema = z.preprocess((value) => {
  if (value === undefined || typeof value !== "string") return value;
  if (!value.trim()) return undefined;

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}, z.array(integrationJwtCredentialSchema).min(1).optional());

const apiConfigSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    AUTH_COOKIE_ENABLED: falseByDefaultBooleanStringSchema,
    INTEGRATION_API_ENABLED: falseByDefaultBooleanStringSchema,
    AUTH_LOGIN_URL: z.string().url().nullable().optional().default(null),
    AUTH_COOKIE_NAME: z.string().trim().min(1).default("conference_identity"),
    AUTH_COOKIE_JWT_ISSUER: z.string().trim().min(1).optional(),
    AUTH_COOKIE_JWT_AUDIENCE: z.string().trim().min(1).optional(),
    AUTH_COOKIE_JWT_HS256_SECRET: z.string().min(32).optional(),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    REDIS_URL: z.string().url().default("redis://localhost:6379"),
    WEB_PUBLIC_URL: z.string().url().default("http://localhost:5173"),
    MEDIA_NODE_ID: z.string().trim().min(1).default("local"),
    SIGNALING_PUBLIC_URL: z
      .string()
      .url()
      .refine((value) => ["ws:", "wss:"].includes(new URL(value).protocol), "must use ws or wss")
      .default("ws://localhost:4000/ws"),
    JOIN_TOKEN_SECRET: z.string().min(1).default(defaultJoinTokenSecret),
    ROOM_SESSION_TOKEN_SECRET: z.string().min(1).optional(),
    JOIN_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(300),
    INTEGRATION_JWT_CREDENTIALS_JSON: integrationJwtCredentialsSchema,
    INTEGRATION_JWT_MAX_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
    INTEGRATION_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
    INTEGRATION_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(60),
    RECORDING_DELIVERY_ENABLED: falseByDefaultBooleanStringSchema,
    DATABASE_URL: z.string().url().optional(),
    RECORDING_S3_ENDPOINT: z.string().url().optional(),
    RECORDING_S3_PUBLIC_ENDPOINT: z.string().url().optional(),
    RECORDING_S3_REGION: z.string().trim().min(1).optional(),
    RECORDING_S3_BUCKET: z.string().trim().min(3).max(63).optional(),
    RECORDING_S3_ACCESS_KEY_ID: z.string().trim().min(1).optional(),
    RECORDING_S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    RECORDING_S3_FORCE_PATH_STYLE: falseByDefaultBooleanStringSchema,
    RECORDING_S3_PRESIGN_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
    RECORDING_ARTIFACT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3_650).optional(),
    RECORDING_COMPOSITION_LEASE_SECONDS: z.coerce.number().int().min(30).max(3_600).default(300),
    RECORDING_CAPTURE_SERVICE_SECRET: z.string().min(32).optional(),
    RECORDING_COMPOSITION_SERVICE_SECRET: z.string().min(32).optional(),
    RECORDING_CONTROL_JWT_HS256_SECRET: z.string().min(32).optional(),
    RECORDING_BOT_ADMISSION_JWT_HS256_SECRET: z.string().min(32).optional(),
  })
  .superRefine((config, context) => {
    if (config.NODE_ENV === "production" && config.JOIN_TOKEN_SECRET === defaultJoinTokenSecret) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["JOIN_TOKEN_SECRET"],
        message: "must be explicitly configured outside the local-development default",
      });
    }

    const integrationCredentials = config.INTEGRATION_JWT_CREDENTIALS_JSON;
    if (integrationCredentials) {
      const integrationIds = new Set<string>();
      const signingSecrets = new Set<string>();
      for (const [index, credential] of integrationCredentials.entries()) {
        if (integrationIds.has(credential.integrationId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["INTEGRATION_JWT_CREDENTIALS_JSON", index, "integrationId"],
            message: "must be unique",
          });
        }
        integrationIds.add(credential.integrationId);

        if (signingSecrets.has(credential.hs256Secret)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["INTEGRATION_JWT_CREDENTIALS_JSON", index, "hs256Secret"],
            message: "must be unique per integration",
          });
        }
        signingSecrets.add(credential.hs256Secret);
      }
    }

    const trustedCookieFields = [
      ["AUTH_COOKIE_JWT_ISSUER", config.AUTH_COOKIE_JWT_ISSUER],
      ["AUTH_COOKIE_JWT_AUDIENCE", config.AUTH_COOKIE_JWT_AUDIENCE],
      ["AUTH_COOKIE_JWT_HS256_SECRET", config.AUTH_COOKIE_JWT_HS256_SECRET],
    ] as const;
    const hasAnyTrustedCookieJwtConfig = trustedCookieFields.some(([, value]) => value !== undefined);
    const hasAllTrustedCookieJwtConfig = trustedCookieFields.every(([, value]) => value !== undefined);

    if (hasAnyTrustedCookieJwtConfig && !hasAllTrustedCookieJwtConfig) {
      for (const [field, value] of trustedCookieFields) {
        if (value === undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: "is required when trusted cookie JWT validation is configured",
          });
        }
      }
    }

    if (config.AUTH_COOKIE_ENABLED && !hasAllTrustedCookieJwtConfig) {
      for (const [field, value] of trustedCookieFields) {
        if (value === undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: "is required when auth cookie support is enabled",
          });
        }
      }
    }

    if (config.INTEGRATION_API_ENABLED && !integrationCredentials) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["INTEGRATION_JWT_CREDENTIALS_JSON"],
        message: "is required when integration API is enabled",
      });
    }

    if (config.RECORDING_DELIVERY_ENABLED) {
      const required = [
        "DATABASE_URL",
        "RECORDING_S3_ENDPOINT",
        "RECORDING_S3_REGION",
        "RECORDING_S3_BUCKET",
        "RECORDING_S3_ACCESS_KEY_ID",
        "RECORDING_S3_SECRET_ACCESS_KEY",
        "RECORDING_ARTIFACT_RETENTION_DAYS",
        "RECORDING_CAPTURE_SERVICE_SECRET",
        "RECORDING_COMPOSITION_SERVICE_SECRET",
      ] as const;
      for (const field of required) {
        if (!config[field]) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: "is required when recording delivery is enabled",
          });
        }
      }
    }

  });

export type ApiConfig = z.infer<typeof apiConfigSchema>;

export function isIntegrationApiEnabled(
  config: Pick<ApiConfig, "INTEGRATION_API_ENABLED">
): boolean {
  return config.INTEGRATION_API_ENABLED;
}

export function hasCompleteTrustedCookieJwtConfig(
  config: Pick<ApiConfig, "AUTH_COOKIE_JWT_ISSUER" | "AUTH_COOKIE_JWT_AUDIENCE" | "AUTH_COOKIE_JWT_HS256_SECRET">
): boolean {
  return Boolean(config.AUTH_COOKIE_JWT_ISSUER && config.AUTH_COOKIE_JWT_AUDIENCE && config.AUTH_COOKIE_JWT_HS256_SECRET);
}

export function isAuthCookieEnabled(
  config: Pick<ApiConfig, "AUTH_COOKIE_ENABLED">
): boolean {
  return config.AUTH_COOKIE_ENABLED;
}

export function validateApiConfig(environment: NodeJS.ProcessEnv): ApiConfig {
  const parsed = apiConfigSchema.safeParse(environment);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "configuration"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid API configuration: ${details}`);
  }

  return parsed.data;
}
