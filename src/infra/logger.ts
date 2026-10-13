import pino, { type Logger } from 'pino'
import pinoPretty from 'pino-pretty'
import { loadEnv } from './env.js'

export const redactedFields = [
  'iq_password',
  'iq_session_token',
  'sessionToken',
  'password',
  '*.iq_password',
  '*.password',
  '*.sessionToken',
  '*.iq_session_token',
  'authorization',
  'cookie',
  'BOT_TOKEN',
  'SESSION_ENCRYPTION_KEY',
]

type LoggerEnv = {
  LOG_LEVEL: 'silent' | 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'
  NODE_ENV: 'development' | 'test' | 'production'
}

function loadLoggerEnv(): LoggerEnv {
  try {
    return loadEnv()
  } catch {
    return {
      LOG_LEVEL: 'info',
      NODE_ENV: 'development',
    }
  }
}

export function createLogger(): Logger {
  const env = loadLoggerEnv()

  // pino-pretty as a direct stream — NOT via pino.transport(). The transport
  // option spawns a worker thread that silently fails to resolve pino-pretty
  // under tsx+ESM, which is why we used to ship raw JSON. Calling the
  // pino-pretty function directly returns a synchronous Transform stream
  // we can hand to pino, which works reliably under both tsx and the
  // compiled runtime. Output is one line per event so Railway shows each
  // entry as a single row, copy-paste captures the full payload, and the
  // export endpoint preserves every field.
  const stream = pinoPretty({
    colorize: false,
    translateTime: 'SYS:standard',
    ignore: 'pid,hostname,service',
    singleLine: true,
  })

  return pino(
    {
      level: env.LOG_LEVEL,
      redact: {
        paths: redactedFields,
        censor: '[REDACTED]',
      },
      base: {
        service: 'noxatrading-bot',
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    stream,
  )
}

export function withCorrelation(logger: Logger, correlationId: string): Logger {
  return logger.child({ correlationId })
}

let rootLogger: Logger | null = null

export function getLogger(): Logger {
  if (!rootLogger) {
    rootLogger = createLogger()
  }

  return rootLogger
}
