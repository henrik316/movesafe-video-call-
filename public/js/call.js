import { api, currentStaff } from './api.js';
import { brand, el, toast } from './dom.js';
import { icon } from './icons.js';
import { copyText, formatClock, formatCode, routeLabel } from './format.js';
import { CallRecorder } from './recorder.js';

function mediaError(err) {
  if (err?.name === 'NotAllowedError') {
    return 'Allow the camera and microphone in the browser prompt, then try again.';
  }
  if (err?.name === 'NotFoundError') return 'No camera or microphone was found on this device.';
  return err?.message || 'Could not start the camera and microphone.';
}

function participantId() {
  const key = 'movesafe-participant';
  let id = sessionStorage.getItem(key);
  if (!id || !/^[A-Za-z0-9-]{8,80}$/.test(id)) {
    id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
  }
  return id;
}

class PeerLink {
  constructor(call, info, { initiator }) {
    this.call = call;
    this.id = info.id;
    this.name = info.name;
    this.isStaff = info.isStaff;
    this.initiator = initiator;
    this.polite = !initiator;
    this.pc = new RTCPeerConnection({ iceServers: call.iceServers });
    this.stream = new MediaStream();
    this.pending = [];
    this.makingOffer = false;
    this.pc.onicecandidate = (event) => {
      if (event.candidate) this.call.sendSignal(this.id, { candidate: event.candidate });
    };
    this.pc.ontrack = (event) => {
      if (!this.stream.getTrackById(event.track.id)) this.stream.addTrack(event.track);
      this.attach();
      if (event.track.kind === 'audio') this.call.recorder?.attachAudioTrack(event.track);
      event.track.onunmute = () => this.attach();
    };
    this.pc.onconnectionstatechange = () => {
      this.call.updateTileStatus(this);
      if (this.pc.connectionState === 'failed' && this.initiator) this.restart().catch(() => {});
    };
    for (const track of call.localStream.getTracks()) {
      this.pc.addTrack(track, call.localStream);
    }
  }

  update(info) {
    this.name = info.name;
    this.isStaff = info.isStaff;
    if (this.video) {
      this.video.dataset.label = this.call.tileLabel(this);
    }
    const name = this.call.root.querySelector(`[data-name-for="${this.id}"]`);
    if (name) name.textContent = this.name;
  }

  attach() {
    if (!this.video) return;
    if (this.video.srcObject !== this.stream) this.video.srcObject = this.stream;
    this.video.play().catch(() => this.call.showTapForSound());
  }

  async makeOffer() {
    if (this.makingOffer) return;
    this.makingOffer = true;
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.call.sendSignal(this.id, { sdp: this.pc.localDescription });
      if (this.queuedAnswer) {
        const answer = this.queuedAnswer;
        this.queuedAnswer = null;
        await this.handleSignal(answer);
      }
    } finally {
      this.makingOffer = false;
    }
  }

  async restart() {
    if (this.restarting) return;
    this.restarting = true;
    try {
      this.makingOffer = true;
      const offer = await this.pc.createOffer({ iceRestart: true });
      await this.pc.setLocalDescription(offer);
      this.call.sendSignal(this.id, { sdp: this.pc.localDescription });
    } catch (err) {
      console.warn(err);
    } finally {
      this.makingOffer = false;
      this.restarting = false;
    }
  }

  async handleSignal(data) {
    try {
      if (data.sdp) {
        const collision = data.sdp.type === 'offer' && (this.makingOffer || this.pc.signalingState !== 'stable');
        if (collision && !this.polite) return;
        if (collision && this.polite) {
          await this.pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
        }
        if (data.sdp.type === 'answer' && this.pc.signalingState !== 'have-local-offer') {
          this.queuedAnswer = data;
          return;
        }
        await this.pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          this.call.sendSignal(this.id, { sdp: this.pc.localDescription });
        }
        while (this.pending.length) {
          const candidate = this.pending.shift();
          await this.pc.addIceCandidate(candidate).catch(() => {});
        }
      } else if (data.candidate) {
        if (!this.pc.remoteDescription) this.pending.push(data.candidate);
        else await this.pc.addIceCandidate(data.candidate).catch(() => {});
      }
    } catch (err) {
      console.warn('Signal error', err);
    }
  }

  close() {
    this.pc.close();
    this.stream.getTracks().forEach((track) => track.stop());
  }
}

class CallSession {
  constructor(root, roomId) {
    this.root = root;
    this.roomId = roomId.toUpperCase();
    this.participantId = participantId();
    this.peers = new Map();
    this.signalQueue = new Map();
    this.useRear = false;
    this.micOn = true;
    this.camOn = true;
    this.destroyed = false;
    this.iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
    this.onBeforeUnload = (event) => {
      if (this.recorder?.active) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    this.onPageHide = () => {
      if (this.recorder?.active) this.recorder.beaconFinish();
    };
  }

  async open() {
    let pub;
    try {
      pub = await api(`/api/rooms/${this.roomId}/public`);
    } catch (err) {
      this.renderMissing(err.status === 404 ? err.message : 'Could not open this survey.');
      return;
    }
    this.room = pub.room;
    this.asGuest = new URLSearchParams(location.search).get('guest') === '1';
    this.me = this.asGuest ? null : await currentStaff();
    this.isStaff = Boolean(this.me);
    try {
      const ice = await api('/api/ice');
      if (ice.iceServers?.length) this.iceServers = ice.iceServers;
    } catch {
      /* stun fallback already set */
    }
    if (this.isStaff) {
      try {
        const full = await api(`/api/rooms/${this.roomId}`);
        this.room = { ...this.room, ...full.room };
      } catch {
        /* public details are enough to join */
      }
    }
    this.localName = this.isStaff ? this.me.name : this.room.customerName;
    document.title = `${this.room.customerName} · MoveSafe`;
    this.renderLobby();
  }

  renderMissing(message) {
    document.title = 'Link not found · MoveSafe';
    this.root.replaceChildren(
      el('main', { class: 'center-page' }, [
        brand('/'),
        el('h1', {}, 'This survey link is not valid'),
        el('p', { class: 'lede' }, message),
      ]),
    );
  }

  renderLobby() {
    const route = routeLabel(this.room.origin, this.room.destination);
    this.preview = el('video');
    this.preview.id = 'preview-video';
    this.preview.muted = true;
    this.preview.autoplay = true;
    this.preview.playsInline = true;
    this.preview.className = 'mirrored';
    this.error = el('p', { class: 'form-error', role: 'alert', hidden: true });
    this.enableBtn = el('button', { class: 'btn btn-primary', type: 'button', onclick: () => this.enableMedia() }, 'Enable camera and mic');
    this.flipBtn = el('button', { class: 'btn btn-ghost', type: 'button', disabled: true, onclick: () => this.flipCamera() }, 'Rear camera');
    this.joinBtn = el(
      'button',
      {
        class: 'btn btn-primary',
        type: 'button',
        disabled: true,
        onclick: () => this.enterCall(),
      },
      this.isStaff ? 'Enter survey' : 'Join walkthrough',
    );
    const fields = [];
    if (!this.isStaff) {
      this.nameInput = el('input', { id: 'guest-name', value: this.room.customerName || '', maxlength: '60', autocomplete: 'name' });
      this.nameInput.addEventListener('input', () => this.refreshLobby());
      this.consent = el('input', { type: 'checkbox', id: 'consent' });
      this.consent.addEventListener('change', () => this.refreshLobby());
      fields.push(
        el('label', { class: 'field' }, [el('span', {}, 'Your name'), this.nameInput]),
        el('label', { class: 'check' }, [
          this.consent,
          el('span', {}, 'I understand this walkthrough may be recorded by MoveSafe Relocation and used to prepare my moving estimate.'),
        ]),
        el('p', { class: 'fine' }, 'You can ask the specialist to stop at any time. A red banner stays on screen for everyone while recording is on.'),
      );
    } else {
      fields.push(
        el('p', { class: 'fine' }, 'Tell the customer before you record. They will see a red banner the entire time, and so will you. Recording captures every person in the call.'),
      );
      if (this.room.customerPhone) {
        fields.push(el('p', { class: 'private-note' }, `Phone: ${this.room.customerPhone}`));
      }
      if (this.room.notes) {
        fields.push(
          el('div', { class: 'private-note' }, [
            el('strong', {}, 'Private office notes'),
            el('p', {}, this.room.notes),
          ]),
        );
      }
    }

    this.root.replaceChildren(
      el('main', { class: 'lobby' }, [
        el('div', { class: 'lobby-card' }, [
          brand(this.isStaff ? '/' : null),
          el('p', { class: 'eyebrow' }, 'Video walkthrough'),
          el('h1', {}, this.room.customerName),
          route ? el('p', { class: 'route' }, route) : null,
          el('p', { class: 'room-code' }, `Room ${formatCode(this.room.id)}`),
          el('div', { class: 'preview-frame' }, [this.preview, el('p', { class: 'preview-fallback' }, 'Camera preview')]),
          ...fields,
          this.error,
          el('div', { class: 'row-actions' }, [this.enableBtn, this.flipBtn, this.joinBtn]),
        ]),
      ]),
    );
  }

  refreshLobby() {
    if (!this.joinBtn?.isConnected) return;
    const named = this.isStaff || this.nameInput.value.trim().length > 1;
    const agreed = this.isStaff || this.consent.checked;
    this.joinBtn.disabled = !this.previewStream || !named || !agreed;
    this.flipBtn.disabled = !this.previewStream;
    this.flipBtn.textContent = this.useRear ? 'Front camera' : 'Rear camera';
    this.preview.classList.toggle('mirrored', !this.useRear);
  }

  async enableMedia() {
    this.error.hidden = true;
    this.enableBtn.disabled = true;
    try {
      await this.acquirePreview();
      this.preview.srcObject = this.previewStream;
      await this.preview.play().catch(() => {});
      this.enableBtn.textContent = 'Camera ready';
      this.refreshLobby();
    } catch (err) {
      this.error.hidden = false;
      this.error.textContent = mediaError(err);
      this.enableBtn.disabled = false;
    }
  }

  async acquirePreview() {
    this.previewStream?.getTracks().forEach((track) => track.stop());
    this.previewStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: {
        facingMode: this.useRear ? { ideal: 'environment' } : { ideal: 'user' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
  }

  async flipCamera() {
    const next = !this.useRear;
    const stream = this.localStream || this.previewStream;
    if (!stream) return;
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: next ? { ideal: 'environment' } : { ideal: 'user' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      const track = fresh.getVideoTracks()[0];
      const old = stream.getVideoTracks()[0];
      if (old) {
        track.enabled = old.enabled;
        stream.removeTrack(old);
      }
      stream.addTrack(track);
      this.useRear = next;
      const video = this.root.querySelector('#local-video') || this.preview;
      if (video) {
        video.srcObject = stream;
        video.classList.toggle('mirrored', !this.useRear);
      }
      for (const peer of this.peers.values()) {
        const sender = peer.pc.getSenders().find((item) => item.track?.kind === 'video');
        if (sender) await sender.replaceTrack(track);
      }
      old?.stop();
      this.refreshLobby();
      this.updateControls();
      if (this.useRear) this.dismissTip();
    } catch {
      toast('Could not switch cameras on this device.');
    }
  }

  async enterCall() {
    if (!this.previewStream) return;
    if (!this.isStaff) {
      const name = this.nameInput.value.trim();
      if (name.length < 2 || !this.consent.checked) return;
      this.localName = name;
    }
    this.localStream = this.previewStream;
    this.previewStream = null;
    this.joinedAt = Date.now();
    this.renderLive();
    document.body.classList.add('in-call');
    window.addEventListener('beforeunload', this.onBeforeUnload);
    window.addEventListener('pagehide', this.onPageHide);
    if (!window.io) {
      toast('Live calling did not load. Refresh the page.');
      return;
    }
    this.socket = window.io({ autoConnect: false });
    this.bindSocket();
    this.shouldBeInRoom = true;
    this.socket.connect();
  }

  bindSocket() {
    this.socket.on('connect', () => {
      if (this.shouldBeInRoom && !this.destroyed) this.sendJoin();
    });
    this.socket.on('disconnect', () => {
      if (this.destroyed) return;
      this.closePeers();
      this.setPresence('Reconnecting…');
    });
    this.socket.on('room-state', (message) => {
      this.isStaff = Boolean(message.you?.isStaff);
      this.localName = message.you?.name || this.localName;
      const local = this.root.querySelector('#local-video');
      if (local) local.dataset.label = `${this.localName} (specialist)`;
      for (const peer of message.peers || []) this.ensurePeer(peer, { initiator: true });
      this.applyRecording(message.recording);
      this.updatePresence();
    });
    this.socket.on('peer-joined', (peer) => {
      this.ensurePeer(peer, { initiator: false });
      const queued = this.signalQueue.get(peer.id) || [];
      this.signalQueue.delete(peer.id);
      for (const data of queued) this.peers.get(peer.id)?.handleSignal(data);
      this.updatePresence();
    });
    this.socket.on('peer-left', ({ id }) => {
      this.removePeer(id);
      this.updatePresence();
    });
    this.socket.on('signal', ({ from, data }) => {
      const peer = this.peers.get(from);
      if (!peer) {
        const list = this.signalQueue.get(from) || [];
        list.push(data);
        this.signalQueue.set(from, list);
        return;
      }
      peer.handleSignal(data);
    });
    this.socket.on('recording', (message) => this.applyRecording(message));
    this.clock = setInterval(() => this.tick(), 500);
  }

  sendJoin() {
    this.socket.emit(
      'join',
      {
        roomId: this.roomId,
        participantId: this.participantId,
        name: this.localName,
        asGuest: this.asGuest,
      },
      (ack) => {
        if (ack?.ok) return;
        this.showFatal(ack?.error || 'Could not join the survey.');
      },
    );
  }

  sendSignal(to, data) {
    this.socket.emit('signal', { roomId: this.roomId, to, data });
  }

  tileLabel(peer) {
    return `${peer.name}${peer.isStaff ? ' (specialist)' : ''}`;
  }

  ensurePeer(info, { initiator }) {
    let peer = this.peers.get(info.id);
    if (peer) {
      peer.update(info);
      return peer;
    }
    peer = new PeerLink(this, info, { initiator });
    this.peers.set(info.id, peer);
    const video = el('video', { class: 'remote-video' });
    video.autoplay = true;
    video.playsInline = true;
    video.dataset.label = this.tileLabel(peer);
    peer.video = video;
    const tile = el('div', { class: 'remote-tile', dataset: { peer: info.id } }, [
      video,
      el('div', { class: 'tile-caption' }, [
        el('span', { dataset: { nameFor: info.id } }, info.name),
        info.isStaff ? el('span', { class: 'mini-pill' }, 'Specialist') : null,
        el('span', { class: 'tile-state', dataset: { stateFor: info.id } }, 'Connecting'),
      ]),
    ]);
    const grid = this.root.querySelector('.remote-grid');
    grid.querySelector('.waiting')?.remove();
    grid.append(tile);
    this.layoutGrid();
    peer.attach();
    if (initiator) peer.makeOffer().catch((err) => console.warn(err));
    return peer;
  }

  removePeer(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.close();
    this.peers.delete(id);
    this.root.querySelector(`[data-peer="${id}"]`)?.remove();
    this.layoutGrid();
  }

  closePeers() {
    for (const id of [...this.peers.keys()]) this.removePeer(id);
  }

  layoutGrid() {
    const grid = this.root.querySelector('.remote-grid');
    if (!grid) return;
    const count = this.peers.size;
    grid.className = `remote-grid n${Math.min(Math.max(count, 0), 3)}`;
    if (count === 0 && !grid.querySelector('.waiting')) {
      grid.append(
        el('div', { class: 'waiting' }, [
          el('h2', {}, this.isStaff ? 'Waiting for the customer' : 'Waiting for your specialist'),
          el('p', {}, this.isStaff
            ? 'Share the survey link. They can join from a phone browser — no app to install.'
            : 'You are in the room. Your MoveSafe specialist will appear here.'),
        ]),
      );
    }
  }

  updateTileStatus(peer) {
    const node = this.root.querySelector(`[data-state-for="${peer.id}"]`);
    if (!node) return;
    const state = peer.pc.connectionState;
    const label = state === 'connected' ? 'Live' : state === 'failed' ? 'Failed' : state === 'disconnected' ? 'Reconnecting' : 'Connecting';
    node.textContent = label;
    node.className = `tile-state${state === 'connected' ? ' ok' : state === 'failed' ? ' bad' : ''}`;
  }

  updatePresence() {
    const names = [this.localName, ...[...this.peers.values()].map((peer) => peer.name)].filter(Boolean);
    this.setPresence(names.join(' · '));
  }

  setPresence(text) {
    const node = this.root.querySelector('#call-presence');
    if (node) node.textContent = text;
  }

  showFatal(message) {
    const stage = this.root.querySelector('.stage');
    if (!stage) {
      toast(message);
      return;
    }
    stage.replaceChildren(el('div', { class: 'waiting' }, [el('h2', {}, 'Unable to join'), el('p', {}, message)]));
  }

  showTapForSound() {
    if (this.root.querySelector('.tap-audio')) return;
    const button = el('button', { class: 'tap-audio', type: 'button' }, 'Tap to hear audio');
    button.addEventListener('click', () => {
      this.root.querySelectorAll('video').forEach((video) => video.play().catch(() => {}));
      button.remove();
    });
    this.root.querySelector('.stage')?.append(button);
  }

  renderLive() {
    const local = el('video');
    local.id = 'local-video';
    local.muted = true;
    local.autoplay = true;
    local.playsInline = true;
    local.className = this.useRear ? '' : 'mirrored';
    local.dataset.label = `${this.localName} (${this.isStaff ? 'specialist' : 'guest'})`;
    local.srcObject = this.localStream;
    local.play().catch(() => {});

    const route = routeLabel(this.room.origin, this.room.destination);
    this.root.replaceChildren(
      el('section', { class: 'call-app' }, [
        el('div', { id: 'rec-banner', class: 'rec-banner', hidden: true }, [
          el('span', { class: 'rec-dot' }),
          el('span', { id: 'rec-live' }, ''),
          el('span', { id: 'rec-timer' }, '0:00'),
        ]),
        el('header', { class: 'call-top' }, [
          brand(this.isStaff ? '/' : null),
          el('div', { class: 'call-heading' }, [
            el('h1', { class: 'call-title' }, this.room.customerName),
            el('p', { id: 'call-presence', class: 'call-sub' }, 'Connecting…'),
            route ? el('p', { class: 'call-sub' }, `${route} · Room ${formatCode(this.room.id)}`) : el('p', { class: 'call-sub' }, `Room ${formatCode(this.room.id)}`),
          ]),
          this.isStaff ? el('a', { class: 'text-link', href: '/recordings' }, 'Library') : el('span'),
        ]),
        el('div', { class: 'stage' }, [
          el('div', { class: 'remote-grid n0' }, [
            el('div', { class: 'waiting' }, [
              el('h2', {}, 'Connecting…'),
              el('p', {}, 'Stay on this page. Video appears as soon as the other person joins.'),
            ]),
          ]),
          el('div', { id: 'rec-chip', class: 'rec-chip', hidden: true }, [
            el('span', { class: 'rec-dot' }),
            'REC',
          ]),
          el('div', { class: 'pip' }, [
            local,
            el('span', { class: 'pip-label' }, 'You'),
          ]),
          el('p', { id: 'connect-hint', class: 'connect-hint', hidden: true }, 'Still connecting. If this lasts, the network is blocking a direct call and a TURN server is required. See the README.'),
          this.isStaff ? null : el('div', { id: 'rear-tip', class: 'rear-tip' }, [
            el('p', {}, 'Showing the rooms? Switch to the rear camera.'),
            el('button', { type: 'button', class: 'btn btn-tiny', onclick: () => this.dismissTip() }, 'Got it'),
          ]),
        ]),
        el('div', { class: 'call-controls' }, [
          this.control('mute', 'mic', 'Mute'),
          this.control('camera', 'cam', 'Camera'),
          this.control('flip', 'flip', 'Rear cam'),
          this.isStaff ? this.control('record', 'record', 'Record') : null,
          this.isStaff ? this.control('invite', 'link', 'Invite') : null,
          this.control('leave', 'leave', 'Leave'),
        ]),
      ]),
    );
    this.root.querySelector('[data-action="mute"]').addEventListener('click', () => this.toggleMute());
    this.root.querySelector('[data-action="camera"]').addEventListener('click', () => this.toggleCamera());
    this.root.querySelector('[data-action="flip"]').addEventListener('click', () => this.flipCamera());
    this.root.querySelector('[data-action="record"]')?.addEventListener('click', () => this.onRecord());
    this.root.querySelector('[data-action="invite"]')?.addEventListener('click', () => this.copyInvite());
    this.root.querySelector('[data-action="leave"]').addEventListener('click', () => this.leave());
    this.updateControls();
    if (sessionStorage.getItem('movesafe-rear-tip') === 'off') this.dismissTip();
  }

  control(action, glyph, label) {
    return el('button', { class: `ctrl${action === 'leave' ? ' leave' : ''}`, type: 'button', dataset: { action } }, [
      icon(glyph),
      el('span', {}, label),
    ]);
  }

  toggleMute() {
    const track = this.localStream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    this.micOn = track.enabled;
    this.updateControls();
  }

  toggleCamera() {
    const track = this.localStream?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    this.camOn = track.enabled;
    const video = this.root.querySelector('#local-video');
    if (video) video.dataset.camera = this.camOn ? 'on' : 'off';
    this.updateControls();
  }

  updateControls() {
    const mute = this.root.querySelector('[data-action="mute"]');
    const cam = this.root.querySelector('[data-action="camera"]');
    const flip = this.root.querySelector('[data-action="flip"]');
    const record = this.root.querySelector('[data-action="record"]');
    if (mute) {
      mute.querySelector('span').textContent = this.micOn ? 'Mute' : 'Unmute';
      mute.classList.toggle('off', !this.micOn);
      mute.replaceChild(icon(this.micOn ? 'mic' : 'micOff'), mute.querySelector('svg'));
    }
    if (cam) {
      cam.querySelector('span').textContent = this.camOn ? 'Camera' : 'Cam off';
      cam.classList.toggle('off', !this.camOn);
      cam.replaceChild(icon(this.camOn ? 'cam' : 'camOff'), cam.querySelector('svg'));
    }
    if (flip) flip.querySelector('span').textContent = this.useRear ? 'Front cam' : 'Rear cam';
    if (record) {
      const mine = Boolean(this.recorder?.active);
      const other = Boolean(this.recording?.active) && !mine;
      record.disabled = other || Boolean(this.recorder?.saving);
      record.classList.toggle('danger', mine || other);
      record.querySelector('span').textContent = mine ? 'Stop' : other ? 'Recording' : this.recorder?.saving ? 'Saving' : 'Record';
      record.replaceChild(icon(mine ? 'stop' : 'record'), record.querySelector('svg'));
      record.setAttribute('aria-pressed', mine ? 'true' : 'false');
    }
  }

  onRecord() {
    if (!this.recorder) {
      this.recorder = new CallRecorder({
        roomId: this.roomId,
        customerName: this.room.customerName,
        participantId: this.participantId,
        getLocalStream: () => this.localStream,
        onChange: () => this.updateControls(),
        onError: (message) => toast(message),
      });
    }
    const button = this.root.querySelector('[data-action="record"]');
    if (button) button.disabled = true;
    this.recorder.toggle().then((saved) => {
      if (saved?.recording?.status === 'ready') toast('Recording saved to the library.');
      if (saved?.recording?.status === 'failed') toast('Recording was too short to save. Try again.');
    }).catch((err) => {
      toast(err.message || 'Could not record.');
    }).finally(() => this.updateControls());
  }

  applyRecording(message) {
    this.recording = message;
    const on = Boolean(message?.active);
    const banner = this.root.querySelector('#rec-banner');
    const chip = this.root.querySelector('#rec-chip');
    const live = this.root.querySelector('#rec-live');
    if (banner) banner.hidden = !on;
    if (chip) chip.hidden = !on;
    if (live) live.textContent = on ? 'This call is being recorded by MoveSafe Relocation' : '';
    if (on && message.startedAt) this.recordingStartedAt = message.startedAt;
    this.updateControls();
    this.tick();
  }

  tick() {
    const timer = this.root.querySelector('#rec-timer');
    if (timer && this.recording?.active && this.recordingStartedAt) {
      timer.textContent = formatClock(Date.now() - Date.parse(this.recordingStartedAt));
    }
    const hint = this.root.querySelector('#connect-hint');
    if (!hint) return;
    const peers = [...this.peers.values()];
    const live = peers.some((peer) => peer.pc.connectionState === 'connected');
    hint.hidden = !(peers.length && !live && Date.now() - this.joinedAt > 12000);
  }

  async copyInvite() {
    const link = `${location.origin}/c/${this.roomId}`;
    const ok = await copyText(link);
    toast(ok ? 'Survey link copied.' : link);
  }

  dismissTip() {
    sessionStorage.setItem('movesafe-rear-tip', 'off');
    this.root.querySelector('#rear-tip')?.remove();
  }

  async leave() {
    await this.destroy({ redirect: true });
  }

  async destroy({ redirect = false } = {}) {
    if (this.destroyed) return;
    this.destroyed = true;
    this.shouldBeInRoom = false;
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    window.removeEventListener('pagehide', this.onPageHide);
    clearInterval(this.clock);
    if (this.recorder?.active) {
      this.recorder.saving = true;
      this.updateControls();
      await this.recorder.stop().catch(() => {});
    }
    this.closePeers();
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.previewStream?.getTracks().forEach((track) => track.stop());
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
    }
    document.body.classList.remove('in-call');
    if (redirect) location.href = this.isStaff ? '/' : '/thanks';
  }
}

export async function mountCall(root, roomId) {
  const session = new CallSession(root, roomId);
  await session.open();
  return { destroy: () => session.destroy({ redirect: false }) };
}
