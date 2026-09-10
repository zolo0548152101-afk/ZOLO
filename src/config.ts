import { z } from "zod";
import { canonicalPhone } from "./domain/policies.js";
const flag = z.enum(["true", "false"]).transform((v) => v === "true");
const schemas = z.enum([
  "haim_core",
  "haim_core_shadow",
  "haim_core_sim",
  "haim_core_test",
]);
const envSchema = z.object({
  NODE_ENV: z.enum(["production", "development", "test"]).default("production"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  BOT_MODE: z.enum(["shadow", "live", "simulation"]).default("shadow"),
  DB_SCHEMA: schemas.default("haim_core_shadow"),
  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().min(4).max(50).default(12),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_MODEL: z.string().default("gpt-5.6-luna"),
  OPENAI_PROMPT_ID: z
    .string()
    .default("pmpt_6a9d0c66737881938a0f60f5df9088cb0806a26699929a86"),
  OPENAI_PROMPT_VERSION: z.string().default("23"),
  OPENAI_REASONING_EFFORT: z.enum(["none", "low", "medium"]).default("low"),
  OPENAI_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(60000)
    .default(45000),
  AGENT_MAX_TURNS: z.coerce.number().int().min(1).max(10).default(4),
  AI_ENABLED: flag.default(true),
  OPENAI_TRACING: flag.default(false),
  WAHA_BASE_URL: z.url().default("http://whatsapp_waha:3000"),
  WAHA_API_KEY: z.string().default(""),
  WAHA_SESSION: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .default("HAIM_YAHAD"),
  WAHA_WEBHOOK_HMAC_KEY: z.string().min(32),
  HAIM_ADMIN_TOKEN: z.string().min(32),
  ADMIN_PHONE: z.string().default("584152101").transform(canonicalPhone),
  WAHA_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(10000),
  WAHA_MEDIA_ORIGINS: z.string().default(""),
  MEDIA_ROOT: z.string().startsWith("/").default("/data/haim-yahad-media"),
  MEDIA_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(52428800)
    .default(26214400),
  MEDIA_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(20000),
  IVRIT_API_TOKEN: z.string().default(""),
  IVRIT_URL: z
    .url()
    .default("https://misc-ten.vercel.app/transcribe_audio_assessors"),
  IVRIT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(120000)
    .default(45000),
  OPENAI_TRANSCRIBE_MODEL: z.string().default("gpt-4o-mini-transcribe"),
  TRANSPORT_CAPACITY: z.coerce.number().int().min(1).max(100).default(10),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  ENABLE_SIMULATE: flag.default(true),
  LIVE_ALLOWLIST: z.string().default(""),
  LIVE_DEPENDENCIES_VERIFIED: flag.default(false),
  MEDIA_VOLUME_CONFIRMED: flag.default(false),
});
export type Config = z.infer<typeof envSchema>;
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const c = envSchema.parse(env);
  if (c.BOT_MODE === "live" && c.DB_SCHEMA !== "haim_core")
    throw new Error("live_requires_haim_core");
  if (
    c.BOT_MODE === "shadow" &&
    c.DB_SCHEMA !== "haim_core_shadow" &&
    c.DB_SCHEMA !== "haim_core_test"
  )
    throw new Error("shadow_requires_separate_schema");
  if (
    c.BOT_MODE === "simulation" &&
    !["haim_core_sim", "haim_core_test"].includes(c.DB_SCHEMA)
  )
    throw new Error("simulation_requires_separate_schema");
  if (c.AI_ENABLED && !c.OPENAI_API_KEY)
    throw new Error("missing_openai_key_or_disable_ai");
  if (
    c.BOT_MODE === "live" &&
    (!c.WAHA_API_KEY ||
      !c.LIVE_DEPENDENCIES_VERIFIED ||
      !c.MEDIA_VOLUME_CONFIRMED)
  )
    throw new Error("live_gates_not_verified");
  return c;
}
