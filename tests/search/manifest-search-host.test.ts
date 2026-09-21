// spec §2.4：搜索平台三家域名的 host 权限声明（SW 经 provider-http 通道发搜索
// 请求，密钥不出 SW）。三家国内直连性官方均无承诺，实测记录归验收清单。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// vitest 固定从仓库根启动（package.json scripts），manifest 以仓库根相对路径读取
const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8"));

describe("manifest：搜索平台 host 权限（spec §2.4）", () => {
  it("host_permissions 包含三家搜索 API 域", () => {
    expect(manifest.host_permissions).toContain("https://api.tavily.com/*");
    expect(manifest.host_permissions).toContain("https://api.exa.ai/*");
    expect(manifest.host_permissions).toContain("https://api.search.brave.com/*");
  });

  it("不引入宽泛通配常驻权限", () => {
    for (const origin of manifest.host_permissions) {
      expect(origin).not.toBe("<all_urls>");
      expect(origin).not.toBe("https://*/*");
      expect(origin).not.toBe("http://*/*");
    }
  });
});
