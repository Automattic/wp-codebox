import assert from "node:assert/strict"

import { parsePreviewHoldSeconds, PreviewOptionError, previewHoldMaxSeconds } from "../packages/cli/src/preview-options.js"

const originalCap = process.env.WP_CODEBOX_PREVIEW_HOLD_MAX_SECONDS

try {
  delete process.env.WP_CODEBOX_PREVIEW_HOLD_MAX_SECONDS
  assert.equal(parsePreviewHoldSeconds("2h"), 3600, "default cap remains one hour")

  process.env.WP_CODEBOX_PREVIEW_HOLD_MAX_SECONDS = "4h"
  assert.equal(previewHoldMaxSeconds(), 14_400, "operator cap accepts hour syntax")
  assert.equal(parsePreviewHoldSeconds("3h"), 10_800, "operator cap allows longer holds")
  assert.equal(parsePreviewHoldSeconds("5h"), 14_400, "requested hold clamps to operator cap")

  process.env.WP_CODEBOX_PREVIEW_HOLD_MAX_SECONDS = "25h"
  assert.throws(() => previewHoldMaxSeconds(), PreviewOptionError, "operator cap cannot exceed hard ceiling")
} finally {
  if (originalCap === undefined) {
    delete process.env.WP_CODEBOX_PREVIEW_HOLD_MAX_SECONDS
  } else {
    process.env.WP_CODEBOX_PREVIEW_HOLD_MAX_SECONDS = originalCap
  }
}

console.log("preview options ok")
