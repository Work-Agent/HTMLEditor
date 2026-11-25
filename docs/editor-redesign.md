# HTML Editor 重构设计：活画布 + 源码补丁

> 结论先行：开源社区没有可直接嵌入的“HTML 版 Obsidian Live Preview”。
> 建议不再走“源码 / 分屏 / 预览”三态切换，而是把预览做成主画布、源码做成
> 可展开的检查器，所有可视化操作都换算成对原始源码的最小补丁。
> 原有 `textarea + iframe.srcdoc` 实现可以整体废弃。
>
> 落地顺序：**阶段 1 先把编辑和预览拆成两个独立视图（两个 tab）**，等 WorkStudio
> 提供分屏能力后自然并排；预览用插件视图而不是 `file://` 浏览器 tab，这样
> 未保存内容、元素→源码、脚本策略都能继续复用。详见第 8 节。

> **当前版本（v0.1）已实现**：CodeMirror 6 代码编辑、保存 / 冲突提示、
> engine 内置的受保护本地预览服务（真实 HTTP origin、未保存 overlay、SSE 刷新）、
> 独立插件预览视图（iframe + BroadcastChannel）、选择元素 → parse5 源码定位、
> 预览控制台 / console 捕获、输入 debounce 实时刷新开关、tab 标题同步、设置页。
> 分屏适配与就地补丁仍待下一步。

## 1. 开源调研（2025-11）

| 类别 | 代表项目 | 许可 | 能否直接用 |
| --- | --- | --- | --- |
| 可视化建站 | GrapesJS、Webstudio、Silex、Puck、Craft.js | BSD-3 / AGPL-3 / MIT | 否。它们编辑自己的组件/文档模型，HTML 只是导出物，不能无损编辑任意 HTML 文件 |
| 富文本 WYSIWYG | CKEditor 5、TinyMCE、ProseMirror、Tiptap、Quill、Trix、SunEditor | GPL/商业、MIT、MIT… | 否。schema 化编辑，`<head>`、`<style>`、`<script>`、自定义元素、未知属性、注释会丢失或被规范化 |
| 代码编辑器 + 预览 | CodeMirror、Monaco、VS Code Live Preview、Web Maker、Sandpack | MIT / Apache-2.0 | 只有“分屏 + 元素→源码定位”，不是就地编辑；可借鉴架构，不能直接满足体验 |
| 商业参考 | Pinegrow、Dreamweaver、Webflow | 闭源 | Pinegrow 的“画布操作 → 最小源码修改”是最接近的目标形态，但它没有可复用的开源内核 |

调研要点：

- **没有成熟的开源库**提供“任意 HTML 文档的单视图实时编辑”。Markdown 生态有
  CodeMirror + 自研 decoration 这条路，HTML 没有对应物。
- 最接近的开源实现是 VS Code 的 Live Preview 扩展（MIT）：iframe 预览、
  元素 ↔ 源码跳转、控制台，但仍然是“看”和“改源码”两个动作。
- 可视化建站类项目（GrapesJS / Webstudio / Puck）解决的是“用组件搭页面”，
  不是“打开一个已有 `.html` 文件，所见即所得地改它”。两者的数据模型根本不同。
- 富文本编辑器的失败点是 schema：它们必须把 DOM 映射到有限的节点类型，
  而 HTML 文件的语义恰恰在 schema 之外（内联样式、脚本、模板语法、注释）。

## 2. 为什么不能照搬 Markdown 的 Live Preview

Markdown 的 live preview 成立，是因为：

1. 源码是唯一真相；
2. 渲染是**单向、确定性**的（Markdown → DOM）；
3. 用户视觉编辑只发生在受控子集（表格、任务勾选），其余操作仍是改文本。

HTML 的“渲染”就是 DOM 本身，而 DOM 对文本是**有损**的：

- 属性顺序、引号风格、空格/缩进、实体写法、自闭合写法、注释位置都会在
  `innerHTML` 序列化时被改写；
- 浏览器会补 `<tbody>`、重排错误嵌套、foster parenting，DOM 树与源码不再一一对应；
- `<script>` / `<style>` / `<pre>` 的空白有语义，重新序列化可能改变行为；
- 模板语法（Vue/Angular/PHP/Handlebars）不是合法 DOM，直接渲染会破坏源码。

因此有三条路，只有第三条可行：

| 方案 | 做法 | 结果 |
| --- | --- | --- |
| A. DOM 为准 | contenteditable 编辑 DOM，保存时 `innerHTML` 回写 | 源码被整体重写，格式和模板语法全丢。不可接受 |
| B. 源码为准 + 全量重渲染 | 每次输入都重新生成预览 | 已是现状的增强版，预览有延迟、iframe 状态丢失，且没有“就地编辑” |
| C. 源码为准 + 最小补丁 | 画布操作换算成对源码区间的 splice | 保留源码格式，编辑即时生效，可撤销。推荐 |

## 3. 新架构：活画布 + 源码补丁

> 这是目标形态。落地顺序见第 8 节：阶段 1 先把编辑和预览拆成两个独立视图，
> 等宿主分屏后并排；就地补丁是阶段 3 的可选增强。

### 3.1 三条原则

1. **源码是唯一真相**。DOM 只是源码的投影，永不回写整篇文档。
2. **画布优先**。默认看到的是渲染结果；代码是按需展开的检查器，不是并列的一屏。
3. **一切编辑都是补丁**。文本、属性、删除、复制、移动都表达为
   `{range, insert}`，通过 CodeMirror transaction 应用，天然获得 undo/redo 和脏态。

### 3.2 数据流

```text
             parse5(sourceCodeLocationInfo)
  源码 ────────────────────────────────────► 索引
   ▲                                          │
   │ splice(op)                               │ path ↔ source range
   │                                          ▼
  CM6 ◄──── patch / reveal ────  画布 runtime（sandbox iframe）
   │                                          ▲
   └──────────── 输入、undo、保存 ─────────────┘
```

- **索引**：用 parse5 建一棵带源码位置的树。每个元素记录
  `startTag`、`endTag`、`attrs[name]`、文本节点、注释的 offset 区间，
  以及从 `<html>` 起的 child-index 路径。
- **路径**：`[1, 0, 2]` 表示 `html > body > 第 3 个子节点`。iframe 内 runtime
  用同一路径定位元素；两边索引一致时，画布点击可以直接命中源码区间。
- **补丁**：画布里的操作只发回 `{kind, path, value}`，由父页面换算成源码区间，
  再 dispatch 给 CM6。CM6 是唯一的文档容器，撤销、脏态、保存都走同一条链路。

已实测 parse5 8.1.1 的位置信息可用：

- `element.sourceCodeLocation` 覆盖整个元素；
- `attrs[name]` 覆盖完整属性（含引号），值区间可在其内部计算；
- 文本节点区间包含实体原文（`Hello &amp; `），替换时按 HTML 转义即可；
- 隐式节点（如 `<tbody>`）没有 location，这类节点拒绝可视化结构操作；
- `<p>a<p>b` 这类隐式闭合也能给出可用区间。

### 3.3 补丁协议（草案）

```ts
type Patch =
  | { kind: 'text';  path: number[]; value: string }
  | { kind: 'attr';  path: number[]; name: string; value: string | null }
  | { kind: 'remove'; path: number[] }
  | { kind: 'duplicate'; path: number[] }
  | { kind: 'move'; path: number[]; delta: -1 | 1 };
```

约束：

- `text` 只允许“纯文本叶子”或“唯一文本子节点”的元素，避免结构变更；
- `attr` 修改已有属性时只替换值区间；新增属性插入到 `>` 前；删除属性删整段；
- `remove` / `duplicate` / `move` 只在首尾标签都有 location、且区间不重叠时执行；
- 任何无法定位的节点 → 提示“此处没有源码位置”，并跳转到最近的可用区间。

### 3.4 画布

用 iframe，不用 Shadow DOM：

- 用户 CSS 的 `:root`、媒体查询、`body` 样式、`@font-face` 需要独立文档才能正确生效；
- Shadow DOM 仍然会被页面样式、全局滚动和字体影响，隔离不彻底；
- iframe 可以按需开启脚本沙箱，主页面永远拿不到用户脚本的 DOM。

加载流程：

1. 读取源码，parse5 建索引；
2. **资产重写**：把相对路径的资源经插件命令读成 data URL，再写进预览副本；
   源码不动；
3. 注入 runtime（放在 `<head>` 最前），写入 `srcdoc`；
4. runtime 与父页面用 `postMessage` 通信：pick / hover / edit / console / scroll。

沙箱：

- 默认 `sandbox=""`：静态预览，最安全；
- 打开“运行脚本”后重建 iframe 为 `sandbox="allow-scripts"`：
  脚本可运行，但 origin 是 opaque，拿不到 `window.parent.workStudio`，
  也不能导航顶层窗口；
- 不开启 `allow-same-origin` / `allow-popups` / `allow-top-navigation`。

资产重写范围（P0）：

- `<link rel=stylesheet>`：读文本 → 递归重写 CSS 里的 `url()` / `@import` → 内联为 `<style>`；
- `<script src>`：读文本 → 内联（`type=module` 的相对 import 暂不支持，给出提示）；
- `img/src`、`source/src`、`srcset`、`video/poster`、`audio`、`svg use`；
- 行内 `style` 与 `<style>` 块中的 `url()`；
- `a[href]` 不改写，点击由 runtime 拦截后交给宿主打开。

不做资产重写的代价：`plugin://` 协议只允许插件根目录内的文件（`src/main/protocols.ts` 已验证），
`file://` 资源在非 file 源页面里会被 Chromium 拦截，所以必须走 bridge。
若后续愿意改宿主，可以增加只读的 workspace 资源协议，直接给 iframe 一个
`<base>`，省掉整条重写管线；这是可选优化，不是前置条件。

### 3.5 增量更新（避免每次输入都重载 iframe）

- **画布内编辑**：runtime 只在本地改一个文本节点/属性，同时发补丁给父页面；
  不重载文档，滚动和表单状态都保留。
- **源码输入**：debounce 250–400ms，把新源码（资产已重写）发给 runtime；
  runtime 用 `DOMParser` 比较后优先局部替换 `<body>` / `<style>`，保留滚动位置。
- **结构性变更 / undo / 打开脚本**：整页重建，明确接受状态丢失。
- 预览右下角显示“已暂停 / 正在同步 / 脚本已启用”等状态，避免“为什么没刷新”的困惑。

### 3.6 界面

```text
┌──────────────────────────────────────────────────────────────┐
│ 文件 · 未保存   html > body > div#app > section.hero          │
│ [自动] [375] [768] [1024]   [脚本] [代码 ⌘\]        [保存]    │
├────────────────────────────────────────────┬─────────────────┤
│                                            │  源码抽屉        │
│              画布（iframe）                 │  CodeMirror 6    │
│   点击选中 · 双击改文本 · hover 高亮         │  选中区间高亮     │
│   链接点击拦截 · 控制台错误角标              │  自动补全         │
│                                            │  （可拖宽/收起）  │
├────────────────────────────────────────────┴─────────────────┤
│ <section class="hero">  id▢  class▢  style▢  文本▢            │
│ [复制] [删除] [上移] [下移] [在源码中编辑]                    │
└──────────────────────────────────────────────────────────────┘
│ 解析 OK · 资产 12/12 · 0 错误 · 1.8 KB                       │
└──────────────────────────────────────────────────────────────┘
```

交互约定：

- 单击选中元素，面包屑显示祖先链；`Esc` 回到 `body`；
- 双击可编辑文本（`contenteditable="plaintext-only"`），`Enter` 提交、`Esc` 取消，
  IME composition 期间不提交；
- 混合内容（元素 + 文本交错）默认只允许在检查器里编辑文本节点，不做整段 contenteditable；
- 源码抽屉打开时双向同步：画布选中 → 源码选中并滚动；源码光标 → 画布高亮 + `scrollIntoView`；
- 抽屉宽度、设备宽度、是否默认打开代码都写入设置；
- 代码抽屉里保留 `Cmd/Ctrl+S`、搜索、自动换行、行号；格式化是显式动作，不自动执行。

## 4. 工程结构

```text
src/
├── engine.ts                 # 资源适配器 + save / readAsset / readText
├── shared/
│   ├── channel.ts            # BroadcastChannel 消息协议（doc / pick / saved）
│   └── settings.ts           # 设置默认值
├── editor/
│   ├── index.ts              # CM6 编辑器工厂
│   ├── theme.ts              # 主题 + HTML 高亮
│   ├── keymap.ts             # 快捷键
│   ├── document/             # 阶段 3：源码索引与补丁
│   │   ├── parse.ts          # parse5 → SourceIndex
│   │   ├── locate.ts         # path / offset ↔ element
│   │   └── patches.ts        # Patch → CM6 changes
│   └── inspector.ts          # 阶段 3：选中元素属性条
├── preview/
│   ├── index.ts              # 预览视图：资源订阅、iframe、状态
│   ├── assets.ts             # 资源收集 + 重写 + 缓存（CSS url/import、srcset）
│   ├── host.ts               # iframe 生命周期、srcdoc、sandbox
│   ├── runtime.ts            # 注入 iframe 的脚本（pick / hover / console）
│   └── protocol.ts           # postMessage 类型
├── page/
│   ├── index.html            # 壳：按 mode 挂载
│   ├── main.ts               # mode=edit / mode=preview 分流
│   ├── edit-main.ts          # 资源订阅、保存、冲突、广播
│   ├── preview-main.ts       # 预览、pick、广播
│   └── style.css
└── settings/                 # 自动换行、字号、脚本、设备宽度
```

依赖新增：

- `parse5@8`（MIT，约 380KB 源码）—— 只在页面 bundle 里，不进引擎；
- `@codemirror/lang-html@6`（MIT）+ `@codemirror/autocomplete` / `search` / `commands`；
- 复用 MarkdownEditor 的 CM6 主题思路，但配 HTML 高亮，不复制其 live-preview 代码。

引擎命令：

| 命令 | 入参 | 说明 |
| --- | --- | --- |
| `html-editor.save` | `ref`, `content` | 保持现状 |
| `html-editor.readAsset` | `ref` | 返回 `{ dataUrl, mime, size }`，单文件上限 8MB |
| `html-editor.readText` | `ref` | 返回 `{ text, mime }`，供 CSS / JS 内联，上限 2MB |

## 5. 分期

| 阶段 | 内容 | 验收 | 估时 |
| --- | --- | --- | --- |
| P0 | 双视图骨架：`mode=edit` + `mode=preview`、CM6、保存/冲突、预览 iframe + 资产重写、BroadcastChannel、pick → 源码选中、预览 tab 的打开/复用/激活 | 打开真实页面 CSS/图片正常；未保存输入实时出现在预览 tab；点击元素切回编辑 tab 已选中 | 3–4d |
| P1 | 分屏适配：宿主支持后把两个 view 并排；滚动锚点同步；预览页 console；设备宽度 | 分屏后编辑/预览同时可见；报错可见 | 1–2d |
| P2 | 真实浏览器预览（`file://` + 保存后 reload）、格式化（显式）、设置页完善、大文件降级 | 需要像素级核对时一键打开真实浏览器；1MB 文档可用 | 1–2d |
| P3 | 就地文本/属性补丁（可选）：parse5 索引、检查器、undo | 画布内改标题，源码只变一个区间 | 2d |

P0 是可交付的第一阶段，约 3–4 天；P1 依赖宿主分屏，分屏不到位时 P0 的双 tab
仍然可用。总计 7–10 个工作日，预计 3.5–5k 行 TypeScript/CSS。旧页面代码全部
重写，`engine.ts` 的资源适配器与 `save` 命令保留。

## 6. 风险与预研

正式开工前用 1 天做 4 个 spike，任一失败就降级方案：

| Spike | 验证 | 失败则 |
| --- | --- | --- |
| S1 | Electron 插件页里 `sandbox="allow-scripts"` + `srcdoc` + data: 资源可正常渲染；parent 收不到 iframe DOM | 默认关闭脚本，仅静态预览 |
| S2 | parse5 树与 iframe DOM 的 child-index 路径在 5 个畸形文档上一致 | 路径失配的子树禁用可视化编辑，只保留“跳源码” |
| S3 | sandbox iframe 内 `contenteditable=plaintext-only` 中文 IME 正常，Enter/Esc 行为可控 | 改为父页面浮层 mini editor，或只在检查器里改文本 |
| S4 | 补丁 → CM6 dispatch → undo → 预览回滚；字节级 diff 只落在目标区间 | 回退到 P0 的“选择 + 跳源码”模式 |

风险清单：

| 风险 | 缓解 |
| --- | --- |
| 浏览器补节点导致路径错位 | 加载时让 runtime 回传 path→tagName，父页面比对；不一致的子树禁用画布编辑 |
| contenteditable 破坏 DOM / 输入法 | 只对单文本节点开启；composition 保护；提交后立即关闭；失败则回滚并提示 |
| 外部资源过多/过大 | 并发 6、单文件 8MB、总量 32MB、失败占位 + 状态栏提示；不做递归 iframe |
| 脚本副作用 | 默认不运行；opaque origin；无 allow-same-origin/popups/top-navigation；切回静态时销毁 iframe |
| 大文件卡顿 | >2MB 不建全量索引，降级为“纯源码 + 手动刷新预览”；索引在 idle 构建 |
| 源码格式被改写 | 只做 splice，永不整体序列化；格式化只能是显式命令且可撤销 |
| undo 后预览与源码不一致 | 所有文档变更（含 undo/redo）统一触发重建或增量刷新，不按入口区分 |

## 7. 和“模式切换”方案的关系

纯模式切换（画布 ⇄ 源码）成本更低，约 P0 的 60%，但它仍然是“两个动作”：
看的时候不能改，改的时候看不到。它可以作为 S2/S3 失败后的降级路径，
也是本设计的第一步（P0 = 可用的画布 + 可展开的源码）。

推荐方案并不是“不要模式切换”，而是：

- **80% 的编辑不需要切模式**：改文字、改 class、改链接、删块、调顺序；
- **20% 的复杂编辑**才展开源码抽屉，且展开后仍然双向联动；
- 源码抽屉不是“另一个模式”，而是画布的检查器。

这样既保留 HTML 源码的可控性，又把“预览”从只读面板变成真正的工作面。

## 8. 落地形态：先双视图，后分屏

用户诉求：暂时把编辑和预览拆成两个 tab，等 WorkStudio 提供分屏后并排。
这个方向是对的，而且比“在编辑器页里塞 iframe”更容易演进。关键是：
**预览要做成独立的插件视图，而不是 `file://` 浏览器 tab。**

### 8.1 为什么是插件预览视图

| 维度 | 插件预览视图（`content?mode=preview`） | `file://` web tab |
| --- | --- | --- |
| 未保存内容 | BroadcastChannel 实时同步，不保存也能看 | 只能看已保存文件 |
| 元素 → 源码 | 可做：预览页 pick → 编辑页选中区间 | 做不到（无 preload / bridge） |
| 脚本安全 | iframe sandbox，默认禁脚本 | 默认执行脚本，需宿主补策略 |
| 分屏未来 | 普通 view，宿主分屏后直接并排 | 也能并排，但没有联动 |
| 渲染保真 | 受资产重写限制 | 最接近真实浏览器 |
| 复杂度 | 需要资产管线（本来就要做） | 不需要资产管线 |

主预览用插件视图；`file://` 真实浏览器打开作为**附加动作**（像素核对 / 交付验收），
不是主循环。这样即使暂时没有分屏，两个 tab 之间也有“未保存实时预览 + 点击元素
回到源码”的联动，而不是纯粹的 Live Server 式保存刷新。

### 8.2 双视图通信

两个 tab 都是 `plugin://html-editor/content?...`，同源，可以直接用
`BroadcastChannel`，不需要引擎临时存储：

```ts
type Msg =
  | { type: 'hello'; view: 'edit' | 'preview' }
  | { type: 'request-doc' }
  | { type: 'doc'; version: number; html: string; dirty: boolean }
  | { type: 'pick'; path: number[]; range: [number, number] }
  | { type: 'saved'; html: string };
```

- 编辑器每次输入（debounce 80–120ms）广播 `doc`，预览页用它渲染未保存内容；
- 预览页打开时发 `hello` + `request-doc`，编辑器回当前 doc；
- 预览页点击元素 → `pick`，编辑器选中源码区间；切回编辑 tab 时已经选中；
- 编辑器保存成功 → `saved`，预览页清掉“未保存”标记；
- 预览页关闭不影响编辑器；编辑器关闭后预览页显示“编辑器已关闭，以下是最近草稿”。

### 8.3 和 VS Code Live Preview 的对应关系

VS Code Live Preview 的形态是：编辑器 + 内嵌浏览器并排、变更后刷新、
元素检查回到源码。双 tab + 后续分屏在**布局**上就是同一个形态；
如果预览用插件视图 + BroadcastChannel，未保存内容也能实时更新，比默认的
“保存后刷新”更激进。缺的只是“并排”和“内嵌浏览器控制台”：并排等宿主分屏，
控制台可以在预览页补。

如果预览直接用 `file://` tab，那更像 VS Code 的 **Live Server**（保存 → 刷新），
而不是 Live Preview。

### 8.4 分屏到来后

预览页是普通 view，宿主只要能把两个 view 放进两个 pane，就自动成立，插件侧
只需要把“打开预览”从 `activate` 改成“打开并在右侧分屏”。元素→源码、
未保存同步、错误角标都继续复用，不需要重写预览实现。

### 8.5 边界

- 预览页的 iframe 仍受资产重写和沙箱限制；真实浏览器保真走 `file://` 附加动作；
- `file://` 的 ES module 相对 import、fetch/XHR、service worker 与 http 页面不同，
  不能把它当作“完全等价浏览器”；
- 两个 tab 的滚动位置不联动；分屏后再做按元素锚点的滚动同步；
- 预页 tab 默认不执行用户脚本；需要时在预览页显式开启；
- 编辑器 tab 关闭后，预览页只读最近草稿，不能保存。
