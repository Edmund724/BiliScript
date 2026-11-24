import { configDefaults, defineConfig } from "vitest/config";

const includeInstallerTest = process.argv.some((arg) => arg.includes("install-agent-sh"));
const nodeMajor = Number(process.versions.node.split(".")[0]);
const execArgv = nodeMajor >= 25 ? ["--no-experimental-webstorage"] : [];
const jsdomEnvironmentOptions = {
  jsdom: {
    url: "https://www.bilibili.com/video/BV1test000000/"
  }
};
const sharedProjectTestConfig = {
  execArgv,
  environmentOptions: jsdomEnvironmentOptions,
  setupFiles: ["tests/setup.ts"],
  clearMocks: true,
  testTimeout: 10000
};
const baseExclude = includeInstallerTest
  ? configDefaults.exclude
  : [...configDefaults.exclude, "tests/agent-bridge/install-agent-sh.test.ts"];

export default defineConfig({
  test: {
    execArgv,
    clearMocks: true,
    testTimeout: 10000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["extension/**/*.js", "extension/**/*.ts"],
      exclude: ["extension/icons/**"]
    },
    projects: [
      {
        test: {
          ...sharedProjectTestConfig,
          name: "unit-node",
          environment: "node",
          include: ["tests/**/*.test.js", "tests/**/*.test.ts"],
          exclude: [...baseExclude, "tests/ui/**", "tests/reader/**", "tests/e2e/**"]
        }
      },
      {
        test: {
          ...sharedProjectTestConfig,
          name: "unit-dom",
          environment: "jsdom",
          include: [
            "tests/ui/**/*.test.js",
            "tests/ui/**/*.test.ts",
            "tests/reader/**/*.test.js",
            "tests/reader/**/*.test.ts"
          ],
          exclude: baseExclude
        }
      },
      {
        test: {
          ...sharedProjectTestConfig,
          name: "e2e",
          environment: "jsdom",
          include: ["tests/e2e/**/*.test.js", "tests/e2e/**/*.test.ts"],
          exclude: baseExclude
        }
      }
    ]
  }
});
