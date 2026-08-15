import { commandArgValue, type ExecutionResult, type WorkspaceRecipeStep } from "@automattic/wp-codebox-core"
import type { SmtpSinkInspectOptions } from "./runtime-services.js"

export function isSmtpSinkRecipeOperation(command: string): boolean {
  return command === "host/smtp.inspect" || command === "host/smtp.reset"
}

export function smtpSinkEvidenceValue(value: string): string {
  return `[redacted:${Buffer.byteLength(value)}]`
}

export async function executeSmtpSinkRecipeOperation(
  step: WorkspaceRecipeStep,
  services: { inspectSmtpSink(serviceId: string, options?: SmtpSinkInspectOptions): Promise<unknown>; resetSmtpSink(serviceId: string): Promise<unknown> },
): Promise<{ execution: ExecutionResult; evidenceArgs: string[] }> {
  const serviceId = commandArgValue(step.args ?? [], "service")
  if (!serviceId) throw new Error(`${step.command} requires service=<smtp-service-id>`)
  if (step.command === "host/smtp.reset") {
    const result = await services.resetSmtpSink(serviceId)
    const evidenceArgs = [`service=${smtpSinkEvidenceValue(serviceId)}`]
    return { execution: smtpExecution(step.command, evidenceArgs, result), evidenceArgs }
  }
  const limitText = commandArgValue(step.args ?? [], "limit")
  const limit = limitText === undefined ? undefined : Number(limitText)
  if (limitText !== undefined && (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 100)) throw new Error("host/smtp.inspect limit must be an integer from 1 through 100")
  const options = {
    limit,
    recipient: commandArgValue(step.args ?? [], "recipient"),
    recipientLabel: commandArgValue(step.args ?? [], "recipient-label"),
    subjectMarker: commandArgValue(step.args ?? [], "subject-marker"),
    linkMarker: commandArgValue(step.args ?? [], "link-marker"),
  }
  const result = await services.inspectSmtpSink(serviceId, options)
  // Query inputs are represented by fixed-size hashes and lengths in replay evidence.
  const evidenceArgs = [`service=${smtpSinkEvidenceValue(serviceId)}`, ...(limit === undefined ? [] : [`limit=${limit}`]), ...(options.recipient ? [`recipient=${smtpSinkEvidenceValue(options.recipient)}`] : []), ...(options.recipientLabel ? [`recipient-label=${options.recipientLabel}`] : []), ...(options.subjectMarker ? [`subject-marker=${smtpSinkEvidenceValue(options.subjectMarker)}`] : []), ...(options.linkMarker ? [`link-marker=${smtpSinkEvidenceValue(options.linkMarker)}`] : [])]
  return { execution: smtpExecution(step.command, evidenceArgs, result), evidenceArgs }
}

function smtpExecution(command: string, args: string[], json: unknown): ExecutionResult {
  const now = new Date().toISOString()
  const stdout = JSON.stringify(json)
  return { id: `smtp-sink-${Date.now()}`, command, args, exitCode: 0, stdout, stderr: "", startedAt: now, finishedAt: now, result: { schema: "wp-codebox/runtime-command-result/v1", status: "ok", stdout, stderr: "", json } }
}
