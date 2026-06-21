export const WORDPRESS_RUNTIME_DISCOVERY_SCHEMA = "wp-codebox/wordpress-runtime-discovery/v1" as const

export type WordPressRuntimeDiscoverySurface = "rest" | "admin" | "database" | "frontend" | "blocks"

export interface WordPressRuntimeDiscoveryResult {
  schema: typeof WORDPRESS_RUNTIME_DISCOVERY_SCHEMA
  command: "wordpress.runtime-discovery"
  status: "ok"
  surfaces: WordPressRuntimeDiscoverySurface[]
  rest?: WordPressRestRouteDiscovery
  admin?: WordPressAdminPageDiscovery
  database?: WordPressDatabaseSchemaDiscovery
  frontend?: WordPressFrontendRouteDiscovery
  blocks?: WordPressBlockEditorTargetDiscovery
  diagnostics: WordPressRuntimeDiscoveryDiagnostic[]
}

export interface WordPressRuntimeDiscoveryDiagnostic {
  surface: WordPressRuntimeDiscoverySurface
  code: string
  message: string
  data?: unknown
}

export interface WordPressRestRouteDiscovery {
  schema: "wp-codebox/wordpress-rest-route-discovery/v1"
  routes: WordPressRestRouteDescriptor[]
  namespaces: string[]
}

export interface WordPressRestRouteDescriptor {
  route: string
  namespace: string
  methods: string[]
  argNames: string[]
}

export interface WordPressAdminPageDiscovery {
  schema: "wp-codebox/wordpress-admin-page-discovery/v1"
  adminUrl: string
  menuLoaded: boolean
  pages: WordPressAdminPageDescriptor[]
}

export interface WordPressAdminPageDescriptor {
  menuSlug: string
  pageTitle: string
  menuTitle: string
  capability: string
  parentSlug?: string
}

export interface WordPressDatabaseSchemaDiscovery {
  schema: "wp-codebox/wordpress-db-schema-discovery/v1"
  prefix: string
  tables: WordPressDatabaseTableDescriptor[]
}

export interface WordPressDatabaseTableDescriptor {
  name: string
  baseName: string
  columns: WordPressDatabaseColumnDescriptor[]
}

export interface WordPressDatabaseColumnDescriptor {
  name: string
  type: string
  nullable: boolean
  key: string
  default: string | null
  extra: string
}

export interface WordPressFrontendRouteDiscovery {
  schema: "wp-codebox/wordpress-frontend-route-discovery/v1"
  homeUrl: string
  permalinkStructure: string
  rewriteRules: WordPressRewriteRuleDescriptor[]
  publicQueryVars: string[]
}

export interface WordPressRewriteRuleDescriptor {
  pattern: string
  query: string
}

export interface WordPressBlockEditorTargetDiscovery {
  schema: "wp-codebox/wordpress-block-editor-target-discovery/v1"
  blocks: WordPressBlockTypeDescriptor[]
  editorPostTypes: WordPressEditorPostTypeDescriptor[]
}

export interface WordPressBlockTypeDescriptor {
  name: string
  title: string
  category: string
  supportsInserter: boolean
  attributes: string[]
}

export interface WordPressEditorPostTypeDescriptor {
  name: string
  label: string
  restBase: string
  editorUrl: string
}
