'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let db;

function init(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS videos (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      title         TEXT    NOT NULL,
      storage_name  TEXT    NOT NULL,
      original_name TEXT    NOT NULL,
      mime_type     TEXT,
      size_bytes    INTEGER NOT NULL,
      duration_ms   INTEGER NOT NULL CHECK (duration_ms > 0),
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS segments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id   INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      start_ms   INTEGER NOT NULL CHECK (start_ms >= 0),
      end_ms     INTEGER NOT NULL CHECK (end_ms > start_ms),
      text       TEXT    NOT NULL DEFAULT '',
      reviewed   INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1)),
      revision   INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL,
      UNIQUE (video_id, id)
    );

    CREATE INDEX IF NOT EXISTS idx_segments_video ON segments(video_id, start_ms);

    CREATE TABLE IF NOT EXISTS publications (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id     INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      version      INTEGER NOT NULL,
      snapshot     TEXT    NOT NULL,
      segment_count INTEGER NOT NULL,
      published_at INTEGER NOT NULL,
      UNIQUE (video_id, version)
    );

    CREATE INDEX IF NOT EXISTS idx_publications_video ON publications(video_id, version);
  `);

  return db;
}

function get() {
  if (!db) throw new Error('数据库尚未初始化');
  return db;
}

module.exports = { init, get };
