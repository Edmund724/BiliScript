# BV1mAam6tEL8 字幕轨与 body 形状（真机实测记录）

**这是转写的记录，不是响应副本。** 原始响应正文（`subtitle_url` 的签名 URL 与语料）没有随记录保留。本文件保留的是
2026-10-06 真机实测得到的**轨条目形状、body 形状、条数与对齐数字**。需要真响应就按下面「取数路径」重抓。

来源两处，都在 gitignore 的 `.scratch/` 里，本文件是它们的入库转写：

- `.scratch/tickets/bilingual-subtitles/research/03-track-alignment.md`（真机实测原始记录）
- `.scratch/tickets/bilingual-subtitles/walkthrough/drive.mjs` 的 `trackEntry` / `bundleFor`

同一份 drive.mjs 的注释自述其 bundle 形状「取自 `research/01-track-shape.md`（`lan` / `lan_doc` / `id_str` /
`subtitle_url` 逐字同形）」，但**那个文件已经不在了**（`research/` 目录只剩 03）。所以下面的轨条目形状是从
drive.mjs 的实时代码转写的。

## 样本

| 项 | 值 |
|---|---|
| bvid | `BV1mAam6tEL8` |
| aid | 117370433574328 |
| cid | 42393338874 |
| 时长 | 461s |

## 取数路径（必须带 cookie）

1. 页面上下文 `fetch('https://api.bilibili.com/x/player/wbi/v2?aid=…&cid=…&bvid=…', { credentials: 'include' })`
2. → `data.subtitle.subtitles[].subtitle_url`
3. → `fetch(subtitle_url, { credentials: 'omit' })` 取各轨 body JSON

**宿主机直连同一 URL 返回 `code: 0` 但 `subtitles` 为空，原因是 `need_login_subtitle`。** 匿名抓到的形状不完整，
不要拿它当样本；扩展自己走的是页面 / SW 侧带 cookie 的路径。

## 轨条目形状（`data.subtitle.subtitles[]` 的单元）

| 字段 | 值 / 样例 | 说明 |
|---|---|---|
| `id` | 2120476497172283392 | JSON 数字，> 2^53，取它会丢精度 |
| `id_str` | `"2120476497172283392"` | **轨身份取这个** |
| `lan` | `"ai-zh"` / `"ai-en"` / … | |
| `lan_doc` | `"中文"` / `"English"` / `"日本語"` / … | |
| `subtitle_url` | 签名 CDN URL | 本记录未保留 |
| `subtitle_url_v2` | 同上 | 本记录未保留 |
| `type` | `1` | |
| `ai_type` | `0`（原语言）/ `1`（译文） | |
| `ai_status` | `2` | |
| `is_lock` | `false` | |

外层信封：

```json
{
  "code": 0,
  "message": "0",
  "ttl": 1,
  "data": {
    "aid": 117370433574328,
    "bvid": "BV1mAam6tEL8",
    "cid": 42393338874,
    "subtitle": {
      "allow_submit": false,
      "lan": "",
      "lan_doc": "",
      "subtitle_position": 2,
      "font_size_type": 0,
      "subtitles": []
    },
    "view_points": []
  }
}
```

## 实测到的 8 条轨

`lan` / `lan_doc` / `ai_type` 为实测值；`id` / `id_str` 转写自 drive.mjs（原响应未保留，无法二次复核）。

| # | `lan` | `lan_doc` | `ai_type` | `id_str` |
|---|---|---|---|---|
| 1 | `ai-zh` | 中文 | 0 | 2120476497172283392 |
| 2 | `ai-en` | English | 1 | 2121827445538866944 |
| 3 | `ai-ja` | 日本語 | 1 | 2121827727664517376 |
| 4 | `ai-es` | Español | 1 | 2121827577382789888 |
| 5 | `ai-ar` | العربية | 1 | 2121827639181244928 |
| 6 | `ai-pt` | Português | 1 | 2121827571862717184 |
| 7 | `ai-th` | ภาษาไทย | 1 | 2121827533660947200 |
| 8 | `ai-id` | Bahasa Indonesia | 1 | 2121827596601095936 |

## body JSON 形状（逐字）

顶层键：`font_size, font_color, background_alpha, background_color, Stroke, type, lang, version, body`
值样例：`font_size = 0.4`、`font_color = "#FFFFFF"`、`background_alpha = 0.5`

段键**两套不同，照抄各自那套**：

- 原语言轨（`ai-zh`）：`from, to, sid, location, content, music`
- 译文轨：`from, to, content, sid`（**没有** `location` / `music`）

## 分段对齐数字（实测）

| 轨 | 段数 | body 字节 |
|---|---|---|
| `ai-zh` | **197** | 28506 |
| `ai-en` | **188** | 26720 |
| `ai-ja` | 188 | 21729 |
| `ai-es` | 188 | 26592 |
| `ai-ar` | 188 | 24717 |
| `ai-pt` | 188 | 26392 |
| `ai-th` | 188 | 24243 |
| `ai-id` | 188 | 25698 |

- 译文轨的 188 段里，**179 段的 `(from, to)` 与 `ai-zh` 完全相同** → 差异全部是合并，没有反向细分。
- 各轨首段 `from = 0.18`、末段 `to = 458.5`。
- **按索引比较无意义**：逐索引相同只有 15/188。
- `ai-en` 与 `ai-ja` 的 `from` / `to` 序列逐字节相同；其余 5 条只对过统计量与端点（未逐条 diff）。
- 语料规模：zh 正文 2090 字 / en 9225 字。

## 9 个合并段（en 侧）

```
40.69~51.54   128.87~130.4   210.49~212.61   215.05~218.53   245.21~248.62
267.46~272.36 296.39~299.719 331.16~335.3    353.78~355.74
```

后 8 组是**严格相邻两段**合并，边界与 `ai-zh` 的端点一一吻合。第 1 组额外跨了一个 zh 空档：

```
zh 侧：40.69~42.61 「还是随便勾一个」 / 42.61~46.26（无段，空档） / 46.26~51.54
en 侧：40.69~51.54 一段盖住上面两段 + 空档
```

即：译文轨的合并**不引入新端点**，只把 zh 的相邻两段（偶有一处跨空档）并成一段。

## 拿它造 fixture

按上面 9 个区间把省下的段并起来，就能用合成语料造出「zh 197 段 ↔ 译文 188 段」的 fixture。当年那份生成器在
`.scratch/tickets/bilingual-subtitles/walkthrough/drive.mjs` 的 `buildTimeline` / `buildFixtureBodies` 里，随那份
一次性走查脚本留在 `.scratch/`（不入库）。要在真机场景里用，照本文件重建，不要从 `.scratch` 引。
