declare module "@php-wasm/universal" {
  export interface PHPRequest {
    method?: string
    url: string
    headers?: Record<string, string>
    body?: string | Uint8Array
  }

  export interface PHPResponseData {
    readonly headers: Record<string, string[]>
    readonly bytes: Uint8Array
    readonly errors: string
    readonly exitCode: number
    readonly httpStatusCode: number
  }

  export class PHP {
    unlink(path: string): void
    constructor(runtimeId: number)
    run(request: { code: string }): Promise<{ bytes: Uint8Array; text: string }>
    isDir(path: string): boolean
    listFiles(path: string): string[]
    mkdir(path: string): void
    readFileAsBuffer(path: string): Uint8Array
    writeFile(path: string, data: Uint8Array): void
    exit(code?: number): void
  }

  export function loadPHPRuntime(loader: {
    dependencyFilename: string
    dependenciesTotalSize: number
    phpWasmAsyncMode: "asyncify"
    init: unknown
  }, options: {
    instantiateWasm: unknown
  }): Promise<number>

  export class PHPRequestHandler {
    getPrimaryPhp(): Promise<PHP>
    request(request: PHPRequest): Promise<PHPResponseData>
  }
}
