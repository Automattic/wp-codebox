import { mkdir, writeFile } from "node:fs/promises"

const origin = process.env.BRICKS_PROBE_ORIGIN ?? "http://127.0.0.1:8798"
const adminPassword = process.env.BRICKS_PROBE_PASSWORD ?? "bricks-cloudflare-test-password"
const clientPassword = process.env.BRICKS_CLIENT_PASSWORD ?? "bricks-client-content-editor-password"
const outputPath = process.env.BRICKS_CLIENT_OUTPUT ?? "outputs/bricks-client-transaction.json"
const pageId = Number(process.env.BRICKS_HOME_PAGE_ID ?? 13)
const username = process.env.BRICKS_CLIENT_USERNAME ?? "client_content_editor"
const changedText = process.env.BRICKS_CLIENT_CHANGED_TEXT ?? "Professional cleaning, staining, sealing, and repair for outdoor wood surfaces across Southwest Missouri. Client edit proof."
const originalText = "Professional cleaning, staining, sealing, and repair for outdoor wood surfaces across Southwest Missouri."

class Session {
  constructor(login, password) {
    this.login = login
    this.password = password
    this.cookies = []
  }

  cookieHeader() { return this.cookies.map(({ name, value }) => `${name}=${value}`).join("; ") }

  remember(response) {
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const pair = raw.split(";", 1)[0]
      const equals = pair.indexOf("=")
      if (equals < 1) continue
      const next = { name: pair.slice(0, equals), value: pair.slice(equals + 1) }
      const index = this.cookies.findIndex((item) => item.name === next.name)
      if (index >= 0) this.cookies[index] = next
      else this.cookies.push(next)
    }
  }

  async request(path, init = {}) {
    const headers = new Headers(init.headers)
    if (this.cookies.length) headers.set("cookie", this.cookieHeader())
    const response = await fetch(new URL(path, origin), { ...init, headers, redirect: "manual" })
    this.remember(response)
    return response
  }

  async loginWordPress() {
    const initial = await this.request("/wp-login.php")
    if (!initial.ok || !/id=["']loginform["']/i.test(await initial.text())) throw new Error(`${this.login} login form failed`)
    const response = await this.request("/wp-login.php", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ log: this.login, pwd: this.password, redirect_to: `${origin}/wp-admin/`, testcookie: "1", "wp-submit": "Log In" }),
    })
    if (![301, 302].includes(response.status)) throw new Error(`${this.login} login failed: ${response.status}`)
    const dashboard = await this.request("/wp-admin/")
    const html = await dashboard.text()
    if (!dashboard.ok || !/Dashboard/i.test(html)) throw new Error(`${this.login} dashboard failed: ${dashboard.status}`)
    const nonceResponse = await this.request("/wp-admin/admin-ajax.php?action=rest-nonce")
    const nonce = (await nonceResponse.text()).trim()
    if (!nonceResponse.ok || !/^[a-f0-9]{10}$/i.test(nonce)) throw new Error(`${this.login} REST nonce endpoint failed`)
    return nonce
  }

  async rest(path, nonce, init = {}) {
    const headers = new Headers(init.headers)
    headers.set("x-wp-nonce", nonce)
    const response = await this.request(path, { ...init, headers })
    const text = await response.text()
    let body
    try { body = JSON.parse(text) } catch { body = text }
    if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} failed: ${response.status}; ${text.slice(0, 1600)}`)
    return body
  }

  async mcpRequest(nonce, sessionId, payload) {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "x-wp-nonce": nonce }
    if (sessionId) headers["mcp-session-id"] = sessionId
    const response = await this.request("/wp-json/mcp/mcp-adapter-default-server", { method: "POST", headers, body: JSON.stringify(payload) })
    const text = await response.text()
    const body = text.trim() ? JSON.parse(text) : null
    if (!response.ok || body?.error) throw new Error(`MCP request failed for ${this.login}: ${response.status}; ${text.slice(0, 1800)}`)
    return { response, body }
  }

  async openMcp(nonce) {
    const initialized = await this.mcpRequest(nonce, null, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "bricks-client-transaction-proof", version: "1.0.0" } },
    })
    const sessionId = initialized.response.headers.get("mcp-session-id")
    if (!sessionId) throw new Error("MCP initialize omitted session ID")
    await this.mcpRequest(nonce, sessionId, { jsonrpc: "2.0", method: "notifications/initialized" })
    return sessionId
  }

  async ability(nonce, sessionId, name, parameters, id) {
    const called = await this.mcpRequest(nonce, sessionId, {
      jsonrpc: "2.0", id, method: "tools/call",
      params: { name: "mcp-adapter-execute-ability", arguments: { ability_name: name, parameters } },
    })
    const result = called.body?.result
    if (result?.isError) throw new Error(`${this.login} ability ${name} failed: ${JSON.stringify(result).slice(0, 2200)}`)
    const structured = result?.structuredContent
    if (structured && typeof structured === "object") return structured
    for (const item of result?.content ?? []) {
      if (item?.type !== "text") continue
      try { return JSON.parse(item.text) } catch {}
    }
    throw new Error(`${name} returned no structured result`)
  }
}

async function publicBody(marker) {
  const response = await fetch(`${origin}/?${marker}=${Date.now()}`, { redirect: "manual" })
  const body = await response.text()
  if (!response.ok) throw new Error(`Public observation failed: ${response.status}`)
  return { body, headers: Object.fromEntries(response.headers.entries()) }
}

async function enableAdminAbility(session, abilityName) {
  const response = await session.request("/wp-admin/admin.php?page=bricks-ai")
  const html = await response.text()
  if (!response.ok) throw new Error(`Bricks AI settings failed: ${response.status}`)
  const values = []
  let targetExists = false
  for (const tag of html.match(/<input\b[^>]*>/gi) ?? []) {
    if (!/name=["']bricksMcpEnabledAbilities\[\]["']/i.test(tag)) continue
    const value = tag.match(/value=["']([^"']+)["']/i)?.[1]?.replaceAll("&amp;", "&")
    if (!value) continue
    if (value === abilityName) targetExists = true
    if (/\bchecked\b/i.test(tag)) values.push(value)
  }
  if (!targetExists) throw new Error(`Bricks AI settings did not offer ${abilityName}`)
  if (!values.includes(abilityName)) values.push(abilityName)
  const marker = html.indexOf("var bricksData =")
  const nonce = marker >= 0 ? html.slice(marker).match(/"nonce":"([^"]+)"/)?.[1] : null
  if (!nonce) throw new Error("Bricks AI settings omitted its admin nonce")
  const settings = new URLSearchParams({ abilitiesApi: "on" })
  for (const value of values) settings.append("bricksMcpEnabledAbilities[]", value)
  const saved = await session.request("/wp-admin/admin-ajax.php", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ action: "bricks_save_ai_settings", formData: settings.toString(), nonce }),
  })
  const body = await saved.json()
  if (!saved.ok || !body.success) throw new Error(`Bricks rejected ${abilityName} activation: ${JSON.stringify(body).slice(0, 1200)}`)
  return { abilityName, enabled: true, totalEnabled: values.length }
}

const admin = new Session("admin", adminPassword)
const adminNonce = await admin.loginWordPress()
const permissionAbility = await enableAdminAbility(admin, "bricks/set-builder-role-access")
let users = await admin.rest(`/wp-json/wp/v2/users?search=${encodeURIComponent(username)}&context=edit`, adminNonce)
let clientUser = Array.isArray(users) ? users.find((user) => user.username === username) : null
if (!clientUser) {
  clientUser = await admin.rest("/wp-json/wp/v2/users", adminNonce, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, name: "Client Content Editor", email: `${username}@417agency.test`, password: clientPassword, roles: ["editor"] }),
  })
}

const adminMcp = await admin.openMcp(adminNonce)
const roleGrant = await admin.ability(adminNonce, adminMcp, "bricks/set-builder-role-access", { roleAccess: { editor: "bricks_edit_content" } }, 2)
if (!roleGrant.success) throw new Error(`Editor role grant failed: ${JSON.stringify(roleGrant)}`)

const client = new Session(username, clientPassword)
const clientNonce = await client.loginWordPress()
const clientMcp = await client.openMcp(clientNonce)
const before = await client.ability(clientNonce, clientMcp, "bricks/get-page-elements", { postId: pageId, responseFormat: "detailed" }, 3)
if (!before.success) throw new Error(`Client page read failed: ${JSON.stringify(before)}`)
const elements = before.data?.elements ?? []
const target = elements.find((element) => element?.name === "text-basic" && element?.settings?.text === originalText)
if (!target?.id) throw new Error("Client transaction could not locate the exact native lede element")

const updated = await client.ability(clientNonce, clientMcp, "bricks/update-element", {
  postId: pageId,
  elementId: target.id,
  settings: { text: changedText },
  returnElement: true,
}, 4)
if (!updated.success || !updated.data?.changed || !Number.isInteger(updated.data?.revisionId)) throw new Error(`Client native edit did not commit with revision: ${JSON.stringify(updated)}`)

const publishAfterEdit = await client.rest(`/wp-json/wp/v2/pages/${pageId}`, clientNonce, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "publish" }),
})
const observedEdit = await publicBody("client-edit")
if (!observedEdit.body.includes(changedText)) throw new Error("Published page did not expose the client edit")

const restored = await client.ability(clientNonce, clientMcp, "bricks/restore-revision", { revisionId: updated.data.revisionId, postId: pageId }, 5)
if (!restored.success || !restored.data?.restored) throw new Error(`Client restore failed: ${JSON.stringify(restored)}`)
const publishAfterRestore = await client.rest(`/wp-json/wp/v2/pages/${pageId}`, clientNonce, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "publish" }),
})
const observedRestore = await publicBody("client-restore")
if (!observedRestore.body.includes(originalText) || observedRestore.body.includes(changedText)) throw new Error("Published page did not expose the restored native Bricks content")

const reopened = await client.ability(clientNonce, clientMcp, "bricks/get-page-elements", { postId: pageId, responseFormat: "detailed" }, 6)
const reopenedTarget = reopened.data?.elements?.find((element) => element?.id === target.id)
if (reopenedTarget?.settings?.text !== originalText) throw new Error("Client reopen did not return the restored element text")

const report = {
  status: "client-edit-publish-observe-restore-passed",
  origin,
  client: { id: clientUser.id, username, roles: clientUser.roles },
  roleGrant: roleGrant.data,
  permissionAbility,
  target: { postId: pageId, elementId: target.id, elementName: target.name },
  edit: { revisionId: updated.data.revisionId, changed: updated.data.changed, publishedStatus: publishAfterEdit.status, publicObserved: true },
  restore: { restored: restored.data.restored, fromRevisionId: restored.data.fromRevisionId, newRevisionId: restored.data.newRevisionId, publishedStatus: publishAfterRestore.status, publicObserved: true, reopened: true },
  publicHeaders: { edit: observedEdit.headers, restore: observedRestore.headers },
  generatedAt: new Date().toISOString(),
}
await mkdir(outputPath.slice(0, outputPath.lastIndexOf("/")), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report))
