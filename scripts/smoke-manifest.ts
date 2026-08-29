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
      // Carries `tsc -p packages/runtime-cloudflare --noEmit`. The test files it
      // chains are also discovered; the typecheck is the reason it stays.
      npmScript("test:cloudflare-runtime"),
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
