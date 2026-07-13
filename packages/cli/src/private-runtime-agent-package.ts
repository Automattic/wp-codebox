import { closeSync, openSync, readSync, unlinkSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const PRIVATE_PACKAGE_FD = 3
const PRIVATE_PACKAGE_MAGIC = Buffer.from("WPCBPKG1", "ascii")
const MAX_PRIVATE_PACKAGE_BYTES = 1024 * 1024

let privatePackagePath = ""

export function privateRuntimeAgentPackagePath(): string {
  return privatePackagePath || process.env.WP_CODEBOX_PRIVATE_RUNTIME_AGENT_PACKAGE_PATH || ""
}

export function receivePrivateRuntimeAgentPackage(): void {
  const header = Buffer.alloc(PRIVATE_PACKAGE_MAGIC.length + 4)
  readExact(PRIVATE_PACKAGE_FD, header)
  if (!header.subarray(0, PRIVATE_PACKAGE_MAGIC.length).equals(PRIVATE_PACKAGE_MAGIC)) {
    throw new Error("Private runtime package transport has an invalid protocol header.")
  }

  const size = header.readUInt32BE(PRIVATE_PACKAGE_MAGIC.length)
  if (size === 0 || size > MAX_PRIVATE_PACKAGE_BYTES) {
    throw new Error("Private runtime package transport size is invalid.")
  }

  const bytes = Buffer.alloc(size)
  try {
    readExact(PRIVATE_PACKAGE_FD, bytes)
    const path = join(tmpdir(), `wp-codebox-private-agent-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    const output = openSync(path, "wx", 0o600)
    try {
      let offset = 0
      while (offset < bytes.length) {
        const written = writeSync(output, bytes, offset, bytes.length - offset)
        if (written <= 0) throw new Error("Private runtime package transport could not be written completely.")
        offset += written
      }
    } catch (error) {
      unlinkSync(path)
      throw error
    } finally {
      closeSync(output)
    }
    privatePackagePath = path
  } finally {
    bytes.fill(0)
    header.fill(0)
    try { closeSync(PRIVATE_PACKAGE_FD) } catch {}
  }
}

export function clearPrivateRuntimeAgentPackage(): void {
  if (privatePackagePath) {
    try { unlinkSync(privatePackagePath) } catch {}
    privatePackagePath = ""
  }
}

function readExact(fd: number, buffer: Buffer): void {
  let offset = 0
  while (offset < buffer.length) {
    const read = readSync(fd, buffer, offset, buffer.length - offset, null)
    if (read <= 0) throw new Error("Private runtime package transport ended before its declared payload length.")
    offset += read
  }
}
