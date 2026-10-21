import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { DatabaseSync } from 'node:sqlite';
import { dataDir, demoMode, isProduction, loadEnv } from './env.js';

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
  migrate(db);
  return db;
}

function columnNames(database, table) {
  return new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function ensureColumn(database, table, name, definition) {
  if (!columnNames(database, table).has(name)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

function migrate(database) {
  ensureColumn(database, 'staff', 'role', "TEXT NOT NULL DEFAULT 'staff'");
  ensureColumn(database, 'staff', 'active', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(database, 'staff', 'session_version', 'INTEGER NOT NULL DEFAULT 1');
  database.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      company_name TEXT NOT NULL DEFAULT 'MoveSafe Relocation',
      tagline TEXT,
      lbs_per_cuft REAL NOT NULL DEFAULT 7,
      trucks_json TEXT,
      catalog_json TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'staff',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      revoked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sms_challenges (
      id TEXT PRIMARY KEY,
      purpose TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      used_at TEXT,
      created_at TEXT NOT NULL,
      actor_email TEXT,
      payload_json TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      actor_email TEXT,
      action TEXT NOT NULL,
      detail TEXT
    );

    CREATE TABLE IF NOT EXISTS setup_tokens (
      token_hash TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS inventory_items (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      room_label TEXT NOT NULL,
      catalog_key TEXT,
      name TEXT NOT NULL,
      size_label TEXT,
      quantity REAL NOT NULL DEFAULT 1,
      cubic_feet REAL,
      confidence REAL,
      source TEXT NOT NULL,
      not_moving INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      recording_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_inventory_room ON inventory_items(room_id);
    CREATE INDEX IF NOT EXISTS idx_invites_email ON invites(email);
  `);
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

function upsertOwner({ email, name, password, resetPassword }) {
  const existing = getStaff(email);
  const now = new Date().toISOString();
  if (!existing) {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare(`
      INSERT INTO staff (email, name, password_hash, role, active, session_version, created_at)
      VALUES (?, ?, ?, 'owner', 1, 1, ?)
    `).run(email, name, hash, now);
    return;
  }
  db.prepare(`UPDATE staff SET role = 'owner', name = ?, active = 1 WHERE email = ?`).run(name, email);
  if (resetPassword) {
    db.prepare(`UPDATE staff SET password_hash = ? WHERE email = ?`).run(bcrypt.hashSync(password, 10), email);
  }
}

export function seedStaff() {
  const owners = db.prepare(`SELECT email FROM staff WHERE role = 'owner'`).all();
  if (process.env.OWNER_EMAIL && process.env.OWNER_PASSWORD) {
    const email = process.env.OWNER_EMAIL.trim().toLowerCase();
    const password = process.env.OWNER_PASSWORD;
    if (isProduction() && password === 'walkthrough-demo') {
      throw new Error('Replace OWNER_PASSWORD before starting in production.');
    }
    if (password.length < 10) {
      throw new Error('OWNER_PASSWORD must be at least 10 characters.');
    }
    upsertOwner({
      email,
      name: process.env.OWNER_NAME || 'Owner',
      password,
      resetPassword: !getStaff(email) || process.env.OWNER_RESET_PASSWORD === 'true',
    });
  } else if (demoMode() && !process.env.OWNER_EMAIL) {
    const demo = staffUsersFromEnv()[0];
    upsertOwner({ email: demo.email, name: demo.name, password: demo.password, resetPassword: true });
  } else if (isProduction() && owners.length === 0) {
    if (!process.env.OWNER_EMAIL) {
      throw new Error('Set OWNER_EMAIL and OWNER_PASSWORD. The shared demo login is disabled in production.');
    }
    const token = createCode(24);
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.prepare(`INSERT INTO setup_tokens (token_hash, expires_at) VALUES (?, ?)`).run(hash, expires);
    console.log('MoveSafe owner setup is incomplete. A one-time setup token follows. It will not be shown again.');
    console.log(`OWNER SETUP TOKEN: ${token}`);
    console.log('Open /setup on this server and choose the owner password.');
  }
  const people = db.prepare(`SELECT email, name, role, active FROM staff ORDER BY created_at`).all();
  return people;
}

export function demoAccount() {
  if (!demoMode() || process.env.OWNER_EMAIL) return null;
  return staffUsersFromEnv()[0];
}

export function getStaff(email) {
  return db.prepare(`
    SELECT email, name, password_hash, role, active, session_version
    FROM staff WHERE email = ?
  `).get(String(email || '').toLowerCase());
}

export function listStaff() {
  return db.prepare(`
    SELECT email, name, role, active, created_at FROM staff ORDER BY role DESC, created_at
  `).all();
}

export function markOwner(email) {
  db.prepare(`UPDATE staff SET role = 'owner', active = 1 WHERE email = ?`).run(email);
  return getStaff(email);
}

export function insertStaffAccount({ email, name, passwordHash }) {
  db.prepare(`
    INSERT INTO staff (email, name, password_hash, role, active, session_version, created_at)
    VALUES (?, ?, ?, 'staff', 1, 1, ?)
  `).run(email, name, passwordHash, new Date().toISOString());
  return getStaff(email);
}

export function setStaffPassword(email, passwordHash) {
  db.prepare(`
    UPDATE staff SET password_hash = ?, session_version = session_version + 1 WHERE email = ?
  `).run(passwordHash, email);
  return getStaff(email);
}

export function setStaffActive(email, active) {
  db.prepare(`
    UPDATE staff SET active = ?, session_version = session_version + 1 WHERE email = ? AND role != 'owner'
  `).run(active ? 1 : 0, email);
  invalidateSessions(email);
  return getStaff(email);
}

export function deleteStaffAccount(email) {
  invalidateSessions(email);
  db.prepare(`DELETE FROM staff WHERE email = ? AND role != 'owner'`).run(email);
}

export function invalidateSessions(email) {
  const rows = db.prepare('SELECT sid, data FROM sessions').all();
  for (const row of rows) {
    try {
      const data = JSON.parse(row.data);
      if (data?.staff?.email === email) deleteSession(row.sid);
    } catch {
      /* ignore unreadable session rows */
    }
  }
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

const DEFAULT_SETTINGS = {
  company_name: 'MoveSafe Relocation',
  tagline: 'Video walkthroughs for careful moves.',
  lbs_per_cuft: 7,
  trucks_json: null,
  catalog_json: null,
};

export function getSettings() {
  const row = db.prepare('SELECT * FROM settings WHERE id = 1').get();
  return { ...DEFAULT_SETTINGS, ...row, lbs_per_cuft: Number(row?.lbs_per_cuft || DEFAULT_SETTINGS.lbs_per_cuft) };
}

export function saveSettings(fields) {
  const current = getSettings();
  const next = { ...current, ...fields, updated_at: new Date().toISOString() };
  db.prepare(`
    INSERT INTO settings (id, company_name, tagline, lbs_per_cuft, trucks_json, catalog_json, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      company_name = excluded.company_name,
      tagline = excluded.tagline,
      lbs_per_cuft = excluded.lbs_per_cuft,
      trucks_json = excluded.trucks_json,
      catalog_json = excluded.catalog_json,
      updated_at = excluded.updated_at
  `).run(next.company_name, next.tagline, next.lbs_per_cuft, next.trucks_json, next.catalog_json, next.updated_at);
  return getSettings();
}

export function createInvite({ id, email, createdBy, expiresAt }) {
  db.prepare(`
    INSERT INTO invites (id, email, role, created_by, created_at, expires_at)
    VALUES (?, ?, 'staff', ?, ?, ?)
  `).run(id, email, createdBy, new Date().toISOString(), expiresAt);
  return getInvite(id);
}

export function getInvite(id) {
  return db.prepare('SELECT * FROM invites WHERE id = ?').get(id);
}

export function listInvites() {
  return db.prepare('SELECT * FROM invites ORDER BY created_at DESC LIMIT 100').all();
}

export function revokeInvite(id) {
  db.prepare(`UPDATE invites SET revoked_at = ? WHERE id = ? AND used_at IS NULL`).run(new Date().toISOString(), id);
  return getInvite(id);
}

export function markInviteUsed(id) {
  db.prepare(`UPDATE invites SET used_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
}

export function insertChallenge(row) {
  db.prepare(`
    INSERT INTO sms_challenges (
      id, purpose, code_hash, expires_at, max_attempts, created_at, actor_email, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.purpose,
    row.codeHash,
    row.expiresAt,
    row.maxAttempts,
    new Date().toISOString(),
    row.actorEmail,
    row.payload ? JSON.stringify(row.payload) : null,
  );
}

export function getChallenge(id) {
  return db.prepare('SELECT * FROM sms_challenges WHERE id = ?').get(id);
}

export function addChallengeAttempt(id) {
  db.prepare('UPDATE sms_challenges SET attempts = attempts + 1 WHERE id = ?').run(id);
}

export function useChallenge(id) {
  db.prepare(`UPDATE sms_challenges SET used_at = ?, payload_json = NULL WHERE id = ?`).run(new Date().toISOString(), id);
}

export function countRecentChallenges(sinceIso) {
  return db.prepare('SELECT COUNT(*) AS count FROM sms_challenges WHERE created_at >= ?').get(sinceIso).count;
}

export function addAudit(actorEmail, action, detail) {
  db.prepare(`INSERT INTO audit_log (at, actor_email, action, detail) VALUES (?, ?, ?, ?)`).run(
    new Date().toISOString(),
    actorEmail || null,
    action,
    detail ? String(detail).slice(0, 500) : null,
  );
}

export function listAudit() {
  return db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all();
}

export function setupOpen() {
  if (db.prepare(`SELECT email FROM staff WHERE role = 'owner' LIMIT 1`).get()) return false;
  return Boolean(db.prepare(`SELECT token_hash FROM setup_tokens WHERE used_at IS NULL AND expires_at > ? LIMIT 1`).get(new Date().toISOString()));
}

export function consumeSetupToken(token) {
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const row = db.prepare(`SELECT * FROM setup_tokens WHERE token_hash = ?`).get(hash);
  if (!row || row.used_at || Date.parse(row.expires_at) < Date.now()) return false;
  db.prepare(`UPDATE setup_tokens SET used_at = ? WHERE token_hash = ?`).run(new Date().toISOString(), hash);
  return true;
}

export function listInventory(roomId) {
  return db.prepare('SELECT * FROM inventory_items WHERE room_id = ? ORDER BY room_label, created_at').all(roomId);
}

export function inventoryTotalsByRoom() {
  return db.prepare(`
    SELECT room_id, SUM(CASE WHEN not_moving = 0 AND cubic_feet IS NOT NULL THEN quantity * cubic_feet ELSE 0 END) AS cubic_feet
    FROM inventory_items
    GROUP BY room_id
  `).all();
}

export function insertInventoryItem(row) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO inventory_items (
      id, room_id, room_label, catalog_key, name, size_label, quantity, cubic_feet,
      confidence, source, not_moving, notes, recording_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.roomId,
    row.roomLabel,
    row.catalogKey || null,
    row.name,
    row.sizeLabel || null,
    row.quantity,
    row.cubicFeet,
    row.confidence,
    row.source,
    row.notMoving ? 1 : 0,
    row.notes || null,
    row.recordingId || null,
    now,
    now,
  );
  return getInventoryItem(row.id);
}

export function getInventoryItem(id) {
  return db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(id);
}

export function updateInventoryItem(id, fields) {
  const current = getInventoryItem(id);
  if (!current) return null;
  const next = {
    room_label: fields.roomLabel ?? current.room_label,
    name: fields.name ?? current.name,
    size_label: fields.sizeLabel ?? current.size_label,
    quantity: fields.quantity ?? current.quantity,
    cubic_feet: fields.cubicFeet === undefined ? current.cubic_feet : fields.cubicFeet,
    not_moving: fields.notMoving === undefined ? current.not_moving : (fields.notMoving ? 1 : 0),
    notes: fields.notes === undefined ? current.notes : fields.notes,
    catalog_key: fields.catalogKey === undefined ? current.catalog_key : fields.catalogKey,
  };
  db.prepare(`
    UPDATE inventory_items
    SET room_label = ?, name = ?, size_label = ?, quantity = ?, cubic_feet = ?,
        not_moving = ?, notes = ?, catalog_key = ?, updated_at = ?
    WHERE id = ?
  `).run(
    next.room_label,
    next.name,
    next.size_label,
    next.quantity,
    next.cubic_feet,
    next.not_moving,
    next.notes,
    next.catalog_key,
    new Date().toISOString(),
    id,
  );
  return getInventoryItem(id);
}

export function deleteInventoryItem(id) {
  db.prepare('DELETE FROM inventory_items WHERE id = ?').run(id);
}

export function linkInventoryRecording(roomId, recordingId) {
  db.prepare(`
    UPDATE inventory_items SET recording_id = ? WHERE room_id = ? AND recording_id IS NULL
  `).run(recordingId, roomId);
}
