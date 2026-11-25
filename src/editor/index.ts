import { Compartment, EditorState, Transaction } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  lineNumbers,
  placeholder,
  scrollPastEnd,
} from '@codemirror/view';
import { history } from '@codemirror/commands';
import {
  bracketMatching,
  foldGutter,
  indentOnInput,
  indentUnit,
} from '@codemirror/language';
import { html } from '@codemirror/lang-html';
import { autocompletion, closeBrackets } from '@codemirror/autocomplete';
import { highlightSelectionMatches, search } from '@codemirror/search';
import { createKeymap } from './keymap';
import { editorTheme, htmlHighlighting } from './theme';
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  type EditorSettings,
} from './settings';

export type ThemeMode = 'light' | 'dark';

export interface HtmlEditorOptions {
  parent: HTMLElement;
  value: string;
  theme: ThemeMode;
  settings?: EditorSettings;
  onChange(text: string): void;
  onSave(): void;
  onPreview(): void;
  onUpdate?(view: EditorView): void;
}

export interface HtmlEditorHandle {
  view: EditorView;
  getValue(): string;
  setValue(value: string, options?: { addToHistory?: boolean }): void;
  setSettings(settings: EditorSettings): void;
  setTheme(theme: ThemeMode): void;
  focus(): void;
  destroy(): void;
}

function applySettingsToHost(
  host: HTMLElement,
  settings: EditorSettings,
): void {
  host.style.setProperty('--he-font-size', `${settings.fontSize}px`);
}

function reconfigureSettings(
  wrapCompartment: Compartment,
  lineNumbersCompartment: Compartment,
  settings: EditorSettings,
) {
  return [
    wrapCompartment.reconfigure(
      settings.lineWrap ? EditorView.lineWrapping : [],
    ),
    lineNumbersCompartment.reconfigure(
      settings.lineNumbers
        ? [lineNumbers(), highlightActiveLineGutter()]
        : [],
    ),
  ];
}

export function createHtmlEditor(options: HtmlEditorOptions): HtmlEditorHandle {
  const themeCompartment = new Compartment();
  const wrapCompartment = new Compartment();
  const lineNumbersCompartment = new Compartment();

  let settings = normalizeSettings(options.settings ?? DEFAULT_SETTINGS);
  let applying = false;

  applySettingsToHost(options.parent, settings);
  options.parent.dataset['theme'] = options.theme;

  const extensions = [
    EditorState.tabSize.of(2),
    EditorState.allowMultipleSelections.of(true),
    highlightSpecialChars(),
    drawSelection(),
    dropCursor(),
    highlightActiveLine(),
    history(),
    bracketMatching(),
    indentOnInput(),
    indentUnit.of('  '),
    html({
      matchClosingTags: true,
      selfClosingTags: true,
      autoCloseTags: true,
    }),
    htmlHighlighting,
    themeCompartment.of(editorTheme(options.theme === 'dark')),
    wrapCompartment.of(settings.lineWrap ? EditorView.lineWrapping : []),
    lineNumbersCompartment.of(
      settings.lineNumbers
        ? [lineNumbers(), highlightActiveLineGutter()]
        : [],
    ),
    foldGutter(),
    search({ top: true }),
    highlightSelectionMatches(),
    autocompletion({
      activateOnTyping: true,
      closeOnBlur: true,
      icons: false,
      maxRenderedOptions: 40,
    }),
    closeBrackets(),
    placeholder('<!doctype html>\n<html lang="zh-CN">…'),
    EditorView.contentAttributes.of({
      'aria-label': 'HTML 源码',
      spellcheck: 'false',
      autocorrect: 'off',
      autocapitalize: 'off',
    }),
    scrollPastEnd(),
    createKeymap({
      onSave: () => options.onSave(),
      onPreview: () => options.onPreview(),
    }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !applying) {
        options.onChange(update.state.doc.toString());
      }
      if (update.docChanged || update.selectionSet || update.focusChanged) {
        options.onUpdate?.(update.view);
      }
    }),
  ];

  const view = new EditorView({
    state: EditorState.create({
      doc: options.value,
      extensions,
    }),
    parent: options.parent,
  });

  const setValue: HtmlEditorHandle['setValue'] = (value, opts) => {
    if (view.state.doc.toString() === value) return;
    const scrollTop = view.scrollDOM.scrollTop;
    applying = true;
    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        selection: { anchor: 0 },
        ...(opts?.addToHistory === false
          ? { annotations: Transaction.addToHistory.of(false) }
          : {}),
      });
    } finally {
      applying = false;
    }
    requestAnimationFrame(() => {
      view.scrollDOM.scrollTop = Math.min(
        scrollTop,
        Math.max(0, view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight),
      );
    });
  };

  const setSettings: HtmlEditorHandle['setSettings'] = (next) => {
    settings = normalizeSettings(next);
    applySettingsToHost(options.parent, settings);
    view.dispatch({
      effects: reconfigureSettings(
        wrapCompartment,
        lineNumbersCompartment,
        settings,
      ),
    });
    view.requestMeasure();
  };

  const setTheme: HtmlEditorHandle['setTheme'] = (theme) => {
    options.parent.dataset['theme'] = theme;
    view.dispatch({
      effects: themeCompartment.reconfigure(editorTheme(theme === 'dark')),
    });
  };

  return {
    view,
    getValue: () => view.state.doc.toString(),
    setValue,
    setSettings,
    setTheme,
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}

export type { EditorSettings };
export { DEFAULT_SETTINGS, normalizeSettings } from './settings';
