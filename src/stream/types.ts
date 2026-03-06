export interface StreamBlock {
  readonly id: string
  readonly sessionId: string
  readonly blockNumber: number
  readonly topic: string | null
  readonly content: string
  readonly participants: readonly string[] | null
  readonly sourceClient: string | null
  readonly pinned: boolean
  readonly distilledAt: Date | null
  readonly distillationRunId: string | null
  readonly createdAt: Date | null
  readonly expiresAt: Date | null
}

export interface CreateStreamBlockInput {
  readonly sessionId: string
  readonly blockNumber: number
  readonly topic?: string
  readonly content: string
  readonly participants?: readonly string[]
  readonly sourceClient?: string
}

export interface StreamFilters {
  readonly sessionId?: string
  readonly status?: 'pending' | 'distilled' | 'pinned'
  readonly search?: string
  readonly fromDate?: Date
  readonly toDate?: Date
}

export interface StreamSessionSummary {
  readonly sessionId: string
  readonly blockCount: number
  readonly firstBlock: Date | null
  readonly lastBlock: Date | null
  readonly topic: string | null
  readonly sourceClient: string | null
}

export interface StreamStats {
  readonly totalBlocks: number
  readonly totalSessions: number
  readonly pendingBlocks: number
  readonly distilledBlocks: number
  readonly pinnedBlocks: number
}

export interface StreamRepository {
  readonly write: (input: CreateStreamBlockInput, ttlDays: number) => Promise<StreamBlock>
  readonly findBySession: (sessionId: string, limit: number) => Promise<readonly StreamBlock[]>
  readonly findRecent: (limit: number, filters?: StreamFilters) => Promise<readonly StreamBlock[]>
  readonly listSessions: (limit: number) => Promise<readonly StreamSessionSummary[]>
  readonly findPendingForDistillation: (limit: number) => Promise<readonly StreamBlock[]>
  readonly findExpiringBlocks: (days: number) => Promise<readonly StreamBlock[]>
  readonly markDistilled: (ids: readonly string[], runId: string) => Promise<number>
  readonly cleanupExpired: () => Promise<number>
  readonly getStats: () => Promise<StreamStats>
  readonly pin: (id: string) => Promise<StreamBlock | null>
  readonly unpin: (id: string) => Promise<StreamBlock | null>
  readonly deleteById: (id: string) => Promise<boolean>
}
