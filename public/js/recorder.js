import { api } from './api.js';

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  const types = [
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm',
    'video/mp4',
  ];
  return types.find((type) => MediaRecorder.isTypeSupported(type)) || null;
}

function initials(label) {
  const cleaned = label.replace(/\(.*\)/, '').trim();
  const parts = cleaned.split(/\s+/).slice(0, 2);
  const letters = parts.map((part) => part[0] || '').join('').toUpperCase();
  return letters || '?';
}

function cover(ctx, video, box) {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return false;
  const scale = Math.max(box.w / width, box.h / height);
  const dw = width * scale;
  const dh = height * scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.w, box.h);
  ctx.clip();
  ctx.drawImage(video, box.x + (box.w - dw) / 2, box.y + (box.h - dh) / 2, dw, dh);
  ctx.restore();
  return true;
}

function cells(count, width, height) {
  if (count <= 1) return [{ x: 0, y: 0, w: width, h: height }];
  const cols = count === 2 ? 2 : 2;
  const rows = Math.ceil(count / cols);
  const w = width / cols;
  const h = height / rows;
  return Array.from({ length: count }, (_, index) => ({
    x: (index % cols) * w,
    y: Math.floor(index / cols) * h,
    w,
    h,
  }));
}

export class CallRecorder {
  constructor(options) {
    this.roomId = options.roomId;
    this.customerName = options.customerName;
    this.participantId = options.participantId;
    this.getLocalStream = options.getLocalStream;
    this.onChange = options.onChange || (() => {});
    this.onError = options.onError || (() => {});
    this.active = false;
    this.id = null;
    this.audioIds = new Set();
    this.queue = Promise.resolve();
    this.failed = false;
  }

  prime() {
    if (!this.audioCtx) this.audioCtx = new AudioContext();
    this.audioCtx.resume().catch(() => {});
  }

  attachAudioTrack(track) {
    if (!track || track.kind !== 'audio' || !this.dest || this.audioIds.has(track.id)) return;
    this.audioIds.add(track.id);
    try {
      const source = this.audioCtx.createMediaStreamSource(new MediaStream([track]));
      source.connect(this.dest);
      this.sources.push(source);
    } catch (err) {
      console.warn('Could not mix an audio track', err);
    }
  }

  async toggle() {
    if (this.active) return this.stop();
    this.prime();
    await this.start();
  }

  async start() {
    const mime = pickMime();
    if (!mime) throw new Error('This browser can’t record video. Use Chrome, Edge, Firefox, or Safari.');
    this.prime();
    this.sources = [];
    this.audioIds = new Set();
    this.dest = this.audioCtx.createMediaStreamDestination();
    const local = this.getLocalStream();
    local?.getAudioTracks().forEach((track) => this.attachAudioTrack(track));
    document.querySelectorAll('.remote-tile video').forEach((video) => {
      const stream = video.srcObject;
      stream?.getAudioTracks?.().forEach((track) => this.attachAudioTrack(track));
    });

    this.canvas = document.createElement('canvas');
    this.canvas.width = 1280;
    this.canvas.height = 720;
    this.canvas.className = 'record-canvas';
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    document.body.appendChild(this.canvas);
    this.running = true;
    this.draw();
    this.timer = setInterval(() => this.draw(), 1000 / 15);

    const canvasStream = this.canvas.captureStream(15);
    const mixed = new MediaStream();
    canvasStream.getVideoTracks().forEach((track) => mixed.addTrack(track));
    this.dest.stream.getAudioTracks().forEach((track) => mixed.addTrack(track));
    if (!mixed.getVideoTracks().length) throw new Error('Could not start the recording picture.');

    this.mediaRecorder = new MediaRecorder(mixed, {
      mimeType: mime,
      videoBitsPerSecond: 1_000_000,
      audioBitsPerSecond: 96_000,
    });
    this.mediaRecorder.onerror = () => this.onError('The recorder hit an error.');
    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size) this.enqueue(event.data);
    };

    const created = await api('/api/recordings/start', {
      method: 'POST',
      body: { roomId: this.roomId, participantId: this.participantId, mime },
    });
    this.id = created.recording.id;
    this.startedAt = Date.now();
    try {
      this.mediaRecorder.start(1000);
    } catch (err) {
      await api(`/api/recordings/${this.id}/abort`, { method: 'POST' }).catch(() => {});
      this.cleanup();
      throw err;
    }
    this.active = true;
    this.onChange();
    this.posterTimer = setTimeout(() => this.capturePoster(), 1200);
    this.limitTimer = setTimeout(() => {
      if (this.active) {
        this.onError('The two-hour recording limit was reached. Saving now.');
        this.stop().catch(() => {});
      }
    }, 2 * 60 * 60 * 1000);
  }

  enqueue(blob) {
    if (!this.id || this.closed) return;
    this.queue = this.queue.then(() => this.upload(blob)).catch((err) => {
      this.failed = true;
      this.onError(err.message || 'A piece of the recording failed to upload.');
    });
  }

  async upload(blob) {
    let last = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(`/api/recordings/${this.id}/chunk`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: blob,
        });
        if (response.ok) return;
        if (response.status === 409) {
          this.closed = true;
          return;
        }
        last = new Error('Upload failed');
      } catch (err) {
        last = err;
      }
      await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
    }
    throw last || new Error('Upload failed');
  }

  capturePoster() {
    if (!this.canvas || !this.id) return;
    this.canvas.toBlob(async (blob) => {
      if (!blob) return;
      await fetch(`/api/recordings/${this.id}/poster`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'image/jpeg' },
        body: blob,
      }).catch(() => {});
    }, 'image/jpeg', 0.85);
  }

  draw() {
    if (!this.running || !this.ctx) return;
    const ctx = this.ctx;
    const width = this.canvas.width;
    const height = this.canvas.height;
    ctx.fillStyle = '#14241c';
    ctx.fillRect(0, 0, width, height);

    const tiles = [];
    document.querySelectorAll('.remote-tile video').forEach((video) => {
      tiles.push({ video, label: video.dataset.label || 'Guest' });
    });
    const local = document.querySelector('#local-video');
    if (local) tiles.push({ video: local, label: local.dataset.label || 'Specialist' });
    const layout = cells(Math.max(tiles.length, 1), width, height);
    const list = tiles.length ? tiles : [{ video: null, label: 'Waiting' }];

    list.forEach((tile, index) => {
      const box = layout[index];
      ctx.fillStyle = '#1d3127';
      ctx.fillRect(box.x, box.y, box.w, box.h);
      const cameraOff = tile.video?.dataset.camera === 'off';
      let drew = false;
      if (tile.video && !cameraOff && tile.video.readyState >= 2) {
        try {
          drew = cover(ctx, tile.video, box);
        } catch {
          drew = false;
        }
      }
      if (!drew) {
        ctx.fillStyle = '#c4923a';
        ctx.font = '600 64px Outfit, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(initials(tile.label), box.x + box.w / 2, box.y + box.h / 2);
      }
      ctx.fillStyle = 'rgba(12, 20, 16, 0.62)';
      ctx.fillRect(box.x, box.y + box.h - 64, box.w, 64);
      ctx.fillStyle = '#f4efe6';
      ctx.font = '600 28px Outfit, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(tile.label, box.x + 24, box.y + box.h - 24);
    });

    ctx.fillStyle = 'rgba(12, 20, 16, 0.45)';
    ctx.fillRect(0, 0, width, 72);
    ctx.fillStyle = '#f4efe6';
    ctx.font = '600 28px Outfit, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('MoveSafe Relocation', 28, 46);
    ctx.fillStyle = '#f0d7a2';
    ctx.font = '500 22px Outfit, sans-serif';
    ctx.textAlign = 'right';
    const stamp = new Date().toLocaleString();
    const who = this.customerName ? `${this.customerName} · ${this.roomId}` : this.roomId;
    ctx.fillText(`${who} · ${stamp}`, width - 28, 46);
  }

  async stop() {
    if (!this.active && !this.mediaRecorder) return null;
    this.active = false;
    this.saving = true;
    this.onChange();
    const recorder = this.mediaRecorder;
    if (recorder && recorder.state !== 'inactive') {
      await new Promise((resolve) => {
        recorder.addEventListener('stop', resolve, { once: true });
        recorder.stop();
      });
    }
    await this.queue;
    let saved = null;
    if (this.id && !this.closed) {
      saved = await api(`/api/recordings/${this.id}/finish`, { method: 'POST' });
    }
    this.cleanup();
    return saved;
  }

  beaconFinish() {
    if (!this.id || this.closed) return;
    try {
      if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') this.mediaRecorder.stop();
    } catch {
      /* the page is going away */
    }
    navigator.sendBeacon(`/api/recordings/${this.id}/finish`);
    this.closed = true;
  }

  cleanup() {
    this.running = false;
    this.active = false;
    clearInterval(this.timer);
    clearTimeout(this.posterTimer);
    clearTimeout(this.limitTimer);
    this.sources?.forEach((source) => {
      try {
        source.disconnect();
      } catch {
        /* already disconnected */
      }
    });
    this.canvas?.remove();
    this.canvas = null;
    this.ctx = null;
    this.mediaRecorder = null;
    this.saving = false;
    this.onChange();
  }
}
