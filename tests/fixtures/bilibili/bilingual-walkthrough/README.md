# bilingual-walkthrough fixture

`scripts/browser-harness/scenarios/bilingual-subtitles.mjs` 读的网络应答数据（**事实**，不是代码）。
场景只读这里，不生成、不写回；形状不变量由场景的 `--fixture-only` 自检钉住。

| 文件 | 内容 |
|---|---|
| `bundles.json` | 两个视频的 `x/player/wbi/v2` 应答：样本视频 `BV1mAam6tEL8` 的 8 条 `ai-*` 轨、单轨视频 `BV1FyHn6JE86` 的 1 条 `ai-zh` 轨 |
| `bodies.json` | 9 条字幕正文：`BV1mAam6tEL8-zh`（197 段）+ `en/ja/es/ar/pt/th/id`（各 188 段）+ `BV1FyHn6JE86-single-zh`（120 段） |
| `search-expectations.json` | 场景里四条搜索用例的期望命中数（主行 / 副行 / 合计），由**独立复算**得出 |
| `meta.json` | 形状事实与来源说明（197 / 188 / 9 组合并、合并段下标、轨列 lan、单轨视频的真网元数据） |

## 来源与口径

- 轨条目的形状（`lan` / `lan_doc` / `id_str` / `subtitle_url` / `ai_type` / `is_lock`）逐字取自
  bilingual-subtitles 票的 `research/01-track-shape.md`（该文件本身已丢失，数字转写在
  `../bv1mAam6tEL8-subtitle-shape.md`）。
- 197 / 188（= 197 − 9 组合并）的分段形状与「译文端点 ⊆ 中文端点」取自
  `research/03-track-alignment.md`。research/03 第 1 组合并额外跨一个中文空档，本 fixture
  未复现该空档（配对结果同为「2 主段 ↔ 1 副段」，搜索期望因此不受影响）。
- **正文字符串是合成语料**（`中文第N段…` / `EN-N …`）：它们只承担「哪条 token 出现在哪条轨的哪一段」
  这一件事。真实接口的文本内容不在本 fixture 的范围内。
- 单轨视频的 `aid` / `cid` / 时长来自 `x/web-interface/view` 的一次真网探测（2026-10-07：
  aid 117385415623802、cid 42470867665、时长 655s）；正文按该时长收口成 120 段。
- 匿名（无登录 cookie）时 `x/player/wbi/v2` 对任何视频都返回 0 轨，所以 8 轨样本**只能**来自
  fixture。场景的 PHASE 2 用 `fetch` 补丁把这两个应答换掉，其余全走真实扩展代码与真实渲染路径。

## 复算

`search-expectations.json` 的期望值不是手抄读数，而是按被测实现同一条配对规则（重叠时长 > 0 的副轨段
按 `from` 升序空格拼接、再按 token 计数）在场景里独立算一遍、与这里逐项比对的。改了 fixture 就得让
这条比对继续通过——这正是 `pnpm harness:scenario bilingual-subtitles -- --fixture-only` 做的事。
