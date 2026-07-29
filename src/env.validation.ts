import { z } from "zod";
import { COUNTRIES } from "./countries";

export const envSchema = z
  .object({
    PROVIDER: z.enum(["openai", "anthropic"]).default("openai"),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_MODEL: z.string().default("gpt-4o-mini"),
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_MODEL: z.string().default("claude-sonnet-5"),

  WP_URL: z.string().url("WP_URL must be a valid URL"),
  WP_USER: z.string().min(1, "WP_USER is required"),
  WP_APP_PASSWORD: z.string().min(1, "WP_APP_PASSWORD is required"),
  WP_POST_STATUS: z.enum(["draft", "publish"]).default("draft"),

    // Optional separate publisher account for the gospel pipeline. If either is
    // unset, gospel posts publish under WP_USER/WP_APP_PASSWORD like everything else.
    WP_USER_GOSPEL: z.string().optional(),
    WP_APP_PASSWORD_GOSPEL: z.string().optional(),

    // Optional separate publisher account for the Ghana pipeline. Same fallback rule.
    WP_USER_GHANA: z.string().optional(),
    WP_APP_PASSWORD_GHANA: z.string().optional(),

    // Optional separate publisher account for the Kenya pipeline. Same fallback rule.
    WP_USER_KENYA: z.string().optional(),
    WP_APP_PASSWORD_KENYA: z.string().optional(),

    SPOTIFY_CLIENT_ID: z.string().optional(),
    SPOTIFY_CLIENT_SECRET: z.string().optional(),
    // Which country's source site to pull from - see src/countries.ts
    COUNTRY: z.enum(Object.keys(COUNTRIES) as [string, ...string[]]).default("TZ"),
    // Overrides the country's default source site, if set
    SOURCE_URL: z.string().url().optional(),
    LOOKBACK_DAYS: z.coerce.number().int().min(0).default(7),
    // For backfill runs: skip posts from the last N days so this run doesn't
    // compete with production's live crons over the same recent posts.
    EXCLUDE_LAST_DAYS: z.coerce.number().int().min(0).default(0),
    MAX_PER_RUN: z.coerce.number().int().min(1).default(3),

    // How often (in days) each post's freshness byline is eligible to be
    // refreshed - e.g. 2.5 means roughly every ~2.5 days per post.
    FRESHNESS_REFRESH_INTERVAL_DAYS: z.coerce.number().positive().default(2.5),
    // Lowest post ID eligible for freshness refresh - see freshness.service.ts
    // for why this is ID-based, not date-based. Only lower this after
    // verifying live that posts at your intended ID boundary are genuinely
    // new content, not old contaminated posts (see comment in that file).
    FRESHNESS_MIN_POST_ID: z.coerce.number().int().min(0).default(615731),

    // Logging - Better Stack (Logtail) in production; pretty console in dev.
    // Leave LOGTAIL_* unset to log to console only.
    LOG_LEVEL: z.string().optional(),
    LOGTAIL_SOURCE_TOKEN: z.string().optional(),
    LOGTAIL_INGEST_HOST: z.string().optional(),
    LOGTAIL_LEVEL: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.PROVIDER === "openai" && !env.OPENAI_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["OPENAI_API_KEY"],
        message: "OPENAI_API_KEY is required when PROVIDER=openai",
      });
    }
    if (env.PROVIDER === "anthropic" && !env.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ANTHROPIC_API_KEY"],
        message: "ANTHROPIC_API_KEY is required when PROVIDER=anthropic",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
