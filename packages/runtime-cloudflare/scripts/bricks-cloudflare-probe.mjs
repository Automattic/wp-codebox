import { readFile } from "node:fs/promises"
import { chromium } from "playwright"

const origin = process.env.BRICKS_PROBE_ORIGIN ?? "http://127.0.0.1:8793"
const password = process.env.BRICKS_PROBE_PASSWORD ?? "bricks-cloudflare-test-password"
const themePath = process.env.BRICKS_THEME_ZIP
const trace = (stage) => {
  if (process.env.BRICKS_PROBE_TRACE === "1") console.error(`[bricks-probe] ${stage}`)
}

if (!themePath) throw new Error("BRICKS_THEME_ZIP is required.")

const cookies = []

function cookieHeader() {
  return cookies.map(({ name, value }) => `${name}=${value}`).join("; ")
}

function rememberCookies(response) {
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";", 1)
    const [name, value] = pair.split("=", 2)
    const index = cookies.findIndex((entry) => entry.name === name)
    if (index >= 0) cookies[index] = { name, value }
    else cookies.push({ name, value })
  }
}

async function request(path, init = {}) {
  const headers = new Headers(init.headers)
  if (cookies.length) headers.set("cookie", cookieHeader())
  const response = await fetch(new URL(path, origin), { ...init, headers, redirect: "manual" })
  rememberCookies(response)
  return response
}

function nonce(html, name = "_wpnonce") {
  return html.match(new RegExp(`name=["']${name}["'][^>]*value=["']([^"']+)["']`, "i"))?.[1]
}

function restNonce(html) {
  const value = html.match(/"nonce":"([^"]+)"/)?.[1]
  if (!value) throw new Error("wp-admin did not expose a REST nonce.")
  return value
}

function bricksThemeContext(html) {
  const marker = html.indexOf('id="bricks-action"')
  if (marker < 0) return ""
  const start = Math.max(html.lastIndexOf('<div class="theme">', marker), html.lastIndexOf('<div class="theme active">', marker))
  return start < 0 ? "" : html.slice(start, marker + 1600)
}

async function login() {
  const initial = await request("/wp-login.php")
  if (!initial.ok || !/<form[^>]+id=["']loginform["']/i.test(await initial.text())) throw new Error("WordPress login form did not open.")
  const form = new URLSearchParams({ log: "admin", pwd: password, redirect_to: `${origin}/wp-admin/`, testcookie: "1", "wp-submit": "Log In" })
  const response = await request("/wp-login.php", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form })
  if (![301, 302].includes(response.status) || !response.headers.get("location")?.includes("/wp-admin/")) throw new Error(`Login failed: ${response.status}`)
  const dashboard = await request("/wp-admin/")
  const html = await dashboard.text()
  if (!dashboard.ok || !/Dashboard/i.test(html)) throw new Error(`wp-admin did not open: ${dashboard.status}`)
  return html
}

async function installTheme() {
  const upload = await request("/wp-admin/theme-install.php?browse=popular")
  const uploadHtml = await upload.text()
  const uploadNonce = nonce(uploadHtml)
  if (!upload.ok || !uploadNonce) throw new Error(`Theme upload screen did not expose a nonce: ${upload.status}`)

  const archive = await readFile(themePath)
  const form = new FormData()
  form.set("_wpnonce", uploadNonce)
  form.set("_wp_http_referer", "/wp-admin/theme-install.php?browse=popular")
  form.set("themezip", new File([archive], "bricks.2.4-rc.zip", { type: "application/zip" }))
  form.set("install-theme-submit", "Install Now")
  const installed = await request("/wp-admin/update.php?action=upload-theme", { method: "POST", body: form })
  if (!installed.ok) throw new Error(`Theme upload failed: status=${installed.status}; body=${(await installed.text()).slice(0, 500)}`)
}

async function createBricksPage(dashboardHtml) {
  const title = "Stain & Seal Pros — Cloudflare Native Bricks Proof"
  const response = await request("/wp-json/wp/v2/pages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-wp-nonce": restNonce(dashboardHtml) },
    body: JSON.stringify({ title, status: "draft" }),
  })
  const body = await response.text()
  if (response.status !== 201) throw new Error(`Native WordPress page creation failed: ${response.status}; ${body.slice(0, 500)}`)
  const page = JSON.parse(body)
  if (!Number.isInteger(page.id) || typeof page.slug !== "string" || typeof page.link !== "string") throw new Error(`Native WordPress page response was incomplete: ${body.slice(0, 500)}`)
  return { id: page.id, slug: page.slug, link: page.link, title }
}

async function openBricksBuilder(page) {
  trace("browser.launch")
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext()
    await context.addCookies(cookies.map(({ name, value }) => ({ name, value, domain: "127.0.0.1", path: "/" })))
    const assetResponses = []
    const pageErrors = []
    context.on("response", (response) => {
      const url = response.url()
      if (url.includes("/wp-content/themes/bricks/assets/")) assetResponses.push({ url: new URL(url).pathname, status: response.status(), source: response.headers()["x-wp-codebox-static"] ?? null })
    })
    const builderTab = await context.newPage()
    builderTab.on("pageerror", (error) => pageErrors.push(error.message))
    const builder = new URL(page.link)
    builder.searchParams.set("bricks", "run")
    trace("builder.goto")
    const response = await builderTab.goto(builder.toString(), { waitUntil: "commit", timeout: 30000 })
    if (!response?.ok()) throw new Error(`Bricks builder request failed: ${response?.status() ?? "no response"}`)
    await builderTab.waitForSelector("#bricks-preloader", { state: "attached", timeout: 60000 })
    trace("builder.preloader")
    await builderTab.waitForTimeout(3000)
    trace("builder.evaluate")
    const evidence = await builderTab.evaluate(() => ({
      title: document.title,
      builder: Boolean(document.querySelector(".brx-body.main")),
      preloader: Boolean(document.querySelector("#bricks-preloader")),
      preloaderVisible: (() => {
        const node = document.querySelector("#bricks-preloader")
        return node instanceof HTMLElement && getComputedStyle(node).display !== "none" && getComputedStyle(node).visibility !== "hidden"
      })(),
      appRoots: [...document.querySelectorAll("[data-v-app]")].length,
      iframe: Boolean(document.querySelector("iframe")),
      bodyClass: document.body.className,
    }))
    const requiredAssets = assetResponses.filter((entry) => /(?:builder\.min\.css|main\.min\.js|iframe\.min\.js)$/.test(entry.url))
    if (!evidence.builder || evidence.preloaderVisible || evidence.appRoots < 1 || !evidence.iframe) throw new Error(`Bricks builder did not finish opening: ${JSON.stringify(evidence)}`)
    if (!requiredAssets.length || requiredAssets.some((entry) => entry.status !== 200 || entry.source !== "r2-wp-content")) {
      throw new Error(`Bricks builder did not load its required R2 assets: ${JSON.stringify(requiredAssets)}`)
    }
    // The builder continues background autosave/heartbeat traffic. A viewport
    // capture is enough for the boot proof and avoids waiting for its page
    // height to settle indefinitely.
    if (process.env.BRICKS_PROBE_SCREENSHOT) await builderTab.screenshot({ path: process.env.BRICKS_PROBE_SCREENSHOT, fullPage: false, timeout: 5000 })
    trace("builder.complete")
    return { ...evidence, assetResponses: requiredAssets, pageErrors }
  } finally {
    trace("browser.close")
    await browser.close()
  }
}

trace("login")
const dashboardHtml = await login()
trace("login.complete")
if (!process.env.BRICKS_PROBE_SKIP_INSTALL) await installTheme()
const themes = await request("/wp-admin/themes.php")
const html = await themes.text()
if (!themes.ok || !/Bricks/i.test(html)) throw new Error(`Active theme check failed: ${themes.status}`)
const bricksTheme = bricksThemeContext(html)
const active = /class=["'][^"']*theme\s+active[^"']*["']/.test(bricksTheme ?? "")
const activation = bricksTheme.match(/href=["']([^"']*themes\.php\?action=activate[^"']*stylesheet=bricks[^"']*)["']/i)?.[1]
if (!active && !activation) throw new Error(`Bricks is installed but WordPress did not expose an activation action: ${bricksTheme.slice(0, 1200)}`)
if (!active) {
  const activated = await request(activation.replaceAll("&#038;", "&").replaceAll("&amp;", "&"))
  if (![200, 301, 302].includes(activated.status)) throw new Error(`Bricks activation failed: status=${activated.status}; body=${(await activated.text()).slice(0, 500)}`)
}
const verified = await request("/wp-admin/themes.php")
const verifiedHtml = await verified.text()
const verifiedBricksTheme = bricksThemeContext(verifiedHtml)
if (!verified.ok || !/class=["'][^"']*theme\s+active[^"']*["']/.test(verifiedBricksTheme ?? "")) throw new Error(`Bricks did not remain the active WordPress theme: ${(verifiedBricksTheme ?? "missing").slice(0, 500)}`)
if (process.env.BRICKS_PROBE_SKIP_BUILDER) {
  console.log(JSON.stringify({ status: "installed-and-active", origin, activeTheme: "Bricks" }))
  process.exit(0)
}
const createdPage = await createBricksPage(dashboardHtml)
trace("page.created")
const builder = await openBricksBuilder(createdPage)
console.log(JSON.stringify({ status: "installed-active-builder-open", origin, activeTheme: "Bricks", createdPage, builder, cookies: cookies.map(({ name }) => name) }))
