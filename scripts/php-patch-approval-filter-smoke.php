<?php

define( 'ABSPATH', __DIR__ );

final class WP_Error {
	private string $code;
	private string $message;
	/** @var mixed */
	private mixed $data;

	/** @param mixed $data */
	public function __construct( string $code = '', string $message = '', mixed $data = null ) {
		$this->code    = $code;
		$this->message = $message;
		$this->data    = $data;
	}

	public function get_error_code(): string {
		return $this->code;
	}

	public function get_error_message(): string {
		return $this->message;
	}

	public function get_error_data(): mixed {
		return $this->data;
	}
}

function is_wp_error( mixed $value ): bool {
	return $value instanceof WP_Error;
}

require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-patch-approval-filter.php';

function assert_same_patch_filter( mixed $expected, mixed $actual, string $label ): void {
	if ( $expected !== $actual ) {
		fwrite( STDERR, $label . " failed.\nExpected: " . var_export( $expected, true ) . "\nActual: " . var_export( $actual, true ) . "\n" );
		exit( 1 );
	}
}

function assert_error_code_patch_filter( string $expected_code, mixed $actual, string $label ): void {
	if ( ! is_wp_error( $actual ) ) {
		fwrite( STDERR, $label . ' failed: expected WP_Error, got ' . var_export( $actual, true ) . PHP_EOL );
		exit( 1 );
	}

	assert_same_patch_filter( $expected_code, $actual->get_error_code(), $label . ' code' );
}

$patch = implode(
	'',
	array(
		"diff --git a/wp-content/plugins/demo/demo.php b/wp-content/plugins/demo/demo.php\n",
		"index 1111111..2222222 100644\n",
		"--- a/wp-content/plugins/demo/demo.php\n",
		"+++ b/wp-content/plugins/demo/demo.php\n",
		"@@ -1 +1 @@\n",
		"-old\n",
		"+new\n",
		"diff --git a/wp-content/plugins/demo/readme.txt b/wp-content/plugins/demo/readme.txt\n",
		"index 3333333..4444444 100644\n",
		"--- a/wp-content/plugins/demo/readme.txt\n",
		"+++ b/wp-content/plugins/demo/readme.txt\n",
		"@@ -1 +1 @@\n",
		"-readme\n",
		"+updated readme\n",
	)
);

$changed_files = array(
	array(
		'path'         => '/wordpress/wp-content/plugins/demo/demo.php',
		'relativePath' => 'wp-content/plugins/demo/demo.php',
	),
	array(
		'path'         => '/wordpress/wp-content/plugins/demo/readme.txt',
		'relativePath' => 'wp-content/plugins/demo/readme.txt',
	),
);

$filter = new WP_Codebox_Patch_Approval_Filter();

$filtered = $filter->filter_patch_to_approved_files(
	$patch,
	$changed_files,
	array( '/wordpress/wp-content/plugins/demo/demo.php' )
);

assert_same_patch_filter(
	implode(
		'',
		array(
			"diff --git a/wp-content/plugins/demo/demo.php b/wp-content/plugins/demo/demo.php\n",
			"index 1111111..2222222 100644\n",
			"--- a/wp-content/plugins/demo/demo.php\n",
			"+++ b/wp-content/plugins/demo/demo.php\n",
			"@@ -1 +1 @@\n",
			"-old\n",
			"+new\n",
		)
	),
	$filtered,
	'filters to only the approved file block'
);

$filtered = $filter->filter_patch_to_approved_files(
	$patch,
	$changed_files,
	array(
		'/wordpress/wp-content/plugins/demo/demo.php',
		'/wordpress/wp-content/plugins/demo/readme.txt',
	)
);
assert_same_patch_filter( $patch, $filtered, 'preserves all blocks when all changed files are approved' );

$renamed_patch = implode(
	'',
	array(
		"diff --git a/wp-content/plugins/demo/old.php b/wp-content/plugins/demo/new.php\n",
		"similarity index 88%\n",
		"rename from wp-content/plugins/demo/old.php\n",
		"rename to wp-content/plugins/demo/new.php\n",
		"--- a/wp-content/plugins/demo/old.php\n",
		"+++ b/wp-content/plugins/demo/new.php\n",
		"@@ -1 +1 @@\n",
		"-old\n",
		"+new\n",
	)
);

$filtered = $filter->filter_patch_to_approved_files(
	$renamed_patch,
	array(
		array(
			'path'         => '/wordpress/wp-content/plugins/demo/new.php',
			'relativePath' => 'wp-content/plugins/demo/new.php',
		),
	),
	array( '/wordpress/wp-content/plugins/demo/new.php' )
);
assert_same_patch_filter( $renamed_patch, $filtered, 'matches approved renamed destination path' );

$filtered = $filter->filter_patch_to_approved_files(
	"diff --git a/wp-content/plugins/demo/windows.php b/wp-content/plugins/demo/windows.php\n--- a/wp-content/plugins/demo/windows.php\t2026-06-17\n+++ b/wp-content/plugins/demo/windows.php\t2026-06-17\n@@ -1 +1 @@\n-old\n+new\n",
	array(
		array(
			'path'         => '/wordpress/wp-content/plugins/demo/windows.php',
			'relativePath' => 'wp-content\\plugins\\demo\\windows.php',
		),
	),
	array( '/wordpress/wp-content/plugins/demo/windows.php' )
);
assert_same_patch_filter( true, is_string( $filtered ), 'normalizes backslashes and metadata-suffixed patch paths' );

$missing = $filter->filter_patch_to_approved_files(
	$patch,
	$changed_files,
	array( '/wordpress/wp-content/plugins/demo/missing.php' )
);
assert_error_code_patch_filter( 'wp_codebox_approved_patch_paths_missing', $missing, 'rejects approved file without changed-file mapping' );

$missing_patch = $filter->filter_patch_to_approved_files(
	$patch,
	array(
		array(
			'path'         => '/wordpress/wp-content/plugins/demo/missing.php',
			'relativePath' => 'wp-content/plugins/demo/missing.php',
		),
	),
	array( '/wordpress/wp-content/plugins/demo/missing.php' )
);
assert_error_code_patch_filter( 'wp_codebox_approved_patch_missing', $missing_patch, 'rejects approved changed file missing from patch' );

$unfilterable = $filter->filter_patch_to_approved_files(
	"not a git patch\n",
	array(
		array(
			'path'         => '/wordpress/wp-content/plugins/demo/demo.php',
			'relativePath' => 'wp-content/plugins/demo/demo.php',
		),
	),
	array( '/wordpress/wp-content/plugins/demo/demo.php' )
);
assert_error_code_patch_filter( 'wp_codebox_patch_unfilterable', $unfilterable, 'rejects patches without git blocks' );

fwrite( STDOUT, "PHP patch approval filter smoke passed\n" );
