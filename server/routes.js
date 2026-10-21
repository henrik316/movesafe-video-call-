import fs from 'node:fs';
import express from 'express';
import bcrypt from 'bcryptjs';
import * as db from './db.js';
import * as signaling from './signaling.js';
import * as recordings from './recordings.js';
import { actor, asyncHandler, canAccessRoom, publicUser, requireStaff, startSession } from './access.js';
import { registerAdminRoutes } from './adminRoutes.js';
import { registerInventoryRoutes } from './inventoryRoutes.js';
import { readOffice } from './office.js';
import { beginChallenge, takeChallenge } from './sms.js';
import { visionMode } from './vision.js';
import { showDemoBanner } from './env.js';
import { openLocal, openS3, parseRange, posterPath, storageMode } from './storage.js';

const loginAttempts = new Map();

function clean(value, max) {
  return String(value || '')
    .replace(/[\u0000-\u001F]/g, '')
    .trim()
    .slice(0, max);
}

function locked(email) {
  const row = loginAttempts.get(email);
  return Boolean(row?.lockUntil && row.lockUntil > Date.now());
}

function markFailure(email) {
  const row = loginAttempts.get(email) || { count: 0, lockUntil: 0 };
  if (row.lockUntil && row.lockUntil <= Date.now()) {
    row.count = 0;
    row.lockUntil = 0;
  }
  row.count += 1;
  if (row.count >= 8) {
    row.lockUntil = Date.now() + 5 * 60 * 1000;
    row.count = 0;
  }
  loginAttempts.set(email, row);
}

function publicRoom(row) {
  return {
    id: row.id,
    customerName: row.customer_name,
    origin: row.origin,
    destination: row.destination,
    moveDate: row.move_date,
  };
}

function staffRoom(row, counts, presence, inventory) {
  return {
    ...publicRoom(row),
    customerPhone: row.customer_phone,
    notes: row.notes,
    createdByName: row.created_by_name,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    recordingCount: counts[row.id] || 0,
    inCall: presence[row.id] || 0,
    inventoryCubicFeet: inventory[row.id] || 0,
  };
}

function visibleRooms(user) {
  return db.listRooms().filter((room) => canAccessRoom(user, room));
}

function roomFor(user, id) {
  const room = db.getRoom(String(id || '').toUpperCase());
  if (!room || !canAccessRoom(user, room)) return null;
  return room;
}

function inventoryMap() {
  return Object.fromEntries(db.inventoryTotalsByRoom().map((row) => [row.room_id, row.cubic_feet || 0]));
}

function recordingAllowed(user, row) {
  if (!row) return null;
  const room = db.getRoom(row.room_id);
  if (!canAccessRoom(user, room)) return null;
  return row;
}

export function registerRoutes(app) {
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, storage: storageMode() });
  });

  app.get('/api/config', (req, res) => {
    const office = readOffice();
    const demo = showDemoBanner() ? db.demoAccount() : null;
    res.json({
      company: office.companyName,
      tagline: office.tagline,
      domain: 'movesaferelocation.com',
      ai: visionMode(),
      demo: demo
        ? {
            email: demo.email,
            password: demo.password,
            name: demo.name,
            note: 'Dev demo only. This shared login is disabled in production.',
          }
        : null,
    });
  });

  app.get('/api/ice', (req, res) => {
    res.json({ iceServers: signaling.iceServers() });
  });

  app.post(
    '/api/login',
    asyncHandler(async (req, res) => {
      const email = clean(req.body?.email, 120).toLowerCase();
      const password = String(req.body?.password || '');
      if (locked(email)) {
        res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
        return;
      }
      const user = email ? db.getStaff(email) : null;
      const match = user ? await bcrypt.compare(password, user.password_hash) : false;
      if (!match) {
        if (email) markFailure(email);
        res.status(401).json({ error: 'Email or password is incorrect.' });
        return;
      }
      loginAttempts.delete(email);
      if (!user.active) {
        res.status(403).json({ error: 'This account is deactivated.' });
        return;
      }
      if (user.role === 'owner') {
        const challenge = await beginChallenge({
          purpose: 'owner_login',
          actorEmail: user.email,
          payload: { email: user.email },
        });
        res.json({ mfaRequired: true, ...challenge });
        return;
      }
      await startSession(req, user);
      db.addAudit(user.email, 'staff.login', null);
      res.json(publicUser(user));
    }),
  );

  app.post(
    '/api/login/mfa',
    asyncHandler(async (req, res) => {
      const taken = takeChallenge(clean(req.body?.challengeId, 80), req.body?.code);
      if (taken.purpose !== 'owner_login') {
        res.status(400).json({ error: 'That code is no longer valid.' });
        return;
      }
      const user = db.getStaff(taken.payload.email);
      if (!user || !user.active || user.role !== 'owner') {
        res.status(403).json({ error: 'Owner access required.' });
        return;
      }
      await startSession(req, user);
      db.addAudit(user.email, 'owner.login', null);
      res.json(publicUser(user));
    }),
  );

  app.post('/api/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('movesafe.sid', { path: '/' });
      res.json({ ok: true });
    });
  });

  app.get('/api/me', (req, res) => {
    const user = actor(req);
    if (!user) {
      res.status(401).json({ error: 'Staff login required.' });
      return;
    }
    res.json(user);
  });

  app.post(
    '/api/rooms',
    requireStaff,
    asyncHandler(async (req, res) => {
      const customerName = clean(req.body?.customerName, 80);
      if (customerName.length < 2) {
        res.status(400).json({ error: 'Enter the customer name.' });
        return;
      }
      const moveDate = clean(req.body?.moveDate, 10);
      if (moveDate && !/^\d{4}-\d{2}-\d{2}$/.test(moveDate)) {
        res.status(400).json({ error: 'Move date must be YYYY-MM-DD.' });
        return;
      }
      const room = db.createRoom({
        customerName,
        customerPhone: clean(req.body?.customerPhone, 40),
        origin: clean(req.body?.origin, 80),
        destination: clean(req.body?.destination, 80),
        moveDate,
        notes: clean(req.body?.notes, 1000),
        createdByEmail: req.session.staff.email,
        createdByName: req.session.staff.name,
      });
      console.log(`Room ${room.id} created for ${room.customer_name}`);
      res.status(201).json({
        room: staffRoom(room, db.recordingCounts(), signaling.presenceMap(), inventoryMap()),
      });
    }),
  );

  app.get('/api/rooms', requireStaff, (req, res) => {
    const counts = db.recordingCounts();
    const presence = signaling.presenceMap();
    const inventory = inventoryMap();
    res.json({ rooms: visibleRooms(req.staff).map((row) => staffRoom(row, counts, presence, inventory)) });
  });

  app.get('/api/rooms/:id', requireStaff, (req, res) => {
    const room = roomFor(req.staff, req.params.id);
    if (!room) {
      res.status(404).json({ error: 'Survey not found.' });
      return;
    }
    res.json({ room: staffRoom(room, db.recordingCounts(), signaling.presenceMap(), inventoryMap()) });
  });

  app.get('/api/rooms/:id/public', (req, res) => {
    const room = db.getRoom(String(req.params.id || '').toUpperCase());
    if (!room) {
      res.status(404).json({ error: 'That survey link is not valid.' });
      return;
    }
    res.json({ room: publicRoom(room) });
  });

  app.post(
    '/api/recordings/start',
    requireStaff,
    asyncHandler(async (req, res) => {
      const room = roomFor(req.staff, req.body?.roomId);
      if (!room) {
        res.status(404).json({ error: 'Survey not found.' });
        return;
      }
      const participantId = clean(req.body?.participantId, 80);
      const mime = clean(req.body?.mime, 80) || 'video/webm';
      const row = await recordings.startRecording({
        room,
        staff: req.session.staff,
        participantId,
        mime,
      });
      res.status(201).json({ recording: recordings.serialize(row) });
    }),
  );

  app.post(
    '/api/recordings/:id/chunk',
    requireStaff,
    express.raw({ type: '*/*', limit: '30mb' }),
    asyncHandler(async (req, res) => {
      const row = db.getRecording(req.params.id);
      if (!row) {
        res.status(404).json({ error: 'Recording not found.' });
        return;
      }
      if (row.started_by_email !== req.session.staff.email) {
        res.status(403).json({ error: 'Only the specialist who started this recording can upload it.' });
        return;
      }
      const bytes = await recordings.saveChunk({ recording: row, buffer: req.body });
      res.json({ ok: true, bytes });
    }),
  );

  app.post(
    '/api/recordings/:id/poster',
    requireStaff,
    express.raw({ type: 'image/*', limit: '3mb' }),
    asyncHandler(async (req, res) => {
      const row = db.getRecording(req.params.id);
      if (!row) {
        res.status(404).json({ error: 'Recording not found.' });
        return;
      }
      if (row.started_by_email !== req.session.staff.email) {
        res.status(403).json({ error: 'Forbidden.' });
        return;
      }
      await recordings.savePoster(row, req.body);
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/recordings/:id/finish',
    requireStaff,
    asyncHandler(async (req, res) => {
      const row = await recordings.finishRecording(req.params.id, {
        actorEmail: req.session.staff.email,
      });
      if (row?.room_id) db.linkInventoryRecording(row.room_id, row.id);
      res.json({ recording: recordings.serialize(row) });
    }),
  );

  app.post(
    '/api/recordings/:id/abort',
    requireStaff,
    asyncHandler(async (req, res) => {
      const row = await recordings.abortRecording(req.params.id, req.session.staff.email);
      res.json({ recording: recordings.serialize(row) });
    }),
  );

  app.get('/api/recordings', requireStaff, (req, res) => {
    const rows = db.listRecordings().filter((row) => recordingAllowed(req.staff, row));
    res.json({ recordings: rows.map(recordings.serialize) });
  });

  app.get(
    '/api/recordings/:id/poster',
    requireStaff,
    (req, res) => {
      const row = recordingAllowed(req.staff, db.getRecording(req.params.id));
      const file = row?.poster_key ? posterPath(row.poster_key) : null;
      if (!file) {
        res.status(404).end();
        return;
      }
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      fs.createReadStream(file).pipe(res);
    },
  );

  app.get(
    '/api/recordings/:id/file',
    requireStaff,
    asyncHandler(async (req, res) => {
      const row = recordingAllowed(req.staff, db.getRecording(req.params.id));
      if (!row || row.status !== 'ready' || !row.storage_key) {
        res.status(404).json({ error: 'Recording is not ready.' });
        return;
      }
      const filename = `${row.customer_name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'walkthrough'}-${row.room_id}.${row.extension || 'webm'}`;
      const disposition = req.query.download === '1' ? 'attachment' : 'inline';
      res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', row.mime || 'video/webm');
      res.setHeader('Cache-Control', 'private, no-store');

      if (row.storage === 's3') {
        try {
          const out = await openS3(row, req.headers.range);
          if (req.headers.range) res.status(206);
          if (out.ContentRange) res.setHeader('Content-Range', out.ContentRange);
          if (out.ContentLength != null) res.setHeader('Content-Length', String(out.ContentLength));
          out.Body.on('error', () => res.destroy());
          res.on('close', () => out.Body.destroy?.());
          out.Body.pipe(res);
        } catch (err) {
          console.error(err);
          if (!res.headersSent) res.status(404).json({ error: 'Recording file is missing.' });
        }
        return;
      }

      const local = openLocal(row);
      if (!local) {
        res.status(404).json({ error: 'Recording file is missing.' });
        return;
      }
      const range = parseRange(req.headers.range, local.size);
      if (range?.invalid) {
        res.status(416).setHeader('Content-Range', `bytes */${local.size}`).end();
        return;
      }
      if (!range) {
        res.status(200);
        res.setHeader('Content-Length', local.size);
        const stream = fs.createReadStream(local.file);
        stream.on('error', () => res.destroy());
        res.on('close', () => stream.destroy());
        stream.pipe(res);
        return;
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${local.size}`);
      res.setHeader('Content-Length', range.end - range.start + 1);
      const stream = fs.createReadStream(local.file, { start: range.start, end: range.end });
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    }),
  );

  app.delete(
    '/api/recordings/:id',
    requireStaff,
    asyncHandler(async (req, res) => {
      const row = recordingAllowed(req.staff, db.getRecording(req.params.id));
      if (!row) {
        res.status(404).json({ error: 'Recording not found.' });
        return;
      }
      if (req.staff.role === 'owner') {
        res.status(403).json({
          error: 'Confirm this delete with the text code sent to the owner phone.',
          code: 'mfa_required',
        });
        return;
      }
      const ok = await recordings.deleteRecording(row.id);
      if (!ok) {
        res.status(404).json({ error: 'Recording not found.' });
        return;
      }
      db.addAudit(req.staff.email, 'recording.delete', row.id);
      res.json({ ok: true });
    }),
  );

  registerAdminRoutes(app);
  registerInventoryRoutes(app);

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });
}
