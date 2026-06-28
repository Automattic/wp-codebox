import type { ExecutionResult } from "@automattic/wp-codebox-core"

export interface WordPressAdminAuthCommandRequirement {
  command: ExecutionResult
  userId: number
  redirectUrl?: string
}

const WORDPRESS_ADMIN_AUTH_ARG_COMMANDS = new Set([
  "wordpress.browser-actions",
  "wordpress.browser-probe",
  "wordpress.browser-page-load",
  "wordpress.browser-scenario",
  "wordpress.visual-compare",
])

const WORDPRESS_ADMIN_AUTH_REQUIRED_COMMANDS = new Set([
  "wordpress.editor-open",
  "wordpress.editor-actions",
  "wordpress.editor-validate-blocks",
])

export function commandWordPressAdminAuthRequirement(command: ExecutionResult): WordPressAdminAuthCommandRequirement | undefined {
  if (WORDPRESS_ADMIN_AUTH_REQUIRED_COMMANDS.has(command.command)) {
    return {
      command,
      userId: commandWordPressAdminAuthUserId(command),
      redirectUrl: commandRedirectUrl(command),
    }
  }

  if (!WORDPRESS_ADMIN_AUTH_ARG_COMMANDS.has(command.command) || !command.args.some((arg) => argRequestsWordPressAdminAuth(arg))) {
    return undefined
  }

  return {
    command,
    userId: commandWordPressAdminAuthUserId(command),
    redirectUrl: commandRedirectUrl(command),
  }
}

export function firstCommandWordPressAdminAuthRequirement(commands: ExecutionResult[]): WordPressAdminAuthCommandRequirement | undefined {
  for (const command of commands) {
    const requirement = commandWordPressAdminAuthRequirement(command)
    if (requirement) {
      return requirement
    }
  }
  return undefined
}

function commandWordPressAdminAuthUserId(command: ExecutionResult): number {
  const raw = command.args.map((arg) => argKeyValue(arg)).find((entry) => entry?.key === "auth-user-id")?.value
  const userId = raw ? Number.parseInt(raw, 10) : 1
  return Number.isInteger(userId) && userId > 0 ? userId : 1
}

function commandRedirectUrl(command: ExecutionResult): string | undefined {
  return command.args.map((arg) => argKeyValue(arg)).find((entry) => entry?.key === "url")?.value
}

function argRequestsWordPressAdminAuth(arg: string): boolean {
  const separator = arg.indexOf("=")
  if (separator > 0) {
    const key = arg.slice(0, separator).trim()
    const value = arg.slice(separator + 1).trim()
    if (key === "auth" && value === "wordpress-admin") {
      return true
    }
    if ((key === "scenario" || key === "scenario-json") && /"auth"\s*:\s*"wordpress-admin"/.test(value)) {
      return true
    }
  }

  return /"auth"\s*:\s*"wordpress-admin"/.test(arg)
}

function argKeyValue(arg: string): { key: string; value: string } | undefined {
  const separator = arg.indexOf("=")
  if (separator <= 0) {
    return undefined
  }
  return {
    key: arg.slice(0, separator).trim(),
    value: arg.slice(separator + 1).trim(),
  }
}
