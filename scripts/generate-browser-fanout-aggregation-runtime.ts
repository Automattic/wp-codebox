import { readFile, writeFile } from "node:fs/promises"

const root = new URL("../", import.meta.url)
const sourceUrl = new URL("packages/runtime-core/src/browser-fanout-aggregation-runtime.js", root)
const browserRuntimeUrl = new URL("packages/wordpress-plugin/assets/browser-runtime.js", root)

const startMarker = "\t// BEGIN generated fanout aggregation runtime. Run `npm run generate:browser-fanout-aggregation-runtime`."
const endMarker = "\t// END generated fanout aggregation runtime."

const source = (await readFile(sourceUrl, "utf8")).trimEnd()
const browserRuntime = await readFile(browserRuntimeUrl, "utf8")
const start = browserRuntime.indexOf(startMarker)
const end = browserRuntime.indexOf(endMarker)

if (start === -1 || end === -1 || end <= start) {
  throw new Error("Browser runtime fanout aggregation generation markers were not found.")
}

const generated = [
  startMarker,
  ...source.split("\n").map((line) => line === "" ? "" : `\t${line}`),
  endMarker,
].join("\n")

const updated = `${browserRuntime.slice(0, start)}${generated}${browserRuntime.slice(end + endMarker.length)}`

await writeFile(browserRuntimeUrl, updated)
