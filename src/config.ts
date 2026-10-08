import { z } from "zod";
import { canonicalPhone, DEFAULT_TRANSPORT_CAPACITY } from "./domain/policies.js";
import { validateAdminSecret } from "./application/security.js";
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
  // Dashboard owns the model. This is only a log/fallback label; requests
  // do not override the hosted prompt's model.
  OPENAI_MODEL: z.string().default("gpt-6-luna"),
  // Unified customer agent (tools + reply). Falls back to ACTION when empty.
  OPENAI_AGENT_PROMPT_ID: z.string().default(""),
  OPENAI_AGENT_PROMPT_VERSION: z.string().default(""),
  OPENAI_ACTION_PROMPT_ID: z.string().default(""),
  OPENAI_ACTION_PROMPT_VERSION: z.string().default(""),
  // Notices (counterparty) still use the reply hosted prompt.
  OPENAI_REPLY_PROMPT_ID: z.string().default(""),
  OPENAI_REPLY_PROMPT_VERSION: z.string().default(""),
  // Legacy eval harness only — never used at runtime.
  OPENAI_PROMPT_ID: z.string().default(""),
  OPENAI_PROMPT_VERSION: z.string().default(""),
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
  // The deployment owner may deliberately use a short local admin PIN.
  // It is still required and never returned by the service.
  HAIM_ADMIN_TOKEN: z.string().min(4),
  // When true, HAIM_ADMIN_TOKEN may be a short PIN (e.g. 2101) even in live.
  // Capability tokens still require long secrets when set.
  HAIM_ALLOW_SHORT_ADMIN_PIN: flag.default(false),
  // Optional distinct capabilities. Empty values fail closed and are never
  // accepted as credentials; callers cannot self-promote with a header.
  HAIM_ADMIN_READONLY_TOKEN: z.string().default(""),
  HAIM_ADMIN_DESTRUCTIVE_TOKEN: z.string().default(""),
  HAIM_ALLOW_ADMIN_CLEAR_ALL: flag.default(false),
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
  TRANSPORT_CAPACITY: z.coerce
    .number()
    .int()
    .min(1)
    .max(DEFAULT_TRANSPORT_CAPACITY)
    .default(DEFAULT_TRANSPORT_CAPACITY),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  ENABLE_SIMULATE: flag.default(true),
  // Keep SQL tables and admin replay, but do not enqueue integration work
  // from every live message event unless explicitly enabled.
  INTEGRATION_DISPATCH: flag.default(false),
  LIVE_ALLOWLIST: z.string().default(""),
  LIVE_DEPENDENCIES_VERIFIED: flag.default(false),
  MEDIA_VOLUME_CONFIRMED: flag.default(false),
  // Rolling quiet window: every new inbound from the same phone resets the
  // countdown; reply only after this much silence after the newest message.
  MESSAGE_COALESCE_QUIET_MS: z.coerce
    .number()
    .int()
    .min(50)
    .max(15000)
    .default(2800),
  // Cap so a never-ending burst cannot hold a worker forever; must stay well
  // above QUIET so each new message can still fully reset the countdown.
  MESSAGE_COALESCE_MAX_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(60000)
    .default(30000),
});
export type Config = z.infer<typeof envSchema>;
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const c = envSchema.parse(env);
  const adminCapabilityTokens = [
    c.HAIM_ADMIN_TOKEN,
    c.HAIM_ADMIN_READONLY_TOKEN,
    c.HAIM_ADMIN_DESTRUCTIVE_TOKEN,
  ].filter(Boolean);
  if (new Set(adminCapabilityTokens).size !== adminCapabilityTokens.length)
    throw new Error("admin_capability_credentials_must_be_distinct");
  if (c.NODE_ENV === "production" || c.BOT_MODE === "live") {
    if (!c.HAIM_ALLOW_SHORT_ADMIN_PIN && !validateAdminSecret(c.HAIM_ADMIN_TOKEN))
      throw new Error("admin_token_too_weak");
    if (c.HAIM_ADMIN_READONLY_TOKEN && !validateAdminSecret(c.HAIM_ADMIN_READONLY_TOKEN))
      throw new Error("admin_readonly_token_too_weak");
    if (c.HAIM_ADMIN_DESTRUCTIVE_TOKEN && !validateAdminSecret(c.HAIM_ADMIN_DESTRUCTIVE_TOKEN))
      throw new Error("admin_destructive_token_too_weak");
  }
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
  if (c.AI_ENABLED) {
    const agentId = c.OPENAI_AGENT_PROMPT_ID || c.OPENAI_ACTION_PROMPT_ID;
    const agentVersion =
      c.OPENAI_AGENT_PROMPT_VERSION || c.OPENAI_ACTION_PROMPT_VERSION;
    if (!agentId || !agentVersion)
      throw new Error("missing_hosted_agent_prompt");
    if (!c.OPENAI_REPLY_PROMPT_ID || !c.OPENAI_REPLY_PROMPT_VERSION)
      throw new Error("missing_hosted_reply_prompt");
  }
  if (
    c.BOT_MODE === "live" &&
    (!c.WAHA_API_KEY ||
      !c.LIVE_DEPENDENCIES_VERIFIED ||
      !c.MEDIA_VOLUME_CONFIRMED)
  )
    throw new Error("live_gates_not_verified");
  return c;
}
