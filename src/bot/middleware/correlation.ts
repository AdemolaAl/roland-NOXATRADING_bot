import { randomBytes } from 'node:crypto'
import type { Middleware } from 'telegraf'
import type { BotContext } from '../index.js'
import { getLogger, withCorrelation } from '../../infra/logger.js'

export const correlationMw: Middleware<BotContext> = async (ctx, next) => {
  const correlationId = randomBytes(8).toString('hex')
  ctx.session ??= {}
  ctx.session.correlationId = correlationId
  ctx.logger = withCorrelation(getLogger(), correlationId)
  await next()
}
