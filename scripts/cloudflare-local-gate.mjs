import { spawn } from "node:child_process"

const port = 8792
const url = `http://127.0.0.1:${port}/`
const child = spawn("npm", ["exec", "--", "wrangler", "dev", "--config", "packages/runtime-cloudflare/wrangler.jsonc", "--port", String(port)], {
  cwd: process.cwd(),
  stdio: ["ignore", "pipe", "pipe"],
})

let output = ""
child.stdout.on("data", (chunk) => { output += chunk })
child.stderr.on("data", (chunk) => { output += chunk })

try {
  await waitForServer()
  await assertHealthResponse()
  await assertHealthResponse()
  console.log("Cloudflare local runtime gate passed: two HTTP 200 health envelopes returned.")
} finally {
  child.kill("SIGTERM")
  await new Promise((resolve) => child.once("exit", resolve))
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

async function assertHealthResponse() {
  const response = await fetch(url)
  if (response.status !== 200) throw new Error(`Expected HTTP 200, received ${response.status}: ${await response.text()}`)
  const body = await response.json()
  if (body.schema !== "wp-codebox/cloudflare-runtime-health/v1" || body.marker !== "wp-codebox-cloudflare-runtime-health" || body.phpVersion !== "8.5.8" || typeof body.wordpressVersion !== "string" || body.execution?.schema !== "wp-codebox/runtime-command-result/v1" || body.execution?.status !== "ok") {
    throw new Error(`Unexpected Cloudflare runtime health envelope: ${JSON.stringify(body)}`)
  }
}
