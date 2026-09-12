import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    environmentOptions: {
      jsdom: {
        url: "https://www.bilibili.com/video/BV1test000000/"
      }
    },
    include: ["tests/**/*.test.js", "tests/**/*.test.ts"],
    setupFiles: ["tests/setup.js"],
    clearMocks: true,
    testTimeout: 10000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["extension/**/*.js", "extension/**/*.ts"],
      // 02 死代码清理：content-classic.js 是分包前的单文件产物，已随 esbuild
      // 分包废弃（现产物为 content-main.mjs + chunks/），此处引用为残留。
      exclude: ["extension/icons/**"]
    }
  }
});
