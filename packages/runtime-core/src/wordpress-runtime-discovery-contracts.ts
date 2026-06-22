export const WORDPRESS_RUNTIME_DISCOVERY_SCHEMA = "wp-codebox/wordpress-runtime-discovery/v1" as const
export const WORDPRESS_REST_ROUTE_INVENTORY_SCHEMA = "wp-codebox/wordpress-rest-route-inventory/v1" as const
export const WORDPRESS_ADMIN_PAGE_INVENTORY_SCHEMA = "wp-codebox/wordpress-admin-page-inventory/v1" as const
export const WORDPRESS_FRONTEND_URL_INVENTORY_SCHEMA = "wp-codebox/wordpress-frontend-url-inventory/v1" as const

export type WordPressRuntimeInventoryCommand =
  | "wordpress.rest-route-inventory"
  | "wordpress.admin-page-inventory"
  | "wordpress.frontend-url-inventory"

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

export interface WordPressRestRouteInventory {
  schema: typeof WORDPRESS_REST_ROUTE_INVENTORY_SCHEMA
  command: "wordpress.rest-route-inventory"
  status: "ok" | "unsupported"
  routes: WordPressRestRouteDescriptor[]
  namespaces: string[]
  diagnostics: WordPressRuntimeDiscoveryDiagnostic[]
}

export interface WordPressRestRouteDescriptor {
  route: string
  namespace: string
  methods: string[]
  argNames: string[]
  endpoints?: WordPressRestRouteEndpointDescriptor[]
  schema?: WordPressRestRouteSchemaDescriptor
}

export interface WordPressRestRouteEndpointDescriptor {
  methods: string[]
  permission: WordPressRestRoutePermissionDescriptor
  args: WordPressRestRouteArgDescriptor[]
}

export interface WordPressRestRoutePermissionDescriptor {
  mode: "public" | "callback" | "none"
  callbackType?: string
}

export interface WordPressRestRouteArgDescriptor {
  name: string
  required: boolean
  type?: string | string[]
  format?: string
  enum?: Array<string | number | boolean | null>
  description?: string
  defaultPresent?: boolean
  validateCallback?: boolean
  sanitizeCallback?: boolean
}

export interface WordPressRestRouteSchemaDescriptor {
  title?: string
  type?: string | string[]
  properties?: string[]
}

export interface WordPressAdminPageDiscovery {
  schema: "wp-codebox/wordpress-admin-page-discovery/v1"
  adminUrl: string
  menuLoaded: boolean
  user?: WordPressAdminDiscoveryUserContext
  pages: WordPressAdminPageDescriptor[]
}

export interface WordPressAdminPageInventory {
  schema: typeof WORDPRESS_ADMIN_PAGE_INVENTORY_SCHEMA
  command: "wordpress.admin-page-inventory"
  status: "ok" | "unsupported"
  adminUrl: string
  menuLoaded: boolean
  user?: WordPressAdminDiscoveryUserContext
  pages: WordPressAdminPageDescriptor[]
  diagnostics: WordPressRuntimeDiscoveryDiagnostic[]
}

export interface WordPressAdminDiscoveryUserContext {
  isLoggedIn: boolean
  id: number
  roles: string[]
}

export interface WordPressAdminPageDescriptor {
  menuSlug: string
  pageTitle: string
  menuTitle: string
  capability: string
  canAccess?: boolean | null
  canonicalUrl?: string
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
  classification: "core" | "prefixed" | "external"
  columns: WordPressDatabaseColumnDescriptor[]
  indexes?: WordPressDatabaseIndexDescriptor[]
  status?: WordPressDatabaseTableStatus | null
}

export interface WordPressDatabaseColumnDescriptor {
  name: string
  type: string
  nullable: boolean
  key: string
  default: string | null
  extra: string
}

export interface WordPressDatabaseIndexDescriptor {
  name: string
  column: string
  unique: boolean
  sequence: number | null
}

export interface WordPressDatabaseTableStatus {
  engine: string
  rows: number | null
  collation: string
}

export interface WordPressFrontendRouteDiscovery {
  schema: "wp-codebox/wordpress-frontend-route-discovery/v1"
  homeUrl: string
  permalinkStructure: string
  rewriteRules: WordPressRewriteRuleDescriptor[]
  publicQueryVars: string[]
}

export interface WordPressFrontendUrlInventory {
  schema: typeof WORDPRESS_FRONTEND_URL_INVENTORY_SCHEMA
  command: "wordpress.frontend-url-inventory"
  status: "ok" | "unsupported"
  homeUrl: string
  permalinkStructure: string
  urls: WordPressFrontendUrlDescriptor[]
  rewriteRules: WordPressRewriteRuleDescriptor[]
  publicQueryVars: string[]
  diagnostics: WordPressRuntimeDiscoveryDiagnostic[]
}

export interface WordPressFrontendUrlDescriptor {
  url: string
  source: "home" | "rewrite-rule"
  pattern?: string
  query?: string
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
