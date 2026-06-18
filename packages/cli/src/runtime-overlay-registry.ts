import { delimiter } from "node:path"
import { discoverRuntimeOverlayDescriptorManifests, type RuntimeOverlayDescriptorManifestEntry, type WorkspaceRecipeRuntimeOverlay } from "@automattic/wp-codebox-core"
import type { PreparedRuntimeOverlay } from "./recipe-sources.js"

export interface RuntimeOverlayDescriptor {
  kind: string
  library: string
  strategy: string
  defaultTarget: string
  capabilities?: RuntimeOverlayDescriptorManifestEntry["capabilities"]
  metadata?: Record<string, unknown>
  prepare?: (overlay: WorkspaceRecipeRuntimeOverlay, recipeDirectory: string, index: number) => Promise<PreparedRuntimeOverlay>
}

const runtimeOverlayDescriptors = new Map<string, RuntimeOverlayDescriptor>()

export function registerRuntimeOverlayDescriptor(descriptor: RuntimeOverlayDescriptor): void {
  const key = runtimeOverlayDescriptorKey(descriptor)
  const existing = runtimeOverlayDescriptors.get(key)
  runtimeOverlayDescriptors.set(key, existing?.prepare && !descriptor.prepare ? { ...descriptor, prepare: existing.prepare } : descriptor)
}

export function registeredRuntimeOverlayDescriptors(): RuntimeOverlayDescriptor[] {
  return [...runtimeOverlayDescriptors.values()]
}

export function runtimeOverlayDescriptor(overlay: Pick<WorkspaceRecipeRuntimeOverlay, "kind" | "library" | "strategy">): RuntimeOverlayDescriptor | undefined {
  return runtimeOverlayDescriptors.get(runtimeOverlayDescriptorKey(overlay))
}

export function runtimeOverlayTarget(overlay: WorkspaceRecipeRuntimeOverlay): string {
  return overlay.target ?? runtimeOverlayDescriptor(overlay)?.defaultTarget ?? ""
}

export function loadConfiguredRuntimeOverlayDescriptors(rawPaths = process.env.WP_CODEBOX_RUNTIME_OVERLAY_DESCRIPTOR_PATHS): void {
  if (!rawPaths) return
  for (const discovered of discoverRuntimeOverlayDescriptorManifests({ directories: runtimeOverlayDescriptorPathList(rawPaths), packages: runtimeOverlayDescriptorPathList(rawPaths) })) {
    for (const descriptor of discovered.manifest.descriptors) {
      registerRuntimeOverlayDescriptor(descriptor)
    }
  }
}

function runtimeOverlayDescriptorKey(descriptor: Pick<RuntimeOverlayDescriptor, "kind" | "library" | "strategy">): string {
  return `${descriptor.kind}\u0000${descriptor.library}\u0000${descriptor.strategy}`
}

function runtimeOverlayDescriptorPathList(rawPaths: string): string[] {
  return rawPaths.split(delimiter).map((path) => path.trim()).filter(Boolean)
}
