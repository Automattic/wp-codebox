import { execFile } from "node:child_process"
import { cp, mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const recursiveRmOptions = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }

/**
 * Assemble the WordPress plugin distribution zip from already-staged inputs.
 *
 * This helper assumes the CLI release bundle has already been staged at
 * `dist/release/wp-codebox-cli` (produced by `package-release-artifact.ts`).
 * It does NOT invoke `release:package` itself, so it is safe to call from
 * inside the release artifact script without recursing.
 *
 * @param repoRoot Absolute path to the repository root.
 * @returns Absolute path to the produced `wp-codebox.zip`.
 */
export async function assembleWordpressPluginZip(repoRoot: string): Promise<string> {
	const pluginSource = join(repoRoot, "packages", "wordpress-plugin")
	const outputDirectory = join(pluginSource, "dist")
	const outputZip = join(outputDirectory, "wp-codebox.zip")
	const cliPackageRoot = join(repoRoot, "dist", "release", "wp-codebox-cli")
	const stagingRoot = await mkdtemp(join(tmpdir(), "wp-codebox-plugin-"))
	const stagingPlugin = join(stagingRoot, "wp-codebox")

	try {
		await mkdir(outputDirectory, { recursive: true })
		await mkdir(stagingPlugin, { recursive: true })
		await cp(join(pluginSource, "wp-codebox.php"), join(stagingPlugin, "wp-codebox.php"))
		await cp(join(pluginSource, "README.md"), join(stagingPlugin, "README.md"))
		await cp(join(pluginSource, "src"), join(stagingPlugin, "src"), { recursive: true })
		if (await exists(join(pluginSource, "assets"))) {
			await cp(join(pluginSource, "assets"), join(stagingPlugin, "assets"), { recursive: true })
		}
		await cp(cliPackageRoot, join(stagingPlugin, "vendor", "wp-codebox-cli"), { recursive: true })
		await rm(outputZip, { force: true })
		await execFileAsync("zip", ["-qr", outputZip, "wp-codebox"], { cwd: stagingRoot })
		return outputZip
	} finally {
		await rm(stagingRoot, recursiveRmOptions)
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path)
		return true
	} catch {
		return false
	}
}

if (import.meta.filename === resolve(process.argv[1] ?? "")) {
	const repoRoot = resolve(import.meta.dirname, "..", "..")
	const outputZip = await assembleWordpressPluginZip(repoRoot)
	console.log(`Built ${outputZip}`)
}
