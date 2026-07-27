import type { RuntimeCreateSpec, WorkspaceRecipeSiteSeedBootstrap } from "@automattic/wp-codebox-core"

export interface PlaygroundSiteSeedMultisiteTopology {
  install: "subdomain" | "subdirectory"
  primary: { domain: string; path: string; title: string }
  sites: Array<{ domain: string; path: string; title: string; primary: boolean }>
  routeHosts: string[]
}

export function playgroundSiteSeedMultisiteTopology(spec: RuntimeCreateSpec | undefined): PlaygroundSiteSeedMultisiteTopology | undefined {
  const bootstraps = recipeSiteSeedBootstraps(spec)
  if (bootstraps.length === 0) return undefined

  const fingerprints = new Set(bootstraps.map((bootstrap) => JSON.stringify(bootstrap)))
  if (fingerprints.size !== 1) {
    throw new Error("Playground mapped-domain multisite bootstrap requires all site seeds to declare the same topology.")
  }

  const bootstrap = bootstraps[0]!
  const sites = (bootstrap.multisite?.sites ?? []).map((site) => ({
    domain: normalizeHost(site.domain),
    path: normalizePath(site.path),
    title: site.title?.trim() || site.domain,
  }))
  if (sites.length === 0) {
    throw new Error("Playground mapped-domain multisite bootstrap requires at least one declared site.")
  }

  const primaryDeclarations = (bootstrap.domains ?? []).filter((domain) => domain.primary)
  if (primaryDeclarations.length > 1) {
    throw new Error("Playground mapped-domain multisite bootstrap supports exactly one primary domain.")
  }
  const requestedPrimary = primaryDeclarations[0]
    ? { domain: normalizeHost(primaryDeclarations[0].domain), path: normalizePath(primaryDeclarations[0].path) }
    : { domain: sites[0]!.domain, path: sites[0]!.path }
  const primaryIndex = sites.findIndex((site) => site.domain === requestedPrimary.domain && site.path === requestedPrimary.path)
  if (primaryIndex < 0) {
    throw new Error("Playground mapped-domain multisite primary domain must match a declared multisite site domain and path.")
  }

  const normalizedSites = sites.map((site, index) => ({ ...site, primary: index === primaryIndex }))
  return {
    install: bootstrap.multisite?.install ?? "subdirectory",
    primary: normalizedSites[primaryIndex]!,
    sites: normalizedSites,
    routeHosts: [...new Set(normalizedSites.map((site) => site.domain))].sort(),
  }
}

export function playgroundSiteSeedPrimaryUrl(spec: RuntimeCreateSpec | undefined): string | undefined {
  const primary = playgroundSiteSeedMultisiteTopology(spec)?.primary
  return primary ? `http://${primary.domain}${primary.path}` : undefined
}

export function playgroundSiteSeedMultisiteBlueprintSteps(spec: RuntimeCreateSpec): unknown[] {
  const topology = playgroundSiteSeedMultisiteTopology(spec)
  if (!topology) return []
  return [
    { step: "enableMultisite" },
    { step: "runPHP", code: playgroundSiteSeedMultisiteSetupPhp(topology) },
  ]
}

function recipeSiteSeedBootstraps(spec: RuntimeCreateSpec | undefined): WorkspaceRecipeSiteSeedBootstrap[] {
  const recipe = spec?.metadata?.recipe
  if (!isRecord(recipe)) return []
  const inputs = isRecord(recipe.inputs) ? recipe.inputs : undefined
  if (!inputs || !Array.isArray(inputs.siteSeeds)) return []
  return inputs.siteSeeds.flatMap((seed) => {
    if (!isRecord(seed) || !isRecord(seed.bootstrap) || !isRecord(seed.bootstrap.multisite) || seed.bootstrap.multisite.enabled !== true) return []
    return [seed.bootstrap as unknown as WorkspaceRecipeSiteSeedBootstrap]
  })
}

function normalizeHost(host: string): string {
  const normalized = host.trim().toLowerCase().replace(/\.$/, "")
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(normalized)) {
    throw new Error(`Playground mapped-domain multisite bootstrap domain must be a hostname without a scheme, path, wildcard, or port: ${host}`)
  }
  return normalized
}

function normalizePath(path: string | undefined): string {
  const value = path?.trim() || "/"
  if (!value.startsWith("/") || value.includes("//") || value.includes("?") || value.includes("#")) {
    throw new Error(`Playground mapped-domain multisite bootstrap path must be an absolute directory path: ${value}`)
  }
  return value.endsWith("/") ? value : `${value}/`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function playgroundSiteSeedMultisiteSetupPhp(topology: PlaygroundSiteSeedMultisiteTopology): string {
  const encoded = JSON.stringify(JSON.stringify(topology))
  return `<?php
require_once '/wordpress/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/upgrade.php';

$topology = json_decode(${encoded}, true);
if (!is_array($topology) || !is_multisite()) {
    throw new RuntimeException('Playground mapped-domain multisite bootstrap did not enable WordPress multisite.');
}

$config_path = ABSPATH . 'wp-config.php';
$config = file_get_contents($config_path);
if (!is_string($config)) {
    throw new RuntimeException('Playground mapped-domain multisite bootstrap could not read wp-config.php.');
}
$subdomain = 'subdomain' === $topology['install'] ? 'true' : 'false';
$config = preg_replace("/define\\(\\s*[\\x27\\x22]SUBDOMAIN_INSTALL[\\x27\\x22]\\s*,\\s*(?:true|false)\\s*\\);/i", "define( 'SUBDOMAIN_INSTALL', " . $subdomain . " );", $config);
$config_lines = preg_split('/\\R/', $config);
if (is_array($config_lines)) {
    $config = implode("\n", array_filter($config_lines, static fn(string $line): bool => !(str_contains($line, '$' . '_SERVER') && str_contains($line, 'HTTP_HOST'))));
}
$host_bootstrap = <<<'WP_CODEBOX_PHP'
/* WP_CODEBOX_DYNAMIC_MULTISITE_HOST */
$wp_codebox_mapped_hosts = __WP_CODEBOX_MAPPED_HOSTS__;
$wp_codebox_request_host = strtolower(preg_replace('/:[0-9]+$/', '', (string) ($_SERVER['HTTP_HOST'] ?? '')));
if (!in_array($wp_codebox_request_host, $wp_codebox_mapped_hosts, true)) {
    $_SERVER['HTTP_HOST'] = '__WP_CODEBOX_PRIMARY_DOMAIN__';
}
unset($wp_codebox_mapped_hosts, $wp_codebox_request_host);
WP_CODEBOX_PHP;
$host_bootstrap = str_replace('__WP_CODEBOX_PRIMARY_DOMAIN__', $topology['primary']['domain'], $host_bootstrap);
$host_bootstrap = str_replace('__WP_CODEBOX_MAPPED_HOSTS__', var_export(array_values(array_unique(array_column($topology['sites'], 'domain'))), true), $host_bootstrap);
$config = preg_replace('/^<\\?php\\s*/i', "<?php\n" . $host_bootstrap . "\n", $config, 1);
if (!is_string($config) || false === file_put_contents($config_path, $config)) {
    throw new RuntimeException('Playground mapped-domain multisite bootstrap could not persist dynamic host configuration.');
}

global $wpdb;
$network_id = get_current_network_id();
$main_site_id = get_main_site_id($network_id);
$primary = $topology['primary'];
$wpdb->update($wpdb->site, array('domain' => $primary['domain'], 'path' => $primary['path']), array('id' => $network_id), array('%s', '%s'), array('%d'));
$wpdb->update($wpdb->blogs, array('domain' => $primary['domain'], 'path' => $primary['path']), array('blog_id' => $main_site_id), array('%s', '%s'), array('%d'));
update_blog_option($main_site_id, 'home', 'http://' . $primary['domain'] . $primary['path']);
update_blog_option($main_site_id, 'siteurl', 'http://' . $primary['domain'] . $primary['path']);
update_blog_option($main_site_id, 'blogname', $primary['title']);

foreach ($topology['sites'] as $site) {
    if (!empty($site['primary'])) {
        continue;
    }
    $existing = get_sites(array('network_id' => $network_id, 'domain' => $site['domain'], 'path' => $site['path'], 'number' => 1));
    $site_id = $existing ? (int) $existing[0]->blog_id : wp_insert_site(array(
        'domain' => $site['domain'],
        'path' => $site['path'],
        'network_id' => $network_id,
        'title' => $site['title'],
    ));
    if (is_wp_error($site_id)) {
        throw new RuntimeException('Playground mapped-domain multisite site creation failed: ' . $site_id->get_error_message());
    }
    update_blog_option((int) $site_id, 'home', 'http://' . $site['domain'] . $site['path']);
    update_blog_option((int) $site_id, 'siteurl', 'http://' . $site['domain'] . $site['path']);
    update_blog_option((int) $site_id, 'blogname', $site['title']);
}

clean_network_cache($network_id);
foreach (get_sites(array('network_id' => $network_id, 'number' => 0)) as $site) {
    clean_blog_cache($site);
}
`
}
