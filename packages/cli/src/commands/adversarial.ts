import { runRecipeRunCommand } from "./recipe-run.js"

export async function runAdversarialRecipeCommand(args: string[]): Promise<number> {
  return runRecipeRunCommand(args)
}

export async function runAdversarialReplayCommand(args: string[]): Promise<number> {
  const mapped: string[] = []
  let hasReplay = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string
    if (arg === "--replay") {
      const value = args[++index]
      if (!value) throw new Error("Missing value for --replay")
      mapped.push("--adversarial-replay", value)
      hasReplay = true
    } else if (arg.startsWith("--replay=")) {
      mapped.push(`--adversarial-replay=${arg.slice("--replay=".length)}`)
      hasReplay = true
    } else {
      mapped.push(arg)
    }
  }
  if (!hasReplay) throw new Error("Missing required option: --replay")
  return runRecipeRunCommand(mapped)
}
