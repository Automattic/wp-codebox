import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { promisify } from "node:util"

import { assembleWordpressPluginZip } from "./lib/assemble-wordpress-plugin-zip.ts"

const execFileAsync = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, "..")

await execFileAsync("npm", ["run", "release:package"], {
	cwd: repoRoot,
	env: {
		...process.env,
		WP_CODEBOX_RELEASE_PLATFORM: process.env.WP_CODEBOX_RELEASE_PLATFORM ?? "linux",
		WP_CODEBOX_RELEASE_ARCH: process.env.WP_CODEBOX_RELEASE_ARCH ?? "x64",
	},
	maxBuffer: 1024 * 1024 * 20,
})

const outputZip = await assembleWordpressPluginZip(repoRoot)
console.log(`Built ${outputZip}`)
