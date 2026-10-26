import './ui/styles.css';
import { append, clear, h } from './ui/dom';
import { renderLimits } from './ui/limits';
import { renderReceive } from './ui/receive';
import { renderSend } from './ui/send';

const app = document.getElementById('app')!;
let cleanup: (() => void) | null = null;

function renderHome(root: HTMLElement): () => void {
  const secure = window.isSecureContext;
  append(
    root,
    h(
      'div',
      { class: 'hero' },
      h('div', { style: 'font-size:3rem' }, '📡'),
      h('h1', null, 'QR Air Transfer'),
      h('p', null, 'Передача файлов «по воздуху» через поток меняющихся QR-кодов. Без Wi-Fi, Bluetooth, интернета и сопряжения: один экран показывает, другая камера смотрит.'),
    ),
    h(
      'div',
      { class: 'tiles' },
      h('a', { class: 'tile', href: '#/send' }, h('div', { class: 'icon' }, '📤'), h('h2', null, 'Отправить'), h('p', null, 'Выберите файл — экран начнёт показывать поток QR-кодов')),
      h('a', { class: 'tile', href: '#/receive' }, h('div', { class: 'icon' }, '📥'), h('h2', null, 'Получить'), h('p', null, 'Наведите камеру на экран отправителя и дождитесь 100%')),
      h('a', { class: 'tile', href: '#/limits' }, h('div', { class: 'icon' }, '📈'), h('h2', null, 'Лимиты'), h('p', null, 'Теоретический предел скорости и размера, калькулятор, замер устройства')),
    ),
    h(
      'div',
      { class: 'card small' },
      h('h3', null, 'Как это работает'),
      h(
        'ol',
        { style: 'margin:0;padding-left:18px' },
        h('li', null, 'Файлы (можно несколько или целую папку) упаковываются в один архив и сжимаются: смешивание контекстов (класс PAQ) или deflate — что даст меньшее полное время передачи.'),
        h('li', null, 'Отправитель показывает сначала исходные блоки, затем бесконечный поток случайных XOR-комбинаций (fountain-код) — порядок и пропуски кадров не важны.'),
        h('li', null, 'Получатель распознаёт коды в нескольких потоках (ZXing/WebAssembly) и решает систему уравнений над GF(2): хватает ≈ K + 2 любых кадров.'),
        h('li', null, 'Обратного канала нет: можно начать приём в любой момент и принимать на несколько устройств сразу.'),
      ),
    ),
    !secure &&
      h('div', { class: 'note err' }, 'Страница открыта не по HTTPS — браузер не даст доступ к камере. Откройте приложение по https:// или с localhost.'),
    h('p', { class: 'small muted', style: 'text-align:center' }, 'Работает офлайн после первого открытия (PWA). Добавьте на главный экран.'),
  );
  return () => {};
}

const routes: Record<string, (root: HTMLElement) => () => void> = {
  '': renderHome,
  send: renderSend,
  receive: renderReceive,
  limits: renderLimits,
};

function route(): void {
  cleanup?.();
  cleanup = null;
  clear(app);
  const name = location.hash.replace(/^#\/?/, '');
  const view = routes[name] ?? renderHome;
  cleanup = view(app);
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
route();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
