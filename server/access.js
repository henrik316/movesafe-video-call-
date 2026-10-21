import * as db from './db.js';

export function actor(req) {
  const sessionUser = req.session?.staff;
  if (!sessionUser?.email) return null;
  const row = db.getStaff(sessionUser.email);
  if (!row || !row.active) return null;
  if (Number(row.session_version) !== Number(sessionUser.sessionVersion)) return null;
  return {
    email: row.email,
    name: row.name,
    role: row.role,
    active: Boolean(row.active),
    sessionVersion: row.session_version,
  };
}

export function requireStaff(req, res, next) {
  const user = actor(req);
  if (!user) {
    res.status(401).json({ error: 'Staff login required.' });
    return;
  }
  req.staff = user;
  next();
}

export function requireOwner(req, res, next) {
  const user = actor(req);
  if (!user || user.role !== 'owner') {
    res.status(403).json({ error: 'Owner access required.' });
    return;
  }
  req.staff = user;
  next();
}

export function canAccessRoom(user, room) {
  if (!user || !room) return false;
  if (user.role === 'owner') return true;
  return room.created_by_email === user.email;
}

export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function httpError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

export function clean(value, max) {
  return String(value || '')
    .replace(/[\u0000-\u001F]/g, '')
    .trim()
    .slice(0, max);
}

export function publicUser(user) {
  return { email: user.email, name: user.name, role: user.role };
}

export function startSession(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) {
        reject(err);
        return;
      }
      req.session.staff = {
        email: user.email,
        name: user.name,
        role: user.role,
        sessionVersion: user.session_version,
      };
      req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
    });
  });
}
