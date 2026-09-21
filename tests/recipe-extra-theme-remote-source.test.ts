import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import https from "node:https"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { ALLOWED_DOWNLOAD_HOSTS_ENV, ALLOW_NETWORK_DOWNLOADS_ENV, prepareExtraThemes } from "../packages/cli/src/recipe-sources.js"
import { withTempDir } from "../scripts/test-kit.js"

const execFileAsync = promisify(execFile)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const tsxBin = join(repoRoot, "node_modules/.bin/tsx")
const workerScript = join(repoRoot, "tests/fixtures/prepare-extra-theme-worker.ts")

interface WorkerTheme {
  slug: string
  themeName: string
  template: string | null
  activate: boolean
  target: string
  provenance: { kind: string; resolvedUrl?: string; digest?: { sha256: string; expected?: string; verified?: boolean } }
}

async function runWorker(themes: unknown[], recipeDirectory: string, env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number }> {
  const themesJsonPath = join(recipeDirectory, "themes.json")
  await writeFile(themesJsonPath, JSON.stringify(themes))
  try {
    const { stdout, stderr } = await execFileAsync(tsxBin, [workerScript, themesJsonPath, recipeDirectory], { env })
    return { stdout, stderr, code: 0 }
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; code?: number }
    return { stdout: execError.stdout ?? "", stderr: execError.stderr ?? "", code: execError.code ?? 1 }
  }
}

// Real prepareExtraThemes() rejects an https:// source exactly like
// extra_plugins does when network downloads are disabled -- the same policy
// gate (evaluateSourcePolicy in source-policy.ts), reached through the same
// prepareRecipeSource() code path, before any network call is attempted.
await withTempDir("wp-codebox-extra-theme-network-disabled-", async (recipeDirectory) => {
  await assert.rejects(
    () => prepareExtraThemes([{ source: "https://example.test/theme.zip", slug: "remote-theme" }], recipeDirectory),
    /require WP_CODEBOX_ALLOW_NETWORK_DOWNLOADS=1/,
  )
})

// An https .zip theme source resolves through the exact same source layer as
// extra_plugins (prepareRecipeSource -> RecipeSourceType "https_zip" ->
// downloadZipSource in zip-source.ts), including sha256 pinning, verified
// end-to-end against a live local HTTPS server. A remote source cannot be
// trusted with a self-signed certificate except via NODE_EXTRA_CA_CERTS,
// which Node only reads at process startup, so this spawns a real child
// process per assertion rather than mutating the running process's trust
// store.
const certDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-extra-theme-https-"))
try {
  const keyPath = join(certDirectory, "key.pem")
  const certPath = join(certDirectory, "cert.pem")
  await execFileAsync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"])

  await withTempDir("wp-codebox-extra-theme-https-fixture-", async (recipeDirectory) => {
    // The zip's top-level directory name must match the extra_themes slug --
    // prepareRecipeSource looks for an <extractDirectory>/<slug> subdirectory
    // first (the shape a GitHub release asset produces), matching how
    // extra_plugins resolves the same zip layout.
    const themeDirectory = join(recipeDirectory, "remote-theme")
    await mkdir(themeDirectory, { recursive: true })
    await writeFile(join(themeDirectory, "style.css"), "/*\nTheme Name: Release Theme\n*/\n")
    await writeFile(join(themeDirectory, "index.php"), "<?php\n")
    await execFileAsync("zip", ["-q", "-r", "remote-theme.zip", "remote-theme"], { cwd: recipeDirectory })
    const zipBuffer = await readFile(join(recipeDirectory, "remote-theme.zip"))
    const correctDigest = createHash("sha256").update(zipBuffer).digest("hex")

    const key = await readFile(keyPath)
    const cert = await readFile(certPath)
    const server = https.createServer({ key, cert }, (request, response) => {
      if (request.url === "/remote-theme.zip") {
        response.writeHead(200, { "content-type": "application/zip" })
        response.end(zipBuffer)
        return
      }
      response.writeHead(404)
      response.end()
    })

    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen))
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("Expected an AddressInfo from the test HTTPS server")
      const zipUrl = `https://127.0.0.1:${address.port}/remote-theme.zip`

      const workerEnv: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_EXTRA_CA_CERTS: certPath,
        [ALLOW_NETWORK_DOWNLOADS_ENV]: "1",
        [ALLOWED_DOWNLOAD_HOSTS_ENV]: "127.0.0.1",
      }

      const verified = await runWorker([{ source: zipUrl, slug: "remote-theme", sha256: correctDigest }], recipeDirectory, workerEnv)
      assert.equal(verified.code, 0, `worker failed: ${verified.stderr}`)
      const [theme] = JSON.parse(verified.stdout) as WorkerTheme[]
      assert.equal(theme.slug, "remote-theme")
      assert.equal(theme.themeName, "Release Theme")
      assert.equal(theme.target, "/wordpress/wp-content/themes/remote-theme")
      assert.equal(theme.provenance.kind, "https_zip")
      assert.equal(theme.provenance.resolvedUrl, zipUrl)
      assert.deepEqual(theme.provenance.digest, { sha256: correctDigest, expected: correctDigest, verified: true })

      const mismatched = await runWorker([{ source: zipUrl, slug: "remote-theme", sha256: "0".repeat(64) }], recipeDirectory, workerEnv)
      assert.notEqual(mismatched.code, 0)
      assert.match(mismatched.stderr, /sha256 mismatch/)
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    }
  })
} finally {
  await rm(certDirectory, { recursive: true, force: true })
}

console.log("recipe extra theme https zip remote source ok")
