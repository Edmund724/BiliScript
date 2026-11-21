import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8"));

describe("manifest：搜索平台 host 权限（spec §2.4）", () => {
  it("host_permissions 包含七家搜索 API 域", () => {
    expect(manifest.host_permissions).toContain("https://api.firecrawl.dev/*");
    expect(manifest.host_permissions).toContain("https://api.tavily.com/*");
    expect(manifest.host_permissions).toContain("https://open.feedcoopapi.com/*");
    expect(manifest.host_permissions).toContain("https://api.anysearch.com/*");
    expect(manifest.host_permissions).toContain("https://search.parallel.ai/*");
    expect(manifest.host_permissions).toContain("https://api.exa.ai/*");
    expect(manifest.host_permissions).toContain("https://api.deepseek.com/*");
    expect(manifest.host_permissions).not.toContain("https://api.search.brave.com/*");
  });

  it("不引入宽泛通配常驻权限", () => {
    for (const origin of manifest.host_permissions) {
      expect(origin).not.toBe("<all_urls>");
      expect(origin).not.toBe("https://*/*");
      expect(origin).not.toBe("http://*/*");
    }
  });
});
