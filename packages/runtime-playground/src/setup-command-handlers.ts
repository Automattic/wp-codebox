import { argValue, booleanArg } from "./command-args.js"

export interface PluginSetupCommandInput {
  action: "install" | "list"
  slug?: string
  activate: boolean
  network: boolean
}

export interface ThemeSetupCommandInput {
  action: "install" | "switch" | "list"
  slug?: string
  activate: boolean
}

export function pluginSetupInputFromArgs(args: string[]): PluginSetupCommandInput {
  const action = setupActionFromArgs(args, "plugin", ["install", "list"])
  const slug = setupSlugFromArgs(args, "plugin")
  if (action === "install" && !slug) {
    throw new Error("wordpress.plugin-setup install requires plugin=<slug> or slug=<slug>")
  }

  return {
    action,
    ...(slug ? { slug } : {}),
    activate: booleanArg(args, "activate", false),
    network: booleanArg(args, "network", false),
  }
}

export function themeSetupInputFromArgs(args: string[]): ThemeSetupCommandInput {
  const action = setupActionFromArgs(args, "theme", ["install", "switch", "list"])
  const slug = setupSlugFromArgs(args, "theme")
  if ((action === "install" || action === "switch") && !slug) {
    throw new Error(`wordpress.theme-setup ${action} requires theme=<slug> or slug=<slug>`)
  }

  return {
    action,
    ...(slug ? { slug } : {}),
    activate: booleanArg(args, "activate", false),
  }
}

function setupActionFromArgs<TAction extends string>(args: string[], kind: string, allowed: readonly TAction[]): TAction {
  const action = (argValue(args, "action")?.trim() || "list") as TAction
  if (!allowed.includes(action)) {
    throw new Error(`wordpress.${kind}-setup action must be ${allowed.join(", ")}`)
  }
  return action
}

function setupSlugFromArgs(args: string[], kind: "plugin" | "theme"): string | undefined {
  const value = (argValue(args, kind) ?? argValue(args, "slug") ?? "").trim()
  if (!value) {
    return undefined
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(value)) {
    throw new Error(`wordpress.${kind}-setup only accepts WordPress.org ${kind} slugs; paths, URLs, and package files are not accepted`)
  }
  return value
}
