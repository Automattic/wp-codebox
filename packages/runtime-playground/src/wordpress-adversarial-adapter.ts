import { createHash } from "node:crypto"

import {
  ADVERSARIAL_ORACLE_SCHEMA,
  clockControlCapabilities,
  negotiateTransportFaults,
  transportFaultCapabilities,
  type AdversarialCasePlan,
  type AdversarialExecutionObservation,
  type AdversarialOracleContract,
  type AdversarialOracleResult,
  type ClockControlCapabilities,
  type RuntimeEpisodeActionSpec,
  type TransportFaultCapabilities,
  type TransportFaultModel,
  type TransportFaultNegotiation,
} from "@automattic/wp-codebox-core"

export const WORDPRESS_ADVERSARIAL_ADAPTER_SCHEMA = "wp-codebox/wordpress-adversarial-adapter/v1" as const

export type WordPressAdversarialSurface =
  | "rest"
  | "ajax"
  | "xmlrpc"
  | "block"
  | "shortcode"
  | "serialized-value"
  | "option"
  | "meta"
  | "file"
  | "cron"
  | "cli"
  | "role-capability"
  | "multisite-membership"

export type WordPressAdapterFidelity = "exact" | "emulated" | "unsupported"

export interface WordPressAdversarialCapability {
  surface: WordPressAdversarialSurface
  fidelity: WordPressAdapterFidelity
  reason: string
}

export interface WordPressAdversarialAction {
  surface: WordPressAdversarialSurface
  operation: string
  target?: string
  input?: unknown
  actor?: { userId?: number; role?: string; blogId?: number; nonce?: string }
  metadata?: Record<string, unknown>
}

export interface WordPressAdversarialAdapter {
  schema: typeof WORDPRESS_ADVERSARIAL_ADAPTER_SCHEMA
  id: "wordpress-playground"
  capabilities: WordPressAdversarialCapability[]
  transportFaults: TransportFaultCapabilities
  clocks: ClockControlCapabilities
  oracleIds: string[]
}

export const WORDPRESS_ADVERSARIAL_CAPABILITIES: readonly WordPressAdversarialCapability[] = [
  { surface: "rest", fidelity: "exact", reason: "Dispatched through WP_REST_Request and rest_do_request()." },
  { surface: "ajax", fidelity: "unsupported", reason: "In-process admin-ajax callbacks may terminate PHP; use browser/server requests when an HTTP runtime is available." },
  { surface: "xmlrpc", fidelity: "unsupported", reason: "The disposable in-process runner does not provide a faithful XML-RPC HTTP request boundary." },
  { surface: "block", fidelity: "exact", reason: "Parsed, serialized, and rendered with WordPress block APIs." },
  { surface: "shortcode", fidelity: "exact", reason: "Executed through do_shortcode()." },
  { surface: "serialized-value", fidelity: "exact", reason: "Round-tripped through maybe_serialize() and maybe_unserialize()." },
  { surface: "option", fidelity: "exact", reason: "Mutated through the WordPress options API." },
  { surface: "meta", fidelity: "exact", reason: "Mutated through the WordPress metadata API." },
  { surface: "file", fidelity: "exact", reason: "Confined to a disposable uploads subdirectory with canonical-path escape evidence." },
  { surface: "cron", fidelity: "exact", reason: "Scheduled and invoked through WordPress cron and hook APIs using explicit timestamps." },
  { surface: "cli", fidelity: "exact", reason: "Executed by the existing WordPress WP-CLI runtime command." },
  { surface: "role-capability", fidelity: "exact", reason: "Mutated through WP_Role and WP_User capability APIs." },
  { surface: "multisite-membership", fidelity: "exact", reason: "Uses add_user_to_blog()/remove_user_from_blog() when multisite is enabled; otherwise reports unsupported." },
] as const

const transportCapabilities = [
  { semantic: "response-substitution", fidelity: "exact", reason: "WordPress HTTP API pre_http_request substitution returns the declared response." },
  { semantic: "malformed-response", fidelity: "emulated", reason: "Represented as a malformed WordPress HTTP API response, not malformed socket bytes." },
  { semantic: "truncated-response", fidelity: "emulated", reason: "Body truncation occurs at the WordPress HTTP API interception boundary." },
  { semantic: "delay", fidelity: "emulated", reason: "Delay is applied before returning from pre_http_request." },
  { semantic: "jitter", fidelity: "unsupported", reason: "Faithful deterministic jitter requires transport scheduling tracked by #2018." },
  { semantic: "timeout", fidelity: "emulated", reason: "Returned as a WP_Error timeout without a socket-level timeout." },
  { semantic: "connection-refusal", fidelity: "emulated", reason: "Returned as a WP_Error connection refusal without opening a socket." },
  { semantic: "connection-reset", fidelity: "emulated", reason: "Returned as a WP_Error reset without a socket-level reset." },
  { semantic: "chunked-response", fidelity: "unsupported", reason: "Exact transfer framing requires the socket proxy tracked by #2018." },
  { semantic: "bandwidth", fidelity: "unsupported", reason: "Exact byte pacing requires the socket proxy tracked by #2018." },
  { semantic: "half-close", fidelity: "unsupported", reason: "Exact connection state requires the socket proxy tracked by #2018." },
  { semantic: "disconnect-after-bytes", fidelity: "unsupported", reason: "Exact connection state requires the socket proxy tracked by #2018." },
  { semantic: "host-remap", fidelity: "unsupported", reason: "Host remapping is not performed at the WordPress HTTP API interception boundary." },
  { semantic: "request-corruption", fidelity: "unsupported", reason: "Wire request corruption requires the socket proxy tracked by #2018." },
  { semantic: "response-corruption", fidelity: "unsupported", reason: "Wire response corruption requires the socket proxy tracked by #2018." },
] as const

export const WORDPRESS_HTTP_TRANSPORT_FAULT_CAPABILITIES = transportFaultCapabilities("wordpress-http-api", [...transportCapabilities])

export const WORDPRESS_CLOCK_CONTROL_CAPABILITIES = clockControlCapabilities("wordpress-playground", [
  { surface: "runtime", freeze: false, advance: false, skew: false, restore: false, fidelity: "unsupported", reason: "PHP time(), current_time(), and current_datetime() have no global supported clock injection primitive in this runtime." },
  { surface: "browser", freeze: true, advance: true, skew: false, restore: true, fidelity: "exact", reason: "Use the existing Playwright clock controller for browser time." },
  { surface: "scheduler", freeze: true, advance: true, skew: true, restore: true, fidelity: "emulated", reason: "Campaigns select and invoke due cron events against an explicit timestamp; background spawn timing is not changed." },
  { surface: "database", freeze: false, advance: false, skew: false, restore: false, fidelity: "unsupported", reason: "The default SQLite runtime database clock is independent and exposes no supported injection primitive." },
])

export const WORDPRESS_ADVERSARIAL_ORACLES: readonly AdversarialOracleContract[] = [
  oracle("wordpress-authorization", "critical", "Authorization, nonce, and multisite tenant isolation must fail closed."),
  oracle("wordpress-injection", "critical", "Mutated input must not create execution or injection indicators."),
  oracle("wordpress-transactional-consistency", "high", "Failed operations must not leave partial state."),
  oracle("wordpress-duplicate-effect", "high", "Retries and concurrent actions must not produce duplicate effects."),
  oracle("wordpress-fail-open", "high", "External-service failures must not be treated as successful authorization or writes."),
  oracle("wordpress-filesystem-escape", "critical", "File mutations must remain inside their declared disposable root."),
  oracle("wordpress-secret-leakage", "critical", "Evidence and responses must not expose secrets."),
] as const

export function createWordPressAdversarialAdapter(): WordPressAdversarialAdapter {
  return {
    schema: WORDPRESS_ADVERSARIAL_ADAPTER_SCHEMA,
    id: "wordpress-playground",
    capabilities: WORDPRESS_ADVERSARIAL_CAPABILITIES.map((capability) => ({ ...capability })),
    transportFaults: WORDPRESS_HTTP_TRANSPORT_FAULT_CAPABILITIES,
    clocks: WORDPRESS_CLOCK_CONTROL_CAPABILITIES,
    oracleIds: WORDPRESS_ADVERSARIAL_ORACLES.map(({ id }) => id),
  }
}

export function negotiateWordPressHttpTransportFaults(model: TransportFaultModel): TransportFaultNegotiation {
  return negotiateTransportFaults(model, WORDPRESS_HTTP_TRANSPORT_FAULT_CAPABILITIES)
}

export function wordpressAdversarialActionSpec(action: WordPressAdversarialAction): RuntimeEpisodeActionSpec {
  const capability = WORDPRESS_ADVERSARIAL_CAPABILITIES.find((candidate) => candidate.surface === action.surface)
  if (!capability || capability.fidelity === "unsupported") {
    throw new Error(`WordPress adversarial surface ${action.surface} is unsupported: ${capability?.reason ?? "not declared"}`)
  }
  if (action.surface === "cli") {
    const command = typeof action.input === "string" ? action.input : ""
    if (!command) throw new Error("WordPress adversarial CLI actions require a non-empty string input.")
    return { kind: "command", command: "wordpress.wp-cli", args: [`command=${command}`], operation: `adversarial:${action.surface}`, metadata: actionMetadata(action, capability) }
  }
  return {
    kind: "command",
    command: "wordpress.run-php",
    args: [`code=${wordpressAdversarialHarnessPhp(action)}`, "capture-diagnostics=wpdb-queries"],
    operation: `adversarial:${action.surface}`,
    metadata: actionMetadata(action, capability),
  }
}

export function wordpressSchedulerClockAction(timestamp: number, hook: string, args: unknown[] = []): RuntimeEpisodeActionSpec {
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error("Scheduler clock timestamp must be a positive Unix timestamp.")
  return wordpressAdversarialActionSpec({ surface: "cron", operation: "run-due", target: hook, input: { timestamp, args } })
}

export function wordpressHttpFaultConfigurationAction(model: TransportFaultModel): RuntimeEpisodeActionSpec {
  const negotiation = negotiateWordPressHttpTransportFaults(model)
  if (!negotiation.supported) {
    throw new Error(`WordPress HTTP fault schedule requires unsupported semantics: ${negotiation.unsupported.map(({ semantic }) => semantic).join(", ")}`)
  }
  const encodedModel = Buffer.from(JSON.stringify(model), "utf8").toString("base64")
  const encodedPlugin = Buffer.from(wordpressHttpFaultMuPluginPhp(), "utf8").toString("base64")
  return {
    kind: "command",
    command: "wordpress.run-php",
    args: [`code=wp_mkdir_p(WPMU_PLUGIN_DIR); file_put_contents(WPMU_PLUGIN_DIR . '/wp-codebox-adversarial-http.php', base64_decode('${encodedPlugin}')); update_option('wp_codebox_adversarial_http_faults', json_decode(base64_decode('${encodedModel}'), true), false);`],
    operation: "adversarial:http-transport-faults",
    metadata: { adapter: WORDPRESS_ADVERSARIAL_ADAPTER_SCHEMA, transportFaultNegotiation: negotiation, networkDefault: "deny" },
  }
}

export function evaluateWordPressAdversarialOracles(
  _plan: AdversarialCasePlan,
  observation: AdversarialExecutionObservation,
  oracles: readonly AdversarialOracleContract[] = WORDPRESS_ADVERSARIAL_ORACLES,
): AdversarialOracleResult[] {
  const evidence = recordValue(observation.metadata?.wordpressAdversarial)
  const violations = Array.isArray(evidence?.violations) ? evidence.violations.flatMap((item) => typeof item === "string" ? [item] : []) : []
  return oracles.map((contract) => {
    const matching = violations.filter((violation) => violationOracleId(violation) === contract.id)
    return {
      oracleId: contract.id,
      failed: matching.length > 0,
      ...(matching.length > 0 ? { code: matching[0], message: `${contract.description ?? contract.id} Evidence: ${matching.join(", ")}.`, evidence: { violations: matching } } : {}),
    }
  })
}

export function wordpressNoveltySignals(value: unknown, maximum = 128): string[] {
  const evidence = recordValue(value)
  const signals: string[] = []
  for (const category of ["hooks", "routes", "queries", "filesystem", "cache", "locks"] as const) {
    const entries = Array.isArray(evidence?.[category]) ? evidence[category] : []
    for (const entry of entries.slice(0, 32)) signals.push(`${category}:${boundedFingerprint(entry)}`)
  }
  const metrics = recordValue(evidence?.metrics)
  for (const name of ["memoryBytes", "cpuMs", "durationMs"] as const) {
    const numeric = metrics?.[name]
    if (typeof numeric === "number" && Number.isFinite(numeric)) signals.push(`${name}:${metricBucket(numeric)}`)
  }
  return [...new Set(signals)].sort().slice(0, Math.max(1, Math.min(maximum, 512)))
}

function oracle(id: string, severity: AdversarialOracleContract["severity"], description: string): AdversarialOracleContract {
  return { schema: ADVERSARIAL_ORACLE_SCHEMA, id, severity, description }
}

function actionMetadata(action: WordPressAdversarialAction, capability: WordPressAdversarialCapability): Record<string, unknown> {
  return { ...action.metadata, adapter: WORDPRESS_ADVERSARIAL_ADAPTER_SCHEMA, surface: action.surface, fidelity: capability.fidelity, fidelityReason: capability.reason }
}

function wordpressAdversarialHarnessPhp(action: WordPressAdversarialAction): string {
  const payload = Buffer.from(JSON.stringify(action), "utf8").toString("base64")
  return `$request = json_decode(base64_decode('${payload}'), true);
$started = microtime(true); $cpu_started = function_exists('getrusage') ? getrusage() : array(); $memory_started = memory_get_usage(true);
$result = array('schema' => 'wp-codebox/wordpress-adversarial-observation/v1', 'surface' => $request['surface'], 'operation' => $request['operation'], 'status' => 'ok', 'violations' => array());
$input = $request['input'] ?? null; $target = isset($request['target']) ? (string) $request['target'] : '';
try {
 switch ($request['surface']) {
  case 'rest':
   $method = strtoupper((string) ($request['operation'] ?: 'GET')); $rest = new WP_REST_Request($method, $target);
   if (is_array($input)) { $rest->set_body_params($input); }
   $response = rest_do_request($rest); $result['response'] = array('status' => $response->get_status(), 'data' => $response->get_data()); break;
  case 'block':
   $blocks = parse_blocks((string) $input); $result['response'] = array('parsed' => count($blocks), 'serialized' => serialize_blocks($blocks), 'rendered' => do_blocks((string) $input)); break;
  case 'shortcode': $result['response'] = do_shortcode((string) $input); break;
  case 'serialized-value': $serialized = maybe_serialize($input); $result['response'] = array('serialized' => $serialized, 'roundTrip' => maybe_unserialize($serialized)); break;
  case 'option':
   if ($request['operation'] === 'delete') { $result['response'] = delete_option($target); }
   elseif ($request['operation'] === 'read') { $result['response'] = get_option($target, null); }
   else { $result['response'] = update_option($target, $input, false); } break;
  case 'meta':
   $object_id = (int) ($request['actor']['userId'] ?? 0); if ($object_id <= 0) { throw new RuntimeException('meta actions require actor.userId as the object id'); }
   if ($request['operation'] === 'delete') { $result['response'] = delete_post_meta($object_id, $target); }
   elseif ($request['operation'] === 'read') { $result['response'] = get_post_meta($object_id, $target, true); }
   else { $result['response'] = update_post_meta($object_id, $target, $input); } break;
  case 'file':
   $uploads = wp_upload_dir(); $root = trailingslashit($uploads['basedir']) . 'wp-codebox-adversarial'; wp_mkdir_p($root);
   $candidate = wp_normalize_path($root . '/' . ltrim($target, '/')); $root_normalized = trailingslashit(wp_normalize_path($root));
   if (strpos($candidate, $root_normalized) !== 0 || strpos($candidate, '..') !== false) { $result['status'] = 'denied'; $result['violations'][] = 'filesystem-escape-attempt'; break; }
   wp_mkdir_p(dirname($candidate)); $result['response'] = array('bytes' => file_put_contents($candidate, is_string($input) ? $input : wp_json_encode($input)), 'relativePath' => substr($candidate, strlen($root_normalized))); break;
  case 'cron':
   $clock = is_array($input) ? (int) ($input['timestamp'] ?? time()) : time(); $args = is_array($input['args'] ?? null) ? $input['args'] : array();
   if ($request['operation'] === 'schedule') { $result['response'] = wp_schedule_single_event($clock, $target, $args, true); }
   else { $executed = 0; foreach ((array) _get_cron_array() as $timestamp => $hooks) { if ((int) $timestamp > $clock || empty($hooks[$target])) { continue; } foreach ($hooks[$target] as $event) { $event_args = (array) ($event['args'] ?? array()); do_action_ref_array($target, $event_args); wp_unschedule_event((int) $timestamp, $target, $event_args); $executed++; } } $result['response'] = array('hook' => $target, 'clock' => $clock, 'executed' => $executed); } break;
  case 'role-capability':
   $role = get_role((string) ($request['actor']['role'] ?? '')); if (!$role) { throw new RuntimeException('role not found'); }
   if ($request['operation'] === 'remove') { $role->remove_cap($target); } else { $role->add_cap($target, $input !== false); } $result['response'] = $role->has_cap($target); break;
  case 'multisite-membership':
   if (!is_multisite()) { $result['status'] = 'unsupported'; $result['reason'] = 'runtime-is-not-multisite'; break; }
   $user_id = (int) ($request['actor']['userId'] ?? 0); $blog_id = (int) ($request['actor']['blogId'] ?? 0);
   $result['response'] = $request['operation'] === 'remove' ? remove_user_from_blog($user_id, $blog_id) : add_user_to_blog($blog_id, $user_id, (string) ($request['actor']['role'] ?? 'subscriber')); break;
  default: $result['status'] = 'unsupported'; $result['reason'] = 'surface-not-executable-in-process';
 }
} catch (Throwable $error) { $result['status'] = 'error'; $result['error'] = array('class' => get_class($error), 'message' => $error->getMessage()); }
$queries = array(); global $wpdb; foreach (array_slice((array) ($wpdb->queries ?? array()), -32) as $query) { $queries[] = preg_replace('/\\s+/', ' ', (string) ($query[0] ?? '')); }
$cpu_finished = function_exists('getrusage') ? getrusage() : array();
$result['novelty'] = array('hooks' => array_slice(array_keys($GLOBALS['wp_filter'] ?? array()), 0, 64), 'routes' => array_slice(array_keys(rest_get_server()->get_routes()), 0, 64), 'queries' => $queries, 'filesystem' => array(), 'cache' => array(), 'locks' => array(), 'metrics' => array('memoryBytes' => max(0, memory_get_usage(true) - $memory_started), 'cpuMs' => max(0, (($cpu_finished['ru_utime.tv_usec'] ?? 0) - ($cpu_started['ru_utime.tv_usec'] ?? 0)) / 1000), 'durationMs' => round((microtime(true) - $started) * 1000, 3)));
echo wp_json_encode($result, JSON_UNESCAPED_SLASHES);`
}

function violationOracleId(violation: string): string | undefined {
  if (/authorization|nonce|tenant|membership/i.test(violation)) return "wordpress-authorization"
  if (/injection|execution|xss|sql/i.test(violation)) return "wordpress-injection"
  if (/partial-state|transaction|state-corruption/i.test(violation)) return "wordpress-transactional-consistency"
  if (/duplicate|race|lost-update/i.test(violation)) return "wordpress-duplicate-effect"
  if (/fail-open|service-failure/i.test(violation)) return "wordpress-fail-open"
  if (/filesystem|path-escape/i.test(violation)) return "wordpress-filesystem-escape"
  if (/secret|credential|token-leak/i.test(violation)) return "wordpress-secret-leakage"
  return undefined
}

function wordpressHttpFaultMuPluginPhp(): string {
  return `<?php
add_filter('pre_http_request', static function ($preempt, $args, $url) {
    $model = get_option('wp_codebox_adversarial_http_faults');
    if (!is_array($model) || empty($model['rules'])) return $preempt;
    $parsed = wp_parse_url((string) $url); $method = strtoupper((string) ($args['method'] ?? 'GET'));
    foreach ($model['rules'] as $rule) {
        $match = (array) ($rule['match'] ?? array());
        if (!empty($match['host']) && strtolower((string) ($parsed['host'] ?? '')) !== strtolower((string) $match['host'])) continue;
        if (!empty($match['method']) && $method !== strtoupper((string) $match['method'])) continue;
        if (!empty($match['path']) && (string) ($parsed['path'] ?? '/') !== (string) $match['path']) continue;
        $counts = (array) get_option('wp_codebox_adversarial_http_fault_counts', array()); $invocation = (int) ($counts[$rule['id']] ?? 0); $counts[$rule['id']] = $invocation + 1; update_option('wp_codebox_adversarial_http_fault_counts', $counts, false);
        $sequence = (array) ($rule['sequence'] ?? array()); $index = $invocation;
        if ($index >= count($sequence) && ($rule['repeat'] ?? 'last') === 'cycle') $index = $index % count($sequence);
        elseif ($index >= count($sequence) && ($rule['repeat'] ?? 'last') === 'last') $index = count($sequence) - 1;
        elseif ($index >= count($sequence)) return $preempt;
        $outcome = (array) ($sequence[$index] ?? array());
        if (isset($outcome['delayMs'])) usleep(min(1000000, max(0, (int) $outcome['delayMs']) * 1000));
        if (isset($outcome['timeoutMs'])) return new WP_Error('http_request_failed', 'Operation timed out (emulated at WordPress HTTP API boundary).');
        if (!empty($outcome['connection'])) return new WP_Error('http_request_failed', 'Connection failure emulated at WordPress HTTP API boundary.');
        $body = isset($outcome['body']) ? (string) $outcome['body'] : '';
        if (isset($outcome['truncateAfterBytes'])) $body = substr($body, 0, max(0, (int) $outcome['truncateAfterBytes']));
        if (!empty($outcome['malformed'])) return array('body' => $body);
        return array('headers' => (array) ($outcome['headers'] ?? array()), 'body' => $body, 'response' => array('code' => (int) ($outcome['status'] ?? 200), 'message' => 'Adversarial response'), 'cookies' => array(), 'filename' => null);
    }
    return $preempt;
}, 10, 3);`
}

function boundedFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)?.slice(0, 4096) ?? "undefined").digest("hex").slice(0, 16)
}

function metricBucket(value: number): string {
  if (value <= 0) return "0"
  return String(2 ** Math.floor(Math.log2(value)))
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
