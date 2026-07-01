import type { BrowserInteractionStep } from "@automattic/wp-codebox-core"
import type { BrowserProbeErrorRecord, BrowserProbeNetworkRecord, BrowserStepAssertion } from "./browser-artifacts.js"

type BrowserObservationAssertionType = "no-console-errors" | "no-page-errors" | "request-count-by-host" | "request-count-by-type"
type BrowserObservationAssertionOperator = "=" | "==" | "!=" | ">" | ">=" | "<" | "<="

interface BrowserObservationAssertionSpec {
  raw: string
  type: BrowserObservationAssertionType
  name?: string
  operator?: BrowserObservationAssertionOperator
  expected?: number
}

export function executeBrowserObservationAssertion(
  step: BrowserInteractionStep,
  consoleMessages: Record<string, unknown>[],
  pageErrors: BrowserProbeErrorRecord[],
  network: BrowserProbeNetworkRecord[],
): BrowserStepAssertion {
  const spec = parseBrowserObservationAssertion(String(step.assertion ?? ""))
  const base = {
    kind: "probe" as const,
    id: spec.raw,
    assertion: spec.raw,
    name: spec.name,
    state: spec.type,
    operator: spec.operator,
    expected: spec.expected,
  }

  switch (spec.type) {
    case "no-console-errors": {
      const actual = consoleMessages.filter((message) => message.type === "error").length
      return finalizeBrowserObservationAssertion(base, actual, 0, actual === 0, ["files/browser/console.jsonl"])
    }
    case "no-page-errors": {
      const actual = pageErrors.filter((error) => error.type === "pageerror").length
      return finalizeBrowserObservationAssertion(base, actual, 0, actual === 0, ["files/browser/errors.jsonl"])
    }
    case "request-count-by-host": {
      const actual = network.filter((record) => requestHost(record.url) === spec.name).length
      return finalizeBrowserObservationAssertion(base, actual, spec.expected, compareNumbers(actual, spec.expected ?? 0, spec.operator ?? "<="), ["files/browser/network.jsonl"])
    }
    case "request-count-by-type": {
      const actual = network.filter((record) => record.resourceType === spec.name).length
      return finalizeBrowserObservationAssertion(base, actual, spec.expected, compareNumbers(actual, spec.expected ?? 0, spec.operator ?? "<="), ["files/browser/network.jsonl"])
    }
  }
}

function parseBrowserObservationAssertion(rawValue: string): BrowserObservationAssertionSpec {
  const raw = rawValue.trim()
  if (raw === "no-console-errors" || raw === "no-page-errors") {
    return { raw, type: raw }
  }

  for (const type of ["request-count-by-host", "request-count-by-type"] as const) {
    const prefix = `${type}:`
    if (raw.startsWith(prefix)) {
      const parsed = raw.slice(prefix.length).trim().match(/^(.*?)(>=|<=|==|!=|=|>|<)\s*(\d+)$/)
      if (!parsed || !parsed[1].trim()) {
        break
      }
      return { raw, type, name: parsed[1].trim(), operator: parsed[2] as BrowserObservationAssertionOperator, expected: Number.parseInt(parsed[3], 10) }
    }
  }

  throw new Error(`wordpress.browser-actions assertObservation supports no-console-errors, no-page-errors, request-count-by-host:<host><op><number>, and request-count-by-type:<type><op><number>: ${rawValue}`)
}

function finalizeBrowserObservationAssertion(
  base: Omit<BrowserStepAssertion, "passed">,
  observed: unknown,
  expectedBudget: unknown,
  passed: boolean,
  supportingArtifacts: string[],
): BrowserStepAssertion {
  return {
    ...base,
    status: passed ? "pass" : "fail",
    expected: expectedBudget,
    expectedBudget,
    actual: observed,
    observed,
    supportingArtifacts,
    passed,
  }
}

function requestHost(url: string): string | undefined {
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

function compareNumbers(actual: number, expected: number, operator: BrowserObservationAssertionOperator): boolean {
  switch (operator) {
    case "=":
    case "==":
      return actual === expected
    case "!=":
      return actual !== expected
    case ">":
      return actual > expected
    case ">=":
      return actual >= expected
    case "<":
      return actual < expected
    case "<=":
      return actual <= expected
  }
}
