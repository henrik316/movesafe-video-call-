import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { dataDir, loadEnv } from './env.js';

loadEnv();

function recordingsDir() {
  const dir = path.join(dataDir(), 'recordings');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function postersDir() {
  const dir = path.join(dataDir(), 'posters');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function storageMode() {
  const mode = (process.env.STORAGE || 'local').toLowerCase();
  if (mode !== 'local' && mode !== 's3') {
    throw new Error('STORAGE must be "local" or "s3".');
  }
  if (mode === 's3' && !process.env.S3_BUCKET) {
    throw new Error('STORAGE=s3 requires S3_BUCKET.');
  }
  return mode;
}

export function localRecordingPath(key) {
  const base = path.basename(key || '');
  if (!base || base !== key) throw new Error('Invalid recording key.');
  return path.join(recordingsDir(), base);
}

const chains = new Map();

function enqueue(id, fn) {
  const prev = chains.get(id) || Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(id, next);
  return next;
}

export function appendChunk(id, extension, buffer) {
  return enqueue(id, async () => {
    const file = localRecordingPath(`${id}.${extension}`);
    await fs.promises.appendFile(file, buffer);
    const stat = await fs.promises.stat(file);
    return stat.size;
  });
}

export function writePoster(id, buffer) {
  const key = `${id}.jpg`;
  fs.writeFileSync(path.join(postersDir(), key), buffer);
  return key;
}

export function posterPath(key) {
  const base = path.basename(key || '');
  if (!base || base !== key) return null;
  const full = path.join(postersDir(), base);
  return fs.existsSync(full) ? full : null;
}

function runFile(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
      resolve({ ok: !err, stdout: stdout || '', err });
    });
  });
}

let ffmpegPromise;
function hasFfmpeg() {
  if (!ffmpegPromise) {
    ffmpegPromise = runFile('ffmpeg', ['-version'], 4000).then((result) => result.ok);
  }
  return ffmpegPromise;
}

async function probeDuration(file) {
  const result = await runFile(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    8000,
  );
  if (!result.ok) return null;
  const value = Number.parseFloat(result.stdout.trim());
  return Number.isFinite(value) ? value : null;
}

async function maybeTranscode(file, extension) {
  const mode = (process.env.TRANSCODE || 'auto').toLowerCase();
  if (mode === 'off' || extension !== 'webm') return null;
  if (!(await hasFfmpeg())) return null;
  const mp4 = file.replace(/\.webm$/, '.mp4');
  const result = await runFile(
    'ffmpeg',
    [
      '-y',
      '-i',
      file,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      mp4,
    ],
    10 * 60 * 1000,
  );
  if (!result.ok || !fs.existsSync(mp4) || fs.statSync(mp4).size < 1000) {
    if (fs.existsSync(mp4)) fs.unlinkSync(mp4);
    console.warn('ffmpeg transcode skipped or failed; keeping WebM.');
    return null;
  }
  fs.unlinkSync(file);
  return mp4;
}

let s3Client;
async function s3() {
  if (!s3Client) {
    const { S3Client } = await import('@aws-sdk/client-s3');
    s3Client = new S3Client({
      region: process.env.S3_REGION || 'us-east-1',
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    });
  }
  return s3Client;
}

async function uploadToS3(file, key, contentType) {
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const stat = fs.statSync(file);
  const client = await s3();
  await client.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Body: fs.createReadStream(file),
      ContentLength: stat.size,
      ContentType: contentType,
    }),
  );
  return stat.size;
}

export async function finalizeFile(recording) {
  const extension = recording.extension || 'webm';
  let file = localRecordingPath(recording.storage_key || `${recording.id}.${extension}`);
  let bytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
  let mime = recording.mime || (extension === 'mp4' ? 'video/mp4' : 'video/webm');
  let ext = extension;
  let key = path.basename(file);

  if (bytes > 0 && ext === 'webm') {
    const transcoded = await maybeTranscode(file, ext);
    if (transcoded) {
      file = transcoded;
      ext = 'mp4';
      mime = 'video/mp4';
      key = path.basename(file);
      bytes = fs.statSync(file).size;
    }
  }

  const duration = bytes > 0 ? await probeDuration(file) : null;
  let storage = 'local';

  if (bytes > 0 && storageMode() === 's3') {
    const objectKey = `recordings/${key}`;
    try {
      await uploadToS3(file, objectKey, mime);
      fs.unlinkSync(file);
      storage = 's3';
      key = objectKey;
    } catch (err) {
      console.error('S3 upload failed; recording kept on local disk.', err);
      storage = 'local';
      key = path.basename(file);
    }
  }

  return { bytes, storage, storageKey: key, mime, extension: ext, durationSec: duration };
}

export async function removeStored(recording) {
  if (!recording) return;
  if (recording.storage === 's3' && recording.storage_key) {
    try {
      const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
      const client = await s3();
      await client.send(
        new DeleteObjectCommand({
          Bucket: process.env.S3_BUCKET,
          Key: recording.storage_key,
        }),
      );
    } catch (err) {
      console.error('S3 delete failed', err);
    }
  } else if (recording.storage_key && !String(recording.storage_key).includes('/')) {
    const file = localRecordingPath(recording.storage_key);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  if (recording.poster_key) {
    const poster = posterPath(recording.poster_key);
    if (poster) fs.unlinkSync(poster);
  }
}

export function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return { invalid: true };
  let start = match[1] ? Number(match[1]) : null;
  let end = match[2] ? Number(match[2]) : null;
  if (start == null && end != null) {
    start = Math.max(size - end, 0);
    end = size - 1;
  } else {
    start = start ?? 0;
    end = end == null ? size - 1 : end;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return { invalid: true };
  }
  return { start, end: Math.min(end, size - 1) };
}

export function openLocal(recording) {
  const file = localRecordingPath(recording.storage_key);
  if (!fs.existsSync(file)) return null;
  return { file, size: fs.statSync(file).size };
}

export async function openS3(recording, rangeHeader) {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const client = await s3();
  const out = await client.send(
    new GetObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: recording.storage_key,
      Range: rangeHeader || undefined,
    }),
  );
  return out;
}
