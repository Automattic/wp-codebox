import type { WorkspaceRecipeMount } from "./runtime-contracts.js"

export interface NormalizeSharedMountsOptions {
  defaultMode?: WorkspaceRecipeMount["mode"]
  label?: string
}

export function normalizeSharedMounts(mounts: readonly WorkspaceRecipeMount[] = [], options: NormalizeSharedMountsOptions = {}): WorkspaceRecipeMount[] {
  return mounts.map((mount, index) => normalizeSharedMount(mount, index, options))
}

export function normalizeSharedMount(mount: WorkspaceRecipeMount, index = 0, options: NormalizeSharedMountsOptions = {}): WorkspaceRecipeMount {
  const label = options.label ?? "Shared mount"
  if (!mount.source || typeof mount.source !== "string") {
    throw new Error(`${label} ${index} requires source`)
  }

  const normalized: WorkspaceRecipeMount = {
    source: mount.source,
    target: normalizeRuntimeMountTarget(mount.target, `${label} ${index}`),
    mode: mount.mode ?? options.defaultMode ?? "readwrite",
  }
  if (mount.type !== undefined) {
    normalized.type = mount.type
  }
  if (mount.metadata !== undefined) {
    normalized.metadata = mount.metadata
  }

  return normalized
}

export function normalizeRuntimeMountTarget(target: string, label = "Shared mount"): string {
  if (!target || typeof target !== "string") {
    throw new Error(`${label} requires target`)
  }

  const normalized = target.trim().replace(/\\/g, "/").replace(/\/+/g, "/")
  if (!normalized.startsWith("/")) {
    throw new Error(`${label} requires an absolute target`)
  }

  const segments = normalized.split("/").filter(Boolean)
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`${label} target must not contain current-directory or parent-directory segments`)
  }

  return segments.length > 0 ? `/${segments.join("/")}` : "/"
}
