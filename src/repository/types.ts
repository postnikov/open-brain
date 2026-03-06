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
}

export interface UpdateThoughtInput {
  readonly content?: string
  readonly title?: string
  readonly tags?: readonly string[]
  readonly embedding?: readonly number[]
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

export interface ThoughtsRepository {
  readonly create: (input: CreateThoughtInput) => Promise<Thought>
  readonly search: (embedding: readonly number[], limit: number, minSimilarity: number, filters?: SearchFilters) => Promise<readonly SearchResult[]>
  readonly findRecent: (limit: number, filters?: SearchFilters) => Promise<readonly Thought[]>
  readonly findById: (id: string) => Promise<Thought | null>
  readonly getStats: () => Promise<ThoughtStats>
  readonly findRelated: (id: string, limit: number) => Promise<readonly SearchResult[]>
  readonly deleteById: (id: string) => Promise<boolean>
  readonly listTags: () => Promise<ReadonlyMap<string, number>>
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
}
