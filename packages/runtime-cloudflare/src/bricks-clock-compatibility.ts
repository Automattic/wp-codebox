/**
 * PHP uniqid() polls gettimeofday until the microsecond changes. Cloudflare's
 * clock is frozen until I/O, so repeated IDs can stall in that loop. Preserve
 * Bricks' six-character ID generation while supplying random entropy directly.
 * Existing document IDs and the echo/return contract are untouched.
 */
export function patchBricksRandomIds(source: string): string {
  const before = "self::generate_hash( md5( uniqid( rand(), true ) ) )";
  const after = "self::generate_hash( bin2hex( random_bytes( 16 ) ) )";
  if (source.includes(after) && !source.includes(before)) return source;
  if (source.split(before).length !== 2) throw new Error("Unsupported Bricks random ID implementation.");
  return source.replace(before, after);
}

/** Undo the earlier public-request pruning: element controls need Settings_Base. */
export function restoreBricksSettings(source: string): string {
  const conditional = "\t\t\t$this->settings = new Settings();";
  const templates = "\t\t$this->templates = new Templates();";
  const restored = "\t\t$this->settings = new Settings();";
  if (!source.includes(conditional) && source.includes(restored)) return source;
  if (source.split(conditional).length !== 2 || source.split(templates).length !== 2) {
    throw new Error("Unsupported Bricks conditional Settings implementation.");
  }
  return source.replace(conditional, "").replace(templates, `${templates}\n${restored}`);
}
