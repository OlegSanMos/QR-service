import { packContainer } from '../core/container';
import { blockCount } from '../core/fountain/layout';
import { DEFAULT_CHANNEL, estimateThroughput } from '../core/limits';
import { MAX_VERSION, type Ecc } from '../core/qr/tables';
import { saveSendPosition, sendStartId } from '../core/resume-store';
import { blockSizeFor } from '../core/transfer';
import type { EncodeRequest, EncodeResponse, RenderedFrame } from '../workers/messages';
import { ScreenWakeLock, clear, formatBytes, formatDuration, formatRate, h } from './dom';

type CodesPerScreen = 1 | 2 | 4;

interface SendSettings {
  version: number;
  ecc: Ecc;
  fps: number;
  codes: CodesPerScreen;
  compress: boolean;
}

const PRESETS: { label: string; hint: string; s: Omit<SendSettings, 'compress'> }[] = [
  { label: 'Надёжно', hint: 'старые телефоны, плохой свет', s: { version: 14, ecc: 'M', fps: 7.5, codes: 1 } },
  { label: 'Баланс', hint: 'большинство телефонов', s: { version: 22, ecc: 'L', fps: 12, codes: 1 } },
  { label: 'Быстро', hint: 'камера 30 к/с, телефон на подставке', s: { version: 30, ecc: 'L', fps: 15, codes: 1 } },
  { label: '60 к/с', hint: 'камера получателя 60 к/с (выберите в настройках приёма)', s: { version: 25, ecc: 'L', fps: 30, codes: 1 } },
  { label: 'Максимум', hint: 'экран ноутбука → камера 60 к/с, подставка', s: { version: 30, ecc: 'L', fps: 30, codes: 2 } },
];

const STORAGE_KEY = 'qr-air.send-settings';
const DEFAULTS: SendSettings = { ...PRESETS[1].s, compress: true };

function loadSettings(): SendSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<SendSettings>) };
  } catch {
    // storage unavailable (private mode) — defaults are fine
  }
  return { ...DEFAULTS };
}

function saveSettings(s: SendSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}

function storageOrNull(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null; // access itself throws where storage is disabled
  }
}

interface Payload {
  name: string;
  mime: string;
  data: Uint8Array;
}

export function renderSend(root: HTMLElement): () => void {
  const settings = loadSettings();
  let payload: Payload | null = null;
  let player: Player | null = null;

  // ---- source selection ----------------------------------------------------
  const fileInput = h('input', { type: 'file' });
  const fileLabel = h('div', { class: 'muted small' }, 'или перетащите файл сюда');
  const drop = h('label', { class: 'drop' }, fileInput, h('div', { style: 'font-size:2rem' }, '📄'), h('div', null, h('b', null, 'Выбрать файл')), fileLabel);
  const textArea = h('textarea', { placeholder: '…или вставьте текст, ссылку, ключ, заметку' });
  const chosen = h('div', { class: 'small', style: 'margin-top:10px' });

  async function setFile(file: File): Promise<void> {
    chosen.textContent = `Чтение ${file.name}…`;
    const data = new Uint8Array(await file.arrayBuffer());
    payload = { name: file.name, mime: file.type || 'application/octet-stream', data };
    textArea.value = '';
    chosen.textContent = `✔ ${file.name} — ${formatBytes(data.length)}`;
    updateSummary();
  }

  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) void setFile(f);
  });
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer?.files?.[0];
    if (f) void setFile(f);
  });
  textArea.addEventListener('input', () => {
    if (textArea.value) {
      payload = { name: 'текст.txt', mime: 'text/plain;charset=utf-8', data: new TextEncoder().encode(textArea.value) };
      chosen.textContent = `✔ текст — ${formatBytes(payload.data.length)}`;
      fileInput.value = '';
    } else {
      payload = null;
      chosen.textContent = '';
    }
    updateSummary();
  });

  // ---- settings --------------------------------------------------------------
  const presetSeg = h('div', { class: 'presets' });
  const presetHint = h('div', { class: 'muted small', style: 'margin-top:6px' });
  PRESETS.forEach((p) => {
    presetSeg.appendChild(
      h('button', {
        onclick: () => {
          Object.assign(settings, p.s);
          presetHint.textContent = p.hint;
          syncControls();
        },
      }, p.label),
    );
  });

  const versionInput = h('input', { type: 'range', min: 5, max: MAX_VERSION, step: 1 });
  const versionOut = h('b');
  const fpsInput = h('input', { type: 'range', min: 1, max: 60, step: 0.5 });
  const fpsOut = h('b');
  const eccSeg = h('div', { class: 'seg' });
  const codesSeg = h('div', { class: 'seg' });
  const compressBox = h('input', { type: 'checkbox' });
  const summary = h('div', { class: 'stats', style: 'margin-top:12px' });
  const warn = h('div');

  const eccButtons = (['L', 'M', 'Q', 'H'] as Ecc[]).map((ecc) =>
    h('button', { onclick: () => ((settings.ecc = ecc), syncControls()) }, ecc),
  );
  eccButtons.forEach((b) => eccSeg.appendChild(b));
  const codeButtons = ([1, 2, 4] as CodesPerScreen[]).map((n) =>
    h('button', { onclick: () => ((settings.codes = n), syncControls()) }, String(n)),
  );
  codeButtons.forEach((b) => codesSeg.appendChild(b));

  versionInput.addEventListener('input', () => ((settings.version = Number(versionInput.value)), syncControls()));
  fpsInput.addEventListener('input', () => ((settings.fps = Number(fpsInput.value)), syncControls()));
  compressBox.addEventListener('change', () => ((settings.compress = compressBox.checked), syncControls()));

  function stat(k: string, v: string): HTMLElement {
    return h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
  }

  function syncControls(): void {
    versionInput.value = String(settings.version);
    const modules = settings.version * 4 + 17;
    versionOut.textContent = `v${settings.version} · ${modules}×${modules}`;
    fpsInput.value = String(settings.fps);
    fpsOut.textContent = `${settings.fps} кадр/с`;
    eccButtons.forEach((b) => b.classList.toggle('on', b.textContent === settings.ecc));
    codeButtons.forEach((b) => b.classList.toggle('on', b.textContent === String(settings.codes)));
    compressBox.checked = settings.compress;
    saveSettings(settings);
    updateSummary();
  }

  function updateSummary(): void {
    clear(summary);
    clear(warn);
    const block = blockSizeFor(settings.version, settings.ecc);
    const raw = block * settings.fps * settings.codes;
    summary.append(stat('Данных в коде', `${block} Б`), stat('Поток (отправка)', formatRate(raw)));
    const real = estimateThroughput(settings.version, settings.ecc, settings.codes, { ...DEFAULT_CHANNEL, displayFps: settings.fps });
    const real60 = estimateThroughput(settings.version, settings.ecc, settings.codes, { ...DEFAULT_CHANNEL, displayFps: settings.fps, cameraFps: 60, shutterMs: 10 });
    summary.append(stat('Приём, камера 30 к/с*', formatRate(real.bytesPerSecond)), stat('Приём, камера 60 к/с*', formatRate(real60.bytesPerSecond)));
    if (payload) {
      // Size before compression plus ~64 B of container metadata: an upper bound.
      const K = blockCount(payload.data.length + 64, block);
      summary.append(stat('Кадров минимум', `${K}`), stat('Время ≥', formatDuration(K / (settings.fps * settings.codes))));
      const t = K / Math.max(1e-6, real.codesPerSecond);
      summary.append(stat('Время ≈ (30 к/с)', formatDuration(t)));
      if (t > 30 * 60) warn.appendChild(h('div', { class: 'note', style: 'margin-top:10px' }, `Передача займёт около ${formatDuration(t)}. Закрепите устройства (штатив/подставка) и отключите автоблокировку экрана.`));
    }
    if (settings.version >= 33 && settings.codes > 1)
      warn.appendChild(h('div', { class: 'note', style: 'margin-top:10px' }, 'Несколько крупных кодов требуют большого экрана отправителя и камеры 1080p+ у получателя.'));
  }

  const startBtn = h('button', { class: 'primary wide', onclick: () => void start() }, '▶ Начать передачу');
  const status = h('div', { class: 'small', style: 'margin-top:8px' });

  async function start(): Promise<void> {
    if (!payload) {
      status.textContent = 'Сначала выберите файл или введите текст.';
      return;
    }
    startBtn.disabled = true;
    status.textContent = settings.compress ? 'Сжатие и подготовка…' : 'Подготовка…';
    try {
      const packed = await packContainer(payload, { compress: settings.compress });
      status.textContent = packed.compressed
        ? `Сжато: ${formatBytes(payload.data.length)} → ${formatBytes(packed.stream.length)}`
        : '';
      player?.destroy();
      player = new Player(packed.stream, settings, payload.name, () => {
        player = null;
        startBtn.disabled = false;
      });
      await player.start();
    } catch (err) {
      status.textContent = `Ошибка: ${err instanceof Error ? err.message : String(err)}`;
      startBtn.disabled = false;
    }
  }

  root.append(
    h('header', { class: 'bar' }, h('a', { class: 'back', href: '#/' }, '←'), h('h1', null, 'Отправка')),
    h('div', { class: 'card' }, h('h3', null, '1. Что передаём'), drop, h('div', { style: 'margin-top:12px' }, textArea), chosen),
    h(
      'div',
      { class: 'card' },
      h('h3', null, '2. Параметры'),
      presetSeg,
      presetHint,
      h('label', { class: 'field' }, h('span', null, 'Версия QR (больше — больше данных, сложнее сканировать)', versionOut), versionInput),
      h('label', { class: 'field' }, h('span', null, 'Смена кодов в секунду', fpsOut), fpsInput),
      h('div', { class: 'row', style: 'margin:12px 0' }, h('span', { class: 'grow small' }, 'Коррекция ошибок'), eccSeg),
      h('div', { class: 'row', style: 'margin:12px 0' }, h('span', { class: 'grow small' }, 'Кодов на экране'), codesSeg),
      h('label', { class: 'check small' }, compressBox, h('span', null, 'Сжимать (deflate), если это уменьшает размер')),
      summary,
      h('div', { class: 'muted small', style: 'margin-top:8px' }, '* оценка по модели канала, экран 60 Гц. Подробнее — в разделе «Лимиты».'),
      warn,
    ),
    startBtn,
    status,
  );
  syncControls();

  return () => player?.destroy();
}

// ---------------------------------------------------------------------------

const QUEUE_TARGET = 6;
/** How often the last shown symbol id is saved for resuming (also saved on stop). */
const POSITION_SAVE_MS = 1000;

class Player {
  private readonly worker: Worker;
  private readonly stage: HTMLElement;
  private readonly codesBox: HTMLElement;
  private readonly info: HTMLElement;
  private readonly pauseBtn: HTMLButtonElement;
  private readonly fpsLabel: HTMLElement;
  private readonly wakeLock = new ScreenWakeLock();
  private canvases: HTMLCanvasElement[] = [];
  private readonly src = document.createElement('canvas');
  private readonly srcCtx = this.src.getContext('2d')!;
  private queue: RenderedFrame[] = [];
  private nextId = 0;
  private transferId = 0;
  private lastShownId = -1;
  private positionSavedAt = 0;
  private inflight = false;
  private epoch = 0;
  private K = 0;
  private G = 1;
  private blockSize = 0;
  private qrSize = 0;
  private raf = 0;
  private lastSwitch = 0;
  private lastTick = 0;
  private vsyncMs = 1000 / 60;
  private paused = false;
  private shown = 0;
  private switches: number[] = [];
  private stalls = 0;
  private readonly onResize = (): void => this.layout();

  constructor(
    private readonly stream: Uint8Array,
    private readonly settings: SendSettings,
    private readonly name: string,
    private readonly onClose: () => void,
  ) {
    this.worker = new Worker(new URL('../workers/encode.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<EncodeResponse>) => this.onWorker(e.data);
    this.worker.onerror = (e) => {
      this.info.textContent = `Ошибка кодировщика: ${e.message || 'не удалось запустить воркер'}`;
    };
    this.codesBox = h('div', { class: 'codes' });
    this.info = h('div', { class: 'info' }, 'Подготовка…');
    this.fpsLabel = h('span');
    this.pauseBtn = h('button', { onclick: () => this.togglePause() }, '⏸');
    this.stage = h(
      'div',
      { class: 'stage' },
      this.codesBox,
      h(
        'div',
        { class: 'hud' },
        this.info,
        h('button', { onclick: () => this.changeFps(-1), title: 'медленнее' }, '−'),
        this.fpsLabel,
        h('button', { onclick: () => this.changeFps(1), title: 'быстрее' }, '+'),
        this.pauseBtn,
        h('button', { onclick: () => void this.toggleFullscreen(), title: 'на весь экран' }, '⛶'),
        h('button', { onclick: () => this.destroy() }, '■ Стоп'),
      ),
    );
    this.src.width = this.src.height = 1;
  }

  async start(): Promise<void> {
    document.body.appendChild(this.stage);
    window.addEventListener('resize', this.onResize);
    void this.wakeLock.enable();
    void this.enterFullscreen();
    this.post({
      type: 'init',
      epoch: this.epoch,
      stream: this.stream,
      version: this.settings.version,
      ecc: this.settings.ecc,
    });
    this.updateFpsLabel();
    this.raf = requestAnimationFrame(this.tick);
  }

  destroy(): void {
    this.savePosition();
    cancelAnimationFrame(this.raf);
    this.worker.terminate();
    window.removeEventListener('resize', this.onResize);
    void this.wakeLock.disable();
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    this.stage.remove();
    this.onClose();
  }

  private post(msg: EncodeRequest): void {
    this.worker.postMessage(msg);
  }

  private onWorker(msg: EncodeResponse): void {
    if (msg.epoch !== this.epoch) return;
    if (msg.type === 'ready') {
      this.K = msg.K;
      this.G = msg.G;
      this.blockSize = msg.blockSize;
      this.qrSize = msg.size;
      // Same file and settings as before ⇒ same id: continue after the last symbol shown.
      this.transferId = msg.transferId;
      this.nextId = sendStartId(storageOrNull(), msg.transferId);
      this.layout();
      this.requestFrames();
    } else if (msg.type === 'frames') {
      this.inflight = false;
      this.queue.push(...msg.frames);
      this.requestFrames();
    } else {
      this.info.textContent = `Ошибка кодирования: ${msg.message}`;
    }
  }

  private requestFrames(): void {
    const want = QUEUE_TARGET * this.settings.codes;
    if (this.inflight || this.queue.length >= want || !this.qrSize) return;
    const count = want - this.queue.length;
    this.inflight = true;
    this.post({ type: 'frames', epoch: this.epoch, firstId: this.nextId, count });
    this.nextId += count;
  }

  private layout(): void {
    if (!this.qrSize) return;
    const n = this.settings.codes;
    const box = this.codesBox.getBoundingClientRect();
    const landscape = box.width >= box.height;
    const cols = n === 1 ? 1 : n === 2 ? (landscape ? 2 : 1) : 2;
    const rows = n / cols;
    const dpr = window.devicePixelRatio || 1;
    const total = this.qrSize + 8;
    const cell = Math.min(box.width / cols, box.height / rows);
    // Integer device pixels per module keep every module the same width (no moiré).
    const scale = Math.max(1, Math.floor((cell * dpr) / total));
    const px = total * scale;
    this.codesBox.style.gridTemplateColumns = `repeat(${cols}, auto)`;
    if (this.canvases.length !== n) {
      clear(this.codesBox);
      this.canvases = Array.from({ length: n }, () => h('canvas'));
      this.canvases.forEach((c) => this.codesBox.appendChild(c));
    }
    for (const c of this.canvases) {
      c.width = c.height = px;
      c.style.width = c.style.height = `${px / dpr}px`;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, px, px);
    }
  }

  private readonly tick = (now: number): void => {
    this.raf = requestAnimationFrame(this.tick);
    if (this.lastTick) {
      const dt = now - this.lastTick;
      if (dt > 4 && dt < 50) this.vsyncMs += (dt - this.vsyncMs) * 0.05;
    }
    this.lastTick = now;
    if (this.paused || !this.qrSize) return;
    const interval = 1000 / this.settings.fps;
    if (now - this.lastSwitch < interval - this.vsyncMs * 0.5) return;
    const n = this.settings.codes;
    if (this.queue.length < n) {
      this.stalls++;
      this.requestFrames();
      return;
    }
    const frames = this.queue.splice(0, n);
    for (let i = 0; i < n; i++) this.draw(this.canvases[i], frames[i]);
    this.shown += n;
    this.lastSwitch = now;
    this.switches.push(now);
    while (this.switches.length && now - this.switches[0] > 1000) this.switches.shift();
    this.requestFrames();
    this.lastShownId = frames[n - 1].symbolId;
    this.updateInfo(this.lastShownId);
    if (now - this.positionSavedAt >= POSITION_SAVE_MS) this.savePosition(now);
  };

  private savePosition(now = performance.now()): void {
    if (this.lastShownId < 0) return;
    this.positionSavedAt = now;
    saveSendPosition(storageOrNull(), this.transferId, this.lastShownId);
  }

  private draw(canvas: HTMLCanvasElement, frame: RenderedFrame): void {
    if (this.src.width !== frame.width) this.src.width = this.src.height = frame.width;
    this.srcCtx.putImageData(new ImageData(frame.pixels, frame.width, frame.width), 0, 0);
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.src, 0, 0, canvas.width, canvas.height);
  }

  private updateInfo(lastId: number): void {
    const actualFps = this.switches.length;
    const rate = this.blockSize * actualFps * this.settings.codes;
    const minTime = this.K / (this.settings.fps * this.settings.codes);
    const phase = lastId < this.K ? `исходные блоки ${Math.min(lastId + 1, this.K)}/${this.K}` : `доп. кадры (${lastId + 1 - this.K})`;
    this.info.textContent =
      `${this.name} · v${this.settings.version}-${this.settings.ecc} · ${this.blockSize} Б/код · ${actualFps} к/с · ${formatRate(rate)} · ` +
      `${phase}${this.G > 1 ? ` · поколений ${this.G}` : ''} · мин. ${formatDuration(minTime)}${this.stalls ? ` · задержек ${this.stalls}` : ''}`;
  }

  private changeFps(dir: number): void {
    const steps = [1, 2, 3, 4, 5, 6, 7.5, 8, 10, 12, 15, 20, 24, 30, 40, 60];
    const i = steps.findIndex((s) => s >= this.settings.fps);
    const idx = Math.min(steps.length - 1, Math.max(0, (i < 0 ? steps.length - 1 : i) + dir));
    this.settings.fps = steps[idx];
    saveSettings(this.settings);
    this.updateFpsLabel();
  }

  private updateFpsLabel(): void {
    this.fpsLabel.textContent = `${this.settings.fps} к/с`;
  }

  private togglePause(): void {
    this.paused = !this.paused;
    this.pauseBtn.textContent = this.paused ? '▶' : '⏸';
  }

  private async enterFullscreen(): Promise<void> {
    try {
      if (!document.fullscreenElement && this.stage.requestFullscreen) await this.stage.requestFullscreen({ navigationUI: 'hide' });
    } catch {
      // not allowed (iOS Safari) — the stage is already a fixed full-viewport layer
    }
    setTimeout(() => this.layout(), 200);
  }

  private async toggleFullscreen(): Promise<void> {
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    else await this.enterFullscreen();
    setTimeout(() => this.layout(), 200);
  }
}
