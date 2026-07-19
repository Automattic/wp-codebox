import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const port = 8792
const origin = `http://127.0.0.1:${port}`
const password = "cloudflare-runtime-test-password"
const stateDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-cloudflare-gate-"))
const cookies = new Map()
let child
let output = ""

try {
  await startWorker()
  const adminHtml = await login()
  const post = await createPost(adminHtml)
  const frontPage = await assertWordPressPage(`${origin}/${post.slug}/`, "published post")
  assertIncludes(frontPage, post.title, "published post")
  await assertHealthResponse()
  await assertLinkedAssets(frontPage, "front-end")
  await assertLinkedAssets(adminHtml, "admin")
  await stopWorker()

  cookies.clear()
  await startWorker()
  const restartedAdmin = await login()
  const restartedPost = await assertWordPressPage(`${origin}/${post.slug}/`, "post after cold restart")
  assertIncludes(restartedPost, post.title, "post after cold restart")
  await assertLinkedAssets(restartedAdmin, "admin after cold restart")
  console.log("Cloudflare local runtime gate passed: login, authenticated REST post creation, frontend/admin assets, and cold-restart persistence.")
} finally {
  await stopWorker()
  await rm(stateDirectory, { recursive: true, force: true })
}

async function startWorker() {
  output = ""
  child = spawn("npm", ["exec", "--", "wrangler", "dev", "--config", "packages/runtime-cloudflare/wrangler.jsonc", "--port", String(port), "--persist-to", stateDirectory, "--var", `WORDPRESS_ADMIN_PASSWORD:${password}`], {
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
    if (/Ready on http:\/\/(?:localhost|127\.0\.0\.1):8792/.test(output)) return
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
  return assertWordPressPage(new URL(location, origin), "wp-admin")
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

async function assertLinkedAssets(html, label) {
  const links = [...html.matchAll(/<(?:link|script)\b[^>]*?\b(?:href|src)=["']([^"']+\.(?:css|js)(?:\?[^"']*)?)["']/gi)].slice(0, 2)
  if (!links.length) throw new Error(`Expected ${label} HTML to link CSS or JavaScript assets.`)
  for (const match of links) {
    const response = await request(new URL(match[1], origin))
    const body = await response.text()
    assertNoPhpDiagnostics(body, `${label} asset ${match[1]}`)
    if (!response.ok || !body.length) throw new Error(`Missing ${label} asset ${match[1]}: ${response.status}`)
  }
}

async function request(target, options = {}) {
  const headers = new Headers(options.headers)
  if (cookies.size) headers.set("cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "))
  const response = await fetch(target, { ...options, headers })
  const setCookies = response.headers.getSetCookie?.() ?? (response.headers.get("set-cookie") ? [response.headers.get("set-cookie")] : [])
  for (const cookie of setCookies) {
    const [pair] = cookie.split(";", 1)
    const separator = pair.indexOf("=")
    if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1))
  }
  return response
}

function assertIncludes(html, expected, label) {
  assertNoPhpDiagnostics(html, label)
  if (!html.includes(expected)) throw new Error(`${label} did not contain ${JSON.stringify(expected)}.`)
}

function assertNoPhpDiagnostics(body, label) {
  if (/<b>(?:Warning|Fatal error|Parse error|Deprecated)<\/b>:/i.test(body)) throw new Error(`PHP diagnostics in ${label}: ${body}`)
}
