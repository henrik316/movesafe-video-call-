import fs from 'node:fs';
import path from 'node:path';

let loaded = false;

export function loadEnv() {
  if (loaded) return;
  loaded = true;
  const file = path.join(process.cwd(), '.env');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === '') {
      process.env[key] = value;
    }
  }
}

export function dataDir() {
  loadEnv();
  return path.resolve(process.cwd(), process.env.DATA_DIR || 'data');
}

export function isProduction() {
  return process.env.NODE_ENV === 'production';
}

export function demoMode() {
  if (isProduction()) return false;
  if (process.env.DEMO_MODE === 'false') return false;
  return true;
}

export function showDemoBanner() {
  if (isProduction()) return false;
  if (process.env.SHOW_DEMO_BANNER === 'false') return false;
  if (process.env.OWNER_EMAIL) return false;
  if (process.env.SHOW_DEMO_BANNER === 'true') return true;
  return demoMode();
}
