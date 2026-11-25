import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname, "src"),
  base: "/",
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        page: resolve(__dirname, "src/page/index.html"),
        preview: resolve(__dirname, "src/page/preview.html"),
        settings: resolve(__dirname, "src/settings/index.html"),
      },
    },
  },
});
