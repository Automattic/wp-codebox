import { randomBytes } from "node:crypto"
import { argValue } from "./command-args.js"
import { phpCliStreamConstants } from "./php-snippets.js"

interface WpCliTemporaryScriptFilesystem {
  writeFile(path: string, contents: string): Promise<void>
  unlink(path: string): Promise<void> | void
}

export function wpCliCommandFromArgs(args: string[]): string {
  const explicit = argValue(args, "command")
  if (explicit) {
    return explicit.trim()
  }

  return args.join(" ").trim()
}

export function shellArgv(command: string): string[] {
  const args: string[] = []
  let current = ""
  let quote = ""

  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    if (!quote && /\s/.test(char)) {
      if (current) {
        args.push(current)
        current = ""
      }
      continue
    }

    if ((char === "'" || char === '"') && (!quote || quote === char)) {
      quote = quote ? "" : char
      continue
    }

    if (char === "\\" && index + 1 < command.length) {
      current += command[++index]
      continue
    }

    current += char
  }

  if (quote) {
    throw new Error("Unclosed quote in wordpress.wp-cli command")
  }

  if (current) {
    args.push(current)
  }

  return args
}

export function wpCliPhpScript(argv: string[]): string {
  return `<?php
putenv('SHELL_PIPE=0');
$GLOBALS['argv'] = array_merge(array('/tmp/wp-cli.phar', '--path=/wordpress', '--no-color'), json_decode(${JSON.stringify(JSON.stringify(argv))}, true));
${phpCliStreamConstants()}
require '/tmp/wp-cli.phar';
`
}

export async function runWithTemporaryWpCliScript<T>(filesystem: WpCliTemporaryScriptFilesystem, runtimeId: string, argv: string[], run: (scriptPath: string) => Promise<T>): Promise<T> {
  const runtimeNamespace = runtimeId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80) || "runtime"
  const scriptPath = `/tmp/wp-codebox-wp-cli-${runtimeNamespace}-${randomBytes(16).toString("hex")}.php`
  await filesystem.writeFile(scriptPath, wpCliPhpScript(argv))
  try {
    return await run(scriptPath)
  } finally {
    await Promise.resolve(filesystem.unlink(scriptPath)).catch(() => undefined)
  }
}

export function cleanWpCliOutput(output: string): string {
  return output.replace(/^#!\/usr\/bin\/env php\r?\n/, "")
}
