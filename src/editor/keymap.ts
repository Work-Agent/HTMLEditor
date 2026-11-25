import {
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete';
import {
  defaultKeymap,
  historyKeymap,
  indentWithTab,
  moveLineDown,
  moveLineUp,
  toggleComment,
} from '@codemirror/commands';
import { foldKeymap } from '@codemirror/language';
import { searchKeymap } from '@codemirror/search';
import { keymap } from '@codemirror/view';

export interface KeymapOptions {
  onSave(): void;
  onPreview(): void;
}

/** 编辑区快捷键。保存 / 预览优先于默认键位。 */
export function createKeymap(options: KeymapOptions) {
  return keymap.of([
    {
      key: 'Mod-s',
      run: () => {
        options.onSave();
        return true;
      },
    },
    {
      key: 'Mod-Shift-v',
      run: () => {
        options.onPreview();
        return true;
      },
    },
    { key: 'Mod-/', run: toggleComment },
    { key: 'Mod-Shift-ArrowUp', run: moveLineUp },
    { key: 'Mod-Shift-ArrowDown', run: moveLineDown },
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...historyKeymap,
    ...searchKeymap,
    ...foldKeymap,
    ...completionKeymap,
    indentWithTab,
  ]);
}
