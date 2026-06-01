export type WorkspaceRecipeJsonSchema = Record<string, unknown>

export interface WorkspaceRecipeJsonSchemaOptions {
  recipeCommandIds?: readonly string[]
}

export function createWorkspaceRecipeJsonSchema(options: WorkspaceRecipeJsonSchemaOptions = {}): WorkspaceRecipeJsonSchema {
  const commandSchema = options.recipeCommandIds && options.recipeCommandIds.length > 0
    ? { enum: [...options.recipeCommandIds] }
    : { type: "string" }

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "wp-codebox/workspace-recipe/v1",
    title: "WP Codebox workspace recipe",
    type: "object",
    additionalProperties: false,
    required: ["schema", "workflow"],
    properties: {
      schema: { const: "wp-codebox/workspace-recipe/v1" },
      runtime: {
        type: "object",
        additionalProperties: false,
        properties: {
          backend: { const: "wordpress-playground" },
          name: { type: "string" },
          wp: { type: "string" },
          blueprint: { type: "object" },
          stack: { $ref: "#/$defs/runtimeStack" },
        },
      },
      inputs: {
        type: "object",
        additionalProperties: false,
        properties: {
          mounts: {
            type: "array",
            items: { $ref: "#/$defs/mount" },
          },
          workspaces: {
            type: "array",
            items: { $ref: "#/$defs/workspace" },
          },
          extra_plugins: {
            type: "array",
            items: { $ref: "#/$defs/extraPlugin" },
          },
          extraPlugins: {
            type: "array",
            items: { $ref: "#/$defs/extraPlugin" },
          },
          secretEnv: {
            type: "array",
            items: { type: "string", pattern: "^[A-Z_][A-Z0-9_]*$" },
          },
          pluginRuntime: { $ref: "#/$defs/pluginRuntime" },
          siteSeeds: {
            type: "array",
            description: "Explicit site/content seed declarations. Local JSON fixture seeds are imported into the sandbox before workflow steps. Parent-site declarations remain bounded, auditable metadata until export support lands.",
            items: { $ref: "#/$defs/siteSeed" },
          },
          stagedFiles: {
            type: "array",
            description: "Local recipe-owned files or directories copied into absolute sandbox paths before workflow steps execute.",
            items: { $ref: "#/$defs/stagedFile" },
          },
          inherit: { $ref: "#/$defs/inheritanceRequest" },
          inheritance: { $ref: "#/$defs/inheritanceResolution" },
        },
      },
      workflow: {
        type: "object",
        additionalProperties: false,
        required: ["steps"],
        properties: {
          before: {
            type: "array",
            items: { $ref: "#/$defs/step" },
          },
          steps: {
            type: "array",
            minItems: 1,
            items: { $ref: "#/$defs/step" },
          },
          after: {
            type: "array",
            items: { $ref: "#/$defs/step" },
          },
        },
      },
      artifacts: {
        type: "object",
        additionalProperties: false,
        properties: {
          directory: { type: "string" },
          verify: { $ref: "#/$defs/artifactVerifier" },
          workspacePolicy: { $ref: "#/$defs/workspacePolicyArtifact" },
        },
      },
    },
    $defs: {
      artifactVerifier: {
        oneOf: [
          { type: "boolean" },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              enabled: { type: "boolean" },
              strict: { type: "boolean" },
            },
          },
        ],
      },
      workspacePolicyArtifact: {
        oneOf: [
          { type: "boolean" },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              enabled: { type: "boolean" },
              strict: { type: "boolean" },
              writableRoots: { type: "array", items: { type: "string" } },
              hiddenPaths: { type: "array", items: { type: "string" } },
              gitBacked: { type: "boolean" },
            },
          },
        ],
      },
      metadata: {
        type: "object",
        additionalProperties: true,
      },
      mount: {
        type: "object",
        additionalProperties: false,
        required: ["source", "target"],
        properties: {
          type: { enum: ["directory", "file"] },
          source: { type: "string" },
          target: { type: "string", pattern: "^/" },
          mode: { enum: ["readonly", "readwrite"] },
          metadata: { $ref: "#/$defs/metadata" },
        },
      },
      runtimeStack: {
        type: "object",
        additionalProperties: false,
        description: "Explicit runtime stack overlays mounted before recipe workspaces, plugins, and workflow steps. Use this to test alternate WordPress core or bundled dependency refs without consumer-specific shims.",
        properties: {
          mounts: {
            type: "array",
            items: { $ref: "#/$defs/mount" },
          },
        },
      },
      workspace: {
        type: "object",
        additionalProperties: false,
        required: ["seed"],
        properties: {
          target: { type: "string", pattern: "^/" },
          mode: { enum: ["readonly", "readwrite"] },
          sourceMode: { enum: ["repo-backed", "site-backed"] },
          seed: { $ref: "#/$defs/workspaceSeed" },
        },
      },
      workspaceSeed: {
        type: "object",
        additionalProperties: false,
        required: ["type"],
        properties: {
          type: { enum: ["plugin_scaffold", "theme_scaffold", "directory"] },
          slug: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" },
          name: { type: "string" },
          source: { type: "string" },
          excludePaths: { type: "array", items: { type: "string" } },
        },
      },
      extraPlugin: {
        type: "object",
        additionalProperties: false,
        required: ["source"],
        properties: {
          source: {
            type: "string",
            description: "Local plugin directory path, WordPress.org plugin zip URL, or generic HTTPS zip URL.",
          },
          slug: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" },
          pluginFile: { type: "string" },
          activate: { type: "boolean" },
          sha256: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
        },
      },
      pluginRuntime: {
        type: "object",
        additionalProperties: false,
        description: "Generic runtime options for heavyweight plugin stacks. Consumers can tune PHP/WP config, run ordered setup hooks, and declare health probes without consumer-specific semantics.",
        properties: {
          label: { type: "string" },
          php: {
            type: "object",
            additionalProperties: false,
            properties: {
              memoryLimit: { type: "string", pattern: "^[0-9]+[KMG]?$" },
              maxExecutionTime: { type: "integer", minimum: 0, maximum: 3600 },
            },
          },
          wpConfigDefines: {
            type: "object",
            additionalProperties: {
              type: ["string", "number", "boolean", "null"],
            },
          },
          setup: {
            type: "array",
            items: { $ref: "#/$defs/step" },
          },
          healthProbes: {
            type: "array",
            items: { $ref: "#/$defs/pluginRuntimeHealthProbe" },
          },
        },
      },
      pluginRuntimeHealthProbe: {
        type: "object",
        additionalProperties: false,
        required: ["name", "type"],
        properties: {
          name: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*$" },
          type: { enum: ["plugin-active", "php", "wp-cli"] },
          pluginFile: { type: "string" },
          code: { type: "string" },
          command: { type: "string" },
        },
      },
      siteSeed: {
        type: "object",
        additionalProperties: false,
        required: ["type", "name", "scopes"],
        properties: {
          type: { enum: ["fixture", "parent_site"] },
          name: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*$" },
          source: { type: "string", description: "Fixture file path. Not allowed for parent_site dry-run declarations." },
          format: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*$" },
          scopes: {
            type: "object",
            additionalProperties: false,
            properties: {
              posts: { $ref: "#/$defs/siteSeedScope" },
              terms: { $ref: "#/$defs/siteSeedScope" },
              options: { $ref: "#/$defs/siteSeedScope" },
              users: { $ref: "#/$defs/siteSeedScope" },
              media: { $ref: "#/$defs/siteSeedScope" },
              activePlugins: { type: "boolean" },
              activeTheme: { type: "boolean" },
            },
          },
        },
      },
      siteSeedScope: {
        type: "object",
        additionalProperties: false,
        properties: {
          ids: { type: "array", items: { type: "integer", minimum: 1 }, maxItems: 100 },
          slugs: { type: "array", items: { type: "string" }, maxItems: 100 },
          names: { type: "array", items: { type: "string" }, maxItems: 100 },
          postTypes: { type: "array", items: { type: "string" }, maxItems: 25 },
          taxonomies: { type: "array", items: { type: "string" }, maxItems: 25 },
          roles: { type: "array", items: { type: "string" }, maxItems: 25 },
          statuses: { type: "array", items: { type: "string" }, maxItems: 25 },
          includeFiles: { type: "boolean" },
          anonymize: { type: "boolean" },
          maxRecords: { type: "integer", minimum: 1, maximum: 100 },
        },
      },
      stagedFile: {
        type: "object",
        additionalProperties: false,
        required: ["source", "target"],
        properties: {
          source: { type: "string" },
          target: { type: "string", pattern: "^/" },
        },
      },
      step: {
        type: "object",
        additionalProperties: false,
        required: ["command"],
        properties: {
          command: commandSchema,
          args: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
      inheritanceRequest: {
        type: "object",
        additionalProperties: false,
        properties: {
          connectors: { type: "array", items: { type: "string" } },
          settings: { type: "array", items: { type: "string" } },
        },
      },
      inheritanceResolution: {
        type: "object",
        additionalProperties: false,
        properties: {
          connectors: { type: "array", items: { $ref: "#/$defs/inheritanceConnector" } },
          settings: { type: "array", items: { $ref: "#/$defs/inheritanceSetting" } },
        },
      },
      inheritanceConnector: {
        type: "object",
        additionalProperties: false,
        required: ["name", "status"],
        properties: {
          name: { type: "string" },
          status: { type: "string" },
          provider: { type: "string" },
          model: { type: "string" },
          providerPluginPaths: { type: "array", items: { type: "string" } },
          secretEnv: { type: "array", items: { type: "string", pattern: "^[A-Z_][A-Z0-9_]*$" } },
          credentials: { $ref: "#/$defs/connectorCredentialEnvelope" },
        },
      },
      connectorCredentialEnvelope: {
        type: "object",
        additionalProperties: false,
        required: ["schema", "connector", "scope", "status", "secrets"],
        properties: {
          schema: { const: "wp-codebox/connector-credentials/v1" },
          connector: { type: "string" },
          scope: { const: "connector" },
          status: { enum: ["available", "missing", "denied"] },
          reason: { type: "string" },
          secrets: { type: "array", items: { $ref: "#/$defs/connectorCredentialSecret" } },
        },
      },
      connectorCredentialSecret: {
        type: "object",
        additionalProperties: false,
        required: ["name", "status"],
        properties: {
          name: { type: "string", pattern: "^[A-Z_][A-Z0-9_]*$" },
          status: { enum: ["available", "missing", "denied"] },
          scope: { type: "string" },
          source: { type: "string" },
          reason: { type: "string" },
        },
      },
      inheritanceSetting: {
        type: "object",
        additionalProperties: false,
        required: ["name", "status"],
        properties: {
          name: { type: "string" },
          status: { type: "string" },
          scope: { type: "string" },
        },
      },
    },
  }
}
