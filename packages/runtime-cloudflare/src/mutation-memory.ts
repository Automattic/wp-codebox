export const MUTATION_DIAGNOSTIC_SCHEMA = "wp-codebox/cloudflare-mutation-phase/v1"

export class MutationRetainedBytes {
  current = 0
  peak = 0

  retain(bytes: number): void {
    this.current += bytes
    this.peak = Math.max(this.peak, this.current)
  }

  release(bytes: number): void {
    this.current -= bytes
    if (this.current < 0) throw new Error("Mutation retained-byte accounting became negative.")
  }
}

export interface MutationRetentionShape {
  responseBytes: number
  markdownBytes: number
  uploadBytes: number
  wpContentBytes: number
  largestChangedFileBytes: number
}

export function mutationRetentionContract(shape: MutationRetentionShape): { wholeTreePeakBytes: number; incrementalPeakBytes: number } {
  for (const value of Object.values(shape)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Mutation retention shape contains invalid bytes.")
  }
  return {
    // The previous request retained the response, all three collections, and a hash copy of the active file.
    wholeTreePeakBytes: shape.responseBytes + shape.markdownBytes + shape.uploadBytes + shape.wpContentBytes + shape.largestChangedFileBytes,
    // Persistence owns one copied file; response conversion may briefly own both PHP and Fetch bodies.
    incrementalPeakBytes: Math.max(shape.responseBytes + shape.largestChangedFileBytes, 2 * shape.responseBytes),
  }
}

export function logMutationPhase(startedAt: number, phase: string, retained: MutationRetainedBytes, evidence: Record<string, number | string>): void {
  console.log(JSON.stringify({
    schema: MUTATION_DIAGNOSTIC_SCHEMA,
    phase,
    elapsedMs: Date.now() - startedAt,
    retainedBytes: retained.current,
    peakRetainedBytes: retained.peak,
    ...evidence,
  }))
}
