import { configDefaults, defineConfig } from "vitest/config";

const includeInstallerTest = process.argv.some((arg) => arg.includes("install-agent-sh"));

export default defineConfig({
  test: {
    environment: "jsdom",
    environmentOptions: {
      jsdom: {
        url: "https://www.bilibili.com/video/BV1test000000/"
      }
    },
    include: ["tests/**/*.test.js", "tests/**/*.test.ts"],
    exclude: includeInstallerTest
      ? configDefaults.exclude
      : [...configDefaults.exclude, "tests/agent-bridge/install-agent-sh.test.ts"],
    setupFiles: ["tests/setup.ts"],
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
