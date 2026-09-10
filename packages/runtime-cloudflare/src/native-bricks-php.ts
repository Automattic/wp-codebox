/** Executes vendor native save/ownership APIs inside an already isolated PHP runtime. */
export const NATIVE_BRICKS_APPLY_PHP = String.raw`<?php
require '/wordpress/wp-load.php';
$admins = get_users(['role' => 'administrator', 'number' => 1]);
if (!$admins) throw new Exception('Prepared native allocation has no administrator.');
// The operator-created administrator owns the native authoring context.
$admins[0]->add_cap(Bricks\Capabilities::FULL_ACCESS);
wp_set_current_user($admins[0]->ID);
if (!class_exists('Bricks\\Abilities\\Elements') || !class_exists('Bricks\\Abilities\\Design')) throw new Exception('Prepared allocation does not contain Bricks native abilities.');
function native_result($value) {
    if (is_wp_error($value)) throw new Exception($value->get_error_code() . ': ' . $value->get_error_message());
    return $value;
}
function native_design($method, $input) {
    return native_result(call_user_func(['Bricks\\Abilities\\Design', $method], $input));
}
function native_id($namespace, $logical) {
    static $seen = [];
    $id = preg_match('/^[a-z0-9]{6}$/', $logical) ? $logical : substr(hash('sha256', $namespace . ':' . $logical), 0, 6);
    if (isset($seen[$namespace][$id]) && $seen[$namespace][$id] !== $logical) throw new Exception('Native ID normalization collision.');
    $seen[$namespace][$id] = $logical;
    return $id;
}
function native_elements($elements, $media) {
    foreach ($elements as &$element) {
        $element['id'] = native_id('element', $element['id']);
        if (isset($element['settings']['_cssGlobalClasses'])) $element['settings']['_cssGlobalClasses'] = array_map(fn($id) => native_id('class', $id), $element['settings']['_cssGlobalClasses']);
        if ($element['name'] === 'image') {
            $ref = $element['settings']['image']['asset_ref'] ?? null;
            if (!$ref || !isset($media[$ref])) throw new Exception('Native image asset reference is unavailable.');
            $element['settings']['image'] = ['id' => $media[$ref]['id'], 'url' => wp_get_attachment_url($media[$ref]['id']), 'size' => $element['settings']['image']['size'] ?? 'full'];
        }
        $element['children'] = native_elements($element['children'] ?? [], $media);
    }
    unset($element);
    return $elements;
}
function native_snapshot($map) {
    $hashes = []; $pages = []; $templates = []; $media = [];
    foreach ($map['documents'] as $logical => $record) {
        $read = native_result(Bricks\Abilities\Elements::get_page_elements(['postId' => $record['id'], 'responseFormat' => 'summary']));
        if (empty($read['documentDigest'])) throw new Exception('Native document digest is unavailable.');
        $hashes[] = $read['documentDigest'];
        if ($record['kind'] === 'page') $pages[] = $record['id']; else $templates[] = $record['id'];
    }
    foreach ($map['media'] as $record) $media[] = $record['id'];
    $design = [];
    foreach ([BRICKS_DB_GLOBAL_CLASSES, BRICKS_DB_GLOBAL_VARIABLES, BRICKS_DB_THEME_STYLES, BRICKS_DB_COLOR_PALETTE] as $option) $design[$option] = get_option($option, []);
    $hashes[] = hash('sha256', wp_json_encode($design));
    return ['native_records' => ['page_ids' => $pages, 'template_ids' => $templates, 'media_ids' => $media], 'native_document_hashes' => $hashes, 'design_system_version' => $map['design_system_version'], 'peak_php_bytes' => memory_get_peak_usage(true)];
}
$input = json_decode(file_get_contents('/tmp/native-bricks-input.json'), true, 512, JSON_THROW_ON_ERROR);
$map = get_option('wp_codebox_native_bricks_map', ['documents' => [], 'media' => [], 'design_system_version' => 'uninitialized']);
if ($input['action'] === 'restore-read') {
    echo json_encode(native_snapshot($map), JSON_THROW_ON_ERROR);
    return;
}
$artifact = $input['artifact'];
require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/media.php';
require_once ABSPATH . 'wp-admin/includes/image.php';
$next_media = [];
foreach ($artifact['assets'] as $asset) {
    $logical = $asset['logical_id'];
    if (isset($map['media'][$logical]) && $map['media'][$logical]['sha256'] === $asset['sha256']) {
        $next_media[$logical] = $map['media'][$logical];
        update_post_meta($next_media[$logical]['id'], '_wp_attachment_image_alt', $asset['alt_text']);
        continue;
    }
    $bytes = base64_decode($asset['content_base64'], true);
    if ($bytes === false || strlen($bytes) !== $asset['bytes'] || hash('sha256', $bytes) !== $asset['sha256']) throw new Exception('Native media integrity mismatch.');
    $upload = wp_upload_bits($asset['filename'], null, $bytes);
    if (!empty($upload['error'])) throw new Exception('Native media upload failed.');
    $attachment = native_result(wp_insert_attachment(['post_mime_type' => $asset['mime_type'], 'post_title' => pathinfo($asset['filename'], PATHINFO_FILENAME), 'post_status' => 'inherit'], $upload['file'], 0, true));
    $metadata = wp_generate_attachment_metadata($attachment, $upload['file']);
    if (!$metadata) throw new Exception('Native media metadata generation failed.');
    wp_update_attachment_metadata($attachment, $metadata);
    update_post_meta($attachment, '_wp_attachment_image_alt', $asset['alt_text']);
    $next_media[$logical] = ['id' => $attachment, 'sha256' => $asset['sha256']];
}
// A complete artifact replaces the managed design store using vendor ownership APIs.
$snapshot = native_design('list_global_classes', ['limit' => 500]);
foreach ($snapshot['items'] as $class) {
    $fresh = native_design('list_global_classes', ['limit' => 500]);
    foreach ($fresh['items'] as $item) if ($item['id'] === $class['id']) native_design('delete_global_class', ['classId' => $item['id'], 'expectedOwnership' => $item['itemOwnership'], 'lockOwnership' => $fresh['lockOwnership'], 'allowOrphans' => true]);
}
$classes = [];
foreach ($artifact['design_system']['global_classes'] as $class) $classes[] = ['id' => native_id('class', $class['id']), 'name' => sanitize_title($class['name']), 'settings' => $class['settings']];
if ($classes) { $fresh = native_design('list_global_classes', ['limit' => 500]); native_design('batch_create_global_classes', ['classes' => $classes, 'expectedOwnership' => $fresh['ownership']]); }
$variables = native_design('list_global_variables', ['limit' => 500]);
foreach ($variables['items'] as $variable) {
    $fresh = native_design('list_global_variables', ['limit' => 500]);
    foreach ($fresh['items'] as $item) if ($item['id'] === $variable['id']) native_design('delete_global_variable', ['variableId' => $item['id'], 'expectedOwnership' => $item['itemOwnership'], 'allowOrphans' => true]);
}
$variables = [];
foreach ($artifact['design_system']['global_variables'] as $variable) $variables[] = ['id' => native_id('variable', $variable['id']), 'name' => sanitize_title($variable['name']), 'value' => $variable['value']];
if ($variables) { $fresh = native_design('list_global_variables', ['limit' => 500]); native_design('set_global_variables', ['variables' => $variables, 'expectedVariableOwnership' => $fresh['variableOwnership'], 'expectedCategoryOwnership' => $fresh['categoryOwnership']]); }
$palettes = native_design('list_color_palettes', ['limit' => 500]);
// Keep a temporary empty palette while replacing the complete managed palette.
// Bricks requires one effective palette and rejects duplicate named variables.
$temporary = native_design('create_color_palette', ['name' => 'Native transaction ' . wp_generate_uuid4(), 'colors' => [], 'expectedOwnership' => $palettes['ownership']]);
foreach ($palettes['items'] as $palette) {
    $fresh = native_design('list_color_palettes', ['limit' => 500]);
    foreach ($fresh['items'] as $item) if ($item['id'] === $palette['id']) native_design('delete_color_palette', ['paletteId' => $item['id'], 'expectedOwnership' => $item['itemOwnership'], 'allowOrphans' => true]);
}
$colors = [];
foreach ($artifact['design_system']['palette'] as $color) $colors[] = ['id' => native_id('color', $color['id']), 'name' => $color['name'], 'raw' => 'var(--native-' . sanitize_title($color['id']) . ')', 'light' => $color['value']];
$fresh = native_design('list_color_palettes', ['limit' => 500]);
native_design('create_color_palette', ['name' => 'Managed native palette', 'colors' => $colors, 'expectedOwnership' => $fresh['ownership']]);
$fresh = native_design('list_color_palettes', ['limit' => 500]);
foreach ($fresh['items'] as $item) if ($item['id'] === $temporary['palette']['id']) native_design('delete_color_palette', ['paletteId' => $item['id'], 'expectedOwnership' => $item['itemOwnership'], 'allowOrphans' => true]);
$styles = native_design('list_theme_styles', ['limit' => 500]);
foreach ($styles['items'] as $style) {
    $fresh = native_design('list_theme_styles', ['limit' => 500]);
    foreach ($fresh['items'] as $item) if ($item['id'] === $style['id']) native_design('delete_theme_style', ['id' => $item['id'], 'expectedOwnership' => $item['itemOwnership'], 'acknowledgeStyleRemoval' => true]);
}
$theme_settings = $artifact['design_system']['theme_style']['settings'];
$typography = $artifact['design_system']['typography'];
$theme_settings['typography']['typographyHtml'] = $typography['root_font_size'];
$theme_settings['typography']['typographyBody']['font-family'] = $typography['body_font_family'];
$theme_settings['typography']['typographyHeadings']['font-family'] = $typography['heading_font_family'];
native_design('create_theme_style', ['label' => 'Managed native style', 'conditions' => [['main' => 'any']], 'settings' => $theme_settings]);
$next_documents = [];
foreach (['pages' => 'page', 'templates' => 'template'] as $collection => $kind) {
    foreach ($artifact['documents'][$collection] as $document) {
        $logical = $document['logical_id'];
        $existing = $map['documents'][$logical] ?? null;
        $elements = native_elements($document['elements'], $next_media);
        if ($existing && $existing['kind'] !== $kind) throw new Exception('Native logical document kind changed.');
        if ($existing && $kind === 'template' && ($existing['type'] ?? $document['type']) !== $document['type']) throw new Exception('Changing template type requires a new logical document ID.');
        if ($kind === 'page') {
            $post = ['post_type' => 'page', 'post_title' => $document['title'], 'post_name' => $document['slug'], 'post_status' => $document['status']];
            if ($existing) $post['ID'] = $existing['id'];
            $post_id = native_result(wp_insert_post($post, true));
        } elseif (!$existing) {
            $created = native_result(Bricks\Abilities\Templates::create_template(['title' => $document['title'], 'type' => $document['type'] === 'single' ? 'content' : $document['type'], 'status' => $document['status'], 'elements' => $elements, 'settings' => ['templateConditions' => $document['conditions']]]));
            $post_id = $created['templateId'];
        } else {
            $post_id = native_result(wp_update_post(['ID' => $existing['id'], 'post_title' => $document['title'], 'post_status' => $document['status']], true));
        }
        native_result(Bricks\Abilities\Elements::set_page_elements(['postId' => $post_id, 'elements' => $elements]));
        if ($kind === 'template') native_result(Bricks\Abilities\Templates::set_template_conditions(['templateId' => $post_id, 'conditions' => $document['conditions']]));
        $next_documents[$logical] = ['id' => $post_id, 'kind' => $kind, 'type' => $document['type'] ?? 'page'];
    }
}
foreach ($map['documents'] as $logical => $record) if (!isset($next_documents[$logical])) wp_delete_post($record['id'], true);
foreach ($map['media'] as $logical => $record) if (!isset($next_media[$logical]) || $next_media[$logical]['id'] !== $record['id']) wp_delete_attachment($record['id'], true);
$first_page = $artifact['documents']['pages'][0]['logical_id'];
update_option('show_on_front', 'page');
update_option('page_on_front', $next_documents[$first_page]['id']);
update_option('blogname', $artifact['site']['title']);
$map = ['documents' => $next_documents, 'media' => $next_media, 'design_system_version' => $artifact['design_system']['version']];
update_option('wp_codebox_native_bricks_map', $map);
echo json_encode(native_snapshot($map), JSON_THROW_ON_ERROR);
`;
