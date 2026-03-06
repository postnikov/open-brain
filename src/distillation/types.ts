export type DistillationContentType = 'decision' | 'insight' | 'question' | 'formulation' | 'contradiction'

export interface ExtractedThought {
  readonly content: string
  readonly contentType: DistillationContentType
  readonly tags?: readonly string[]
}

export interface DistillationResult {
  readonly thoughts: readonly ExtractedThought[]
  readonly skippedBlocks: readonly string[]
  readonly tokensUsed: number
  readonly estimatedCost: number
}

export interface DistillationRunResult {
  readonly runId: string
  readonly trigger: string
  readonly status: 'success' | 'partial' | 'error'
  readonly blocksProcessed: number
  readonly sessionsProcessed: number
  readonly thoughtsCreated: number
  readonly thoughtIds: readonly string[]
  readonly blocksSkipped: number
  readonly skipReasons: string
  readonly tokensUsed: number
  readonly estimatedCost: number
  readonly durationMs: number
  readonly errorMessage?: string
}

export interface DistillationLogEntry {
  readonly id: string
  readonly trigger: string
  readonly status: string
  readonly blocksProcessed: number
  readonly sessionsProcessed: number
  readonly thoughtsCreated: number
  readonly thoughtIds: readonly string[] | null
  readonly blocksSkipped: number
  readonly skipReasons: string | null
  readonly tokensUsed: number
  readonly estimatedCost: number
  readonly durationMs: number
  readonly errorMessage: string | null
  readonly createdAt: Date | null
}

export interface DistillationService {
  readonly run: (trigger: string) => Promise<DistillationRunResult>
  readonly isRunning: () => boolean
}

export interface DistillationRepository {
  readonly logRun: (result: DistillationRunResult) => Promise<string>
  readonly getRecentRuns: (limit: number) => Promise<readonly DistillationLogEntry[]>
  readonly getRunById: (id: string) => Promise<DistillationLogEntry | null>
}
