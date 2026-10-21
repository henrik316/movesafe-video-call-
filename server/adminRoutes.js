import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { DEFAULT_TRUCKS } from './catalog.js';
import { asyncHandler, clean, httpError, publicUser, requireOwner, startSession } from './access.js';
import * as db from './db.js';
import { sendInviteMail } from './mail.js';
import { readOffice } from './office.js';
import * as recordings from './recordings.js';
import { beginChallenge, smsConfigured, takeChallenge } from './sms.js';
import { demoMode, isProduction } from './env.js';
import { visionMode } from './vision.js';

const PURPOSES = new Set([
  'invite_create',
  'invite_resend',
  'invite_revoke',
  'staff_deactivate',
  'staff_remove',
  'settings_update',
  'recording_delete',
  'owner_password',
]);

function originOf(req) {
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
  return `${proto}://${req.get('host')}`;
}

function emailOf(value) {
  const email = clean(value, 120).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError('Enter a valid email address.', 400);
  return email;
}

function inviteStatus(row) {
  if (row.used_at) return 'used';
  if (row.revoked_at) return 'revoked';
  if (Date.parse(row.expires_at) < Date.now()) return 'expired';
  return 'pending';
}

function publicInvite(row) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: inviteStatus(row),
  };
}

async function issueInvite({ email, actorEmail, origin, company }) {
  if (db.getStaff(email)) throw httpError('That person already has an account.', 409);
  const token = crypto.randomBytes(24).toString('base64url');
  const id = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  db.createInvite({ id, email, createdBy: actorEmail, expiresAt });
  const link = `${origin}/invite/${token}`;
  let mailed = false;
  try {
    mailed = (await sendInviteMail({ to: email, link, company })).sent;
  } catch (err) {
    console.error(`[movesafe] Invite email failed: ${err.message}`);
  }
  db.addAudit(actorEmail, 'staff.invite', email);
  return { email, expiresAt, link, mailed, id };
}

function normalizeTrucks(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 12) {
    throw httpError('Add at least one truck size.', 400);
  }
  return value.map((truck) => {
    const name = clean(truck.name, 40);
    const cubicFeet = Number(truck.cubicFeet);
    if (name.length < 2 || !Number.isFinite(cubicFeet) || cubicFeet < 50 || cubicFeet > 5000) {
      throw httpError('Each truck needs a name and a capacity between 50 and 5000 cubic feet.', 400);
    }
    return { id: clean(truck.id, 20) || name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, cubicFeet };
  });
}

function normalizeOverrides(value) {
  if (!Array.isArray(value)) return [];
  return value.map((row) => {
    const key = clean(row.key, 40);
    const cubicFeet = Number(row.cubicFeet);
    if (!key || !Number.isFinite(cubicFeet) || cubicFeet < 0 || cubicFeet > 500) {
      throw httpError('Reference sizes must be between 0 and 500 cubic feet.', 400);
    }
    return { key, cubicFeet };
  }).slice(0, 200);
}

async function runPurpose(purpose, payload, req) {
  const office = readOffice();
  if (purpose === 'invite_create') {
    return issueInvite({
      email: payload.email,
      actorEmail: req.staff.email,
      origin: originOf(req),
      company: office.companyName,
    });
  }
  if (purpose === 'invite_resend') {
    const existing = db.getInvite(payload.inviteId);
    if (!existing || existing.used_at) throw httpError('That invite can no longer be resent.', 400);
    db.revokeInvite(existing.id);
    db.addAudit(req.staff.email, 'staff.invite.revoke', `${existing.email} replaced`);
    return issueInvite({
      email: existing.email,
      actorEmail: req.staff.email,
      origin: originOf(req),
      company: office.companyName,
    });
  }
  if (purpose === 'invite_revoke') {
    const existing = db.getInvite(payload.inviteId);
    if (!existing) throw httpError('Invite not found.', 404);
    db.revokeInvite(existing.id);
    db.addAudit(req.staff.email, 'staff.invite.revoke', existing.email);
    return { ok: true };
  }
  if (purpose === 'staff_deactivate' || purpose === 'staff_remove') {
    const person = db.getStaff(payload.email);
    if (!person || person.role === 'owner') throw httpError('That staff account cannot be changed.', 400);
    if (purpose === 'staff_remove') {
      db.deleteStaffAccount(person.email);
      db.addAudit(req.staff.email, 'staff.remove', person.email);
    } else {
      db.setStaffActive(person.email, false);
      db.addAudit(req.staff.email, 'staff.deactivate', person.email);
    }
    return { ok: true };
  }
  if (purpose === 'settings_update') {
    db.saveSettings({
      company_name: payload.companyName,
      tagline: payload.tagline,
      lbs_per_cuft: payload.lbsPerCuft,
      trucks_json: JSON.stringify(payload.trucks),
      catalog_json: JSON.stringify(payload.overrides),
    });
    db.addAudit(req.staff.email, 'settings.update', `weight ${payload.lbsPerCuft} lb/cu ft`);
    return readOffice();
  }
  if (purpose === 'recording_delete') {
    const row = db.getRecording(payload.recordingId);
    if (!row) throw httpError('Recording not found.', 404);
    const ok = await recordings.deleteRecording(row.id);
    if (!ok) throw httpError('Recording not found.', 404);
    db.addAudit(req.staff.email, 'recording.delete', `${row.id} ${row.customer_name}`);
    return { ok: true };
  }
  if (purpose === 'owner_password') {
    const updated = db.setStaffPassword(req.staff.email, payload.passwordHash);
    req.session.staff.sessionVersion = updated.session_version;
    await new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
    db.addAudit(req.staff.email, 'owner.password', 'password changed');
    return { ok: true };
  }
  throw httpError('Unknown verification purpose.', 400);
}

function preparePayload(purpose, body, staffRow) {
  if (purpose === 'invite_create') {
    return { email: emailOf(body.email) };
  }
  if (purpose === 'invite_resend' || purpose === 'invite_revoke') {
    const inviteId = clean(body.inviteId, 80);
    if (!inviteId) throw httpError('Choose an invite.', 400);
    return { inviteId };
  }
  if (purpose === 'staff_deactivate' || purpose === 'staff_remove') {
    return { email: emailOf(body.email) };
  }
  if (purpose === 'recording_delete') {
    const recordingId = clean(body.recordingId, 40);
    if (!recordingId) throw httpError('Choose a recording.', 400);
    return { recordingId };
  }
  if (purpose === 'settings_update') {
    const companyName = clean(body.companyName, 80);
    const tagline = clean(body.tagline, 140);
    const lbsPerCuft = Number(body.lbsPerCuft);
    if (companyName.length < 2) throw httpError('Enter the company name.', 400);
    if (!Number.isFinite(lbsPerCuft) || lbsPerCuft < 1 || lbsPerCuft > 30) {
      throw httpError('Weight per cubic foot must be between 1 and 30.', 400);
    }
    return {
      companyName,
      tagline,
      lbsPerCuft,
      trucks: normalizeTrucks(body.trucks || DEFAULT_TRUCKS),
      overrides: normalizeOverrides(body.overrides || []),
    };
  }
  if (purpose === 'owner_password') {
    return { currentPassword: String(body.currentPassword || ''), newPassword: String(body.newPassword || '') };
  }
  throw httpError('Unknown verification purpose.', 400);
}

export function registerAdminRoutes(app) {
  app.get('/api/admin/settings', requireOwner, (req, res) => {
    const office = readOffice();
    res.json({
      companyName: office.companyName,
      tagline: office.tagline,
      lbsPerCuft: office.lbsPerCuft,
      trucks: office.trucks,
      catalog: office.catalog.map((entry) => ({
        key: entry.key,
        name: entry.name,
        group: entry.group,
        cubicFeet: entry.cubicFeet,
        overridden: Boolean(entry.overridden),
      })),
      ai: visionMode(),
      smsConfigured: smsConfigured(),
      smsDev: !isProduction() && !smsConfigured(),
      mailConfigured: Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM),
      demoMode: demoMode() && !process.env.OWNER_EMAIL,
    });
  });

  app.get('/api/admin/staff', requireOwner, (req, res) => {
    res.json({
      staff: db.listStaff().map((person) => ({
        email: person.email,
        name: person.name,
        role: person.role,
        active: Boolean(person.active),
        createdAt: person.created_at,
      })),
    });
  });

  app.get('/api/admin/invites', requireOwner, (req, res) => {
    res.json({ invites: db.listInvites().map(publicInvite) });
  });

  app.get('/api/admin/audit', requireOwner, (req, res) => {
    res.json({
      entries: db.listAudit().map((row) => ({
        id: row.id,
        at: row.at,
        actorEmail: row.actor_email,
        action: row.action,
        detail: row.detail,
      })),
    });
  });

  app.get('/api/admin/recordings', requireOwner, (req, res) => {
    res.json({ recordings: db.listRecordings().map(recordings.serialize) });
  });

  app.post(
    '/api/admin/challenges',
    requireOwner,
    asyncHandler(async (req, res) => {
      const purpose = clean(req.body?.purpose, 40);
      if (!PURPOSES.has(purpose)) throw httpError('Unknown verification purpose.', 400);
      let payload = preparePayload(purpose, req.body || {}, req.staff);
      if (purpose === 'owner_password') {
        const row = db.getStaff(req.staff.email);
        const match = await bcrypt.compare(payload.currentPassword, row.password_hash);
        if (!match) throw httpError('Current password is incorrect.', 401);
        if (payload.newPassword.length < 10) throw httpError('Use at least 10 characters.', 400);
        payload = { passwordHash: await bcrypt.hash(payload.newPassword, 10) };
      }
      if (purpose === 'invite_create' && db.getStaff(payload.email)) {
        throw httpError('That person already has an account.', 409);
      }
      const challenge = await beginChallenge({ purpose, actorEmail: req.staff.email, payload });
      res.json(challenge);
    }),
  );

  app.post(
    '/api/admin/challenges/:id/confirm',
    requireOwner,
    asyncHandler(async (req, res) => {
      const taken = takeChallenge(req.params.id, req.body?.code);
      if (taken.purpose === 'owner_login' || taken.actorEmail !== req.staff.email) {
        throw httpError('That code is no longer valid.', 400);
      }
      const result = await runPurpose(taken.purpose, taken.payload, req);
      res.json(result);
    }),
  );

  app.post(
    '/api/setup',
    asyncHandler(async (req, res) => {
      if (db.listStaff().some((person) => person.role === 'owner')) {
        throw httpError('Owner setup is already complete.', 404);
      }
      const token = String(req.body?.token || '');
      const password = String(req.body?.password || '');
      if (!process.env.OWNER_EMAIL) throw httpError('Set OWNER_EMAIL before using the setup token.', 400);
      const email = process.env.OWNER_EMAIL.trim().toLowerCase();
      if (password.length < 10) throw httpError('Use at least 10 characters.', 400);
      if (isProduction() && password === 'walkthrough-demo') throw httpError('Choose a different password.', 400);
      if (!db.consumeSetupToken(token)) throw httpError('That setup token is not valid.', 400);
      const name = clean(req.body?.name, 80) || process.env.OWNER_NAME || 'Owner';
      db.insertStaffAccount({ email, name, passwordHash: await bcrypt.hash(password, 10) });
      const owner = db.markOwner(email);
      db.addAudit(owner.email, 'owner.setup', 'owner account created');
      await startSession(req, owner);
      res.json(publicUser(owner));
    }),
  );

  app.get('/api/setup', (req, res) => {
    res.json({ open: db.setupOpen() });
  });

  app.get('/api/invites/:token', (req, res) => {
    const id = crypto.createHash('sha256').update(String(req.params.token || '')).digest('hex');
    const invite = db.getInvite(id);
    const status = invite ? inviteStatus(invite) : 'missing';
    if (status !== 'pending') {
      res.status(400).json({ error: status === 'expired' ? 'This invite has expired.' : status === 'used' ? 'This invite was already used.' : 'This invite is not valid.' });
      return;
    }
    res.json({ email: invite.email, expiresAt: invite.expires_at });
  });

  app.post(
    '/api/invites/:token',
    asyncHandler(async (req, res) => {
      const id = crypto.createHash('sha256').update(String(req.params.token || '')).digest('hex');
      const invite = db.getInvite(id);
      const status = invite ? inviteStatus(invite) : 'missing';
      if (status !== 'pending') {
        throw httpError(status === 'expired' ? 'This invite has expired.' : status === 'used' ? 'This invite was already used.' : 'This invite is not valid.', 400);
      }
      if (invite.role !== 'staff') throw httpError('This invite is not valid.', 400);
      const password = String(req.body?.password || '');
      const name = clean(req.body?.name, 80);
      if (name.length < 2) throw httpError('Enter your name.', 400);
      if (password.length < 10) throw httpError('Use at least 10 characters.', 400);
      if (db.getStaff(invite.email)) throw httpError('That person already has an account.', 409);
      const user = db.insertStaffAccount({
        email: invite.email,
        name,
        passwordHash: await bcrypt.hash(password, 10),
      });
      db.markInviteUsed(invite.id);
      db.addAudit(invite.created_by, 'staff.joined', invite.email);
      await startSession(req, user);
      res.json(publicUser(user));
    }),
  );
}
