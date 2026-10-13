/* eslint-disable no-console */
// Synthetic load test for the NOXATRADING Telegraf middleware + scene chain.
//
// Goals:
//   1. Inject N concurrent fake Telegram updates through the real bot
//      pipeline (createBot → middleware → scene routing → repo writes).
//   2. Measure per-update latency (p50/p95/p99/max), peak event-loop lag,
//      peak pg pool waitingCount.
//   3. Compare baselines before / after a hot-path change.
//
// Hard rule: every record this script creates is wiped at start AND end.
// Synthetic users use telegram_ids in the reserved range
// [SYNTHETIC_RANGE_START, SYNTHETIC_RANGE_END) so cleanup queries are
// unambiguous and can never collide with real users.
//
// Usage:
//   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/noxatrading_test \
//   npx tsx scripts/load-test.ts [--users 1000] [--label baseline|after]
//
// Run AGAINST A LOCAL/TEST POSTGRES ONLY. Never set TEST_DATABASE_URL to
// the production Railway URL — the cleanup phase deletes all rows in the
// synthetic range regardless of which DB you're pointed at.

import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import { Pool } from 'pg'

import { closePool, getPool } from '../src/infra/db.js'
import { createBot } from '../src/bot/index.js'
import { adminRepo } from '../src/core/repositories/index.js'

// Optional import — present only after FIX 2 lands. Resolved lazily so the
// same script runs against both pre-fix and post-fix code.
async function maybePrimeAdminCache(): Promise<void> {
  try {
    const mod = (await import('../src/bot/middleware/adminCache.js' as never)) as {
      ensureAdminCacheReady?: () => Promise<void>
    }
    if (typeof mod.ensureAdminCacheReady === 'function') {
      await mod.ensureAdminCacheReady()
    }
  } catch {
    // Module doesn't exist on the baseline branch — fine, skip.
  }
}

const SYNTHETIC_RANGE_START = 9_000_000_000n
const SYNTHETIC_RANGE_END = 9_000_001_000n

type Args = {
  users: number
  label: string
}

function parseArgs(): Args {
  const args = process.argv.slice(2)
  let users = 1000
  let label = 'unlabeled'
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--users' && args[i + 1]) {
      users = Number(args[i + 1])
      i += 1
    } else if (args[i] === '--label' && args[i + 1]) {
      label = String(args[i + 1])
      i += 1
    }
  }
  if (!Number.isFinite(users) || users <= 0) {
    throw new Error(`--users must be a positive number, got ${users}`)
  }
  return { users, label }
}

function ensureLocalDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
  if (!url) {
    throw new Error('Set TEST_DATABASE_URL (or DATABASE_URL) to a LOCAL Postgres before running')
  }
  // Defensive guard: refuse to run against anything that looks like the
  // Railway prod proxy. The cleanup phase deletes synthetic rows blindly;
  // a misconfigured run pointing at prod would still only delete IDs in
  // the reserved range, but better to fail loudly than rely on that.
  if (/rlwy\.net|railway\.app|railway\.internal/i.test(url)) {
    throw new Error(
      `Refusing to run load test against what looks like Railway (${url.replace(/:[^:@]*@/, ':***@')}). Use a local Postgres only.`,
    )
  }
  process.env.DATABASE_URL = url
  return url
}

// Cleanup helper: deletes every row in our synthetic telegram_id range
// across every table that references it. Wrapped in a single transaction
// so a half-cleanup never leaves orphan rows.
async function cleanupSyntheticRecords(reason: string): Promise<{
  users: number
  trades: number
  funnel: number
  tokenRequests: number
}> {
  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const funnel = await client.query(
      'DELETE FROM funnel_events WHERE user_telegram_id BETWEEN $1 AND $2',
      [SYNTHETIC_RANGE_START.toString(), (SYNTHETIC_RANGE_END - 1n).toString()],
    )
    const trades = await client.query(
      'DELETE FROM trades WHERE user_telegram_id BETWEEN $1 AND $2',
      [SYNTHETIC_RANGE_START.toString(), (SYNTHETIC_RANGE_END - 1n).toString()],
    )
    const tokenRequests = await client.query(
      'DELETE FROM token_requests WHERE user_telegram_id BETWEEN $1 AND $2',
      [SYNTHETIC_RANGE_START.toString(), (SYNTHETIC_RANGE_END - 1n).toString()],
    )
    const users = await client.query(
      'DELETE FROM users WHERE telegram_id BETWEEN $1 AND $2',
      [SYNTHETIC_RANGE_START.toString(), (SYNTHETIC_RANGE_END - 1n).toString()],
    )
    await client.query('COMMIT')
    console.log(
      `🧹 cleanup (${reason}): users=${users.rowCount} trades=${trades.rowCount} funnel=${funnel.rowCount} tokenReqs=${tokenRequests.rowCount}`,
    )
    return {
      users: users.rowCount ?? 0,
      trades: trades.rowCount ?? 0,
      funnel: funnel.rowCount ?? 0,
      tokenRequests: tokenRequests.rowCount ?? 0,
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function verifyNoSyntheticRows(): Promise<void> {
  const pool = getPool()
  const result = await pool.query<{ count: string }>(
    `SELECT (
       (SELECT count(*) FROM users          WHERE telegram_id      BETWEEN $1 AND $2)
     + (SELECT count(*) FROM trades         WHERE user_telegram_id BETWEEN $1 AND $2)
     + (SELECT count(*) FROM funnel_events  WHERE user_telegram_id BETWEEN $1 AND $2)
     + (SELECT count(*) FROM token_requests WHERE user_telegram_id BETWEEN $1 AND $2)
     )::text AS count`,
    [SYNTHETIC_RANGE_START.toString(), (SYNTHETIC_RANGE_END - 1n).toString()],
  )
  const remaining = Number(result.rows[0]!.count)
  if (remaining !== 0) {
    throw new Error(`cleanup verification failed: ${remaining} synthetic rows remain`)
  }
}

// Stub Telegraf's outbound API so synthetic updates don't 401 against the
// real BOT_TOKEN. We only need the methods middleware/scenes actually call,
// plus getMe (Telegraf calls it at the top of handleUpdate to identify
// the bot account).
const STUB_BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: 'LoadTestBot',
  username: 'loadtestbot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
}

type TelegramStub = {
  getMe: () => Promise<typeof STUB_BOT_INFO>
  sendMessage: (...args: unknown[]) => Promise<{ message_id: number }>
  sendPhoto: (...args: unknown[]) => Promise<{ message_id: number }>
  sendVideo: (...args: unknown[]) => Promise<{ message_id: number }>
  sendDocument: (...args: unknown[]) => Promise<{ message_id: number }>
  sendAnimation: (...args: unknown[]) => Promise<{ message_id: number }>
  sendChatAction: (...args: unknown[]) => Promise<true>
  editMessageText: (...args: unknown[]) => Promise<true>
  editMessageReplyMarkup: (...args: unknown[]) => Promise<true>
  editMessageCaption: (...args: unknown[]) => Promise<true>
  answerCbQuery: (...args: unknown[]) => Promise<true>
  deleteMessage: (...args: unknown[]) => Promise<true>
  callApi: (...args: unknown[]) => Promise<unknown>
}

function makeTelegramStub(): TelegramStub {
  return {
    getMe: async () => STUB_BOT_INFO,
    sendMessage: async () => ({ message_id: 1 }),
    sendPhoto: async () => ({ message_id: 1 }),
    sendVideo: async () => ({ message_id: 1 }),
    sendDocument: async () => ({ message_id: 1 }),
    sendAnimation: async () => ({ message_id: 1 }),
    sendChatAction: async () => true,
    editMessageText: async () => true,
    editMessageReplyMarkup: async () => true,
    editMessageCaption: async () => true,
    answerCbQuery: async () => true,
    deleteMessage: async () => true,
    callApi: async () => ({}),
  }
}

type SyntheticUpdate = ReturnType<typeof makeUpdate>

let messageIdCounter = 1_000_000

function makeUpdate(telegramId: bigint, kind: 'start' | 'callback' | 'text') {
  const updateId = Number(telegramId - SYNTHETIC_RANGE_START + BigInt(messageIdCounter++))
  const from = {
    id: Number(telegramId),
    is_bot: false,
    first_name: `User${telegramId}`,
    username: `loaduser_${telegramId}`,
    language_code: 'en',
  }
  const chat = {
    id: Number(telegramId),
    first_name: from.first_name,
    username: from.username,
    type: 'private' as const,
  }
  const date = Math.floor(Date.now() / 1000)

  if (kind === 'callback') {
    return {
      update_id: updateId,
      callback_query: {
        id: String(updateId),
        from,
        chat_instance: String(updateId),
        data: 'TIMEFRAME_1m',
        message: {
          message_id: updateId,
          date,
          chat,
          from,
          text: 'pick a timeframe',
        },
      },
    }
  }

  if (kind === 'text') {
    return {
      update_id: updateId,
      message: {
        message_id: updateId,
        date,
        chat,
        from,
        text: 'EUR/USD 88%',
      },
    }
  }

  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date,
      chat,
      from,
      text: '/start',
      entities: [{ type: 'bot_command', offset: 0, length: 6 }],
    },
  }
}

function buildUpdateMix(userCount: number): SyntheticUpdate[] {
  const updates: SyntheticUpdate[] = []
  for (let i = 0; i < userCount; i += 1) {
    const tid = SYNTHETIC_RANGE_START + BigInt(i)
    // Mix: 70% callback (the most common in scene-driven UX), 20% text
    // (amount entry, login email/password), 10% /start (cold entry).
    const kind = i < userCount * 0.7 ? 'callback' : i < userCount * 0.9 ? 'text' : 'start'
    updates.push(makeUpdate(tid, kind))
  }
  return updates
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))
  return sorted[idx]!
}

async function main() {
  const args = parseArgs()
  const url = ensureLocalDatabaseUrl()

  // Provide minimum env so loadEnv() doesn't blow up. Real values aren't
  // needed because we stub bot.telegram before any outbound API call.
  process.env.BOT_TOKEN = process.env.BOT_TOKEN ?? '0:loadtest'
  process.env.SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY ?? '0'.repeat(64)
  process.env.ADMIN_TELEGRAM_IDS = process.env.ADMIN_TELEGRAM_IDS ?? '1'
  process.env.SUPER_ADMIN_TELEGRAM_ID = process.env.SUPER_ADMIN_TELEGRAM_ID ?? '1'
  process.env.ALERT_CHANNEL_ID = process.env.ALERT_CHANNEL_ID ?? '0'
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent'
  process.env.NUDGES_PAUSED = '1'

  console.log(`▶ load test: ${args.users} users · label=${args.label}`)
  console.log(`  DB: ${url.replace(/:[^:@]*@/, ':***@')}`)

  // Pre-flight: clean any orphan synthetic rows from a previous aborted
  // run before measuring (so the workload starts on a clean slate).
  await cleanupSyntheticRecords('pre-run')

  // Seed a no-op admin record so admin cache primes successfully even
  // when the test DB has no admins. We use a synthetic admin ID outside
  // our user range so it doesn't interfere with the workload.
  await adminRepo.seedFromEnv()
  await maybePrimeAdminCache()

  const bot = createBot()
  // Replace the outbound Telegram client with a stub so synthetic updates
  // never hit the real Telegram API. Cast through unknown — Telegraf's
  // Telegram type is large and we only need the surface our handlers use.
  ;(bot as unknown as { telegram: TelegramStub }).telegram = makeTelegramStub()
  // Pre-seed botInfo so Telegraf doesn't try to fetch it (it normally calls
  // getMe on first handleUpdate; we have a stub for that too, but setting
  // botInfo here removes one async hop from the measurement).
  ;(bot as unknown as { botInfo: typeof STUB_BOT_INFO }).botInfo = STUB_BOT_INFO

  const updates = buildUpdateMix(args.users)

  // Sample pool waiting count every 100ms during the run.
  const pool = getPool() as unknown as Pool
  let peakWaiting = 0
  const waitingSampler = setInterval(() => {
    const w = (pool as unknown as { waitingCount: number }).waitingCount ?? 0
    if (w > peakWaiting) peakWaiting = w
  }, 100)
  waitingSampler.unref?.()

  // Histogram of event loop delay across the entire run.
  const eldHistogram = monitorEventLoopDelay({ resolution: 10 })
  eldHistogram.enable()

  const latencies: number[] = new Array(updates.length)
  const wallStart = performance.now()

  await Promise.all(
    updates.map(async (update, idx) => {
      const t0 = performance.now()
      try {
        // Telegraf's handleUpdate is the same entry point its long-poll
        // loop uses, so this is a faithful per-update measurement.
        await bot.handleUpdate(update as never)
      } catch (err) {
        console.error('handleUpdate failed', err)
      }
      latencies[idx] = performance.now() - t0
    }),
  )

  const wallMs = performance.now() - wallStart
  clearInterval(waitingSampler)
  eldHistogram.disable()

  latencies.sort((a, b) => a - b)
  const p50 = percentile(latencies, 50)
  const p95 = percentile(latencies, 95)
  const p99 = percentile(latencies, 99)
  const max = latencies.at(-1) ?? 0
  const meanMs =
    latencies.reduce((acc, value) => acc + value, 0) / Math.max(1, latencies.length)
  const throughputPerSec = (latencies.length / wallMs) * 1000

  // Histogram values are in nanoseconds.
  const eldP99Ms = eldHistogram.percentile(99) / 1e6
  const eldMaxMs = eldHistogram.max / 1e6

  console.log(`\n📊 results [${args.label}] ${args.users} updates`)
  console.log(`   latency  p50: ${p50.toFixed(2)}ms`)
  console.log(`   latency  p95: ${p95.toFixed(2)}ms`)
  console.log(`   latency  p99: ${p99.toFixed(2)}ms`)
  console.log(`   latency  max: ${max.toFixed(2)}ms`)
  console.log(`   latency mean: ${meanMs.toFixed(2)}ms`)
  console.log(`   total wall:   ${wallMs.toFixed(0)}ms (${throughputPerSec.toFixed(0)} updates/sec)`)
  console.log(`   pool peakWaiting: ${peakWaiting}`)
  console.log(`   event loop lag p99: ${eldP99Ms.toFixed(2)}ms · max: ${eldMaxMs.toFixed(2)}ms`)

  // Mandatory teardown — wipe everything we created. Verify zero rows.
  await cleanupSyntheticRecords('post-run')
  await verifyNoSyntheticRows()
  console.log('✅ cleanup verified: 0 synthetic rows remain')

  await closePool()
}

main().catch(async (err) => {
  console.error('load test failed:', err)
  // Best-effort cleanup even on failure so we don't leak synthetic rows.
  try {
    await cleanupSyntheticRecords('error-fallback')
    await verifyNoSyntheticRows()
  } catch (cleanupErr) {
    console.error('cleanup-on-failure also failed:', cleanupErr)
  }
  await closePool().catch(() => {})
  process.exit(1)
})
