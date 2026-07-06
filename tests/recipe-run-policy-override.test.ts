import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import { runRecipeRunCommand, runRecipeValidateCommand } from "../packages/cli/src/commands/recipe-run.js"
import { printHelp } from "../packages/cli/src/output.js"
import { withTempDir } from "../scripts/test-kit.js"

function captureStdout(callback: () => void): string {
  const original = console.log
  const lines: string[] = []
  console.log = (...args: unknown[]) => lines.push(args.join(" "))
  try {
    callback()
  } finally {
    console.log = original
  }
  return lines.join("\n")
}

await withTempDir("wp-codebox-recipe-run-policy-override-", async (directory) => {
  const recipePath = join(directory, "recipe.json")
  const restrictivePolicyPath = join(directory, "restrictive-policy.json")
  const completePolicyPath = join(directory, "complete-policy.json")

  await writeFile(recipePath, JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    workflow: {
      steps: [
        { command: "wordpress.run-php", args: ["code=echo 'ok';"] },
      ],
    },
  }))
  await writeFile(restrictivePolicyPath, JSON.stringify({
    network: "deny",
    filesystem: "readwrite-mounts",
    commands: ["inspect-mounted-inputs"],
    secrets: "none",
    approvals: "never",
  }))
  await writeFile(completePolicyPath, JSON.stringify({
    network: "deny",
    filesystem: "readwrite-mounts",
    commands: ["inspect-mounted-inputs", "wordpress.run-php"],
    secrets: "none",
    approvals: "never",
  }))

  const restrictiveExitCode = await runRecipeValidateCommand(["--recipe", recipePath, "--policy", restrictivePolicyPath, "--json"])
  assert.equal(restrictiveExitCode, 1)

  const restrictiveDryRunExitCode = await runRecipeRunCommand(["--recipe", recipePath, "--policy", restrictivePolicyPath, "--dry-run", "--json"])
  assert.equal(restrictiveDryRunExitCode, 1)

  const completeExitCode = await runRecipeValidateCommand(["--recipe", recipePath, "--policy", completePolicyPath, "--json"])
  assert.equal(completeExitCode, 0)

  const completeDryRunExitCode = await runRecipeRunCommand(["--recipe", recipePath, "--policy", completePolicyPath, "--dry-run", "--json"])
  assert.equal(completeDryRunExitCode, 0)
})

const help = captureStdout(printHelp)
assert.match(help, /recipe validate --recipe <path> \[--policy <json\|file>\]/)
assert.match(help, /recipe-run and recipe validate/)

console.log("recipe-run policy override validation ok")
