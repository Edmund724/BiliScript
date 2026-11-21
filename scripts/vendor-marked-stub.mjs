const STUB_MESSAGE =
  "[BILISCRIPT] marked 已被体积裁剪替身替换：产品侧未启用 mermaid markdown label，此调用不应触发";

export function marked() {
  throw new Error(STUB_MESSAGE);
}

marked.use = function use() {
  throw new Error(STUB_MESSAGE);
};
