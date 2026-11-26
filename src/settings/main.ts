import '@work-studio/sdk/global';
import './style.css';

import {
  clampFontSize,
  DEFAULT_SETTINGS,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  normalizeSettings,
  type EditorSettings,
} from '../editor/settings';

const PLUGIN_ID = 'html-editor';
const bridge = window.workStudio;
const app = document.querySelector<HTMLDivElement>('#app');

let settings: EditorSettings = { ...DEFAULT_SETTINGS };
let booted = false;

function node<T extends HTMLElement>(selector: string): T | null {
  return app?.querySelector<T>(selector) ?? null;
}

function setStatus(text: string, error = false): void {
  const status = node<HTMLSpanElement>('#status');
  if (!status) return;
  status.textContent = text;
  status.classList.toggle('is-error', error);
}

function syncInputs(): void {
  const wrap = node<HTMLInputElement>('#lineWrap');
  if (wrap) wrap.checked = settings.lineWrap;

  const lines = node<HTMLInputElement>('#lineNumbers');
  if (lines) lines.checked = settings.lineNumbers;

  const live = node<HTMLInputElement>('#livePreview');
  if (live) live.checked = settings.livePreview;

  const size = node<HTMLInputElement>('#fontSize');
  if (size && document.activeElement !== size) {
    size.value = String(settings.fontSize);
  }

  const hint = node<HTMLSpanElement>('#fontSizeHint');
  if (hint) hint.textContent = `${settings.fontSize} px`;
}

function apply(value: unknown): void {
  settings = normalizeSettings(value);
  syncInputs();
}

function savePatch(patch: Partial<EditorSettings>): void {
  const previous = settings;
  settings = normalizeSettings({ ...settings, ...patch });
  syncInputs();

  void bridge
    .command(PLUGIN_ID, 'settings', 'set', patch)
    .then((result) => {
      if (!result.ok) throw new Error(result.error.message);
      setStatus('已保存');
    })
    .catch((error: unknown) => {
      settings = previous;
      syncInputs();
      setStatus(
        error instanceof Error ? error.message : String(error),
        true,
      );
    });
}

function reset(): void {
  const previous = settings;
  settings = { ...DEFAULT_SETTINGS };
  syncInputs();

  void bridge
    .command(PLUGIN_ID, 'settings', 'set', settings)
    .then((result) => {
      if (!result.ok) throw new Error(result.error.message);
      setStatus('已恢复默认');
    })
    .catch((error: unknown) => {
      settings = previous;
      syncInputs();
      setStatus(
        error instanceof Error ? error.message : String(error),
        true,
      );
    });
}

function render(): void {
  if (!app) return;
  app.innerHTML = `
    <header class="head">
      <span class="badge" aria-hidden="true">&lt;/&gt;</span>
      <div>
        <h1>HTML 编辑器</h1>
        <p>代码编辑、保存与浏览器预览</p>
      </div>
    </header>

    <section class="card" aria-label="编辑器设置">
      <div class="row">
        <label for="lineWrap">
          <span>自动换行</span>
          <small>长行在编辑器中折行显示，不改变 HTML 内容。</small>
        </label>
        <input id="lineWrap" class="switch" type="checkbox" />
      </div>

      <div class="row">
        <label for="lineNumbers">
          <span>显示行号</span>
          <small>在编辑器左侧显示行号。</small>
        </label>
        <input id="lineNumbers" class="switch" type="checkbox" />
      </div>

      <div class="row">
        <label for="livePreview">
          <span>输入时自动刷新预览</span>
          <small>停止输入约 450ms 后更新预览；关闭时只在保存 / 刷新时更新。</small>
        </label>
        <input id="livePreview" class="switch" type="checkbox" />
      </div>

      <div class="row">
        <label for="fontSize">
          <span>字号</span>
          <small>${MIN_FONT_SIZE} – ${MAX_FONT_SIZE} px</small>
        </label>
        <div style="display:flex;align-items:center;gap:10px;">
          <span id="fontSizeHint" class="value">${settings.fontSize} px</span>
          <input
            id="fontSize"
            type="number"
            min="${MIN_FONT_SIZE}"
            max="${MAX_FONT_SIZE}"
            step="1"
            value="${settings.fontSize}"
          />
        </div>
      </div>
    </section>

    <div class="actions">
      <button id="reset" type="button">恢复默认</button>
      <span id="status" class="status">设置会保存到插件数据目录。</span>
    </div>

    <p class="note">
      预览通过本地预览服务加载当前编辑内容（包括未保存的修改），相对资源从磁盘读取；
      保存或外部更新后会自动刷新。页面脚本会在预览标签中执行，请只预览可信文件。
    </p>`;

  node<HTMLInputElement>('#lineWrap')?.addEventListener('change', (event) => {
    savePatch({ lineWrap: (event.target as HTMLInputElement).checked });
  });

  node<HTMLInputElement>('#lineNumbers')?.addEventListener(
    'change',
    (event) => {
      savePatch({
        lineNumbers: (event.target as HTMLInputElement).checked,
      });
    },
  );

  node<HTMLInputElement>('#livePreview')?.addEventListener(
    'change',
    (event) => {
      savePatch({
        livePreview: (event.target as HTMLInputElement).checked,
      });
    },
  );

  const size = node<HTMLInputElement>('#fontSize');
  size?.addEventListener('change', () => {
    const value = Number(size.value);
    if (!Number.isFinite(value)) {
      size.value = String(settings.fontSize);
      return;
    }
    const next = clampFontSize(value);
    size.value = String(next);
    if (next === settings.fontSize) return;
    savePatch({ fontSize: next });
  });

  node<HTMLButtonElement>('#reset')?.addEventListener('click', reset);

  syncInputs();
}

render();

void bridge
  .subscribe(PLUGIN_ID, 'settings')
  .then((value) => {
    booted = true;
    apply(value);
  })
  .catch(() => {
    booted = true;
    syncInputs();
  });

bridge.onUpdate((update) => {
  if (
    !booted ||
    update.domain !== PLUGIN_ID ||
    update.resource !== 'settings'
  ) {
    return;
  }
  apply(update.data);
});

window.addEventListener('beforeunload', () => {
  bridge.unsubscribe(PLUGIN_ID, 'settings');
});
