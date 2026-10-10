-- 既存のテーブルがあれば削除して作り直す
DROP TABLE IF EXISTS info;
DROP TABLE IF EXISTS timetable;

-- お知らせ（テロップ）用の表（拡張版）
CREATE TABLE info (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_text TEXT NOT NULL,          -- 元の入力文
  formatted_text TEXT,             -- AI整形後（またはそのまま）の文
  tag TEXT NOT NULL,               -- カテゴリタグ
  frequency INTEGER DEFAULT 1,     -- 表示頻度（迷子用: 〇回に1回）
  is_active INTEGER DEFAULT 1,     -- 表示ON/OFFフラグ
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- タイムテーブル用の表（前回と同じ）
CREATE TABLE timetable (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time_str TEXT NOT NULL,
  title TEXT NOT NULL,
  band TEXT,
  type TEXT NOT NULL
);