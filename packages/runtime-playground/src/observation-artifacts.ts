import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { ObservationSpec, RuntimeCreateSpec, RuntimeEpisodeTraceRef } from "@chubes4/wp-codebox-core"
import { bootstrapPhpCode } from "./php-bootstrap.js"
import { assertPlaygroundResponseOk } from "./playground-command-errors.js"
import type { PlaygroundCliServer } from "./preview-server.js"

export async function observeWordPressState({
  artifactRoot,
  observationId,
  server,
  spec,
  runtimeSpec,
}: {
  artifactRoot: string
  observationId: string
  server: PlaygroundCliServer
  spec: ObservationSpec
  runtimeSpec: RuntimeCreateSpec
}): Promise<{ data: unknown; artifactRefs: RuntimeEpisodeTraceRef[] }> {
  const config = {
    sections: spec.sections,
    redaction: spec.redaction ?? "safe",
    includeContent: spec.includeContent === true,
    optionNames: spec.optionNames,
    userFields: spec.userFields,
  }
  const response = await server.playground.run({ code: bootstrapPhpCode(runtimeSpec, wordpressStateExportPhp(config), []) })
  assertPlaygroundResponseOk("observe.wordpress-state", response)
  const stateExport = JSON.parse(response.text || "{}") as {
    schema?: string
    version?: number
    generatedAt?: string
    config?: Record<string, unknown>
    sections?: Record<string, unknown>
  }
  const sectionArtifacts: Record<string, { artifact: string; sha256: string; bytes: number }> = {}
  const artifactRefs: RuntimeEpisodeTraceRef[] = []
  const sections = stateExport.sections ?? {}

  for (const [section, contents] of Object.entries(sections)) {
    const serialized = `${JSON.stringify({ schema: "wp-codebox/wordpress-state-section/v1", section, data: contents }, null, 2)}\n`
    const digest = createHash("sha256").update(serialized).digest("hex")
    const relativePath = `files/observations/${observationId}-wordpress-state-${safeArtifactSegment(section)}.json`
    await mkdir(dirname(join(artifactRoot, relativePath)), { recursive: true })
    await writeFile(join(artifactRoot, relativePath), serialized)
    sectionArtifacts[section] = { artifact: relativePath, sha256: digest, bytes: Buffer.byteLength(serialized) }
    artifactRefs.push({
      kind: "wordpress-state-section",
      id: `${observationId}:${section}`,
      path: relativePath,
      digest: { algorithm: "sha256", value: digest },
    })
  }

  return {
    data: {
      schema: stateExport.schema ?? "wp-codebox/wordpress-state-export/v1",
      version: stateExport.version ?? 1,
      generatedAt: stateExport.generatedAt,
      config: stateExport.config,
      sections: Object.fromEntries(Object.entries(sections).map(([section, contents]) => [section, summarizeWordPressStateSection(section, contents)])),
      artifacts: sectionArtifacts,
    },
    artifactRefs,
  }
}

export async function observeHttpResponse({
  artifactRoot,
  observationId,
  spec,
  url,
}: {
  artifactRoot: string
  observationId: string
  spec: ObservationSpec
  url: string
}): Promise<{ data: unknown; artifactRefs: RuntimeEpisodeTraceRef[] }> {
  const response = await fetch(url, {
    method: spec.method ?? "GET",
    headers: spec.headers,
    body: spec.body,
  })
  const body = await response.text()
  const bodyDigest = createHash("sha256").update(body).digest("hex")
  const artifactRefs: RuntimeEpisodeTraceRef[] = []
  const data: Record<string, unknown> = {
    url,
    method: spec.method ?? "GET",
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    bodySha256: bodyDigest,
    bodyBytes: Buffer.byteLength(body),
  }

  if (spec.includeBody === true && body.length <= 4096) {
    data.body = body
  } else if (body.length > 0) {
    const relativePath = `files/observations/${observationId}-body.txt`
    await mkdir(dirname(join(artifactRoot, relativePath)), { recursive: true })
    await writeFile(join(artifactRoot, relativePath), body)
    artifactRefs.push({
      kind: "observation-artifact",
      id: `${observationId}:body`,
      path: relativePath,
      digest: { algorithm: "sha256", value: bodyDigest },
    })
  }

  return { data, artifactRefs }
}

function wordpressStateExportPhp(config: Record<string, unknown>): string {
  return `
$config = json_decode( ${JSON.stringify(JSON.stringify(config))}, true );
$requested_sections = isset( $config['sections'] ) && is_array( $config['sections'] ) ? array_values( array_unique( array_map( 'strval', $config['sections'] ) ) ) : array( 'summary' );
$redaction = isset( $config['redaction'] ) ? (string) $config['redaction'] : 'safe';
$include_content = ! empty( $config['includeContent'] );
$option_names = isset( $config['optionNames'] ) && is_array( $config['optionNames'] ) ? array_values( array_unique( array_map( 'strval', $config['optionNames'] ) ) ) : array();
$user_fields = isset( $config['userFields'] ) && is_array( $config['userFields'] ) ? array_values( array_unique( array_map( 'strval', $config['userFields'] ) ) ) : array();
$allowed_sections = array( 'summary', 'posts', 'terms', 'menus', 'templates', 'media', 'options', 'users', 'rest-routes', 'abilities' );
$sections = array_values( array_intersect( $requested_sections, $allowed_sections ) );
if ( empty( $sections ) ) {
    $sections = array( 'summary' );
}

$hash_value = function ( $value ) {
    return hash( 'sha256', wp_json_encode( $value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ) );
};

$post_counts = array();
foreach ( get_post_types( array(), 'names' ) as $post_type ) {
    $counts = wp_count_posts( $post_type );
    $post_counts[ $post_type ] = array();
    foreach ( get_object_vars( $counts ) as $status => $count ) {
        $post_counts[ $post_type ][ $status ] = (int) $count;
    }
}

$exports = array();
$exports['summary'] = array(
    'siteUrl'           => get_site_url(),
    'homeUrl'           => get_home_url(),
    'wordpressVersion'  => get_bloginfo( 'version' ),
    'activeTheme'       => wp_get_theme()->get_stylesheet(),
    'activePlugins'     => array_values( (array) get_option( 'active_plugins', array() ) ),
    'postCounts'        => $post_counts,
);

if ( in_array( 'posts', $sections, true ) ) {
    $post_types = get_post_types( array( 'public' => true ), 'names' );
    $posts = get_posts( array(
        'post_type'      => array_values( $post_types ),
        'post_status'    => 'any',
        'posts_per_page' => 200,
        'orderby'        => 'ID',
        'order'          => 'ASC',
    ) );
    $exports['posts'] = array_map( function ( $post ) use ( $include_content, $hash_value ) {
        $entry = array(
            'id'          => (int) $post->ID,
            'type'        => $post->post_type,
            'slug'        => $post->post_name,
            'status'      => $post->post_status,
            'title'       => get_the_title( $post ),
            'contentHash' => $hash_value( (string) $post->post_content ),
            'modifiedGmt' => $post->post_modified_gmt,
        );
        if ( $include_content ) {
            $entry['content'] = (string) $post->post_content;
        }
        return $entry;
    }, $posts );
}

if ( in_array( 'terms', $sections, true ) ) {
    $terms = get_terms( array( 'hide_empty' => false ) );
    $exports['terms'] = is_wp_error( $terms ) ? array() : array_map( function ( $term ) {
        return array(
            'id'       => (int) $term->term_id,
            'taxonomy' => $term->taxonomy,
            'slug'     => $term->slug,
            'name'     => $term->name,
            'parent'   => (int) $term->parent,
            'count'    => (int) $term->count,
        );
    }, $terms );
}

if ( in_array( 'menus', $sections, true ) ) {
    $menus = wp_get_nav_menus();
    $exports['menus'] = array_map( function ( $menu ) {
        $items = wp_get_nav_menu_items( $menu->term_id );
        return array(
            'id'    => (int) $menu->term_id,
            'slug'  => $menu->slug,
            'name'  => $menu->name,
            'items' => is_array( $items ) ? array_map( function ( $item ) {
                return array(
                    'id'       => (int) $item->ID,
                    'title'    => $item->title,
                    'url'      => $item->url,
                    'parentId' => (int) $item->menu_item_parent,
                    'object'   => $item->object,
                    'type'     => $item->type,
                );
            }, $items ) : array(),
        );
    }, $menus );
}

if ( in_array( 'templates', $sections, true ) ) {
    $exports['templates'] = array(
        'theme'         => wp_get_theme()->get_stylesheet(),
        'templates'     => function_exists( 'get_block_templates' ) ? array_map( function ( $template ) use ( $hash_value ) {
            return array(
                'id'          => $template->id ?? '',
                'slug'        => $template->slug ?? '',
                'theme'       => $template->theme ?? '',
                'type'        => $template->type ?? '',
                'source'      => $template->source ?? '',
                'contentHash' => $hash_value( (string) ( $template->content ?? '' ) ),
            );
        }, get_block_templates( array(), 'wp_template' ) ) : array(),
        'templateParts' => function_exists( 'get_block_templates' ) ? array_map( function ( $template ) use ( $hash_value ) {
            return array(
                'id'          => $template->id ?? '',
                'slug'        => $template->slug ?? '',
                'theme'       => $template->theme ?? '',
                'area'        => $template->area ?? '',
                'source'      => $template->source ?? '',
                'contentHash' => $hash_value( (string) ( $template->content ?? '' ) ),
            );
        }, get_block_templates( array(), 'wp_template_part' ) ) : array(),
        'globalStyles'  => function_exists( 'wp_get_global_stylesheet' ) ? array( 'stylesheetHash' => $hash_value( wp_get_global_stylesheet() ) ) : null,
    );
}

if ( in_array( 'media', $sections, true ) ) {
    $attachments = get_posts( array(
        'post_type'      => 'attachment',
        'post_status'    => 'any',
        'posts_per_page' => 200,
        'orderby'        => 'ID',
        'order'          => 'ASC',
    ) );
    $exports['media'] = array_map( function ( $attachment ) {
        return array(
            'id'       => (int) $attachment->ID,
            'slug'     => $attachment->post_name,
            'title'    => get_the_title( $attachment ),
            'mimeType' => $attachment->post_mime_type,
            'metadata' => wp_get_attachment_metadata( $attachment->ID ),
        );
    }, $attachments );
}

if ( in_array( 'options', $sections, true ) ) {
    $exports['options'] = array();
    foreach ( $option_names as $option_name ) {
        $exports['options'][ $option_name ] = get_option( $option_name, null );
    }
}

if ( in_array( 'users', $sections, true ) ) {
    $allowed_user_fields = array_intersect( $user_fields, array( 'ID', 'user_login', 'display_name', 'roles', 'caps' ) );
    $users = get_users( array( 'orderby' => 'ID', 'order' => 'ASC' ) );
    $exports['users'] = array_map( function ( $user ) use ( $allowed_user_fields, $redaction ) {
        $entry = array( 'id' => (int) $user->ID, 'redacted' => 'none' !== $redaction );
        foreach ( $allowed_user_fields as $field ) {
            if ( 'ID' === $field ) {
                $entry['ID'] = (int) $user->ID;
            } elseif ( 'roles' === $field ) {
                $entry['roles'] = array_values( (array) $user->roles );
            } elseif ( 'caps' === $field ) {
                $entry['caps'] = array_keys( array_filter( (array) $user->allcaps ) );
            } elseif ( 'none' === $redaction ) {
                $entry[ $field ] = (string) $user->{$field};
            }
        }
        return $entry;
    }, $users );
}

if ( in_array( 'rest-routes', $sections, true ) ) {
    $routes = rest_get_server()->get_routes();
    $exports['rest-routes'] = array_map( function ( $route, $handlers ) {
        return array(
            'route'   => $route,
            'methods' => array_values( array_unique( array_reduce( $handlers, function ( $methods, $handler ) {
                foreach ( (array) ( $handler['methods'] ?? array() ) as $method => $enabled ) {
                    if ( $enabled ) {
                        $methods[] = is_string( $method ) ? $method : (string) $enabled;
                    }
                }
                return $methods;
            }, array() ) ) ),
        );
    }, array_keys( $routes ), $routes );
}

if ( in_array( 'abilities', $sections, true ) ) {
    $abilities = array();
    if ( function_exists( 'wp_get_abilities' ) ) {
        $registered = wp_get_abilities();
        if ( is_array( $registered ) ) {
            foreach ( $registered as $name => $ability ) {
                $abilities[] = array(
                    'name'        => (string) $name,
                    'description' => is_array( $ability ) ? (string) ( $ability['description'] ?? '' ) : '',
                    'category'    => is_array( $ability ) ? (string) ( $ability['category'] ?? '' ) : '',
                );
            }
        }
    }
    $exports['abilities'] = $abilities;
}

echo wp_json_encode( array(
    'schema'    => 'wp-codebox/wordpress-state-export/v1',
    'version'   => 1,
    'generatedAt' => gmdate( 'c' ),
    'config'    => array(
        'sections'       => $sections,
        'redaction'      => $redaction,
        'includeContent' => $include_content,
        'optionNames'    => $option_names,
        'userFields'     => $user_fields,
    ),
    'sections'  => $exports,
), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
`
}

function safeArtifactSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "section"
}

function summarizeWordPressStateSection(section: string, contents: unknown): unknown {
  if (section === "summary") {
    return contents
  }

  if (Array.isArray(contents)) {
    return { count: contents.length }
  }

  if (contents && typeof contents === "object") {
    const entries = Object.entries(contents as Record<string, unknown>)
    return {
      count: entries.length,
      keys: entries.map(([key]) => key),
    }
  }

  return { count: contents == null ? 0 : 1 }
}
