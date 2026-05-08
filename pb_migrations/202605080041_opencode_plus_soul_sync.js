function saveCollectionIfMissing(app, config) {
  try {
    app.findCollectionByNameOrId(config.name)
    return
  } catch {}
  app.save(new Collection(config))
}

migrate((app) => {
  const baseRules = {
    listRule: "",
    viewRule: "",
    createRule: "",
    updateRule: "",
    deleteRule: "",
  }

  saveCollectionIfMissing(app, {
    ...baseRules,
    name: "opcp_deployments",
    type: "base",
    fields: [
      { name: "deployment_id", type: "text", required: true, presentable: true },
      { name: "name", type: "text", required: true },
      { name: "url", type: "url" },
      { name: "enabled", type: "bool" },
      { name: "metadata", type: "json" },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_opcp_deployments_deployment_id ON opcp_deployments (deployment_id)"],
  })

  saveCollectionIfMissing(app, {
    ...baseRules,
    name: "opcp_souls",
    type: "base",
    fields: [
      { name: "name", type: "text", required: true, presentable: true },
      { name: "description", type: "text" },
      { name: "parent_id", type: "text" },
      { name: "content", type: "editor" },
      { name: "enabled", type: "bool" },
      { name: "sort_order", type: "number" },
      { name: "metadata", type: "json" },
    ],
  })

  saveCollectionIfMissing(app, {
    ...baseRules,
    name: "opcp_roles",
    type: "base",
    fields: [
      { name: "name", type: "text", required: true, presentable: true },
      { name: "description", type: "text" },
      { name: "soul_id", type: "text", required: true },
      { name: "enabled", type: "bool" },
    ],
  })

  saveCollectionIfMissing(app, {
    ...baseRules,
    name: "opcp_deployment_roles",
    type: "base",
    fields: [
      { name: "deployment_id", type: "text", required: true, presentable: true },
      { name: "role_id", type: "text", required: true },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_opcp_deployment_roles_deployment ON opcp_deployment_roles (deployment_id)"],
  })

  saveCollectionIfMissing(app, {
    ...baseRules,
    name: "opcp_assets",
    type: "base",
    fields: [
      { name: "kind", type: "select", required: true, values: ["skill", "command", "tool", "plugin"] },
      { name: "name", type: "text", required: true, presentable: true },
      { name: "description", type: "text" },
      { name: "content", type: "editor" },
      { name: "language", type: "select", values: ["markdown", "javascript", "typescript"] },
      { name: "enabled", type: "bool" },
      { name: "metadata", type: "json" },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_opcp_assets_kind_name ON opcp_assets (kind, name)"],
  })

  saveCollectionIfMissing(app, {
    ...baseRules,
    name: "opcp_deployment_asset_overrides",
    type: "base",
    fields: [
      { name: "deployment_id", type: "text", required: true, presentable: true },
      { name: "asset_id", type: "text", required: true },
      { name: "sync_enabled", type: "bool" },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_opcp_asset_override ON opcp_deployment_asset_overrides (deployment_id, asset_id)"],
  })

  saveCollectionIfMissing(app, {
    ...baseRules,
    name: "opcp_named_spaces",
    type: "base",
    fields: [
      { name: "name", type: "text", required: true, presentable: true },
      { name: "description", type: "text" },
      { name: "expected_kind", type: "text" },
      { name: "sync_mode", type: "select", values: ["external", "git", "local-only", "pocketbase-small"] },
      { name: "notes", type: "editor" },
      { name: "enabled", type: "bool" },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_opcp_named_spaces_name ON opcp_named_spaces (name)"],
  })

  saveCollectionIfMissing(app, {
    ...baseRules,
    name: "opcp_deployment_space_paths",
    type: "base",
    fields: [
      { name: "deployment_id", type: "text", required: true, presentable: true },
      { name: "space_id", type: "text", required: true },
      { name: "local_path", type: "text", required: true },
      { name: "enabled", type: "bool" },
      { name: "read_only", type: "bool" },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_opcp_space_path ON opcp_deployment_space_paths (deployment_id, space_id)"],
  })

  saveCollectionIfMissing(app, {
    ...baseRules,
    name: "opcp_synced_projects",
    type: "base",
    fields: [
      { name: "name", type: "text", required: true, presentable: true },
      { name: "description", type: "text" },
      { name: "space_id", type: "text", required: true },
      { name: "role_id", type: "text" },
      { name: "icon", type: "file", maxSelect: 1, maxSize: 1048576 },
      { name: "enabled", type: "bool" },
      { name: "metadata", type: "json" },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_opcp_synced_projects_name ON opcp_synced_projects (name)"],
  })

  saveCollectionIfMissing(app, {
    ...baseRules,
    name: "opcp_deployment_project_paths",
    type: "base",
    fields: [
      { name: "deployment_id", type: "text", required: true, presentable: true },
      { name: "project_id", type: "text", required: true },
      { name: "local_path", type: "text", required: true },
      { name: "enabled", type: "bool" },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_opcp_project_path ON opcp_deployment_project_paths (deployment_id, project_id)"],
  })

  saveCollectionIfMissing(app, {
    ...baseRules,
    name: "opcp_render_history",
    type: "base",
    fields: [
      { name: "deployment_id", type: "text", required: true, presentable: true },
      { name: "target", type: "text", required: true },
      { name: "status", type: "select", values: ["success", "failed", "skipped"] },
      { name: "message", type: "text" },
      { name: "content_hash", type: "text" },
      { name: "metadata", type: "json" },
    ],
  })
}, (app) => {
  const names = [
    "opcp_render_history",
    "opcp_deployment_project_paths",
    "opcp_synced_projects",
    "opcp_deployment_space_paths",
    "opcp_named_spaces",
    "opcp_deployment_asset_overrides",
    "opcp_assets",
    "opcp_deployment_roles",
    "opcp_roles",
    "opcp_souls",
    "opcp_deployments",
  ]
  for (const name of names) {
    try { app.delete(app.findCollectionByNameOrId(name)) } catch {}
  }
})
