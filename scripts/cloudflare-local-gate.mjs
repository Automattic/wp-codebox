import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stripVTControlCharacters } from "node:util"

const port = 8792
const origin = `http://127.0.0.1:${port}`
const password = "cloudflare-runtime-test-password"
const authSecret = "cloudflare-runtime-test-auth-secret"
const stateDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-cloudflare-gate-"))
const cookies = []
let child
let output = ""

try {
  await run("npm", ["run", "generate:cloudflare-wordpress-runtime-corpus"])
  await run("npm", ["run", "provision:cloudflare-wordpress-runtime-corpus", "--", "--local", "--persist-to", stateDirectory])
  await startWorker()
  await assertConcurrentMutations()
  const coldHome = await timedWordPressPage(origin, "cold explanatory homepage")
  const warmHome = await timedWordPressPage(origin, "warm explanatory homepage")
  await assertExplanatoryHomepage(warmHome.body)
  if (coldHome.cacheStatus !== "miss" || warmHome.cacheStatus !== "hit" || warmHome.elapsedMs >= coldHome.elapsedMs || warmHome.elapsedMs > 500) {
    throw new Error(`Warm explanatory homepage did not use its revision cache: cold=${coldHome.elapsedMs}ms/${coldHome.cacheStatus} warm=${warmHome.elapsedMs}ms/${warmHome.cacheStatus}.`)
  }
  console.log(`Explanatory homepage timing: cold=${coldHome.elapsedMs}ms warm=${warmHome.elapsedMs}ms.`)
  const adminHtml = await login()
  const editorHtml = await assertPostNewEditor()
  const post = await createPost(adminHtml)
  const frontPage = await assertWordPressPage(`${origin}/${post.slug}/`, "published post")
  assertIncludes(frontPage, post.title, "published post")
  await assertHealthResponse()
  await assertLinkedAssets(frontPage, "front-end")
  await assertLinkedAssets(adminHtml, "admin")
  await assertLinkedAssets(editorHtml, "editor")
  await assertStaticResponseSemantics()
  await stopWorker()

  await startWorker()
  const restartedAdmin = await assertAuthenticatedDashboard(new URL("/wp-admin/", origin))
  const restartedPost = await assertWordPressPage(`${origin}/${post.slug}/`, "post after cold restart")
  assertIncludes(restartedPost, post.title, "post after cold restart")
  await assertLinkedAssets(restartedAdmin, "admin after cold restart")
  cookies.length = 0
  await login()
  console.log("Cloudflare local runtime gate passed: explanatory homepage, complete block styles, revision page cache, login, dashboard, post editor, concurrent canonical mutations, authenticated REST post creation, frontend/admin/editor assets, and cold-restart session persistence.")
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

async function startWorker() {
  output = ""
  child = spawn("npm", ["exec", "--", "wrangler", "dev", "--config", "packages/runtime-cloudflare/wrangler.jsonc", "--port", String(port), "--persist-to", stateDirectory, "--var", `WORDPRESS_ADMIN_PASSWORD:${password}`, "--var", `WORDPRESS_AUTH_SECRET:${authSecret}`], {
    cwd: process.cwd(),
    // The host PAC resolves these public archive hosts through an unavailable local proxy.
    env: { ...process.env, NO_PROXY: "wordpress.org,github.com,codeload.github.com", no_proxy: "wordpress.org,github.com,codeload.github.com" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout.on("data", (chunk) => { output += chunk })
  child.stderr.on("data", (chunk) => { output += chunk })
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
  const location = response.headers.get("location")
  if (!location?.includes("/wp-admin/")) throw new Error(`Login did not redirect to wp-admin: ${location}`)
  const admin = await assertAuthenticatedDashboard(new URL(location, origin))
  return admin
}

async function createPost(adminHtml) {
  const nonce = adminHtml.match(/"nonce":"([^"]+)"/)?.[1]
  if (!nonce) throw new Error("wp-admin did not expose a REST nonce.")
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
  if (typeof post.slug !== "string" || post.title?.rendered !== title) throw new Error(`Unexpected REST post response: ${body}`)
  return { slug: post.slug, title }
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

async function assertWordPressPage(target, label) {
  const response = await request(target)
  const body = await response.text()
  assertNoPhpDiagnostics(body, label)
  if (response.status !== 200 || !response.headers.get("content-type")?.includes("text/html") || !/<html[\s>]/i.test(body)) throw new Error(`Expected an HTML ${label}, received ${response.status}: ${body}`)
  return body
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
    if (response.headers.get("x-wp-codebox-static") !== "wordpress-archive") throw new Error(`${label} asset ${match[1]} did not bypass PHP through the WordPress archive static path.`)
  }
}

async function assertStaticResponseSemantics() {
  const asset = `${origin}/wp-includes/js/jquery/jquery.min.js?ver=3.7.1`
  const get = await request(asset)
  if (!get.ok || !get.headers.get("content-type")?.includes("javascript") || get.headers.get("x-wp-codebox-static") !== "wordpress-archive" || !get.headers.get("cache-control")?.includes("max-age")) throw new Error(`Unexpected static asset response: ${get.status}`)
  const head = await request(asset, { method: "HEAD" })
  if (!head.ok || head.headers.get("x-wp-codebox-static") !== "wordpress-archive" || (await head.text()) !== "") throw new Error("Static HEAD did not preserve headers with an empty body.")
  const missing = await request(`${origin}/wp-includes/js/does-not-exist.min.js`)
  if (missing.status !== 404) throw new Error(`Missing static archive asset returned ${missing.status}, not 404.`)
  const source = await request(`${origin}/wp-includes/version.php`)
  if (source.headers.get("x-wp-codebox-static") === "wordpress-archive") throw new Error("Static handler exposed a PHP source file.")
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
