import crypto from 'node:crypto';
import * as db from './db.js';
import { isProduction } from './env.js';

const CODE_TTL_MS = 8 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const SEND_WINDOW_MS = 10 * 60 * 1000;
const MAX_SENDS = 5;

export function phoneHint() {
  const digits = String(process.env.OWNER_PHONE || '').replace(/\D/g, '');
  if (digits.length < 4) return null;
  return digits.slice(-4);
}

export function smsConfigured() {
  return Boolean(
    process.env.OWNER_PHONE
    && process.env.TWILIO_ACCOUNT_SID
    && process.env.TWILIO_AUTH_TOKEN
    && process.env.TWILIO_FROM,
  );
}

function pepper() {
  return process.env.SESSION_SECRET || 'dev-only-movesafe-secret';
}

function hashCode(code, id) {
  return crypto.createHash('sha256').update(`${code}:${id}:${pepper()}`).digest('hex');
}

function codesMatch(code, id, expectedHash) {
  const actual = hashCode(code, id);
  const left = Buffer.from(actual);
  const right = Buffer.from(String(expectedHash || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function assertReady() {
  if (smsConfigured()) return;
  if (isProduction()) {
    const error = new Error('SMS is not configured. Set OWNER_PHONE and the Twilio variables before this step.');
    error.status = 409;
    throw error;
  }
}

async function deliver(code, purpose) {
  assertReady();
  const hint = phoneHint();
  if (smsConfigured()) {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const body = new URLSearchParams({
      To: process.env.OWNER_PHONE,
      From: process.env.TWILIO_FROM,
      Body: `MoveSafe verification code: ${code}. It expires in 8 minutes.`,
    });
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!response.ok) {
      console.error(`[movesafe] Twilio SMS failed with status ${response.status}`);
      const error = new Error('The text message could not be sent.');
      error.status = 502;
      throw error;
    }
    return { devSms: false, phoneHint: hint };
  }
  console.log(`[movesafe] DEV MODE: SMS was not sent. Purpose ${purpose}. Code ${code}. Phone ending ${hint || 'unset'}. Configure Twilio to text the owner.`);
  if (!isProduction() && process.env.SMS_CAPTURE_FILE) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.SMS_CAPTURE_FILE, `${JSON.stringify({ purpose, code, at: new Date().toISOString() })}\n`);
  }
  return { devSms: true, phoneHint: hint };
}

export async function beginChallenge({ purpose, actorEmail, payload }) {
  const recent = db.countRecentChallenges(new Date(Date.now() - SEND_WINDOW_MS).toISOString());
  if (recent >= MAX_SENDS) {
    const error = new Error('Too many text messages were requested. Wait a few minutes and try again.');
    error.status = 429;
    throw error;
  }
  const id = crypto.randomBytes(16).toString('hex');
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  const sent = await deliver(code, purpose);
  const expires = new Date(Date.now() + CODE_TTL_MS).toISOString();
  db.insertChallenge({
    id,
    purpose,
    codeHash: hashCode(code, id),
    expiresAt: expires,
    maxAttempts: MAX_ATTEMPTS,
    actorEmail: actorEmail || null,
    payload,
  });
  return { challengeId: id, expiresAt: expires, devSms: sent.devSms, phoneHint: sent.phoneHint };
}

export function takeChallenge(id, code) {
  const row = db.getChallenge(id);
  if (!row || row.used_at) {
    const error = new Error('That code is no longer valid. Request a new one.');
    error.status = 400;
    throw error;
  }
  if (Date.parse(row.expires_at) < Date.now()) {
    const error = new Error('That code has expired. Request a new one.');
    error.status = 400;
    throw error;
  }
  if (row.attempts >= row.max_attempts) {
    const error = new Error('Too many incorrect codes. Request a new one.');
    error.status = 429;
    throw error;
  }
  if (!codesMatch(String(code || '').trim(), row.id, row.code_hash)) {
    db.addChallengeAttempt(row.id);
    const remaining = row.max_attempts - (row.attempts + 1);
    const error = new Error(remaining > 0 ? 'That code is incorrect.' : 'Too many incorrect codes. Request a new one.');
    error.status = remaining > 0 ? 401 : 429;
    throw error;
  }
  db.useChallenge(row.id);
  return {
    purpose: row.purpose,
    actorEmail: row.actor_email,
    payload: row.payload_json ? JSON.parse(row.payload_json) : {},
  };
}
