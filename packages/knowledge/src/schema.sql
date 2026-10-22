-- Enterprise AI Workflow Copilot — durable schema.
--
-- Every business table carries tenant_id. Repositories below always bind it,
-- and no query is allowed to run without it (see tests/unit/tenancy.test.ts).
--
-- pgvector is OPTIONAL: `doc_chunks.embedding` is added at boot only when the
-- `vector` extension is available AND an embedding provider is configured.
-- Without it, retrieval degrades to keyword search and /api/capabilities says
-- so explicitly. No embeddings are ever fabricated.

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  permissions JSONB NOT NULL,
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  verification_base_url TEXT,
  kind TEXT NOT NULL DEFAULT 'browser',
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS app_pages (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  title TEXT,
  discovered_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS ui_elements (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  page_id TEXT REFERENCES app_pages(id) ON DELETE SET NULL,
  semantic_name TEXT NOT NULL,
  element_role TEXT,
  selector TEXT,
  label TEXT,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence TEXT NOT NULL DEFAULT 'identified',
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS recordings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  mode TEXT NOT NULL,
  directory TEXT NOT NULL,
  workflow_id TEXT,
  error TEXT,
  created_by TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  bundle_path TEXT,
  recording_id TEXT,
  uncertainty JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_steps (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  intent TEXT NOT NULL,
  action TEXT NOT NULL,
  risk TEXT NOT NULL,
  anchor_kind TEXT NOT NULL,
  element_role TEXT,
  element_name TEXT,
  selector TEXT,
  ocr_text TEXT,
  field_label TEXT,
  param_name TEXT,
  is_secret BOOLEAN NOT NULL DEFAULT FALSE,
  postconditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence TEXT NOT NULL DEFAULT 'identified',
  uncertainty_note TEXT,
  UNIQUE (workflow_id, idx)
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  required_inputs JSONB NOT NULL DEFAULT '[]'::jsonb,
  triggered_by JSONB NOT NULL DEFAULT '[]'::jsonb,
  verification JSONB,
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  application_id TEXT REFERENCES applications(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'sop',
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS doc_chunks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  content TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS graph_nodes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, kind, ref_id)
);

CREATE TABLE IF NOT EXISTS graph_edges (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  weight DOUBLE PRECISION NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, from_node_id, to_node_id, relation)
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  intent TEXT NOT NULL,
  skill_id TEXT,
  workflow_id TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  intent TEXT NOT NULL,
  inputs JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL,
  outcome TEXT,
  engine_outcome TEXT,
  engine_report_path TEXT,
  model_calls INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  requested_by TEXT,
  failure JSONB,
  timings JSONB,
  recovery JSONB,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS execution_steps (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  step_id TEXT,
  intent TEXT NOT NULL,
  status TEXT NOT NULL,
  rung TEXT,
  detail TEXT,
  duration_ms INTEGER,
  input_verified BOOLEAN,
  resolved_selector TEXT,
  resolution_source TEXT
);

CREATE TABLE IF NOT EXISTS verification_results (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  tier TEXT NOT NULL,
  passed BOOLEAN NOT NULL,
  source TEXT NOT NULL,
  expected JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed JSONB,
  detail TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

-- Episodic memory: one row per execution, so a later run can see what
-- happened before without replaying the engine report.
CREATE TABLE IF NOT EXISTS execution_memory (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  intent TEXT NOT NULL,
  outcome TEXT,
  failure JSONB,
  recovery JSONB,
  trace_ref TEXT,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL
);

-- Procedural memory: repairs that worked, with the conditions they applied to.
-- `candidate` is evidence awaiting review; only `approved` rows are reused.
CREATE TABLE IF NOT EXISTS repairs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  workflow_version INTEGER NOT NULL,
  failure_origin TEXT NOT NULL,
  failure_code TEXT NOT NULL,
  action JSONB NOT NULL,
  conditions JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'candidate',
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  reviewed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  reviewed_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_memory_tenant ON execution_memory(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_repairs_lookup ON repairs(tenant_id, workflow_id, status);
CREATE INDEX IF NOT EXISTS idx_skills_tenant ON skills(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_workflows_tenant ON workflows(tenant_id, application_id);
CREATE INDEX IF NOT EXISTS idx_steps_workflow ON workflow_steps(workflow_id, idx);
CREATE INDEX IF NOT EXISTS idx_plans_tenant ON plans(tenant_id, created_at DESC);
-- Added with M4: the memory-use audit for a run. `ADD COLUMN IF NOT EXISTS`
-- keeps existing databases working without a migration step.
ALTER TABLE executions ADD COLUMN IF NOT EXISTS memory JSONB;
ALTER TABLE execution_steps ADD COLUMN IF NOT EXISTS repair_id TEXT;

CREATE INDEX IF NOT EXISTS idx_executions_tenant ON executions(tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_chunks_tenant ON doc_chunks(tenant_id, document_id);
