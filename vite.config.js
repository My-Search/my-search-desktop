import { defineConfig } from "vite";

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  // 生产环境构建输出到 src-tauri（Tauri 打包时读取）
  build: {
    outDir: "dist",
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
