import crypto from 'node:crypto';
import * as db from './db.js';

const rooms = new Map();
const liveRecordings = new Map();
let onAbandon = () => {};

export function setAbandonHandler(fn) {
  onAbandon = fn;
}

export function presenceCount(roomId) {
  return rooms.get(roomId)?.size || 0;
}

export function presenceMap() {
  return Object.fromEntries([...rooms.entries()].map(([id, members]) => [id, members.size]));
}

function roomMembers(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Map());
  return rooms.get(roomId);
}

export function registerLiveRecording(info) {
  const prev = liveRecordings.get(info.roomId);
  if (prev?.timer) clearTimeout(prev.timer);
  liveRecordings.set(info.roomId, { ...info, timer: null });
}

export function clearLiveRecording(roomId) {
  const prev = liveRecordings.get(roomId);
  if (prev?.timer) clearTimeout(prev.timer);
  liveRecordings.delete(roomId);
}

function armAbandon(roomId, participantId) {
  const live = liveRecordings.get(roomId);
  if (!live || live.participantId !== participantId) return;
  if (live.timer) clearTimeout(live.timer);
  live.timer = setTimeout(() => {
    const members = rooms.get(roomId);
    const still = members?.get(participantId);
    if (still && still.email === live.email) return;
    const recordingId = live.recordingId;
    clearLiveRecording(roomId);
    onAbandon(recordingId);
  }, 20000);
}

function disarmAbandon(roomId, participantId) {
  const live = liveRecordings.get(roomId);
  if (!live || live.participantId !== participantId) return;
  if (live.timer) clearTimeout(live.timer);
  live.timer = null;
}

function cleanName(value, fallback) {
  const name = String(value || '')
    .replace(/[\u0000-\u001F]/g, '')
    .trim()
    .slice(0, 60);
  return name || fallback;
}

export function iceServers() {
  const servers = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ];
  const urls = (process.env.TURN_URLS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (!urls.length) return servers;

  if (process.env.TURN_SECRET) {
    const expiry = Math.floor(Date.now() / 1000) + 8 * 60 * 60;
    const username = `${expiry}:movesafe`;
    const credential = crypto
      .createHmac('sha1', process.env.TURN_SECRET)
      .update(username)
      .digest('base64');
    servers.push({ urls, username, credential });
  } else if (process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    servers.push({
      urls,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  return servers;
}

export function recordingPayload(roomId) {
  const row = db.getActiveRecording(roomId);
  if (!row) return { active: false };
  return {
    active: true,
    id: row.id,
    startedAt: row.started_at,
    byName: row.started_by_name,
    ownerParticipantId: row.owner_participant_id,
  };
}

export function attachSignaling(io) {
  io.on('connection', (socket) => {
    let joined = null;

    socket.on('join', (payload = {}, ack) => {
      const reply = (body) => {
        if (typeof ack === 'function') ack(body);
      };
      try {
        const roomId = String(payload.roomId || '').toUpperCase();
        const participantId = String(payload.participantId || '');
        if (!/^[A-Z0-9]{8}$/.test(roomId)) throw new Error('That survey link is not valid.');
        if (!/^[A-Za-z0-9-]{8,80}$/.test(participantId)) {
          throw new Error('Missing participant id.');
        }
        const room = db.getRoom(roomId);
        if (!room) throw new Error('That survey link is not valid.');

        const sessionStaff = socket.request.session?.staff || null;
        const staff = payload.asGuest ? null : sessionStaff;
        const displayName = cleanName(payload.name, staff ? staff.name : 'Guest');

        const members = roomMembers(roomId);
        const previous = members.get(participantId);
        if (previous && previous.socketId !== socket.id) {
          const old = io.sockets.sockets.get(previous.socketId);
          members.delete(participantId);
          io.to(roomId).emit('peer-left', { id: participantId });
          if (old) old.disconnect(true);
        }
        if (!members.has(participantId) && members.size >= 4) {
          throw new Error('This survey room is full (4 people).');
        }

        members.set(participantId, {
          socketId: socket.id,
          name: displayName,
          isStaff: Boolean(staff),
          email: staff?.email || null,
        });
        socket.join(roomId);
        joined = { roomId, participantId };
        disarmAbandon(roomId, participantId);

        const peers = [...members.entries()]
          .filter(([id]) => id !== participantId)
          .map(([id, member]) => ({ id, name: member.name, isStaff: member.isStaff }));

        socket.emit('room-state', {
          you: { id: participantId, name: displayName, isStaff: Boolean(staff) },
          peers,
          recording: recordingPayload(roomId),
          customerName: room.customer_name,
        });
        socket.to(roomId).emit('peer-joined', {
          id: participantId,
          name: displayName,
          isStaff: Boolean(staff),
        });
        reply({ ok: true });
      } catch (err) {
        reply({ ok: false, error: err.message || 'Could not join.' });
      }
    });

    socket.on('signal', (payload = {}) => {
      if (!joined) return;
      const roomId = String(payload.roomId || '');
      if (roomId !== joined.roomId) return;
      const target = rooms.get(roomId)?.get(payload.to);
      if (!target) return;
      io.to(target.socketId).emit('signal', {
        from: joined.participantId,
        data: payload.data,
      });
    });

    socket.on('disconnect', () => {
      if (!joined) return;
      const members = rooms.get(joined.roomId);
      const current = members?.get(joined.participantId);
      if (!current || current.socketId !== socket.id) return;
      members.delete(joined.participantId);
      if (members.size === 0) rooms.delete(joined.roomId);
      socket.to(joined.roomId).emit('peer-left', { id: joined.participantId });
      armAbandon(joined.roomId, joined.participantId);
    });
  });
}

export function emitToRoom(io, roomId, event, payload) {
  io.to(roomId).emit(event, payload);
}
