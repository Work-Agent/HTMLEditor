/**
 * 本地预览服务：只读静态文件 + 会话 token + SSE 热刷新。
 *
 * 为什么放在 engine：
 * - file:// 页面拿不到 module / fetch / service worker 所需的正常 origin；
 * - 本地 http 服务可以按工作区根目录提供真实相对路径与绝对路径；
 * - 保存或外部更新时通过 SSE 让预览页 reload。
 *
 * 安全边界：
 * - 只绑定 127.0.0.1，随机端口；
 * - 首次带短时 ticket 访问后写入 HttpOnly / SameSite=None; Secure cookie；
 *   预览页用跨站 iframe 嵌入本地服务，SameSite=Strict 不会在 iframe 中发送。
 * - 只读 GET/HEAD，无目录列表，无 CORS；
 * - 限制在工作区根目录内，realpath 防符号链接逃逸；
 * - 屏蔽 dotfile、node_modules、.git 等目录。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, type Stats } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_HTML_BYTES = 8 * 1024 * 1024;
const TOKEN_TTL_SECONDS = 12 * 60 * 60;
const TICKET_TTL_MS = 5 * 60 * 1000;
const KEEPALIVE_MS = 20_000;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.weba': 'audio/webm',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
};

const ALLOWED = new Set(Object.keys(MIME));

const BLOCKED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.cache',
  '.next',
  '.nuxt',
  '.turbo',
  '.idea',
  '.vscode',
  'node_modules',
]);

const PREVIEW_SCRIPT = `
(() => {
  if (window.__WORKSTUDIO_PREVIEW__) return;
  window.__WORKSTUDIO_PREVIEW__ = true;

  const inFrame = window.parent !== window;
  const send = (message) => {
    if (!inFrame) return;
    try { window.parent.postMessage(message, '*'); } catch {}
  };

  const source = new EventSource(
    location.origin + '/__events?path=' + encodeURIComponent(location.pathname)
  );
  let reloadTimer = 0;
  source.addEventListener('reload', () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => location.reload(), 100);
  });

  send({ type: 'workstudio-page-start' });

  const buffer = [];
  let flushTimer = 0;
  const formatArg = (value) => {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.stack || value.message;
    try {
      const json = JSON.stringify(value);
      return json === undefined ? String(value) : json;
    } catch {
      return String(value);
    }
  };
  const flush = () => {
    flushTimer = 0;
    if (!inFrame) { buffer.length = 0; return; }
    if (!buffer.length) return;
    const entries = buffer.splice(0, 100);
    send({ type: 'workstudio-console', entries });
    if (buffer.length) flushTimer = setTimeout(flush, 120);
  };
  const queue = (level, args) => {
    if (!inFrame) return;
    buffer.push({ level, text: args.map(formatArg).join(' ') });
    if (!flushTimer) flushTimer = setTimeout(flush, 120);
  };
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level];
    if (typeof original !== 'function') continue;
    console[level] = (...args) => {
      queue(level, args);
      original.apply(console, args);
    };
  }
  window.addEventListener('error', (event) => {
    queue('error', [
      event.message + ' @ ' + (event.filename || '') + ':' +
      (event.lineno || 0) + ':' + (event.colno || 0)
    ]);
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    queue('error', [
      'Unhandled rejection: ' +
      (reason && reason.stack ? reason.stack : String(reason))
    ]);
  });

  if (!inFrame) return;

  let picking = false;
  let outline = null;
  const ensureOutline = () => {
    if (outline) return outline;
    outline = document.createElement('div');
    outline.setAttribute('data-workstudio-outline', '');
    outline.style.cssText =
      'position:fixed;pointer-events:none;z-index:2147483647;' +
      'border:2px solid #4f6bed;background:rgba(79,107,237,.12);' +
      'border-radius:2px;display:none;';
    (document.body || document.documentElement).appendChild(outline);
    return outline;
  };

  const tagPath = (target) => {
    const path = [];
    const tags = [];
    let node = target;
    while (node && node !== document.documentElement) {
      const parent = node.parentElement;
      if (!parent) return null;
      const index = Array.prototype.indexOf.call(parent.children, node);
      if (index < 0) return null;
      path.unshift(index);
      tags.unshift((node.tagName || '').toLowerCase());
      node = parent;
    }
    if (node !== document.documentElement) return null;
    return { path, tags };
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || data.type !== 'workstudio-pick-mode') return;
    picking = data.enabled === true;
    if (!picking && outline) outline.style.display = 'none';
  });

  document.addEventListener('mousemove', (event) => {
    if (!picking) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const rect = target.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    const box = ensureOutline();
    box.style.display = 'block';
    box.style.left = rect.left + 'px';
    box.style.top = rect.top + 'px';
    box.style.width = rect.width + 'px';
    box.style.height = rect.height + 'px';
  }, true);

  document.addEventListener('click', (event) => {
    if (!picking) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const info = tagPath(target);
    if (!info) return;
    event.preventDefault();
    event.stopPropagation();
    send({ type: 'workstudio-pick', path: info.path, tags: info.tags });
  }, true);

  document.addEventListener('mouseleave', () => {
    if (outline) outline.style.display = 'none';
  }, true);

  send({ type: 'workstudio-preview-ready' });
})();
`;

export interface PreviewStartInput {
  ref: string;
  /** 工作区根目录；缺省时退回 HTML 所在目录。 */
  root?: string;
  /** 未保存的当前编辑内容；提供时作为 overlay 服务。 */
  content?: string;
}

export interface PreviewStartResult {
  url: string;
  port: number;
  root: string;
}

export interface PreviewServers {
  start(input: PreviewStartInput): Promise<PreviewStartResult>;
  /** 更新 overlay 并广播 reload；没有对应服务时返回 false。 */
  update(ref: string, content: string): Promise<boolean>;
  /** 不改变 overlay，只广播 reload。 */
  broadcast(ref: string): Promise<boolean>;
  close(): void;
}

interface Entry {
  root: string;
  server: Server;
  port: number;
  token: string;
  tickets: Map<string, number>;
  cookie: string;
  clients: Map<ServerResponse, string>;
  overlay: Map<string, string>;
  /** 文件路径 → 预览 URL path；用于精确定位要刷新的 SSE 客户端。 */
  pages: Map<string, string>;
  keepalive: NodeJS.Timeout | null;
}

type RangeResult = { start: number; end: number } | 'invalid' | null;

function filePath(ref: string): string {
  try {
    return fileURLToPath(ref);
  } catch {
    throw new Error(`不是文件地址：${ref}`);
  }
}

function isWithin(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function baseHeaders(): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
}

function sendText(
  res: ServerResponse,
  status: number,
  text: string,
  head = false,
): void {
  const body = `${text}\n`;
  res.writeHead(status, {
    ...baseHeaders(),
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  if (head) res.end();
  else res.end(body);
}

function cookieValue(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const item = part.trim();
    const index = item.indexOf('=');
    if (index <= 0) continue;
    if (item.slice(0, index) === name) {
      return item.slice(index + 1);
    }
  }
  return null;
}

function injectPreviewScript(html: string, origin: string): string {
  const tag = `<script src="${origin}/__preview.js" data-workstudio-preview></script>`;
  // 注入到 <head> 最前面，保证页面自己的脚本执行前已经接管 console / 错误 /
  // SSE / pick。绝对 URL 不受页面 <base> 影响。
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (match) => `${match}\n${tag}`);
  }
  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(
      /<html\b[^>]*>/i,
      (match) => `${match}\n<head>${tag}</head>`,
    );
  }
  return `${tag}\n${html}`;
}

function parseRange(header: string | undefined, size: number): RangeResult {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return 'invalid';

  let start = match[1] === '' ? null : Number(match[1]);
  let end = match[2] === '' ? null : Number(match[2]);
  if (start === null && end === null) return 'invalid';

  if (start === null) {
    const suffix = end ?? 0;
    if (suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    end = end === null ? size - 1 : Math.min(end, size - 1);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid';
  if (start < 0 || start > end || start >= size) return 'invalid';
  return { start, end };
}

function broadcast(entry: Entry, pagePath?: string): void {
  for (const [client, path] of entry.clients) {
    if (pagePath && path !== pagePath) continue;
    try {
      client.write('event: reload\ndata: {}\n\n');
    } catch {
      entry.clients.delete(client);
    }
  }
}

async function isDirectory(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  return Boolean(info?.isDirectory());
}

export function createPreviewServers(): PreviewServers {
  const entries = new Map<string, Entry>();

  async function ensureEntry(base: string): Promise<Entry> {
    const root = await realpath(resolve(base)).catch(() => {
      throw new Error(`预览根目录不存在：${base}`);
    });
    const info = await stat(root).catch(() => null);
    if (!info?.isDirectory()) {
      throw new Error(`预览根目录不是目录：${base}`);
    }

    const existing = entries.get(root);
    if (existing) return existing;

    const token = randomBytes(24).toString('hex');
    const entry: Entry = {
      root,
      server: createServer(),
      port: 0,
      token,
      tickets: new Map(),
      cookie: '',
      clients: new Map(),
      overlay: new Map(),
      pages: new Map(),
      keepalive: null,
    };

    entry.server.on('request', (req, res) => {
      void handle(entry, req, res);
    });
    entry.server.on('clientError', (_error, socket) => {
      socket.destroy();
    });

    await new Promise<void>((done, fail) => {
      const onError = (error: Error): void => {
        entry.server.off('listening', onListening);
        fail(error);
      };
      const onListening = (): void => {
        entry.server.off('error', onError);
        done();
      };
      entry.server.once('error', onError);
      entry.server.once('listening', onListening);
      entry.server.listen(0, '127.0.0.1');
    });

    const address = entry.server.address();
    if (!address || typeof address === 'string') {
      entry.server.close();
      throw new Error('预览服务启动失败');
    }

    entry.port = address.port;
    entry.cookie = `ws_html_preview_${entry.port}`;
    entry.server.unref();

    entry.keepalive = setInterval(() => {
      for (const client of entry.clients.keys()) {
        try {
          client.write(': ping\n\n');
        } catch {
          entry.clients.delete(client);
        }
      }
    }, KEEPALIVE_MS);
    entry.keepalive.unref();

    entries.set(root, entry);
    return entry;
  }

  async function resolveFile(entry: Entry, target: string): Promise<string> {
    const real = await realpath(target).catch(() => null);
    return real ?? target;
  }

  function sendRedirect(
    entry: Entry,
    res: ServerResponse,
    url: URL,
  ): void {
    const clean = new URL(url.toString());
    clean.searchParams.delete('__preview_ticket');
    res.writeHead(302, {
      ...baseHeaders(),
      'Set-Cookie': `${entry.cookie}=${entry.token}; HttpOnly; SameSite=None; Secure; Path=/; Max-Age=${TOKEN_TTL_SECONDS}`,
      Location: `${clean.pathname}${clean.search}${clean.hash}`,
    });
    res.end();
  }

  function openEvents(
    entry: Entry,
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): void {
    res.writeHead(200, {
      ...baseHeaders(),
      'Cache-Control': 'no-cache, no-store',
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
    });
    res.setTimeout(0);
    res.write('retry: 1000\n\n');
    let pagePath = url.searchParams.get('path') ?? '/';
    // 目录 URL 由服务端映射到 index.html；SSE 也按 index.html 归一化，
    // 这样从 /dir/ 打开的页面和保存 /dir/index.html 能匹配。
    if (pagePath.endsWith('/')) pagePath += 'index.html';
    entry.clients.set(res, pagePath);
    req.on('close', () => entry.clients.delete(res));
  }

  function sendScript(head: boolean, res: ServerResponse): void {
    res.writeHead(200, {
      ...baseHeaders(),
      'Content-Type': 'text/javascript; charset=utf-8',
      'Content-Length': Buffer.byteLength(PREVIEW_SCRIPT),
    });
    if (head) res.end();
    else res.end(PREVIEW_SCRIPT);
  }

  async function serveStatic(
    entry: Entry,
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const head = req.method === 'HEAD';

    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      sendText(res, 400, 'Bad request', head);
      return;
    }

    if (pathname.includes('\0') || pathname.includes('\\')) {
      sendText(res, 400, 'Bad request', head);
      return;
    }

    const segments = pathname.split('/').filter(Boolean);
    for (const segment of segments) {
      if (
        segment.startsWith('.') ||
        BLOCKED_DIRS.has(segment) ||
        segment === 'node_modules'
      ) {
        sendText(res, 403, 'Forbidden', head);
        return;
      }
    }

    let target = resolve(entry.root, `.${pathname}`);
    if (!isWithin(entry.root, target)) {
      sendText(res, 403, 'Forbidden', head);
      return;
    }

    let info: Stats | null = await stat(target).catch(() => null);
    if (info?.isDirectory()) {
      if (!pathname.endsWith('/')) {
        res.writeHead(301, {
          ...baseHeaders(),
          Location: `${pathname}/${url.search}${url.hash}`,
        });
        res.end();
        return;
      }
      target = join(target, 'index.html');
      info = await stat(target).catch(() => null);
    }

    const realTarget = info ? await resolveFile(entry, target) : target;
    if (info && !isWithin(entry.root, realTarget)) {
      sendText(res, 403, 'Forbidden', head);
      return;
    }

    const overlay =
      entry.overlay.get(target) ?? entry.overlay.get(realTarget);

    if (!info && overlay === undefined) {
      sendText(res, 404, 'Not found', head);
      return;
    }
    if (info && !info.isFile()) {
      sendText(res, 403, 'Forbidden', head);
      return;
    }

    const ext = extname(target).toLowerCase();
    if (!ALLOWED.has(ext)) {
      sendText(res, 403, 'Forbidden', head);
      return;
    }

    if (ext === '.html' || ext === '.htm') {
      const small =
        overlay !== undefined ||
        (info?.size ?? 0) <= MAX_HTML_BYTES;
      if (!small) {
        // 超大 HTML 不注入 runtime，直接流式返回，避免把整页读进内存。
        const size = info?.size ?? 0;
        const range = parseRange(req.headers.range, size);
        if (range === 'invalid') {
          res.writeHead(416, {
            ...baseHeaders(),
            'Content-Range': `bytes */${size}`,
          });
          res.end();
          return;
        }
        if (range) {
          const length = range.end - range.start + 1;
          res.writeHead(206, {
            ...baseHeaders(),
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': length,
            'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
            'Accept-Ranges': 'bytes',
          });
          if (head) {
            res.end();
            return;
          }
          const stream = createReadStream(realTarget, range);
          stream.on('error', () => res.destroy());
          stream.pipe(res);
          return;
        }
        res.writeHead(200, {
          ...baseHeaders(),
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': size,
          'Accept-Ranges': 'bytes',
        });
        if (head) {
          res.end();
          return;
        }
        const stream = createReadStream(realTarget);
        stream.on('error', () => res.destroy());
        stream.pipe(res);
        return;
      }

      const dest = req.headers['sec-fetch-dest'];
      const shouldInject =
        dest === undefined ||
        dest === 'document' ||
        dest === 'iframe' ||
        dest === 'frame';
      const html = overlay ?? (await readFile(realTarget, 'utf8'));
      const origin = `http://${req.headers.host ?? `127.0.0.1:${entry.port}`}`;
      const body = shouldInject ? injectPreviewScript(html, origin) : html;
      res.writeHead(200, {
        ...baseHeaders(),
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      });
      if (head) res.end();
      else res.end(body);
      return;
    }

    if (overlay !== undefined) {
      const body = Buffer.from(overlay);
      res.writeHead(200, {
        ...baseHeaders(),
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        'Content-Length': body.byteLength,
      });
      if (head) res.end();
      else res.end(body);
      return;
    }

    const size = info?.size ?? 0;
    const range = parseRange(req.headers.range, size);
    if (range === 'invalid') {
      res.writeHead(416, {
        ...baseHeaders(),
        'Content-Range': `bytes */${size}`,
      });
      res.end();
      return;
    }

    if (range) {
      const length = range.end - range.start + 1;
      res.writeHead(206, {
        ...baseHeaders(),
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        'Content-Length': length,
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
        'Accept-Ranges': 'bytes',
      });
      if (head) {
        res.end();
        return;
      }
      const stream = createReadStream(realTarget, range);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
      return;
    }

    res.writeHead(200, {
      ...baseHeaders(),
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': size,
      'Accept-Ranges': 'bytes',
    });
    if (head) {
      res.end();
      return;
    }
    const stream = createReadStream(realTarget);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  async function handle(
    entry: Entry,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const host = req.headers.host;
      if (
        host !== `127.0.0.1:${entry.port}` &&
        host !== `localhost:${entry.port}`
      ) {
        sendText(res, 403, 'Invalid host');
        return;
      }

      const url = new URL(
        req.url ?? '/',
        `http://127.0.0.1:${entry.port}`,
      );
      const ticket = url.searchParams.get('__preview_ticket');

      if (ticket) {
        const expires = entry.tickets.get(ticket);
        if (expires === undefined || expires < Date.now()) {
          entry.tickets.delete(ticket);
          sendText(res, 403, 'Forbidden');
          return;
        }
        sendRedirect(entry, res, url);
        return;
      }

      const cookie = cookieValue(req, entry.cookie);
      if (!cookie || !safeEqual(cookie, entry.token)) {
        sendText(res, 403, 'Forbidden');
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendText(res, 405, 'Method not allowed');
        return;
      }

      if (url.pathname === '/__preview.js') {
        sendScript(req.method === 'HEAD', res);
        return;
      }
      if (url.pathname === '/__events') {
        openEvents(entry, req, res, url);
        return;
      }

      await serveStatic(entry, req, res, url);
    } catch (error) {
      if (!res.headersSent) {
        sendText(
          res,
          500,
          error instanceof Error ? error.message : 'Preview server error',
        );
      } else {
        res.destroy();
      }
    }
  }

  function closeEntry(entry: Entry): void {
    if (entry.keepalive) clearInterval(entry.keepalive);
    entry.keepalive = null;
    for (const client of entry.clients.keys()) {
      try {
        client.end();
      } catch {
        // 客户端已经断开。
      }
    }
    entry.clients.clear();
    entry.server.closeAllConnections?.();
    entry.server.close();
    entries.delete(entry.root);
  }

  async function entryFor(file: string, root?: string): Promise<Entry> {
    let base = dirname(file);
    if (root && isAbsolute(root) && (await isDirectory(root))) {
      const realRoot = await realpath(root).catch(() => null);
      if (realRoot) {
        const realFile = await realpath(file).catch(() => file);
        if (isWithin(realRoot, realFile)) base = root;
      }
    }
    return ensureEntry(base);
  }

  return {
    async start(input) {
      const file = resolve(filePath(input.ref));
      const real = await realpath(file).catch(() => null);
      const realFile = real ?? file;

      const rootPath =
        input.root && isAbsolute(input.root) ? resolve(input.root) : '';
      const realRoot = rootPath
        ? await realpath(rootPath).catch(() => null)
        : null;
      const rootIsDir = realRoot ? await isDirectory(realRoot) : false;
      const rawWithinRoot = Boolean(
        rootIsDir && rootPath && isWithin(rootPath, file),
      );

      // 工作区内已存在的文件如果通过符号链接指向工作区外，不允许把服务根
      // 改到目标目录——那等于绕过 workspace root 限制。
      // 文件不存在时 real 为 null，不能据此判断“指向外部”。
      if (
        real &&
        rawWithinRoot &&
        realRoot &&
        !isWithin(realRoot, real)
      ) {
        throw new Error('预览文件通过符号链接指向工作区外');
      }

      let entry: Entry;
      let served: string;
      let rel: string;

      if (rawWithinRoot && rootPath) {
        // 工作区内文件（包括尚不存在的新文件）统一按工作区根生成 URL，
        // 保留 sub/page.html 这样的路径，绝对 /assets 与 ../ 资源都能正确解析。
        entry = await ensureEntry(rootPath);
        rel = relative(rootPath, file);
        served = resolve(entry.root, rel);
      } else {
        entry = await entryFor(file, input.root);
        served = realFile;
        rel = relative(entry.root, served);
        if (!isWithin(entry.root, served)) {
          // 文件在工作区外时，用原始文件所在真实目录 + basename 生成 URL。
          // 符号链接逃逸交给静态 handler 的 realpath 检查拒绝。
          const dir = await realpath(dirname(file)).catch(() => dirname(file));
          entry = await ensureEntry(dir);
          served = join(entry.root, basename(file));
          rel = relative(entry.root, served);
        }
      }

      if (!rel) rel = 'index.html';
      const encoded = rel.split(sep).map(encodeURIComponent).join('/');
      const pagePath = `/${encoded}`;
      entry.pages.set(file, pagePath);
      if (realFile !== file) entry.pages.set(realFile, pagePath);
      entry.pages.set(served, pagePath);

      if (input.content !== undefined) {
        const content = input.content;
        entry.overlay.set(file, content);
        if (realFile !== file) entry.overlay.set(realFile, content);
        entry.overlay.set(served, content);
      }

      const now = Date.now();
      for (const [value, expires] of entry.tickets) {
        if (expires < now) entry.tickets.delete(value);
      }
      const ticket = randomBytes(18).toString('hex');
      entry.tickets.set(ticket, now + TICKET_TTL_MS);

      return {
        url: `http://127.0.0.1:${entry.port}/${encoded}?__preview_ticket=${ticket}`,
        port: entry.port,
        root: entry.root,
      };
    },

    async update(ref, content) {
      const file = resolve(filePath(ref));
      // macOS 的 /var 与 /private/var 是同一路径；root 已 realpath，
      // 因此比较前必须把 ref 也 realpath，否则 update 找不到对应服务。
      const realFile = await realpath(file).catch(() => file);
      let updated = false;
      for (const entry of entries.values()) {
        const within =
          isWithin(entry.root, realFile) || isWithin(entry.root, file);
        if (!within) continue;
        entry.overlay.set(file, content);
        if (realFile !== file) entry.overlay.set(realFile, content);
        const pagePath =
          entry.pages.get(realFile) ?? entry.pages.get(file);
        if (pagePath) broadcast(entry, pagePath);
        updated = true;
      }
      return updated;
    },

    async broadcast(ref) {
      const file = resolve(filePath(ref));
      const realFile = await realpath(file).catch(() => file);
      let sent = false;
      for (const entry of entries.values()) {
        if (
          !isWithin(entry.root, realFile) &&
          !isWithin(entry.root, file)
        ) {
          continue;
        }
        broadcast(entry);
        sent = true;
      }
      return sent;
    },

    close() {
      for (const entry of [...entries.values()]) closeEntry(entry);
    },
  };
}
