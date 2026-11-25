import {
  HighlightStyle,
  syntaxHighlighting,
} from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { EditorView } from '@codemirror/view';

/** CodeMirror 主题。颜色全部走 CSS 变量，页面切浅色 / 深色时不需要重建编辑器。 */
export function editorTheme(dark: boolean) {
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        color: 'var(--he-fg)',
        backgroundColor: 'var(--he-bg)',
      },
      '&.cm-focused': {
        outline: 'none',
      },
      '.cm-scroller': {
        fontFamily: 'var(--he-font-mono)',
        fontSize: 'var(--he-font-size)',
        lineHeight: '1.68',
        overflow: 'auto',
      },
      '.cm-content': {
        padding: '18px 0 24px',
        caretColor: 'var(--he-accent)',
      },
      '.cm-line': {
        padding: '0 20px 0 10px',
      },
      '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: 'var(--he-accent)',
      },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection':
        {
          backgroundColor: 'var(--he-selection)',
        },
      '.cm-activeLine': {
        backgroundColor: 'var(--he-active-line)',
      },
      '.cm-gutters': {
        backgroundColor: 'var(--he-bg)',
        color: 'var(--he-gutter-fg)',
        border: 'none',
        borderRight: '1px solid var(--he-border)',
        paddingLeft: '6px',
      },
      '.cm-lineNumbers .cm-gutterElement': {
        minWidth: '28px',
        padding: '0 10px 0 12px',
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'var(--he-active-line)',
        color: 'var(--he-fg)',
      },
      '.cm-foldGutter .cm-gutterElement': {
        color: 'var(--he-muted)',
        padding: '0 4px',
      },
      '.cm-foldGutter .cm-gutterElement:hover': {
        color: 'var(--he-accent)',
      },
      '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
        backgroundColor: 'var(--he-accent-soft)',
        outline: '1px solid var(--he-accent)',
      },
      '.cm-nonmatchingBracket': {
        color: 'var(--he-danger)',
      },
      '.cm-panels': {
        backgroundColor: 'var(--he-panel)',
        color: 'var(--he-fg)',
        borderColor: 'var(--he-border)',
      },
      '.cm-panels.cm-panels-top': {
        borderBottom: '1px solid var(--he-border)',
      },
      '.cm-panels.cm-panels-bottom': {
        borderTop: '1px solid var(--he-border)',
      },
      '.cm-panel.cm-search': {
        padding: '8px 10px',
        fontFamily: 'var(--he-font)',
        fontSize: '12px',
      },
      '.cm-panel.cm-search input, .cm-panel.cm-search button': {
        fontFamily: 'var(--he-font)',
        fontSize: '12px',
      },
      '.cm-panel.cm-search input': {
        backgroundColor: 'var(--he-input-bg)',
        color: 'var(--he-fg)',
        border: '1px solid var(--he-border)',
        borderRadius: '5px',
        padding: '3px 7px',
      },
      '.cm-panel.cm-search button': {
        backgroundColor: 'var(--he-button-bg)',
        color: 'var(--he-fg)',
        border: '1px solid var(--he-border)',
        borderRadius: '5px',
      },
      '.cm-panel.cm-search button:hover': {
        borderColor: 'var(--he-accent)',
        color: 'var(--he-accent)',
      },
      '.cm-searchMatch': {
        backgroundColor: 'var(--he-search-match)',
        outline: '1px solid var(--he-accent)',
      },
      '.cm-searchMatch.cm-searchMatch-selected': {
        backgroundColor: 'var(--he-search-selected)',
      },
      '.cm-selectionMatch': {
        backgroundColor: 'var(--he-accent-soft)',
      },
      '.cm-tooltip': {
        backgroundColor: 'var(--he-panel)',
        color: 'var(--he-fg)',
        border: '1px solid var(--he-border)',
        borderRadius: '8px',
        boxShadow: 'var(--he-shadow)',
      },
      '.cm-tooltip-autocomplete > ul': {
        maxHeight: '280px',
        fontFamily: 'var(--he-font-mono)',
        fontSize: '12px',
      },
      '.cm-tooltip-autocomplete > ul > li': {
        padding: '3px 8px',
      },
      '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
        backgroundColor: 'var(--he-accent-soft)',
        color: 'var(--he-fg)',
      },
      '.cm-tooltip-autocomplete .cm-completionDetail': {
        color: 'var(--he-muted)',
        fontStyle: 'normal',
        marginLeft: '12px',
      },
      '.cm-completionIcon': {
        color: 'var(--he-muted)',
      },
      '.cm-foldPlaceholder': {
        backgroundColor: 'var(--he-panel)',
        border: '1px solid var(--he-border)',
        color: 'var(--he-muted)',
      },
      '.cm-placeholder': {
        color: 'var(--he-muted)',
        fontStyle: 'normal',
      },
    },
    { dark },
  );
}

const htmlHighlightStyle = HighlightStyle.define([
  { tag: tags.tagName, color: 'var(--he-tag)' },
  { tag: tags.attributeName, color: 'var(--he-attr)' },
  {
    tag: [tags.attributeValue, tags.string, tags.special(tags.string)],
    color: 'var(--he-string)',
  },
  { tag: [tags.angleBracket, tags.bracket, tags.squareBracket], color: 'var(--he-punct)' },
  { tag: [tags.punctuation, tags.operator], color: 'var(--he-punct)' },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
    color: 'var(--he-comment)',
    fontStyle: 'italic',
  },
  { tag: [tags.number, tags.bool], color: 'var(--he-number)' },
  { tag: [tags.keyword, tags.operatorKeyword], color: 'var(--he-keyword)' },
  {
    tag: [tags.documentMeta, tags.processingInstruction, tags.meta],
    color: 'var(--he-meta)',
  },
  { tag: [tags.propertyName, tags.className, tags.labelName], color: 'var(--he-attr)' },
  { tag: [tags.typeName, tags.definitionKeyword], color: 'var(--he-tag)' },
  { tag: tags.variableName, color: 'var(--he-fg)' },
  { tag: [tags.link, tags.url], color: 'var(--he-link)' },
  { tag: tags.strong, fontWeight: '650' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.invalid, color: 'var(--he-danger)' },
]);

export const htmlHighlighting = syntaxHighlighting(htmlHighlightStyle);
