import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { DatabaseSync } from 'node:sqlite';
import { dataDir, isProduction, loadEnv } from './env.js';

loadEnv();

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function createCode(length) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ROOM_ALPHABET[bytes[i] % ROOM_ALPHABET.length];
  }
  return out;
}

function openDatabase() {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'movesafe.sqlite'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 4000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS staff (
      email TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      expires TEXT
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      customer_name TEXT NOT NULL,
      customer_phone TEXT,
      origin TEXT,
      destination TEXT,
      move_date TEXT,
      notes TEXT,
      created_by_email TEXT,
      created_by_name TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recordings (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      origin TEXT,
      destination TEXT,
      move_date TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_sec INTEGER,
      started_by_email TEXT NOT NULL,
      started_by_name TEXT NOT NULL,
      owner_participant_id TEXT,
      mime TEXT,
      extension TEXT,
      bytes INTEGER DEFAULT 0,
      status TEXT NOT NULL,
      storage TEXT NOT NULL DEFAULT 'local',
      storage_key TEXT,
      poster_key TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_recordings_started ON recordings(started_at);
    CREATE INDEX IF NOT EXISTS idx_recordings_room ON recordings(room_id);
  `);
  return db;
}

const db = openDatabase();

function staffUsersFromEnv() {
  if (process.env.STAFF_USERS) {
    return process.env.STAFF_USERS.split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [email, name, password] = part.split('|').map((bit) => (bit || '').trim());
        if (!email || !password) {
          throw new Error('Each STAFF_USERS entry must look like email|Name|password');
        }
        return { email: email.toLowerCase(), name: name || email, password };
      });
  }
  const password = process.env.STAFF_PASSWORD || (isProduction() ? '' : 'walkthrough-demo');
  const email = (process.env.STAFF_EMAIL || 'alex@movesaferelocation.com').toLowerCase();
  if (!password) {
    throw new Error('Set STAFF_PASSWORD (or STAFF_USERS) before starting in production.');
  }
  if (isProduction() && password === 'walkthrough-demo') {
    throw new Error('Replace the demo STAFF_PASSWORD before starting in production.');
  }
  return [
    {
      email,
      name: process.env.STAFF_NAME || 'Alex Rivera',
      password,
    },
  ];
}

export function seedStaff() {
  const users = staffUsersFromEnv();
  const upsert = db.prepare(`
    INSERT INTO staff (email, name, password_hash, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      name = excluded.name,
      password_hash = excluded.password_hash
  `);
  const now = new Date().toISOString();
  for (const user of users) {
    const hash = bcrypt.hashSync(user.password, 10);
    upsert.run(user.email, user.name, hash, now);
  }
  return users.map(({ email, name }) => ({ email, name }));
}

export function primaryStaff() {
  const users = staffUsersFromEnv();
  return users[0];
}

export function getStaff(email) {
  return db.prepare('SELECT email, name, password_hash FROM staff WHERE email = ?').get(email);
}

export function saveSession(sid, data, expires) {
  db.prepare(`
    INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?)
    ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires
  `).run(sid, data, expires);
}

export function getSession(sid) {
  return db.prepare('SELECT sid, data, expires FROM sessions WHERE sid = ?').get(sid);
}

export function deleteSession(sid) {
  db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
}

export function pruneSessions() {
  db.prepare('DELETE FROM sessions WHERE expires IS NOT NULL AND expires < ?').run(new Date().toISOString());
}

export function createRoom(input) {
  let id = createCode(8);
  for (let i = 0; i < 5 && getRoom(id); i += 1) id = createCode(8);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO rooms (
      id, customer_name, customer_phone, origin, destination, move_date, notes,
      created_by_email, created_by_name, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.customerName,
    input.customerPhone || null,
    input.origin || null,
    input.destination || null,
    input.moveDate || null,
    input.notes || null,
    input.createdByEmail,
    input.createdByName,
    now,
  );
  return getRoom(id);
}

export function getRoom(id) {
  return db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
}

export function listRooms() {
  return db.prepare('SELECT * FROM rooms ORDER BY created_at DESC LIMIT 100').all();
}

export function recordingCounts() {
  const rows = db.prepare(`
    SELECT room_id, COUNT(*) AS count
    FROM recordings
    WHERE status = 'ready'
    GROUP BY room_id
  `).all();
  return Object.fromEntries(rows.map((row) => [row.room_id, row.count]));
}

export function insertRecording(row) {
  db.prepare(`
    INSERT INTO recordings (
      id, room_id, customer_name, origin, destination, move_date, started_at,
      started_by_email, started_by_name, owner_participant_id, mime, extension,
      bytes, status, storage, storage_key, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'recording', 'local', ?, ?)
  `).run(
    row.id,
    row.roomId,
    row.customerName,
    row.origin,
    row.destination,
    row.moveDate,
    row.startedAt,
    row.startedByEmail,
    row.startedByName,
    row.ownerParticipantId,
    row.mime,
    row.extension,
    row.storageKey,
    row.startedAt,
  );
  return getRecording(row.id);
}

export function getRecording(id) {
  return db.prepare('SELECT * FROM recordings WHERE id = ?').get(id);
}

export function getActiveRecording(roomId) {
  return db.prepare(`
    SELECT * FROM recordings
    WHERE room_id = ? AND status = 'recording'
    ORDER BY started_at DESC
    LIMIT 1
  `).get(roomId);
}

export function setRecordingBytes(id, bytes) {
  db.prepare('UPDATE recordings SET bytes = ? WHERE id = ?').run(bytes, id);
}

export function setPoster(id, posterKey) {
  db.prepare('UPDATE recordings SET poster_key = ? WHERE id = ?').run(posterKey, id);
}

export function finishRecordingRow(id, fields) {
  db.prepare(`
    UPDATE recordings
    SET status = ?, bytes = ?, storage = ?, storage_key = ?, mime = ?, extension = ?,
        ended_at = ?, duration_sec = ?
    WHERE id = ?
  `).run(
    fields.status,
    fields.bytes,
    fields.storage,
    fields.storageKey,
    fields.mime,
    fields.extension,
    fields.endedAt,
    fields.durationSec,
    id,
  );
  return getRecording(id);
}

export function listRecordings() {
  return db.prepare('SELECT * FROM recordings ORDER BY started_at DESC LIMIT 200').all();
}

export function deleteRecording(id) {
  db.prepare('DELETE FROM recordings WHERE id = ?').run(id);
}

export function recordingsOlderThan(iso) {
  return db.prepare(`
    SELECT * FROM recordings
    WHERE status != 'recording' AND started_at < ?
  `).all(iso);
}

export function staleOpenRecordings(olderThanIso) {
  return db.prepare(`
    SELECT * FROM recordings
    WHERE status = 'recording' AND started_at < ?
  `).all(olderThanIso);
}
