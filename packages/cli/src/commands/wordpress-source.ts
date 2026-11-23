import { materializePlaygroundWordPressSource, WORDPRESS_SOURCE_SCHEMA, type PlaygroundWordPressSource, type PlaygroundWordPressSourceOptions } from "@automattic/wp-codebox-playground"

interface WordPressSourceCommandOptions {
  wp?: string
  json: boolean
}

type WordPressSourceMaterializer = (versionQuery: string | undefined, options: PlaygroundWordPressSourceOptions) => Promise<PlaygroundWordPressSource>

/**
 * `wp-codebox wordpress-source [--wp <version-query>] [--json]`
 *
 * Prints the host path of WordPress core source extracted from the validated
 * Playground archive cache. stdout carries only the result (root path, or one
 * JSON object with --json); diagnostics go to stderr. Failures always print a
 * one-line reason on stderr; with --json, stdout additionally carries one
 * `{ schema, error: { code, message, ... } }` object so callers can branch on
 * a stable code instead of parsing prose. Exit codes: 0 success, 1 the source
 * could not be materialized, 2 invalid arguments.
 */
export async function runWordPressSourceCommand(args: string[], materialize: WordPressSourceMaterializer = materializePlaygroundWordPressSource): Promise<number> {
  let options: WordPressSourceCommandOptions
  try {
    options = parseWordPressSourceOptions(args)
  } catch (error) {
    process.stderr.write(`wp-codebox wordpress-source: ${errorMessage(error)}\n`)
    if (args.includes("--json")) {
      writeJsonError({ code: "wordpress-source-invalid-arguments", message: errorMessage(error) })
    }
    return 2
  }

  let source: PlaygroundWordPressSource
  try {
    source = await materialize(options.wp, { log: (message) => process.stderr.write(`[wp-codebox] ${message}\n`) })
  } catch (error) {
    const message = `failed to materialize WordPress ${options.wp ?? "latest"} source: ${errorMessage(error)}`
    process.stderr.write(`wp-codebox wordpress-source: ${message}\n`)
    if (options.json) {
      writeJsonError({ ...wordPressSourceErrorDetails(error), message, requestedVersion: options.wp ?? "latest" })
    }
    return 1
  }

  const output = options.json
    ? JSON.stringify({ schema: source.schema, version: source.version, root: source.root, archive: source.archive, sourceUrl: source.sourceUrl })
    : source.root
  process.stdout.write(`${output}\n`)
  return 0
}

function parseWordPressSourceOptions(args: string[]): WordPressSourceCommandOptions {
  const options: WordPressSourceCommandOptions = { json: false }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--json") {
      options.json = true
      continue
    }
    if (arg === "--wp" || arg.startsWith("--wp=")) {
      const value = arg === "--wp" ? args[++index] : arg.slice("--wp=".length)
      if (!value || value.startsWith("--")) {
        throw new Error("--wp requires a version query such as 7.1.2 or latest")
      }
      options.wp = value === "latest" ? undefined : value
      continue
    }
    throw new Error(`Unknown option: ${arg}`)
  }
  return options
}

export type WordPressSourceErrorCode =
  | "wordpress-source-invalid-arguments"
  | "wordpress-source-invalid-version"
  | "wordpress-source-release-unresolved"
  | "wordpress-source-download-failed"
  | "wordpress-source-cache-locked"
  | "wordpress-source-materialization-failed"

interface WordPressSourceError {
  code: WordPressSourceErrorCode
  message: string
  requestedVersion?: string
  sourceUrl?: string
}

function writeJsonError(error: WordPressSourceError): void {
  process.stdout.write(`${JSON.stringify({ schema: WORDPRESS_SOURCE_SCHEMA, error })}\n`)
}

/** Maps a materializer failure to a stable error code (and the asset URL when known). */
function wordPressSourceErrorDetails(error: unknown): { code: WordPressSourceErrorCode; sourceUrl?: string } {
  const asset = error && typeof error === "object" && "asset" in error && typeof error.asset === "string" ? error.asset : undefined
  const sourceUrl = error && typeof error === "object" && "sourceUrl" in error && typeof error.sourceUrl === "string" ? error.sourceUrl : undefined
  if (asset === "wordpress-archive-cache") return { code: "wordpress-source-download-failed", sourceUrl }
  if (asset === "wordpress-release-metadata") return { code: "wordpress-source-release-unresolved", sourceUrl }
  if (asset === "wordpress-archive-cache-lock") return { code: "wordpress-source-cache-locked" }
  if (/requires a WordPress release version/.test(errorMessage(error))) return { code: "wordpress-source-invalid-version" }
  return { code: "wordpress-source-materialization-failed" }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
