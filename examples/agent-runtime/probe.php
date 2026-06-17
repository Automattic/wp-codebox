<?php
require_once ABSPATH . 'wp-admin/includes/plugin.php';
require_once dirname(__DIR__, 2) . '/packages/wordpress-plugin/src/class-wp-codebox-agent-runtime-invoker.php';

$plugins = array(
    'agents-api/agents-api.php',
    'data-machine/data-machine.php',
    'data-machine-code/data-machine-code.php',
);

$activation_results = array();

foreach ($plugins as $plugin) {
    $result = activate_plugin($plugin);
    $activation_results[$plugin] = array(
        'active' => is_plugin_active($plugin),
        'error' => is_wp_error($result) ? $result->get_error_message() : null,
    );
}

do_action('plugins_loaded');
do_action('init');
do_action('wp_abilities_api_categories_init');
do_action('wp_abilities_api_init');

echo json_encode(
    array(
        'command' => 'agent-runtime.probe',
        'wp_loaded' => function_exists('wp_insert_post'),
        'plugins' => $activation_results,
        'signals' => array(
            'agents_api_loaded' => defined('AGENTS_API_LOADED'),
            'agents_chat_ability_available' => (new WP_Codebox_Agent_Runtime_Invoker())->is_agents_api_ready(),
            'data_machine_version' => defined('DATAMACHINE_VERSION') ? DATAMACHINE_VERSION : null,
            'data_machine_permission_helper' => class_exists('DataMachine\\Abilities\\PermissionHelper'),
            'data_machine_code_version' => defined('DATAMACHINE_CODE_VERSION') ? DATAMACHINE_CODE_VERSION : null,
            'data_machine_code_workspace' => class_exists('DataMachineCode\\Workspace\\Workspace'),
        ),
    ),
    JSON_PRETTY_PRINT
);
