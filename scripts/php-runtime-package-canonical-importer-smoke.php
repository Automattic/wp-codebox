<?php
declare(strict_types=1);

define( 'ABSPATH', __DIR__ );
function is_wp_error( mixed $value ): bool { return $value instanceof WP_Error; }
function get_current_user_id(): int { return 1; }
final class WP_Error {
	public function __construct( private string $code, private string $message, private array $data = array() ) {}
	public function get_error_code(): string { return $this->code; }
	public function get_error_message(): string { return $this->message; }
	public function get_error_data(): array { return $this->data; }
}

require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-runtime-package-executor.php';

$filter_called = false;
function apply_filters( string $hook, mixed $value, mixed ...$args ): mixed {
	global $filter_called;
	$filter_called = true;
	return array( 'success' => true );
}

$source = realpath( __DIR__ . '/../tests/fixtures/wpsg-runtime-package/.agent.json' );
$executor = new WP_Codebox_Runtime_Package_Executor();
$run = new ReflectionMethod( $executor, 'import_package_bundle' );
$result = $run->invoke( $executor, array( 'package' => array( 'slug' => 'example', 'source' => $source ) ) );
assert( is_wp_error( $result ) );
assert( 'wp_codebox_runtime_package_importer_unavailable' === $result->get_error_code() );
assert( false === $filter_called );
fwrite( STDOUT, "PHP runtime package canonical importer smoke passed\n" );
