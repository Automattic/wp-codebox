import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { renderMcpClientConfigArtifacts, type McpClientConfigRenderSpec } from "@automattic/wp-codebox-core"

export async function runMcpRenderClientConfigsCommand(args: string[]): Promise<number> {
  const specPath = optionValue(args, "--spec")
  if (!specPath) {
    console.error("Usage: wp-codebox mcp render-client-configs --spec <file>")
    return 1
  }

  const spec = JSON.parse(await readFile(resolve(specPath), "utf8")) as McpClientConfigRenderSpec
  const rendered = renderMcpClientConfigArtifacts(spec)

  for (const artifact of rendered.artifacts) {
    const absolutePath = resolve(artifact.path)
    await mkdir(dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, artifact.contents)
  }

  console.log(`Generated ${rendered.clients.length} local MCP client config artifacts in ${spec.outputRoot}`)
  return 0
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index === -1) {
    return undefined
  }
  return args[index + 1]
}
