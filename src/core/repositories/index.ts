import { Pool } from 'pg'
import { getPool } from '../../infra/db.js'
import { AdminRepository } from './adminRepo.js'
import { AuditLogRepository } from './auditRepo.js'
import { BroadcastRepository } from './broadcastRepo.js'
import { ClickAttributionRepository } from './clickAttributionRepo.js'
import { FunnelRepository } from './funnelRepo.js'
import { IqPostbackRepository } from './iqPostbackRepo.js'
import { ProcessedUpdateRepository } from './processedUpdateRepo.js'
import { SystemStateRepository } from './systemStateRepo.js'
import { TokenRequestRepository } from './tokenRequestRepo.js'
import { TokenRepository } from './tokenRepo.js'
import { TradeRepository } from './tradeRepo.js'
import { UserRepository } from './userRepo.js'

let pool: Pool | null = null

function repositoryPool(): Pool {
  if (!pool) {
    pool = getPool()
  }

  return pool
}

export const userRepo = new UserRepository(repositoryPool())
export const tradeRepo = new TradeRepository(repositoryPool())
export const tokenRepo = new TokenRepository(repositoryPool())
export const tokenRequestRepo = new TokenRequestRepository(repositoryPool())
export const adminRepo = new AdminRepository(repositoryPool())
export const auditRepo = new AuditLogRepository(repositoryPool())
export const broadcastRepo = new BroadcastRepository(repositoryPool())
export const systemStateRepo = new SystemStateRepository(repositoryPool())
export const funnelRepo = new FunnelRepository(repositoryPool())
export const clickAttributionRepo = new ClickAttributionRepository(repositoryPool())
export const iqPostbackRepo = new IqPostbackRepository(repositoryPool())
export const processedUpdateRepo = new ProcessedUpdateRepository(repositoryPool())
