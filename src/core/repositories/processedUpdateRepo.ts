import type { Pool } from 'pg'

export class ProcessedUpdateRepository {
  constructor(private pool: Pool) {}

  // Records a Telegram update_id as processed. Returns true if this is the
  // first time we've seen it (handler should run), false if it's a duplicate
  // delivery (handler should be skipped — a previous delivery already
  // claimed this update). ON CONFLICT DO NOTHING is the atomic dedupe
  // primitive: two concurrent inserts of the same update_id will see
  // exactly one rowCount=1 and one rowCount=0.
  async recordIfNew(updateId: number): Promise<boolean> {
    const result = await this.pool.query(
      'INSERT INTO processed_updates (update_id) VALUES ($1) ON CONFLICT (update_id) DO NOTHING',
      [updateId],
    )
    return (result.rowCount ?? 0) > 0
  }

  // Cleanup helper for the future periodic prune job. Deletes rows older
  // than the given cutoff. Returns the number of rows deleted so the caller
  // can log. Telegram's retry window is ~24h, so a cutoff of 48h gives
  // plenty of margin while keeping the table small.
  async pruneOlderThan(cutoff: Date): Promise<number> {
    const result = await this.pool.query(
      'DELETE FROM processed_updates WHERE processed_at < $1',
      [cutoff],
    )
    return result.rowCount ?? 0
  }
}
