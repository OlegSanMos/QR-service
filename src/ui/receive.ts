import { unpackContainer, type UnpackedContainer } from '../core/container';
import { downscaleFor, roiAround, type LocatedCode, type Rect } from '../core/roi';
import type { ReceiverStatus } from '../core/transfer';
import type { DecodeRequest, DecodeResponse, DetectedQuad, ReceiverRequest, ReceiverResponse } from '../workers/messages';
import { ScreenWakeLock, clear, formatBytes, formatDuration, formatRate, h } from './dom';

/** Part of the camera frame sent to the decoder, and the factor it was resized by. */
interface Crop extends Rect {
  scale: number;
  /** True when this is the tracked region around the last seen codes. */
  tracked: boolean;
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
export const MAX_POOL_SIZE = 4;

export function defaultPoolSize(): number {
  // At least two: some browsers under-report cores for privacy, and one thread
  // at ~30 ms per frame would cap recognition at ~30 fps.
  const cores = navigator.hardwareConcurrency || 4;
  return Math.max(2, Math.min(MAX_POOL_SIZE, cores - 1));
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
    h('div', { class: 'card', style: 'margin-top:12px' }, fileLabel, h('div', { class: 'progress' }, progressBar), progressLabel, h('div', { style: 'margin-top:10px' }, stats)),
    result,
    settingsCard,
  );

  // ---- state -----------------------------------------------------------------
  const pool = new DecoderPool(defaultPoolSize());
  const receiver = new Worker(new URL('../workers/receiver.worker.ts', import.meta.url), { type: 'module' });
  const wakeLock = new ScreenWakeLock();
  const capture = document.createElement('canvas');
  const captureCtx = capture.getContext('2d', { willReadFrequently: true })!;
  let stream: MediaStream | null = null;
  let running = false;
  let destroyed = false;
  let status: ReceiverStatus | null = null;
  let framesAccepted = 0;
  let lastForeignAt = 0;
  let quads: { q: DetectedQuad; at: number }[] = [];
  let recentMax: number[] = [];
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
  // Region-of-interest tracking (see core/roi.ts).
  let roi: Rect | null = null;
  let roiScale = 1;
  let roiMisses = 0;
  let lastGrowCheck = 0;
  let droppedAtCheck = 0;
  let cameraFramesAtCheck = 0;
  let cameraFrames = 0;
  let lastCropPixels = 0;

  const post = (msg: ReceiverRequest): void => receiver.postMessage(msg);

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
    updateRoi(located.filter((q) => q.valid), crop);
    recentMax.push(codes.length);
    if (recentMax.length > 30) recentMax.shift();
    if (codes.length) {
      codeRate.add(now, codes.length);
      if (running) post({ type: 'codes', codes, now });
    }
  };

  /** Follows the codes: crop around them next time, or fall back to the whole frame after misses. */
  function updateRoi(found: LocatedCode[], crop: Crop): void {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (found.length > 0) {
      roi = roiAround(found, vw, vh);
      roiScale = downscaleFor(found);
      roiMisses = 0;
    } else if (roi && crop.tracked) {
      // A miss inside the ROI: maybe too blurry for the downscale — use more pixels,
      // and after a few misses search the whole frame again.
      roiScale = Math.min(1, roiScale * 1.5);
      if (++roiMisses >= 4) roi = null;
    }
  }

  receiver.onmessage = (e: MessageEvent<ReceiverResponse>) => {
    const msg = e.data;
    const now = performance.now();
    if (msg.type === 'status') {
      if (msg.lastKind === 'foreign') lastForeignAt = now;
      if (msg.started) {
        lastRank = 0;
        completeShown = false;
        clear(result);
      }
      framesAccepted = msg.framesAccepted;
      updateStatus(msg.status, now);
    } else {
      updateStatus(msg.status, now);
      void finish(msg.status, msg.stream);
    }
  };

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
    roi = null;
    roiScale = 1;
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
    if (!pool.hasIdle()) {
      dropped++;
      return;
    }
    frameCounter++;
    // Every 15th frame scans the whole frame and looks for up to 4 codes, so newly
    // appeared codes are found even while tracking; otherwise only the tracked area.
    const probe = frameCounter % 15 === 0;
    let crop: Crop;
    if (roi && !probe) {
      crop = { ...roi, scale: roiScale, tracked: true };
    } else if (!roi && cropSelect.value === 'center') {
      const side = Math.min(vw, vh);
      crop = { x: (vw - side) / 2, y: (vh - side) / 2, w: side, h: side, scale: 1, tracked: false };
    } else {
      // Probes reuse the known module size; a blind search keeps full resolution.
      crop = { x: 0, y: 0, w: vw, h: vh, scale: roi ? roiScale : 1, tracked: false };
    }
    const dw = Math.max(1, Math.round(crop.w * crop.scale));
    const dh = Math.max(1, Math.round(crop.h * crop.scale));
    if (capture.width !== dw || capture.height !== dh) {
      capture.width = dw;
      capture.height = dh;
    }
    captureCtx.imageSmoothingEnabled = true;
    captureCtx.drawImage(video, crop.x, crop.y, crop.w, crop.h, 0, 0, dw, dh);
    const image = captureCtx.getImageData(0, 0, dw, dh);
    // Record the exact factor used after rounding, so coordinates map back precisely.
    crop.scale = dw / crop.w;
    lastCropPixels = dw * dh;
    const seen = Math.max(1, ...recentMax);
    const maxSymbols = probe ? 4 : Math.min(4, seen);
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
    if (running && roi) {
      ctx.strokeStyle = 'rgba(79,140,255,0.6)';
      ctx.lineWidth = 2 * dpr;
      ctx.setLineDash([8 * dpr, 6 * dpr]);
      ctx.strokeRect(roi.x * scale + ox, roi.y * scale + oy, roi.w * scale, roi.h * scale);
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
    setStat('Область', running ? (roi ? `слежение · ${Math.round(Math.sqrt(lastCropPixels))}² пикс.` : 'весь кадр') : '—');
    const faster = running && camFps >= 45 ? fasterSenderHint() : '';
    if (faster) hint.textContent = faster;
    if (!status) return;
    const s = status;
    const pct = (s.rank / s.K) * 100;
    progressBar.style.width = `${pct.toFixed(1)}%`;
    const info = s.info;
    fileLabel.textContent = info ? `${info.name} · ${formatBytes(info.size)}${info.compressed ? ' (сжат)' : ''}` : `Передача ${s.transferId.toString(16)} · ${formatBytes(s.totalLength)}`;
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
    lastGrowCheck = now;
    cameraFramesAtCheck = cameraFrames;
    droppedAtCheck = dropped;
    if (frames >= 20 && lost / frames > 0.15 && pool.size < MAX_POOL_SIZE && pool.readyCount === pool.size) {
      pool.grow();
      const track = stream?.getVideoTracks()[0];
      if (track) describeCamera(track);
    }
  }

  /** With a 60 fps camera the sender can change codes up to ~30 times a second. */
  function fasterSenderHint(): string {
    const s = status;
    if (!s || s.completedAt || s.received < 20) return '';
    return s.duplicates > s.received * 1.5 ? 'Камера снимает 60 к/с — на отправителе можно поставить до 30 смен кода в секунду' : '';
  }

  // ---- completion --------------------------------------------------------------
  async function finish(s: ReceiverStatus, data: Uint8Array): Promise<void> {
    if (completeShown) return;
    completeShown = true;
    stopCamera();
    placeholder.style.display = '';
    placeholder.textContent = 'Приём завершён';
    clear(result);
    let file: UnpackedContainer;
    try {
      file = await unpackContainer(data);
    } catch (err) {
      result.appendChild(h('div', { class: 'card note err' }, `Файл собран, но повреждён: ${err instanceof Error ? err.message : String(err)}`, h('div', { style: 'margin-top:8px' }, againButton())));
      return;
    }
    const seconds = Math.max(0.001, ((s.completedAt ?? performance.now()) - s.startedAt) / 1000);
    const blob = new Blob([file.data as BlobPart], { type: file.mime });
    const url = URL.createObjectURL(blob);
    const saveLink = h('a', { class: 'button primary', href: url, download: file.name }, '💾 Сохранить');
    const actions = h('div', { class: 'row', style: 'justify-content:center;margin-top:12px' }, saveLink);
    const shareFile = new File([blob], file.name, { type: file.mime });
    if (navigator.canShare?.({ files: [shareFile] })) {
      actions.appendChild(h('button', { onclick: () => void navigator.share({ files: [shareFile] }).catch(() => {}) }, '↗ Поделиться'));
    }
    actions.appendChild(againButton());
    const preview = h('div', { class: 'preview', style: 'margin-top:12px' });
    if (file.mime.startsWith('image/')) preview.appendChild(h('img', { src: url, alt: file.name }));
    else if (file.mime.startsWith('text/') || /\.(txt|md|json|csv|log|xml|html?)$/i.test(file.name)) {
      const text = new TextDecoder().decode(file.data.subarray(0, 100_000));
      preview.appendChild(h('pre', null, text));
      actions.appendChild(h('button', { onclick: () => void navigator.clipboard?.writeText(text).catch(() => {}) }, '📋 Копировать'));
    }
    result.appendChild(
      h(
        'div',
        { class: 'card done' },
        h('div', { class: 'big' }, '✅'),
        h('h3', null, file.name),
        h('div', { class: 'muted small' }, `${formatBytes(file.data.length)}${file.compressed ? ` (передано ${formatBytes(s.totalLength)} сжатыми)` : ''} · ${formatDuration(seconds)} · ${formatRate(s.totalLength / seconds)} · CRC-32 ✔`),
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
