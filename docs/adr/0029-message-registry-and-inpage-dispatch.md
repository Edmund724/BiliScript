# ADR-0029：单源消息注册表（BACKGROUND_MESSAGE_REGISTRY）、SW 路由与同帧内页分发槽

> 状态：有效

在 BiliScript 的 Service Worker（SW）、Offscreen 文档、Content Script 与 Popup/Settings 等多上下文通信架构中，我们决定以 `extension/shared/messaging-protocol.ts` 中的 **`BACKGROUND_MESSAGE_REGISTRY` 单源注册表** 驱动消息类型联合、发送端返回类型推断、特权发件人校验与 SW `Map` 路由，并通过 `extension/shared/messaging.ts` 的 **同帧内页分发槽（`dispatchContentScriptMessage`）** 解耦 Content Script 内部触发与 `entry/` 处理器，同时在 SW 边界施加跨标签页与渠道级安全约束。

## 背景与动机

1. **多端消息定义与路由漂移**：早期消息协议、`entry/background.ts` 路由表与 `sendMessage` 返回类型各自维护，新增或改名消息时容易漏注册、返回载荷不匹配、或混淆同步回包与异步 `return true` 通道。
2. **特权升级与原型链键冲突风险**：Offscreen 代发 HTTP、ASR 音频转写、片段缓存读写等特权消息仅允许 Offscreen 文档发起；而直接用普通对象索引 `handlers[message.type]` 会命中 `Object.prototype`（如 `"constructor"`、`"toString"`）。
3. **`chrome.runtime.sendMessage` 不回环同帧 Content Script**：`ui/script-button.ts` 触发阅读模式或自愈恢复时与 `entry/message-handler.ts` 处于同一 Content Script 帧，WebExtension 的 `chrome.runtime.sendMessage` 不会向发送者自身分派 `onMessage`；同时 `tests/layer-deps.test.ts` 严禁 `ui/` 静态引入 `entry/`。

## 已定决策

### 1. `BACKGROUND_MESSAGE_REGISTRY` 单源驱动与编译期穷尽路由

- `shared/messaging-protocol.ts` 以单一元数据注册表定义每条 Background 消息的 **响应类型、发送权（`offscreenOnly`）、回包模式（sync vs async `sendResponse`）与最小载荷形态谓词**。
- `core/message-router.ts` 与 `entry/background.ts` 通过 TypeScript `satisfies` 与注册表进行 1:1 编译期对齐，确保漏注册、多注册、错误返回形态或载荷字段漂移在 `tsc --noEmit` 阶段直接报错。
- 路由器内部将处理器表与 `storage-message-family.ts` 操作表拷贝进 ES `Map`（仅收自有键）分发，彻底阻断原型链键名碰撞；前置校验证明发件人为非 Offscreen 的特权请求直接返回 `{ ok: false, error }`，不触发任何副作用。

### 2. 同帧内页分发槽（`ui -> shared <- entry`）

- `entry/message-handler.ts` 向 `shared/messaging.ts` 的 `globalThis` 共享槽注册 `dispatchContentScriptMessage`；`ui/script-button.ts` 直接经该槽同步/进程内调起同一套 `enterReaderMode` / 恢复链，既消除无意义的 SW 往返延迟，又保持 `ui/` 对 `entry/` 的零静态依赖。

### 3. 渠道级纵深安全边界与未连接端口静默清理

- `entry/background.ts` 对 `player-ai-quick-action` 校验 `sender.tab.id === message.tabId`（防止恶意或异常页面帧伪造跨标签页操作），并在带扩展 Cookie 凭证的 `bgFetchJson` 消息入口强制执行 `isBiliUrl` 校验。
- `shared/messaging.ts` 在 `Port.onDisconnect` 中主动读取 `chrome.runtime.lastError` 并抑制已断开端口的异步延迟回包报错，避免 bfcache 或面板关闭后的未捕获异常噪音。

## 考虑过的备选

- **继续按字符串字面量在各域手写 `switch (message.type)`**：每新增消息需同步修改 4 处以上且无法防原型链键碰撞，予以否决。
- **允许 `ui/script-button.ts` 通过 SW `tabs.sendMessage` 回环自身或直接 `import` `entry/`**：前者平白增加 SW 冷启动与序列化延迟，后者破坏单向分层边界，予以否决。

## 后果

- 新增任意 SW 消息必须先登记进 `BACKGROUND_MESSAGE_REGISTRY` 并在 `entry/background.ts` 路由表中完成实现；`tests/shared/messaging-response-scan.test.ts` 与 `tests/core/message-router.test.ts` 持续守卫注册表与路由表全等性。
- 跨上下文通道继续以编译期契约为主，部分历史逆变回调与局部校验遗留已单列为类型重构技术债追踪。
