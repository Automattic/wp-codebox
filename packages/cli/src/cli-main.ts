import { runCli } from "./cli-entry.js"
import { serializeError, wantsJsonOutput, writeJsonFailure } from "./output.js"

export type CliRunner = (args: string[]) => Promise<number>
export type CliExit = (code: number) => never

const UNSETTLED_COMMAND_MESSAGE = "WP Codebox CLI command did not settle before the Node.js event loop drained."

export function runCliEntrypoint(args: string[], runner: CliRunner = runCli, exit: CliExit = process.exit): void {
  let settled = false
  const writeStderr = process.stderr.write.bind(process.stderr)
  const handleBeforeExit = () => {
    if (settled) {
      return
    }
    if (wantsJsonOutput(args)) {
      writeJsonFailure(args[0], UNSETTLED_COMMAND_MESSAGE, { code: "unsettled-command" })
      process.exitCode = 1
      return
    }
    writeStderr(`${UNSETTLED_COMMAND_MESSAGE}\n`)
    process.exitCode = 1
  }

  process.once("beforeExit", handleBeforeExit)
  runner(args).then(
    (code) => {
      settled = true
      process.off("beforeExit", handleBeforeExit)
      process.exitCode = code
      exit(code)
    },
    (error) => {
      settled = true
      process.off("beforeExit", handleBeforeExit)
      const serialized = serializeError(error)
      if (wantsJsonOutput(args)) {
        writeJsonFailure(args[0], serialized.message, { code: serialized.code ?? "uncaught-error", error: serialized })
      } else {
        writeStderr(`${serialized.message}\n`)
      }
      process.exitCode = 1
      exit(1)
    },
  )
}
