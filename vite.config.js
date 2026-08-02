import { defineConfig } from "vite";
import { fileURLToPath } from "url";

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  // 生产环境构建输出到 dist
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        config: fileURLToPath(new URL("./config.html", import.meta.url)),
      },
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
