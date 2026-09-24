// 最小 marked 替身（体积裁剪）：mermaid 的 rendering-util/handle-markdown-text.ts
// 静态 import marked，但产品侧不给 mermaid 传 markdown label 配置（labelType
// 默认 "text"），运行时零调用——替身只需保住 import 面，并在真的被调用时大声
// 失败（而不是静默裁掉导致难以诊断的 undefined 行为）。经 esbuild alias
// （vendor-mermaid-slim.mjs 探针轮 + build-content.js 轮 B）接入，砍掉 ~80KB
// 的 marked 依赖树。构建守卫经 sourcemap sources 识别本文件（见
// build-content.js 的 mermaid stub 守卫）。

const STUB_MESSAGE =
  "[BILISCRIPT] marked 已被体积裁剪替身替换：产品侧未启用 mermaid markdown label，此调用不应触发";

export function marked() {
  throw new Error(STUB_MESSAGE);
}

marked.use = function use() {
  throw new Error(STUB_MESSAGE);
};
