<?php

$task = isset( $sandbox_task ) ? (string) $sandbox_task : 'No task supplied.';

update_option(
	'wp_codebox_headless_agent_task_state',
	array(
		'status'  => 'completed',
		'message' => 'Generic sandbox agent task completed.',
		'task'    => $task,
	)
);

echo wp_json_encode(
	array(
		'schema' => 'wp-codebox/headless-browser-agent-task-demo/v1',
		'status' => 'completed',
		'task'   => $task,
	),
	JSON_PRETTY_PRINT
);
