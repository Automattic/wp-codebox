import { spawn } from "node:child_process"
import { createHash, createHmac } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stripVTControlCharacters } from "node:util"
import { encodeZip } from "@php-wasm/stream-compression"

const port = 8792
const origin = `http://127.0.0.1:${port}`
const password = "cloudflare-runtime-test-password"
const authSecret = "cloudflare-runtime-test-auth-secret"
const operatorToken = "cloudflare-runtime-test-operator-token"
const coordinator = process.argv.includes("--coordinator=d1") ? "d1" : "durable-object"
const wranglerConfig = coordinator === "d1" ? "packages/runtime-cloudflare/wrangler.d1.jsonc" : "packages/runtime-cloudflare/wrangler.jsonc"
const stateDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-cloudflare-gate-"))
const cookies = []
let siteContexts = [{ id: "default", hostname: "127.0.0.1", origin }]
let child
let output = ""

function siteCredential(rootCredential, siteId, purpose) {
  if (siteId === "default") return rootCredential
  return createHmac("sha256", rootCredential).update(`wp-codebox/site-credential/v1\0${siteId}\0${purpose}`).digest("hex")
}

try {
  await run("npm", ["run", "generate:cloudflare-wordpress-runtime-corpus"])
  await run("npm", ["run", "provision:cloudflare-wordpress-runtime-corpus", "--", "--local", "--persist-to", stateDirectory])
  const staticArtifactImport = await provisionStaticArtifact()
  await startWorker()
  await assertFullBootProbe()
  await assertWordPressCronDisabled()
  await assertConcurrentMutations()
  await assertCoordinatorBackend()
  console.log(`Coordinator adoption probe starting for ${coordinator}.`)
  await assertCoordinatorAdoption()
  console.log(`Coordinator adoption probe passed for ${coordinator}.`)
  const coldHome = await timedWordPressPage(origin, "cold explanatory homepage")
  const warmHome = await timedWordPressPage(origin, "warm explanatory homepage")
  await assertExplanatoryHomepage(warmHome.body)
  if (coldHome.cacheStatus !== "miss" || warmHome.cacheStatus !== "hit" || warmHome.elapsedMs >= coldHome.elapsedMs || warmHome.elapsedMs > 500) {
    throw new Error(`Warm explanatory homepage did not use its revision cache: cold=${coldHome.elapsedMs}ms/${coldHome.cacheStatus} warm=${warmHome.elapsedMs}ms/${warmHome.cacheStatus}.`)
  }
  console.log(`Explanatory homepage timing: cold=${coldHome.elapsedMs}ms warm=${warmHome.elapsedMs}ms.`)
  const adminHtml = await login()
  const { deletedThemePath, scheduledPost } = await installDurablePlugin(adminHtml)
  await assertScheduledPost(scheduledPost.id, "draft", 0, scheduledPost.timestamp, "new scheduled post")
  const editorHtml = await assertPostNewEditor()
  const media = await createMedia(adminHtml)
  await assertMediaFile(media, "uploaded media")
  const post = await createPost(adminHtml)
  const frontPage = await assertWordPressPage(new URL(post.route, origin), "published post")
  assertIncludes(frontPage, post.title, "published post")
  await assertAnonymousWordPressPage(new URL(post.route, origin), "post publication candidate")
  await assertAnonymousWordPressPage(origin, "homepage publication candidate")
  const initialPublication = await publishRoutes(["/", post.route])
  await assertCoordinatorFence(post.route)
  const updatedPost = await updatePost(adminHtml, post, initialPublication.revision)
  await assertAnonymousWordPressPage(new URL(post.route, origin), "updated post canonical snapshot before publication")
  // Restart with an explicit pending job to prove progress is durable rather than isolate-local.
  await stopWorker()
  await startWorker()
  const automaticallyPublishedPost = await runScheduledPublicationUntil(new URL(post.route, origin), updatedPost.title, "automatically republished post")
  assertIncludes(automaticallyPublishedPost, updatedPost.title, "automatically republished post")
  post.title = updatedPost.title
  await assertHealthResponse()
  await assertLinkedAssets(frontPage, "front-end")
  await assertLinkedAssets(adminHtml, "admin")
  await assertLinkedAssets(editorHtml, "editor")
  await assertStaticResponseSemantics()
  const restartedAdmin = await assertAuthenticatedDashboard(new URL("/wp-admin/", origin))
  const restartedPost = await assertPublishedWordPressPage(new URL(post.route, origin), "post after publication restart", ["publication-r2", "publication-edge"])
  assertIncludes(restartedPost, post.title, "post after cold restart")
  await assertMediaFile(media, "media after cold restart")
  await assertMediaMetadata(media, "media metadata after cold restart")
  await assertDurablePlugin("plugin after cold restart")
  await assertDurablePluginAsset("plugin asset after cold restart")
  await assertDeletedThemeFile(deletedThemePath, "bundled theme tombstone after cold restart")
  await assertScheduledPost(scheduledPost.id, "draft", 0, scheduledPost.timestamp, "scheduled post before cron")
  await runScheduledCronUntilPost(scheduledPost.id)
  await assertScheduledPostEventually(scheduledPost.id, "publish", 1, false, "scheduled post after cron")
  const scheduledPage = await runScheduledPublicationUntil(new URL(scheduledPost.route, origin), "Published by the Cloudflare scheduled handler.", "automatically published scheduled post")
  assertIncludes(scheduledPage, "Published by the Cloudflare scheduled handler.", "automatically published scheduled post")
  await assertLinkedAssets(restartedAdmin, "admin after cold restart")
  await stopWorker()

  await startWorker()
  await assertScheduledPost(scheduledPost.id, "publish", 1, false, "scheduled post after cron restart")
  await runScheduledCron()
  await assertScheduledPost(scheduledPost.id, "publish", 1, false, "scheduled post after duplicate cron trigger")
  cookies.length = 0
  const finalAdmin = await login()
  console.log(`Static artifact import starting for ${coordinator}.`)
  const imported = await importStaticArtifact(staticArtifactImport)
  console.log(`Static artifact import committed for ${coordinator}.`)
  console.log(`Static artifact receipt: ${JSON.stringify({ pages: imported.pages, themeSlug: imported.themeSlug, quality: imported.quality })}`)
  const importedPages = await assertImportedArtifactPages(finalAdmin, imported)
  console.log(`Static artifact pages are editable for ${coordinator}.`)
  const importedPublication = await runScheduledPublicationUntil(new URL(importedPages.secondary.route, origin), "A second imported page.", "imported static artifact publication", 12)
  assertIncludes(importedPublication, "A second imported page.", "imported static artifact publication")
  console.log(`Static artifact publication promoted for ${coordinator}.`)
  await stopWorker()
  await startWorker()
  const importedAdmin = await login()
  await assertImportedArtifactPages(importedAdmin, imported)
  const duplicateStateBefore = await (await fetch(`${origin}/?phase=r2-state`)).json()
  const duplicate = await importStaticArtifact(staticArtifactImport, 200)
  const duplicateStateAfter = await (await fetch(`${origin}/?phase=r2-state`)).json()
  if (duplicate.status !== "duplicate" || duplicateStateAfter.version !== duplicateStateBefore.version || duplicateStateAfter.pointer?.revision !== duplicateStateBefore.pointer?.revision) throw new Error("Idempotent static artifact import changed canonical state.")
  const conflicting = await importStaticArtifact({ ...staticArtifactImport, import: { ...staticArtifactImport.import, slug: "different-artifact-site" } }, 409)
  const conflictStateAfter = await (await fetch(`${origin}/?phase=r2-state`)).json()
  if (conflicting.status !== "conflict" || conflictStateAfter.version !== duplicateStateBefore.version || conflictStateAfter.pointer?.revision !== duplicateStateBefore.pointer?.revision) throw new Error("Conflicting static artifact replay changed canonical state.")
  await assertTwoSiteIsolation()
  console.log(`Cloudflare local runtime gate passed with ${coordinator} coordination: canonical full-boot probe, explanatory homepage, complete block styles, coordinator-free R2 publication reads, login, dashboard, post editor, concurrent canonical mutations, authenticated REST post and media creation, plugin ZIP installation and activation, direct R2 upload serving, frontend/admin/editor assets, cold-restart persistence, and bounded durable scheduled callback execution.`)
} finally {
  await stopWorker()
  await rm(stateDirectory, { recursive: true, force: true })
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const childProcess = spawn(command, args, { cwd: process.cwd(), stdio: "inherit" })
    childProcess.on("error", reject)
    childProcess.on("exit", (code) => code === 0 ? resolve(undefined) : reject(new Error(`${command} ${args.join(" ")} failed with status ${code}.`)))
  })
}

async function provisionStaticArtifact() {
  const artifact = {
    schema: "blocks-engine/php-transformer/site-artifact/v1",
    artifact_type: "website",
    version: 1,
    root: "website",
    entrypoint: "website/index.html",
    files: [{
      path: "website/index.html",
      role: "document",
      kind: "html",
      mime_type: "text/html",
      encoding: "utf-8",
      content: "<!doctype html><html><head><meta charset=\"utf-8\"><title>Verified Artifact Site</title></head><body><main><h1>Verified Artifact Site</h1><p>Imported from a verified R2 artifact.</p></main></body></html>",
    }, {
      path: "website/about/index.html",
      role: "document",
      kind: "html",
      mime_type: "text/html",
      encoding: "utf-8",
      content: "<!doctype html><html><head><meta charset=\"utf-8\"><title>About the Verified Artifact</title></head><body><main><h1>About the Verified Artifact</h1><p>A second imported page.</p></main></body></html>",
    }],
  }
  const serialized = JSON.stringify(artifact)
  const sha256 = createHash("sha256").update(serialized).digest("hex")
  const key = `sites/default/import-artifacts/${sha256}.json`
  const path = join(stateDirectory, "static-site-artifact.json")
  await writeFile(path, serialized)
  await run("npm", ["exec", "--", "wrangler", "r2", "object", "put", `wp-codebox-runtime-chubes/${key}`, "--file", path, "--local", "--persist-to", stateDirectory])
  return {
    schema: "wp-codebox/cloudflare-static-artifact-import-request/v1",
    idempotencyKey: `cloudflare-static-artifact-${sha256}`,
    artifact: { r2Key: key, sha256, size: Buffer.byteLength(serialized) },
    import: { slug: "verified-artifact-site", name: "Verified Artifact Site", siteTitle: "Verified Artifact Site" },
  }
}

async function assertTwoSiteIsolation() {
  await stopWorker()
  siteContexts = [
    { id: "alpha", hostname: "alpha.localhost", origin: `http://alpha.localhost:${port}` },
    { id: "beta", hostname: "beta.localhost", origin: `http://beta.localhost:${port}` },
  ]
  await startWorker()
  const alpha = siteContexts[0].origin
  const beta = siteContexts[1].origin
  const unknown = await fetch(`http://unknown.localhost:${port}/?phase=r2-state`)
  if (unknown.status !== 421) throw new Error(`Unknown hostname reached the runtime: ${unknown.status}.`)

  const mutate = async (siteOrigin) => {
    const response = await fetch(`${siteOrigin}/?phase=r2-mutate`, { method: "POST" })
    if (!response.ok) throw new Error(`Site mutation failed for ${siteOrigin}: ${response.status} ${await response.text()}`)
    return response.json()
  }
  const [alphaFirst, betaFirst] = await Promise.all([mutate(alpha), mutate(beta)])
  const alphaSecond = await mutate(alpha)
  if (alphaFirst.revisionValue !== 1 || alphaSecond.revisionValue !== 2 || betaFirst.revisionValue !== 1) throw new Error("Site mutations did not retain independent canonical histories.")

  const [alphaState, betaState] = await Promise.all([
    fetch(`${alpha}/?phase=r2-state`).then((response) => response.json()),
    fetch(`${beta}/?phase=r2-state`).then((response) => response.json()),
  ])
  if (alphaState.version !== 3 || betaState.version !== 2 || alphaState.pointer?.revision === betaState.pointer?.revision
    || !alphaState.pointer?.manifestKey.startsWith("sites/alpha/markdown/revisions/")
    || !betaState.pointer?.manifestKey.startsWith("sites/beta/markdown/revisions/")) {
    throw new Error(`Site coordinator or R2 state crossed namespaces: ${JSON.stringify({ alphaState, betaState })}`)
  }

  const [alphaPosts, betaPosts] = await Promise.all([
    fetch(`${alpha}/wp-json/wp/v2/posts?slug=cloudflare-r2-proof-2`).then((response) => response.json()),
    fetch(`${beta}/wp-json/wp/v2/posts?slug=cloudflare-r2-proof-2`).then((response) => response.json()),
  ])
  if (!Array.isArray(alphaPosts) || alphaPosts.length !== 1 || !Array.isArray(betaPosts) || betaPosts.length !== 0) throw new Error("Site REST collections crossed canonical namespaces.")

  const loginStatus = async (siteOrigin, candidatePassword) => fetch(`${siteOrigin}/wp-login.php`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ log: "admin", pwd: candidatePassword, redirect_to: `${siteOrigin}/wp-admin/`, "wp-submit": "Log In" }),
    redirect: "manual",
  }).then((response) => response.status)
  if (await loginStatus(alpha, siteCredential(password, "beta", "admin-password")) !== 200) throw new Error("Alpha accepted Beta's admin credential.")
  if (![301, 302].includes(await loginStatus(alpha, siteCredential(password, "alpha", "admin-password")))) throw new Error("Alpha rejected its site-scoped admin credential.")
  await Promise.all([fetch(alpha), fetch(beta)])
  const [alphaPublishState, betaPublishState] = await Promise.all([
    fetch(`${alpha}/?phase=r2-state`).then((response) => response.json()),
    fetch(`${beta}/?phase=r2-state`).then((response) => response.json()),
  ])

  const publish = async (siteOrigin, siteId) => {
    const response = await fetch(`${siteOrigin}/?phase=operator-publish`, {
      method: "POST",
      headers: { authorization: `Bearer ${siteCredential(operatorToken, siteId, "operator-token")}`, "content-type": "application/json" },
      body: JSON.stringify({ routes: ["/"] }),
    })
    if (!response.ok) throw new Error(`Site publication failed for ${siteOrigin}: ${response.status} ${await response.text()}`)
    return response.json()
  }
  const rejectedCredentialReuse = await fetch(`${alpha}/?phase=operator-publish`, {
    method: "POST",
    headers: { authorization: `Bearer ${siteCredential(operatorToken, "beta", "operator-token")}`, "content-type": "application/json" },
    body: JSON.stringify({ routes: ["/"] }),
  })
  if (rejectedCredentialReuse.status !== 401) throw new Error(`Cross-site operator credential reuse returned ${rejectedCredentialReuse.status} instead of 401.`)
  const [alphaPublication, betaPublication] = await Promise.all([publish(alpha, "alpha"), publish(beta, "beta")])
  if (alphaPublication.revision === betaPublication.revision || alphaPublication.canonicalRevision !== alphaPublishState.pointer?.revision || betaPublication.canonicalRevision !== betaPublishState.pointer?.revision) throw new Error("Site publication receipts crossed namespaces.")
  const [alphaPublished, betaPublished] = await Promise.all([fetch(alpha), fetch(beta)])
  if (!alphaPublished.headers.get("x-wp-codebox-page-cache-source")?.startsWith("publication-") || !betaPublished.headers.get("x-wp-codebox-page-cache-source")?.startsWith("publication-")) throw new Error("Site publications did not resolve through isolated publication caches.")
  console.log(`Two-site isolation passed for ${coordinator}.`)
}

async function startWorker() {
  output = ""
  child = spawn("npm", ["exec", "--", "wrangler", "dev", "--test-scheduled", "--config", wranglerConfig, "--port", String(port), "--persist-to", stateDirectory, "--var", `WORDPRESS_ADMIN_PASSWORD:${password}`, "--var", `WORDPRESS_AUTH_SECRET:${authSecret}`, "--var", `WORDPRESS_OPERATOR_TOKEN:${operatorToken}`, "--var", `WORDPRESS_SITE_CONTEXTS:${JSON.stringify(siteContexts)}`], {
    cwd: process.cwd(),
    // The host PAC resolves these public archive hosts through an unavailable local proxy.
    env: { ...process.env, NO_PROXY: "wordpress.org,github.com,codeload.github.com", no_proxy: "wordpress.org,github.com,codeload.github.com" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout.on("data", (chunk) => {
    output += chunk
    if (process.env.CLOUDFLARE_GATE_DEBUG) process.stdout.write(chunk)
  })
  child.stderr.on("data", (chunk) => {
    output += chunk
    if (process.env.CLOUDFLARE_GATE_DEBUG) process.stderr.write(chunk)
  })
  await waitForServer()
}

async function stopWorker() {
  if (!child || child.exitCode !== null) return
  child.kill("SIGTERM")
  await new Promise((resolve) => child.once("exit", resolve))
  child = undefined
}

async function waitForServer() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (/Ready on http:\/\/(?:localhost|127\.0\.0\.1):8792/.test(stripVTControlCharacters(output))) return
    if (child.exitCode !== null) throw new Error(`workerd exited before starting:\n${output}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`workerd did not start within 30 seconds:\n${output}`)
}

async function assertLoginForm() {
  const html = await assertWordPressPage(`${origin}/wp-login.php`, "login form")
  if (!/<form[^>]+id=["']loginform["']/i.test(html)) throw new Error("wp-login.php did not return the login form.")
}

async function login() {
  await assertLoginForm()
  const form = new URLSearchParams({ log: "admin", pwd: password, redirect_to: `${origin}/wp-admin/`, testcookie: "1", "wp-submit": "Log In" })
  const response = await request(`${origin}/wp-login.php`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form, redirect: "manual" })
  if (![301, 302].includes(response.status)) throw new Error(`Expected login redirect, received ${response.status}: ${await response.text()}`)
  if (response.headers.get("x-wp-codebox-publication") === "queued" || response.headers.has("x-wp-codebox-publication-revision")) throw new Error("Login must not enqueue or promote publication work.")
  const location = response.headers.get("location")
  if (!location?.includes("/wp-admin/")) throw new Error(`Login did not redirect to wp-admin: ${location}`)
  const admin = await assertAuthenticatedDashboard(new URL(location, origin))
  return admin
}

async function createPost(adminHtml) {
  const nonce = restNonce(adminHtml)
  const title = `Cloudflare durable post ${Date.now()}`
  const response = await request(`${origin}/wp-json/wp/v2/posts`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-wp-nonce": nonce },
    body: JSON.stringify({ title, content: "Persisted through the authenticated Cloudflare runtime.", status: "publish" }),
  })
  const body = await response.text()
  assertNoPhpDiagnostics(body, "REST post creation")
  if (response.status !== 201) throw new Error(`Expected REST post creation, received ${response.status}: ${body}`)
  const post = JSON.parse(body)
  if (typeof post.slug !== "string" || typeof post.link !== "string" || post.title?.rendered !== title) throw new Error(`Unexpected REST post response: ${body}`)
  const link = new URL(post.link)
  return { id: post.id, slug: post.slug, route: `${link.pathname}${link.search}`, title }
}

async function importStaticArtifact(input, expectedStatus = 201) {
  const response = await fetch(`${origin}/?phase=operator-static-artifact-import`, {
    method: "POST",
    headers: { authorization: `Bearer ${operatorToken}`, "content-type": "application/json" },
    body: JSON.stringify(input),
  })
  const body = await response.text()
  if (response.status !== expectedStatus) throw new Error(`Static artifact import failed: ${response.status} ${body}.\nWorker output:\n${output}`)
  const result = JSON.parse(body)
  if (expectedStatus === 201 && (result.status !== "imported" || result.staticSiteImporterVersion !== "1.3.4" || !result.themeSlug
    || !result.pages || !Object.keys(result.pages).length || Object.values(result.quality ?? {}).some((count) => count !== 0)
    || !response.headers.get("x-wp-codebox-canonical-revision") || !response.headers.get("x-wp-codebox-canonical-version"))) {
    throw new Error(`Static artifact import returned invalid evidence: ${body}.`)
  }
  return result
}

async function assertImportedArtifactPages(adminHtml, imported) {
  const pageIds = Object.values(imported.pages ?? {}).filter(Number.isInteger)
  if (pageIds.length !== 2) throw new Error(`Static artifact import did not return two page IDs: ${JSON.stringify(imported)}.`)
  const pages = []
  for (const pageId of pageIds) {
    const response = await request(`${origin}/wp-json/wp/v2/pages/${pageId}?context=edit`, { headers: { "x-wp-nonce": restNonce(adminHtml) } })
    const body = await response.text()
    if (!response.ok) throw new Error(`Imported artifact page ${pageId} was unavailable: ${response.status} ${body}. Receipt: ${JSON.stringify(imported.pages)}.\nWorker output:\n${output}`)
    const page = JSON.parse(body)
    const raw = page.content?.raw
    if (typeof raw !== "string" || !raw.includes("<!-- wp:") || /<!-- wp:(?:html|freeform)\b/.test(raw)) throw new Error(`Imported artifact page is not editable native block content: ${body}.`)
    const link = new URL(page.link)
    pages.push({ id: pageId, route: `${link.pathname}${link.search}`, raw })
  }
  const primary = pages.find(({ raw }) => raw.includes("Imported from a verified R2 artifact."))
  const secondary = pages.find(({ raw }) => raw.includes("A second imported page."))
  if (!primary || !secondary || secondary.route === "/") throw new Error(`Imported artifact routes are invalid: ${JSON.stringify(pages)}.`)
  return { primary, secondary }
}

async function updatePost(adminHtml, post, previousPublicationRevision) {
  const title = `Automatically published ${Date.now()}`
  const response = await request(`${origin}/wp-json/wp/v2/posts/${post.id}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-wp-nonce": restNonce(adminHtml) },
    body: JSON.stringify({ title, content: "This edit was compiled and promoted by the canonical mutation transaction." }),
  })
  const body = await response.text()
  assertNoPhpDiagnostics(body, "REST post update with automatic publication")
  const publicationRevision = response.headers.get("x-wp-codebox-publication-revision")
  if (response.status !== 200 || response.headers.get("x-wp-codebox-publication") !== "queued" || !response.headers.get("x-wp-codebox-publication-job")) {
    throw new Error(`Automatic publication failed: status=${response.status} publication=${response.headers.get("x-wp-codebox-publication")} revision=${publicationRevision} body=${body}.`)
  }
  const payload = JSON.parse(body)
  if (payload.title?.rendered !== title) throw new Error(`Unexpected updated post response: ${body}`)
  return { title }
}

async function createMedia(adminHtml) {
  const nonce = restNonce(adminHtml)
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
  const filename = `cloudflare-durable-media-${Date.now()}.png`
  const response = await request(`${origin}/wp-json/wp/v2/media`, {
    method: "POST",
    headers: {
      "content-disposition": `attachment; filename="${filename}"`,
      "content-type": "image/png",
      "x-wp-nonce": nonce,
    },
    body: bytes,
  })
  const body = await response.text()
  assertNoPhpDiagnostics(body, "REST media creation")
  if (response.status !== 201) throw new Error(`Expected REST media creation, received ${response.status}: ${body}`)
  const media = JSON.parse(body)
  if (!Number.isInteger(media.id) || typeof media.source_url !== "string" || !media.source_url.includes(`/wp-content/uploads/`) || !media.source_url.endsWith(`/${filename}`)) {
    throw new Error(`Unexpected REST media response: ${body}`)
  }
  return { id: media.id, sourceUrl: media.source_url, filename, bytes }
}

async function assertMediaFile(media, label) {
  const response = await request(new URL(media.sourceUrl, origin))
  const bytes = Buffer.from(await response.arrayBuffer())
  if (response.status !== 200 || response.headers.get("content-type") !== "image/png" || response.headers.get("x-wp-codebox-static") !== "r2-upload" || !bytes.equals(media.bytes)) {
    throw new Error(`${label} was not served intact from R2: status=${response.status} content-type=${response.headers.get("content-type")} source=${response.headers.get("x-wp-codebox-static")} bytes=${bytes.length}.`)
  }
  const head = await request(new URL(media.sourceUrl, origin), { method: "HEAD" })
  if (head.status !== 200 || head.headers.get("content-length") !== String(media.bytes.length) || head.headers.get("x-wp-codebox-static") !== "r2-upload" || (await head.arrayBuffer()).byteLength !== 0) {
    throw new Error(`${label} HEAD semantics were invalid.`)
  }
}

async function assertMediaMetadata(media, label) {
  const response = await request(`${origin}/wp-json/wp/v2/media/${media.id}`)
  const body = await response.text()
  assertNoPhpDiagnostics(body, label)
  const attachment = JSON.parse(body)
  if (response.status !== 200 || attachment.id !== media.id || !attachment.source_url?.endsWith(`/${media.filename}`)) throw new Error(`${label} was not restored: ${body}`)
}

function restNonce(adminHtml) {
  const nonce = adminHtml.match(/"nonce":"([^"]+)"/)?.[1]
  if (!nonce) throw new Error("wp-admin did not expose a REST nonce.")
  return nonce
}

async function assertPostNewEditor() {
  const response = await request(`${origin}/wp-admin/post-new.php`)
  const body = await response.text()
  assertNoPhpDiagnostics(body, "post editor")
  if (response.status !== 200 || response.url.includes("wp-login.php") || !/wp-edit-post|block-editor/i.test(body)) {
    throw new Error(`Expected the authenticated block editor, received ${response.status} at ${response.url}.`)
  }
  return body
}

async function installDurablePlugin(adminHtml) {
  const uploadPage = await request(`${origin}/wp-admin/plugin-install.php?tab=upload`)
  const uploadHtml = await uploadPage.text()
  const nonce = uploadHtml.match(/name=["']_wpnonce["'][^>]*value=["']([^"']+)["']/i)?.[1]
  if (!uploadPage.ok || !nonce) throw new Error("Plugin upload page did not expose its installation nonce.")
  const source = `<?php
/**
 * Plugin Name: Cloudflare Durable Plugin Proof
 */
add_action( 'rest_api_init', static function () {
	register_rest_route( 'wp-codebox/v1', '/durable-plugin', array(
		'methods' => 'GET',
		'callback' => static fn() => rest_ensure_response( array( 'durable' => true, 'source' => 'canonical-wp-content' ) ),
		'permission_callback' => '__return_true',
	) );
	register_rest_route( 'wp-codebox/v1', '/delete-bundled-theme-file', array(
		'methods' => 'POST',
		'callback' => static function () {
			foreach ( wp_get_themes() as $stylesheet => $theme ) {
				if ( $stylesheet === get_stylesheet() ) continue;
				$relative = 'themes/' . $stylesheet . '/style.css';
				$absolute = WP_CONTENT_DIR . '/' . $relative;
				if ( is_file( $absolute ) && unlink( $absolute ) ) return rest_ensure_response( array( 'deleted' => $relative ) );
			}
			return new WP_Error( 'no_inactive_theme_file', 'No inactive bundled theme file was available.', array( 'status' => 409 ) );
		},
		'permission_callback' => static fn() => current_user_can( 'delete_themes' ),
	) );
	register_rest_route( 'wp-codebox/v1', '/schedule-durable-post', array(
		'methods' => 'POST',
		'callback' => static function () {
			$post_id = wp_insert_post( array( 'post_title' => 'Durable Cron Proof', 'post_name' => 'durable-cron-proof', 'post_content' => 'Published by the Cloudflare scheduled handler.', 'post_status' => 'draft', 'post_type' => 'post' ), true );
			if ( is_wp_error( $post_id ) ) return $post_id;
			$timestamp = time() - 1;
			$scheduled = wp_schedule_single_event( $timestamp, 'wp_codebox_publish_scheduled_post', array( $post_id ), true );
			if ( is_wp_error( $scheduled ) ) return $scheduled;
			if ( true !== $scheduled ) return new WP_Error( 'schedule_failed', 'WordPress did not persist the cron event.', array( 'status' => 500 ) );
			return rest_ensure_response( array( 'id' => $post_id, 'timestamp' => $timestamp, 'link' => get_permalink( $post_id ) ) );
		},
		'permission_callback' => static fn() => current_user_can( 'publish_posts' ),
	) );
	register_rest_route( 'wp-codebox/v1', '/scheduled-post-status/(?P<id>\\d+)', array(
		'methods' => 'GET',
		'callback' => static function ( $request ) {
			$post = get_post( (int) $request['id'] );
			if ( !$post ) return new WP_Error( 'missing_post', 'Scheduled post is missing.', array( 'status' => 404 ) );
			return rest_ensure_response( array( 'status' => $post->post_status, 'runs' => (int) get_option( 'wp_codebox_cron_runs', 0 ), 'next' => wp_next_scheduled( 'wp_codebox_publish_scheduled_post', array( $post->ID ) ) ) );
		},
		'permission_callback' => '__return_true',
	) );
} );`
  const cronCallback = `
add_action( 'wp_codebox_publish_scheduled_post', static function ( $post_id ) {
	wp_publish_post( (int) $post_id );
	update_option( 'wp_codebox_cron_runs', (int) get_option( 'wp_codebox_cron_runs', 0 ) + 1, false );
} );`
  const archive = new Uint8Array(await new Response(encodeZip([
    new File([`${source}${cronCallback}`], "cloudflare-durable-proof/cloudflare-durable-proof.php", { lastModified: 0, type: "application/x-httpd-php" }),
    new File([".cloudflare-durable-proof{display:block}"], "cloudflare-durable-proof/proof.css", { lastModified: 0, type: "text/css" }),
  ])).arrayBuffer())
  const form = new FormData()
  form.set("_wpnonce", nonce)
  form.set("_wp_http_referer", "/wp-admin/plugin-install.php?tab=upload")
  form.set("pluginzip", new File([archive], "cloudflare-durable-proof.zip", { type: "application/zip" }))
  form.set("install-plugin-submit", "Install Now")
  const installed = await request(`${origin}/wp-admin/update.php?action=upload-plugin`, { method: "POST", body: form })
  const installedHtml = await installed.text()
  assertNoPhpDiagnostics(installedHtml, "plugin installation")
  const activationHref = installedHtml.match(/href=["']([^"']*plugins\.php\?action=activate[^"']+)["'][^>]*>Activate Plugin</i)?.[1]
  if (!installed.ok || !activationHref) throw new Error(`WordPress did not install the durable plugin: status=${installed.status}.`)
  const activationUrl = new URL(activationHref.replaceAll("&#038;", "&").replaceAll("&amp;", "&"), `${origin}/wp-admin/`)
  const activated = await request(activationUrl)
  const activatedHtml = await activated.text()
  assertNoPhpDiagnostics(activatedHtml, "plugin activation")
  if (!activated.ok || !/Plugin activated/i.test(activatedHtml)) throw new Error(`WordPress did not activate the durable plugin: status=${activated.status}.`)
  await assertDurablePlugin("newly activated plugin")
  await assertDurablePluginAsset("newly installed plugin asset")
  const deleted = await request(`${origin}/wp-json/wp-codebox/v1/delete-bundled-theme-file`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-wp-nonce": restNonce(adminHtml) },
    body: "{}",
  })
  const deletedPayload = await deleted.json()
  if (!deleted.ok || !/^themes\/[a-z0-9-]+\/style\.css$/.test(deletedPayload.deleted ?? "")) throw new Error(`Bundled theme deletion failed: status=${deleted.status} payload=${JSON.stringify(deletedPayload)}.`)
  await assertDeletedThemeFile(deletedPayload.deleted, "new bundled theme tombstone")
  const scheduled = await request(`${origin}/wp-json/wp-codebox/v1/schedule-durable-post`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-wp-nonce": restNonce(adminHtml) },
    body: "{}",
  })
  const scheduledPayload = await scheduled.json()
  if (!scheduled.ok || !Number.isSafeInteger(scheduledPayload.id) || !Number.isSafeInteger(scheduledPayload.timestamp) || typeof scheduledPayload.link !== "string") throw new Error(`Durable cron scheduling failed: status=${scheduled.status} payload=${JSON.stringify(scheduledPayload)}.`)
  const scheduledLink = new URL(scheduledPayload.link)
  scheduledPayload.route = `${scheduledLink.pathname}${scheduledLink.search}`
  return { deletedThemePath: deletedPayload.deleted, scheduledPost: scheduledPayload }
}

async function assertDurablePlugin(label) {
  const response = await request(`${origin}/wp-json/wp-codebox/v1/durable-plugin`)
  const payload = await response.json()
  if (!response.ok || payload.durable !== true || payload.source !== "canonical-wp-content") throw new Error(`Unexpected ${label} response: status=${response.status} payload=${JSON.stringify(payload)}.`)
}

async function assertDurablePluginAsset(label) {
  const response = await request(`${origin}/wp-content/plugins/cloudflare-durable-proof/proof.css`)
  const body = await response.text()
  if (!response.ok || body !== ".cloudflare-durable-proof{display:block}" || response.headers.get("content-type") !== "text/css; charset=utf-8"
    || response.headers.get("x-wp-codebox-static") !== "r2-wp-content") {
    throw new Error(`Unexpected ${label} response: status=${response.status} source=${response.headers.get("x-wp-codebox-static")} body=${body}.`)
  }
}

async function assertDeletedThemeFile(path, label) {
  const response = await request(`${origin}/wp-content/${path}`)
  if (response.status !== 404) throw new Error(`Expected ${label} to return 404, received ${response.status}.`)
}

async function assertScheduledPost(id, status, runs, next, label) {
  const response = await request(`${origin}/wp-json/wp-codebox/v1/scheduled-post-status/${id}`)
  const payload = await response.json()
  if (!response.ok || payload.status !== status || payload.runs !== runs || payload.next !== next) throw new Error(`Unexpected ${label}: status=${response.status} payload=${JSON.stringify(payload)}.`)
}

async function assertScheduledPostEventually(id, status, runs, next, label) {
  const deadline = Date.now() + 30_000
  let last
  while (Date.now() < deadline) {
    const response = await request(`${origin}/wp-json/wp-codebox/v1/scheduled-post-status/${id}`)
    const payload = await response.json()
    if (response.ok && payload.status === status && payload.runs === runs && payload.next === next) return
    last = { status: response.status, payload }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const diagnostics = stripVTControlCharacters(output).split("\n").filter((line) => /scheduled|cron|error|exception/i.test(line) && !line.includes("scheduled-post-status")).slice(-30).join("\n")
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}.\nScheduled diagnostics:\n${diagnostics}`)
}

async function runScheduledCron() {
  let response
  try {
    response = await fetch(`${origin}/__scheduled?cron=*+*+*+*+*`, { signal: AbortSignal.timeout(60_000) })
  } catch (error) {
    const diagnostics = stripVTControlCharacters(output).split("\n").filter((line) => /cloudflare-cron|scheduled|error|exception/i.test(line) && !line.includes("scheduled-post-status")).slice(-40).join("\n")
    throw new Error(`Wrangler scheduled trigger did not complete: ${error instanceof Error ? error.message : String(error)}.\n${diagnostics}`)
  }
  if (!response.ok) throw new Error(`Wrangler scheduled trigger failed with ${response.status}: ${await response.text()}`)
}

async function runScheduledCronUntilPost(id) {
  for (let tick = 0; tick < 5; tick++) {
    await runScheduledCron()
    const response = await request(`${origin}/wp-json/wp-codebox/v1/scheduled-post-status/${id}`)
    const payload = await response.json()
    if (response.ok && payload.status === "publish" && payload.runs === 1 && payload.next === false) return
  }
  throw new Error("Scheduled post remained queued after five bounded cron ticks.")
}

async function runScheduledPublicationUntil(target, expected, label, maxTicks = 5) {
  for (let tick = 0; tick < maxTicks; tick++) {
    await runScheduledCron()
    const response = await fetch(target)
    const body = await response.text()
    if (response.ok && ["publication-r2", "publication-edge"].includes(response.headers.get("x-wp-codebox-page-cache-source")) && body.includes(expected)) return body
  }
  const diagnostics = stripVTControlCharacters(output).split("\n").filter((line) => /publication|scheduled|error|exception/i.test(line)).slice(-30).join("\n")
  throw new Error(`${label} did not reach coordinator-free R2 publication after ${maxTicks} bounded scheduled ticks.\n${diagnostics}`)
}

async function assertWordPressCronDisabled() {
  const response = await request(`${origin}/wp-cron.php?doing_wp_cron=1`)
  if (response.status !== 404 || !((await response.text()).includes("Cloudflare scheduled handler"))) throw new Error(`Direct WordPress cron returned ${response.status}.`)
}

async function assertConcurrentMutations() {
  const responses = await Promise.all([
    fetch(`${origin}/?phase=r2-mutate`, { method: "POST" }),
    fetch(`${origin}/?phase=r2-mutate`, { method: "POST" }),
  ])
  const mutations = await Promise.all(responses.map(async (response) => {
    const body = await response.text()
    assertNoPhpDiagnostics(body, "concurrent canonical mutation")
    if (response.status !== 200) throw new Error(`Expected concurrent canonical mutation, received ${response.status}: ${body}`)
    return JSON.parse(body)
  }))
  const revisions = mutations.map((mutation) => mutation.revisionValue).sort((left, right) => left - right)
  if (revisions[1] !== revisions[0] + 1 || !mutations.some((mutation) => mutation.previousPostFound)) {
    throw new Error(`Concurrent canonical mutations were not serialized: ${JSON.stringify(mutations)}`)
  }
}

async function assertHealthResponse() {
  const response = await request(`${origin}/?phase=health`)
  const body = await response.json()
  if (response.status !== 200 || body.schema !== "wp-codebox/cloudflare-runtime-health/v1" || body.marker !== "wp-codebox-cloudflare-runtime-health" || body.phpVersion !== "8.5.8" || typeof body.wordpressVersion !== "string" || body.execution?.status !== "ok") throw new Error(`Unexpected Cloudflare runtime health envelope: ${JSON.stringify(body)}`)
}

async function assertFullBootProbe() {
  const startedAt = performance.now()
  const response = await request(`${origin}/?phase=full`)
  const payload = await response.json()
  if (!response.ok || payload.schema !== "wp-codebox/cloudflare-boot-probe/v1" || payload.phase !== "full" || payload.completed !== true
    || payload.evidence?.bootMode !== "canonical-mdi" || !payload.evidence?.wordpressVersion || !payload.evidence?.phpVersion) {
    throw new Error(`Canonical full-boot probe failed: status=${response.status} payload=${JSON.stringify(payload)}.`)
  }
  console.log(`Canonical full-boot probe timing: ${Math.round(performance.now() - startedAt)}ms.`)
}

async function assertCoordinatorBackend() {
  const response = await fetch(`${origin}/?phase=r2-state`)
  const payload = await response.json()
  if (!response.ok || payload.schema !== "wp-codebox/cloudflare-wordpress-state/v2" || payload.store !== coordinator || !payload.pointer?.revision) {
    throw new Error(`Unexpected ${coordinator} coordinator state: status=${response.status} payload=${JSON.stringify(payload)}.`)
  }
}

async function assertCoordinatorAdoption() {
  const before = await (await fetch(`${origin}/?phase=r2-state`)).json()
  const reset = await fetch(`${origin}/?phase=operator-reset`, { method: "POST", headers: { authorization: `Bearer ${operatorToken}` } })
  if (!reset.ok) throw new Error(`Coordinator reset before adoption failed: ${reset.status} ${await reset.text()}.`)
  const adoption = await fetch(`${origin}/?phase=operator-adopt`, {
    method: "POST",
    headers: { authorization: `Bearer ${operatorToken}`, "content-type": "application/json" },
    body: JSON.stringify({ pointer: before.pointer, version: before.version }),
  })
  const adoptionBody = await adoption.text()
  if (!adoption.ok) throw new Error(`Exact coordinator adoption failed: status=${adoption.status} body=${adoptionBody}.\nWorker output:\n${output}`)
  const adopted = JSON.parse(adoptionBody)
  if (!adoption.ok || !adopted.adopted || adopted.version !== before.version || adopted.pointer?.revision !== before.pointer?.revision) {
    throw new Error(`Exact coordinator adoption failed: status=${adoption.status} payload=${JSON.stringify(adopted)}.`)
  }
  const divergent = await fetch(`${origin}/?phase=operator-adopt`, {
    method: "POST",
    headers: { authorization: `Bearer ${operatorToken}`, "content-type": "application/json" },
    body: JSON.stringify({ pointer: before.pointer, version: before.version + 1 }),
  })
  if (divergent.status !== 409) throw new Error(`Divergent coordinator adoption was not rejected: ${divergent.status} ${await divergent.text()}.`)
  await assertCoordinatorBackend()
}

async function assertCoordinatorFence(publishedRoute) {
  const headers = { authorization: `Bearer ${operatorToken}` }
  const beforeResponse = await fetch(`${origin}/?phase=operator-fence-status`, { headers })
  const beforeBody = await beforeResponse.text()
  if (!beforeResponse.ok) throw new Error(`Pre-fence cutover status failed: ${beforeResponse.status} ${beforeBody}.\nWorker output:\n${output}`)
  const before = JSON.parse(beforeBody)
  if (!beforeResponse.ok || !before.coherent || before.fence?.active || before.state?.store !== coordinator || !before.state?.pointer || before.receipt?.revision !== before.state.pointer.revision || before.manifest?.revision !== before.state.pointer.revision) {
    throw new Error(`Unexpected pre-fence cutover status: ${beforeResponse.status} ${JSON.stringify(before)}.`)
  }
  const acquiredResponse = await fetch(`${origin}/?phase=operator-fence-acquire`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ ttlSeconds: 30 }),
  })
  const acquiredBody = await acquiredResponse.text()
  if (!acquiredResponse.ok) throw new Error(`Coordinator fence acquisition failed: ${acquiredResponse.status} ${acquiredBody}.\nWorker output:\n${output}`)
  const acquired = JSON.parse(acquiredBody)
  if (!acquiredResponse.ok || !acquired.active || typeof acquired.token !== "string" || !Number.isSafeInteger(acquired.expiresAt)) throw new Error(`Coordinator fence acquisition failed: ${acquiredResponse.status} ${JSON.stringify(acquired)}.`)
  const published = await fetch(new URL(publishedRoute, origin))
  if (!published.ok || !["publication-r2", "publication-edge"].includes(published.headers.get("x-wp-codebox-page-cache-source"))) throw new Error("Anonymous publication was unavailable during the coordinator fence.")
  const mutation = await fetch(`${origin}/?phase=r2-mutate`, { method: "POST" })
  if (mutation.status !== 409) throw new Error(`Canonical mutation was not fenced: ${mutation.status} ${await mutation.text()}.`)
  const publication = await fetch(`${origin}/?phase=operator-publish`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ routes: ["/", publishedRoute] }),
  })
  if (publication.status !== 409) throw new Error(`Canonical publication was not fenced: ${publication.status} ${await publication.text()}.`)
  const active = await (await fetch(`${origin}/?phase=operator-fence-status`, { headers })).json()
  if (!active.coherent || !active.fence?.active || active.state.version !== before.state.version || active.state.pointer?.revision !== before.state.pointer.revision) throw new Error(`Coordinator state changed under fence: ${JSON.stringify(active)}.`)
  const renewedResponse = await fetch(`${origin}/?phase=operator-fence-renew`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ token: acquired.token, ttlSeconds: 60 }),
  })
  const renewed = await renewedResponse.json()
  if (!renewedResponse.ok || renewed.token !== acquired.token || renewed.expiresAt <= acquired.expiresAt) throw new Error(`Coordinator fence renewal failed: ${renewedResponse.status} ${JSON.stringify(renewed)}.`)
  const released = await fetch(`${origin}/?phase=operator-fence-release`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ token: acquired.token }),
  })
  if (!released.ok) throw new Error(`Coordinator fence release failed: ${released.status} ${await released.text()}.`)
  const after = await (await fetch(`${origin}/?phase=operator-fence-status`, { headers })).json()
  if (!after.coherent || after.fence?.active || after.state.version !== before.state.version || after.state.pointer?.revision !== before.state.pointer.revision) throw new Error(`Coordinator state changed across fence: ${JSON.stringify(after)}.`)
  console.log(`Coordinator mutation fence passed for ${coordinator}.`)
}

async function assertWordPressPage(target, label) {
  const response = await request(target)
  const body = await response.text()
  assertNoPhpDiagnostics(body, label)
  if (response.status !== 200 || !response.headers.get("content-type")?.includes("text/html") || !/<html[\s>]/i.test(body)) throw new Error(`Expected an HTML ${label}, received ${response.status}: ${body}`)
  return body
}

async function assertPublishedWordPressPage(target, label, sources = ["publication-r2"]) {
  const response = await fetch(target)
  const body = await response.text()
  assertNoPhpDiagnostics(body, label)
  if (response.status !== 200 || !sources.includes(response.headers.get("x-wp-codebox-page-cache-source"))
    || !response.headers.get("x-wp-codebox-publication-revision") || !/<html[\s>]/i.test(body)) {
    throw new Error(`Expected a coordinator-free R2 ${label}, received ${response.status}/${response.headers.get("x-wp-codebox-page-cache-source")}.`)
  }
  return body
}

async function assertPublishedRevision(target, revision, label) {
  const response = await fetch(target)
  const body = await response.text()
  assertNoPhpDiagnostics(body, label)
  if (!response.ok || !["publication-r2", "publication-edge"].includes(response.headers.get("x-wp-codebox-page-cache-source"))
    || response.headers.get("x-wp-codebox-publication-revision") !== revision) {
    throw new Error(`Expected ${label} at publication ${revision}, received ${response.status}/${response.headers.get("x-wp-codebox-publication-revision")}.`)
  }
}

async function assertAnonymousWordPressPage(target, label) {
  const response = await fetch(target)
  const body = await response.text()
  assertNoPhpDiagnostics(body, label)
  if (response.status !== 200 || !response.headers.get("content-type")?.includes("text/html") || !/<html[\s>]/i.test(body)) throw new Error(`Expected an anonymous HTML ${label}, received ${response.status}: ${body}`)
  return body
}

async function publishRoutes(routes) {
  const response = await request(`${origin}/?phase=operator-publish`, {
    method: "POST",
    headers: { authorization: `Bearer ${operatorToken}`, "content-type": "application/json" },
    body: JSON.stringify({ routes }),
  })
  const body = await response.text()
  let payload
  try {
    payload = JSON.parse(body)
  } catch {
    throw new Error(`Canonical publication returned non-JSON: status=${response.status} body=${body}.\n${stripVTControlCharacters(output).split("\n").filter((line) => /error|exception|publication/i.test(line)).slice(-30).join("\n")}`)
  }
  if (!response.ok || payload.schema !== "wp-codebox/published-revision/v3" || payload.routes?.length !== routes.length) {
    throw new Error(`Canonical publication failed: status=${response.status} payload=${JSON.stringify(payload)}.`)
  }
  return payload
}

async function timedWordPressPage(target, label) {
  const startedAt = performance.now()
  const response = await request(target)
  const body = await response.text()
  assertNoPhpDiagnostics(body, label)
  if (response.status !== 200 || !response.headers.get("content-type")?.includes("text/html") || !/<html[\s>]/i.test(body)) throw new Error(`Expected an HTML ${label}, received ${response.status}: ${body}`)
  return { body, elapsedMs: Math.round(performance.now() - startedAt), cacheStatus: response.headers.get("x-wp-codebox-page-cache") }
}

async function assertExplanatoryHomepage(html) {
  for (const text of [
    "Cloudflare WordPress Runtime",
    "WordPress at the edge, with durable Markdown state",
    "Follow a request",
    "The durability boundary",
    "What this deployment proves",
    "Current operating envelope",
  ]) assertIncludes(html, text, "explanatory homepage")
  const inlineCss = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((match) => match[1]).join("\n")
  const stylesheetUrls = [...html.matchAll(/<link\b[^>]*?\brel=["'][^"']*stylesheet[^"']*["'][^>]*?\bhref=["']([^"']+)["']|<link\b[^>]*?\bhref=["']([^"']+)["'][^>]*?\brel=["'][^"']*stylesheet/gi)].map((match) => match[1] || match[2])
  const linkedCss = []
  for (const stylesheet of stylesheetUrls) {
    const response = await request(new URL(stylesheet, origin))
    const body = await response.text()
    if (!response.ok || !response.headers.get("content-type")?.includes("text/css")) throw new Error(`Explanatory homepage stylesheet failed: ${stylesheet} (${response.status}).`)
    linkedCss.push(body)
  }
  const css = `${inlineCss}\n${linkedCss.join("\n")}`
  for (const [block, signature] of [
    ["list", /ol,ul\{box-sizing:border-box\}/],
    ["columns", /\.wp-block-columns\{align-items:normal/],
    ["buttons", /\.wp-block-buttons\{box-sizing:border-box/],
    ["navigation", /\.wp-block-navigation\{position:relative/],
  ]) if (!signature.test(css)) throw new Error(`Explanatory homepage omitted the core ${block} block stylesheet.`)
}

async function assertAuthenticatedDashboard(target) {
  const response = await request(target)
  const body = await response.text()
  assertNoPhpDiagnostics(body, "wp-admin")
  if (response.url.includes("wp-login.php") || response.redirected || response.status !== 200 || !/id=["']wpadminbar["']/.test(body) || !/id=["']dashboard-widgets["']/.test(body)) {
    throw new Error(`Expected an authenticated wp-admin dashboard, received ${response.status} at ${response.url}; cookie names: ${cookieNames().join(", ")}`)
  }
  return body
}

async function assertLinkedAssets(html, label) {
  const links = [...html.matchAll(/<(?:link|script)\b[^>]*?\b(?:href|src)=["']([^"']+\.(?:css|js)(?:\?[^"']*)?)["']/gi)]
  const representatives = [links.find((match) => /\.css(?:\?|$)/i.test(match[1])), links.find((match) => /\.js(?:\?|$)/i.test(match[1]))]
  if (representatives.some((match) => !match)) throw new Error(`Expected ${label} HTML to link both CSS and JavaScript assets.`)
  for (const match of representatives) {
    const response = await request(new URL(match[1], origin))
    const body = await response.text()
    assertNoPhpDiagnostics(body, `${label} asset ${match[1]}`)
    if (!response.ok || !body.length) throw new Error(`Missing ${label} asset ${match[1]}: ${response.status}`)
    if (response.headers.get("x-wp-codebox-static") !== "r2-range") throw new Error(`${label} asset ${match[1]} did not bypass PHP through the WordPress R2 range path.`)
  }
}

async function assertStaticResponseSemantics() {
  const asset = `${origin}/wp-includes/js/jquery/jquery.min.js?ver=3.7.1`
  const get = await request(asset)
  if (!get.ok || !get.headers.get("content-type")?.includes("javascript") || get.headers.get("x-wp-codebox-static") !== "r2-range" || !get.headers.get("cache-control")?.includes("immutable") || !get.headers.get("etag")) throw new Error(`Unexpected static asset response: ${get.status}`)
  const getBody = Buffer.from(await get.arrayBuffer())
  if (get.headers.get("etag") !== `"${createHash("sha256").update(getBody).digest("hex")}"`) throw new Error("Static GET ETag did not match the served bytes.")
  const head = await request(asset, { method: "HEAD" })
  const headBody = await head.text()
  if (!head.ok || head.headers.get("x-wp-codebox-static") !== "r2-range" || head.headers.get("content-length") !== String(getBody.byteLength) || head.headers.get("etag") !== get.headers.get("etag") || headBody !== "") {
    throw new Error(`Static HEAD did not preserve headers with an empty body: status=${head.status} source=${head.headers.get("x-wp-codebox-static")} get-bytes=${getBody.byteLength} head-length=${head.headers.get("content-length")} body=${headBody.length}.`)
  }
  const missing = await request(`${origin}/wp-includes/js/does-not-exist.min.js`)
  if (missing.status !== 404) throw new Error(`Missing static archive asset returned ${missing.status}, not 404.`)
  const source = await request(`${origin}/wp-includes/version.php`)
  if (source.headers.get("x-wp-codebox-static") === "r2-range") throw new Error("Static handler exposed a PHP source file.")
}

async function request(target, options = {}) {
  const headers = new Headers(options.headers)
  const requestUrl = new URL(target)
  const requestCookies = cookiesFor(requestUrl)
  if (requestCookies.length) headers.set("cookie", requestCookies.join("; "))
  const response = await fetch(target, { ...options, headers })
  const setCookies = response.headers.getSetCookie?.()
  if (!setCookies) throw new Error("The local gate requires Headers.getSetCookie() to preserve distinct WordPress login cookies.")
  for (const cookie of setCookies) storeCookie(cookie, requestUrl)
  if (new URL(target).pathname === "/wp-login.php" && options.method === "POST") console.log(`Login response cookie names: ${cookieNames().join(", ")}`)
  return response
}

function storeCookie(header, requestUrl) {
  const parts = header.split(";").map((part) => part.trim())
  const separator = parts[0].indexOf("=")
  if (separator <= 0) throw new Error("Invalid Set-Cookie header.")
  const name = parts[0].slice(0, separator)
  const value = parts[0].slice(separator + 1)
  const attributes = new Map(parts.slice(1).map((part) => {
    const index = part.indexOf("=")
    return [index === -1 ? part.toLowerCase() : part.slice(0, index).toLowerCase(), index === -1 ? "" : part.slice(index + 1)]
  }))
  const hostOnly = !attributes.has("domain")
  const domain = (attributes.get("domain") || requestUrl.hostname).replace(/^\./, "").toLowerCase()
  if (!hostOnly && requestUrl.hostname !== domain && !requestUrl.hostname.endsWith(`.${domain}`)) throw new Error(`Set-Cookie domain ${domain} does not match ${requestUrl.hostname}.`)
  const path = attributes.get("path") || requestUrl.pathname.slice(0, requestUrl.pathname.lastIndexOf("/") + 1) || "/"
  const expires = attributes.get("max-age") === "0" ? 0 : attributes.has("expires") ? Date.parse(attributes.get("expires")) : undefined
  const index = cookies.findIndex((cookie) => cookie.name === name && cookie.domain === domain && cookie.path === path)
  if (expires === 0 || (expires && expires <= Date.now())) {
    if (index !== -1) cookies.splice(index, 1)
    return
  }
  const cookie = { name, value, domain, hostOnly, path, secure: attributes.has("secure"), expires }
  if (index === -1) cookies.push(cookie)
  else cookies[index] = cookie
}

function cookiesFor(url) {
  return cookies.filter((cookie) => (!cookie.secure || url.protocol === "https:") && (url.hostname === cookie.domain || (!cookie.hostOnly && url.hostname.endsWith(`.${cookie.domain}`))) && url.pathname.startsWith(cookie.path) && (!cookie.expires || cookie.expires > Date.now())).map((cookie) => `${cookie.name}=${cookie.value}`)
}

function cookieNames() {
  return cookies.map((cookie) => cookie.name).sort()
}

function assertIncludes(html, expected, label) {
  assertNoPhpDiagnostics(html, label)
  if (!html.includes(expected)) throw new Error(`${label} did not contain ${JSON.stringify(expected)}.`)
}

function assertNoPhpDiagnostics(body, label) {
  if (/<b>(?:Warning|Fatal error|Parse error|Deprecated)<\/b>:/i.test(body)) throw new Error(`PHP diagnostics in ${label}: ${body}`)
}
