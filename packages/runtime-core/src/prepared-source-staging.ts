import { cpSync, mkdirSync, rmSync } from "node:fs"
import { basename, join, relative, resolve } from "node:path"

export interface PreparedSourceStage {
  source: string
  sourceRef: string
  originalSource: string
  root: string
  cleanupPaths: string[]
  provenance: PreparedSourceProvenance
}

export interface PreparedSourceProvenance {
  kind: "local"
  original: string
  localPathCategory?: "recipe-relative" | "temporary-download" | "temporary-composer-autoload" | "prepared-artifact"
}

export interface PrepareLocalSourceStageOptions {
  source: string
  sourceRef?: string
  targetRoot: string
  targetName?: string
  recipeDirectory?: string
  cleanupRoot?: boolean
  excludeNames?: string[]
}

export const DEFAULT_PREPARED_SOURCE_EXCLUDE_NAMES = [".git", "node_modules", "vendor"]

export function prepareLocalSourceStageSync(options: PrepareLocalSourceStageOptions): PreparedSourceStage {
  const source = resolve(options.source)
  const sourceRef = options.sourceRef ?? options.source
  const root = resolve(options.targetRoot)
  const target = join(root, options.targetName ?? basename(source))
  if (resolve(source) !== resolve(target)) {
    rmSync(target, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
    copyPreparedSourceFilteredSync(source, target, options.excludeNames)
  } else {
    mkdirSync(target, { recursive: true })
  }

  return {
    source: target,
    sourceRef,
    originalSource: source,
    root,
    cleanupPaths: options.cleanupRoot === false ? [] : [root],
    provenance: localPreparedSourceProvenance(sourceRef, options.recipeDirectory),
  }
}

export function copyPreparedSourceFilteredSync(source: string, target: string, excludeNames: string[] = DEFAULT_PREPARED_SOURCE_EXCLUDE_NAMES): void {
  const excluded = new Set(excludeNames)
  cpSync(source, target, {
    recursive: true,
    filter: (entry: string) => !excluded.has(basename(entry)),
  })
}

export function preparedSourceRoot(artifactsRoot: string, directoryName: string): string {
  return resolve(artifactsRoot, directoryName)
}

export function preparedSourcePath(artifactsRoot: string, directoryName: string, slug: string): string {
  return join(preparedSourceRoot(artifactsRoot, directoryName), slug)
}

export function localPreparedSourceProvenance(sourceRef: string, recipeDirectory?: string): PreparedSourceProvenance {
  const relativeSource = recipeDirectory ? relative(resolve(recipeDirectory), resolve(recipeDirectory, sourceRef)) : ""
  return {
    kind: "local",
    original: sourceRef,
    localPathCategory: recipeDirectory && (relativeSource === "" || !relativeSource.startsWith("..")) ? "recipe-relative" : undefined,
  }
}

export function collectPreparedSourceCleanupPaths(...groups: Array<Array<{ cleanupPaths: string[] }>>): string[] {
  return groups.flatMap((group) => group.flatMap((entry) => entry.cleanupPaths))
}
