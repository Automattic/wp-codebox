<?php
define( 'ABSPATH', __DIR__ );

require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-redaction-policy.php';

$fixture = json_decode( file_get_contents( __DIR__ . '/fixtures/redaction-policy-profiles.json' ), true );
if ( ! is_array( $fixture ) || ! is_array( $fixture['profiles'] ?? null ) ) {
	fwrite( STDERR, "Invalid redaction policy fixture.\n" );
	exit( 1 );
}

foreach ( $fixture['profiles'] as $profile => $cases ) {
	foreach ( $cases['redact'] as $key ) {
		if ( ! WP_Codebox_Redaction_Policy::key_should_redact( $profile, $key ) ) {
			fwrite( STDERR, "Expected {$profile} to redact {$key}.\n" );
			exit( 1 );
		}
	}

	foreach ( $cases['preserve'] as $key ) {
		if ( WP_Codebox_Redaction_Policy::key_should_redact( $profile, $key ) ) {
			fwrite( STDERR, "Expected {$profile} to preserve {$key}.\n" );
			exit( 1 );
		}
	}
}

$redacted = WP_Codebox_Redaction_Policy::redact_array(
	'provider_proxy',
	array(
		'provider' => 'generic',
		'request'  => array(
			'authorization' => 'Bearer abc',
			'model'         => 'example',
		),
	)
);

if ( '[redacted]' !== ( $redacted['request']['authorization'] ?? null ) || 'example' !== ( $redacted['request']['model'] ?? null ) ) {
	fwrite( STDERR, "Provider proxy recursive redaction failed.\n" );
	exit( 1 );
}
