import { isWordPressRuntimeFile } from "./wordpress-runtime-corpus.js"

export const WORDPRESS_RUNTIME_ARTIFACT_SCHEMA = "wp-codebox/wordpress-runtime-artifact/v1"
export const WORDPRESS_RUNTIME_MAX_FILES = 2_000
export const WORDPRESS_RUNTIME_MAX_UNCOMPRESSED_BYTES = 24 * 1024 * 1024
export const WORDPRESS_RUNTIME_MAX_ARCHIVE_BYTES = 8 * 1024 * 1024
export const WORDPRESS_RUNTIME_MAX_FILE_BYTES = 8 * 1024 * 1024

export interface WordPressRuntimeArtifactManifest {
  schema: typeof WORDPRESS_RUNTIME_ARTIFACT_SCHEMA
  key: string
  archive: { sha256: string; size: number }
  source: { url: string; version?: string; identity?: string }
  files: Array<{ path: string; size: number; sha256: string }>
}

export interface RuntimeMemfs {
  writeFile(path: string, bytes: Uint8Array): void
  run(request: { code: string }): Promise<{ text: string }>
}

const WORDPRESS_RUNTIME_ARCHIVE_TEMP_PATH = "/tmp/wp-codebox-wordpress-runtime.zip"
const REQUIRED_WORDPRESS_RUNTIME_FILES = [
  "wordpress/index.php",
  "wordpress/wp-load.php",
  "wordpress/wp-includes/version.php",
  "wordpress/wp-settings.php",
]

export function wordpressRuntimeArtifactKey(sha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("WordPress runtime artifact hash must be a SHA-256 digest.")
  return `runtime/wordpress/${sha256}.zip`
}

export function validateWordPressRuntimeArtifactManifest(manifest: WordPressRuntimeArtifactManifest): void {
  if (manifest.schema !== WORDPRESS_RUNTIME_ARTIFACT_SCHEMA) throw new Error("WordPress runtime artifact schema is invalid.")
  if (manifest.key !== wordpressRuntimeArtifactKey(manifest.archive.sha256)) throw new Error("WordPress runtime artifact key is not content addressed.")
  if (!Number.isSafeInteger(manifest.archive.size) || manifest.archive.size < 1 || manifest.archive.size > WORDPRESS_RUNTIME_MAX_ARCHIVE_BYTES) throw new Error("WordPress runtime artifact archive size is outside the allowed budget.")
  if (!manifest.source.url.startsWith("https://")) throw new Error("WordPress runtime artifact source URL is invalid.")
  if (!manifest.files.length || manifest.files.length > WORDPRESS_RUNTIME_MAX_FILES) throw new Error("WordPress runtime artifact file count is outside the allowed budget.")

  const paths = new Set(manifest.files.map((file) => file.path))
  let total = 0
  for (const file of manifest.files) {
    if (!isSafeRuntimePath(file.path) || !isWordPressRuntimeFile(file.path, paths)) throw new Error(`WordPress runtime artifact contains an invalid file path: ${file.path}`)
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > WORDPRESS_RUNTIME_MAX_FILE_BYTES || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error(`WordPress runtime artifact has invalid metadata for ${file.path}.`)
    total += file.size
  }
  if (total > WORDPRESS_RUNTIME_MAX_UNCOMPRESSED_BYTES || paths.size !== manifest.files.length) throw new Error("WordPress runtime artifact file budget is invalid.")
}

export async function materializeWordPressRuntimeArtifact(php: RuntimeMemfs, bucket: R2Bucket, manifest: WordPressRuntimeArtifactManifest): Promise<{ materializedFiles: number; materializedBytes: number }> {
  validateWordPressRuntimeArtifactManifest(manifest)
  const object = await bucket.get(manifest.key)
  if (!object) throw new Error(`WordPress runtime artifact is unavailable: ${manifest.key}`)
  if (object.size > WORDPRESS_RUNTIME_MAX_ARCHIVE_BYTES) throw new Error("WordPress runtime artifact archive exceeds its size budget.")
  if (object.size !== manifest.archive.size) throw new Error("WordPress runtime artifact size does not match its manifest.")

  // The archive and expanded corpus caps leave most of the 128 MiB isolate for PHP-WASM and runtime overhead.
  const archiveBytes = new Uint8Array(await object.arrayBuffer())
  if (await sha256Hex(archiveBytes) !== manifest.archive.sha256) throw new Error("WordPress runtime artifact archive hash does not match its manifest.")

  // The archive digest binds these bytes to the already path- and budget-checked manifest.
  // Crossing into PHP once avoids per-file JS/WASM calls during cold boot.
  php.writeFile(WORDPRESS_RUNTIME_ARCHIVE_TEMP_PATH, archiveBytes)
  const output = (await php.run({ code: zipMaterializationCode(manifest) })).text.trim()
  let evidence: unknown
  try {
    evidence = JSON.parse(output)
  } catch {
    throw new Error(`WordPress runtime artifact extraction did not return valid evidence: ${output}`)
  }
  if (!isMaterializationEvidence(evidence, manifest)) throw new Error("WordPress runtime artifact extraction returned invalid evidence.")
  return evidence
}

function zipMaterializationCode(manifest: WordPressRuntimeArtifactManifest): string {
  const expected = Object.fromEntries(manifest.files.map((file) => [file.path, file.size]))
  const expectedJson = JSON.stringify(expected).replace(/</g, "\\u003c")
  const requiredJson = JSON.stringify(REQUIRED_WORDPRESS_RUNTIME_FILES)
  return `<?php
$archive_path = ${JSON.stringify(WORDPRESS_RUNTIME_ARCHIVE_TEMP_PATH)};
$expected = json_decode(${JSON.stringify(expectedJson)}, true, 512, JSON_THROW_ON_ERROR);
$required = json_decode(${JSON.stringify(requiredJson)}, true, 512, JSON_THROW_ON_ERROR);
try {
    if (!extension_loaded('zip') || !class_exists('ZipArchive')) {
        throw new RuntimeException('WordPress runtime artifact extraction requires the PHP ZipArchive extension.');
    }
    $zip = new ZipArchive();
    $opened = $zip->open($archive_path);
    if (true !== $opened) {
        throw new RuntimeException('WordPress runtime artifact ZIP could not be opened (ZipArchive status ' . $opened . ').');
    }
    try {
        if ($zip->numFiles !== count($expected)) {
            throw new RuntimeException('WordPress runtime artifact ZIP file count does not match its manifest.');
        }
        for ($index = 0; $index < $zip->numFiles; $index++) {
            $name = $zip->getNameIndex($index);
            $stat = $zip->statIndex($index);
            if (!is_string($name) || !array_key_exists($name, $expected) || !is_array($stat) || !isset($stat['size']) || (int) $stat['size'] !== $expected[$name]) {
                throw new RuntimeException('WordPress runtime artifact ZIP entries do not match its manifest.');
            }
        }
        if (!$zip->extractTo('/', array_keys($expected))) {
            throw new RuntimeException('WordPress runtime artifact ZIP extraction failed.');
        }
        foreach ($required as $path) {
            if (!is_file('/' . $path)) {
                throw new RuntimeException('WordPress runtime artifact is missing required file after extraction: ' . $path);
            }
        }
        echo json_encode(array('materializedFiles' => count($expected), 'materializedBytes' => array_sum($expected)), JSON_THROW_ON_ERROR);
    } finally {
        $zip->close();
    }
} finally {
    @unlink($archive_path);
}`
}

function isMaterializationEvidence(value: unknown, manifest: WordPressRuntimeArtifactManifest): value is { materializedFiles: number; materializedBytes: number } {
  if (!value || typeof value !== "object") return false
  const evidence = value as Record<string, unknown>
  return evidence.materializedFiles === manifest.files.length
    && evidence.materializedBytes === manifest.files.reduce((total, file) => total + file.size, 0)
}

function isSafeRuntimePath(path: string): boolean {
  return path.startsWith("wordpress/") && !path.includes("\\") && !path.split("/").some((segment) => !segment || segment === "." || segment === "..")
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
