export const schemaSql = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coworkers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  description TEXT,
  system_prompt TEXT NOT NULL,
  model_provider TEXT NOT NULL,
  model_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  runtime_status TEXT NOT NULL DEFAULT 'STOPPED',
  workspace_path TEXT NOT NULL,
  enabled_tools_json TEXT NOT NULL DEFAULT '[]',
  policies_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status IN ('active', 'paused')),
  CHECK (runtime_status IN ('STOPPED', 'STARTING', 'IDLE', 'WORKING', 'WAITING_FOR_APPROVAL', 'ERROR'))
);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  coworker_id TEXT NOT NULL,
  name TEXT NOT NULL,
  schedule_type TEXT NOT NULL,
  cron_expression TEXT,
  run_at TEXT,
  timezone TEXT NOT NULL,
  task_template_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (coworker_id) REFERENCES coworkers(id) ON DELETE CASCADE,
  CHECK (schedule_type IN ('cron', 'once')),
  CHECK (enabled IN (0, 1))
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  coworker_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (coworker_id) REFERENCES coworkers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS conversations_coworker_updated_idx
  ON conversations(coworker_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  coworker_id TEXT NOT NULL,
  schedule_id TEXT,
  run_id TEXT,
  thread_id TEXT,
  title TEXT NOT NULL,
  input TEXT NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  priority INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (coworker_id) REFERENCES coworkers(id) ON DELETE CASCADE,
  FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE SET NULL,
  CHECK (status IN ('QUEUED', 'RUNNING', 'WAITING_FOR_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED')),
  CHECK (source IN ('manual', 'schedule', 'recovery'))
);

CREATE UNIQUE INDEX IF NOT EXISTS tasks_run_id_idx
  ON tasks(run_id)
  WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_coworker_queue_idx
  ON tasks(coworker_id, status, priority DESC, created_at ASC);

CREATE TABLE IF NOT EXISTS task_image_attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  coworker_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (coworker_id) REFERENCES coworkers(id) ON DELETE CASCADE,
  CHECK (size > 0)
);

CREATE INDEX IF NOT EXISTS task_image_attachments_task_idx
  ON task_image_attachments(task_id, created_at ASC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  coworker_id TEXT NOT NULL,
  task_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (coworker_id) REFERENCES coworkers(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  CHECK (role IN ('user', 'assistant', 'system', 'tool'))
);

CREATE INDEX IF NOT EXISTS messages_coworker_created_idx
  ON messages(coworker_id, created_at ASC);

CREATE TABLE IF NOT EXISTS task_checkpoints (
  task_id TEXT PRIMARY KEY,
  messages_json TEXT NOT NULL DEFAULT '[]',
  pending_tool_json TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  coworker_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  arguments_json TEXT,
  result_json TEXT,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (coworker_id) REFERENCES coworkers(id) ON DELETE CASCADE,
  CHECK (status IN ('REQUESTED', 'WAITING_FOR_APPROVAL', 'RUNNING', 'COMPLETED', 'FAILED', 'DENIED'))
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  coworker_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL UNIQUE,
  action_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  proposed_payload_json TEXT,
  decided_payload_json TEXT,
  risk_level TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (coworker_id) REFERENCES coworkers(id) ON DELETE CASCADE,
  FOREIGN KEY (tool_call_id) REFERENCES tool_calls(id) ON DELETE CASCADE,
  CHECK (risk_level IN ('low', 'medium', 'high')),
  CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EDITED', 'EXPIRED'))
);

CREATE INDEX IF NOT EXISTS approvals_status_created_idx
  ON approvals(status, created_at ASC);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  coworker_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL,
  FOREIGN KEY (coworker_id) REFERENCES coworkers(id) ON DELETE CASCADE
);

DELETE FROM artifacts
WHERE task_id IS NOT NULL
  AND rowid NOT IN (
    SELECT MIN(rowid)
    FROM artifacts
    WHERE task_id IS NOT NULL
    GROUP BY task_id, file_path
  );
CREATE UNIQUE INDEX IF NOT EXISTS artifacts_task_path_idx
  ON artifacts(task_id, file_path)
  WHERE task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  coworker_id TEXT,
  task_id TEXT,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (coworker_id) REFERENCES coworkers(id) ON DELETE SET NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS activity_created_idx ON activity(created_at DESC);

CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  credential_key TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (type IN ('email')),
  CHECK (mode IN ('local-outbox', 'resend')),
  CHECK (status IN ('connected', 'disconnected', 'error'))
);

CREATE TABLE IF NOT EXISTS side_effects (
  idempotency_key TEXT PRIMARY KEY,
  tool_call_id TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (tool_call_id) REFERENCES tool_calls(id) ON DELETE CASCADE,
  CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  content TEXT NOT NULL,
  source_url TEXT,
  bundled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (bundled IN (0, 1))
);

CREATE TABLE IF NOT EXISTS coworker_skills (
  coworker_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (coworker_id, skill_id),
  FOREIGN KEY (coworker_id) REFERENCES coworkers(id) ON DELETE CASCADE,
  FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS skill_resources (
  skill_id TEXT NOT NULL,
  path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  content BLOB NOT NULL,
  PRIMARY KEY (skill_id, path),
  FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO conversations(id, coworker_id, title, created_at, updated_at)
SELECT
  tasks.thread_id,
  tasks.coworker_id,
  MIN(tasks.title),
  MIN(tasks.created_at),
  MAX(COALESCE(tasks.completed_at, tasks.started_at, tasks.created_at))
FROM tasks
WHERE tasks.thread_id IS NOT NULL AND tasks.thread_id <> ''
GROUP BY tasks.thread_id, tasks.coworker_id;

INSERT OR IGNORE INTO conversations(id, coworker_id, title, created_at, updated_at)
SELECT
  'coworker:' || coworkers.id,
  coworkers.id,
  'New conversation',
  coworkers.created_at,
  coworkers.updated_at
FROM coworkers
WHERE NOT EXISTS (
  SELECT 1 FROM conversations WHERE conversations.coworker_id = coworkers.id
);

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (1, datetime('now'));
`;
