import { createRequire } from "node:module"
import { sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const packageRequire = createRequire(new URL("../package.json", import.meta.url))
const packageNodeModules = `${fileURLToPath(new URL("../node_modules", import.meta.url))}${sep}`
const packageVendor = `${fileURLToPath(new URL("../vendor", import.meta.url))}${sep}`

export async function resolve(specifier, context, nextResolve) {
  const packageOwned = specifier === "tsx" || specifier.startsWith("tsx/") || specifier.startsWith("@automattic/wp-codebox-core/") || specifier.startsWith("@php-wasm/") || specifier.startsWith("@wp-playground/")
  if (!packageOwned) return nextResolve(specifier, context)

  const resolved = packageRequire.resolve(specifier)
  if (!resolved.startsWith(packageNodeModules) && !resolved.startsWith(packageVendor)) throw new Error(`${specifier} resolved outside runtime-cloudflare package dependencies`)
  return nextResolve(pathToFileURL(resolved).href, context)
}
