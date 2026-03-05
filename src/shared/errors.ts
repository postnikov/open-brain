export class OpenBrainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'OpenBrainError'
  }
}

export class DatabaseError extends OpenBrainError {
  constructor(message: string, cause?: unknown) {
    super(message, 'DATABASE_ERROR', cause)
    this.name = 'DatabaseError'
  }
}

export class EmbeddingError extends OpenBrainError {
  constructor(message: string, cause?: unknown) {
    super(message, 'EMBEDDING_ERROR', cause)
    this.name = 'EmbeddingError'
  }
}

export class MetadataExtractionError extends OpenBrainError {
  constructor(message: string, cause?: unknown) {
    super(message, 'METADATA_EXTRACTION_ERROR', cause)
    this.name = 'MetadataExtractionError'
  }
}

export class StreamError extends OpenBrainError {
  constructor(message: string, cause?: unknown) {
    super(message, 'STREAM_ERROR', cause)
    this.name = 'StreamError'
  }
}
