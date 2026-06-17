import type { ArtifactFileDigest, ArtifactRedactionMetadata } from "./artifact-manifest.js"

export const TOOL_CALL_TRANSCRIPT_SCHEMA = "wp-codebox/tool-call-transcript/v1" as const

export type ToolCallArtifactPhase = "planning" | "execution" | "verification" | "finalization" | (string & {})
export type ToolCallArtifactStatus = "started" | "succeeded" | "failed" | "cancelled" | "timed_out" | "skipped" | (string & {})

export interface ToolCallArtifactRef {
  path: string
  kind?: string
  contentType?: string
  sha256?: ArtifactFileDigest
}

export interface ToolCallArtifactDigestRef {
  algorithm: "sha256"
  value: string
}

export interface ToolCallArtifactRecord {
  call_id: string
  tool_name: string
  tool_type: string
  phase: ToolCallArtifactPhase
  status: ToolCallArtifactStatus
  started_at?: string
  finished_at?: string
  input_artifacts?: ToolCallArtifactRef[]
  output_artifacts?: ToolCallArtifactRef[]
  input_digest?: ToolCallArtifactDigestRef
  output_digest?: ToolCallArtifactDigestRef
  redaction: ArtifactRedactionMetadata
  metadata?: Record<string, unknown>
}

export interface ToolCallTranscriptArtifact {
  schema: typeof TOOL_CALL_TRANSCRIPT_SCHEMA
  tool_calls: ToolCallArtifactRecord[]
  redaction: ArtifactRedactionMetadata
  metadata?: Record<string, unknown>
}
