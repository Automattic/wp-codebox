<?php

declare(strict_types=1);

define( 'ABSPATH', __DIR__ );

require_once dirname( __DIR__ ) . '/packages/wordpress-plugin/src/class-wp-codebox-json.php';
require_once dirname( __DIR__ ) . '/packages/wordpress-plugin/src/class-wp-codebox-path-policy.php';
require_once dirname( __DIR__ ) . '/packages/wordpress-plugin/src/class-wp-codebox-agent-outcome-classifier.php';

function smoke_assert( bool $condition, string $message ): void {
	if ( ! $condition ) {
		fwrite( STDERR, $message . PHP_EOL );
		exit( 1 );
	}
}

$classifier = new WP_Codebox_Agent_Outcome_Classifier();

smoke_assert(
	! $classifier->strict_remediation_outcome( array( 'expected_artifacts' => array( 'remediation-artifact', 'fix-pr' ) ) ),
	'expected artifact semantics do not opt into strict remediation outcome'
);
smoke_assert(
	$classifier->strict_remediation_outcome( array( 'policy' => array( 'outcome_contract' => 'remediation-outcome' ) ) ),
	'explicit outcome contract opts into strict remediation outcome'
);

$artifact_root = sys_get_temp_dir() . '/wp-codebox-agent-outcome-' . getmypid();
$files_dir     = $artifact_root . DIRECTORY_SEPARATOR . 'files';
mkdir( $files_dir, 0777, true );
file_put_contents(
	$files_dir . DIRECTORY_SEPARATOR . 'changed-files.json',
	json_encode(
		array(
			'files' => array(
				array(
					'path'         => '/workspace/plugin.php',
					'relativePath' => 'plugin.php',
					'status'       => 'modified',
				),
			),
		),
		JSON_UNESCAPED_SLASHES
	)
);

$artifact_outcome = $classifier->remediation_outcome(
	array(
		'artifacts' => array( 'directory' => $artifact_root ),
		'agentResult' => array(
			'pr_url' => 'https://github.com/Automattic/wp-codebox/pull/1234',
		),
	),
	0,
	''
);
smoke_assert( true === $artifact_outcome['success'], 'changed-file artifact outcome remains successful' );
smoke_assert( 'completed' === $artifact_outcome['kind'], 'changed-file artifact does not define fix outcome kind' );
smoke_assert( isset( $artifact_outcome['artifact']['changed_files'][0] ), 'changed-file artifact details are retained' );
smoke_assert( ! isset( $artifact_outcome['pr_url'] ), 'GitHub PR URLs are not promoted into outcome fields' );

$provider_text_outcome = $classifier->remediation_outcome(
	array( 'agentResult' => array( 'summary' => 'OpenAI and Anthropic provider notes only.' ) ),
	0,
	'openai anthropic provider text'
);
smoke_assert( true === $provider_text_outcome['success'], 'provider names in text do not fail outcome' );
smoke_assert( 'completed' === $provider_text_outcome['kind'], 'provider names in text do not define provider_error kind' );

$structured_provider_outcome = $classifier->remediation_outcome(
	array(
		'run_outcome' => array(
			'schema'         => 'agents-api.run-outcome',
			'status'         => 'failed',
			'provider_error' => array( 'message' => 'rate limited' ),
			'retryable'      => true,
		),
	),
	1,
	''
);
smoke_assert( false === $structured_provider_outcome['success'], 'structured provider error fails outcome' );
smoke_assert( 'provider_error' === $structured_provider_outcome['kind'], 'structured provider error is preserved' );

@unlink( $files_dir . DIRECTORY_SEPARATOR . 'changed-files.json' );
@rmdir( $files_dir );
@rmdir( $artifact_root );

echo "agent outcome classifier smoke passed\n";
