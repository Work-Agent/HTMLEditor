/** HTML 编辑器设置：页面与设置页共用同一套归一化逻辑。 */

export interface EditorSettings {
  /** 长行自动折行 */
  lineWrap: boolean;
  /** 左侧行号 */
  lineNumbers: boolean;
  /** 编辑器字号 px */
  fontSize: number;
  /** 输入停止后自动刷新预览 */
  livePreview: boolean;
}

export const DEFAULT_SETTINGS: EditorSettings = {
  lineWrap: true,
  lineNumbers: true,
  fontSize: 13,
  livePreview: false,
};

export const MIN_FONT_SIZE = 11;
export const MAX_FONT_SIZE = 20;

export function clampFontSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SETTINGS.fontSize;
  return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(value)));
}

export function normalizeSettings(value: unknown): EditorSettings {
  const source =
    typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : {};
  return {
    lineWrap:
      typeof source['lineWrap'] === 'boolean'
        ? source['lineWrap']
        : DEFAULT_SETTINGS.lineWrap,
    lineNumbers:
      typeof source['lineNumbers'] === 'boolean'
        ? source['lineNumbers']
        : DEFAULT_SETTINGS.lineNumbers,
    fontSize:
      typeof source['fontSize'] === 'number'
        ? clampFontSize(source['fontSize'])
        : DEFAULT_SETTINGS.fontSize,
    livePreview:
      typeof source['livePreview'] === 'boolean'
        ? source['livePreview']
        : DEFAULT_SETTINGS.livePreview,
  };
}
