/**
 * HTML editor 的插件引擎：资源适配器 + 保存 / 本地预览服务。
 *
 * 资源适配器只负责读取 HTML 源码；写入统一走 save 命令，
 * 页面和助手共用同一条命令地址。预览服务只读、只绑定 127.0.0.1，
 * 生命周期跟随插件激活/停用。
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { definePlugin } from "@workstudio/sdk";
import { createPreviewServers } from "./server/preview";

const previews = createPreviewServers();

export const workstudio = definePlugin({
  resources: {
    html: {
      async read(ref, options) {
        const file = fileURLToPath(ref);
        const title = basename(file);
        const text = await readFile(file, "utf-8");
        if (!options?.offset && !options?.limit) {
          return [{ locator: ref, title, text }];
        }
        const lines = text.split("\n");
        const offset = Math.max(0, (options?.offset ?? 1) - 1);
        const limit = Math.max(1, Math.min(options?.limit ?? 200, 2000));
        const content = lines.slice(offset, offset + limit).join("\n");
        return [
          {
            locator: `${ref}#L${offset + 1}`,
            title,
            text: content,
            ...(content.length !== text.length
              ? { truncated: true, totalLines: lines.length }
              : {}),
          },
        ];
      },
      async grep(ref, query) {
        const text = await readFile(fileURLToPath(ref), "utf-8");
        const needle = query.toLowerCase();
        if (!needle) return [];
        const lines = text.split("\n");
        const items: Array<{ locator: string; snippet: string; line: number }> =
          [];
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? "";
          if (!line.toLowerCase().includes(needle)) continue;
          items.push({
            locator: `${ref}#L${index + 1}`,
            snippet: line.slice(0, 240),
            line: index + 1,
          });
          if (items.length >= 100) break;
        }
        return items;
      },
    },
  },
  commands: {
    "html-editor.save": {
      summary: "保存 HTML 内容",
      args: {
        ref: { type: "string", required: true },
        content: { type: "string", required: true },
      },
      async run(input, ctx) {
        const ref = String(input.ref);
        const content = String(input.content);
        await ctx.fs.write(ref, new TextEncoder().encode(content));
        try {
          await previews.update(ref, content);
        } catch (error) {
          ctx.log.warn(
            `预览刷新失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
        ctx.changed(ref, "content");
        return { saved: true, ref };
      },
    },
    "html-editor.preview": {
      summary: "启动 / 复用本地预览服务并返回预览地址",
      args: {
        ref: { type: "string", required: true },
        root: { type: "string" },
        content: { type: "string" },
      },
      async run(input) {
        return previews.start({
          ref: String(input.ref),
          ...(typeof input.root === "string" ? { root: input.root } : {}),
          ...(typeof input.content === "string"
            ? { content: input.content }
            : {}),
        });
      },
    },
    "html-editor.live": {
      summary: "更新预览 overlay 并广播刷新（外部变更 / 未保存内容）",
      args: {
        ref: { type: "string", required: true },
        content: { type: "string", required: true },
      },
      async run(input) {
        return {
          updated: await previews.update(
            String(input.ref),
            String(input.content),
          ),
        };
      },
    },
  },
  lifecycle: {
    deactivate() {
      previews.close();
    },
  },
});
