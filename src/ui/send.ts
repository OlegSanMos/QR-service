import { describeFiles, type FileEntry, type Method } from '../core/container';
import { blockCount } from '../core/fountain/layout';
import { autoDisplayFps, DEFAULT_CHANNEL, expectedLinkBytesPerSecond, snapRefreshHz, worstPhaseCapture } from '../core/limits';
import { MAX_VERSION, type Ecc } from '../core/qr/tables';
import { saveSendPosition, sendStartId } from '../core/resume-store';
import { blockSizeFor } from '../core/transfer';
import type { EncodeRequest, EncodeResponse, RenderedFrame } from '../workers/messages';
import { packInWorker, type CodecProgress } from './codec';
import { ScreenWakeLock, clear, formatBytes, formatDuration, formatRate, h } from './dom';

type CodesPerScreen = 1 | 2 | 4;
type CompressionChoice = Method | 'auto';

interface SendSettings {
  /** 'auto', a preset id, or 'manual' after the user touched a control. */
  preset: string;
  version: number;
  ecc: Ecc;
  fps: number;
  codes: CodesPerScreen;
  method: CompressionChoice;
}

/** Version used by the automatic mode: robust at 720p and 1080p, 1258 bytes per code. */
const AUTO_VERSION = 25;

const PRESETS: { id: string; label: string; hint: string; s?: Omit<SendSettings, 'preset' | 'method'> }[] = [
  { id: 'auto', label: '⚡ Авто', hint: 'самый быстрый режим для любой камеры получателя — подстраивается под экран' },
  { id: 'reliable', label: 'Надёжно', hint: 'старые телефоны, плохой свет', s: { version: 14, ecc: 'M', fps: 7.5, codes: 1 } },
  { id: 'cam30', label: '30 к/с', hint: 'камера получателя снимает 30 к/с', s: { version: 25, ecc: 'L', fps: 15, codes: 1 } },
  { id: 'cam60', label: '60 к/с', hint: 'камера получателя 60 к/с (по умолчанию на приёме)', s: { version: 25, ecc: 'L', fps: 20, codes: 1 } },
  { id: 'max', label: 'Максимум', hint: 'экран ноутбука → камера 60 к/с, подставка', s: { version: 30, ecc: 'L', fps: 20, codes: 2 } },
];

const STORAGE_KEY = 'qr-air.send-settings.v2';
const DEFAULTS: SendSettings = { preset: 'auto', version: AUTO_VERSION, ecc: 'L', fps: 20, codes: 1, method: 'auto' };

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

/** Measures the display refresh rate from requestAnimationFrame intervals. */
function measureRefreshHz(): Promise<number> {
  return new Promise((resolve) => {
    const deltas: number[] = [];
    let last = 0;
    const tick = (t: number): void => {
      if (last) deltas.push(t - last);
      last = t;
      if (deltas.length < 30) requestAnimationFrame(tick);
      else {
        deltas.sort((a, b) => a - b);
        resolve(snapRefreshHz(1000 / deltas[deltas.length >> 1]));
      }
    };
    requestAnimationFrame(tick);
    setTimeout(() => resolve(60), 1500); // background tab: rAF may not run
  });
}

const METHOD_LABELS: Record<Method, string> = {
  store: 'без сжатия',
  deflate: 'deflate',
  cm: 'контекстное смешивание',
};

/** Recursively reads a dropped folder (Chrome, Safari, Firefox: webkitGetAsEntry). */
async function readEntry(entry: FileSystemEntry, prefix: string, out: { file: File; path: string }[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    out.push({ file, path: prefix + file.name });
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (batch.length === 0) break;
      for (const e of batch) await readEntry(e, `${prefix}${entry.name}/`, out);
    }
  }
}

export function renderSend(root: HTMLElement): () => void {
  const settings = loadSettings();
  let files: FileEntry[] = [];
  let player: Player | null = null;
  let refreshHz = 60;

  // ---- source selection ----------------------------------------------------
  const fileInput = h('input', { type: 'file', multiple: true });
  const folderInput = h('input', { type: 'file', multiple: true });
  folderInput.setAttribute('webkitdirectory', '');
  const canPickFolder = 'webkitdirectory' in folderInput && !/iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const drop = h(
    'label',
    { class: 'drop' },
    fileInput,
    h('div', { style: 'font-size:2rem' }, '📄'),
    h('div', null, h('b', null, 'Выбрать файлы')),
    h('div', { class: 'muted small' }, canPickFolder ? 'или перетащите файлы и папки сюда' : 'можно выбрать несколько'),
  );
  const folderBtn = h('button', { onclick: () => folderInput.click(), style: canPickFolder ? '' : 'display:none' }, '📁 Выбрать папку');
  const textArea = h('textarea', { placeholder: '…или вставьте текст, ссылку, ключ, заметку' });
  const chosen = h('div', { class: 'small', style: 'margin-top:10px' });

  async function addFiles(list: { file: File; path: string }[]): Promise<void> {
    if (list.length === 0) return;
    chosen.textContent = `Чтение ${list.length} файл(ов)…`;
    const read: FileEntry[] = [];
    for (const { file, path } of list) {
      read.push({ name: path, mime: file.type || 'application/octet-stream', data: new Uint8Array(await file.arrayBuffer()) });
    }
    files = files.filter((f) => f.name !== 'текст.txt' || textArea.value !== '').concat(read);
    renderChosen();
  }

  function renderChosen(): void {
    clear(chosen);
    if (files.length === 0) return;
    const total = files.reduce((s, f) => s + f.data.length, 0);
    const list = h('div', { class: 'file-list' });
    for (const f of files.slice(0, 6)) list.appendChild(h('div', null, `• ${f.name} — ${formatBytes(f.data.length)}`));
    if (files.length > 6) list.appendChild(h('div', { class: 'muted' }, `… и ещё ${files.length - 6}`));
    chosen.append(
      h('div', { class: 'row' }, h('b', { class: 'grow' }, `✔ ${describeFiles(files)} · ${formatBytes(total)}`), h('button', { onclick: () => ((files = []), (textArea.value = ''), renderChosen()) }, 'Очистить')),
      list,
    );
    updateSummary();
  }

  const fromInput = (input: HTMLInputElement): { file: File; path: string }[] =>
    Array.from(input.files ?? []).map((file) => ({ file, path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name }));
  fileInput.addEventListener('change', () => void addFiles(fromInput(fileInput)).then(() => (fileInput.value = '')));
  folderInput.addEventListener('change', () => void addFiles(fromInput(folderInput)).then(() => (folderInput.value = '')));
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const items = Array.from(e.dataTransfer?.items ?? []);
    const entries = items.map((i) => i.webkitGetAsEntry?.()).filter((x): x is FileSystemEntry => !!x);
    if (entries.length > 0) {
      const out: { file: File; path: string }[] = [];
      void Promise.all(entries.map((en) => readEntry(en, '', out))).then(() => addFiles(out));
    } else {
      void addFiles(Array.from(e.dataTransfer?.files ?? []).map((file) => ({ file, path: file.name })));
    }
  });
  textArea.addEventListener('input', () => {
    files = files.filter((f) => f.name !== 'текст.txt');
    if (textArea.value) files.push({ name: 'текст.txt', mime: 'text/plain;charset=utf-8', data: new TextEncoder().encode(textArea.value) });
    renderChosen();
    updateSummary();
  });

  // ---- mode & settings ---------------------------------------------------------
  const presetSeg = h('div', { class: 'presets' });
  const presetHint = h('div', { class: 'muted small', style: 'margin-top:6px' });
  const presetButtons = PRESETS.map((p) =>
    h('button', {
      onclick: () => {
        settings.preset = p.id;
        if (p.s) Object.assign(settings, p.s);
        syncControls();
      },
    }, p.label),
  );
  presetButtons.forEach((b) => presetSeg.appendChild(b));

  const versionInput = h('input', { type: 'range', min: 5, max: MAX_VERSION, step: 1 });
  const versionOut = h('b');
  const fpsInput = h('input', { type: 'range', min: 1, max: 60, step: 0.5 });
  const fpsOut = h('b');
  const eccSeg = h('div', { class: 'seg' });
  const codesSeg = h('div', { class: 'seg' });
  const methodSelect = h(
    'select',
    { style: 'width:auto' },
    h('option', { value: 'auto' }, 'авто (быстрее всего)'),
    h('option', { value: 'cm' }, 'максимальное (CM)'),
    h('option', { value: 'deflate' }, 'быстрое (deflate)'),
    h('option', { value: 'store' }, 'без сжатия'),
  );
  const summary = h('div', { class: 'stats', style: 'margin-top:12px' });
  const warn = h('div');

  const manual = (): void => {
    settings.preset = 'manual';
  };
  const eccButtons = (['L', 'M', 'Q', 'H'] as Ecc[]).map((ecc) => h('button', { onclick: () => (manual(), (settings.ecc = ecc), syncControls()) }, ecc));
  eccButtons.forEach((b) => eccSeg.appendChild(b));
  const codeButtons = ([1, 2, 4] as CodesPerScreen[]).map((n) => h('button', { onclick: () => (manual(), (settings.codes = n), syncControls()) }, String(n)));
  codeButtons.forEach((b) => codesSeg.appendChild(b));
  versionInput.addEventListener('input', () => (manual(), (settings.version = Number(versionInput.value)), syncControls()));
  fpsInput.addEventListener('input', () => (manual(), (settings.fps = Number(fpsInput.value)), syncControls()));
  methodSelect.addEventListener('change', () => ((settings.method = methodSelect.value as CompressionChoice), syncControls()));

  /** In automatic mode the parameters follow the measured display. */
  function applyAuto(): void {
    if (settings.preset !== 'auto') return;
    settings.version = AUTO_VERSION;
    settings.ecc = 'L';
    settings.codes = 1;
    settings.fps = Math.round(autoDisplayFps(refreshHz) * 10) / 10;
  }

  function stat(k: string, v: string): HTMLElement {
    return h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
  }

  function syncControls(): void {
    applyAuto();
    presetButtons.forEach((b, i) => b.classList.toggle('on', PRESETS[i].id === settings.preset));
    const preset = PRESETS.find((p) => p.id === settings.preset);
    presetHint.textContent = preset ? preset.hint : 'ручная настройка';
    versionInput.value = String(settings.version);
    const modules = settings.version * 4 + 17;
    versionOut.textContent = `v${settings.version} · ${modules}×${modules}`;
    fpsInput.value = String(settings.fps);
    fpsOut.textContent = `${settings.fps} кадр/с`;
    eccButtons.forEach((b) => b.classList.toggle('on', b.textContent === settings.ecc));
    codeButtons.forEach((b) => b.classList.toggle('on', b.textContent === String(settings.codes)));
    methodSelect.value = settings.method;
    saveSettings(settings);
    updateSummary();
  }

  function linkRate(): number {
    return expectedLinkBytesPerSecond(settings.version, settings.ecc, settings.codes, settings.fps, refreshHz);
  }

  function updateSummary(): void {
    clear(summary);
    clear(warn);
    const block = blockSizeFor(settings.version, settings.ecc);
    const rate = linkRate();
    summary.append(
      stat('Режим', `v${settings.version}-${settings.ecc} · ${settings.fps} смен/с${settings.codes > 1 ? ` · ${settings.codes} кода` : ''}`),
      stat('Ожидаемая скорость*', formatRate(rate)),
    );
    if (files.length > 0) {
      const total = files.reduce((s, f) => s + f.data.length, 0);
      const K = blockCount(total + 64, block);
      summary.append(stat('Без сжатия ≈', formatDuration((K * block) / rate)), stat('Со сжатием', 'посчитаем при старте'));
      const t = (K * block) / rate;
      if (t > 30 * 60) warn.appendChild(h('div', { class: 'note', style: 'margin-top:10px' }, `Без сжатия передача заняла бы около ${formatDuration(t)}. Закрепите устройства (подставка) и отключите автоблокировку экрана.`));
    }
    const stallWarning = phaseLockWarning(settings.fps, refreshHz);
    if (stallWarning) warn.appendChild(h('div', { class: 'note', style: 'margin-top:10px' }, stallWarning));
    if (settings.version >= 33 && settings.codes > 1)
      warn.appendChild(h('div', { class: 'note', style: 'margin-top:10px' }, 'Несколько крупных кодов требуют большого экрана отправителя и камеры 1080p+ у получателя.'));
  }

  const startBtn = h('button', { class: 'primary wide', onclick: () => void start() }, '▶ Начать передачу');
  const status = h('div', { class: 'small', style: 'margin-top:8px' });
  const progressBar = h('div');
  const progressWrap = h('div', { class: 'progress', style: 'display:none' }, progressBar);

  async function start(): Promise<void> {
    if (files.length === 0) {
      status.textContent = 'Сначала выберите файлы или введите текст.';
      return;
    }
    startBtn.disabled = true;
    progressWrap.style.display = '';
    progressBar.style.width = '0';
    const total = files.reduce((s, f) => s + f.data.length, 0);
    const t0 = performance.now();
    const onProgress = (p: CodecProgress): void => {
      const pct = p.total ? (p.done / p.total) * 100 : 0;
      progressBar.style.width = `${pct.toFixed(0)}%`;
      status.textContent = p.phase === 'cm' ? `Сжатие (контекстное смешивание): ${pct.toFixed(0)}%` : 'Сжатие…';
    };
    try {
      const packed = await packInWorker(files, { method: settings.method, linkBytesPerSecond: linkRate() }, onProgress);
      const secs = (performance.now() - t0) / 1000;
      const saved = total > 0 ? Math.max(0, 1 - packed.stream.length / total) : 0;
      status.textContent =
        `${METHOD_LABELS[packed.method]}: ${formatBytes(total)} → ${formatBytes(packed.stream.length)}` +
        (saved > 0.005 ? ` (−${Math.round(saved * 100)}%)` : '') +
        ` за ${formatDuration(secs)} · передача ≈ ${formatDuration(packed.stream.length / linkRate())}`;
      progressWrap.style.display = 'none';
      player?.destroy();
      player = new Player(packed.stream, settings, describeFiles(files), () => {
        player = null;
        startBtn.disabled = false;
      });
      await player.start();
    } catch (err) {
      progressWrap.style.display = 'none';
      status.textContent = `Ошибка: ${err instanceof Error ? err.message : String(err)}`;
      startBtn.disabled = false;
    }
  }

  root.append(
    h('header', { class: 'bar' }, h('a', { class: 'back', href: '#/' }, '←'), h('h1', null, 'Отправка')),
    h('div', { class: 'card' }, h('h3', null, '1. Что передаём'), drop, h('div', { class: 'row', style: 'margin-top:8px' }, folderBtn), h('div', { style: 'margin-top:12px' }, textArea), chosen),
    h(
      'div',
      { class: 'card' },
      h('h3', null, '2. Режим'),
      presetSeg,
      presetHint,
      summary,
      warn,
      h(
        'details',
        { class: 'advanced' },
        h('summary', null, 'Ручная настройка'),
        h('label', { class: 'field' }, h('span', null, 'Версия QR (больше — больше данных, сложнее сканировать)', versionOut), versionInput),
        h('label', { class: 'field' }, h('span', null, 'Смена кодов в секунду', fpsOut), fpsInput),
        h('div', { class: 'row', style: 'margin:12px 0' }, h('span', { class: 'grow small' }, 'Коррекция ошибок'), eccSeg),
        h('div', { class: 'row', style: 'margin:12px 0' }, h('span', { class: 'grow small' }, 'Кодов на экране'), codesSeg),
        h('div', { class: 'row', style: 'margin:12px 0' }, h('span', { class: 'grow small' }, 'Сжатие'), methodSelect),
      ),
      h('div', { class: 'muted small', style: 'margin-top:8px' }, '* оценка по модели канала для камер 30 и 60 к/с. Подробнее — в разделе «Лимиты».'),
    ),
    startBtn,
    progressWrap,
    status,
  );
  syncControls();
  void measureRefreshHz().then((hz) => {
    refreshHz = hz;
    syncControls();
  });

  return () => player?.destroy();
}

/**
 * Warns when a 60 fps camera gets too few frames per code: camera and screen run at
 * nearly the same rate, so their phase drifts only slowly, and at a bad phase no
 * code is captured cleanly for tens of seconds — repeatedly, at equal intervals.
 */
function phaseLockWarning(fps: number, refreshHz: number): string {
  const worst = worstPhaseCapture({ ...DEFAULT_CHANNEL, refreshHz, displayFps: fps, cameraFps: 60, shutterMs: 10 });
  if (worst >= 0.5) return '';
  const frames = Number((60 / fps).toFixed(1));
  return `При ${fps} сменах/с на каждый код приходится всего ${frames} кадр${frames === 1 ? '' : 'а'} камеры 60 к/с: частоты экрана и камеры почти равны, и приём будет периодически замирать на десятки секунд. Для камеры 60 к/с ставьте не больше 20 смен/с.`;
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
    // Several codes get 4 extra modules of white between them, so the receiver
    // never pairs finder patterns of neighbouring codes and can track each one.
    const gapModules = n > 1 ? 4 : 0;
    const cell = Math.min(box.width / cols, box.height / rows);
    // Integer device pixels per module keep every module the same width (no moiré).
    const scale = Math.max(1, Math.floor((cell * dpr) / (total + gapModules)));
    const px = total * scale;
    this.codesBox.style.gridTemplateColumns = `repeat(${cols}, auto)`;
    this.codesBox.style.gap = `${(gapModules * scale) / dpr}px`;
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
