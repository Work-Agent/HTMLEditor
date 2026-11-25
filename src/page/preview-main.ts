import '@workstudio/sdk/global';
import './preview.css';

import {
  createEditorChannel,
  type EditorChannelMessage,
  type PickMessage,
} from '../shared/channel';

const PLUGIN_ID = 'html-editor';
const bridge = window.workStudio;
const params = new URLSearchParams(location.search);
const ref = params.get('ref') ?? '';

function el<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`缺少页面元素：${selector}`);
  return node;
}

const iframe = el<HTMLIFrameElement>('#preview');
const frameWrap = el<HTMLDivElement>('#frame-wrap');
const statusEl = el<HTMLSpanElement>('#status');
const titleEl = el<HTMLSpanElement>('#title');
const connectionEl = el<HTMLSpanElement>('#connection');
const pickButton = el<HTMLButtonElement>('#pick');
const reloadButton = el<HTMLButtonElement>('#reload');
const consoleButton = el<HTMLButtonElement>('#console');
const consoleCount = el<HTMLSpanElement>('#console-count');
const consolePanel = el<HTMLElement>('#console-panel');
const consoleList = el<HTMLDivElement>('#console-list');
const consoleSummary = el<HTMLSpanElement>('#console-summary');
const consoleClear = el<HTMLButtonElement>('#console-clear');
const consoleClose = el<HTMLButtonElement>('#console-close');
const widthButtons = document.querySelectorAll<HTMLButtonElement>(
  'button[data-width]',
);

type StatusKind = 'ok' | 'warning' | 'error';

interface ConsoleEntry {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  text: string;
}

const MAX_CONSOLE_ENTRIES = 300;
const MAX_CONSOLE_TEXT = 4000;

let channel: BroadcastChannel | null = null;
let currentUrl = '';
let loaded = false;
let pickMode = false;
let editorConnected = false;
let consoleEntries: ConsoleEntry[] = [];
let consoleOpen = false;

function fileName(value: string): string {
  if (!value) return 'HTML';
  const tail = value.split(/[/?#]/).filter(Boolean).pop() ?? 'HTML';
  try {
    return decodeURIComponent(tail);
  } catch {
    return tail;
  }
}

function setStatus(text: string, kind: StatusKind = 'ok'): void {
  statusEl.textContent = text;
  statusEl.classList.toggle('is-error', kind === 'error');
  statusEl.classList.toggle('is-warning', kind === 'warning');
}

function setConnection(text: string): void {
  connectionEl.textContent = text;
}

function cleanUrl(value: string): string {
  try {
    const url = new URL(value);
    url.searchParams.delete('__preview_ticket');
    return url.toString();
  } catch {
    return value;
  }
}

function iframeOrigin(): string {
  try {
    return currentUrl ? new URL(currentUrl).origin : '';
  } catch {
    return '';
  }
}

function setUrl(value: string): void {
  if (!value || value === currentUrl) return;
  currentUrl = value;
  loaded = false;
  clearConsole();
  setStatus('加载预览…');
  iframe.src = value;
}

function reload(): void {
  if (!currentUrl) return;
  const target = loaded ? cleanUrl(currentUrl) : currentUrl;
  loaded = false;
  clearConsole();
  setStatus('加载预览…');
  iframe.src = target;
}

function postPickMode(): void {
  if (!currentUrl || !iframe.contentWindow) return;
  const origin = iframeOrigin();
  if (!origin) return;
  try {
    iframe.contentWindow.postMessage(
      { type: 'workstudio-pick-mode', enabled: pickMode },
      origin,
    );
  } catch {
    // iframe 尚未导航到预览服务。
  }
}

function setPickMode(enabled: boolean): void {
  pickMode = enabled;
  pickButton.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  setStatus(
    enabled
      ? '选择元素：点击预览中的元素定位源码'
      : '已退出选择模式',
  );
  postPickMode();
}

function setWidth(width: string): void {
  frameWrap.dataset['width'] = width;
  for (const button of widthButtons) {
    button.setAttribute(
      'aria-pressed',
      button.dataset['width'] === width ? 'true' : 'false',
    );
  }
}

function consoleLevel(value: unknown): ConsoleEntry['level'] {
  return value === 'warn' || value === 'error' || value === 'debug' ||
    value === 'info'
    ? value
    : 'log';
}

function consoleEntryNode(entry: ConsoleEntry): HTMLElement {
  const row = document.createElement('div');
  row.className = `console-entry is-${entry.level}`;
  const level = document.createElement('span');
  level.className = 'console-level';
  level.textContent = entry.level;
  const text = document.createElement('span');
  text.className = 'console-text';
  text.textContent = entry.text;
  row.append(level, text);
  return row;
}

function updateConsoleMeta(): void {
  const errors = consoleEntries.filter(
    (entry) => entry.level === 'error',
  ).length;
  consoleCount.hidden = consoleEntries.length === 0;
  consoleCount.textContent =
    consoleEntries.length === 0
      ? ''
      : String(errors > 0 ? errors : consoleEntries.length);
  consoleCount.classList.toggle('is-error', errors > 0);
  consoleSummary.textContent =
    consoleEntries.length === 0
      ? '暂无输出'
      : `${consoleEntries.length} 条${errors > 0 ? ` · ${errors} 个错误` : ''}`;
  consoleButton.title =
    errors > 0 ? `预览控制台（${errors} 个错误）` : '预览控制台';
}

function renderConsole(): void {
  consoleList.textContent = '';
  for (const entry of consoleEntries) {
    consoleList.appendChild(consoleEntryNode(entry));
  }
  if (consoleOpen) consoleList.scrollTop = consoleList.scrollHeight;
}

function appendConsole(entries: ConsoleEntry[]): void {
  if (entries.length === 0) return;
  const wasEmpty = consoleEntries.length === 0;
  consoleEntries.push(...entries);
  const trimmed = consoleEntries.length > MAX_CONSOLE_ENTRIES;
  if (trimmed) {
    consoleEntries = consoleEntries.slice(-MAX_CONSOLE_ENTRIES);
    renderConsole();
  } else if (wasEmpty) {
    renderConsole();
  } else {
    for (const entry of entries) {
      consoleList.appendChild(consoleEntryNode(entry));
    }
    if (consoleOpen) consoleList.scrollTop = consoleList.scrollHeight;
  }
  updateConsoleMeta();
}

function clearConsole(): void {
  consoleEntries = [];
  consoleList.textContent = '';
  updateConsoleMeta();
}

function setConsoleOpen(open: boolean): void {
  consoleOpen = open;
  consolePanel.hidden = !open;
  consoleButton.setAttribute('aria-pressed', open ? 'true' : 'false');
  if (open) consoleList.scrollTop = consoleList.scrollHeight;
}

function onIframeMessage(event: MessageEvent): void {
  if (event.source !== iframe.contentWindow) return;
  const origin = iframeOrigin();
  if (origin && event.origin !== origin) return;

  const data = event.data as
    | {
        type?: unknown;
        path?: unknown;
        tags?: unknown;
        entries?: unknown;
      }
    | null;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'workstudio-page-start') {
    clearConsole();
    return;
  }

  if (data.type === 'workstudio-console') {
    const raw = Array.isArray(data.entries) ? data.entries : [];
    const entries: ConsoleEntry[] = [];
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue;
      const level = (item as { level?: unknown }).level;
      const text = (item as { text?: unknown }).text;
      if (typeof text !== 'string') continue;
      entries.push({
        level: consoleLevel(level),
        text: text.slice(0, MAX_CONSOLE_TEXT),
      });
    }
    appendConsole(entries);
    return;
  }

  if (data.type === 'workstudio-preview-ready') {
    setConnection('已连接');
    postPickMode();
    return;
  }

  if (data.type === 'workstudio-pick') {
    const path = Array.isArray(data.path)
      ? data.path.filter(
          (value): value is number =>
            typeof value === 'number' &&
            Number.isInteger(value) &&
            value >= 0,
        )
      : [];
    const tags = Array.isArray(data.tags)
      ? data.tags.filter((value): value is string => typeof value === 'string')
      : [];
    if (path.length !== tags.length) return;
    setStatus('正在定位源码…');
    const message: PickMessage = {
      type: 'pick',
      ref,
      path,
      tags,
      url: currentUrl,
    };
    channel?.postMessage(message);
  }
}

function onChannelMessage(event: MessageEvent): void {
  const message = event.data as EditorChannelMessage | null;
  if (
    !message ||
    typeof message !== 'object' ||
    message.ref !== ref
  ) {
    return;
  }

  switch (message.type) {
    case 'preview-url':
      editorConnected = true;
      setUrl(message.url);
      break;
    case 'editor-ready':
      editorConnected = true;
      setConnection('编辑器已连接');
      channel?.postMessage({ type: 'preview-ready', ref });
      break;
    case 'editor-closed':
      editorConnected = false;
      setConnection('编辑器已关闭');
      setPickMode(false);
      setStatus(
        '编辑器已关闭；当前页面仍可查看，重新打开编辑器后可继续联动',
        'warning',
      );
      break;
    case 'preview-error':
      editorConnected = true;
      setConnection('预览服务不可用');
      setStatus(`无法启动预览：${message.message}`, 'error');
      break;
    case 'pick-result':
      if (message.ok) {
        setStatus(`已定位 <${message.tag ?? '元素'}>`);
      } else if (message.reason === 'stale') {
        setStatus('预览内容与当前源码不一致，请刷新预览', 'warning');
      } else {
        setStatus('未能定位到源码位置', 'warning');
      }
      break;
    default:
      break;
  }
}

const initialHostTheme = document.documentElement.dataset['theme'];
let hostTheme: 'light' | 'dark' | null =
  initialHostTheme === 'dark' || initialHostTheme === 'light'
    ? initialHostTheme
    : null;
let currentTheme: 'light' | 'dark' = 'light';

function preferredTheme(): 'light' | 'dark' {
  if (hostTheme) return hostTheme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function applyTheme(): void {
  const theme = preferredTheme();
  currentTheme = theme;
  document.documentElement.dataset['theme'] = theme;
}

const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
mediaQuery.addEventListener('change', applyTheme);

const themeObserver = new MutationObserver(() => {
  const value = document.documentElement.dataset['theme'];
  if (value !== 'dark' && value !== 'light') return;
  if (value === currentTheme) return;
  hostTheme = value;
  currentTheme = value;
});
themeObserver.observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['data-theme'],
});

function boot(): void {
  const name = fileName(ref);
  titleEl.textContent = name;
  titleEl.title = ref || 'HTML';
  document.title = `预览 · ${name}`;
  applyTheme();

  const workspaceId = bridge.workspaceId;
  if (workspaceId) {
    void bridge
      .command('shell', `${workspaceId}/views`, 'address', {
        url: location.href,
        title: `预览 · ${name}`,
      })
      .catch(() => undefined);
  }

  if (!ref) {
    setStatus('缺少资源地址', 'error');
    setConnection('');
    return;
  }

  channel = createEditorChannel();
  channel.onmessage = onChannelMessage;
  channel.postMessage({ type: 'preview-ready', ref });

  iframe.addEventListener('load', () => {
    if (!currentUrl) return;
    loaded = true;
    setStatus('已加载');
    postPickMode();
  });

  window.addEventListener('message', onIframeMessage);
  pickButton.addEventListener('click', () => {
    if (!editorConnected) {
      setStatus('编辑器未连接，无法定位源码', 'warning');
      return;
    }
    setPickMode(!pickMode);
  });
  consoleButton.addEventListener('click', () => setConsoleOpen(!consoleOpen));
  consoleClear.addEventListener('click', clearConsole);
  consoleClose.addEventListener('click', () => setConsoleOpen(false));
  reloadButton.addEventListener('click', () => {
    if (channel && editorConnected) {
      setStatus('刷新预览…');
      channel.postMessage({ type: 'preview-refresh', ref });
      return;
    }
    reload();
  });
  for (const button of widthButtons) {
    button.addEventListener('click', () =>
      setWidth(button.dataset['width'] ?? 'auto'),
    );
  }

  window.addEventListener('beforeunload', () => {
    channel?.postMessage({ type: 'preview-closed', ref });
    channel?.close();
    channel = null;
    mediaQuery.removeEventListener('change', applyTheme);
    themeObserver.disconnect();
  });
}

void boot();
