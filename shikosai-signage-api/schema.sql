DROP TABLE IF EXISTS info;
DROP TABLE IF EXISTS timetable;
DROP TABLE IF EXISTS app_state;
DROP TABLE IF EXISTS sidebar_items;

-- お知らせ（テロップ）用
CREATE TABLE info (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_text TEXT NOT NULL,
  formatted_text TEXT,
  tag TEXT NOT NULL,
  frequency INTEGER DEFAULT 1,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- タイムテーブル用（1日目・2日目対応版）
CREATE TABLE timetable (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day INTEGER DEFAULT 1,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  title TEXT NOT NULL,
  band TEXT,
  type TEXT NOT NULL
);

-- システム状態管理用
CREATE TABLE app_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  current_day INTEGER DEFAULT 1,
  current_index INTEGER DEFAULT -1,
  is_auto INTEGER DEFAULT 1,
  wait_cm INTEGER DEFAULT 0
);
INSERT INTO app_state (id, current_day, current_index, is_auto, wait_cm) VALUES (1, 1, -1, 1, 0);

-- 右側パネル用
CREATE TABLE sidebar_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  image_data TEXT,
  duration INTEGER DEFAULT 10,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);