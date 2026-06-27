import {
  CODEBOX_PUBLIC_RUNTIME_ABILITIES,
  RUNTIME_CONTRACT_NORMALIZERS,
  RUNTIME_CONTRACT_SCHEMAS,
} from "./runtime-contract-manifest.js"
import { TASK_INPUT_SCHEMA } from "./task-input.js"

/**
 * Discoverable map of Codebox-owned public contract primitives for external SDKs.
 * Values are stable Codebox schema/ability ids; backend handler bindings stay out
 * of this facade.
 */
export const CODEBOX_PUBLIC_CONTRACT_PRIMITIVES = {
  runtimeSession: {
    schemas: {
      access: RUNTIME_CONTRACT_SCHEMAS.runtimeBoundary.runtimeAccess,
      previewLease: RUNTIME_CONTRACT_SCHEMAS.runtimeBoundary.previewLease,
      previewReviewerAccess: RUNTIME_CONTRACT_SCHEMAS.preview.reviewerAccess,
      browserSessionProductDto: RUNTIME_CONTRACT_SCHEMAS.runtimeBoundary.browserSessionProductDto,
      browserPreviewBootConfig: RUNTIME_CONTRACT_SCHEMAS.runtimeBoundary.browserPreviewBootConfig,
      browserContainedSiteStatus: RUNTIME_CONTRACT_SCHEMAS.runtimeBoundary.browserContainedSiteStatus,
      browserContainedSiteOpen: RUNTIME_CONTRACT_SCHEMAS.runtimeBoundary.browserContainedSiteOpen,
    },
    normalizers: {
      runtimeAccess: RUNTIME_CONTRACT_NORMALIZERS.runtimeAccess,
      previewReviewerAccess: RUNTIME_CONTRACT_NORMALIZERS.previewReviewerAccess,
    },
  },
  runtimeProfile: {
    schemas: {
      profile: RUNTIME_CONTRACT_SCHEMAS.runtimeBoundary.profile,
    },
    normalizers: {
      runtimeProfile: RUNTIME_CONTRACT_NORMALIZERS.runtimeProfile,
    },
  },
  task: {
    abilities: {
      run: CODEBOX_PUBLIC_RUNTIME_ABILITIES.agentTask.run,
      batch: CODEBOX_PUBLIC_RUNTIME_ABILITIES.agentTask.batch,
      fanout: CODEBOX_PUBLIC_RUNTIME_ABILITIES.agentTask.fanout,
    },
    schemas: {
      input: TASK_INPUT_SCHEMA,
      runRequest: RUNTIME_CONTRACT_SCHEMAS.agentTask.runRequest,
      runResult: RUNTIME_CONTRACT_SCHEMAS.agentTask.runResult,
      headlessRequest: RUNTIME_CONTRACT_SCHEMAS.agentTask.headlessRequest,
      headlessResult: RUNTIME_CONTRACT_SCHEMAS.agentTask.headlessResult,
    },
    normalizers: {
      agentTaskRunResult: RUNTIME_CONTRACT_NORMALIZERS.agentTaskRunResult,
    },
  },
  agent: {
    abilities: {
      runTask: CODEBOX_PUBLIC_RUNTIME_ABILITIES.agentTask.run,
      runTaskBatch: CODEBOX_PUBLIC_RUNTIME_ABILITIES.agentTask.batch,
      runTaskFanout: CODEBOX_PUBLIC_RUNTIME_ABILITIES.agentTask.fanout,
    },
    schemas: {
      workload: RUNTIME_CONTRACT_SCHEMAS.taskState.agentRuntimeWorkload,
      runResult: RUNTIME_CONTRACT_SCHEMAS.taskState.agentTaskRunResult,
    },
  },
  artifact: {
    schemas: {
      resultEnvelope: RUNTIME_CONTRACT_SCHEMAS.artifact.resultEnvelope,
      typedArtifact: RUNTIME_CONTRACT_SCHEMAS.artifact.typedArtifact,
      typedArtifactIndex: RUNTIME_CONTRACT_SCHEMAS.artifact.typedArtifactIndex,
      bundleFileManifest: RUNTIME_CONTRACT_SCHEMAS.artifact.bundleFileManifest,
      browserArtifactPersistenceRef: RUNTIME_CONTRACT_SCHEMAS.artifact.browserArtifactPersistenceRef,
    },
    normalizers: {
      artifactResultEnvelope: RUNTIME_CONTRACT_NORMALIZERS.artifactResultEnvelope,
      typedArtifact: RUNTIME_CONTRACT_NORMALIZERS.typedArtifact,
      typedArtifactIndex: RUNTIME_CONTRACT_NORMALIZERS.typedArtifactIndex,
    },
  },
  credential: {
    schemas: {
      requirements: RUNTIME_CONTRACT_SCHEMAS.runtimeProvider.credentialRequirements,
      preflight: RUNTIME_CONTRACT_SCHEMAS.runtimeProvider.credentialPreflight,
      resolution: RUNTIME_CONTRACT_SCHEMAS.runtimeProvider.credentialResolution,
    },
    redacted: true,
  },
} as const

export type CodeboxPublicContractPrimitive = keyof typeof CODEBOX_PUBLIC_CONTRACT_PRIMITIVES
export type CodeboxPublicContractPrimitives = typeof CODEBOX_PUBLIC_CONTRACT_PRIMITIVES

export function codeboxPublicContractPrimitives(): CodeboxPublicContractPrimitives {
  return CODEBOX_PUBLIC_CONTRACT_PRIMITIVES
}

export function codeboxPublicContractPrimitive<TPrimitive extends CodeboxPublicContractPrimitive>(primitive: TPrimitive): CodeboxPublicContractPrimitives[TPrimitive] {
  return CODEBOX_PUBLIC_CONTRACT_PRIMITIVES[primitive]
}
