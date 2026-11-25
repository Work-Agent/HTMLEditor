import { parse } from 'parse5';

interface SourceElement {
  tag: string;
  /** 隐式节点（如 tbody）没有源码位置；保留节点以维持 child 索引对齐。 */
  from: number | null;
  to: number | null;
  children: SourceElement[];
}

interface ParseNode {
  nodeName?: string;
  tagName?: string;
  childNodes?: ParseNode[];
  sourceCodeLocation?: {
    startOffset: number;
    endOffset: number;
  } | null;
}

export interface SourceRange {
  from: number;
  to: number;
  tag: string;
}

function elementChildren(node: ParseNode): ParseNode[] {
  return (node.childNodes ?? []).filter(
    (child) => typeof child.tagName === 'string',
  );
}

function findElement(
  node: ParseNode,
  tag: string,
): ParseNode | null {
  if ((node.tagName ?? '').toLowerCase() === tag) return node;
  for (const child of node.childNodes ?? []) {
    const found = findElement(child, tag);
    if (found) return found;
  }
  return null;
}

function toSourceElement(node: ParseNode): SourceElement | null {
  const tag = node.tagName;
  if (!tag) return null;
  const location = node.sourceCodeLocation;
  const children: SourceElement[] = [];
  for (const child of elementChildren(node)) {
    const item = toSourceElement(child);
    if (item) children.push(item);
  }
  return {
    tag: tag.toLowerCase(),
    from: location ? location.startOffset : null,
    to: location ? location.endOffset : null,
    children,
  };
}

function buildIndex(html: string): SourceElement | null {
  const document = parse(html, {
    sourceCodeLocationInfo: true,
  }) as unknown as ParseNode;
  const root = findElement(document, 'html');
  if (!root) return null;
  return toSourceElement(root);
}

/**
 * 把 iframe 中的 element-child 路径映射回源码区间。
 * parse5 的隐式节点（tbody 等）与浏览器一致；没有 location 的节点返回 null。
 */
export function locateElementPath(
  html: string,
  path: number[],
  tags?: string[],
): SourceRange | null {
  if (!Array.isArray(path) || path.length > 64) return null;
  let current: SourceElement | null = buildIndex(html);
  if (!current) return null;

  for (let index = 0; index < path.length; index += 1) {
    const step = path[index];
    if (step === undefined || !Number.isInteger(step) || step < 0) {
      return null;
    }
    const next: SourceElement | undefined = current.children[step];
    if (!next) return null;
    const expected = tags?.[index];
    if (expected && next.tag.toLowerCase() !== String(expected).toLowerCase()) {
      return null;
    }
    current = next;
  }

  if (current.from === null || current.to === null) return null;

  return {
    from: current.from,
    to: current.to,
    tag: current.tag,
  };
}
