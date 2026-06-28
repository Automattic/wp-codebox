<?php
/**
 * Smoke test: the agentic runtime provisions its runtime substrate into the
 * browser sandbox by default (issue #1591).
 *
 * Proves that with the codebox-agent-runtime profile selected and NO
 * consumer-supplied component sources, the browser runtime dependency payload
 * resolves the default substrate (agents-api + the selected provider plugin)
 * from the host's installed plugin directory, and that an unresolvable required
 * component is surfaced rather than silently dropped.
 */

declare(strict_types=1);

define( 'ABSPATH', __DIR__ );

final class WP_Error {
	/** @param array<string,mixed> $data */
	public function __construct( private string $code = '', private string $message = '', private array $data = array() ) {}
	public function get_error_code(): string { return $this->code; }
	public function get_error_message(): string { return $this->message; }
	/** @return array<string,mixed> */
	public function get_error_data(): array { return $this->data; }
}

function is_wp_error( mixed $value ): bool {
	return $value instanceof WP_Error;
}

/** @return array{basedir:string,baseurl:string} */
function wp_upload_dir(): array {
	return array(
		'basedir' => $GLOBALS['wp_codebox_substrate_uploads'],
		'baseurl' => 'https://example.test/wp-content/uploads',
	);
}

/** @return array<string,mixed>|false */
function wp_parse_url( string $url ): array|false {
	return parse_url( $url );
}

function apply_filters( string $hook_name, mixed $value, mixed ...$args ): mixed {
	unset( $args );
	return $value;
}

function do_action( string $hook_name, mixed ...$args ): void {
	if ( 'wp_codebox_browser_runtime_component_unresolved' === $hook_name ) {
		$GLOBALS['wp_codebox_substrate_unresolved'][] = (string) ( $args[0] ?? '' );
	}
}

function sanitize_key( string $key ): string {
	return strtolower( preg_replace( '/[^a-zA-Z0-9_-]/', '', $key ) ?? '' );
}

function sanitize_text_field( string $value ): string {
	return trim( preg_replace( '/[\r\n\t ]+/', ' ', $value ) ?? '' );
}

require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-path-policy.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/trait-wp-codebox-abilities-browser-runtime.php';

final class WP_Codebox_Browser_Runtime_Agent_Substrate_Smoke {
	use WP_Codebox_Abilities_Browser_Runtime;

	/** @param array<string,mixed> $input @param array<int,array<string,mixed>> $browser_plugins @return array<string,mixed>|WP_Error */
	public static function dependencies( array $input, array $browser_plugins = array() ): array|WP_Error {
		return ( new ReflectionMethod( self::class, 'browser_runtime_dependencies' ) )->invoke( null, $input, $browser_plugins, null );
	}

	/** @param array<string,mixed> $input @param array<int,mixed> $declared_components @return array<int,array<string,mixed>>|WP_Error */
	public static function component_plugins( array $input, array $declared_components ): array|WP_Error {
		return ( new ReflectionMethod( self::class, 'browser_component_plugins' ) )->invoke( null, $input, array(), $declared_components );
	}

	/** @return array<int,string> */
	private static function string_list( mixed $value ): array {
		if ( ! is_array( $value ) ) {
			return array();
		}

		return array_values( array_filter( array_map( 'strval', $value ), static fn( string $item ): bool => '' !== trim( $item ) ) );
	}

	/** @param array<string,mixed> $input @return array<int,string> Provider plugin paths (lives in the inheritance trait in production). */
	private static function browser_provider_plugin_paths( array $input ): array {
		return array_values( array_filter( is_array( $input['provider_plugin_paths'] ?? null ) ? $input['provider_plugin_paths'] : array(), static fn( $path ): bool => is_string( $path ) && is_dir( $path ) ) );
	}
}

function fail( string $message ): void {
	fwrite( STDERR, $message . PHP_EOL );
	exit( 1 );
}

function remove_tree( string $path ): void {
	if ( ! is_dir( $path ) ) {
		return;
	}
	$iterator = new RecursiveIteratorIterator(
		new RecursiveDirectoryIterator( $path, FilesystemIterator::SKIP_DOTS ),
		RecursiveIteratorIterator::CHILD_FIRST
	);
	foreach ( $iterator as $item ) {
		if ( $item instanceof SplFileInfo && $item->isDir() ) {
			rmdir( $item->getPathname() );
		} elseif ( $item instanceof SplFileInfo ) {
			unlink( $item->getPathname() );
		}
	}
	rmdir( $path );
}

/** @param array<int,array<string,mixed>> $plugins @return array<int,array<string,mixed>> */
function plugin_by_slug( array $plugins, string $slug ): array {
	foreach ( $plugins as $plugin ) {
		if ( $slug === ( $plugin['slug'] ?? '' ) ) {
			return $plugin;
		}
	}
	return array();
}

$root = sys_get_temp_dir() . '/wp-codebox-agent-substrate-smoke';
remove_tree( $root );
$GLOBALS['wp_codebox_substrate_uploads']    = $root . '/uploads';
$GLOBALS['wp_codebox_substrate_unresolved'] = array();

// -- Phase 1 (BEFORE): no runtime substrate installed on the host. ----------------
// The agent-runtime profile declares agents-api as a component, but with no host
// install, contract, or registry source it cannot resolve. Pre-fix this was a
// silent drop ("plugins (0)"); now it is surfaced via the unresolved action.
mkdir( $GLOBALS['wp_codebox_substrate_uploads'], 0777, true );
define( 'WP_PLUGIN_DIR', $root . '/active-plugins' );

$before = WP_Codebox_Browser_Runtime_Agent_Substrate_Smoke::component_plugins(
	array(),
	array( array( 'slug' => 'agents-api' ) )
);
if ( is_wp_error( $before ) ) {
	fail( 'Expected component resolution without a source to return an empty list, got error ' . $before->get_error_code() );
}
if ( array() !== $before ) {
	fail( 'Expected no resolvable component plugins when the substrate is not installed.' );
}
if ( ! in_array( 'agents-api', $GLOBALS['wp_codebox_substrate_unresolved'], true ) ) {
	fail( 'Expected the unresolved required component "agents-api" to be surfaced via wp_codebox_browser_runtime_component_unresolved.' );
}

// -- Phase 2 (AFTER): substrate installed on the host. ----------------------------
// Install agents-api + the selected provider plugin into WP_PLUGIN_DIR. The
// browser runtime now resolves both from the host's installed copies with no
// consumer-supplied component sources.
mkdir( WP_PLUGIN_DIR . '/agents-api', 0777, true );
file_put_contents( WP_PLUGIN_DIR . '/agents-api/agents-api.php', "<?php\n/* Plugin Name: Agents API */\n" );
mkdir( WP_PLUGIN_DIR . '/ai-provider-for-openai', 0777, true );
file_put_contents( WP_PLUGIN_DIR . '/ai-provider-for-openai/ai-provider-for-openai.php', "<?php\n/* Plugin Name: AI Provider for OpenAI */\n" );

// Shape mirrors WP_Codebox_Runtime_Profile_Resolver output for a selected
// codebox-agent-runtime + provider-openai profile: agents-api as a declared
// runtime component, the provider plugin as a slug-only runtime plugin.
$input = array(
	'runtime' => array(
		'components' => array( array( 'slug' => 'agents-api' ) ),
		'plugins'    => array( array( 'slug' => 'ai-provider-for-openai', 'activate' => true ) ),
	),
);

$after = WP_Codebox_Browser_Runtime_Agent_Substrate_Smoke::dependencies( $input );
if ( is_wp_error( $after ) ) {
	fail( 'Expected runtime dependencies to resolve, got error ' . $after->get_error_code() . ': ' . $after->get_error_message() );
}

$plugins = is_array( $after['plugins'] ?? null ) ? $after['plugins'] : array();

$agents_api = plugin_by_slug( $plugins, 'agents-api' );
if ( empty( $agents_api ) ) {
	fail( 'Expected the default substrate to provision agents-api from the host install.' );
}
if ( true !== ( $agents_api['local_package'] ?? false ) || ! str_starts_with( (string) ( $agents_api['url'] ?? '' ), 'data:application/zip;base64,' ) ) {
	fail( 'Expected agents-api to be packaged from the host install as a local data: package.' );
}
if ( 'host-installed-plugin' !== ( $agents_api['provenance']['source'] ?? '' ) ) {
	fail( 'Expected agents-api provenance to record host-installed-plugin resolution.' );
}

$provider = plugin_by_slug( $plugins, 'ai-provider-for-openai' );
if ( empty( $provider ) ) {
	fail( 'Expected the selected provider plugin to provision from the host install.' );
}
if ( true !== ( $provider['local_package'] ?? false ) || ! str_starts_with( (string) ( $provider['url'] ?? '' ), 'data:application/zip;base64,' ) ) {
	fail( 'Expected ai-provider-for-openai to be packaged from the host install as a local data: package.' );
}

if ( ! in_array( 'agents-api', is_array( $after['components'] ?? null ) ? $after['components'] : array(), true ) ) {
	fail( 'Expected agents-api to appear in the resolved component slug list.' );
}
if ( (int) ( $after['summary']['plugins'] ?? 0 ) < 2 ) {
	fail( 'Expected at least the agents-api + provider substrate in the dependency summary.' );
}

remove_tree( $root );
fwrite( STDOUT, "PHP browser runtime agent substrate smoke passed\n" );
fwrite( STDOUT, "  before: agents-api unresolved (surfaced), plugins (0)\n" );
fwrite( STDOUT, sprintf( "  after:  plugins (%d) -> agents-api + ai-provider-for-openai from host installs\n", count( $plugins ) ) );
