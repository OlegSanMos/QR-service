import {
  DEFAULT_CHANNEL,
  achievableFps,
  captureProbability,
  estimateThroughput,
  maxResolvableVersion,
  maxUniqueCodesPerSecond,
  optimalDisplayFps,
  type ChannelParams,
} from '../core/limits';
import { HEADER_SIZE } from '../core/protocol';
import { QrEncoder } from '../core/qr/encoder';
import { byteCapacity, type Ecc } from '../core/qr/tables';
import { cmCompress } from '../core/cm';
import { STREAM_MASK, TransferEncoder } from '../core/transfer';
import { clear, formatBytes, formatDuration, formatRate, h } from './dom';
import { DecoderPool, defaultPoolSize } from './receive';

export function renderLimits(root: HTMLElement): () => void {
  const p: ChannelParams & { version: number; ecc: Ecc; codes: number; camHeight: number } = {
    ...DEFAULT_CHANNEL,
    version: 25,
    ecc: 'L',
    codes: 1,
    camHeight: 1080,
  };

  const out = h('div');
  const table = h('div', { class: 'table-wrap' });
  const benchOut = h('div', { class: 'small', style: 'margin-top:10px' });
  let pool: DecoderPool | null = null;
  let destroyed = false;

  function slider(label: string, key: 'version' | 'displayFps' | 'shutterMs', min: number, max: number, step: number, fmt: (v: number) => string): HTMLElement {
    const value = h('b');
    const input = h('input', { type: 'range', min, max, step, value: p[key] });
    const sync = (): void => {
      value.textContent = fmt(p[key]);
    };
    input.addEventListener('input', () => {
      p[key] = Number(input.value);
      sync();
      update();
    });
    sync();
    return h('label', { class: 'field' }, h('span', null, label, value), input);
  }

  function select<T extends string | number>(label: string, options: [T, string][], get: () => T, set: (v: T) => void): HTMLElement {
    const sel = h('select', { style: 'width:auto' });
    for (const [v, text] of options) sel.appendChild(h('option', { value: String(v), selected: v === get() }, text));
    sel.addEventListener('change', () => {
      const raw = sel.value;
      set((typeof get() === 'number' ? Number(raw) : raw) as T);
      update();
    });
    return h('div', { class: 'row', style: 'margin:8px 0' }, h('span', { class: 'grow small' }, label), sel);
  }

  const decodeInput = h('input', { type: 'number', min: 0, step: 1, placeholder: '∞ (не ограничено)', style: 'width:140px' });
  decodeInput.addEventListener('input', () => {
    const v = Number(decodeInput.value);
    p.decodeFps = decodeInput.value && v > 0 ? v : Infinity;
    update();
  });

  function stat(k: string, v: string): HTMLElement {
    return h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
  }

  function update(): void {
    clear(out);
    const fps = achievableFps(p.displayFps, p.refreshHz);
    const ch: ChannelParams = { ...p, displayFps: fps };
    const est = estimateThroughput(p.version, p.ecc, p.codes, ch);
    const best = optimalDisplayFps(ch);
    const bestEst = estimateThroughput(p.version, p.ecc, p.codes, { ...ch, displayFps: best });
    const ceiling = maxUniqueCodesPerSecond(ch);
    const resolvable = maxResolvableVersion((p.camHeight * 0.85) / (p.codes === 4 ? 2 : 1));
    out.append(
      h(
        'div',
        { class: 'stats' },
        stat('Байт в коде (полезных)', `${est.payloadPerCode} из ${est.qrBytes}`),
        stat('Реальная смена кодов', `${fps.toFixed(fps % 1 ? 1 : 0)} к/с`),
        stat('Вероятность поймать код', `${(captureProbability(ch) * 100).toFixed(0)}%`),
        stat('Уникальных кодов', `${est.codesPerSecond.toFixed(1)}/с`),
        stat('Скорость приёма', formatRate(est.bytesPerSecond)),
        stat('В битах', `${((est.bytesPerSecond * 8) / 1000).toFixed(0)} кбит/с`),
        stat('Оптимум смены', `${best.toFixed(best % 1 ? 1 : 0)} к/с → ${formatRate(bestEst.bytesPerSecond)}`),
        stat('Потолок модели', `${ceiling.toFixed(1)} кодов/с`),
        stat('1 МБ', formatDuration(2 ** 20 / est.bytesPerSecond)),
        stat('10 МБ', formatDuration((10 * 2 ** 20) / est.bytesPerSecond)),
        stat('100 МБ', formatDuration((100 * 2 ** 20) / est.bytesPerSecond)),
        stat(`Макс. версия при ${p.camHeight}p`, `v${resolvable}`),
      ),
    );
    if (p.version > resolvable) {
      out.appendChild(h('div', { class: 'note', style: 'margin-top:10px' }, `v${p.version} слишком плотная для камеры ${p.camHeight}p (нужно ≥ 3 пикселя камеры на модуль). Уменьшите версию или повысьте разрешение.`));
    }
    renderTable(ch);
  }

  function renderTable(ch: ChannelParams): void {
    clear(table);
    const t = h('table');
    t.appendChild(h('thead', null, h('tr', null, h('th', null, 'Версия'), h('th', null, 'Модулей'), h('th', null, 'L, Б'), h('th', null, 'M, Б'), h('th', null, 'L, КБ/с'), h('th', null, 'M, КБ/с'))));
    const body = h('tbody');
    for (const v of [5, 10, 15, 20, 22, 25, 30, 35, 40]) {
      const n = v * 4 + 17;
      const l = estimateThroughput(v, 'L', p.codes, ch);
      const m = estimateThroughput(v, 'M', p.codes, ch);
      body.appendChild(
        h(
          'tr',
          { class: v === p.version ? 'hl' : '' },
          h('td', null, `v${v}`),
          h('td', null, `${n}×${n}`),
          h('td', null, String(byteCapacity(v, 'L'))),
          h('td', null, String(byteCapacity(v, 'M'))),
          h('td', null, (l.bytesPerSecond / 1024).toFixed(1)),
          h('td', null, (m.bytesPerSecond / 1024).toFixed(1)),
        ),
      );
    }
    t.appendChild(body);
    table.appendChild(t);
  }

  // ---- device benchmark --------------------------------------------------------
  const benchBtn = h('button', { class: 'primary', onclick: () => void runBench() }, '⏱ Измерить это устройство');

  async function runBench(): Promise<void> {
    benchBtn.disabled = true;
    clear(benchOut);
    const line = (text: string): void => {
      benchOut.appendChild(h('div', null, text));
    };
    try {
      // 1. Sender side: fountain symbol + QR matrix generation.
      const stream = new Uint8Array(2 * 1024 * 1024).map((_, i) => (i * 2654435761) >>> 24);
      const enc = new TransferEncoder(stream, { version: p.version, ecc: p.ecc });
      let n = 0;
      let t0 = performance.now();
      while (performance.now() - t0 < 600) enc.matrix(enc.K + n++);
      const encodeFps = (n * 1000) / (performance.now() - t0);
      const autoEnc = new QrEncoder(p.version, p.ecc, { mask: 'auto' });
      const payload = enc.frame(0);
      let m = 0;
      t0 = performance.now();
      while (performance.now() - t0 < 300) {
        autoEnc.encode(payload);
        m++;
      }
      const autoFps = (m * 1000) / (performance.now() - t0);
      line(`Генерация кадров v${p.version}-${p.ecc}: ${encodeFps.toFixed(0)} кодов/с (фикс. маска ${STREAM_MASK} + отбеливание); со стандартным перебором 8 масок было бы ${autoFps.toFixed(0)} кодов/с.`);

      // 1b. Compression speed: decides whether context mixing pays off on this device.
      const sample = new TextEncoder().encode(
        Array.from({ length: 6000 }, (_, i) => `${i};${['Москва', 'Казань', 'Омск'][i % 3]};${(i * 7919) % 10007};статус ${i % 7}\n`).join(''),
      );
      cmCompress(sample.subarray(0, 20_000)); // JIT warm-up
      t0 = performance.now();
      const cmPacked = cmCompress(sample);
      const cmMs = performance.now() - t0;
      const cmSpeed = sample.length / (cmMs / 1000);
      line(
        `Сжатие CM: ${formatRate(cmSpeed)} на этом устройстве (${formatBytes(sample.length)} таблицы → ${formatBytes(cmPacked.length)}). ` +
          `На 1 МБ данных сжатие и распаковка займут ≈ ${((2.5 * 1048576) / cmSpeed).toFixed(1)} с — приложение выбирает CM, только если это меньше выигрыша во времени передачи.`,
      );
      await new Promise((r) => setTimeout(r, 0));

      // 2. Receiver side: ZXing on a camera-sized frame containing the code.
      pool?.destroy();
      pool = new DecoderPool(defaultPoolSize());
      const started = performance.now();
      while (pool.readyCount === 0) {
        if (destroyed) return;
        if (performance.now() - started > 15000) throw new Error('распознаватель не загрузился');
        await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 300)); // let the other workers finish loading
      const matrix = enc.matrix(enc.K);
      const camW = Math.round((p.camHeight * 16) / 9);
      const camH = p.camHeight;
      const canvas = document.createElement('canvas');
      canvas.width = camW;
      canvas.height = camH;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.fillStyle = '#777';
      ctx.fillRect(0, 0, camW, camH);
      const total = matrix.size + 8;
      const ppm = Math.max(1, Math.floor((camH * 0.8) / total));
      const ox = Math.floor((camW - total * ppm) / 2);
      const oy = Math.floor((camH - total * ppm) / 2);
      ctx.fillStyle = '#eee';
      ctx.fillRect(ox, oy, total * ppm, total * ppm);
      ctx.fillStyle = '#111';
      for (let y = 0; y < matrix.size; y++)
        for (let x = 0; x < matrix.size; x++) if (matrix.modules[y * matrix.size + x]) ctx.fillRect(ox + (x + 4) * ppm, oy + (y + 4) * ppm, ppm, ppm);
      const base = ctx.getImageData(0, 0, camW, camH);
      let done = 0;
      let ok = 0;
      let msSum = 0;
      pool.onResult = (codes, _q, _c, ms) => {
        done++;
        msSum += ms;
        if (codes.length) ok++;
      };
      const crop = { x: 0, y: 0, w: camW, h: camH, scale: 1, trackId: null };
      const benchStart = performance.now();
      while (performance.now() - benchStart < 3000) {
        if (destroyed) return;
        if (pool.hasIdle()) pool.submit(new ImageData(new Uint8ClampedArray(base.data), camW, camH), 1, crop);
        else await new Promise((r) => setTimeout(r, 1));
      }
      await new Promise((r) => setTimeout(r, 200));
      const decodeFps = (done * 1000) / (performance.now() - benchStart);
      line(`Распознавание кадра ${camW}×${camH} (${defaultPoolSize()} потока): ${decodeFps.toFixed(0)} кадров/с, ${(msSum / Math.max(1, done)).toFixed(1)} мс на кадр в потоке, успешно ${ok}/${done}.`);
      p.decodeFps = Math.round(decodeFps);
      decodeInput.value = String(p.decodeFps);
      const limitedBy = decodeFps < p.cameraFps ? 'процессором получателя' : 'камерой и экраном';
      line(`Подставлено в модель: распознавание ${p.decodeFps} к/с — скорость ограничена ${limitedBy}.`);
      update();
    } catch (err) {
      line(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      benchBtn.disabled = false;
    }
  }

  const eccSeg = h('div', { class: 'seg' });
  (['L', 'M', 'Q', 'H'] as Ecc[]).forEach((e) => {
    const b = h('button', {
      onclick: () => {
        p.ecc = e;
        eccSeg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        update();
      },
    }, e);
    if (e === p.ecc) b.classList.add('on');
    eccSeg.appendChild(b);
  });

  const slow = maxUniqueCodesPerSecond(DEFAULT_CHANNEL);
  const fast = maxUniqueCodesPerSecond({ ...DEFAULT_CHANNEL, cameraFps: 60, refreshHz: 120, shutterMs: 10 });
  const maxPayload = byteCapacity(40, 'L') - HEADER_SIZE;

  root.append(
    h('header', { class: 'bar' }, h('a', { class: 'back', href: '#/' }, '←'), h('h1', null, 'Лимиты скорости и размера')),
    h(
      'div',
      { class: 'card' },
      h('h3', null, 'Короткий ответ'),
      h(
        'ul',
        { class: 'small', style: 'margin:0;padding-left:18px' },
        h('li', null, `Один QR-код вмещает максимум ${byteCapacity(40, 'L')} Б (версия 40, коррекция L); полезных в нашем кадре — ${byteCapacity(40, 'L') - HEADER_SIZE} Б.`),
        h('li', null, `Камера не может «увидеть» больше 1/(T_кадра + T_развёртки экрана + T_затвора) разных кодов в секунду: ≈ ${slow.toFixed(1)} для камеры 30 к/с и экрана 60 Гц, ≈ ${fast.toFixed(1)} для 60 к/с и 120 Гц.`),
        h('li', null, `Потолок для одного стандартного QR: ≈ ${formatRate(maxPayload * slow)} (камера 30 к/с) и ≈ ${formatRate(maxPayload * fast)} (60 к/с). На практике с телефона на телефон — 10–40 КБ/с.`),
        h('li', null, 'Несколько кодов на большом экране умножают скорость, пока камера различает модули (≥ 3 пикселя на модуль).'),
        h('li', null, 'Максимальный размер файла по протоколу — 4 ГиБ (32-битная длина). Реальный предел — память браузера (сотни МБ) и время: 100 МБ при 30 КБ/с ≈ 1 час.'),
      ),
    ),
    h(
      'div',
      { class: 'card' },
      h('h3', null, 'Калькулятор канала «экран → камера»'),
      slider('Версия QR', 'version', 1, 40, 1, (v) => `v${v} (${v * 4 + 17}×${v * 4 + 17})`),
      h('div', { class: 'row', style: 'margin:8px 0' }, h('span', { class: 'grow small' }, 'Коррекция ошибок'), eccSeg),
      select('Кодов на экране', [[1, '1'], [2, '2'], [4, '4']], () => p.codes, (v) => (p.codes = v)),
      slider('Смена кодов (отправитель)', 'displayFps', 1, 60, 0.5, (v) => `${v} к/с`),
      select('Частота экрана', [[60, '60 Гц'], [90, '90 Гц'], [120, '120 Гц'], [144, '144 Гц']], () => p.refreshHz, (v) => (p.refreshHz = v)),
      select('Камера', [[24, '24 к/с'], [30, '30 к/с'], [60, '60 к/с'], [120, '120 к/с']], () => p.cameraFps, (v) => (p.cameraFps = v)),
      select('Разрешение камеры', [[720, '720p'], [1080, '1080p'], [2160, '4K']], () => p.camHeight, (v) => (p.camHeight = v)),
      slider('Экспозиция + считывание затвора', 'shutterMs', 1, 40, 1, (v) => `${v} мс`),
      h('div', { class: 'row', style: 'margin:8px 0' }, h('span', { class: 'grow small' }, 'Распознавание получателем, кадров/с'), decodeInput),
      out,
    ),
    h('div', { class: 'card' }, h('h3', null, 'Все версии при текущих параметрах'), table),
    h(
      'div',
      { class: 'card' },
      h('h3', null, 'Замер на этом устройстве'),
      h('p', { class: 'small muted', style: 'margin-top:0' }, 'Измеряет, сколько кодов в секунду это устройство может сгенерировать (как отправитель) и распознать (как получатель) для выбранной версии и разрешения.'),
      benchBtn,
      benchOut,
    ),
    h(
      'div',
      { class: 'card small' },
      h('h3', null, 'Модель'),
      h(
        'div',
        { class: 'formula' },
        'P(код пойман) = clamp((T_d − t_s − τ) / T_c, 0, 1)\nN = f_d · P · min(1, f_dec / f_c)\nN_max = 1 / (T_c + t_s + τ)\nСкорость = N · кодов_на_экране · (ёмкость_QR − 15 Б)',
      ),
      h('p', { class: 'muted' }, 'T_d — время показа кода, t_s — время перерисовки экрана в области кода, τ — экспозиция + считывание строк камерой, T_c — период кадров камеры, f_dec — скорость распознавания. Полный вывод — docs/THEORY.md в репозитории.'),
      h('p', { class: 'muted' }, `Объём ${formatBytes(2 ** 32 - 1)} — предел 32-битного поля длины в заголовке кадра.`),
    ),
  );
  update();

  return () => {
    destroyed = true;
    pool?.destroy();
  };
}
