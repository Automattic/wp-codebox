import { spawn } from "node:child_process"
import { createHash, createHmac } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stripVTControlCharacters } from "node:util"
import { encodeZip } from "@php-wasm/stream-compression"
import { runVisualCompareCommand } from "../packages/runtime-playground/dist/browser-visual-compare.js"
import publicationContract from "../packages/runtime-cloudflare/src/publication-contract.json" with { type: "json" }

const port = 8792
const origin = `http://127.0.0.1:${port}`
const password = "cloudflare-runtime-test-password"
const authSecret = "cloudflare-runtime-test-auth-secret"
const operatorToken = "cloudflare-runtime-test-operator-token"
const apiToken = "cloudflare-runtime-test-api-token"
const administratorClaimSecret = "cloudflare-runtime-test-administrator-claim-secret"
const maxScheduledPostTicks = 10
const runtimeQueueSchema = "wp-codebox/runtime-dispatch/v1"
const runtimeDispatchAttempts = new Map()
const coordinator = process.argv.includes("--coordinator=d1") ? "d1" : "durable-object"
const publicProvisioning = process.argv.includes("--public-provisioning")
const artifactPath = process.argv.find((argument) => argument.startsWith("--artifact="))?.slice("--artifact=".length)
const executionWranglerConfig = coordinator === "d1" ? "packages/runtime-cloudflare/wrangler.d1.jsonc" : "packages/runtime-cloudflare/wrangler.jsonc"
const controlWranglerConfig = "packages/runtime-cloudflare/wrangler.control.jsonc"
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
  await startWorker(!publicProvisioning && coordinator === "durable-object", publicProvisioning ? controlWranglerConfig : executionWranglerConfig)
  if (publicProvisioning) {
    await assertPublicProvisioning(staticArtifactImport)
    console.log("Cloudflare public provisioning gate passed: authenticated artifact staging, idempotent site allocation, initial publication, cold-restart site read, administrator claim, native-block edit, automatic republication, and post-restart persistence.")
  } else {
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
  if (coordinator === "d1") {
    const automaticallyPublishedPost = await waitForPublication(new URL(post.route, origin), updatedPost.title, "automatically republished post", 15, updatedPost.publicationJob)
    assertIncludes(automaticallyPublishedPost, updatedPost.title, "automatically republished post")
    post.title = updatedPost.title
  }
  // Local Wrangler queues are process-local; restart after promotion proves the
  // canonical state and immutable R2 publication survive isolate replacement.
  await stopWorker()
  await startWorker()
  const restartedAdmin = await assertAuthenticatedDashboard(new URL("/wp-admin/", origin))
  await assertRestorePackHydration("repeated canonical mutations after restart")
  if (coordinator === "durable-object") {
    await assertCanonicalPost(post.id, updatedPost.title, restartedAdmin, "updated post after restart")
  }
  await assertHealthResponse()
  await assertLinkedAssets(frontPage, "front-end")
  await assertLinkedAssets(adminHtml, "admin")
  await assertLinkedAssets(editorHtml, "editor")
  await assertStaticResponseSemantics()
  const restartedPost = await assertPublishedWordPressPage(new URL(post.route, origin), "post after publication restart", ["publication-r2", "publication-edge"])
  assertIncludes(restartedPost, post.title, "post after cold restart")
  await assertMediaFile(media, "media after cold restart")
  await assertMediaMetadata(media, "media metadata after cold restart")
  await assertDurablePlugin("plugin after cold restart")
  await assertDurablePluginAsset("plugin asset after cold restart")
  await assertDeletedThemeFile(deletedThemePath, "bundled theme tombstone after cold restart")
  if (coordinator === "d1") { await stopWorker(); await startWorker(true) }
  await assertScheduledPost(scheduledPost.id, "draft", 0, scheduledPost.timestamp, "scheduled post before cron")
  await runScheduledCronUntilPost(scheduledPost.id)
  await assertScheduledPostEventually(scheduledPost.id, "publish", 1, false, "scheduled post after cron")
  await assertLinkedAssets(restartedAdmin, "admin after cold restart")
  await stopWorker()

  await startWorker(true)
  await assertScheduledPost(scheduledPost.id, "publish", 1, false, "scheduled post after cron restart")
  await runScheduledCron()
  await assertScheduledPost(scheduledPost.id, "publish", 1, false, "scheduled post after duplicate cron trigger")
  if (coordinator === "d1") { await stopWorker(); await startWorker() }
  cookies.length = 0
  const finalAdmin = await login()
  console.log(`Static artifact import starting for ${coordinator}.`)
  const imported = await importStaticArtifact(staticArtifactImport)
  console.log(`Static artifact import committed for ${coordinator}.`)
  console.log(`Static artifact receipt: ${JSON.stringify({ pages: imported.pages, themeSlug: imported.themeSlug, quality: imported.quality })}`)
  const importedPages = await assertImportedArtifactPages(finalAdmin, imported)
  console.log(`Static artifact pages are editable for ${coordinator}.`)
  if (coordinator === "d1") {
    const importedPublication = await waitForPublication(new URL(importedPages.secondary.route, origin), "Public reads are cheap.", "imported static artifact publication", 12, imported.publicationJob)
    assertIncludes(importedPublication, "Public reads are cheap.", "imported static artifact publication")
    console.log("Static artifact publication promoted for d1.")
  }
  await stopWorker()
  await startWorker()
  const importedAdmin = await login()
  await assertImportedArtifactPages(importedAdmin, imported)
  const duplicateStateBefore = await (await fetch(`${origin}/?phase=r2-state`)).json()
  const duplicate = await importStaticArtifact(staticArtifactImport, coordinator === "d1" ? 202 : 200)
  const duplicateStateAfter = await (await fetch(`${origin}/?phase=r2-state`)).json()
  const convergedReplay = coordinator === "d1"
    ? duplicate.status === "imported" && duplicate.operationId === imported.operationId && JSON.stringify(duplicate.durableReceipt) === JSON.stringify(imported.durableReceipt)
    : duplicate.status === "duplicate"
  if (!convergedReplay || duplicateStateAfter.version !== duplicateStateBefore.version || duplicateStateAfter.pointer?.revision !== duplicateStateBefore.pointer?.revision) throw new Error("Idempotent static artifact import did not converge on its durable receipt and canonical state.")
  const conflicting = await importStaticArtifact({ ...staticArtifactImport, import: { ...staticArtifactImport.import, slug: "different-artifact-site" } }, 409)
  const conflictStateAfter = await (await fetch(`${origin}/?phase=r2-state`)).json()
  if (conflicting.status !== "conflict" || conflictStateAfter.version !== duplicateStateBefore.version || conflictStateAfter.pointer?.revision !== duplicateStateBefore.pointer?.revision) throw new Error("Conflicting static artifact replay changed canonical state.")
  await assertTwoSiteIsolation()
  assertRuntimePhaseTraceSummaries()
  console.log(`Cloudflare local runtime gate passed with ${coordinator} coordination: canonical full-boot probe, one-pack restore hydration after repeated mutations, explanatory homepage, complete block styles, coordinator-free R2 publication reads, login, dashboard, post editor, concurrent canonical mutations, authenticated REST post and media creation, plugin ZIP installation and activation, direct R2 upload serving, frontend/admin/editor assets, cold-restart persistence, and bounded durable scheduled callback execution.`)
  }
} finally {
  await stopWorker()
  if (process.env.CLOUDFLARE_GATE_PRESERVE) console.log(`Preserved Cloudflare local gate evidence at ${stateDirectory}.`)
  else await rm(stateDirectory, { recursive: true, force: true })
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const childProcess = spawn(command, args, { cwd: process.cwd(), stdio: "inherit" })
    childProcess.on("error", reject)
    childProcess.on("exit", (code) => code === 0 ? resolve(undefined) : reject(new Error(`${command} ${args.join(" ")} failed with status ${code}.`)))
  })
}

async function provisionStaticArtifact() {
  const stylesheet = `
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;font-family:Arial,sans-serif;background:#f5f2e8;color:#17211b}
a{color:inherit}
.site-header{display:flex;align-items:center;justify-content:space-between;padding:18px 32px;border-bottom:2px solid #17211b;background:#fff}
.site-header nav{display:flex;gap:24px}.site-header a{text-decoration:none}
.brand{font-size:17px;font-weight:800;letter-spacing:-.02em}.brand:before{content:'W';display:inline-grid;place-items:center;width:30px;height:30px;margin-right:10px;background:#3157ff;color:#fff;border-radius:6px}
.site-header nav a{font-size:14px;font-weight:700}
main{max-width:1180px;margin:0 auto;padding:32px}
.hero{display:grid;grid-template-columns:1.3fr .7fr;gap:28px;padding:52px;border:2px solid #17211b;border-radius:24px;background:#172b5f;color:#fff;box-shadow:8px 8px 0 #17211b}
.eyebrow,.proof-kicker,.section-kicker,.step-number{font-size:12px;line-height:1.2;font-weight:800;letter-spacing:.14em;text-transform:uppercase}
.eyebrow{display:inline-block;margin:0 0 20px;padding:8px 11px;border:1px solid #9fb0ff;border-radius:999px;color:#dbe2ff}
h1{max-width:760px;margin:0 0 20px;font-size:54px;line-height:1;letter-spacing:-.05em}
h2{margin:0;font-size:34px;line-height:1.05;letter-spacing:-.035em}h3{margin:0 0 10px;font-size:19px}p{font-size:17px;line-height:1.55;margin:0}
.lede{max-width:690px;color:#dbe2ff}.actions{display:flex;align-items:center;gap:16px;margin-top:28px}.status{font-size:13px;font-weight:700;color:#dbe2ff}
.cta{display:inline-block;padding:13px 18px;border:2px solid #17211b;border-radius:8px;background:#d9ff57;color:#17211b;font-weight:800;text-decoration:none;box-shadow:4px 4px 0 #17211b}
.proof-card{padding:24px;border:2px solid #17211b;border-radius:16px;background:#fff;color:#17211b}
.proof-image{display:block;width:86px;height:86px;margin-bottom:24px;border-radius:14px}.proof-kicker{margin-bottom:6px;color:#516057}.artifact-name{font-size:21px;font-weight:800}.proof-row{display:flex;justify-content:space-between;gap:16px;padding:12px 0;border-top:1px solid #cdd4cf}.proof-row:first-of-type{margin-top:18px}.proof-label{font-size:13px;color:#607068}.proof-value{font-size:13px;font-weight:800;text-align:right}
.flow{padding:72px 0 24px}.section-heading{display:grid;grid-template-columns:.65fr 1.35fr;gap:28px;align-items:end;margin-bottom:28px}.section-kicker{color:#3157ff}.section-intro{color:#526057}
.steps{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.step{min-height:190px;padding:22px;border:2px solid #17211b;border-radius:14px;background:#fff}.step-number{margin-bottom:38px;color:#3157ff}.step p:last-child{font-size:14px;color:#526057}
.comparison{margin-top:48px}.compare-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:24px}.compare-card{padding:24px;border:2px solid #17211b;border-radius:14px;background:#fff}.compare-card.current{background:#d9ff57}.compare-title{min-height:48px}.compare-row{padding:12px 0;border-top:1px solid #aeb8b1}.compare-label{margin-bottom:3px;font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#526057}.compare-value{font-size:14px;font-weight:700}
.detail-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:28px}.detail-card{padding:24px;border:2px solid #17211b;border-radius:14px;background:#fff}.detail-card p{font-size:15px;color:#526057}.evidence{margin-top:32px;padding:28px;border:2px solid #17211b;border-radius:16px;background:#d9ff57}.evidence p{margin-top:10px}
.site-footer{display:flex;align-items:center;justify-content:space-between;margin-top:56px;padding:22px 32px;background:#17211b;color:#fff}.site-footer p,.site-footer a{font-size:13px}.site-footer a{font-weight:700;text-decoration:none}
@media(max-width:760px){.site-header,.site-footer{padding:16px 20px}.site-header nav{gap:14px}main{padding:20px}.hero{grid-template-columns:1fr;padding:30px;box-shadow:5px 5px 0 #17211b}h1{font-size:40px}.actions{align-items:flex-start;flex-direction:column}.section-heading{grid-template-columns:1fr}.steps,.detail-grid{grid-template-columns:1fr 1fr}.compare-grid{grid-template-columns:1fr}.site-footer{align-items:flex-start;flex-direction:column;gap:8px}}
@media(max-width:480px){.site-header nav a:first-child{display:none}.steps,.detail-grid{grid-template-columns:1fr}.hero{padding:24px}h1{font-size:35px}}
`.trim()
  const proofSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="16" fill="#3157ff"/><path d="M23 24h34l16 16v32H23z" fill="#fff"/><path d="M57 24v17h16M33 51h30M33 60h23" fill="none" stroke="#3157ff" stroke-width="5" stroke-linejoin="round"/><circle cx="69" cy="69" r="15" fill="#d9ff57" stroke="#17211b" stroke-width="4"/><path d="M62 69l5 5 10-12" fill="none" stroke="#17211b" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  const homeContent = `<section class="hero"><div><p class="eyebrow">Architecture explainer</p><h1>How WordPress Playground runs on Cloudflare Workers.</h1><p class="lede">The familiar Playground runtime normally runs WordPress in a browser tab. Here, the same PHP WebAssembly approach runs inside a Cloudflare Worker. Codebox connects that disposable runtime to durable storage, request routing, and publication.</p><div class="actions"><a class="cta" href="/about/">Follow one request</a><p class="status">This website is also the imported test input.</p></div></div><aside class="proof-card"><img class="proof-image" src="assets/proof.svg" alt="WordPress runtime architecture"><p class="proof-kicker">Where each part runs</p><p class="artifact-name">Playground, server-side</p><div class="proof-row"><p class="proof-label">PHP + WordPress</p><p class="proof-value">WebAssembly in the Worker</p></div><div class="proof-row"><p class="proof-label">Current revision</p><p class="proof-value">Coordinated in D1</p></div><div class="proof-row"><p class="proof-label">Files + public pages</p><p class="proof-value">Stored immutably in R2</p></div></aside></section><section class="flow" id="proof"><div class="section-heading"><div><p class="section-kicker">The request lifecycle</p><h2>A disposable runtime with durable WordPress state.</h2></div><p class="section-intro">The Worker can disappear after any request. Persistence comes from reconstructing WordPress from canonical files, not from pretending the Worker has a permanent disk.</p></div><div class="steps"><article class="step"><p class="step-number">01 / Route</p><h3>Classify the request</h3><p>Published anonymous pages can come straight from R2. Admin, REST, preview, and mutation requests continue into WordPress.</p></article><article class="step"><p class="step-number">02 / Boot</p><h3>Start Playground</h3><p>The Worker loads pinned PHP and WordPress artifacts, then rebuilds a disposable SQLite index from canonical state.</p></article><article class="step"><p class="step-number">03 / Execute</p><h3>Run real WordPress</h3><p>Playground translates the HTTP request into PHP. Core, plugins, authentication, REST, and wp-admin run normally.</p></article><article class="step"><p class="step-number">04 / Commit</p><h3>Persist mutations</h3><p>Codebox writes immutable canonical files to R2, then conditionally advances the site revision coordinated by D1.</p></article></div></section><section class="comparison"><div class="section-heading"><div><p class="section-kicker">What is different</p><h2>Three ways to run WordPress.</h2></div><p class="section-intro">All three run WordPress. They differ in where PHP executes, what remains alive between requests, and how state becomes durable.</p></div><div class="compare-grid"><article class="compare-card"><h3 class="compare-title">Typical WordPress hosting</h3><div class="compare-row"><p class="compare-label">PHP runs on</p><p class="compare-value">A long-running web server</p></div><div class="compare-row"><p class="compare-label">State lives in</p><p class="compare-value">A persistent database and filesystem</p></div><div class="compare-row"><p class="compare-label">Between requests</p><p class="compare-value">The server and disk remain available</p></div></article><article class="compare-card"><h3 class="compare-title">Playground at playground.wordpress.net</h3><div class="compare-row"><p class="compare-label">PHP runs on</p><p class="compare-value">WebAssembly in your browser tab</p></div><div class="compare-row"><p class="compare-label">State lives in</p><p class="compare-value">The browser session unless saved or exported</p></div><div class="compare-row"><p class="compare-label">Between visits</p><p class="compare-value">The interactive runtime is client-scoped</p></div></article><article class="compare-card current"><h3 class="compare-title">Playground on Cloudflare Workers</h3><div class="compare-row"><p class="compare-label">PHP runs on</p><p class="compare-value">WebAssembly inside a Worker</p></div><div class="compare-row"><p class="compare-label">State lives in</p><p class="compare-value">Canonical R2 objects with a D1 revision pointer</p></div><div class="compare-row"><p class="compare-label">Between requests</p><p class="compare-value">The runtime may vanish; the site does not</p></div></article></div></section>`
  const aboutContent = `<section class="hero"><div><p class="eyebrow">Follow one request</p><h1>Public reads are cheap. WordPress boots when it is needed.</h1><p class="lede">A published visitor request can be answered from an immutable R2 page snapshot without starting PHP. Editing, REST, previews, and unpublished routes boot Playground and execute WordPress inside the Worker.</p><div class="actions"><a class="cta" href="/">Back to the architecture</a><p class="status">Codebox owns the lifecycle around Playground.</p></div></div><aside class="proof-card"><img class="proof-image" src="../assets/proof.svg" alt="Cloudflare request lifecycle"><p class="proof-kicker">A dynamic request</p><p class="artifact-name">Boot, run, commit</p><div class="proof-row"><p class="proof-label">Runtime disk</p><p class="proof-value">Disposable memory</p></div><div class="proof-row"><p class="proof-label">SQLite</p><p class="proof-value">Rebuildable index</p></div><div class="proof-row"><p class="proof-label">Source of truth</p><p class="proof-value">Canonical files in R2</p></div></aside></section><section class="flow"><div class="section-heading"><div><p class="section-kicker">The important boundaries</p><h2>Cloudflare services have narrow jobs.</h2></div><p class="section-intro">No single Cloudflare primitive acts like a traditional server. The pieces compose around a normal WordPress request.</p></div><div class="detail-grid"><article class="detail-card"><h3>Worker: execute</h3><p>Loads PHP-WASM, WordPress, and Playground request handling for dynamic traffic. Its memory is an optimization, never the source of truth.</p></article><article class="detail-card"><h3>D1: coordinate</h3><p>Stores the current revision pointer, version, leases, and operation progress so concurrent mutations cannot overwrite each other.</p></article><article class="detail-card"><h3>R2: preserve and serve</h3><p>Stores content-addressed canonical files, WordPress assets, uploaded media, and immutable snapshots for published routes.</p></article></div><section class="evidence"><h2>How this page proves the explanation.</h2><p>The gate imports this HTML site into native Gutenberg blocks, compares the source and WordPress render pixel for pixel, edits this second page through authenticated WordPress APIs, republishes it, kills the Worker, starts a new one, and verifies the public edit and raw block content survived.</p></section></section>`
  const document = ({ title, secondary, content }) => {
    const assetRoot = secondary ? "../assets" : "assets"
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="stylesheet" href="${assetRoot}/site.css"></head><body><header class="site-header"><a class="brand" href="/">Playground on Cloudflare Workers</a><nav><a href="/#proof">How it works</a><a href="/about/">Evidence</a></nav></header><main>${content}</main><footer class="site-footer"><p>WordPress Playground running on Cloudflare Workers.</p><a href="/about/">Read the acceptance proof</a></footer></body></html>`
  }
  const fixture = {
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
      content: document({ title: "WordPress Playground on Cloudflare Workers", secondary: false, content: homeContent }),
    }, {
      path: "website/about/index.html",
      role: "document",
      kind: "html",
      mime_type: "text/html",
      encoding: "utf-8",
      content: document({ title: "How the Cloudflare Workers Proof Works", secondary: true, content: aboutContent }),
    }, {
      path: "website/assets/site.css",
      role: "asset",
      kind: "css",
      mime_type: "text/css",
      encoding: "utf-8",
      content: stylesheet,
    }, {
      path: "website/assets/proof.svg",
      role: "asset",
      kind: "image",
      mime_type: "image/svg+xml",
      encoding: "utf-8",
      content: proofSvg,
    }],
  }
  const serialized = artifactPath ? await readFile(artifactPath, "utf8") : JSON.stringify(fixture)
  const artifact = JSON.parse(serialized)
  if (artifact?.schema !== "blocks-engine/php-transformer/site-artifact/v1") throw new Error(`The provisioning artifact at ${artifactPath} does not use the canonical portable schema.`)
  const sha256 = createHash("sha256").update(serialized).digest("hex")
  const key = `sites/default/import-artifacts/${sha256}.json`
  if (!publicProvisioning) {
    const path = join(stateDirectory, "static-site-artifact.json")
    await writeFile(path, serialized)
    await run("npm", ["exec", "--", "wrangler", "r2", "object", "put", `wp-codebox-runtime-chubes/${key}`, "--file", path, "--local", "--persist-to", stateDirectory])
  }
  const request = {
    schema: "wp-codebox/cloudflare-static-artifact-import-request/v1",
    idempotencyKey: `cloudflare-static-artifact-${sha256}`,
    artifact: { r2Key: key, sha256, size: Buffer.byteLength(serialized) },
    import: { slug: "playground-cloudflare-proof", name: "WordPress Playground on Cloudflare Workers", siteTitle: "WordPress Playground on Cloudflare Workers" },
  }
  return publicProvisioning ? { ...request, serialized } : request
}

async function assertPublicProvisioning(input) {
  const authorization = { authorization: `Bearer ${apiToken}` }
  const expectedPageCount = JSON.parse(input.serialized).files.filter((file) => file.path.endsWith(".html")).length
  const stagedResponse = await fetch(`${origin}/v1/artifacts/${input.artifact.sha256}`, {
    method: "PUT",
    headers: { ...authorization, "content-type": "application/json" },
    body: input.serialized,
  })
  const stagedBody = await stagedResponse.text()
  if (stagedResponse.status !== 200) throw new Error(`Public artifact staging failed: ${stagedResponse.status} ${stagedBody}.`)
  const staged = JSON.parse(stagedBody)
  if (staged.schema !== "wp-codebox/provisioning-artifact/v1" || staged.artifact?.sha256 !== input.artifact.sha256 || staged.artifact?.size !== input.artifact.size
    || staged.artifact?.r2Key !== `sites/provisioning/import-artifacts/${input.artifact.sha256}.json`) {
    throw new Error(`Public artifact staging returned an invalid reference: ${stagedBody}.`)
  }

  const idempotencyKey = `cloudflare-public-provisioning-${input.artifact.sha256}`
  const requestBody = JSON.stringify({ schema: "wp-codebox/provisioning-create-request/v1", idempotencyKey, artifact: staged.artifact, import: input.import })
  const createSite = () => fetch(`${origin}/v1/sites`, { method: "POST", headers: { ...authorization, "content-type": "application/json", "idempotency-key": idempotencyKey }, body: requestBody })
  const createdResponse = await createSite()
  const createdBody = await createdResponse.text()
  if (createdResponse.status !== 202) throw new Error(`Public site creation failed: ${createdResponse.status} ${createdBody}.`)
  const created = JSON.parse(createdBody)
  if (created.schema !== "wp-codebox/provisioning-site/v1" || created.site?.id !== "default" || typeof created.site.operation !== "string"
    || typeof created.site.administratorClaim?.token !== "string") throw new Error(`Public site creation returned an invalid resource: ${createdBody}.`)
  const replayResponse = await createSite()
  const replayBody = await replayResponse.text()
  if (replayResponse.status !== 202 || replayBody !== createdBody) throw new Error(`Public site creation replay did not converge: ${replayResponse.status} ${replayBody}.`)

  let operation
  const operationId = new URL(created.site.operation, origin).pathname.split("/").at(-1)
  if (!operationId || !/^[0-9a-f-]{36}$/.test(operationId)) throw new Error(`Public provisioning operation URL omitted its identity: ${created.site.operation}.`)
  await stopWorker()
  await startWorker(false, executionWranglerConfig)
  for (let tick = 0; tick < 8; tick++) {
    if (operation?.receipt?.publication?.status === "pending") await runRuntimeDispatch("publication", operation.receipt.publication.jobKey)
    else await runRuntimeDispatch("operation", operationId)
    const response = await request(`${origin}/?phase=operator-static-artifact-operation&operationId=${encodeURIComponent(operationId)}`, { headers: { authorization: `Bearer ${operatorToken}` } })
    const body = await response.text()
    if (!response.ok) throw new Error(`Public provisioning operation read failed: ${response.status} ${body}.`)
    operation = JSON.parse(body)
    if (operation?.state === "succeeded") break
    if (operation?.state === "failed") throw new Error(`Public provisioning operation failed: ${body}.`)
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  const imported = operation?.receipt?.ssiResult
  if (operation?.state !== "succeeded" || imported?.status !== "imported" || imported.staticSiteImporterVersion !== "1.3.6" || !imported.themeSlug
    || !imported.pages || Object.keys(imported.pages).length !== expectedPageCount || Object.values(imported.quality ?? {}).some((count) => count !== 0)
    || operation.receipt?.publication?.status !== "promoted") {
    throw new Error(`Public provisioning did not produce a terminal import receipt: ${JSON.stringify(operation)}.`)
  }

  await stopWorker()
  await startWorker(false, controlWranglerConfig)
  const operationResponse = await fetch(new URL(created.site.operation, origin), { headers: authorization })
  const operationBody = await operationResponse.text()
  const controlOperation = JSON.parse(operationBody).operation
  if (!operationResponse.ok || JSON.stringify(controlOperation?.receipt) !== JSON.stringify(operation.receipt)) throw new Error(`Control plane did not expose the execution receipt: ${operationResponse.status} ${operationBody}.`)
  const siteResponse = await fetch(`${origin}/v1/sites/${created.site.id}`, { headers: authorization })
  const siteBody = await siteResponse.text()
  const site = JSON.parse(siteBody)
  if (!siteResponse.ok || site.site?.status !== "ready" || site.site?.administratorClaim?.state !== "pending" || siteBody.includes(created.site.administratorClaim.token)) {
    throw new Error(`Cold-restart public site read returned invalid state: ${siteResponse.status} ${siteBody}.`)
  }
  const claimResponse = await fetch(new URL(created.site.administratorClaim.url, origin), { method: "POST", headers: { authorization: `Bearer ${created.site.administratorClaim.token}` } })
  const claimBody = await claimResponse.text()
  const claim = JSON.parse(claimBody)
  if (!claimResponse.ok || claim.credential?.username !== "admin" || claim.credential?.password !== password) throw new Error(`Administrator claim failed: ${claimResponse.status} ${claimBody}.`)
  await stopWorker()
  await startWorker(false, executionWranglerConfig)
  const adminHtml = await login(claim.credential.password)
  const importedPages = await assertImportedArtifactPages(adminHtml, imported)
  await assertStaticArtifactVisualParity(input.serialized, importedPages)
  const edited = await updateImportedPage(adminHtml, importedPages.secondary)
  const published = await waitForPublication(new URL(edited.route, origin), edited.marker, "provisioned site edit publication", 12, edited.publicationJob)
  assertIncludes(published, edited.marker, "provisioned site edit publication")
  await stopWorker()
  await startWorker()
  const persisted = await assertPublishedWordPressPage(new URL(edited.route, origin), "provisioned site edit after restart", ["publication-r2", "publication-edge"])
  assertIncludes(persisted, edited.marker, "provisioned site edit after restart")
  const restartedAdmin = await assertAuthenticatedDashboard(new URL("/wp-admin/", origin))
  const persistedPages = await assertImportedArtifactPages(restartedAdmin, imported, false)
  const persistedEdit = [persistedPages.primary, persistedPages.secondary].find((page) => page.id === edited.id)
  if (!persistedEdit?.raw.includes(edited.marker)) throw new Error(`Provisioned site edit was not retained as editable block content after restart: ${JSON.stringify(persistedPages)}.`)
}

async function assertStaticArtifactVisualParity(serialized, importedPages) {
  const artifact = JSON.parse(serialized)
  const root = `${(artifact.root ?? "website").replace(/\/$/, "")}/`
  const files = new Map(artifact.files.map((file) => {
    const relativePath = file.path.startsWith(root) ? file.path.slice(root.length) : file.path
    const bytes = typeof file.content === "string" ? Buffer.from(file.content) : Buffer.from(file.content_base64 ?? "", "base64")
    return [relativePath, { bytes, mimeType: file.mime_type ?? "application/octet-stream" }]
  }))
  const routes = new Map()
  for (const [relativePath, file] of files) {
    if (!relativePath.endsWith(".html")) continue
    const route = relativePath === "index.html" ? "/" : relativePath.endsWith("/index.html") ? `/${relativePath.slice(0, -"index.html".length)}` : `/${relativePath}`
    routes.set(route, file)
  }

  const sourceServer = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname
    const file = routes.get(pathname) ?? files.get(pathname.replace(/^\//, ""))
    if (!file) {
      response.writeHead(404).end("Not found")
      return
    }
    response.writeHead(200, { "content-type": file.mimeType, "content-length": String(file.bytes.length) })
    response.end(request.method === "HEAD" ? undefined : file.bytes)
  })
  await new Promise((resolve, reject) => {
    sourceServer.once("error", reject)
    sourceServer.listen(0, "127.0.0.1", resolve)
  })

  try {
    const address = sourceServer.address()
    if (!address || typeof address === "string") throw new Error("Static artifact parity server did not expose a loopback port.")
    const sourceOrigin = `http://127.0.0.1:${address.port}`
    for (const page of [importedPages.primary, importedPages.secondary]) {
      const route = new URL(page.route, origin).pathname
      if (!routes.has(route)) throw new Error(`Imported route ${route} has no exact source-artifact document.`)
      const artifactRoot = join(stateDirectory, "visual-parity", route === "/" ? "home" : route.replace(/^\/|\/$/g, "").replaceAll("/", "-"))
      const comparison = await runVisualCompareCommand({
        artifactRoot,
        server: {
          serverUrl: sourceOrigin,
          playground: { run: async () => ({ text: "" }) },
          async [Symbol.asyncDispose]() {},
        },
        spec: {
          command: "wordpress.visual-compare",
          args: [
            `source-url=${sourceOrigin}${route}`,
            `candidate-url=${origin}${route}`,
            "viewport=1280x720",
            "full-page=true",
            "threshold=0",
            "include-aa=true",
            "block-external-requests=true",
            "timeout=120s",
          ],
        },
      })
      const summary = JSON.parse(comparison.output)
      if (summary.status !== "identical" || summary.comparison?.mismatchPixels !== 0 || summary.comparison?.dimensionMismatch) {
        throw new Error(`Static artifact visual parity failed for ${route}: ${JSON.stringify({ status: summary.status, comparison: summary.comparison, files: summary.files, artifactRoot })}.`)
      }
      console.log(`Static artifact visual parity passed for ${route}: 0 mismatched pixels at 1280x720.`)
    }
  } finally {
    await new Promise((resolve, reject) => sourceServer.close((error) => error ? reject(error) : resolve()))
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

async function startWorker(testScheduled = coordinator === "durable-object", config = executionWranglerConfig) {
  output = ""
  const apiTokens = [{ id: "local-gate", principal: "local-gate", digest: createHash("sha256").update(apiToken).digest("hex"), scopes: ["sites:create", "sites:read", "sites:import", "operations:read"], expiresAt: "2099-01-01T00:00:00.000Z", maxSites: 1 }]
  const args = ["exec", "--", "wrangler", "dev", ...(testScheduled ? ["--test-scheduled"] : []), "--config", config, "--port", String(port), "--persist-to", stateDirectory, "--var", `WORDPRESS_ADMIN_PASSWORD:${password}`, "--var", `WORDPRESS_ADMIN_CLAIM_SECRET:${administratorClaimSecret}`, "--var", `WORDPRESS_AUTH_SECRET:${authSecret}`, "--var", `WORDPRESS_OPERATOR_TOKEN:${operatorToken}`, "--var", `WORDPRESS_API_TOKENS:${JSON.stringify(apiTokens)}`, "--var", `WORDPRESS_SITE_CONTEXTS:${JSON.stringify(siteContexts)}`]
  child = spawn("npm", args, {
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

async function login(candidatePassword = password) {
  await assertLoginForm()
  const form = new URLSearchParams({ log: "admin", pwd: candidatePassword, redirect_to: `${origin}/wp-admin/`, testcookie: "1", "wp-submit": "Log In" })
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

async function importStaticArtifact(input, expectedStatus = coordinator === "d1" ? 202 : 201) {
  const response = await fetch(`${origin}/?phase=operator-static-artifact-import`, {
    method: "POST",
    headers: { authorization: `Bearer ${operatorToken}`, "content-type": "application/json" },
    body: JSON.stringify(input),
  })
  const body = await response.text()
  if (response.status !== expectedStatus) throw new Error(`Static artifact import failed: ${response.status} ${body}.\nWorker output:\n${output}`)
  let result = JSON.parse(body)
  if (expectedStatus === 202) {
    if (typeof result.operationId !== "string") throw new Error(`Queued static artifact import omitted its operation ID: ${body}.`)
    const operationId = result.operationId
    for (let tick = 0; tick < 10; tick++) {
      await runRuntimeDispatch("operation", operationId)
      const operationResponse = await fetch(`${origin}/?phase=operator-static-artifact-operation&operationId=${encodeURIComponent(result.operationId)}`, {
        headers: { authorization: `Bearer ${operatorToken}` },
      })
      const operationBody = await operationResponse.text()
      if (!operationResponse.ok) throw new Error(`Queued static artifact operation read failed: ${operationResponse.status} ${operationBody}.`)
      const operation = JSON.parse(operationBody)
      if (operation.state === "succeeded") {
        result = { ...operation.receipt?.ssiResult, operationId, publicationJob: operation.receipt?.publication?.jobKey, durableReceipt: operation.receipt }
        break
      }
      if (operation.state === "publication-pending" && operation.receipt?.publication?.jobKey) await runRuntimeDispatch("publication", operation.receipt.publication.jobKey)
      if (operation.state === "failed") throw new Error(`Queued static artifact operation failed: ${operationBody}.`)
    }
  }
  const expectedResultStatus = expectedStatus === 200 ? "duplicate" : "imported"
  if (expectedStatus !== 409 && (!result || typeof result !== "object" || result.status !== expectedResultStatus || result.staticSiteImporterVersion !== "1.3.6" || !result.themeSlug
    || !result.pages || !Object.keys(result.pages).length || Object.values(result.quality ?? {}).some((count) => count !== 0)
    || (expectedStatus === 201 && (!response.headers.get("x-wp-codebox-canonical-revision") || !response.headers.get("x-wp-codebox-canonical-version"))))) {
    throw new Error(`Static artifact import returned invalid evidence: ${body}.`)
  }
  return result
}

async function assertImportedArtifactPages(adminHtml, imported, assertSourceMarkers = true) {
  const pageIds = Object.values(imported.pages ?? {}).filter(Number.isInteger)
  if (!pageIds.length) throw new Error(`Static artifact import did not return page IDs: ${JSON.stringify(imported)}.`)
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
  const primary = pages.find(({ route }) => route === "/")
  const secondary = pages.find(({ route }) => route !== "/")
  if (!primary || (pages.length > 1 && !secondary)) throw new Error(`Imported artifact routes are invalid: ${JSON.stringify(pages)}.`)
  if (assertSourceMarkers) {
    for (const marker of ["Typical WordPress hosting", "playground.wordpress.net", "Playground on Cloudflare Workers"]) {
      if (!primary.raw.includes(marker)) throw new Error(`Imported architecture explainer omitted ${marker}: ${primary.raw}.`)
    }
    for (const marker of ["Worker: execute", "D1: coordinate", "R2: preserve and serve"]) {
      if (!(secondary ?? primary).raw.includes(marker)) throw new Error(`Imported request explainer omitted ${marker}: ${(secondary ?? primary).raw}.`)
    }
  }
  return { primary, secondary: secondary ?? primary }
}

async function updateImportedPage(adminHtml, page) {
  const marker = `Provisioned site edit ${Date.now()}`
  const content = `<!-- wp:paragraph --><p>${marker}</p><!-- /wp:paragraph -->`
  const response = await request(`${origin}/wp-json/wp/v2/pages/${page.id}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-wp-nonce": restNonce(adminHtml) },
    body: JSON.stringify({ content, status: "publish" }),
  })
  const body = await response.text()
  assertNoPhpDiagnostics(body, "provisioned site page edit")
  if (response.status !== 200 || response.headers.get("x-wp-codebox-publication") !== "queued" || !response.headers.get("x-wp-codebox-publication-job")) {
    throw new Error(`Provisioned site page edit did not queue publication: status=${response.status} publication=${response.headers.get("x-wp-codebox-publication")} body=${body}.`)
  }
  const updated = JSON.parse(body)
  const raw = updated.content?.raw
  if (typeof raw !== "string" || !raw.includes(marker) || /<!-- wp:(?:html|freeform)\b/.test(raw)) throw new Error(`Provisioned site page edit was not retained as native block content: ${body}.`)
  const link = new URL(updated.link)
  return { id: page.id, marker, route: `${link.pathname}${link.search}`, publicationJob: response.headers.get("x-wp-codebox-publication-job") }
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
  return { title, publicationJob: response.headers.get("x-wp-codebox-publication-job") }
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

async function assertCanonicalPost(id, title, adminHtml, label) {
  const response = await request(`${origin}/wp-json/wp/v2/posts/${id}?context=edit`, { headers: { "x-wp-nonce": restNonce(adminHtml) } })
  const payload = await response.json()
  if (!response.ok || payload.title?.raw !== title) throw new Error(`Unexpected ${label}: status=${response.status} payload=${JSON.stringify(payload)}.`)
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
  for (let tick = 0; tick < maxScheduledPostTicks; tick++) {
    await runScheduledCron()
    const response = await request(`${origin}/wp-json/wp-codebox/v1/scheduled-post-status/${id}`)
    const payload = await response.json()
    if (response.ok && payload.status === "publish" && payload.runs === 1 && payload.next === false) return
  }
  throw new Error(`Scheduled post remained queued after ${maxScheduledPostTicks} bounded cron ticks.`)
}

async function waitForPublication(target, expected, label, maxPolls = 15, dispatchIdentity) {
  for (let poll = 0; poll < maxPolls; poll++) {
    if (dispatchIdentity) await runRuntimeDispatch("publication", dispatchIdentity)
    const response = await fetch(target)
    const body = await response.text()
    if (response.ok && ["publication-r2", "publication-edge"].includes(response.headers.get("x-wp-codebox-page-cache-source")) && body.includes(expected)) return body
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  const diagnostics = stripVTControlCharacters(output).split("\n").filter((line) => /publication|scheduled|error|exception/i.test(line)).slice(-30).join("\n")
  throw new Error(`${label} did not reach coordinator-free R2 publication after ${maxPolls} bounded polls.\n${diagnostics}`)
}

async function runRuntimeDispatch(kind, identity) {
  if (!identity) throw new Error(`Runtime ${kind} dispatch identity is missing.`)
  const attempts = runtimeDispatchAttempts.get(identity) ?? 1
  const response = await request(`${origin}/?phase=operator-runtime-dispatch`, {
    method: "POST",
    headers: { authorization: `Bearer ${operatorToken}`, "content-type": "application/json", "x-wp-codebox-dispatch-attempts": String(attempts) },
    body: JSON.stringify({ schema: runtimeQueueSchema, siteId: "default", generation: 1, kind, identity }),
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`Runtime ${kind} dispatch failed: status=${response.status} body=${body}.`)
  const result = JSON.parse(body)
  if (result.outcome === "retry") {
    runtimeDispatchAttempts.set(identity, attempts + 1)
    if (result.delaySeconds) await new Promise((resolve) => setTimeout(resolve, result.delaySeconds * 1000))
  } else {
    runtimeDispatchAttempts.delete(identity)
  }
  return result
}

async function assertWordPressCronDisabled() {
  const response = await request(`${origin}/wp-cron.php?doing_wp_cron=1`)
  if (response.status !== 404 || !((await response.text()).includes("Cloudflare scheduled handler"))) throw new Error(`Direct WordPress cron returned ${response.status}.`)
}

async function assertConcurrentMutations() {
  const outputOffset = output.length
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
  const summaries = runtimePhaseTraceSummaries(output.slice(outputOffset)).filter((summary) => summary.operation === "mutation")
  if (summaries.length !== 2 || summaries.filter((summary) => summary.phases.some((phase) => phase.name === "runtime.cache.promote" && phase.evidence?.stateMatched === true && phase.evidence?.sameRuntime === true)).length !== 2
    || !summaries.some((summary) => summary.runtime === "warm" && summary.phases.some((phase) => phase.name === "runtime.cache.reuse"))) {
    throw new Error(`Concurrent canonical mutations did not carry the exact committed runtime forward: ${JSON.stringify(summaries)}.`)
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
  const divergentRevision = "00000000-0000-4000-8000-000000000000"
  const divergent = await fetch(`${origin}/?phase=operator-adopt`, {
    method: "POST",
    headers: { authorization: `Bearer ${operatorToken}`, "content-type": "application/json" },
    body: JSON.stringify({ pointer: { ...before.pointer, revision: divergentRevision, manifestKey: before.pointer.manifestKey.replace(before.pointer.revision, divergentRevision) }, version: before.version }),
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
  if (!response.ok || payload.schema !== publicationContract.publishedRevisionSchema || payload.routes?.length !== routes.length) {
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

function assertRuntimePhaseTraceSummaries() {
  const summaries = runtimePhaseTraceSummaries(output)
  const runtimes = new Set(summaries.map((summary) => summary.runtime))
  const operations = new Set(summaries.map((summary) => summary.operation))
  for (const runtime of ["cold", "warm"]) {
    if (!runtimes.has(runtime)) throw new Error(`Cloudflare runtime gate did not emit a machine-readable ${runtime} runtime summary.`)
  }
  if (!operations.has("mutation")) throw new Error("Cloudflare runtime gate did not emit a machine-readable mutation operation summary.")
  const phaseNames = new Set(summaries.flatMap((summary) => summary.phases?.map((phase) => phase.name) ?? []))
  for (const phase of ["canonical.bootstrap.seed", "persistence.markdown.write", "persistence.manifest.write", "runtime.cache.promote"]) {
    if (!phaseNames.has(phase)) throw new Error(`Cloudflare runtime gate did not emit the required ${phase} phase.`)
  }
  if (summaries.some((summary) => !Number.isFinite(summary.totalMs) || !Array.isArray(summary.phases) || summary.phases.reduce((total, phase) => total + phase.durationMs, 0) > summary.totalMs + 1)) throw new Error("Cloudflare runtime gate received an invalid phase trace summary.")
}

async function assertRestorePackHydration(label) {
  const deadline = Date.now() + 2_000
  let packHydrations = []
  while (Date.now() < deadline) {
    packHydrations = runtimePhaseTraceSummaries(output).filter((summary) => {
      const fetch = summary.phases?.find((phase) => phase.name === "canonical.restore-pack.fetch")
      const decode = summary.phases?.find((phase) => phase.name === "canonical.restore-pack.verify-decode")
      const legacy = summary.phases?.find((phase) => phase.name === "canonical.objects.hydrate")
      return !legacy && fetch?.evidence?.requests === 1 && decode?.evidence?.requests === 0 && Number.isSafeInteger(fetch.evidence?.bytes) && Number.isSafeInteger(decode.evidence?.files)
    })
    if (packHydrations.length) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  if (!packHydrations.length) throw new Error(`Cold restart did not prove one-pack canonical restore hydration for ${label}; expected exactly one R2 pack read and zero legacy object reads in the restore phases.`)
  console.log(`Restore-pack hydration passed for ${coordinator}: ${label}; one R2 pack read replaced per-file canonical reads.`)
}

function runtimePhaseTraceSummaries(rawOutput) {
  return stripVTControlCharacters(rawOutput).split("\n").flatMap((line) => {
    try {
      const value = JSON.parse(line)
      return value?.schema === "wp-codebox/cloudflare-runtime-phase-trace/v1" ? [value] : []
    } catch {
      return []
    }
  })
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
