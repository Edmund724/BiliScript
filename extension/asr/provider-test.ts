// extension/asr/provider-test.ts
// ASR 平台连通性测试探针的**页面侧入参层**（设置抽屉「测试」按钮的入口）。
//
// 职责边界：本模块只做探针入参的预检与组装——草稿归一化、baseUrl / 模型名校验、
// Key 代查（表单重输优先，否则按 id 读已存 Key）、语言档位取全局设置；**探针本体
// 在 offscreen 跑真适配器**（asr/offscreen-bridge.page.js 的
// probeAsrProviderViaOffscreen → entry/offscreen-asr.js 的 asr-probe 处理）。
//
// 为什么不再在本模块里发 fetch（本次修复）：设置抽屉是 script-only-ui，跑在
// B 站页面的 content script 里，那里的探针与真实转写（offscreen 文档）根本不是
// 一件事——
//   ① content script 没有 chrome.permissions，页面侧的 host 权限预检必然 fail-open
//      （core/host-permissions.js），域名未授权也照样放行；
//   ② content script 的 fetch 受网页 CORS 约束，而扩展文档里的出口只受 host 权限
//      约束：平台回一个 ACAO 就能让探针在未授权时拿到 200，「连接成功」证明不了
//      真跑出得去浏览器；
//   ③ 探针验的是草稿配置，真跑用的是已保存配置（offscreen 直读 background 的
//      运行时配置），「填了没保存的 Key」会让测试过、真跑 401。
// 三者叠加正是「测试连接成功、实际转写失败」的成因。现在探针与实际转写同链，
// 权限门、URL/表单构造、失败文案与分类都由适配器一处给出。

// arch-slim-2/09：AsrProvider 的归一化在 asr/ 域内（asr-provider-normalize.js）。
import { normalizeAsrProvider } from "./asr-provider-normalize.js";
import { getMergedSettings } from "../core/settings-store.js";
import { asrProviderStore } from "./asr-provider-store.js";
import { probeAsrProviderViaOffscreen } from "./offscreen-bridge.page.js";

export interface AsrProbeResult {
  ok: boolean;
  error?: string;
}

// 按 provider.type 分发到对应探针。provider 可直接带 apiKey（前端测试按钮
// 用户重输的场景），也可不带（由 providerId 从已存 Key 读取）。
// 返回 { ok: boolean, error?: string }，error 为可直接展示的文案（本地预检 /
// 未授权提示 / 平台 HTTP 报文 / 通道故障），本层不改写探针正文。
export async function testAsrConnection(provider: unknown): Promise<AsrProbeResult> {
  let normalized = normalizeAsrProvider(provider);
  if (!normalized) {
    // 新增平台场景：Modal 尚未分配 id（editingId 为空），normalizeAsrProvider
    // 因缺 id 返回 null；Key 随参携带、无需按 id 代查时探针仍可执行，注入占位 id
    // 放行归一化（占位 id 不落盘，仅复用 type/baseUrl/model 校验）。
    const raw = provider as { id?: string; apiKey?: string };
    if (!String(raw?.id || "").trim() && String(raw?.apiKey || "").trim()) {
      normalized = normalizeAsrProvider({ ...raw, id: "__probe-draft__" });
    }
  }
  if (!normalized) {
    return { ok: false, error: "平台配置不完整或 type 非法" };
  }
  // baseUrl 已由 normalizeAsrProvider 归一（去空白与尾斜杠），空即不可探。
  // 这两条是本地预检，不建端口、不发请求。
  if (!normalized.baseUrl) {
    return { ok: false, error: "请填写 baseUrl" };
  }
  if (!normalized.model) {
    return { ok: false, error: "请填写模型名" };
  }

  // 解析 apiKey：优先 provider.apiKey，否则按 id 读已存 Key
  const apiKey = await asrProviderStore.resolveDraftApiKey(
    (provider as { apiKey?: string })?.apiKey,
    normalized.id
  );

  // 语言档位来自全局设置 asrLanguage（popup 顶部切换），与实际转写取同一份
  // （offscreen 侧 provider.language 也由该设置注入）：探针验的就是真跑的
  // 语言链路（SiliconFlow 辰星只有 ?language=english 才启用英文识别）。
  let language = "";
  try {
    const settings = await getMergedSettings();
    language = (settings?.asrLanguage as string) || "";
  } catch {
    // 设置读取失败不阻塞探针：按 auto 处理（不附语言参数）
  }

  return probeAsrProviderViaOffscreen({
    type: normalized.type,
    baseUrl: normalized.baseUrl,
    model: normalized.model,
    apiKey,
    language
  });
}
