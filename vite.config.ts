import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8")) as { version: string };

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
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
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: {
      // 本仓库的 test/ 下有大量测试期浏览器 profile（GB 级、数万文件），
      // src-tauri/target 同理。不排除会让 Vite 的文件监听把整个项目拖进
      // 冷启动扫描，dev 模式首屏因此要几十秒（骨架屏长时间不消失）。
      ignored: ["**/src-tauri/**", "**/test/**"],
    },
  },
});
