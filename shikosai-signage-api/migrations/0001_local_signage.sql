CREATE TABLE IF NOT EXISTS signage_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  current_day INTEGER NOT NULL DEFAULT 1,
  current_index INTEGER NOT NULL DEFAULT -1,
  is_auto INTEGER NOT NULL DEFAULT 1,
  wait_cm INTEGER NOT NULL DEFAULT 1,
  delay_minutes INTEGER NOT NULL DEFAULT 0,
  sidebar_mode TEXT NOT NULL DEFAULT 'sync',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO signage_state (id) VALUES (1);

CREATE TABLE IF NOT EXISTS circle_catalog (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'circle',
  class_name TEXT NOT NULL DEFAULT '',
  group_name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  program_description TEXT NOT NULL DEFAULT '',
  circle_cut_path TEXT NOT NULL DEFAULT '',
  circle_cut_alt TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  preference_score INTEGER NOT NULL DEFAULT 0 CHECK (preference_score BETWEEN -10 AND 10),
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS programs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  scheduled_start TEXT NOT NULL,
  adjusted_start TEXT NOT NULL DEFAULT '',
  end_time TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'program',
  class_name TEXT NOT NULL DEFAULT '',
  circle_slug TEXT NOT NULL DEFAULT '',
  media_path TEXT NOT NULL DEFAULT '',
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS programs_by_day_start ON programs(day, scheduled_start, display_order);

CREATE TABLE IF NOT EXISTS commercials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  circle_slug TEXT NOT NULL DEFAULT '',
  media_path TEXT NOT NULL DEFAULT '',
  duration_seconds INTEGER NOT NULL DEFAULT 15,
  preference_score INTEGER NOT NULL DEFAULT 0 CHECK (preference_score BETWEEN -10 AND 10),
  max_per_break INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  play_count INTEGER NOT NULL DEFAULT 0,
  last_played_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'お知らせ',
  is_emergency INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  display_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS playback_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  commercial_id INTEGER NOT NULL,
  break_key TEXT NOT NULL,
  played_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS playback_by_ad_time ON playback_history(commercial_id, played_at);
CREATE INDEX IF NOT EXISTS playback_by_break ON playback_history(break_key, commercial_id);

CREATE TABLE IF NOT EXISTS backup_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  local_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  byte_size INTEGER NOT NULL DEFAULT 0
);
