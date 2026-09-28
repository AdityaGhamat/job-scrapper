import dotenv from "dotenv";
import { z } from "zod";

// Load ingest-api/.env when present. Real environment variables take precedence.
dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
  INGEST_API_KEY: z.string().min(1, "INGEST_API_KEY is required"),
  MAX_INGEST_BATCH_SIZE: z.coerce.number().int().min(1).max(5000).default(500),
  MONGODB_SEARCH_MODE: z.enum(["atlas", "text", "auto"]).default("atlas"),
  MONGODB_SEARCH_INDEX_NAME: z.string().min(1).max(128).default("jobs_search"),
  JSON_BODY_LIMIT: z.string().min(1).max(32).default("2mb"),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return parsed.data;
}

export const config: AppConfig = loadConfig();
