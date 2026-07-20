import * as PHPWasmNode from "@php-wasm/node"
import { compileBlueprint } from "@wp-playground/blueprints"
import { bootWordPressAndRequestHandler } from "@wp-playground/wordpress"
import type { MountSpec, RuntimeCreateSpec } from "@automattic/wp-codebox-core"
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http"
import { dirname } from "node:path"
import { playgroundBlueprint } from "./blueprint.js"
import { assertPhpWasmExternalExtensionsSupported } from "./php-wasm-preflight.js"
import type { PlaygroundCliServer, PlaygroundServerRunResponse } from "./preview-server.js"

const { createNodeFsMountHandler, loadNodeRuntime } = PHPWasmNode as unknown as {
  createNodeFsMountHandler(localPath: string): unknown
  loadNodeRuntime(phpVersion: AllPHPVersion, options?: { followSymlinks?: boolean; emscriptenOptions?: { processId?: number }; extensions?: Array<{ source: { format: "manifest"; manifestUrl: string } }> }): Promise<number>
}

type AllPHPVersion = "8.5" | "8.4" | "8.3" | "8.2" | "8.1" | "8.0" | "7.4" | "5.2"

interface ProgrammaticPHP {
  fileExists(path: string): boolean
  mkdir(path: string): void
  mount(vfsPath: string, mountHandler: unknown): Promise<unknown>
  onMessage(listener: (data: string) => Promise<string | void> | string | void): () => Promise<void>
  readFileAsText(path: string): string
  run(options: { code: string } | { scriptPath: string }): Promise<ProgrammaticPHPResponse>
  writeFile(path: string, contents: string): void
}

interface ProgrammaticPHPResponse {
  exitCode: number
  errors: string
  text: string
}

export interface ProgrammaticPlaygroundStartupOptions {
  bootstrapIniEntries: Record<string, string>
  phpIniEntries?: Record<string, string>
  wordpressDirectory: string
  wordpressInstallMode?: "install-from-existing-files" | "install-from-existing-files-if-needed" | "do-not-attempt-installing"
  sharedPhpIniContent: string
}

export async function startProgrammaticPlaygroundServer(spec: RuntimeCreateSpec, mounts: MountSpec[], options: ProgrammaticPlaygroundStartupOptions): Promise<PlaygroundCliServer> {
  const phpVersion = (spec.environment.phpVersion ?? "8.4") as AllPHPVersion
  await assertPhpWasmExternalExtensionsSupported(spec.environment.extensions)
  let nextProcessId = 1
  const phpIniEntries = {
    ...options.bootstrapIniEntries,
    ...options.phpIniEntries,
  }
  const requestHandler = await bootWordPressAndRequestHandler({
    createPhpRuntime: () => loadNodeRuntime(phpVersion, programmaticNodeRuntimeOptions(spec, nextProcessId++)),
    phpVersion,
    siteUrl: spec.preview?.siteUrl ?? "http://127.0.0.1",
    documentRoot: "/wordpress",
    sapiName: "cli",
    wordpressInstallMode: options.wordpressInstallMode ?? "install-from-existing-files",
    phpIniEntries,
    createFiles: {
      "/internal/shared/php.ini": options.sharedPhpIniContent,
      "/internal/shared/auto_prepend_file.php": autoPrependPhp(spec),
      "/internal/shared/mu-plugins/.keep": "",
      "/internal/shared/preload/.keep": "",
    },
    async onPHPInstanceCreated(php: unknown) {
      const programmaticPhp = php as ProgrammaticPHP
      await mountHostDirectory(programmaticPhp, "/wordpress", options.wordpressDirectory)
      for (const mount of mounts) {
        await mountHostDirectory(programmaticPhp, mount.target, mount.source)
      }
    },
  })

  const primaryPhp = await requestHandler.getPrimaryPhp() as ProgrammaticPHP
  await applyBlueprint(primaryPhp, spec)

  const httpServer = createHttpServer((incoming, outgoing) => {
    handleRequest(requestHandler, incoming, outgoing).catch((error: Error) => {
      if (!outgoing.headersSent) {
        outgoing.statusCode = 500
      }
      outgoing.end(error.message)
    })
  })
  const serverUrl = await listenHttpServer(httpServer, 0, "127.0.0.1")

  return {
    serverUrl,
    playground: {
      run: (runOptions) => runPhp(primaryPhp, runOptions),
      onMessage: (listener) => primaryPhp.onMessage(listener),
      readFileAsText: (path) => primaryPhp.readFileAsText(path),
      async writeFile(path, contents) {
        primaryPhp.writeFile(path, contents)
      },
    },
    async [Symbol.asyncDispose]() {
      await closeHttpServer(httpServer)
      await requestHandler[Symbol.asyncDispose]()
    },
  }
}

export function programmaticNodeRuntimeOptions(spec: RuntimeCreateSpec, processId: number): { followSymlinks: true; emscriptenOptions: { processId: number }; extensions?: Array<{ source: { format: "manifest"; manifestUrl: string } }> } {
  const extensions = spec.environment.extensions?.map((extension) => ({ source: { format: "manifest" as const, manifestUrl: extension.manifest } }))
  return {
    followSymlinks: true,
    emscriptenOptions: { processId },
    ...(extensions && extensions.length > 0 ? { extensions } : {}),
  }
}

function autoPrependPhp(spec: RuntimeCreateSpec): string {
  const recipe = spec.metadata?.recipe
  if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) {
    return "<?php\n"
  }

  const distribution = (recipe as { distribution?: unknown }).distribution
  if (!distribution || typeof distribution !== "object" || Array.isArray(distribution)) {
    return "<?php\n"
  }

  const env = (distribution as { env?: unknown }).env
  const constants = (distribution as { constants?: unknown }).constants
  const lines: string[] = []
  if (env && typeof env === "object" && !Array.isArray(env)) {
    for (const [name, value] of Object.entries(env)) {
      if (/^[A-Z_][A-Z0-9_]*$/.test(name) && (value === null || ["string", "number", "boolean"].includes(typeof value))) {
        lines.push(`putenv(${JSON.stringify(`${name}=${value === null ? "" : String(value)}`)});`)
      }
    }
  }
  if (constants && typeof constants === "object" && !Array.isArray(constants)) {
    for (const [name, value] of Object.entries(constants)) {
      if (/^[A-Z_][A-Z0-9_]*$/i.test(name) && (value === null || ["string", "number", "boolean"].includes(typeof value))) {
        lines.push(`if (!defined(${JSON.stringify(name)})) { define(${JSON.stringify(name)}, ${phpLiteral(value)}); }`)
      }
    }
  }

  return `<?php\n${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`
}

function phpLiteral(value: string | number | boolean | null): string {
  if (typeof value === "string") {
    return JSON.stringify(value)
  }
  if (value === null) {
    return "null"
  }
  return String(value)
}

async function mountHostDirectory(php: ProgrammaticPHP, vfsPath: string, hostPath: string): Promise<void> {
  ensureVfsParentDirectory(php, vfsPath)
  await php.mount(vfsPath, createNodeFsMountHandler(hostPath))
}

function ensureVfsParentDirectory(php: ProgrammaticPHP, vfsPath: string): void {
  const parent = dirname(vfsPath.replace(/\/+$/, ""))
  if (!parent || parent === "." || parent === "/" || php.fileExists(parent)) {
    return
  }
  ensureVfsParentDirectory(php, parent)
  if (!php.fileExists(parent)) {
    php.mkdir(parent)
  }
}

async function applyBlueprint(php: ProgrammaticPHP, spec: RuntimeCreateSpec): Promise<void> {
  const blueprint = playgroundBlueprint(spec.environment.blueprint, spec.policy, spec.preview?.siteUrl)
  if (!blueprint || typeof blueprint !== "object" || !("steps" in blueprint) || !Array.isArray(blueprint.steps) || blueprint.steps.length === 0) {
    return
  }

  const compiled = await compileBlueprint(blueprint)
  await compiled.run(php as never)
}

async function runPhp(php: ProgrammaticPHP, options: { code: string } | { scriptPath: string }): Promise<PlaygroundServerRunResponse> {
  const response = await php.run(options)
  return normalizePhpResponse(response)
}

function normalizePhpResponse(response: ProgrammaticPHPResponse): PlaygroundServerRunResponse {
  return {
    exitCode: response.exitCode,
    errors: response.errors,
    text: response.text,
  }
}

async function handleRequest(requestHandler: Awaited<ReturnType<typeof bootWordPressAndRequestHandler>>, incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
  const response = await requestHandler.request({
    url: incoming.url ?? "/",
    method: incoming.method ?? "GET",
    headers: incoming.headers as Record<string, string | string[]>,
    body: await readRequestBody(incoming),
  })

  outgoing.statusCode = response.httpStatusCode
  for (const [name, values] of Object.entries(response.headers)) {
    outgoing.setHeader(name, values as string[])
  }
  outgoing.end(response.bytes)
}

function readRequestBody(incoming: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    incoming.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    incoming.on("end", () => resolve(Buffer.concat(chunks)))
    incoming.on("error", reject)
  })
}

function listenHttpServer(server: HttpServer, port: number, bind: string): Promise<string> {
  return new Promise((resolve, reject) => {
    server.listen(port, bind, () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("Programmatic Playground server address is unavailable"))
        return
      }
      const host = bind === "0.0.0.0" ? "127.0.0.1" : bind
      resolve(`http://${host.includes(":") ? `[${host}]` : host}:${address.port}`)
    })
    server.once("error", reject)
  })
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
    server.closeAllConnections()
  })
}
