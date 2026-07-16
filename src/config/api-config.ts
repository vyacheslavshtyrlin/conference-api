import { z } from "zod";

const defaultJoinTokenSecret = "change-me-for-local-development";

const apiConfigSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
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
  })
  .superRefine((config, context) => {
    if (config.NODE_ENV === "production" && config.JOIN_TOKEN_SECRET === defaultJoinTokenSecret) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["JOIN_TOKEN_SECRET"],
        message: "must be explicitly configured outside the local-development default",
      });
    }
  });

export type ApiConfig = z.infer<typeof apiConfigSchema>;

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
