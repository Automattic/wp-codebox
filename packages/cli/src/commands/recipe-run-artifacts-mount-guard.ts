import { relative, resolve } from "node:path"
import type { WorkspaceRecipe } from "@automattic/wp-codebox-core"

export interface RecipeArtifactsMountConflict {
  artifactsDirectory: string
  mountSource: string
  mountPath: string
  mountKind: string
}

export class RecipeArtifactsMountConflictError extends Error {
  readonly code = "recipe-artifacts-mount-conflict"

  constructor(readonly conflict: RecipeArtifactsMountConflict) {
    super(`Recipe artifacts directory ${conflict.artifactsDirectory} is inside recipe mount source ${conflict.mountSource}. Choose an --artifacts directory outside mounted sources to avoid recursive artifact collection.`)
    this.name = "RecipeArtifactsMountConflictError"
  }
}

interface RecipeMountSourceCandidate {
  source: string
  path: string
  kind: string
}

export function recipeArtifactsMountConflict(recipe: WorkspaceRecipe, recipeDirectory: string, artifactsDirectory: string | undefined): RecipeArtifactsMountConflict | undefined {
  const resolvedArtifactsDirectory = resolve(artifactsDirectory ?? "artifacts")
  for (const candidate of recipeMountSourceCandidates(recipe)) {
    const mountSource = resolve(recipeDirectory, candidate.source)
    if (!pathContainsOrEquals(mountSource, resolvedArtifactsDirectory)) {
      continue
    }

    return {
      artifactsDirectory: resolvedArtifactsDirectory,
      mountSource,
      mountPath: candidate.path,
      mountKind: candidate.kind,
    }
  }

  return undefined
}

function recipeMountSourceCandidates(recipe: WorkspaceRecipe): RecipeMountSourceCandidate[] {
  const candidates: RecipeMountSourceCandidate[] = []

  for (const [index, mount] of (recipe.runtime?.stack?.mounts ?? []).entries()) {
    candidates.push({ source: mount.source, path: `$.runtime.stack.mounts[${index}].source`, kind: "runtime-stack-mount" })
  }

  for (const [index, mount] of (recipe.distribution?.sourceMounts ?? []).entries()) {
    candidates.push({ source: mount.source, path: `$.distribution.sourceMounts[${index}].source`, kind: "distribution-source-mount" })
  }

  for (const [index, mount] of (recipe.inputs?.mounts ?? []).entries()) {
    candidates.push({ source: mount.source, path: `$.inputs.mounts[${index}].source`, kind: "input-mount" })
  }

  for (const [index, workspace] of (recipe.inputs?.workspaces ?? []).entries()) {
    if (workspace.seed.type === "directory" && workspace.seed.source) {
      candidates.push({ source: workspace.seed.source, path: `$.inputs.workspaces[${index}].seed.source`, kind: "workspace-mount" })
    }
  }

  return candidates
}

function pathContainsOrEquals(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === "" || (!!path && !path.startsWith("..") && !path.startsWith("/"))
}
