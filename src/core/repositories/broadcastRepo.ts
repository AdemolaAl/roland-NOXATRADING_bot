import type { Pool } from 'pg'

export type BroadcastStatus = 'pending' | 'sending' | 'sent' | 'cancelled' | 'failed'
export type BroadcastMediaKind = 'photo' | 'video' | 'document' | 'animation'

export type BroadcastRow = {
  id: string
  created_by_admin_id: string
  segment: string
  recipient_count: number
  message_text: string
  media_kind: BroadcastMediaKind | null
  media_file_id: string | null
  scheduled_for: Date | null
  status: BroadcastStatus
  delivered_count: number
  failed_count: number
  created_at: Date
  sent_at: Date | null
}

export class BroadcastRepository {
  constructor(private readonly pool: Pool) {}

  async create(params: {
    createdByAdminId: bigint
    segment: string
    recipientCount: number
    messageText: string
    mediaKind?: BroadcastMediaKind | null
    mediaFileId?: string | null
    scheduledFor?: Date
  }): Promise<BroadcastRow> {
    const result = await this.pool.query<BroadcastRow>(
      `INSERT INTO broadcasts
         (created_by_admin_id, segment, recipient_count, message_text,
          media_kind, media_file_id, scheduled_for)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        params.createdByAdminId.toString(),
        params.segment,
        params.recipientCount,
        params.messageText,
        params.mediaKind ?? null,
        params.mediaFileId ?? null,
        params.scheduledFor ?? null,
      ],
    )
    return result.rows[0]!
  }

  async findById(id: string): Promise<BroadcastRow | null> {
    const result = await this.pool.query<BroadcastRow>('SELECT * FROM broadcasts WHERE id = $1', [id])
    return result.rows[0] ?? null
  }

  async markSending(id: string): Promise<void> {
    await this.pool.query("UPDATE broadcasts SET status = 'sending' WHERE id = $1", [id])
  }

  async markSent(id: string, deliveredCount: number, failedCount: number): Promise<void> {
    await this.pool.query(
      `UPDATE broadcasts
       SET status = 'sent', delivered_count = $2, failed_count = $3, sent_at = now()
       WHERE id = $1`,
      [id, deliveredCount, failedCount],
    )
  }

  async markCancelled(id: string): Promise<void> {
    await this.pool.query("UPDATE broadcasts SET status = 'cancelled' WHERE id = $1", [id])
  }

  async markFailed(id: string): Promise<void> {
    await this.pool.query("UPDATE broadcasts SET status = 'failed' WHERE id = $1", [id])
  }

  async listScheduledDue(asOf: Date): Promise<BroadcastRow[]> {
    const result = await this.pool.query<BroadcastRow>(
      `SELECT * FROM broadcasts
       WHERE status = 'pending' AND scheduled_for IS NOT NULL AND scheduled_for <= $1
       ORDER BY scheduled_for ASC`,
      [asOf],
    )
    return result.rows
  }
}
