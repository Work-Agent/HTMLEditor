# HTML Editor

WorkStudio 的 HTML 代码编辑器插件：**CodeMirror 6 + HTML 语言支持**，内置
本地预览服务，可在独立预览视图中打开当前编辑内容。

## 功能

- **代码编辑**：HTML 语法高亮、标签 / 属性补全、自动闭合标签、括号匹配、代码折叠
- **导航与查找**：行号、当前行高亮、查找替换（`Cmd/Ctrl+F`）、跳转行、多光标
- **编辑体验**：自动换行、字号、缩进、撤销 / 重做、`Cmd/Ctrl+S` 保存
- **状态**：脏态标记、光标行列、选区内字符数、文档字符 / 行数
- **冲突处理**：文件在外部更新时提示「重新加载 / 保留我的修改」，不会静默覆盖
- **预览视图**：engine 启动受保护的本地静态服务，独立插件预览页用 iframe 嵌入；
  当前编辑内容（包括未保存修改）可直接预览，ES module、`fetch`、绝对路径和真实
  origin 都可用；保存 / 刷新 / 输入后（可选）通过 SSE 更新
- **选择元素**：预览页开启「选择元素」后，点击页面元素通过 postMessage +
  BroadcastChannel 回到编辑器，用 parse5 映射源码区间并选中
- **预览控制台**：捕获 iframe 内的 console / 运行时错误 / unhandled rejection，
  工具栏显示错误数，面板可查看、清空、关闭
- **主题**：跟随系统 / 宿主的 `data-theme`，浅色与深色都有独立的语法配色
- **设置**：自动换行、显示行号、字号（11–20 px）、输入时自动刷新预览

编辑器页面不再使用 `textarea + iframe` 分屏。编辑与预览是两个独立视图：
现在切换查看，等 WorkStudio 提供分屏能力后可以直接并排。预览视图内部的 iframe
只承载本地预览服务，不参与编辑器布局。

## 开发

```bash
pnpm install
pnpm typecheck
pnpm build
```

`pnpm build` 会生成：

```text
dist/page/index.html
dist/page/preview.html
dist/settings/index.html
dist/engine.js
dist/assets/...
commands.json
api.json
api.d.ts
```

## 安装

把整个仓库目录作为本地插件安装到 WorkStudio，或 `pnpm build` 后打 zip 安装。
依赖全部打包进 `dist`，安装时不需要执行 npm。

约定：

- `workstudio.id`: `html-editor`
- claims: `.html` / `.htm`
- 内容页：`dist/page/index.html`
- 预览页：`dist/page/preview.html`（由 `plugin://html-editor/content/preview.html` 加载）
- 设置页：`dist/settings/index.html`
- 引擎：`dist/engine.js`
- 技能：`skills/html-editor/SKILL.md`

## Release

Tag 必须与 `package.json` 的 `version` 一致：

```bash
git tag v0.1.0
git push origin v0.1.0
```

`.github/workflows/release.yml` 在 tag 推送后：

1. checkout 插件和 WorkStudio 的 `packages/sdk`，先构建 SDK；
2. `pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm build`；
3. 打包并创建 GitHub Release：
   - `html-editor-v0.1.0.zip`（可直接安装）
   - `html-editor-v0.1.0.zip.sha256`

zip 根目录包含 `package.json`、`dist/`、`skills/`、`commands.json`、`api.json`、
`api.d.ts`、`docs/`、`README.md`、`LICENSE`。

WorkStudio SDK 从 `Work-Agent/WorkStudio` checkout：

- 如果该仓库是私有的，在 HTMLEditor 仓库添加 secret `WORKSTUDIO_TOKEN`
  （PAT，Contents: Read 即可）；
- 可选仓库变量 `WORKSTUDIO_REF` 固定 SDK 的 tag / commit；
- 如果仓库公开，默认 `GITHUB_TOKEN` 通常可用。

安装 release zip：WorkStudio 设置 → 插件 → 从 zip 安装（或宿主对应的插件安装入口）。

## 命令

| 命令 | 入参 | 说明 |
| --- | --- | --- |
| `html-editor.save` | `ref`, `content` | 保存 HTML、更新预览 overlay 并通知 `workspace` 订阅者 |
| `html-editor.preview` | `ref`, `root?`, `content?` | 启动 / 复用本地预览服务，返回带 5 分钟短时 ticket 的内部 URL |
| `html-editor.live` | `ref`, `content` | 更新未保存内容 overlay 并广播 SSE reload |

`commands.json` / `api.json` / `api.d.ts` 由 `workstudio-plugin` 从
`definePlugin` 生成，不手写。

资源适配器支持：

- 读取整篇 HTML；
- `offset` / `limit` 按行读取（Agent 读取大文件用）；
- `grep` 按行返回 `ref#L<n>` 定位与片段。

## 设置

设置保存在插件数据目录，对所有 HTML 文件生效：

- 自动换行
- 显示行号
- 字号
- 输入时自动刷新预览（停止输入约 450ms 后更新）

## 快捷键

| 快捷键 | 动作 |
| --- | --- |
| `Cmd/Ctrl+S` | 保存 |
| `Cmd/Ctrl+Shift+V` | 打开 / 刷新预览视图（不要求保存） |
| `Cmd/Ctrl+F` | 查找 / 替换 |
| `Cmd/Ctrl+Z` / `Shift+Cmd/Ctrl+Z` | 撤销 / 重做 |
| `Cmd/Ctrl+/` | 切换 HTML 注释 |
| `Cmd/Ctrl+Shift+↑/↓` | 上移 / 下移当前行 |
| `Tab` / `Shift+Tab` | 缩进 / 反缩进 |
| `Ctrl+Space` | 主动触发补全 |

## 结构

```text
src/
├── engine.ts                 # definePlugin：资源适配器 + save / preview / live
├── server/
│   └── preview.ts            # 本地只读静态服务 + ticket/cookie + SSE + pick runtime
├── shared/
│   └── channel.ts            # 编辑页 ↔ 预览页 BroadcastChannel 协议
├── editor/
│   ├── index.ts              # CodeMirror 编辑器工厂
│   ├── theme.ts              # 主题与 HTML 语法配色
│   ├── keymap.ts             # 快捷键
│   ├── settings.ts           # 设置类型 / 归一化
│   └── source-map.ts         # parse5：element path → 源码区间
├── page/
│   ├── index.html
│   ├── main.ts               # 编辑页：资源、保存、冲突、预览视图、pick 定位
│   ├── style.css
│   ├── preview.html
│   ├── preview-main.ts       # 预览视图：iframe、设备宽度、选择元素
│   └── preview.css
└── settings/
    ├── index.html
    ├── main.ts
    └── style.css
```

## 预览说明

编辑器点「预览」会打开一个独立的插件预览视图：

```text
编辑页 (plugin://html-editor/content?ref=…)
   │  html-editor.preview → 本地静态服务 URL
   │  BroadcastChannel: preview-url / preview-ready / pick / pick-result
   ▼
预览视图 (plugin://html-editor/content/preview.html?ref=…)
   └─ iframe → http://127.0.0.1:<port>/<file>?__preview_ticket=…
```

- engine 绑定 `127.0.0.1` 随机端口，每个工作区根目录复用一个服务；
- 工作区根目录作为静态根，相对路径、绝对路径、ES module、`fetch` 都按真实
  HTTP origin 工作；
- 当前编辑内容通过内存 overlay 提供，所以**未保存也能预览**；
- 保存、外部更新或预览页「刷新」时，编辑页重新请求预览地址 / 更新 overlay，
  通过 SSE 让 iframe reload；
- 设置中开启「输入时自动刷新预览」后，输入停止约 450ms 会复用同一个预览服务
  更新 overlay 并广播 SSE，不产生新 ticket / 新 iframe URL；
- 预览页有设备宽度（自动 / 375 / 768 / 1280）、「选择元素」和控制台面板；
- runtime 注入在 `<head>` 最前面，先接管 console / error / SSE / pick，再执行
  页面自己的脚本；console 以 120ms 批次 postMessage 到预览页；
- 「选择元素」开启后，iframe 内的 runtime 捕获点击，把 element path 通过
  `postMessage` 发给预览页，预览页再通过 BroadcastChannel 发给编辑页；
  编辑页用 parse5 映射 `path + tags` 到源码区间并选中；
- 如果点击时源码已经变化，编辑页返回 `stale`，提示刷新预览。

安全边界：

- 首次访问使用 5 分钟有效的短时 `__preview_ticket`，随后写入
  `HttpOnly; SameSite=None; Secure` cookie（loopback 视为可信；预览页用跨站
  iframe，`SameSite=Strict` 不会在 iframe 中发送）；
- 只读 GET/HEAD，无目录列表、无 CORS；限制在根目录内，`realpath` 防符号链接
  逃逸；屏蔽 dotfile、`node_modules`、`.git` 等目录；
- 只服务 Web 资源扩展名（html/css/js/json/图片/字体/媒体等）；
- `Host` 头校验防 DNS rebinding；响应带 `X-Content-Type-Options: nosniff`、
  `Referrer-Policy: no-referrer`、`Cache-Control: no-store`。

预览页的地址栏是插件页面（`preview.html?ref=…`），本地服务 URL 只存在于
iframe 内，不会显示在 WorkStudio 标签地址栏里。

边界：

- 预览服务本身不添加 CSP；runtime 注入在 `<head>` 最前面，通常不会被页面的
  meta CSP 拦截。页面自身的 CSP 仍会约束页面脚本；如果它禁止内联样式，
  hover 高亮可能不显示，但选择元素 / 热刷新仍可用；
- 超过 8MB 的 HTML 不注入 runtime（避免整页读入内存），此时热刷新 / 选择元素 /
  控制台不可用，但页面仍可加载；
- 只服务白名单扩展名，`.md` / `.env` 等不会暴露；
- 预览刷新是整页 reload，不是 DOM 局部 patch；默认只在保存 / 刷新 / 重新预览
  时更新，输入自动刷新需要在设置中开启；
- 服务随插件 deactivate 关闭；已打开的预览视图会失效，重新点击「预览」即可；
- 从旧版本升级时如果还开着旧的 web 预览标签（旧 id 的 localhost 标签），请关闭；新版本会使用新的预览视图 id，不会自动接管旧标签。

## 下一步

当前版本已经具备代码编辑 + 本地预览服务 + 独立预览视图 + 选择元素定位源码。

下一步：

- 等 WorkStudio 提供分屏后，把编辑页和预览视图直接并排；
- 就地编辑：画布操作 → 源码最小补丁（parse5 location + CM6 transaction）；
- 设备旋转、控制台过滤 / 复制、滚动同步等细节。

## 已知边界

- 编辑和预览仍是两个标签；分屏能力由宿主提供后改善。
- 预览刷新是整页 reload，不是 DOM 局部 patch；默认在保存 / 外部更新 / 刷新 /
  重新预览时更新，输入自动刷新需要在设置中开启。
- 「选择元素」只选中元素源码区间，不直接编辑；源码变化后需要先刷新预览。
- 大文件依赖 CodeMirror 自身性能，暂未做降级阈值。
- 预览脚本在本地 HTTP origin 中执行，不经过 WorkStudio bridge；页面可以读取
  工作区内被服务允许的 Web 资源，因此只应预览可信文件。
