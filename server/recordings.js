import * as db from './db.js';
import * as signaling from './signaling.js';
import {
  appendChunk,
  finalizeFile,
  removeStored,
  writePoster,
} from './storage.js';

let io = null;
const tails = new Map();

function lock(id, fn) {
  const prev = tails.get(id) || Promise.resolve();
  const run = prev.then(fn, fn);
  tails.set(
    id,
    run.then(
      () => {},
      () => {},
    ),
  );
  return run;
}

export function setIo(serverIo) {
  io = serverIo;
}

function emitRecording(roomId) {
  if (!io) return;
  signaling.emitToRoom(io, roomId, 'recording', signaling.recordingPayload(roomId));
}

export function serialize(row) {
  if (!row) return null;
  return {
    id: row.id,
    roomId: row.room_id,
    customerName: row.customer_name,
    origin: row.origin,
    destination: row.destination,
    moveDate: row.move_date,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationSec: row.duration_sec,
    startedByName: row.started_by_name,
    startedByEmail: row.started_by_email,
    mime: row.mime,
    extension: row.extension,
    bytes: row.bytes,
    status: row.status,
    hasPoster: Boolean(row.poster_key),
  };
}

function publicMime(mime, extension) {
  if (extension === 'mp4' || String(mime).includes('mp4')) return 'video/mp4';
  return 'video/webm';
}

export async function startRecording({ room, staff, participantId, mime }) {
  const active = db.getActiveRecording(room.id);
  if (active) {
    const error = new Error('A recording is already in progress for this survey.');
    error.status = 409;
    throw error;
  }
  const extension = String(mime).includes('mp4') ? 'mp4' : 'webm';
  const id = db.createCode(12);
  const startedAt = new Date().toISOString();
  const row = db.insertRecording({
    id,
    roomId: room.id,
    customerName: room.customer_name,
    origin: room.origin,
    destination: room.destination,
    moveDate: room.move_date,
    startedAt,
    startedByEmail: staff.email,
    startedByName: staff.name,
    ownerParticipantId: participantId || null,
    mime: publicMime(mime, extension),
    extension,
    storageKey: `${id}.${extension}`,
  });
  signaling.registerLiveRecording({
    roomId: room.id,
    recordingId: id,
    participantId: participantId || null,
    email: staff.email,
  });
  emitRecording(room.id);
  console.log(`Recording started ${id} room ${room.id} by ${staff.email}`);
  return row;
}

export async function saveChunk({ recording, buffer }) {
  return lock(recording.id, async () => {
    const fresh = db.getRecording(recording.id);
    if (!fresh || fresh.status !== 'recording') {
      const error = new Error('Recording is not active.');
      error.status = 409;
      throw error;
    }
    if (!buffer?.length) return fresh.bytes || 0;
    if ((fresh.bytes || 0) + buffer.length > 1_500_000_000) {
      const error = new Error('Recording is too large.');
      error.status = 413;
      throw error;
    }
    const size = await appendChunk(fresh.id, fresh.extension, buffer);
    db.setRecordingBytes(fresh.id, size);
    return size;
  });
}

export async function savePoster(recording, buffer) {
  if (!buffer?.length) return;
  const key = writePoster(recording.id, buffer);
  db.setPoster(recording.id, key);
}

export async function finishRecording(id, { actorEmail, system = false } = {}) {
  return lock(id, async () => finishRecordingLocked(id, { actorEmail, system }));
}

async function finishRecordingLocked(id, { actorEmail, system = false } = {}) {
  const existing = db.getRecording(id);
  if (!existing) {
    const error = new Error('Recording not found.');
    error.status = 404;
    throw error;
  }
  if (!system && actorEmail && existing.started_by_email !== actorEmail) {
    const error = new Error('Only the specialist who started this recording can save it.');
    error.status = 403;
    throw error;
  }
  if (existing.status !== 'recording') return existing;

  const stored = await finalizeFile(existing);
  const endedAt = new Date().toISOString();
  const wall = Math.max(
    0,
    Math.round((Date.parse(endedAt) - Date.parse(existing.started_at)) / 1000),
  );
  const durationSec = stored.durationSec != null ? Math.round(stored.durationSec) : wall;
  const status = stored.bytes > 500 ? 'ready' : 'failed';
  const row = db.finishRecordingRow(id, {
    status,
    bytes: stored.bytes,
    storage: stored.storage,
    storageKey: stored.storageKey,
    mime: stored.mime,
    extension: stored.extension,
    endedAt,
    durationSec: status === 'ready' ? durationSec : 0,
  });
  signaling.clearLiveRecording(existing.room_id);
  emitRecording(existing.room_id);
  console.log(`Recording ${status} ${id} (${stored.bytes} bytes, ${stored.storage})`);
  return row;
}

export async function abortRecording(id, actorEmail) {
  const existing = db.getRecording(id);
  if (!existing) return null;
  if (existing.started_by_email !== actorEmail) {
    const error = new Error('Forbidden.');
    error.status = 403;
    throw error;
  }
  if (existing.status === 'recording') {
    await finishRecording(id, { actorEmail, system: true });
    const row = db.getRecording(id);
    if (row && row.bytes < 500) {
      await removeStored(row);
      db.finishRecordingRow(id, {
        status: 'failed',
        bytes: 0,
        storage: row.storage,
        storageKey: row.storage_key,
        mime: row.mime,
        extension: row.extension,
        endedAt: new Date().toISOString(),
        durationSec: 0,
      });
    }
  }
  return db.getRecording(id);
}

export async function deleteRecording(id) {
  const row = db.getRecording(id);
  if (!row) return false;
  if (row.status === 'recording') {
    const error = new Error('Stop the recording before deleting it.');
    error.status = 409;
    throw error;
  }
  await removeStored(row);
  db.deleteRecording(id);
  return true;
}

export async function purgeExpired() {
  const days = Number(process.env.RECORDING_TTL_DAYS || 0);
  if (!Number.isFinite(days) || days <= 0) return;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = db.recordingsOlderThan(cutoff);
  for (const row of rows) {
    await removeStored(row);
    db.deleteRecording(row.id);
    console.log(`Retention deleted recording ${row.id}`);
  }
}

export async function finalizeAbandoned(id) {
  const row = db.getRecording(id);
  if (!row || row.status !== 'recording') return;
  console.log(`Finalizing recording ${id} after the specialist disconnected`);
  await finishRecording(id, { system: true });
}
