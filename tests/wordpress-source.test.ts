import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { collectBytes, encodeZip } from "@php-wasm/stream-compression"

import { runWordPressSourceCommand } from "../packages/cli/src/commands/wordpress-source.js"
import { materializePlaygroundWordPressSource, verifiedWordPressRootError, WORDPRESS_SOURCE_SCHEMA } from "../packages/runtime-playground/src/playground-wordpress-source.js"

const TAG_PROCESSOR = "wp-includes/html-api/class-wp-html-tag-processor.php"

async function wordpressZip(declaredVersion: string | undefined, options: { prefix?: string; extra?: Record<string, string> } = {}): Promise<Uint8Array> {
  const prefix = options.prefix ?? "wordpress/"
  const files: File[] = [
    new File(["<?php\n// WordPress test fixture\n"], `${prefix}index.php`),
    new File(["<?php\nclass WP_HTML_Tag_Processor {}\n"], `${prefix}${TAG_PROCESSOR}`),
  ]
  if (declaredVersion !== undefined) {
    files.push(new File([`<?php\n/**\n * The WordPress version string.\n */\n$wp_version = '${declaredVersion}';\n\n$wp_db_version = 60000;\n`], `${prefix}wp-includes/version.php`))
  }
  for (const [name, contents] of Object.entries(options.extra ?? {})) {
    files.push(new File([contents], name))
  }
  return collectBytes(encodeZip(files))
}

async function seedArchive(cacheDirectory: string, version: string, archive: Uint8Array): Promise<void> {
  await mkdir(cacheDirectory, { recursive: true })
  await writeFile(join(cacheDirectory, `${version}.zip`), archive)
}

async function stagingLeftovers(cacheDirectory: string): Promise<string[]> {
  const sourceDirectory = join(cacheDirectory, "source")
  if (!existsSync(sourceDirectory)) return []
  return (await readdir(sourceDirectory)).filter((name) => name.startsWith("."))
}

async function captureStdout(run: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = ""
  let stderr = ""
  const writeStdout = process.stdout.write.bind(process.stdout)
  const writeStderr = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout += String(chunk); return true }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true }) as typeof process.stderr.write
  try {
    return { code: await run(), stdout, stderr }
  } finally {
    process.stdout.write = writeStdout
    process.stderr.write = writeStderr
  }
}

const cacheDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-wordpress-source-"))
const originalFetch = globalThis.fetch

try {
  // Cache hit: the validated archive is extracted to <cache>/source/<version>/wordpress.
  await seedArchive(cacheDirectory, "9.9.1", await wordpressZip("9.9.1"))
  const source = await materializePlaygroundWordPressSource("9.9.1", { cacheDirectory })
  assert.deepEqual(source, {
    schema: WORDPRESS_SOURCE_SCHEMA,
    version: "9.9.1",
    root: join(cacheDirectory, "source", "9.9.1", "wordpress"),
    archive: join(cacheDirectory, "9.9.1.zip"),
    sourceUrl: "https://wordpress.org/wordpress-9.9.1.zip",
  })
  assert.ok(existsSync(join(source.root, TAG_PROCESSOR)), "html-api sources must be materialized")
  assert.equal(await verifiedWordPressRootError(source.root, "9.9.1"), undefined)
  assert.match(await verifiedWordPressRootError(source.root, "9.9.0") ?? "", /declares \$wp_version '9\.9\.1', expected '9\.9\.0'/)
  assert.deepEqual(await stagingLeftovers(cacheDirectory), [])

  // Reuse: a verified tree is returned as-is, without re-extraction.
  const marker = join(source.root, "reuse-marker.txt")
  await writeFile(marker, "kept")
  const logs: string[] = []
  const reused = await materializePlaygroundWordPressSource("9.9.1", { cacheDirectory, log: (message) => logs.push(message) })
  assert.equal(reused.root, source.root)
  assert.equal(await readFile(marker, "utf8"), "kept")
  assert.ok(logs.some((message) => message.startsWith("Reusing WordPress 9.9.1 source")))

  // Archives without a single top-level directory are accepted too.
  await seedArchive(cacheDirectory, "9.9.8", await wordpressZip("9.9.8", { prefix: "" }))
  const flat = await materializePlaygroundWordPressSource("9.9.8", { cacheDirectory })
  assert.ok(existsSync(join(flat.root, TAG_PROCESSOR)))

  // Atomicity: a version mismatch leaves no final directory and no staging leftovers.
  await seedArchive(cacheDirectory, "9.9.2", await wordpressZip("9.9.3"))
  await assert.rejects(() => materializePlaygroundWordPressSource("9.9.2", { cacheDirectory }), /declares \$wp_version '9\.9\.3', expected '9\.9\.2'/)
  assert.equal(existsSync(join(cacheDirectory, "source", "9.9.2")), false)
  assert.deepEqual(await stagingLeftovers(cacheDirectory), [])

  // Missing version.php is rejected the same way.
  await seedArchive(cacheDirectory, "9.9.4", await wordpressZip(undefined))
  await assert.rejects(() => materializePlaygroundWordPressSource("9.9.4", { cacheDirectory }), /does not contain wp-includes\/version\.php/)
  assert.equal(existsSync(join(cacheDirectory, "source", "9.9.4")), false)

  // Path traversal entries are refused before anything escapes the staging directory.
  await seedArchive(cacheDirectory, "9.9.9", await wordpressZip("9.9.9", { extra: { "wordpress/../../escaped.php": "<?php" } }))
  await assert.rejects(() => materializePlaygroundWordPressSource("9.9.9", { cacheDirectory }), /unsafe entry path/)
  assert.equal(existsSync(join(cacheDirectory, "escaped.php")), false)
  assert.equal(existsSync(join(cacheDirectory, "source", "9.9.9")), false)
  assert.deepEqual(await stagingLeftovers(cacheDirectory), [])

  // Concurrent callers converge on one complete tree.
  await seedArchive(cacheDirectory, "9.9.5", await wordpressZip("9.9.5"))
  const concurrent = await Promise.all(Array.from({ length: 4 }, () => materializePlaygroundWordPressSource("9.9.5", { cacheDirectory })))
  assert.deepEqual(new Set(concurrent.map((entry) => entry.root)), new Set([join(cacheDirectory, "source", "9.9.5", "wordpress")]))
  assert.equal(await verifiedWordPressRootError(concurrent[0].root, "9.9.5"), undefined)
  assert.deepEqual(await stagingLeftovers(cacheDirectory), [])

  // An unverifiable final tree is replaced by a verified one.
  const staleRoot = join(cacheDirectory, "source", "9.9.6", "wordpress")
  await mkdir(join(staleRoot, "wp-includes"), { recursive: true })
  await writeFile(join(staleRoot, "wp-includes", "version.php"), "<?php\n$wp_version = '1.0';\n")
  await seedArchive(cacheDirectory, "9.9.6", await wordpressZip("9.9.6"))
  const replaced = await materializePlaygroundWordPressSource("9.9.6", { cacheDirectory })
  assert.equal(await verifiedWordPressRootError(replaced.root, "9.9.6"), undefined)
  assert.ok(existsSync(join(replaced.root, TAG_PROCESSOR)))
  assert.deepEqual(await stagingLeftovers(cacheDirectory), [])

  // Cache miss downloads through the existing archive cache downloader.
  const downloadArchive = await wordpressZip("9.9.7")
  const requested: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    requested.push(String(input))
    return new Response(downloadArchive, { status: 200 })
  }) as typeof fetch
  const downloaded = await materializePlaygroundWordPressSource("9.9.7", { cacheDirectory })
  assert.deepEqual(requested, ["https://wordpress.org/wordpress-9.9.7.zip"])
  assert.equal(downloaded.archive, join(cacheDirectory, "9.9.7.zip"))
  assert.ok(existsSync(downloaded.archive))
  assert.ok(existsSync(join(downloaded.root, TAG_PROCESSOR)))

  // Offline: a failed download leaves no archive and no source tree.
  globalThis.fetch = (async () => { throw new TypeError("fetch failed") }) as typeof fetch
  await assert.rejects(() => materializePlaygroundWordPressSource("9.9.10", { cacheDirectory }), /wordpress-archive-cache.*fetch failed/)
  assert.equal(existsSync(join(cacheDirectory, "9.9.10.zip")), false)
  assert.equal(existsSync(join(cacheDirectory, "source", "9.9.10")), false)

  // Invalid archive bytes are rejected by the existing validator.
  globalThis.fetch = (async () => new Response("not a zip", { status: 200 })) as typeof fetch
  await assert.rejects(() => materializePlaygroundWordPressSource("9.9.11", { cacheDirectory }), /invalid/)
  assert.equal(existsSync(join(cacheDirectory, "source", "9.9.11")), false)
  globalThis.fetch = originalFetch

  await assert.rejects(() => materializePlaygroundWordPressSource("trunk", { cacheDirectory }), /requires a WordPress release version/)

  // CLI: --json prints exactly one wp-codebox/wordpress-source/v1 object on stdout.
  const materialize: typeof materializePlaygroundWordPressSource = (versionQuery, options) => materializePlaygroundWordPressSource(versionQuery, { ...options, cacheDirectory })
  const json = await captureStdout(() => runWordPressSourceCommand(["--wp", "9.9.1", "--json"], materialize))
  assert.equal(json.code, 0)
  assert.equal(json.stdout.trim().split("\n").length, 1, "stdout must contain exactly one JSON line")
  const parsed = JSON.parse(json.stdout)
  assert.deepEqual(Object.keys(parsed), ["schema", "version", "root", "archive", "sourceUrl"])
  assert.deepEqual(parsed, source)
  assert.match(json.stderr, /Reusing WordPress 9\.9\.1 source/)

  const plain = await captureStdout(() => runWordPressSourceCommand(["--wp=9.9.1"], materialize))
  assert.equal(plain.code, 0)
  assert.equal(plain.stdout, `${source.root}\n`)

  const failed = await captureStdout(() => runWordPressSourceCommand(["--wp", "9.9.2", "--json"], materialize))
  assert.equal(failed.code, 1)
  assert.equal(failed.stdout, "")
  assert.match(failed.stderr, /failed to materialize WordPress 9\.9\.2 source/)

  const usage = await captureStdout(() => runWordPressSourceCommand(["--bogus"], materialize))
  assert.equal(usage.code, 2)
  assert.equal(usage.stdout, "")
  assert.match(usage.stderr, /Unknown option: --bogus/)

  const missingValue = await captureStdout(() => runWordPressSourceCommand(["--wp", "--json"], materialize))
  assert.equal(missingValue.code, 2)
  assert.match(missingValue.stderr, /--wp requires a version query/)

  console.log("wordpress-source passed")
} finally {
  globalThis.fetch = originalFetch
  await rm(cacheDirectory, { recursive: true, force: true })
}
