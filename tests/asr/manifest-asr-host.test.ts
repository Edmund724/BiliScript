import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8"));

describe("manifest：ASR 音频 CDN 的最窄 host 权限（工单 04）", () => {
  it("host_permissions 包含音频 CDN 域 https://*.bilivideo.com/*", () => {
    expect(manifest.host_permissions).toContain("https://*.bilivideo.com/*");
  });

  it("不以宽泛 <all_urls> 作为常驻 host 权限", () => {
    expect(manifest.host_permissions).not.toContain("<all_urls>");
  });

  it("DNR 会话规则所需权限 declarativeNetRequest 已声明", () => {
    expect(manifest.permissions).toContain("declarativeNetRequest");
  });

  it("站内域保持既有最窄集合（显式包含 B 站、YouTube 桌面端与直播间）", () => {
    expect(manifest.host_permissions).toEqual([
      "https://www.bilibili.com/*",
      "https://www.youtube.com/*",
      "https://live.bilibili.com/*",
      "ws://127.0.0.1/*",
      "https://api.bilibili.com/*",
      "https://index-translate.bilibili.com/*",
      "https://*.hdslb.com/*",
      "https://*.bilivideo.com/*",
      "https://*.bilivideo.cn/*",
      "https://*.akamaized.net/*",
      "https://api.tavily.com/*",
      "https://api.exa.ai/*",
      "https://api.firecrawl.dev/*",
      "https://open.feedcoopapi.com/*",
      "https://api.anysearch.com/*",
      "https://search.parallel.ai/*",
      "https://api.deepseek.com/*"
    ]);
  });
});
