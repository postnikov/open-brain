export interface Thought {
  readonly id: string
  readonly content: string
  readonly contentType: string
  readonly source: string
  readonly sourceRef: string | null
  readonly title: string | null
  readonly tags: readonly string[] | null
  readonly topics: readonly string[] | null
  readonly sentiment: string | null
  readonly weight: number
  readonly compostedAt: Date | null
  readonly epistemicStatus: string | null
  readonly createdAt: Date | null
  readonly thoughtAt: Date | null
  readonly updatedAt: Date | null
  readonly tier: MemoryTier
  readonly supersedes: string | null
  readonly supersededBy: string | null
  readonly supersededAt: Date | null
  readonly supersedeReason: string | null
  readonly validTo: Date | null
  readonly openCount: number
  readonly lastOpenedAt: Date | null
}

export type MemoryTier = 'hot' | 'pointer' | 'source'
export type MemoryStatus = 'active' | 'superseded' | 'expired'

/** Status derived from the supersede chain and validity end; only `active` is visible by default. */
export function memoryStatus(t: Pick<Thought, 'supersededBy' | 'validTo'>, now = new Date()): MemoryStatus {
  if (t.supersededBy) return 'superseded'
  if (t.validTo && t.validTo.getTime() <= now.getTime()) return 'expired'
  return 'active'
}

export interface CreateThoughtInput {
  readonly content: string
  readonly source: string
  readonly contentType?: string
  readonly sourceRef?: string
  readonly title?: string
  readonly tags?: readonly string[]
  readonly topics?: readonly string[]
  readonly sentiment?: string
  readonly embedding?: readonly number[]
  readonly thoughtAt?: Date
  readonly contentHash?: string
  readonly validTo?: Date
}

export interface SupersedeInput {
  readonly supersedes: string
  readonly reason?: string
}

/** Pointer for two-step recall: everything needed to choose, nothing of the text. */
export interface RecallPointer {
  readonly id: string
  readonly title: string | null
  readonly date: Date | null
  readonly contentType: string
  readonly tier: MemoryTier
  readonly source: string
  readonly sourceRef: string
  readonly status: MemoryStatus
  readonly score: number
}

/** In-place edits are metadata only: new text is a new version (createSuperseding). */
export interface UpdateThoughtInput {
  readonly title?: string
  readonly tags?: readonly string[]
  readonly weight?: number
  readonly epistemicStatus?: string | null
}

export interface SearchFilters {
  readonly source?: string
  readonly contentType?: string
  readonly tags?: readonly string[]
  readonly fromDate?: Date
  readonly toDate?: Date
  readonly epistemicStatus?: string
  /** Include superseded and expired thoughts (hidden by default). */
  readonly includeInactive?: boolean
}

export interface SearchResult {
  readonly thought: Thought
  readonly similarity: number
}

export interface ThoughtStats {
  readonly total: number
  readonly bySource: ReadonlyMap<string, number>
  readonly byType: ReadonlyMap<string, number>
  readonly last7Days: number
  readonly last30Days: number
}

export interface DuplicatePair {
  readonly thoughtA: Thought
  readonly thoughtB: Thought
  readonly similarity: number
}

export interface OrphanTag {
  readonly tag: string
  readonly thought: Thought
}

export interface ThoughtsRepository {
  readonly create: (input: CreateThoughtInput) => Promise<Thought>
  readonly search: (embedding: readonly number[], limit: number, minSimilarity: number, filters?: SearchFilters) => Promise<readonly SearchResult[]>
  readonly findRecent: (limit: number, filters?: SearchFilters) => Promise<readonly Thought[]>
  readonly findById: (id: string) => Promise<Thought | null>
  readonly getStats: () => Promise<ThoughtStats>
  readonly findRelated: (id: string, limit: number) => Promise<readonly SearchResult[]>
  readonly deleteById: (id: string) => Promise<boolean>
  readonly listTags: () => Promise<ReadonlyMap<string, number>>
  readonly findOrphanTags: () => Promise<readonly OrphanTag[]>
  readonly renameTag: (oldTag: string, newTag: string) => Promise<number>
  readonly update: (id: string, input: UpdateThoughtInput) => Promise<Thought | null>
  readonly removeTagFromThought: (thoughtId: string, tag: string) => Promise<boolean>
  readonly findByTag: (tag: string) => Promise<readonly Thought[]>
  readonly compost: (id: string) => Promise<Thought | null>
  readonly uncompost: (id: string) => Promise<Thought | null>
  readonly findComposted: () => Promise<readonly Thought[]>
  readonly cleanupCompost: (days: number) => Promise<number>
  readonly findByEpistemicStatus: (status: string, limit: number) => Promise<readonly Thought[]>
  readonly findForReview: (daysAgo: number, limit: number) => Promise<readonly Thought[]>
  readonly searchTimeline: (embedding: readonly number[], limit: number, minSimilarity: number) => Promise<readonly SearchResult[]>
  readonly addTagToThoughts: (ids: readonly string[], tag: string) => Promise<number>
  readonly findDuplicates: (minSimilarity: number, limit: number) => Promise<readonly DuplicatePair[]>
  readonly mergeThoughts: (keepId: string, removeId: string) => Promise<Thought | null>
  readonly dismissPair: (idA: string, idB: string) => Promise<void>
  /** Insert a new thought and mark `supersedes` as replaced by it, atomically. */
  readonly createSuperseding: (input: CreateThoughtInput, supersede: SupersedeInput) => Promise<Thought>
  /** Undo a replacement mark; the newer thought keeps its `supersedes` provenance. */
  readonly unsupersede: (id: string) => Promise<Thought | null>
  readonly recall: (embedding: readonly number[], limit: number, minSimilarity: number, hotBoost: number, includeInactive?: boolean) => Promise<readonly RecallPointer[]>
  /** Full text for chosen ids; counts the open (drives the hot tier). */
  readonly open: (ids: readonly string[]) => Promise<readonly Thought[]>
  readonly refreshTiers: (policy: TierPolicy) => Promise<TierRefresh>
}

export interface TierPolicy {
  readonly hotMinOpens: number
  readonly hotWindowDays: number
  readonly coolAfterDays: number
}

export interface TierRefresh {
  readonly promoted: number
  readonly demoted: number
  readonly candidatesTagged: number
}
