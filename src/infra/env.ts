import { z } from 'zod'

const bigintList = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => BigInt(x))
    .filter((x) => x !== 0n)

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    BOT_TOKEN: z.string().min(10),
    DATABASE_URL: z.string().url(),
    SESSION_ENCRYPTION_KEY: z.string().length(64, 'must be 32 bytes hex (64 chars)'),
    ADMIN_TELEGRAM_IDS: z.string().transform(bigintList),
    SUPER_ADMIN_TELEGRAM_ID: z.string().transform(bigintList),
    ALERT_CHANNEL_ID: z.string(),
    AFFSTORE_POSTBACK_CHANNEL_ID: z.string().optional().transform((value) => {
      if (!value) return undefined
      return BigInt(value)
    }),
    // Random opaque secret required on every Affstore S2S postback
    // request. Passed by Affstore as ?secret=<value> on the webhook URL;
    // the handler constant-time-compares against this. Generate with
    // `openssl rand -hex 32`. Required in production; optional in dev
    // (the test setup never hits the real webhook handler).
    AFFSTORE_POSTBACK_SECRET: z.string().optional(),
    // Fractional values allowed (e.g. 0.5 = 30 min). Drives the inactivity-ping
    // schedule + threshold check.
    INACTIVITY_PING_HOURS: z.coerce.number().positive().default(0.5),
    PRO_DAILY_CHART_LIMIT: z.coerce.number().int().positive().default(5),
    // Emergency kill-switch for the nudge worker. Set NUDGES_PAUSED=1 in
    // Railway and redeploy (or just restart) to instantly stop all nudge
    // sends — useful when the outbound API queue is saturated and starving
    // /start replies. Schedules still re-arm so users resume after un-pausing.
    NUDGES_PAUSED: z
      .string()
      .optional()
      .transform((value) => value === '1' || value?.toLowerCase() === 'true'),
    // Quiet Telegram traffic is normal for this bot. Leave this off unless
    // you explicitly want the process to restart itself after prolonged
    // inactivity.
    POLL_WATCHDOG_EXIT_ON_QUIET: z
      .string()
      .optional()
      .transform((value) => value === '1' || value?.toLowerCase() === 'true'),
    LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    // Telegram update transport. polling = long-poll loop (fragile under
    // heavy concurrent load — see commit ed15309). webhook = Telegram
    // pushes updates to /<secret-path> on the existing :8080 server.
    // Default polling so local dev (no public HTTPS) works unchanged.
    BOT_TRANSPORT: z.enum(['polling', 'webhook']).default('polling'),
    // HTTPS hostname Telegram should call. If unset, falls back to
    // Railway's RAILWAY_PUBLIC_DOMAIN. No protocol or trailing slash —
    // just the bare host (e.g. noxatrading.up.railway.app).
    WEBHOOK_DOMAIN: z.string().optional(),
    // Random opaque value Telegram echoes in the
    // X-Telegram-Bot-Api-Secret-Token header on every webhook POST.
    // Combined with the unguessable hashed path (Telegraf's
    // secretPathComponent), prevents random Internet POSTs from being
    // accepted as updates. Generate with `openssl rand -hex 32`.
    WEBHOOK_SECRET_TOKEN: z.string().optional(),
    // Railway exposes the deploy's public domain via this env var. Used
    // as the fallback for WEBHOOK_DOMAIN so prod doesn't have to set
    // both — Railway already provides one.
    RAILWAY_PUBLIC_DOMAIN: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.BOT_TRANSPORT === 'webhook') {
      const domain = env.WEBHOOK_DOMAIN ?? env.RAILWAY_PUBLIC_DOMAIN
      if (!domain) {
        ctx.addIssue({
          code: 'custom',
          path: ['WEBHOOK_DOMAIN'],
          message:
            'BOT_TRANSPORT=webhook requires WEBHOOK_DOMAIN (or RAILWAY_PUBLIC_DOMAIN to be present)',
        })
      }
      if (!env.WEBHOOK_SECRET_TOKEN || env.WEBHOOK_SECRET_TOKEN.length < 16) {
        ctx.addIssue({
          code: 'custom',
          path: ['WEBHOOK_SECRET_TOKEN'],
          message:
            'BOT_TRANSPORT=webhook requires WEBHOOK_SECRET_TOKEN of at least 16 chars (use `openssl rand -hex 32`)',
        })
      }
    }
  })

export type Env = z.infer<typeof schema>
let cached: Env | null = null

export function loadEnv(): Env {
  if (cached) return cached
  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Invalid environment:\n${issues}`)
  }
  cached = parsed.data
  return cached
}

export function resetEnvCache() { cached = null }
