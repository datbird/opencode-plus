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
    name: "opcp_synced_sessions",
    type: "base",
    fields: [
      { name: "session_id", type: "text", required: true, presentable: true },
      { name: "project_id", type: "text", required: true },
      { name: "space_id", type: "text", required: true },
      { name: "title", type: "text" },
      { name: "payload_path", type: "text", required: true },
      { name: "created_by_deployment", type: "text" },
      { name: "updated_by_deployment", type: "text" },
      { name: "status", type: "select", values: ["available", "locked", "conflict", "archived"] },
      { name: "metadata", type: "json" },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_opcp_synced_sessions_session ON opcp_synced_sessions (session_id)",
      "CREATE INDEX idx_opcp_synced_sessions_project ON opcp_synced_sessions (project_id)",
    ],
  })
}, (app) => {
  try { app.delete(app.findCollectionByNameOrId("opcp_synced_sessions")) } catch {}
})
