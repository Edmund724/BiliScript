import { execFile, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const INSTALL_SCRIPT = resolve("scripts/install-agent.sh");
const SKILL_SOURCE = resolve("skills/biliscript");
const tempRoot = mkdtempSync(join(tmpdir(), "biliscript-install-sh-test-"));
const spawnedPids = new Set<number>();
const IS_WINDOWS = /^[A-Za-z]:[\\/]/.test(process.execPath);

function findPosixShell(): string {
  if (!IS_WINDOWS) return "/bin/sh";
  const candidates = [
    "C:\\Program Files\\Git\\bin\\sh.exe",
    "C:\\Program Files (x86)\\Git\\bin\\sh.exe"
  ];
  const whereResult = spawnSync("where.exe", ["git"], { encoding: "utf8" });
  const gitPath = whereResult.stdout?.split(/\r?\n/)[0]?.trim();
  if (gitPath) {
    candidates.unshift(resolve(dirname(gitPath), "..", "bin", "sh.exe"));
  }
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error("未找到用于执行 POSIX 安装脚本的 sh 可执行文件");
  }
  return found;
}

function toShellArg(filePath: string): string {
  if (!IS_WINDOWS) return filePath;
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
}

function buildShellEnv(extraEnv: Record<string, string> = {}): Record<string, string | undefined> {
  if (extraEnv.PATH !== undefined) {
    return { ...process.env, ...extraEnv };
  }
  const pathSep = IS_WINDOWS ? ";" : ":";
  const extraPaths = [dirname(process.execPath)];
  if (IS_WINDOWS) {
    const gitUsrBin = "C:\\Program Files\\Git\\usr\\bin";
    if (existsSync(gitUsrBin)) extraPaths.push(gitUsrBin);
  }
  const basePath = process.env.PATH ?? "";
  return {
    ...process.env,
    ...extraEnv,
    PATH: [...extraPaths, basePath].filter(Boolean).join(pathSep)
  };
}

function runInstaller(
  args: string[],
  extraEnv: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  const sh = findPosixShell();
  return new Promise((resolveRun) => {
    execFile(
      sh,
      [toShellArg(INSTALL_SCRIPT), ...args],
      { env: buildShellEnv(extraEnv) },
      (error, stdout, stderr) => {
        const exitCode = error && "code" in error && typeof error.code === "number" ? error.code : error ? 1 : 0;
        resolveRun({ code: exitCode, stdout, stderr });
      }
    );
  });
}

function extractStatusJson(stdout: string): { ok: boolean; daemonPid: number; extensionOnline: boolean } {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") && line.endsWith("}"));
  const last = lines[lines.length - 1];
  if (!last) throw new Error(`安装输出中未找到状态 JSON：\n${stdout}`);
  return JSON.parse(last) as { ok: boolean; daemonPid: number; extensionOnline: boolean };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterAll(() => {
  for (const pid of spawnedPids) {
    try {
      process.kill(pid);
    } catch {
      // Daemon already exited.
    }
  }
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("POSIX 安装脚本 scripts/install-agent.sh", () => {
  it("本地源安装成功并启动 Daemon，重复安装原子替换并重启为新 PID", async () => {
    const skillRoot = join(tempRoot, "local-install", "skills");
    const tokenPath = join(tempRoot, "local-install", "bridge.token");
    const port = String(22000 + Math.floor(Math.random() * 1000));
    const env = {
      BILISCRIPT_BRIDGE_PORT: port,
      BILISCRIPT_BRIDGE_TOKEN_PATH: tokenPath,
      BILISCRIPT_BRIDGE_IDLE_MS: "15000"
    };

    const first = await runInstaller(
      ["--source-dir", toShellArg(SKILL_SOURCE), "--skill-root", toShellArg(skillRoot)],
      env
    );
    expect(first.code, `stderr: ${first.stderr}\nstdout: ${first.stdout}`).toBe(0);
    const installedSkill = join(skillRoot, "biliscript", "SKILL.md");
    const installedCli = join(skillRoot, "biliscript", "scripts", "biliscript.mjs");
    expect(readFileSync(installedSkill, "utf8")).toBe(readFileSync(join(SKILL_SOURCE, "SKILL.md"), "utf8"));
    expect(readFileSync(installedCli, "utf8")).toBe(readFileSync(join(SKILL_SOURCE, "scripts", "biliscript.mjs"), "utf8"));

    const firstStatus = extractStatusJson(first.stdout);
    expect(firstStatus.ok).toBe(true);
    expect(firstStatus.daemonPid).toBeGreaterThan(0);
    spawnedPids.add(firstStatus.daemonPid);
    expect(isProcessAlive(firstStatus.daemonPid)).toBe(true);

    // 写入旧目录标记文件，验证再次安装会替换目录并杀掉旧 Daemon、启动新 PID
    const staleMarker = join(skillRoot, "biliscript", "stale.txt");
    writeFileSync(staleMarker, "stale");

    const second = await runInstaller(
      ["--source-dir", toShellArg(SKILL_SOURCE), "--skill-root", toShellArg(skillRoot)],
      env
    );
    expect(second.code, `stderr: ${second.stderr}\nstdout: ${second.stdout}`).toBe(0);
    expect(existsSync(staleMarker)).toBe(false);

    const secondStatus = extractStatusJson(second.stdout);
    expect(secondStatus.ok).toBe(true);
    expect(secondStatus.daemonPid).toBeGreaterThan(0);
    expect(secondStatus.daemonPid).not.toBe(firstStatus.daemonPid);
    spawnedPids.add(secondStatus.daemonPid);
    expect(isProcessAlive(firstStatus.daemonPid)).toBe(false);
    expect(isProcessAlive(secondStatus.daemonPid)).toBe(true);
  }, 20000);

  it("Node.js 版本低于 22.20 时拒绝安装并提示升级", async () => {
    const fakeBin = join(tempRoot, "old-node-bin");
    const skillRoot = join(tempRoot, "old-node-skills");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(fakeBin, "node"), "#!/bin/sh\necho 20.18.0\n");
    chmodSync(join(fakeBin, "node"), 0o755);

    const baseBin = IS_WINDOWS ? "C:\\Program Files\\Git\\usr\\bin" : "/usr/bin:/bin";
    const result = await runInstaller(
      ["--source-dir", toShellArg(SKILL_SOURCE), "--skill-root", toShellArg(skillRoot)],
      { PATH: `${fakeBin}${IS_WINDOWS ? ";" : ":"}${baseBin}` }
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Node.js 版本过低");
    expect(result.stderr).toContain("22.20");
    expect(existsSync(join(skillRoot, "biliscript"))).toBe(false);
  });

  it("GitHub 归档下载失败时回退到 jsDelivr 下载并重启 Daemon", async () => {
    const skillMd = readFileSync(join(SKILL_SOURCE, "SKILL.md"), "utf8");
    const cliMjs = readFileSync(join(SKILL_SOURCE, "scripts", "biliscript.mjs"), "utf8");
    const server = http.createServer((req, res) => {
      if (req.url === "/fallback/SKILL.md") {
        res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
        res.end(skillMd);
        return;
      }
      if (req.url === "/fallback/scripts/biliscript.mjs") {
        res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
        res.end(cliMjs);
        return;
      }
      res.writeHead(500);
      res.end("upstream unavailable");
    });

    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("无法绑定本地测试 HTTP 服务");

    try {
      const skillRoot = join(tempRoot, "fallback-install", "skills");
      const tokenPath = join(tempRoot, "fallback-install", "bridge.token");
      const port = String(23000 + Math.floor(Math.random() * 1000));
      const base = `http://127.0.0.1:${address.port}`;
      const result = await runInstaller(
        ["--skill-root", toShellArg(skillRoot)],
        {
          BILISCRIPT_INSTALL_ARCHIVE_URL: `${base}/archive.tar.gz`,
          BILISCRIPT_INSTALL_FALLBACK_BASE_URL: `${base}/fallback`,
          BILISCRIPT_BRIDGE_PORT: port,
          BILISCRIPT_BRIDGE_TOKEN_PATH: tokenPath,
          BILISCRIPT_BRIDGE_IDLE_MS: "15000"
        }
      );

      expect(result.code, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
      expect(result.stdout).toContain("jsDelivr");
      expect(readFileSync(join(skillRoot, "biliscript", "SKILL.md"), "utf8")).toBe(skillMd);
      expect(readFileSync(join(skillRoot, "biliscript", "scripts", "biliscript.mjs"), "utf8")).toBe(cliMjs);

      const status = extractStatusJson(result.stdout);
      expect(status.ok).toBe(true);
      expect(status.daemonPid).toBeGreaterThan(0);
      spawnedPids.add(status.daemonPid);
      expect(isProcessAlive(status.daemonPid)).toBe(true);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  }, 20000);
});
