import { BROWSER_PROBE_ACCEPTED_ARGS, BROWSER_PROBE_BROWSER_VALUES, BROWSER_PROBE_CAPTURE_VALUES, BROWSER_PROBE_CHROMIUM_PROFILE_IDS, BROWSER_PROBE_PROFILES, BROWSER_PROBE_THROTTLE_PROFILE_IDS, commandRegistry, type WorkspaceRecipe } from "@automattic/wp-codebox-core/contracts"
import { validateWorkspaceRecipe } from "../packages/cli/src/recipe-validation.js"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

async function validationIssueCodes(args: string[]): Promise<string[]> {
  const recipe: WorkspaceRecipe = {
    schema: "wp-codebox/workspace-recipe/v1",
    version: 1,
    workflow: {
      steps: [
        {
          command: "wordpress.browser-probe",
          args: ["url=/", ...args],
        },
      ],
    },
  }

  return (await validateWorkspaceRecipe(recipe, "browser-probe-contract-smoke.json")).map((issue) => issue.code)
}

async function main(): Promise<void> {
  const browserProbe = commandRegistry.find((command) => command.id === "wordpress.browser-probe")
  assert(browserProbe, "wordpress.browser-probe must be registered")
  assert(browserProbe.acceptedArgs === BROWSER_PROBE_ACCEPTED_ARGS, "browser probe registry must use the shared accepted args definition")

  const acceptedArgNames = new Set(browserProbe.acceptedArgs.map((arg) => arg.name))
  for (const name of ["browser", "profile", "profiles", "viewport", "throttle", "timezone", "user-agent", "permissions", "timeout", "stall-timeout", "observe"]) {
    assert(acceptedArgNames.has(name), `browser probe registry is missing arg: ${name}`)
  }

  for (const profileId of BROWSER_PROBE_CHROMIUM_PROFILE_IDS) {
    const profile = BROWSER_PROBE_PROFILES[profileId]
    assert(profile.browser === "chromium", `${profileId} must be runnable by the Chromium runner`)
    assert(profile.args.some((arg) => arg === "browser=chromium"), `${profileId} must request chromium explicitly`)
  }

  assert(!BROWSER_PROBE_BROWSER_VALUES.includes("webkit" as never), "shared browser values must not advertise WebKit until the runner supports it")
  assert(!BROWSER_PROBE_CHROMIUM_PROFILE_IDS.includes("desktop-webkit" as never), "shared profiles must not advertise desktop-webkit until runnable")
  assert(!BROWSER_PROBE_CHROMIUM_PROFILE_IDS.includes("mobile-webkit" as never), "shared profiles must not advertise mobile-webkit until runnable")

  assert((await validationIssueCodes(["browser=chromium"])).length === 0, "recipe validation must accept shared Chromium browser value")
  assert((await validationIssueCodes([`profile=${BROWSER_PROBE_CHROMIUM_PROFILE_IDS[0]}`])).length === 0, "recipe validation must accept shared Chromium profile value")
  assert((await validationIssueCodes([`profiles=${BROWSER_PROBE_CHROMIUM_PROFILE_IDS.join(",")}`])).length === 0, "recipe validation must accept shared Chromium profile matrix values")
  assert((await validationIssueCodes([`throttle=${BROWSER_PROBE_THROTTLE_PROFILE_IDS[0]}`])).length === 0, "recipe validation must accept shared throttle profile value")
  assert((await validationIssueCodes([`capture=${BROWSER_PROBE_CAPTURE_VALUES.join(",")}`])).length === 0, "recipe validation must accept shared capture values")

  assert((await validationIssueCodes(["browser=webkit"])).includes("invalid-browser"), "recipe validation must reject non-runnable WebKit browser value")
  assert((await validationIssueCodes(["profile=desktop-webkit"])).includes("invalid-profile"), "recipe validation must reject non-runnable WebKit profile")
  assert((await validationIssueCodes(["profiles=desktop-chrome,mobile-webkit"])).includes("invalid-profile"), "recipe validation must reject non-runnable WebKit profile matrices")
}

await main()
