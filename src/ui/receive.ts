import { describeFiles, type FileEntry, type Method } from '../core/container';
import { createZip } from '../core/zip';
import { unpackInWorker } from './codec';
import { peekSymbolId } from '../core/protocol';
import type { Rect } from '../core/roi';
import { CodeTracker, MAX_TRACKS } from '../core/tracks';
import type { ReceiverStatus } from '../core/transfer';
import type { DecodeRequest, DecodeResponse, DetectedQuad, ReceiverRequest, ReceiverResponse } from '../workers/messages';
import { ScreenWakeLock, clear, formatBytes, formatDuration, formatRate, h } from './dom';

/** Part of the camera frame sent to the decoder, and the factor it was resized by. */
interface Crop extends Rect {
  scale: number;
  /** Track this region follows (see core/tracks.ts), or null for a search of the whole frame. */
  trackId: number | null;
}

/** Round-robin pool of ZXing workers; a frame is dropped when every worker is busy. */
export class DecoderPool {
  private readonly workers: { worker: Worker; busy: boolean; ready: boolean }[] = [];
  private nextRequest = 1;
  private readonly crops = new Map<number, Crop>();
  onResult: (codes: Uint8Array[], quads: DetectedQuad[], crop: Crop, ms: number) => void = () => {};
  onError: (message: string) => void = () => {};

  constructor(size: number) {
    for (let i = 0; i < size; i++) this.grow();
  }

  get size(): number {
    return this.workers.length;
  }

  /** Adds one more decoding thread. */
  grow(): void {
    const worker = new Worker(new URL('../workers/decode.worker.ts', import.meta.url), { type: 'module' });
    const slot = { worker, busy: false, ready: false };
    worker.onmessage = (e: MessageEvent<DecodeResponse>) => {
      const msg = e.data;
      if (msg.type === 'ready') {
        slot.ready = true;
        return;
      }
      slot.busy = false;
      const crop = this.crops.get(msg.id);
      this.crops.delete(msg.id);
      if (msg.type === 'result' && crop) this.onResult(msg.codes, msg.quads, crop, msg.ms);
      else if (msg.type === 'error') this.onError(msg.message);
    };
    worker.onerror = (e) => {
      slot.busy = false;
      this.onError(`Ошибка распознавателя: ${e.message || 'не удалось запустить воркер'}`);
    };
    this.workers.push(slot);
  }

  get readyCount(): number {
    return this.workers.filter((w) => w.ready).length;
  }

  hasIdle(): boolean {
    return this.workers.some((w) => w.ready && !w.busy);
  }

  get idleCount(): number {
    return this.workers.filter((w) => w.ready && !w.busy).length;
  }

  submit(image: ImageData, maxSymbols: number, crop: Crop): boolean {
    const slot = this.workers.find((w) => w.ready && !w.busy);
    if (!slot) return false;
    slot.busy = true;
    const id = this.nextRequest++;
    this.crops.set(id, crop);
    const msg: DecodeRequest = { type: 'decode', id, image, maxSymbols };
    slot.worker.postMessage(msg, [image.data.buffer]);
    return true;
  }

  destroy(): void {
    for (const w of this.workers) w.worker.terminate();
    this.workers.length = 0;
  }
}

/** Upper bound for decoding threads (each holds its own ~1 MB WebAssembly instance). */
export const MAX_POOL_SIZE = 6;

export function defaultPoolSize(): number {
  // At least two: some browsers under-report cores for privacy, and one thread
  // at ~30 ms per frame would cap recognition at ~30 fps.
  const cores = navigator.hardwareConcurrency || 4;
  return Math.max(2, Math.min(4, cores - 1));
}

/** Sliding-window event rate. */
class Rate {
  private readonly events: [number, number][] = [];
  private started = 0;
  constructor(private readonly windowMs = 2000) {}
  add(now: number, amount = 1): void {
    this.trim(now);
    if (this.events.length === 0) this.started = now;
    this.events.push([now, amount]);
  }
  perSecond(now: number): number {
    this.trim(now);
    if (this.events.length === 0) return 0;
    let sum = 0;
    for (const [, a] of this.events) sum += a;
    // Until the window has filled, divide by the time actually observed.
    const span = Math.min(this.windowMs, Math.max(500, now - this.started));
    return (sum * 1000) / span;
  }
  private trim(now: number): void {
    while (this.events.length && now - this.events[0][0] > this.windowMs) this.events.shift();
  }
}

export function renderReceive(root: HTMLElement): () => void {
  const video = h('video', { playsInline: true, muted: true, autoplay: true });
  video.setAttribute('playsinline', '');
  const overlay = h('canvas', { class: 'overlay' });
  const placeholder = h('div', { class: 'placeholder' }, 'Нажмите «Включить камеру» и наведите её на экран отправителя');
  const hint = h('div', { class: 'hint' }, '');
  const viewfinder = h('div', { class: 'viewfinder' }, video, overlay, placeholder, hint);

  const cameraBtn = h('button', { class: 'primary wide', onclick: () => void startCamera() }, '📷 Включить камеру');
  const cameraSelect = h('select');
  const resolutionSelect = h('select', null, h('option', { value: '1920' }, '1080p'), h('option', { value: '1280' }, '720p'), h('option', { value: '3840' }, '4K'));
  const fpsSelect = h('select', null, h('option', { value: '60' }, '60 к/с'), h('option', { value: '30' }, '30 к/с'));
  const cropSelect = h('select', null, h('option', { value: 'full' }, 'весь кадр'), h('option', { value: 'center' }, 'центр (быстрее)'));
  const cameraInfo = h('div', { class: 'small muted' });
  const zoomInput = h('input', { type: 'range', min: 1, max: 1, step: 0.1, value: 1 });
  const zoomField = h('label', { class: 'field', style: 'display:none' }, h('span', null, 'Зум'), zoomInput);
  const progressBar = h('div');
  const progressLabel = h('div', { class: 'small muted' }, 'Ожидание кодов…');
  const fileLabel = h('div', { style: 'font-weight:600' });
  const stats = h('div', { class: 'stats' });
  const result = h('div');
  const errorBox = h('div');
  const resumeNote = h(
    'div',
    { class: 'note', style: 'margin-top:10px;display:none' },
    h('div', null, 'Продолжаем прерванный приём — включите камеру'),
    h('button', { style: 'margin-top:8px', onclick: () => discardRestored() }, 'Начать заново'),
  );

  const cameraField = h('label', { class: 'field', style: 'display:none' }, h('span', null, 'Камера'), cameraSelect);
  const settingsCard = h(
    'div',
    { class: 'card' },
    h('h3', null, 'Настройки камеры'),
    cameraField,
    h('label', { class: 'field' }, h('span', null, 'Разрешение'), resolutionSelect),
    h('label', { class: 'field' }, h('span', null, 'Частота кадров камеры'), fpsSelect),
    h('label', { class: 'field' }, h('span', null, 'Поиск кода (пока код не найден)'), cropSelect),
    zoomField,
    cameraInfo,
  );

  root.append(
    h('header', { class: 'bar' }, h('a', { class: 'back', href: '#/' }, '←'), h('h1', null, 'Приём')),
    viewfinder,
    cameraBtn,
    errorBox,
    h('div', { class: 'card', style: 'margin-top:12px' }, fileLabel, h('div', { class: 'progress' }, progressBar), progressLabel, resumeNote, h('div', { style: 'margin-top:10px' }, stats)),
    result,
    settingsCard,
  );

  // ---- state -----------------------------------------------------------------
  const pool = new DecoderPool(defaultPoolSize());
  const receiver = new Worker(new URL('../workers/receiver.worker.ts', import.meta.url), { type: 'module' });
  const wakeLock = new ScreenWakeLock();
  let stream: MediaStream | null = null;
  let running = false;
  let destroyed = false;
  let status: ReceiverStatus | null = null;
  let framesAccepted = 0;
  let lastForeignAt = 0;
  let quads: { q: DetectedQuad; at: number }[] = [];
  /** [time, symbol id] of recently decoded codes, to measure how fast the sender changes codes. */
  let idTrail: [number, number][] = [];
  let frameCounter = 0;
  let dropped = 0;
  let decodeMs = 0;
  const cameraRate = new Rate();
  const decodeRate = new Rate();
  const codeRate = new Rate();
  const rankRate = new Rate(3000);
  let lastRank = 0;
  let lastMediaTime = -1;
  let lastPresented = -1;
  let completeShown = false;
  // One tracked region per visible code (see core/tracks.ts).
  const tracker = new CodeTracker(1, 1);
  /** A capture canvas per track (fixed size while the track holds), plus one for whole-frame searches. */
  const canvases = new Map<number | null, { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }>();
  /** Track jobs that could not be served because every decoder was busy (drives pool growth). */
  let starved = 0;
  let starvedAtCheck = 0;
  let lastGrowCheck = 0;
  let droppedAtCheck = 0;
  let cameraFramesAtCheck = 0;
  let cameraFrames = 0;
  let lastCropPixels = 0;

  const post = (msg: ReceiverRequest): void => receiver.postMessage(msg);
  // Picks up a transfer interrupted by a reload or crash (answered with 'restored').
  post({ type: 'restore', now: performance.now() });

  pool.onError = (m) => showError(m);
  pool.onResult = (codes, qs, crop, ms) => {
    const now = performance.now();
    decodeRate.add(now);
    decodeMs += (ms - decodeMs) * 0.1;
    // Back from the resized crop to camera-frame coordinates.
    const located = qs.map((q) => ({
      ...q,
      points: q.points.map((v, i) => (i % 2 === 0 ? crop.x : crop.y) + v / crop.scale),
    }));
    for (const q of located) quads.push({ q, at: now });
    tracker.update(located.filter((q) => q.valid), crop.trackId);
    if (codes.length) {
      codeRate.add(now, codes.length);
      for (const c of codes) {
        const id = peekSymbolId(c);
        if (id !== null) idTrail.push([now, id]);
      }
      idTrail = idTrail.filter(([t]) => now - t < 3000);
      if (running) post({ type: 'codes', codes, now });
    }
  };

  receiver.onmessage = (e: MessageEvent<ReceiverResponse>) => {
    const msg = e.data;
    const now = performance.now();
    if (msg.type === 'status') {
      if (msg.lastKind === 'foreign') lastForeignAt = now;
      if (msg.started) {
        lastRank = 0;
        idTrail = [];
        completeShown = false;
        clear(result);
        hideRestored();
      }
      framesAccepted = msg.framesAccepted;
      updateStatus(msg.status, now);
    } else if (msg.type === 'restored') {
      framesAccepted = msg.framesAccepted;
      lastRank = msg.status.rank; // restored blocks must not count as reception speed
      updateStatus(msg.status, now);
      showRestored(msg.status);
    } else {
      hideRestored();
      updateStatus(msg.status, now);
      void finish(msg.status, msg.stream);
    }
  };

  // ---- resuming an interrupted transfer ------------------------------------------
  let restoredId: number | null = null;

  function showRestored(s: ReceiverStatus): void {
    restoredId = s.transferId;
    resumeNote.style.display = '';
  }

  function hideRestored(): void {
    restoredId = null;
    resumeNote.style.display = 'none';
  }

  /** "Начать заново": forgets the restored transfer instead of continuing it. */
  function discardRestored(): void {
    if (restoredId !== null) post({ type: 'discard', transferId: restoredId });
    hideRestored();
    status = null;
    lastRank = 0;
    framesAccepted = 0;
    progressBar.style.width = '0';
    progressLabel.textContent = 'Ожидание кодов…';
    fileLabel.textContent = '';
  }

  // Once the camera is being switched on, the "turn the camera on" note is done.
  cameraBtn.addEventListener('click', hideRestored);

  function updateStatus(s: ReceiverStatus | null, now: number): void {
    status = s;
    if (s && s.rank > lastRank) {
      rankRate.add(now, s.rank - lastRank);
      lastRank = s.rank;
    }
  }

  // ---- camera ------------------------------------------------------------------
  async function startCamera(deviceId?: string): Promise<void> {
    clear(errorBox);
    if (!navigator.mediaDevices?.getUserMedia) {
      showError('Камера недоступна. Откройте приложение по HTTPS (или localhost) в современном браузере.');
      return;
    }
    stopCamera();
    const width = Number(resolutionSelect.value);
    const fps = Number(fpsSelect.value);
    const source: MediaTrackConstraints = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } };
    const size: MediaTrackConstraints = { width: { ideal: width }, height: { ideal: Math.round((width * 9) / 16) } };
    // A bare `ideal` frame rate loses to the ideal resolution on many phones (1080p@30 wins),
    // so first insist on the rate and let the resolution give way, then relax step by step.
    const attempts: MediaTrackConstraints[] = [
      { ...source, ...size, frameRate: { min: fps * 0.8, ideal: fps } },
      { ...source, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { min: fps * 0.8, ideal: fps } },
      { ...source, ...size, frameRate: { ideal: fps } },
      { ...source },
    ];
    let lastError: unknown = null;
    for (const video of attempts) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
        break;
      } catch (err) {
        lastError = err;
        // Only an unsatisfiable constraint is worth retrying; a denied permission is final.
        if (!(err instanceof Error) || (err.name !== 'OverconstrainedError' && err.name !== 'ConstraintNotSatisfiedError')) break;
      }
    }
    if (!stream) {
      showError(`Не удалось открыть камеру: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
      return;
    }
    if (destroyed) {
      stopCamera();
      return;
    }
    video.srcObject = stream;
    await video.play().catch(() => {});
    placeholder.style.display = 'none';
    cameraBtn.style.display = 'none';
    running = true;
    void wakeLock.enable();
    const track = stream.getVideoTracks()[0];
    await tuneTrack(track);
    await listCameras(track.getSettings().deviceId);
    describeCamera(track);
    tracker.reset(video.videoWidth || 1, video.videoHeight || 1);
    lastPresented = -1;
    scheduleFrame();
  }

  async function tuneTrack(track: MediaStreamTrack): Promise<void> {
    const caps = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { focusMode?: string[]; zoom?: { min: number; max: number; step: number } };
    try {
      if (caps.focusMode?.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] });
    } catch {
      // optional
    }
    if (caps.zoom && caps.zoom.max > caps.zoom.min) {
      zoomField.style.display = '';
      zoomInput.min = String(caps.zoom.min);
      zoomInput.max = String(caps.zoom.max);
      zoomInput.step = String(caps.zoom.step || 0.1);
      zoomInput.value = String((track.getSettings() as MediaTrackSettings & { zoom?: number }).zoom ?? caps.zoom.min);
      zoomInput.oninput = () => {
        void track.applyConstraints({ advanced: [{ zoom: Number(zoomInput.value) } as MediaTrackConstraintSet] }).catch(() => {});
      };
    } else {
      zoomField.style.display = 'none';
    }
  }

  function describeCamera(track: MediaStreamTrack): void {
    const st = track.getSettings();
    const caps = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities;
    const maxFps = caps.frameRate?.max;
    const mode = st.width && st.height ? `${st.width}×${st.height}` : 'режим неизвестен';
    cameraInfo.textContent =
      `Камера работает в режиме ${mode} @ ${st.frameRate ? Math.round(st.frameRate) : '?'} к/с` +
      (maxFps ? `; браузер сообщает максимум ${Math.round(maxFps)} к/с` : '') +
      `. Потоков распознавания: ${pool.size}.`;
  }

  async function listCameras(activeId?: string): Promise<void> {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    clear(cameraSelect);
    devices.forEach((d, i) => cameraSelect.appendChild(h('option', { value: d.deviceId, selected: d.deviceId === activeId }, d.label || `Камера ${i + 1}`)));
    cameraField.style.display = devices.length > 1 ? '' : 'none';
  }

  cameraSelect.addEventListener('change', () => void startCamera(cameraSelect.value));
  resolutionSelect.addEventListener('change', () => {
    if (stream) void startCamera(cameraSelect.value || undefined);
  });
  fpsSelect.addEventListener('change', () => {
    if (stream) void startCamera(cameraSelect.value || undefined);
  });

  function stopCamera(): void {
    running = false;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
    void wakeLock.disable();
  }

  // ---- frame capture -----------------------------------------------------------
  const hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

  function scheduleFrame(): void {
    if (!running) return;
    if (hasRVFC) video.requestVideoFrameCallback((_now, meta) => onFrame(meta.presentedFrames));
    else requestAnimationFrame(() => onFrame());
  }

  function onFrame(presentedFrames?: number): void {
    if (!running) return;
    scheduleFrame();
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;
    const now = performance.now();
    if (presentedFrames !== undefined) {
      // Count every frame the camera delivered, even ones whose callback we missed.
      // A new stream restarts the counter; treat that as a single fresh frame.
      const delta = lastPresented < 0 || presentedFrames < lastPresented ? 1 : presentedFrames - lastPresented;
      lastPresented = presentedFrames;
      if (delta === 0) return;
      cameraRate.add(now, delta);
      cameraFrames += delta;
      if (delta > 1) dropped += delta - 1;
    } else {
      // rAF fallback: only process frames the camera actually delivered.
      if (video.currentTime === lastMediaTime) return;
      lastMediaTime = video.currentTime;
      cameraRate.add(now);
      cameraFrames++;
    }
    if (tracker.frameW !== vw || tracker.frameH !== vh) tracker.reset(vw, vh);
    let idle = pool.idleCount;
    if (idle === 0) {
      dropped++;
      starved += tracker.all.length;
      return;
    }
    frameCounter++;
    // Every 15th frame (and whenever nothing is tracked) one decoder searches the
    // whole frame for up to MAX_TRACKS codes, so newly visible codes get tracks;
    // the other decoders each read one tracked code, least recently served first.
    const tracks = tracker.all;
    if (tracks.length === 0 || frameCounter % 15 === 0) {
      let crop: Crop;
      if (tracks.length === 0 && cropSelect.value === 'center') {
        const side = Math.min(vw, vh);
        crop = { x: (vw - side) / 2, y: (vh - side) / 2, w: side, h: side, scale: 1, trackId: null };
      } else {
        // With codes in view their module size is known: search at that resolution.
        const scale = tracks.length ? Math.max(...tracks.map((t) => t.scale)) : 1;
        crop = { x: 0, y: 0, w: vw, h: vh, scale, trackId: null };
      }
      submitCrop(crop, MAX_TRACKS);
      idle--;
    }
    const jobs = tracker.jobs(idle);
    starved += Math.max(0, tracks.length - jobs.length);
    for (const t of jobs) submitCrop({ ...t.rect, scale: t.scale, trackId: t.id }, 1);
  }

  function submitCrop(crop: Crop, maxSymbols: number): void {
    const dw = Math.max(1, Math.round(crop.w * crop.scale));
    const dh = Math.max(1, Math.round(crop.h * crop.scale));
    let slot = canvases.get(crop.trackId);
    if (!slot) {
      const canvas = document.createElement('canvas');
      slot = { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true })! };
      canvases.set(crop.trackId, slot);
    }
    // Forget canvases of tracks that are gone.
    if (canvases.size > MAX_TRACKS + 1) {
      for (const id of canvases.keys()) if (id !== null && !tracker.all.some((t) => t.id === id)) canvases.delete(id);
    }
    const { canvas, ctx } = slot;
    if (canvas.width !== dw || canvas.height !== dh) {
      canvas.width = dw;
      canvas.height = dh;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(video, crop.x, crop.y, crop.w, crop.h, 0, 0, dw, dh);
    const image = ctx.getImageData(0, 0, dw, dh);
    // Record the exact factor used after rounding, so coordinates map back precisely.
    crop.scale = dw / crop.w;
    if (crop.trackId !== null) lastCropPixels = dw * dh;
    pool.submit(image, maxSymbols, crop);
  }

  // ---- rendering ---------------------------------------------------------------
  let uiRaf = 0;
  const statEls = new Map<string, HTMLElement>();

  function setStat(key: string, value: string): void {
    let el = statEls.get(key);
    if (!el) {
      el = h('div', { class: 'v' });
      stats.appendChild(h('div', { class: 'stat' }, h('div', { class: 'k' }, key), el));
      statEls.set(key, el);
    }
    el.textContent = value;
  }

  function drawOverlay(now: number): void {
    const rect = viewfinder.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(rect.width * dpr);
    const hh = Math.round(rect.height * dpr);
    if (overlay.width !== w || overlay.height !== hh) {
      overlay.width = w;
      overlay.height = hh;
    }
    const ctx = overlay.getContext('2d')!;
    ctx.clearRect(0, 0, w, hh);
    quads = quads.filter((q) => now - q.at < 250);
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;
    const scale = Math.min(w / vw, hh / vh);
    const ox = (w - vw * scale) / 2;
    const oy = (hh - vh * scale) / 2;
    if (running && tracker.all.length > 0) {
      ctx.strokeStyle = 'rgba(79,140,255,0.6)';
      ctx.lineWidth = 2 * dpr;
      ctx.setLineDash([8 * dpr, 6 * dpr]);
      for (const t of tracker.all) ctx.strokeRect(t.rect.x * scale + ox, t.rect.y * scale + oy, t.rect.w * scale, t.rect.h * scale);
      ctx.setLineDash([]);
    } else if (cropSelect.value === 'center' && running) {
      const side = Math.min(vw, vh) * scale;
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 2 * dpr;
      ctx.strokeRect((w - side) / 2, (hh - side) / 2, side, side);
    }
    for (const { q, at } of quads) {
      const alpha = 1 - (now - at) / 250;
      ctx.strokeStyle = q.valid ? `rgba(46,204,113,${alpha})` : `rgba(255,93,93,${alpha})`;
      ctx.lineWidth = 3 * dpr;
      ctx.beginPath();
      for (let i = 0; i < 4; i++) {
        const x = q.points[i * 2] * scale + ox;
        const y = q.points[i * 2 + 1] * scale + oy;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }

  function render(): void {
    uiRaf = requestAnimationFrame(render);
    const now = performance.now();
    drawOverlay(now);
    const camFps = cameraRate.perSecond(now);
    const decFps = decodeRate.perSecond(now);
    const codesPs = codeRate.perSecond(now);
    if (running) {
      if (pool.readyCount === 0) hint.textContent = 'Загрузка распознавателя…';
      else if (now - lastForeignAt < 1500 && !status) hint.textContent = 'Найден обычный QR-код — это не передача';
      else if (!status) hint.textContent = codesPs > 0 ? 'Код найден, синхронизация…' : 'Наведите камеру на экран отправителя';
      else hint.textContent = '';
    } else {
      hint.textContent = '';
    }
    maybeGrowPool(now);
    setStat('Камера', `${camFps.toFixed(0)} к/с`);
    setStat('Распознаётся', `${decFps.toFixed(0)} к/с · ${decodeMs.toFixed(0)} мс · ${pool.size} пот.`);
    setStat('Кодов прочитано', `${codesPs.toFixed(1)}/с`);
    setStat('Пропущено кадров', String(dropped));
    const nTracks = tracker.all.length;
    setStat('Область', running ? (nTracks ? `слежение · ${nTracks} ${nTracks === 1 ? 'код' : 'кода'} · ${Math.round(Math.sqrt(lastCropPixels))}² пикс.` : 'весь кадр') : '—');
    const framing = running ? framingHint() : '';
    if (framing && !hint.textContent) hint.textContent = framing;
    const advice = running && camFps >= 45 ? senderRateHint(camFps, now) : '';
    if (advice) hint.textContent = advice;
    if (!status) return;
    const s = status;
    const pct = (s.rank / s.K) * 100;
    progressBar.style.width = `${pct.toFixed(1)}%`;
    const info = s.info;
    fileLabel.textContent = info
      ? `${describeFiles(info.files)} · ${formatBytes(info.totalSize)}${info.method !== 'store' ? ` (сжато до ${formatBytes(s.totalLength)})` : ''}`
      : `Передача ${s.transferId.toString(16)} · ${formatBytes(s.totalLength)}`;
    const rate = rankRate.perSecond(now) * s.blockSize;
    const elapsed = ((s.completedAt ?? now) - s.startedAt) / 1000;
    const eta = rate > 0 ? ((s.K - s.rank) * s.blockSize) / rate : Infinity;
    progressLabel.textContent = s.completedAt
      ? `Готово: ${s.K} блоков за ${formatDuration(elapsed)}`
      : `${s.rank} / ${s.K} блоков · ${pct.toFixed(1)}% · осталось ≈ ${formatDuration(eta)}`;
    setStat('Скорость', formatRate(rate));
    setStat('Средняя', formatRate((s.rank * s.blockSize) / Math.max(0.001, elapsed)));
    setStat('Прошло', formatDuration(elapsed));
    setStat('Уникальных кадров', `${s.received} (+${s.duplicates} повт.)`);
    setStat('Избыточность', s.rank ? `${(((s.received - s.rank) / Math.max(1, s.rank)) * 100).toFixed(1)}%` : '—');
    setStat('Принято QR', String(framesAccepted));
  }
  uiRaf = requestAnimationFrame(render);

  /** Adds a decoding thread when frames keep getting dropped because every worker is busy. */
  function maybeGrowPool(now: number): void {
    if (!running || now - lastGrowCheck < 1500) return;
    const frames = cameraFrames - cameraFramesAtCheck;
    const lost = dropped - droppedAtCheck;
    const missedJobs = starved - starvedAtCheck;
    lastGrowCheck = now;
    cameraFramesAtCheck = cameraFrames;
    droppedAtCheck = dropped;
    starvedAtCheck = starved;
    // Several codes need a decoder each per camera frame; up to 4 threads for one code, 6 for more.
    const limit = tracker.all.length > 1 ? MAX_POOL_SIZE : 4;
    const jobsWanted = frames * Math.max(1, tracker.all.length);
    const lossy = lost / Math.max(1, frames) > 0.15 || missedJobs / Math.max(1, jobsWanted) > 0.15;
    if (frames >= 20 && lossy && pool.size < limit && pool.readyCount === pool.size) {
      pool.grow();
      const track = stream?.getVideoTracks()[0];
      if (track) describeCamera(track);
    }
  }

  /** Advice on framing: codes cut off by the frame edge, or too small to read reliably. */
  function framingHint(): string {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const edge = Math.min(vw, vh) * 0.02;
    for (const t of tracker.all) {
      const half = t.side / 2;
      if (t.cx - half < edge || t.cy - half < edge || t.cx + half > vw - edge || t.cy + half > vh - edge) {
        return 'Код у края кадра — отодвиньте телефон, чтобы все коды целиком были в кадре';
      }
      if (t.ppm > 0 && t.ppm < 2.6) return 'Коды мелковаты — поднесите телефон ближе (на модуль нужно ≥ 3 пикселя камеры)';
    }
    return '';
  }

  /** Code changes per second on the sender, from the symbol ids decoded in the last seconds. */
  function senderChangesPerSecond(now: number): number {
    let lo: [number, number] | null = null;
    let hi: [number, number] | null = null;
    for (const e of idTrail) {
      if (now - e[0] > 3000) continue;
      if (!lo || e[1] < lo[1]) lo = e;
      if (!hi || e[1] > hi[1]) hi = e;
    }
    if (!lo || !hi || hi[0] - lo[0] < 1000 || hi[1] - lo[1] > 100_000) return 0;
    // Ids are dealt to the codes on screen in turn: one change shows `codes` new ids.
    const codesOnScreen = Math.max(1, tracker.all.length);
    return ((hi[1] - lo[1]) * 1000) / (hi[0] - lo[0]) / codesOnScreen;
  }

  /**
   * Advice on the sender's rate for a 60 fps camera. Camera and screen clocks run
   * at nearly the same rate, so with <= 2 camera frames per code there are long
   * stretches where every code is caught mid-change: reception stalls at regular
   * intervals (see worstPhaseCapture in core/limits.ts). 3 frames per code
   * (20 changes/s on a 60 Hz screen) are safe at any phase.
   */
  function senderRateHint(camFps: number, now: number): string {
    const s = status;
    if (!s || s.completedAt || s.received < 20) return '';
    const rate = senderChangesPerSecond(now);
    if (rate <= 0) return '';
    const framesPerCode = camFps / rate;
    if (framesPerCode < 2.6) {
      return `Отправитель меняет коды ${Math.round(rate)} раз/с — камера успевает снять каждый всего ${framesPerCode.toFixed(1)} раза, и приём будет периодически замирать. Поставьте на отправителе 20 смен/с`;
    }
    if (framesPerCode > 3.6) return 'Камера снимает 60 к/с — на отправителе можно поставить до 20 смен кода в секунду';
    return '';
  }

  // ---- completion --------------------------------------------------------------
  async function finish(s: ReceiverStatus, data: Uint8Array): Promise<void> {
    if (completeShown) return;
    completeShown = true;
    stopCamera();
    placeholder.style.display = '';
    placeholder.textContent = 'Приём завершён';
    clear(result);
    const unpackNote = h('div', { class: 'card small' }, 'Распаковка…');
    result.appendChild(unpackNote);
    const t0 = performance.now();
    let files: FileEntry[];
    let method: Method;
    try {
      const r = await unpackInWorker(data, (p) => {
        unpackNote.textContent = p.phase === 'cm' ? `Распаковка (контекстное смешивание): ${Math.round((p.done / Math.max(1, p.total)) * 100)}%` : 'Распаковка…';
      });
      files = r.files;
      method = r.method;
    } catch (err) {
      clear(result);
      result.appendChild(h('div', { class: 'card note err' }, `Данные собраны, но повреждены: ${err instanceof Error ? err.message : String(err)}`, h('div', { style: 'margin-top:8px' }, againButton())));
      return;
    }
    clear(result);
    const unpackSecs = (performance.now() - t0) / 1000;
    const seconds = Math.max(0.001, ((s.completedAt ?? performance.now()) - s.startedAt) / 1000 + unpackSecs);
    const totalSize = files.reduce((sum, f) => sum + f.data.length, 0);
    const blobs = files.map((f) => new Blob([f.data as BlobPart], { type: f.mime }));
    const urls = blobs.map((b) => URL.createObjectURL(b));
    const baseName = (name: string): string => name.split('/').pop() || name;
    const actions = h('div', { class: 'row', style: 'justify-content:center;margin-top:12px' });

    if (files.length === 1) {
      actions.appendChild(h('a', { class: 'button primary', href: urls[0], download: baseName(files[0].name) }, '💾 Сохранить'));
    } else {
      const zipUrl = URL.createObjectURL(new Blob([createZip(files) as BlobPart], { type: 'application/zip' }));
      actions.appendChild(h('a', { class: 'button primary', href: zipUrl, download: 'qr-air-files.zip' }, '🗜 Сохранить всё (.zip)'));
    }
    const shareFiles = files.map((f, i) => new File([blobs[i]], baseName(f.name), { type: f.mime }));
    if (navigator.canShare?.({ files: shareFiles })) {
      actions.appendChild(h('button', { onclick: () => void navigator.share({ files: shareFiles }).catch(() => {}) }, files.length > 1 ? '↗ Поделиться всеми' : '↗ Поделиться'));
    }
    actions.appendChild(againButton());

    const preview = h('div', { class: 'preview', style: 'margin-top:12px' });
    if (files.length === 1) {
      const f = files[0];
      if (f.mime.startsWith('image/')) preview.appendChild(h('img', { src: urls[0], alt: f.name }));
      else if (f.mime.startsWith('text/') || /\.(txt|md|json|csv|log|xml|html?)$/i.test(f.name)) {
        const text = new TextDecoder().decode(f.data.subarray(0, 100_000));
        preview.appendChild(h('pre', null, text));
        actions.appendChild(h('button', { onclick: () => void navigator.clipboard?.writeText(text).catch(() => {}) }, '📋 Копировать'));
      }
    } else {
      const list = h('div', { class: 'file-list' });
      files.forEach((f, i) =>
        list.appendChild(
          h('div', { class: 'row' }, h('span', { class: 'grow' }, `${f.name} — ${formatBytes(f.data.length)}`), h('a', { class: 'button', href: urls[i], download: baseName(f.name) }, '💾')),
        ),
      );
      preview.appendChild(list);
    }

    const compression = method === 'store' ? '' : ` · сжатие ${method === 'cm' ? 'CM' : 'deflate'}: передано ${formatBytes(s.totalLength)}`;
    result.appendChild(
      h(
        'div',
        { class: 'card done' },
        h('div', { class: 'big' }, '✅'),
        h('h3', null, describeFiles(files)),
        h('div', { class: 'muted small' }, `${formatBytes(totalSize)} за ${formatDuration(seconds)} · ${formatRate(totalSize / seconds)}${compression} · CRC-32 ✔`),
        actions,
        preview,
      ),
    );
    result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function againButton(): HTMLButtonElement {
    return h('button', {
      onclick: () => {
        clear(result);
        post({ type: 'reset' });
        status = null;
        lastRank = 0;
        completeShown = false;
        progressBar.style.width = '0';
        progressLabel.textContent = 'Ожидание кодов…';
        fileLabel.textContent = '';
        void startCamera(cameraSelect.value || undefined);
      },
    }, '↻ Принять ещё');
  }

  function showError(message: string): void {
    clear(errorBox);
    errorBox.appendChild(h('div', { class: 'note err', style: 'margin-top:12px' }, message));
  }

  return () => {
    destroyed = true;
    cancelAnimationFrame(uiRaf);
    stopCamera();
    pool.destroy();
    receiver.terminate();
  };
}
