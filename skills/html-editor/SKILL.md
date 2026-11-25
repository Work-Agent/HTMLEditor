---
name: html-editor
description: 编辑、保存和预览工作区中的 HTML 文件；需要修改 .html/.htm 时按需加载。
---

# HTML 编辑器

用于读取、编辑和保存工作区的 `.html` / `.htm` 文件。编辑器基于 CodeMirror 6，
提供 HTML 语法高亮、补全、折叠、查找和冲突提示。

## 工作流

1. 先用 `read` 读取 `file://...html` 资源。
2. 在 HTML 编辑器页面修改源码；`Cmd/Ctrl+S` 保存。
3. 也可以通过 `html-editor.save` 写回：
   - `ref`: 当前文件地址
   - `content`: 完整 HTML 文本
4. 保存后同一 ref 的订阅者会收到 `content` 变更。

## 预览

- 编辑器工具栏的「预览」或 `Cmd/Ctrl+Shift+V` 会打开独立预览视图；预览视图
  iframe 嵌入 engine 启动的本地静态服务，显示当前编辑内容（含未保存修改）。
- 预览使用真实 HTTP origin，因此 ES module、`fetch`、绝对路径、相对资源和
  CSS 都可用；保存、刷新或 `html-editor.live` 会更新内容。
- 预览页可开启「选择元素」：点击页面元素会通过 postMessage + BroadcastChannel
  回到编辑器，用 parse5 映射源码区间并选中。源码变化后需要先刷新预览。
- 设置中可开启「输入时自动刷新预览」；默认只在保存 / 刷新时更新。
- 预览页控制台捕获 iframe 内的 console / error / unhandled rejection；只捕获
  iframe 顶层文档，不包含子 iframe / worker。
- 服务只绑定 `127.0.0.1`，使用短时 ticket + HttpOnly cookie，只读并限制在
  工作区根目录内；dotfile、`node_modules`、`.git` 等不会暴露。
- **预览会执行页面脚本**；只对可信文件使用预览。需要脚本结果时，优先使用
  宿主提供的 browser 能力，而不是把脚本写进待保存的文件。

## 注意

- 不改变文件身份或路径。
- 不把 HTML 当作纯文本覆盖未知编码文件；先确认资源可读。
- 外部更新与未保存修改冲突时，页面会提示「重新加载 / 保留我的修改」。
- 编辑器和预览目前是两个独立标签；等宿主提供分屏后可并排使用。
