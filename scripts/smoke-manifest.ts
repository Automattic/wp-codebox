export type SmokeCommand = {
  name: string
  command: string
  args: string[]
}

type SmokeGroupDefinition = {
  description: string
  commands: SmokeCommand[]
}

function npmScript(name: string): SmokeCommand {
  return {
    name,
    command: "npm",
    args: ["run", name],
  }
}

/*
 * Test files are not registered here. `scripts/smoke-discovery.ts` finds
 * tests/*.test.{ts,mjs} and scripts/*-smoke.{ts,php} by convention, and
 * `npm run check` runs them after the commands below.
 *
 * This group is only for work that is not a single test file: compilation and
 * typechecking. Everything else belongs in a discovered file.
 */
export const smokeGroups = {
  declared: {
    description: "Build and typecheck work that file discovery cannot express.",
    commands: [
      // tsc -b for runtime-core/runtime-playground/cli, plus the CLI bin
      // permission and build-provenance steps.
      npmScript("build"),
      // These chains order their member files deliberately, and some of those
      // files depend on earlier ones having run. Discovery cannot express that,
      // so the chains stay and their members are excluded from discovery via
      // CHAIN_OWNED_FILES in smoke-discovery.ts.
      npmScript("test:generic-primitives"),
      npmScript("test:runtime-services"),
    ],
  },
} satisfies Record<string, SmokeGroupDefinition>

export const smokeManifest = {
  groups: smokeGroups,
  aggregateGroups: {
    check: ["declared"],
  },
} as const

export type SmokeGroupName = keyof typeof smokeGroups
export type SmokeAggregateGroupName = keyof typeof smokeManifest.aggregateGroups
