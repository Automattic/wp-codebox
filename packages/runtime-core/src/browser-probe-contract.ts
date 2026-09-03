export type BrowserProbeAcceptedArg = {
  name: string
  description: string
  required?: boolean
  repeatable?: boolean
  format?: string
}

export type BrowserProbeProfileDefinition = {
  id: string
  browser: "chromium"
  args: string[]
}

export const BROWSER_PROBE_BROWSER_VALUES = ["chromium"] as const

export const BROWSER_PROBE_CAPTURE_VALUES = ["console", "errors", "html", "network", "websocket", "performance", "memory", "screenshot", "video"] as const
export const BROWSER_PROBE_CHROMIUM_PROFILE_IDS = ["desktop-chrome", "mobile-chrome", "low-end-mobile-slow-4g"] as const
export const BROWSER_PROBE_THROTTLE_PROFILE_IDS = ["low-end-mobile-slow-4g"] as const
export const BROWSER_GEOLOCATION_PERMISSION_STATES = ["granted", "denied", "prompt"] as const
export const BROWSER_GEOLOCATION_PERMISSION_ALIASES = ["default"] as const
export const BROWSER_GEOLOCATION_MAX_ACCURACY_METERS = 1_000_000

export type BrowserGeolocationPermissionState = (typeof BROWSER_GEOLOCATION_PERMISSION_STATES)[number]

export interface BrowserGeolocation {
  latitude: number
  longitude: number
  accuracy?: number
  permission: BrowserGeolocationPermissionState
}

export function normalizeBrowserGeolocationPermissionState(value: string): BrowserGeolocationPermissionState {
  const normalized = value.trim().toLowerCase()
  if (normalized === "default") return "prompt"
  if ((BROWSER_GEOLOCATION_PERMISSION_STATES as readonly string[]).includes(normalized)) return normalized as BrowserGeolocationPermissionState
  throw new Error(`Browser geolocation permission must be ${[...BROWSER_GEOLOCATION_PERMISSION_STATES, ...BROWSER_GEOLOCATION_PERMISSION_ALIASES].join(", ")}: ${value}`)
}

export function browserGeolocation(input: Omit<BrowserGeolocation, "permission"> & { permission?: BrowserGeolocationPermissionState | "default" }): BrowserGeolocation {
  if (!Number.isFinite(input.latitude) || input.latitude < -90 || input.latitude > 90) throw new Error("Browser geolocation latitude must be a finite number between -90 and 90.")
  if (!Number.isFinite(input.longitude) || input.longitude < -180 || input.longitude > 180) throw new Error("Browser geolocation longitude must be a finite number between -180 and 180.")
  if (input.accuracy !== undefined && (!Number.isFinite(input.accuracy) || input.accuracy < 0 || input.accuracy > BROWSER_GEOLOCATION_MAX_ACCURACY_METERS)) throw new Error(`Browser geolocation accuracy must be a finite number between 0 and ${BROWSER_GEOLOCATION_MAX_ACCURACY_METERS}.`)
  return {
    latitude: input.latitude,
    longitude: input.longitude,
    ...(input.accuracy !== undefined ? { accuracy: input.accuracy } : {}),
    permission: normalizeBrowserGeolocationPermissionState(input.permission ?? "prompt"),
  }
}

export const BROWSER_PROBE_PROFILES: Record<(typeof BROWSER_PROBE_CHROMIUM_PROFILE_IDS)[number], BrowserProbeProfileDefinition> = {
  "desktop-chrome": {
    id: "desktop-chrome",
    browser: "chromium",
    args: ["browser=chromium", "viewport=1280x720"],
  },
  "mobile-chrome": {
    id: "mobile-chrome",
    browser: "chromium",
    args: ["browser=chromium", "device=Pixel 5"],
  },
  "low-end-mobile-slow-4g": {
    id: "low-end-mobile-slow-4g",
    browser: "chromium",
    args: ["browser=chromium", "device=Pixel 5", "throttle=low-end-mobile-slow-4g"],
  },
}

export const BROWSER_PROBE_ACCEPTED_ARGS: BrowserProbeAcceptedArg[] = [
  { name: "url", description: "Preview path or absolute URL to visit.", required: true, format: "path or URL" },
  { name: "wait-for", description: "Navigation wait condition.", format: "domcontentloaded|load|networkidle|selector:<selector>|duration" },
  { name: "duration", description: "Extra capture duration, or wait time when wait-for=duration.", format: "duration, e.g. 2s or 500ms" },
  { name: "browser", description: "Browser engine used by the probe runner.", format: BROWSER_PROBE_BROWSER_VALUES.join("|") },
  { name: "profile", description: "Single Chromium browser probe profile to apply.", format: BROWSER_PROBE_CHROMIUM_PROFILE_IDS.join("|") },
  { name: "profiles", description: "Comma-separated Chromium browser probe profile matrix.", format: BROWSER_PROBE_CHROMIUM_PROFILE_IDS.join(",") },
  { name: "device", description: "Optional built-in Playwright device profile to use for the browser context.", format: "Playwright device name, e.g. Pixel 5" },
  { name: "viewport", description: "Optional viewport size override.", format: "<width>x<height>, e.g. 390x844" },
  { name: "locale", description: "Optional browser context locale.", format: "BCP 47 locale, e.g. en-US" },
  { name: "timezone", description: "Optional browser context timezone.", format: "IANA timezone, e.g. America/New_York" },
  { name: "user-agent", description: "Optional browser context user agent override.", format: "string" },
  { name: "permissions", description: "Comma-separated browser permissions to grant to the context.", format: "comma-separated permission names" },
  { name: "geolocation-latitude", description: "Browser context geolocation latitude.", format: "finite number from -90 to 90" },
  { name: "geolocation-longitude", description: "Browser context geolocation longitude.", format: "finite number from -180 to 180" },
  { name: "geolocation-accuracy", description: "Optional browser context geolocation accuracy in meters.", format: `finite number from 0 to ${BROWSER_GEOLOCATION_MAX_ACCURACY_METERS}` },
  { name: "geolocation-permission", description: "Explicit browser context geolocation permission state. default is normalized to prompt.", format: [...BROWSER_GEOLOCATION_PERMISSION_STATES, ...BROWSER_GEOLOCATION_PERMISSION_ALIASES].join("|") },
  { name: "throttle", description: "Optional Chromium/CDP throttle profile, or none.", format: `none|${BROWSER_PROBE_THROTTLE_PROFILE_IDS.join("|")}` },
  { name: "auth", description: "Optional in-memory browser authentication mode. Use wordpress-admin to bootstrap WordPress admin cookies from PHP without writing token-bearing storage-state artifacts.", format: "wordpress-admin" },
  { name: "auth-user-id", description: "WordPress user ID used with auth=wordpress-admin; defaults to 1.", format: "positive integer" },
  { name: "storage-state", description: "Optional Playwright storageState JSON, or @<path> to JSON, imported into a fresh browser context. Summaries redact cookie/localStorage values and report only schema/kind, counts, hosts, and diagnostics.", format: "JSON object or @path" },
  { name: "pre-page-script", description: "Optional JavaScript installed before navigation so page scripts can observe mocked browser/payment capabilities.", format: "JavaScript source" },
  { name: "script", description: "Optional page-side JavaScript to evaluate after navigation and before final capture.", format: "JavaScript function body" },
  { name: "assert", description: "Repeatable DOM/browser assertion. Supports advisory:<assertion>, exists:<selector>, not-exists:<selector>, visible:<selector>, hidden:<selector>, count:<selector><op><number>, text:<selector> contains <text>, attr:<selector>[name][=value], no-console-errors, no-page-errors, request-count-by-host:<host><op><number>, request-count-by-type:<type><op><number>, total-transfer-size<op><number>, metric:<name><op><number>, and no-errors.", repeatable: true, format: "browser assertion" },
  { name: "capture", description: "Comma-separated artifacts to capture.", format: BROWSER_PROBE_CAPTURE_VALUES.join(",") },
  { name: "observe", description: "Comma-separated selectors to observe for browser lifecycle readiness evidence.", format: "comma-separated selectors" },
  { name: "fail-fast", description: "Stop liveness tracking at the first browser command stall.", format: "boolean" },
  { name: "stall-timeout", description: "Idle timeout for browser command progress.", format: "duration, e.g. 5s or 500ms" },
  { name: "timeout", description: "Total wall timeout for browser navigation and probe work.", format: "duration, e.g. 30s or 1500ms" },
  { name: "route-host", description: "Preview host alias routed to the local Playground preview.", repeatable: true, format: "hostname" },
  { name: "route-host-drain", description: "Whether pending routed requests must drain before the command succeeds. Use advisory for pages with long-lived routed requests that should be recorded but not fail evidence capture.", format: "required|advisory" },
  { name: "allow-host", description: "External host allowed by the browser preview network policy.", repeatable: true, format: "hostname" },
  { name: "block-host", description: "External host blocked by the browser preview network policy.", repeatable: true, format: "hostname" },
  { name: "record-external", description: "Record external network requests as policy evidence.", format: "boolean" },
  { name: "preview-mode", description: "Preview origin mode used for browser routing.", format: "local|public" },
  { name: "network-policy", description: "Browser preview network policy mode.", format: "record|deny" },
]
