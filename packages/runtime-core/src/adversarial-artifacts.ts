import { ArtifactBundleWriter } from "./artifact-layout.js"
import { calculateArtifactContentDigest, type ArtifactManifest } from "./artifact-manifest.js"
import type { AdversarialCampaignResult } from "./adversarial-campaign.js"

export const ADVERSARIAL_EVIDENCE_BUNDLE_SCHEMA = "wp-codebox/adversarial-evidence-bundle/v1" as const

export interface AdversarialEvidenceBundle {
  schema: typeof ADVERSARIAL_EVIDENCE_BUNDLE_SCHEMA
  path: string
  manifestPath: string
  resultPath: string
  findingPaths: string[]
  replayPaths: string[]
  secretScanPath: string
  contentDigest: string
  bytes: number
  redactions: number
}

export async function writeAdversarialEvidenceBundle(directory: string, result: AdversarialCampaignResult, options: { maxBytes?: number; sensitiveValues?: string[]; createdAt?: string } = {}): Promise<AdversarialEvidenceBundle> {
  const maximum = options.maxBytes ?? 100 * 1_048_576
  const writer = new ArtifactBundleWriter(directory)
  const findingPaths: string[] = []
  const replayPaths: string[] = []
  let bytes = 0
  let redactions = 0
  const writeJson = async (path: string, value: unknown, kind: string): Promise<void> => {
    const redacted = redactAdversarialEvidence(value, options.sensitiveValues ?? [])
    redactions += redacted.redactions
    bytes += Buffer.byteLength(redacted.contents)
    if (bytes > maximum) throw new Error(`Adversarial evidence bundle exceeds ${maximum} bytes.`)
    await writer.write(path, redacted.contents, { kind, contentType: "application/json", redaction: { policy: "applied", sensitive: true, reason: "Adversarial evidence is secret-scanned and path-normalized before publication." } })
  }

  await writeJson("result/adversarial-campaign-result.json", result, "adversarial-campaign-result")
  for (const finding of result.findings) {
    const findingPath = `findings/${finding.fingerprint}.json`
    const replayPath = `replay/${finding.fingerprint}.json`
    await writeJson(findingPath, finding, "adversarial-finding")
    await writeJson(replayPath, finding.replay, "adversarial-replay")
    findingPaths.push(findingPath)
    replayPaths.push(replayPath)
  }
  const secretScanPath = "evidence/secret-scan.json"
  await writeJson(secretScanPath, { schema: "wp-codebox/adversarial-secret-scan/v1", status: redactions > 0 ? "redacted" : "passed", redactions, scannedFiles: 1 + findingPaths.length + replayPaths.length }, "secret-scan")

  const contentDigestInputs = ["result/adversarial-campaign-result.json", ...findingPaths, ...replayPaths, secretScanPath]
  const contentDigest = await calculateArtifactContentDigest(directory, contentDigestInputs)
  const createdAt = options.createdAt ?? new Date().toISOString()
  const manifest: ArtifactManifest = {
    id: `${result.campaignId}-adversarial-evidence`,
    contentDigest: { algorithm: "sha256", value: contentDigest, inputs: contentDigestInputs },
    createdAt,
    runtime: { id: "adversarial-runtime", backend: "declared-adapter", environment: { kind: "runtime", name: "Adversarial campaign" }, createdAt, status: "created" },
    files: [],
  }
  await writer.writeManifest(manifest)
  return { schema: ADVERSARIAL_EVIDENCE_BUNDLE_SCHEMA, path: directory, manifestPath: "manifest.json", resultPath: "result/adversarial-campaign-result.json", findingPaths, replayPaths, secretScanPath, contentDigest, bytes, redactions }
}

export function redactAdversarialEvidence(value: unknown, sensitiveValues: readonly string[] = []): { contents: string; redactions: number } {
  let contents = `${JSON.stringify(value, null, 2)}\n`
  let redactions = 0
  const replace = (pattern: RegExp, replacement: string): void => {
    const matches = contents.match(pattern)
    redactions += matches?.length ?? 0
    contents = contents.replace(pattern, replacement)
  }
  replace(/("(?:authorization|cookie|password|passwd|secret|token|apiKey|api_key)"\s*:\s*")[^"]*(")/gi, "$1[redacted]$2")
  replace(/("(?:path|sourcePath|workspace|cwd)"\s*:\s*")\/(?:home|Users|var|tmp)\/[^"\n]*(")/g, "$1[redacted-path]$2")
  for (const secret of sensitiveValues.filter(Boolean)) {
    const pattern = new RegExp(escapeRegExp(secret), "g")
    replace(pattern, "[redacted]")
  }
  return { contents, redactions }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
