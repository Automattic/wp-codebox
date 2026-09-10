import { mkdir, writeFile } from "node:fs/promises"

const origin = process.env.BRICKS_PROBE_ORIGIN ?? "http://127.0.0.1:8795"
const password = process.env.BRICKS_PROBE_PASSWORD ?? "bricks-cloudflare-test-password"
const existingPageId = Number.parseInt(process.env.BRICKS_BUILDER_PAGE_ID ?? "", 10)
const outputPath = process.env.BRICKS_BUILDER_OUTPUT
const cookies = []

function remember(response) {
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";", 1)
    const [name, value] = pair.split("=", 2)
    const index = cookies.findIndex((cookie) => cookie.name === name)
    if (index >= 0) cookies[index] = { name, value }
    else cookies.push({ name, value })
  }
}

async function request(path, init = {}) {
  const headers = new Headers(init.headers)
  if (cookies.length) headers.set("cookie", cookies.map(({ name, value }) => `${name}=${value}`).join("; "))
  const response = await fetch(new URL(path, origin), { ...init, headers, redirect: "manual" })
  remember(response)
  return response
}

await request("/wp-login.php")
await request("/wp-login.php", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ log: "admin", pwd: password, redirect_to: `${origin}/wp-admin/`, testcookie: "1", "wp-submit": "Log In" }),
})
const dashboard = await request("/wp-admin/")
const dashboardHtml = await dashboard.text()
const restNonce = dashboardHtml.match(/"nonce":"([^"]+)"/)?.[1]
if (!restNonce) throw new Error("Missing REST nonce.")
let page
if (Number.isInteger(existingPageId) && existingPageId > 0) {
  const fetched = await request(`/wp-json/wp/v2/pages/${existingPageId}?context=edit`, { headers: { "x-wp-nonce": restNonce } })
  page = await fetched.json()
  if (!fetched.ok || !Number.isInteger(page.id)) throw new Error(`Could not read page: ${fetched.status} ${JSON.stringify(page).slice(0, 1000)}`)
} else {
  const created = await request("/wp-json/wp/v2/pages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-wp-nonce": restNonce },
    body: JSON.stringify({ title: "Bricks response diagnostic", status: "draft" }),
  })
  page = await created.json()
  if (!created.ok || !Number.isInteger(page.id)) throw new Error(`Could not create page: ${created.status} ${JSON.stringify(page).slice(0, 1000)}`)
}
let response = await request(`/?page_id=${page.id}&bricks=run`)
const redirectChain = []
for (let hop = 0; hop < 5 && response.status >= 300 && response.status < 400 && response.headers.get("location"); hop += 1) {
  redirectChain.push({ status: response.status, location: response.headers.get("location"), headers: Object.fromEntries(response.headers) })
  response = await request(response.headers.get("location"))
}
const body = await response.text()
const report = { status: response.status, headers: Object.fromEntries(response.headers), redirectChain, page: { id: page.id, title: page.title?.rendered }, body: body.slice(0, 8000) }
if (outputPath) {
  await mkdir(outputPath.slice(0, outputPath.lastIndexOf("/")), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`)
}
console.log(JSON.stringify(report))
