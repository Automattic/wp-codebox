import { materializePlaygroundWordPressSource, type PlaygroundWordPressSource, type PlaygroundWordPressSourceOptions } from "@automattic/wp-codebox-playground"

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
 * JSON object with --json); diagnostics and failures go to stderr.
 */
export async function runWordPressSourceCommand(args: string[], materialize: WordPressSourceMaterializer = materializePlaygroundWordPressSource): Promise<number> {
  let options: WordPressSourceCommandOptions
  try {
    options = parseWordPressSourceOptions(args)
  } catch (error) {
    process.stderr.write(`wp-codebox wordpress-source: ${errorMessage(error)}\n`)
    return 2
  }

  let source: PlaygroundWordPressSource
  try {
    source = await materialize(options.wp, { log: (message) => process.stderr.write(`[wp-codebox] ${message}\n`) })
  } catch (error) {
    process.stderr.write(`wp-codebox wordpress-source: failed to materialize WordPress ${options.wp ?? "latest"} source: ${errorMessage(error)}\n`)
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
