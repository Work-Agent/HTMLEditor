import '@work-studio/sdk/global';
import './style.css';

import { redo, undo } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import type { EditorView } from '@codemirror/view';
import {
  createHtmlEditor,
  DEFAULT_SETTINGS,
  normalizeSettings,
  type EditorSettings,
  type HtmlEditorHandle,
  type ThemeMode,
} from '../editor';
import { locateElementPath } from '../editor/source-map';
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

const editorHost = el<HTMLDivElement>('#editor');
const titleEl = el<HTMLSpanElement>('#title');
const dirtyEl = el<HTMLSpanElement>('#dirty');
const saveButton = el<HTMLButtonElement>('#save');
const previewButton = el<HTMLButtonElement>('#preview');
const undoButton = el<HTMLButtonElement>('#undo');
const redoButton = el<HTMLButtonElement>('#redo');
const searchButton = el<HTMLButtonElement>('#search');
const wrapButton = el<HTMLButtonElement>('#wrap');
const linesButton = el<HTMLButtonElement>('#lines');
const statusEl = el<HTMLSpanElement>('#status');
const positionEl = el<HTMLSpanElement>('#position');
const countEl = el<HTMLSpanElement>('#count');
const conflictEl = el<HTMLDivElement>('#conflict');
const conflictReload = el<HTMLButtonElement>('#conflict-reload');
const conflictKeep = el<HTMLButtonElement>('#conflict-keep');

let editor: HtmlEditorHandle | null = null;
let settings: EditorSettings = { ...DEFAULT_SETTINGS };
let content = '';
let savedText = '';
let dirty = false;
let saving = false;
let conflictText: string | null = null;
let workspaceRoot = '';
let lastTitleReport = '';
let previewUrl = '';
let previewText = '';
let previewStarting: Promise<string | null> | null = null;
let previewOpen = false;
let liveTimer: number | null = null;
let bootReady = false;
const previewId = ref ? `html-preview-view:${hash(ref)}` : '';
const channel = createEditorChannel();

type StatusKind = 'ok' | 'warning' | 'error';

function fileName(value: string): string {
  if (!value) return 'HTML';
  const tail = value.split(/[/?#]/).filter(Boolean).pop() ?? 'HTML';
  try {
    return decodeURIComponent(tail);
  } catch {
    return tail;
  }
}

function hash(value: string): string {
  let h = 0;
  for (let index = 0; index < value.length; index += 1) {
    h = (h * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(h).toString(36);
}

function setStatus(text: string, kind: StatusKind = 'ok'): void {
  statusEl.textContent = text;
  statusEl.classList.toggle('is-error', kind === 'error');
  statusEl.classList.toggle('is-warning', kind === 'warning');
}

function updateDirty(): void {
  dirtyEl.textContent = dirty ? '● 未保存' : '';
  saveButton.disabled = saving;
  saveButton.classList.toggle('is-dirty', dirty);
  saveButton.textContent = saving ? '保存中…' : '保存';
  document.title = `${dirty ? '● ' : ''}${fileName(ref)}`;
  reportTab();
}

/** 把文件名和脏态同步到宿主标签；宿主接口不可用时静默跳过。 */
function reportTab(): void {
  const workspaceId = bridge.workspaceId;
  if (!workspaceId) return;

  const title = `${dirty ? '● ' : ''}${fileName(ref)}`;
  if (title === lastTitleReport) return;
  lastTitleReport = title;
  void bridge
    .command('shell', `${workspaceId}/views`, 'address', {
      url: location.href,
      title,
    })
    .catch(() => undefined);
}

function showConflict(): void {
  conflictEl.hidden = conflictText === null;
}

function extractText(snapshot: unknown): string | null {
  if (Array.isArray(snapshot)) {
    for (const item of snapshot) {
      if (
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { text?: unknown }).text === 'string'
      ) {
        return (item as { text: string }).text;
      }
    }
    return null;
  }
  if (
    typeof snapshot === 'object' &&
    snapshot !== null &&
    typeof (snapshot as { text?: unknown }).text === 'string'
  ) {
    return (snapshot as { text: string }).text;
  }
  return null;
}

function applyText(text: string): void {
  editor?.setValue(text, { addToHistory: false });
  content = text;
  savedText = text;
  dirty = false;
  conflictText = null;
  showConflict();
  updateDirty();
  updatePosition(editor?.view);
  if (previewUrl) previewText = text;
  void pushLive(text);
}

function applySnapshot(
  snapshot: unknown,
  options: { force?: boolean } = {},
): void {
  const text = extractText(snapshot);
  if (text === null) return;

  // 内容与当前文档一致时保留现有状态，避免把“已保存”刷成“已加载”。
  if (!options.force && !dirty && text === content) return;

  if (options.force || !dirty) {
    applyText(text);
    setStatus(options.force ? '已重新加载' : '已加载');
    return;
  }

  // 磁盘内容没有变化；当前未保存状态继续保留。
  if (text === savedText) {
    setStatus('未保存', 'warning');
    return;
  }

  // 外部内容恰好等于当前编辑内容：视为已经同步。
  if (text === content) {
    savedText = text;
    dirty = false;
    conflictText = null;
    showConflict();
    updateDirty();
    setStatus('已同步外部修改');
    return;
  }

  conflictText = text;
  showConflict();
  setStatus('文件已在外部更新', 'warning');
}

async function save(): Promise<boolean> {
  if (saving || !editor) return false;
  if (!ref) {
    setStatus('缺少资源地址', 'error');
    return false;
  }
  if (conflictText !== null) {
    setStatus('文件已在外部更新，请先处理冲突', 'error');
    return false;
  }

  cancelLivePreview();
  const text = editor.getValue();
  saving = true;
  updateDirty();
  setStatus('保存中…');

  try {
    const result = await bridge.command<{ saved: boolean }>(
      PLUGIN_ID,
      PLUGIN_ID,
      'save',
      { ref, content: text },
    );
    if (!result.ok) throw new Error(result.error.message);

    savedText = text;
    content = editor.getValue();
    dirty = content !== savedText;
    if (previewUrl) previewText = text;
    conflictText = null;
    showConflict();
    updateDirty();

    if (dirty) {
      setStatus('已保存，仍有新的修改', 'warning');
    } else {
      setStatus('已保存');
    }
    return true;
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error');
    return false;
  } finally {
    saving = false;
    updateDirty();
  }
}

async function pushLive(text: string): Promise<void> {
  if (!ref) return;
  try {
    await bridge.command(PLUGIN_ID, PLUGIN_ID, 'live', {
      ref,
      content: text,
    });
  } catch {
    // 预览服务还没启动或已关闭；不影响编辑和保存。
  }
}

async function watchWorkspaceRegistry(): Promise<void> {
  try {
    applyWorkspaceRegistry(await bridge.subscribe('workspace', 'registry'));
  } catch {
    // 没有工作区注册表时，预览服务会退回 HTML 所在目录。
  }
}

function applyWorkspaceRegistry(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  const record = value as {
    current?: { id?: string; path?: string };
    workspaces?: Array<{ id?: string; path?: string }>;
  };
  const workspaceId = bridge.workspaceId;
  const meta =
    (Array.isArray(record.workspaces)
      ? record.workspaces.find((item) => item.id === workspaceId)
      : null) ?? record.current;
  if (meta && typeof meta.path === 'string') workspaceRoot = meta.path;
}

function cancelLivePreview(): void {
  if (liveTimer === null) return;
  window.clearTimeout(liveTimer);
  liveTimer = null;
}

function scheduleLivePreview(): void {
  if (!settings.livePreview || !previewOpen || !previewUrl) return;
  if (liveTimer !== null) window.clearTimeout(liveTimer);
  liveTimer = window.setTimeout(() => {
    liveTimer = null;
    if (!settings.livePreview || !previewOpen || !previewUrl || !editor) {
      return;
    }
    // 复用同一个预览服务：只更新 overlay + SSE，不需要新 ticket / 新 iframe URL。
    const content = editor.getValue();
    previewText = content;
    void pushLive(content);
  }, 450);
}

async function ensurePreviewUrl(
  options: { quiet?: boolean } = {},
): Promise<string | null> {
  if (!ref || !editor) return null;
  if (previewStarting) return previewStarting;

  previewStarting = (async () => {
    const content = editor!.getValue();
    const input: { ref: string; content: string; root?: string } = {
      ref,
      content,
    };
    if (workspaceRoot) input.root = workspaceRoot;

    if (!options.quiet) setStatus('启动预览…');
    const result = await bridge.command<{ url: string }>(
      PLUGIN_ID,
      PLUGIN_ID,
      'preview',
      input,
    );
    if (!result.ok) {
      setStatus(`无法启动预览：${result.error.message}`, 'error');
      channel.postMessage({
        type: 'preview-error',
        ref,
        message: result.error.message,
      });
      return null;
    }

    previewUrl = result.data.url;
    previewText = content;
    channel.postMessage({
      type: 'preview-url',
      ref,
      url: previewUrl,
    });
    if (!options.quiet) setStatus('预览已就绪');
    return previewUrl;
  })();

  try {
    return await previewStarting;
  } finally {
    previewStarting = null;
  }
}

async function handlePreviewReady(): Promise<void> {
  if (!bootReady) return;
  if (previewUrl) {
    channel.postMessage({ type: 'preview-url', ref, url: previewUrl });
    return;
  }
  await ensurePreviewUrl();
}

function handlePick(message: PickMessage): void {
  if (!editor) return;

  const reply = (
    ok: boolean,
    reason?: 'stale' | 'not-found',
    tag?: string,
  ): void => {
    channel.postMessage({
      type: 'pick-result',
      ref,
      ok,
      ...(reason ? { reason } : {}),
      ...(tag ? { tag } : {}),
    });
  };

  if (!previewUrl || message.url !== previewUrl) {
    setStatus('预览内容已更新，请刷新预览后再定位', 'warning');
    reply(false, 'stale');
    return;
  }
  if (editor.getValue() !== previewText) {
    setStatus('源码已修改，请刷新预览后再定位', 'warning');
    reply(false, 'stale');
    return;
  }

  const range = locateElementPath(previewText, message.path, message.tags);
  if (!range) {
    setStatus('无法定位到源码位置', 'warning');
    reply(false, 'not-found');
    return;
  }

  editor.view.dispatch({
    selection: { anchor: range.from, head: range.to },
    scrollIntoView: true,
  });
  setStatus(`已定位 <${range.tag}>`);
  reply(true, undefined, range.tag);
}

async function openPreview(): Promise<void> {
  const workspaceId = bridge.workspaceId;
  if (!ref) {
    setStatus('缺少资源地址', 'error');
    return;
  }
  if (!workspaceId || !editor) {
    setStatus('缺少窗口上下文', 'error');
    return;
  }

  cancelLivePreview();
  const url = await ensurePreviewUrl();
  if (!url) return;

  const previewPageUrl = `plugin://${PLUGIN_ID}/content/preview.html?ref=${encodeURIComponent(ref)}`;
  setStatus('打开预览…');
  const opened = await bridge.command(
    'shell',
    `${workspaceId}/views`,
    'open',
    {
      id: previewId,
      type: 'page',
      title: `预览 · ${fileName(ref)}`,
      url: previewPageUrl,
    },
  );
  if (!opened.ok) {
    setStatus(`无法打开预览：${opened.error.message}`, 'error');
    return;
  }

  setStatus('预览已打开');
}

function updatePosition(view?: EditorView): void {
  if (!view) return;
  const state = view.state;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const selected = state.selection.ranges.reduce(
    (sum, range) => sum + (range.to - range.from),
    0,
  );
  const column = head - line.from + 1;
  positionEl.textContent =
    selected > 0
      ? `行 ${line.number}, 列 ${column} · 已选 ${selected}`
      : `行 ${line.number}, 列 ${column}`;
  countEl.textContent = `${state.doc.length.toLocaleString('zh-CN')} 字符 · ${state.doc.lines.toLocaleString('zh-CN')} 行`;
}

function syncToggle(button: HTMLButtonElement, value: boolean): void {
  button.setAttribute('aria-pressed', value ? 'true' : 'false');
}

function applySettings(value: unknown): void {
  settings = normalizeSettings(value);
  editor?.setSettings(settings);
  syncToggle(wrapButton, settings.lineWrap);
  syncToggle(linesButton, settings.lineNumbers);
  if (!settings.livePreview) cancelLivePreview();
}

function toggleSetting(key: 'lineWrap' | 'lineNumbers'): void {
  const previous = settings;
  const next: EditorSettings = {
    ...settings,
    [key]: !settings[key],
  };
  settings = next;
  editor?.setSettings(next);
  syncToggle(key === 'lineWrap' ? wrapButton : linesButton, next[key]);

  void bridge
    .command(PLUGIN_ID, 'settings', 'set', { [key]: next[key] })
    .then((result) => {
      if (!result.ok) throw new Error(result.error.message);
    })
    .catch((error: unknown) => {
      settings = previous;
      editor?.setSettings(previous);
      syncToggle(
        key === 'lineWrap' ? wrapButton : linesButton,
        previous[key],
      );
      setStatus(error instanceof Error ? error.message : String(error), 'error');
    });
}

const initialHostTheme = document.documentElement.dataset['theme'];
let hostTheme: ThemeMode | null =
  initialHostTheme === 'dark' || initialHostTheme === 'light'
    ? initialHostTheme
    : null;
let currentTheme: ThemeMode = 'light';

function preferredTheme(): ThemeMode {
  if (hostTheme) return hostTheme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function applyTheme(): void {
  const theme = preferredTheme();
  currentTheme = theme;
  document.documentElement.dataset['theme'] = theme;
  editor?.setTheme(theme);
}

const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
mediaQuery.addEventListener('change', applyTheme);

const themeObserver = new MutationObserver(() => {
  const value = document.documentElement.dataset['theme'];
  if (value !== 'dark' && value !== 'light') return;
  if (value === currentTheme) return;
  hostTheme = value;
  currentTheme = value;
  editor?.setTheme(value);
});
themeObserver.observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['data-theme'],
});

channel.onmessage = (event) => {
  const message = event.data as EditorChannelMessage | null;
  if (!message || typeof message !== 'object' || message.ref !== ref) return;
  if (message.type === 'preview-ready') {
    previewOpen = true;
    void handlePreviewReady();
    return;
  }
  if (message.type === 'preview-closed') {
    previewOpen = false;
    cancelLivePreview();
    return;
  }
  if (message.type === 'preview-refresh') {
    void ensurePreviewUrl();
    return;
  }
  if (message.type === 'pick') {
    handlePick(message);
  }
};

async function boot(): Promise<void> {
  const name = fileName(ref);
  titleEl.textContent = name;
  titleEl.title = ref || 'HTML';
  document.title = name;
  applyTheme();

  let initial: unknown = null;
  let loadFailed = false;
  if (ref) {
    try {
      initial = await bridge.subscribe('workspace', ref);
    } catch (error) {
      loadFailed = true;
      setStatus(error instanceof Error ? error.message : String(error), 'error');
    }
  } else {
    setStatus('缺少资源地址', 'error');
  }

  const initialText = extractText(initial) ?? '';
  content = initialText;
  savedText = initialText;
  if (ref && initial === null && !loadFailed) {
    setStatus('无法读取 HTML 资源', 'error');
  }

  editor = createHtmlEditor({
    parent: editorHost,
    value: initialText,
    theme: preferredTheme(),
    settings,
    onChange(text) {
      content = text;
      dirty = text !== savedText;
      updateDirty();
      if (!saving) {
        setStatus(dirty ? '未保存' : '就绪', dirty ? 'warning' : 'ok');
        if (settings.livePreview && previewOpen && previewUrl) {
          scheduleLivePreview();
        }
      }
    },
    onSave: () => {
      void save();
    },
    onPreview: () => {
      void openPreview();
    },
    onUpdate(view) {
      updatePosition(view);
    },
  });

  const offUpdate = bridge.onUpdate((update) => {
    if (update.domain === 'workspace' && update.resource === ref) {
      if (update.type === 'snapshot') applySnapshot(update.data);
      return;
    }
    if (update.domain === 'workspace' && update.resource === 'registry') {
      if (update.type === 'snapshot') applyWorkspaceRegistry(update.data);
      return;
    }
    if (update.domain === PLUGIN_ID && update.resource === 'settings') {
      applySettings(update.data);
      return;
    }
  });

  updateDirty();
  updatePosition(editor.view);
  if (ref && initialText) setStatus('已加载');

  try {
    applySettings(await bridge.subscribe(PLUGIN_ID, 'settings'));
  } catch {
    applySettings(settings);
  }

  await watchWorkspaceRegistry();
  bootReady = true;
  channel.postMessage({ type: 'editor-ready', ref });

  undoButton.addEventListener('click', () => {
    if (!editor) return;
    undo(editor.view);
    editor.focus();
  });
  redoButton.addEventListener('click', () => {
    if (!editor) return;
    redo(editor.view);
    editor.focus();
  });
  searchButton.addEventListener('click', () => {
    if (!editor) return;
    openSearchPanel(editor.view);
  });
  wrapButton.addEventListener('click', () => toggleSetting('lineWrap'));
  linesButton.addEventListener('click', () => toggleSetting('lineNumbers'));
  previewButton.addEventListener('click', () => void openPreview());
  saveButton.addEventListener('click', () => void save());

  conflictReload.addEventListener('click', () => {
    if (conflictText === null) return;
    const text = conflictText;
    applyText(text);
    setStatus('已重新加载');
  });
  conflictKeep.addEventListener('click', () => {
    conflictText = null;
    showConflict();
    setStatus('保留当前修改', 'warning');
  });

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    if (!(event.metaKey || event.ctrlKey)) return;
    const key = event.key.toLowerCase();
    if (key === 's') {
      event.preventDefault();
      void save();
      return;
    }
    if (key === 'v' && event.shiftKey) {
      event.preventDefault();
      void openPreview();
    }
  });

  window.addEventListener('beforeunload', () => {
    cancelLivePreview();
    channel.postMessage({ type: 'editor-closed', ref });
    channel.close();
    offUpdate();
    mediaQuery.removeEventListener('change', applyTheme);
    themeObserver.disconnect();
    if (ref) bridge.unsubscribe('workspace', ref);
    bridge.unsubscribe('workspace', 'registry');
    bridge.unsubscribe(PLUGIN_ID, 'settings');
    editor?.destroy();
    editor = null;
  });

  requestAnimationFrame(() => {
    if (document.hasFocus()) editor?.focus();
  });
}

void boot();
