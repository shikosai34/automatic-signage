CREATE TABLE IF NOT EXISTS obs_agent_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  current_scene TEXT NOT NULL DEFAULT '',
  current_program TEXT NOT NULL DEFAULT '',
  current_commercial TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT ''
);
