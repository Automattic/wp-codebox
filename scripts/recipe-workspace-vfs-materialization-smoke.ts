import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, "..")
const workspace = await mkdtemp(join(tmpdir(), "wp-codebox-recipe-workspace-vfs-materialization-"))

try {
  const seed = join(workspace, "seed")
  const recipePath = join(workspace, "recipe.json")
  const artifacts = join(workspace, "artifacts")
  await mkdir(seed, { recursive: true })
  await writeFile(join(seed, "plugin.php"), "<?php\n// before\n")
  await writeFile(join(seed, "remove-me.txt"), "delete this\n")

  await writeFile(recipePath, `${JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: { wp: "7.0" },
    inputs: {
      workspaces: [
        {
          target: "/workspace/materialization-smoke",
          sourceMode: "repo-backed",
          seed: {
            type: "directory",
            source: "./seed",
            slug: "materialization-smoke",
          },
        },
      ],
    },
    workflow: {
      steps: [
        {
          command: "wordpress.run-php",
          args: [
            "code=" + [
              "file_put_contents('/workspace/materialization-smoke/plugin.php', \"<?php\\n// after from playground\\n\");",
              "file_put_contents('/workspace/materialization-smoke/generated.txt', \"created inside playground\\n\");",
              "unlink('/workspace/materialization-smoke/remove-me.txt');",
              "echo 'workspace mutated';",
            ].join(" "),
          ],
        },
      ],
    },
    artifacts: { directory: artifacts },
  }, null, 2)}\n`)

  const { stdout } = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "recipe-run", "--recipe", recipePath, "--json"], { cwd: root, timeout: 120_000 })
  const output = JSON.parse(stdout)
  assert.equal(output.success, true, output.error?.message ?? "recipe-run failed")
  assert.ok(output.artifacts?.directory, "recipe-run should return an artifact directory")

  const changedFiles = JSON.parse(await readFile(join(output.artifacts.directory, "files", "changed-files.json"), "utf8"))
  const changed = new Map(changedFiles.files.map((file: { relativePath: string }) => [file.relativePath, file]))
  assert.equal(changed.get("generated.txt")?.status, "added")
  assert.equal(changed.get("plugin.php")?.status, "modified")
  assert.equal(changed.get("remove-me.txt")?.status, "deleted")

  const patch = await readFile(join(output.artifacts.directory, "files", "patch.diff"), "utf8")
  assert.match(patch, /diff --git a\/workspace\/materialization-smoke\/generated\.txt b\/workspace\/materialization-smoke\/generated\.txt/)
  assert.match(patch, /\+created inside playground/)
  assert.match(patch, /\+\/\/ after from playground/)
  assert.match(patch, /deleted file mode 100644/)
} finally {
  await rm(workspace, { recursive: true, force: true })
}
