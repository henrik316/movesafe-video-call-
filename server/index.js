import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { isProduction, loadEnv } from './env.js';
import * as db from './db.js';
import { storageMode } from './storage.js';
import { attachSignaling, setAbandonHandler } from './signaling.js';
import { finalizeAbandoned, purgeExpired, setIo } from './recordings.js';
import { registerRoutes } from './routes.js';

loadEnv();

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

if (isProduction()) {
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 16) {
    console.error('Set SESSION_SECRET to a long random string in production.');
    process.exit(1);
  }
}

let staff;
try {
  staff = db.seedStaff();
  storageMode();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
db.pruneSessions();

class SqliteSessionStore extends session.Store {
  get(sid, callback) {
    try {
      const row = db.getSession(sid);
      if (!row) {
        callback(null, null);
        return;
      }
      if (row.expires && Date.parse(row.expires) < Date.now()) {
        db.deleteSession(sid);
        callback(null, null);
        return;
      }
      callback(null, JSON.parse(row.data));
    } catch (err) {
      callback(err);
    }
  }

  set(sid, sess, callback) {
    try {
      const expires = sess.cookie?.expires ? new Date(sess.cookie.expires).toISOString() : null;
      db.saveSession(sid, JSON.stringify(sess), expires);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  destroy(sid, callback) {
    try {
      db.deleteSession(sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  touch(sid, sess, callback) {
    this.set(sid, sess, callback);
  }
}

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
  next();
});

const sessionMiddleware = session({
  name: 'movesafe.sid',
  store: new SqliteSessionStore(),
  secret: process.env.SESSION_SECRET || 'dev-only-movesafe-secret',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: 16 * 60 * 60 * 1000,
    path: '/',
  },
});

app.use(sessionMiddleware);
app.use(express.json({ limit: '1mb' }));

registerRoutes(app);

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
app.use(express.static(publicDir, { index: 'index.html' }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) {
    next();
    return;
  }
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong.' : err.message });
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  maxHttpBufferSize: 1_000_000,
});
io.engine.use(sessionMiddleware);
setIo(io);
setAbandonHandler((recordingId) => {
  finalizeAbandoned(recordingId).catch((err) => console.error(err));
});
attachSignaling(io);

await purgeExpired();
setInterval(() => {
  db.pruneSessions();
  purgeExpired().catch((err) => console.error(err));
}, 60 * 60 * 1000).unref();

httpServer.listen(port, host, () => {
  console.log(`MoveSafe video desk at http://localhost:${port}`);
  console.log(`Storage: ${storageMode()} · data in ${process.env.DATA_DIR || './data'}`);
  console.log(`Staff accounts: ${staff.map((user) => user.email).join(', ')}`);
  if (isProduction() && process.env.COOKIE_SECURE !== 'true') {
    console.warn('COOKIE_SECURE is not true. Set it when the site is served over HTTPS.');
  }
});
