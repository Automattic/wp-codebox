import { readFile, writeFile } from "node:fs/promises"

const origin = process.env.BRICKS_PROBE_ORIGIN ?? "http://127.0.0.1:8795"
const password = process.env.BRICKS_PROBE_PASSWORD ?? "bricks-cloudflare-test-password"
const logoPath = process.env.BRICKS_LOGO_PATH ?? "/Users/ty/Github/Stain-and-Seal-Pros/stain-and-seal-pros/images/logo_transparent.png"
const heroPath = process.env.BRICKS_HERO_PATH ?? "/Users/ty/Github/Stain-and-Seal-Pros/stain-and-seal-pros/images/deck-after-01.jpg"
const mcpAdapterPath = process.env.MCP_ADAPTER_ZIP ?? "packages/runtime-cloudflare/assets/mcp-adapter-0.6.1.zip"
const outputPath = process.env.BRICKS_PROBE_OUTPUT ?? "outputs/bricks-native-site-probe.json"
const idempotencyKey = process.env.BRICKS_FOUNDATION_KEY ?? "stain-seal-pros-cloudflare-native-v1"
const existingFoundation = process.env.BRICKS_EXISTING_FOUNDATION === "1"
const readOnlyReopen = process.env.BRICKS_READ_ONLY === "1"
const mediaSuffix = process.env.BRICKS_MEDIA_SUFFIX ? `-${process.env.BRICKS_MEDIA_SUFFIX}` : ""

const cookies = []

function cookieHeader() {
  return cookies.map(({ name, value }) => `${name}=${value}`).join("; ")
}

function rememberCookies(response) {
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";", 1)
    const equals = pair.indexOf("=")
    if (equals < 1) continue
    const next = { name: pair.slice(0, equals), value: pair.slice(equals + 1) }
    const index = cookies.findIndex((entry) => entry.name === next.name)
    if (index >= 0) cookies[index] = next
    else cookies.push(next)
  }
}

async function request(path, init = {}) {
  const headers = new Headers(init.headers)
  if (cookies.length) headers.set("cookie", cookieHeader())
  const response = await fetch(new URL(path, origin), { ...init, headers, redirect: "manual" })
  rememberCookies(response)
  return response
}

function extractRestNonce(html) {
  const match = html.match(/"nonce":"([^"]+)"/)
  if (!match) throw new Error("wp-admin did not expose a REST nonce")
  return match[1]
}

function extractBricksNonce(html) {
  const marker = html.indexOf("var bricksData =")
  const match = marker >= 0 ? html.slice(marker).match(/"nonce":"([^"]+)"/) : null
  if (!match) throw new Error("Bricks AI settings did not expose its admin nonce")
  return match[1]
}

function checkedBricksAbilities(html) {
  const abilities = []
  for (const tag of html.match(/<input\b[^>]*>/gi) ?? []) {
    if (!/name=["']bricksMcpEnabledAbilities\[\]["']/i.test(tag) || !/\bchecked\b/i.test(tag)) continue
    const value = tag.match(/value=["']([^"']+)["']/i)?.[1]
    if (value) abilities.push(value.replaceAll("&amp;", "&"))
  }
  if (!abilities.includes("bricks/commit-site-foundation")) {
    throw new Error(`Bricks did not offer commit-site-foundation among ${abilities.length} enabled abilities`)
  }
  return abilities
}

async function login() {
  const loginForm = await request("/wp-login.php")
  const loginHtml = await loginForm.text()
  if (!loginForm.ok || !/id=["']loginform["']/i.test(loginHtml)) throw new Error(`WordPress login form failed: ${loginForm.status}`)
  const form = new URLSearchParams({
    log: "admin",
    pwd: password,
    redirect_to: `${origin}/wp-admin/`,
    testcookie: "1",
    "wp-submit": "Log In",
  })
  const response = await request("/wp-login.php", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  })
  if (![301, 302].includes(response.status)) throw new Error(`WordPress login failed: ${response.status}`)
  const dashboard = await request("/wp-admin/")
  const html = await dashboard.text()
  if (!dashboard.ok || !/Dashboard/i.test(html)) throw new Error(`WordPress dashboard failed: ${dashboard.status}`)
  return html
}

async function enableAbilities() {
  const page = await request("/wp-admin/admin.php?page=bricks-ai")
  const html = await page.text()
  if (!page.ok || !/name=["']abilitiesApi["']/i.test(html)) throw new Error(`Bricks AI settings failed: ${page.status}`)
  const abilities = checkedBricksAbilities(html)
  const settings = new URLSearchParams({ abilitiesApi: "on" })
  for (const ability of abilities) settings.append("bricksMcpEnabledAbilities[]", ability)
  const payload = new URLSearchParams({
    action: "bricks_save_ai_settings",
    formData: settings.toString(),
    nonce: extractBricksNonce(html),
  })
  const response = await request("/wp-admin/admin-ajax.php", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: payload,
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`Bricks ability activation failed: ${response.status}; ${body.slice(0, 800)}`)
  const parsed = JSON.parse(body)
  if (!parsed.success) throw new Error(`Bricks rejected ability activation: ${body.slice(0, 800)}`)
  return abilities
}

async function installAndActivateMcpAdapter(dashboardHtml) {
  let wpNonce = extractRestNonce(dashboardHtml)
  let plugins = await rest("/wp-json/wp/v2/plugins?context=edit", wpNonce)
  let adapter = Array.isArray(plugins.body) ? plugins.body.find((entry) => entry.plugin === "mcp-adapter/mcp-adapter") : null
  if (!adapter) {
    const upload = await request("/wp-admin/plugin-install.php?tab=upload")
    const uploadHtml = await upload.text()
    const uploadNonce = uploadHtml.match(/name=["']_wpnonce["'][^>]*value=["']([^"']+)["']/i)?.[1]
    if (!upload.ok || !uploadNonce) throw new Error(`Plugin upload screen failed: ${upload.status}`)
    const archive = await readFile(mcpAdapterPath)
    const form = new FormData()
    form.set("_wpnonce", uploadNonce)
    form.set("_wp_http_referer", "/wp-admin/plugin-install.php?tab=upload")
    form.set("pluginzip", new File([archive], "mcp-adapter-0.6.1.zip", { type: "application/zip" }))
    form.set("install-plugin-submit", "Install Now")
    const installed = await request("/wp-admin/update.php?action=upload-plugin", { method: "POST", body: form })
    const body = await installed.text()
    await writeFile("/tmp/mcp-adapter-install-response.html", body)
    if (!installed.ok || !/Plugin installed successfully/i.test(body)) throw new Error(`MCP Adapter install failed: ${installed.status}; ${body.slice(0, 1000)}`)
    wpNonce = await freshRestNonce()
    plugins = await rest("/wp-json/wp/v2/plugins?context=edit", wpNonce)
    adapter = Array.isArray(plugins.body) ? plugins.body.find((entry) => entry.plugin === "mcp-adapter/mcp-adapter") : null
    if (!adapter) throw new Error("MCP Adapter upload completed but WordPress did not register the plugin")
  }
  if (adapter.status !== "active") {
    const activated = await rest("/wp-json/wp/v2/plugins/mcp-adapter/mcp-adapter", wpNonce, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    })
    adapter = activated.body
  }
  if (adapter.status !== "active") throw new Error(`MCP Adapter did not activate: ${JSON.stringify(adapter).slice(0, 1000)}`)
  return { plugin: adapter.plugin, status: adapter.status, version: adapter.version ?? "0.6.1" }
}

async function freshRestNonce() {
  const dashboard = await request("/wp-admin/")
  const html = await dashboard.text()
  if (!dashboard.ok) throw new Error(`WordPress dashboard refresh failed: ${dashboard.status}`)
  return extractRestNonce(html)
}

async function rest(path, wpNonce, init = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-wp-nonce", wpNonce)
  const response = await request(path, { ...init, headers })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} failed: ${response.status}; ${text.slice(0, 1800)}`)
  return { response, body }
}

async function uploadMedia(wpNonce, path, filename, mime, alt) {
  const bytes = await readFile(path)
  const slug = filename.replace(/\.[^.]+$/, "")
  const existing = await rest(`/wp-json/wp/v2/media?slug=${encodeURIComponent(slug)}&per_page=1&context=edit`, wpNonce)
  if (Array.isArray(existing.body) && existing.body[0]) {
    const media = existing.body[0]
    return { id: media.id, url: media.source_url, bytes: bytes.byteLength, mime, reused: true }
  }
  const { body } = await rest("/wp-json/wp/v2/media", wpNonce, {
    method: "POST",
    headers: {
      "content-type": mime,
      "content-disposition": `attachment; filename="${filename}"`,
    },
    body: bytes,
  })
  await rest(`/wp-json/wp/v2/media/${body.id}`, wpNonce, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ alt_text: alt }),
  })
  return { id: body.id, url: body.source_url, bytes: bytes.byteLength, mime, reused: false }
}

async function runAbility(name, input, wpNonce, destructive = true) {
  const encodedInput = encodeURIComponent(JSON.stringify(input))
  const path = destructive
    ? `/wp-json/wp-abilities/v1/abilities/${name}/run?input=${encodedInput}`
    : `/wp-json/wp-abilities/v1/abilities/${name}/run`
  const { body } = await rest(path, wpNonce, destructive
    ? { method: "DELETE" }
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input }) })
  return body
}

async function mcpRequest(wpNonce, sessionId, payload) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "x-wp-nonce": wpNonce,
  }
  if (sessionId) headers["mcp-session-id"] = sessionId
  const response = await request("/wp-json/mcp/mcp-adapter-default-server", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })
  const text = await response.text()
  let body = null
  if (text.trim()) {
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error(`MCP returned non-JSON: ${response.status}; ${text.slice(0, 1800)}`)
    }
  }
  if (!response.ok || body?.error) throw new Error(`MCP request failed: ${response.status}; ${JSON.stringify(body).slice(0, 2400)}`)
  return { response, body }
}

async function openMcpSession(wpNonce) {
  const initialized = await mcpRequest(wpNonce, null, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "bricks-cloudflare-native-probe", version: "1.0.0" } },
  })
  const sessionId = initialized.response.headers.get("mcp-session-id")
  if (!sessionId) throw new Error(`MCP initialize omitted Mcp-Session-Id: ${JSON.stringify(initialized.body).slice(0, 1200)}`)
  await mcpRequest(wpNonce, sessionId, { jsonrpc: "2.0", method: "notifications/initialized" })
  return { sessionId, initialize: initialized.body?.result }
}

async function mcpExecuteAbility(wpNonce, sessionId, abilityName, parameters, id = 2) {
  const called = await mcpRequest(wpNonce, sessionId, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "mcp-adapter-execute-ability",
      arguments: { ability_name: abilityName, parameters },
    },
  })
  const result = called.body?.result
  if (result?.isError) throw new Error(`MCP tool call failed: ${JSON.stringify(result).slice(0, 2400)}`)
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent
  for (const item of result?.content ?? []) {
    if (item?.type !== "text" || typeof item.text !== "string") continue
    try {
      return JSON.parse(item.text)
    } catch {
      // Keep looking for a structured content block.
    }
  }
  throw new Error(`MCP execute-ability returned no structured result: ${JSON.stringify(result).slice(0, 2400)}`)
}

async function closeMcpSession(wpNonce, sessionId) {
  const response = await request("/wp-json/mcp/mcp-adapter-default-server", {
    method: "DELETE",
    headers: { "x-wp-nonce": wpNonce, "mcp-session-id": sessionId },
  })
  if (!response.ok) throw new Error(`MCP session close failed: ${response.status}; ${(await response.text()).slice(0, 1000)}`)
}

function foundationInput(media) {
  const logo = media.logo.url
  const hero = media.hero.url
  return {
    idempotencyKey,
    palette: {
      name: "Stain & Seal Pros",
      colors: [
        { name: "Brand Navy", value: "#0B3A66" },
        { name: "Brand Orange", value: "#FF6A00" },
        { name: "Ink", value: "#12202C" },
        { name: "Surface", value: "#FFFFFF" },
        { name: "Surface Warm", value: "#F4EFE8" },
        { name: "Muted", value: "#5B6873" },
      ],
    },
    typography: { bodyFontFamily: "Inter", headingFontFamily: "Inter", rootFontSize: "62.5%" },
    header: {
      title: "Site Header",
      html: `<div class="site-header"><a class="brand" href="/"><img src="${logo}" alt="Stain & Seal Pros"></a><nav class="main-nav" aria-label="Primary"><a href="#services">Services</a><a href="#work">Our work</a><a class="button button-small" href="#estimate">Get an estimate</a></nav></div>`,
      css: `.site-header{display:flex;align-items:center;justify-content:space-between;gap:var(--space-m);max-width:1200px;margin:0 auto;padding:1.6rem 2.4rem;background:var(--surface)}.brand img{display:block;width:17rem;height:auto}.main-nav{display:flex;align-items:center;gap:2.4rem}.main-nav a{color:var(--brand-navy);font-weight:700;text-decoration:none}.button{display:inline-flex;align-items:center;justify-content:center;padding:1.4rem 2.2rem;border-radius:.5rem;background:var(--brand-orange);color:#fff!important;font-weight:800;text-decoration:none}.button-small{padding:1rem 1.6rem}@media(max-width:767px){.site-header{padding:1.2rem 1.6rem}.brand img{width:13rem}.main-nav>a:not(.button){display:none}}`,
    },
    footer: {
      title: "Site Footer",
      html: `<div class="site-footer"><img src="${logo}" alt="Stain & Seal Pros"><p>Professional wood restoration and protection for decks, fences, log homes, pergolas, and more.</p><a href="#estimate">Request an estimate</a></div>`,
      css: `.site-footer{display:grid;gap:1.6rem;justify-items:start;background:var(--brand-navy);color:#fff;padding:5rem max(2.4rem,calc((100vw - 1200px)/2))}.site-footer img{width:18rem;filter:brightness(0) invert(1)}.site-footer p{max-width:60ch}.site-footer a{color:#fff;font-weight:800}`,
    },
    home: {
      title: "Stain & Seal Pros | Wood Restoration & Protection",
      slug: "home",
      html: `<section class="hero"><div class="hero-copy"><p class="eyebrow">Springfield-area wood care specialists</p><h1>Restore the wood you love. Protect it for years.</h1><p class="lede">Professional cleaning, staining, sealing, and repair for outdoor wood surfaces across Southwest Missouri.</p><a class="button" href="#estimate">Request a free estimate</a></div><figure class="hero-media"><img src="${hero}" alt="Freshly restored and stained residential deck"><figcaption>Craftsmanship you can see in every board.</figcaption></figure></section><section id="services" class="section"><div class="section-heading"><p class="eyebrow">Built for Missouri weather</p><h2>Complete care for outdoor wood</h2></div><div class="service-grid"><article class="service-card"><h3>Deck restoration</h3><p>Cleaning, preparation, staining, and sealing that restores color and protects the surface.</p></article><article class="service-card"><h3>Fence staining</h3><p>Even coverage and durable protection for privacy fences, gates, and decorative woodwork.</p></article><article class="service-card"><h3>Specialty wood care</h3><p>Experienced care for log homes, pergolas, pre-stain projects, and wood repairs.</p></article></div></section><section id="work" class="work"><div><p class="eyebrow">Real local work</p><h2>Careful preparation. Clean results.</h2><p>Every project starts with the condition of the wood and ends with a finish selected for the surface, exposure, and desired look.</p></div><img src="${hero}" alt="Restored deck project completed by Stain & Seal Pros"></section><section id="estimate" class="estimate"><p class="eyebrow">Ready to protect your investment?</p><h2>Tell us about your project.</h2><p>Share the surface, approximate size, and where the project is located. We’ll help you choose the right next step.</p><a class="button" href="#estimate-form">Start your estimate</a></section>`,
      css: `body{margin:0;color:var(--ink);background:var(--surface);font-family:Inter,system-ui,sans-serif}h1,h2,h3{color:var(--brand-navy);font-weight:800;line-height:1.05;margin:0}h1{font-size:clamp(4.2rem,7vw,8rem);max-width:12ch}h2{font-size:clamp(3.4rem,5vw,5.6rem)}h3{font-size:2.4rem}.hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(36rem,.85fr);min-height:70rem;align-items:center;gap:5vw;padding:7rem max(2.4rem,calc((100vw - 1200px)/2));background:linear-gradient(115deg,var(--surface-warm),#fff)}.hero-copy{display:grid;gap:2.2rem;justify-items:start}.eyebrow{margin:0;color:var(--brand-orange);font-size:1.4rem;font-weight:900;letter-spacing:.12em;text-transform:uppercase}.lede{max-width:58rem;color:var(--muted);font-size:2.1rem;line-height:1.6}.hero-media{margin:0}.hero-media img,.work img{width:100%;aspect-ratio:4/5;object-fit:cover;border-radius:1.2rem;box-shadow:0 2.5rem 6rem rgba(11,58,102,.18)}.hero-media figcaption{margin-top:1rem;color:var(--muted);font-size:1.4rem}.section,.work,.estimate{padding:9rem max(2.4rem,calc((100vw - 1200px)/2))}.section-heading{display:grid;gap:1.2rem;max-width:78rem}.service-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:2rem;margin-top:4rem}.service-card{display:grid;gap:1.4rem;padding:3rem;border-top:.5rem solid var(--brand-orange);background:var(--surface-warm)}.service-card p,.work p,.estimate p{color:var(--muted);font-size:1.8rem;line-height:1.65}.work{display:grid;grid-template-columns:1fr 1fr;align-items:center;gap:7vw;background:var(--brand-navy)}.work h2,.work p:not(.eyebrow){color:#fff}.work img{aspect-ratio:3/2}.estimate{display:grid;gap:1.8rem;justify-items:start;max-width:1200px;margin:0 auto}.estimate p{max-width:64rem}@media(max-width:767px){.hero{grid-template-columns:1fr;min-height:auto;padding-top:5rem}.hero-media img{aspect-ratio:4/3}.service-grid{grid-template-columns:1fr}.work{grid-template-columns:1fr}.section,.work,.estimate{padding-top:6rem;padding-bottom:6rem}}`,
    },
  }
}

function existingFoundationTrees(media, classByName) {
  const classes = (...names) => ({ _cssGlobalClasses: names.map((name) => {
    const id = classByName.get(name)
    if (!id) throw new Error(`Existing Bricks global class is missing: ${name}`)
    return id
  }) })
  const text = (value, classNames = []) => ({ name: "text-basic", settings: { text: value, ...classes(...classNames) } })
  const heading = (value, tag, classNames = []) => ({ name: "heading", settings: { text: value, tag, ...classes(...classNames) } })
  const link = (value, url, classNames = []) => ({ name: "text-link", settings: { text: value, link: { type: "external", url }, ...classes(...classNames) } })
  const image = (asset, _alt, classNames = []) => ({ name: "image", settings: { image: { id: asset.id, url: asset.url, size: "full" }, ...classes(...classNames) } })
  return {
    header: [{ name: "div", settings: classes("site-header"), children: [
      { name: "div", settings: classes("brand"), children: [image(media.logo, "Stain & Seal Pros")] },
      { name: "div", settings: classes("main-nav"), children: [
        link("Services", "#services"), link("Our work", "#work"), link("Get an estimate", "#estimate", ["button", "button-small"]),
      ] },
    ] }],
    footer: [{ name: "div", settings: classes("site-footer"), children: [
      image(media.logo, "Stain & Seal Pros"),
      text("Professional wood restoration and protection for decks, fences, log homes, pergolas, and more."),
      link("Request an estimate", "#estimate"),
    ] }],
    home: [
      { name: "section", settings: classes("hero"), children: [
        { name: "div", settings: classes("hero-copy"), children: [
          text("Springfield-area wood care specialists", ["eyebrow"]),
          heading("Restore the wood you love. Protect it for years.", "h1"),
          text("Professional cleaning, staining, sealing, and repair for outdoor wood surfaces across Southwest Missouri.", ["lede"]),
          link("Request a free estimate", "#estimate", ["button"]),
        ] },
        { name: "div", settings: classes("hero-media"), children: [
          image(media.hero, "Freshly restored and stained residential deck"),
          text("Craftsmanship you can see in every board."),
        ] },
      ] },
      { name: "section", settings: { ...classes("section"), _attributes: [{ name: "id", value: "services" }] }, children: [
        { name: "div", settings: classes("section-heading"), children: [
          text("Built for Missouri weather", ["eyebrow"]), heading("Complete care for outdoor wood", "h2"),
        ] },
        { name: "div", settings: classes("service-grid"), children: [
          { name: "div", settings: classes("service-card"), children: [heading("Deck restoration", "h3"), text("Cleaning, preparation, staining, and sealing that restores color and protects the surface.")] },
          { name: "div", settings: classes("service-card"), children: [heading("Fence staining", "h3"), text("Even coverage and durable protection for privacy fences, gates, and decorative woodwork.")] },
          { name: "div", settings: classes("service-card"), children: [heading("Specialty wood care", "h3"), text("Experienced care for log homes, pergolas, pre-stain projects, and wood repairs.")] },
        ] },
      ] },
      { name: "section", settings: { ...classes("work"), _attributes: [{ name: "id", value: "work" }] }, children: [
        { name: "div", children: [text("Real local work", ["eyebrow"]), heading("Careful preparation. Clean results.", "h2"), text("Every project starts with the condition of the wood and ends with a finish selected for the surface, exposure, and desired look.")] },
        image(media.hero, "Restored deck project completed by Stain & Seal Pros"),
      ] },
      { name: "section", settings: { ...classes("estimate"), _attributes: [{ name: "id", value: "estimate" }] }, children: [
        text("Ready to protect your investment?", ["eyebrow"]), heading("Tell us about your project.", "h2"),
        text("Share the surface, approximate size, and where the project is located. We’ll help you choose the right next step."),
        link("Start your estimate", "#estimate-form", ["button"]),
      ] },
    ],
  }
}

const dashboard = await login()
const mcpAdapter = await installAndActivateMcpAdapter(dashboard)
const enabled = await enableAbilities()
const wpNonce = await freshRestNonce()
const { body: abilities } = await rest("/wp-json/wp-abilities/v1/abilities?per_page=100", wpNonce)
const abilityNames = Array.isArray(abilities) ? abilities.map((entry) => entry.name) : []
for (const required of ["bricks/commit-site-foundation", "bricks/get-page-elements", "bricks/create-template", "bricks/list-global-classes", "bricks/list-global-variables"]) {
  if (!abilityNames.includes(required)) throw new Error(`Required Bricks ability is absent after activation: ${required}`)
}

const media = {
  logo: await uploadMedia(wpNonce, logoPath, `stain-seal-pros-logo${mediaSuffix}.png`, "image/png", "Stain & Seal Pros"),
  hero: await uploadMedia(wpNonce, heroPath, `stain-seal-pros-deck-after${mediaSuffix}.jpg`, "image/jpeg", "Freshly restored and stained residential deck"),
}

const mcp = await openMcpSession(wpNonce)
let foundation
if (readOnlyReopen) {
  foundation = {
    workflow: "read-only-reopen",
    transactionState: "observed",
    resources: {
      headerTemplateId: Number(process.env.BRICKS_HEADER_TEMPLATE_ID ?? 9),
      footerTemplateId: Number(process.env.BRICKS_FOOTER_TEMPLATE_ID ?? 11),
      homePageId: Number(process.env.BRICKS_HOME_PAGE_ID ?? 13),
      homeUrl: `${origin}/`,
    },
    replayed: true,
  }
} else if (existingFoundation) {
  const resources = {
    headerTemplateId: Number(process.env.BRICKS_HEADER_TEMPLATE_ID ?? 9),
    footerTemplateId: Number(process.env.BRICKS_FOOTER_TEMPLATE_ID ?? 11),
    homePageId: Number(process.env.BRICKS_HOME_PAGE_ID ?? 13),
    homeUrl: `${origin}/`,
  }
  const context = await mcpExecuteAbility(wpNonce, mcp.sessionId, "bricks/get-design-context", { responseFormat: "summary", limit: 100 }, 19)
  if (!context.success) throw new Error(`Bricks design context failed before focused repair: ${JSON.stringify(context).slice(0, 2400)}`)
  const classByName = new Map((context.data?.globalClasses ?? []).map((item) => [item.name, item.id]))
  const trees = existingFoundationTrees(media, classByName)
  const imports = []
  const createTemplates = process.env.BRICKS_CREATE_TEMPLATES === "1"
  if (createTemplates) {
    for (const target of [
      { name: "header", type: "header", elements: trees.header },
      { name: "footer", type: "footer", elements: trees.footer },
    ]) {
      const created = await mcpExecuteAbility(wpNonce, mcp.sessionId, "bricks/create-template", {
        title: `Site ${target.name[0].toUpperCase()}${target.name.slice(1)} Cloudflare ${process.env.BRICKS_MEDIA_SUFFIX ?? "native"}`,
        type: target.type,
        status: "publish",
        elements: target.elements,
        settings: { templateConditions: [{ main: "any" }] },
      }, 18 + imports.length)
      if (!created.success) throw new Error(`Bricks ${target.name} template creation failed: ${JSON.stringify(created).slice(0, 2400)}`)
      resources[`${target.name}TemplateId`] = created.data.templateId
      imports.push({ name: `create-${target.name}`, postId: created.data.templateId, result: created.data })
    }
  }
  const targets = createTemplates
    ? [{ name: "home", postId: resources.homePageId, elements: trees.home }]
    : [
        { name: "header", postId: resources.headerTemplateId, elements: trees.header },
        { name: "footer", postId: resources.footerTemplateId, elements: trees.footer },
        { name: "home", postId: resources.homePageId, elements: trees.home },
      ]
  for (const target of targets) {
    const committed = await mcpExecuteAbility(wpNonce, mcp.sessionId, "bricks/set-page-elements", {
      postId: target.postId,
      elements: target.elements,
    }, 20 + imports.length * 2)
    if (!committed.success) throw new Error(`Bricks focused ${target.name} native save failed: ${JSON.stringify(committed).slice(0, 2400)}`)
    imports.push({ name: target.name, postId: target.postId, result: committed.data })
  }
  for (const templateId of [resources.headerTemplateId, resources.footerTemplateId]) {
    const conditions = await mcpExecuteAbility(wpNonce, mcp.sessionId, "bricks/set-template-conditions", {
      templateId,
      conditions: [{ main: "any" }],
    }, 40 + imports.length)
    if (!conditions.success) throw new Error(`Bricks template condition save failed for ${templateId}: ${JSON.stringify(conditions).slice(0, 2400)}`)
    imports.push({ name: `conditions-${templateId}`, postId: templateId, result: conditions.data })
  }
  foundation = { workflow: "focused-foundation-repair", transactionState: "committed", resources, imports, replayed: false }
} else {
  const executed = await mcpExecuteAbility(wpNonce, mcp.sessionId, "bricks/commit-site-foundation", foundationInput(media))
  if (!executed.success) throw new Error(`Bricks foundation failed through MCP: ${JSON.stringify(executed).slice(0, 2400)}`)
  foundation = executed.data
}
const resources = foundation?.resources ?? {}
const pageId = resources.homePageId
if (!Number.isInteger(pageId)) throw new Error(`Bricks foundation did not return a homepage ID: ${JSON.stringify(foundation).slice(0, 2400)}`)
const homeElements = await mcpExecuteAbility(wpNonce, mcp.sessionId, "bricks/get-page-elements", { postId: pageId, responseFormat: "summary" }, 3)
const headerElements = await mcpExecuteAbility(wpNonce, mcp.sessionId, "bricks/get-page-elements", { postId: resources.headerTemplateId, responseFormat: "summary" }, 4)
const footerElements = await mcpExecuteAbility(wpNonce, mcp.sessionId, "bricks/get-page-elements", { postId: resources.footerTemplateId, responseFormat: "summary" }, 5)
const designContext = await mcpExecuteAbility(wpNonce, mcp.sessionId, "bricks/get-design-context", { responseFormat: "summary", limit: 50 }, 6)
for (const [label, value] of Object.entries({ homeElements, headerElements, footerElements, designContext })) {
  if (!value.success) throw new Error(`${label} failed through MCP: ${JSON.stringify(value).slice(0, 2400)}`)
}
await closeMcpSession(wpNonce, mcp.sessionId)
const result = {
  status: "native-foundation-committed",
  origin,
  wordpressLogin: true,
  enabledAbilityCount: enabled.length,
  registeredBricksAbilityCount: abilityNames.filter((name) => name.startsWith("bricks/")).length,
  mcpAdapter,
  mcpProtocolVersion: mcp.initialize?.protocolVersion ?? null,
  media,
  foundation,
  nativeEvidence: {
    home: homeElements.data,
    header: headerElements.data,
    footer: footerElements.data,
    designContext: designContext.data,
  },
  pageId,
  generatedAt: new Date().toISOString(),
}

await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result))
