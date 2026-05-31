<?php
/**
 * Plugin Name: WP Codebox Headless Browser Agent Task Demo
 * Description: Generic fixture for the headless browser-agent recipe example.
 */

add_action( 'admin_menu', static function (): void {
	add_management_page(
		'WP Codebox Agent Task Demo',
		'WP Codebox Agent Task Demo',
		'manage_options',
		'wp-codebox-headless-agent-task',
		'wp_codebox_headless_agent_task_render_page'
	);
} );

function wp_codebox_headless_agent_task_render_page(): void {
	$state = get_option(
		'wp_codebox_headless_agent_task_state',
		array(
			'status'  => 'pending',
			'message' => 'Waiting for the sandbox agent task.',
			'task'    => '',
		)
	);

	$status  = is_array( $state ) && isset( $state['status'] ) ? (string) $state['status'] : 'pending';
	$message = is_array( $state ) && isset( $state['message'] ) ? (string) $state['message'] : '';
	$task    = is_array( $state ) && isset( $state['task'] ) ? (string) $state['task'] : '';

	?>
	<div class="wrap wp-codebox-headless-agent-task" data-status="<?php echo esc_attr( $status ); ?>">
		<h1>WP Codebox Headless Browser Agent Task</h1>
		<p class="wp-codebox-agent-status" data-status="<?php echo esc_attr( $status ); ?>"><?php echo esc_html( $message ); ?></p>
		<?php if ( '' !== $task ) : ?>
			<pre class="wp-codebox-agent-task"><?php echo esc_html( $task ); ?></pre>
		<?php endif; ?>
	</div>
	<?php
}
