/**
 * HTML 编辑页与预览页之间的跨视图通道。
 *
 * 两个页面都是 plugin://html-editor/content…，同源，所以用 BroadcastChannel。
 * 预览页 iframe 指向本地预览服务（不同 origin），iframe → 预览页用 postMessage，
 * 预览页 → 编辑页用这里定义的消息。
 */

export const HTML_EDITOR_CHANNEL = 'workstudio-html-editor';

export interface PreviewReadyMessage {
  type: 'preview-ready';
  ref: string;
}

export interface EditorReadyMessage {
  type: 'editor-ready';
  ref: string;
}

export interface PreviewUrlMessage {
  type: 'preview-url';
  ref: string;
  url: string;
}

export interface EditorClosedMessage {
  type: 'editor-closed';
  ref: string;
}

export interface PreviewClosedMessage {
  type: 'preview-closed';
  ref: string;
}

export interface PreviewRefreshMessage {
  type: 'preview-refresh';
  ref: string;
}

export interface PreviewErrorMessage {
  type: 'preview-error';
  ref: string;
  message: string;
}

export interface PickMessage {
  type: 'pick';
  ref: string;
  /** 从 <html> 开始的元素 child 索引链。 */
  path: number[];
  /** 与 path 对齐的标签名，用于校验 DOM 与源码树是否一致。 */
  tags: string[];
  /** 产生这次 pick 的预览地址；用于判断预览是否已经过期。 */
  url: string;
}

export interface PickResultMessage {
  type: 'pick-result';
  ref: string;
  ok: boolean;
  tag?: string;
  reason?: 'stale' | 'not-found';
}

export type EditorChannelMessage =
  | PreviewReadyMessage
  | EditorReadyMessage
  | PreviewUrlMessage
  | EditorClosedMessage
  | PreviewClosedMessage
  | PreviewRefreshMessage
  | PreviewErrorMessage
  | PickMessage
  | PickResultMessage;

export function createEditorChannel(): BroadcastChannel {
  return new BroadcastChannel(HTML_EDITOR_CHANNEL);
}
