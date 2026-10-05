// extension/ui/provider-editor.ts — 平台编辑 Modal 的对外导出壳（工单 12 分片）。
//
// 原 provider-editor.ts（992 行）沿既有分节切成四片，函数体逐字节搬移、零逻辑改动；
// 本文件退化为逐名再导出壳，对外导出面与导入路径零变化（消费方 settings-panel
// 等零改动）：
//
//   provider-editor-state.ts          状态袋（单例，对外只读）+ 会话写入原语
//                                     （beginEditorSession / endEditorSession /
//                                     editDraft）+ 结算原语（captureSession /
//                                     runIfCurrent）+ 字段/DOM 读原语 + 对外类型
//                                     （零运行时 import，纯片；照 analysis-validate.ts
//                                     先例）
//   provider-editor-projection.ts     字段投影表（DOM 形态 + 目标态规则 + input
//                                     回写声明）+ 协议/预设投影口径；模板与两类
//                                     联动共用同一投影点
//   provider-editor-catalog.ts        AI 平台「模型目录」内联行（行模板 / 草稿增删 /
//                                     空态 / 红字错误 / 行级连通测试）
//   provider-editor-fetch-dialog.ts   「获取可用模型」勾选弹窗（骨架 / 搜索 / 全选
//                                     三态 / 已添加置灰 / 失败原位重试）
//   provider-editor-modal.ts          Modal 本体（打开 / 关闭与 dirty 保护 / 模板
//                                     布局 / 挂载与全局监听 / 事件委托接线 + 保存 /
//                                     删除 / 测试连接三条动作）
//
// 契约要点（跨片分发，详见各片头注）：
//   - Modal（AI / ASR 共用）：点列表行「编辑」或「+ 添加平台」打开的面板内弹层
//     （reader/explain-card.ts 先例：mask + role=dialog + Esc 文档级捕获 + 焦点进
//     对话框）；字段全量平铺，底部「取消 / 保存」。
//   - 保存只落盘这一个平台（单平台 upsert 委托注入的 onSave，整列表落盘、权限
//     代申请、orphan 回收与重渲收口在 ui/provider-transaction.ts 的单点事务）。
//   - 「获取可用模型」的域名权限代申请全仓唯一处在 fetch 片的 openFetchDialog，
//     保持在点击同步链（零先行 await）——等价行为断言见 tests/ui/
//     provider-editor.test.ts 与 provider-editor-session.test.ts。
//   - 关闭语义（拍板 Q6）与抽屉收起联动（hidden → 强制关闭）实现在 modal 片。

export { closeProviderEditor, isProviderEditorOpen, openProviderEditor } from "./provider-editor-modal.js";
export type {
  ProviderEditorDelete,
  ProviderEditorKind,
  ProviderEditorOpenOptions,
  ProviderEditorSave
} from "./provider-editor-state.js";
