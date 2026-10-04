# 🎬 Subtitle Desk — 小团队视频字幕校对台

供小团队在**本机/内网**协作校对视频字幕的 Web 应用：浏览器时间轴上按毫秒增删改字幕片段、
实时预览、审校、发布不可变版本并导出 SRT。视频文件与 SQLite 数据全部保存在运行服务的本机磁盘。

## 功能一览

- **上传视频**：浏览器读取视频时长（毫秒）并与文件一起上传；服务端流式播放，支持 Range 拖动。
- **毫秒级片段管理**：在时间轴上点击定位，按「起点/终点（ms）」新增、编辑、删除字幕片段。
- **硬性时间规则**（服务端事务内校验，前端输入原样保留、原稿不动）：
  - 起点必须早于终点；
  - 终点不得超过视频时长，起点不得为负；
  - 同视频片段之间**不得时间重叠**（端点相接允许）；
  - 非法操作返回 `422` 与中文原因，编辑弹窗保持你未提交的输入，可修改后重试。
- **乐观锁修订号 `revision`**：
  - 每次修改（含审校、删除）都必须携带「所见修订号」；
  - 修订号过期返回 `409` 冲突与**当前片段内容**，绝不覆盖他人修改；
  - 前端 5 秒自动轮询他人改动（编辑弹窗打开时暂停），收到冲突弹窗可选择放弃或基于最新内容重编。
- **审校流**：片段有 `待审 / 已审` 状态；**修改已审片段的内容会自动撤销其审校状态**（仅切换审校状态不会）。
- **发布门禁**：至少 1 个片段、全部已审、时间全部合法才能发布。
- **不可变版本**：发布把当前片段整体快照存库；之后的编辑只影响草稿，历史发布版本永不改变。
- **SRT 导出**：下载时可选择「草稿」「最新已发布」或任意历史版本（`?version=draft|published|<版本号>`）。
- **SRT 导入（预览 → 确认）**：为已有视频导入本地 SRT：
  - 接受 UTF-8（可含 BOM）、CRLF/LF 混用、序号不连续、多行文本的标准 SRT；
  - 先**预览**解析结果（每个条目含 SRT 序号与原文件行号）以及与当前草稿的逐条时间冲突；
  - 再选择**追加到草稿**（有冲突时禁止）或**替换整个草稿**；导入片段一律为**待审**，已发布版本及其 SRT 不变；
  - 空文件、格式错误、负时间、起止倒置、越过视频时长、导入条目互相重叠时返回**具体条目与行号**，且绝不写入；
  - 预览与确认之间草稿若被任何人修改，确认返回 `409` 并要求重新预览，绝不覆盖他人更改；整批写入在一个事务内，要么全部成功要么完全不变。
- **区间恢复（从历史发布版本恢复某一时间段，预览 → 确认）**：
  - 选定某个历史发布版本与整数毫秒区间（起点早于终点且均在视频时长内），先并列查看区间内**发布快照**与**当前草稿**片段，以及确认后将**移除/恢复**的片段清单；
  - 区间边界若**穿过任一侧（草稿或历史快照）字幕片段**，预览即拒绝并逐条指出片段（草稿给片段号、历史给“第 n 段”）与时间（端点相接允许）；
  - 区间内以历史片段**整体替换**：区间内草稿片段整体删除，历史片段作为**新草稿片段**插入且**一律待审、修订号从 1 开始**；区间外草稿片段（含审校状态与修订号）、历史发布版本与现有 SRT 导出语义均不变；
  - 确认的版本与区间必须与预览一致；预览后草稿发生增删改或审校变化时确认返回 `409` 并要求重新预览；版本不存在、区间越界或替换后时间线不合法时绝不写入；整批恢复在一个事务内原子完成，并沿用现有片段修订号冲突与发布门禁约定（恢复片段为待审，未审校前不能发布）。

## 一键启动（Docker Compose，推荐）

需要 Docker 与 Docker Compose v2。

```bash
docker compose up -d --build
```

启动后访问：

- **应用地址**：http://localhost:8080
- **监听端口**：容器内 `8080`，宿主机默认映射 `8080:8080`

停止 / 查看日志：

```bash
docker compose down
docker compose logs -f
```

数据（SQLite 数据库 `app.db` 与上传的视频文件）保存在 Docker 卷 `subtitle-data`
（挂载到容器 `/app/data`），容器重建不丢失。

如不想用命名卷，可把 `docker-compose.yml` 中的卷改为绑定挂载：

```yaml
    volumes:
      - ./data:/app/data
```

## 本地直接运行（Node.js ≥ 20）

```bash
npm install
npm start
```

同样访问 http://localhost:8080 。数据默认写入项目下 `./data/`。

运行端到端测试（覆盖校验、冲突、审校撤销、发布门禁、不可变版本、SRT 导入与区间恢复等 184 个断言）：

```bash
npm test
```

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 服务监听端口 |
| `HOST` | `0.0.0.0` | 监听地址；仅本机使用可设 `127.0.0.1` |
| `DB_PATH` | `./data/app.db` | SQLite 数据库文件路径，首次启动自动建表初始化 |
| `UPLOAD_DIR` | `./data/videos` | 上传视频存储目录，自动创建 |
| `MAX_UPLOAD_MB` | `2048` | 单个视频上传大小上限（MB） |
| `MAX_SRT_KB` | `10240` | 单个 SRT 导入文件大小上限（KB，默认 10 MB，仅内存解析） |

Compose 中改宿主机端口示例（宿主 9000 → 容器 8080）：

```yaml
    ports:
      - "9000:8080"
```

## 使用流程

1. 打开首页，填写标题并选择视频文件上传（需浏览器可解析的 MP4/WebM 等格式）。
2. 进入工作台：播放视频或点击时间轴定位，用「＋ 新增片段」并可一键取播放位置为起止时间。
3. 在片段表中编辑、删除、定位；逐条「标记已审」。绿色=已审，蓝色=待审。
4. 需要套用现成字幕时，点片段列表右上角「⬆ 导入 SRT…」：选择本地 `.srt` 后「解析并预览」，
   核对每条的 SRT 序号、原文件行号、时间与多行文本，以及与当前草稿的冲突；
   无冲突可「追加到草稿」，或随时「替换整个草稿」（已发布版本不受影响）。
   若预览期间草稿被他人改动，确认时会被拒绝并自动按最新草稿重新预览。
5. 需要把某段时间的字幕回退到历史发布版本时，点片段列表右上角「⏪ 从历史版本恢复区间…」：
   选择已发布版本与起止毫秒（可一键取播放位置）后「预览」，左右并列核对区间内当前草稿（将移除）
   与历史快照（将恢复，含“第 n 段”序号），确认后整批原子替换；恢复片段均为待审新片段，需重新审校才能发布。
6. 右侧「发布与下载」面板实时列出阻塞发布的问题；全部满足后点「发布新版本」。
7. 用「下载 SRT ▾」选择草稿或任一已发布版本导出。

## HTTP API 摘要

所有写操作的 JSON 请求体均需携带整数修订号 `revision`（新增片段除外）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/videos` | multipart 上传：`title`、`duration_ms`、`video` |
| `GET` | `/api/videos` / `/api/videos/:id` | 列表 / 详情（含片段与发布版本） |
| `DELETE` | `/api/videos/:id` | 删除视频及其全部数据 |
| `GET` | `/api/videos/:id/media` | 视频流（支持 `Range`） |
| `POST` | `/api/videos/:id/segments` | 新增片段 `{start_ms,end_ms,text}` |
| `PUT` | `/api/videos/:id/segments/:sid` | 修改 `{start_ms,end_ms,text,revision}` |
| `DELETE` | `/api/videos/:id/segments/:sid` | 删除（JSON 体带 `revision`） |
| `POST` | `/api/videos/:id/segments/:sid/review` | 审校切换 `{reviewed,revision}` |
| `GET` | `/api/videos/:id/status` | 发布门禁检查 |
| `POST` | `/api/videos/:id/publish` | 发布不可变版本 |
| `GET` | `/api/videos/:id/publications` | 已发布版本列表 |
| `POST` | `/api/videos/:id/srt/preview` | 预览 SRT 导入（multipart 字段 `srt`，或 JSON `{content}`），返回条目/行号/草稿冲突与确认令牌 `token` |
| `POST` | `/api/videos/:id/srt/import` | 确认写入：multipart 或 JSON 携带 `srt`/`content`、`mode=append\|replace`、预览返回的 `token` |
| `POST` | `/api/videos/:id/restore/preview` | 区间恢复预览：JSON `{version,start_ms,end_ms}`，并列返回区间内草稿/历史快照、将移除与将恢复清单及确认令牌 `token` |
| `POST` | `/api/videos/:id/restore/confirm` | 确认恢复：JSON 原样回传 `{version,start_ms,end_ms,token}`，事务内整批原子替换 |
| `GET` | `/api/videos/:id/srt?version=` | 导出 SRT：`draft`（默认）/ `published` / `1` 等版本号 |

错误响应统一为 `{ "error": { "code", "message", "current?" } }`：
`422` 为非法修改（含原因），`409` 为修订冲突（`current` 为最新片段）。

### SRT 导入调用示例（两步：预览 → 确认）

SRT 必须原样提交两次（multipart 文件字段 `srt`，或 JSON 字符串字段 `content`；UTF-8，可含 BOM），
服务端用 HMAC 令牌把「所见 SRT 内容 + 草稿指纹」绑定到确认请求；令牌随服务进程重启失效。

第一步——预览（不写入）：

```bash
# multipart
curl -s -X POST http://localhost:8080/api/videos/12/srt/preview \
  -F "srt=@subtitles.srt;type=application/x-subrip"
```

```bash
# 或 JSON
curl -s -X POST http://localhost:8080/api/videos/12/srt/preview \
  -H 'Content-Type: application/json' \
  --data-binary @<(jq -Rs '{content: .}' subtitles.srt)
```

成功返回（节选）：

```json
{
  "draft_count": 2,
  "imported_count": 3,
  "entries": [
    { "entry": 1, "seq": 1, "line": 1, "time_line": 2,
      "start_ms": 1000, "end_ms": 2000, "text": "第一句" }
  ],
  "conflicts": [
    { "entry": 1, "seq": 1, "line": 1, "segment_id": 7,
      "start_ms": 1500, "end_ms": 2500,
      "message": "导入条目「序号 1」（原文件第 1 行）（1000–2000ms）与现有草稿片段 #7（1500–2500ms）时间冲突" }
  ],
  "append_blocked": true,
  "token": "eyJ2IjoxMiwibSI6InByZXZpZXci…….签名"
}
```

解析/时间不合法时返回 `422 invalid_srt`，`errors[]` 逐条给出 `code / entry / seq / line / message`
（错误码：`empty_srt / bad_index / missing_timestamp / bad_timestamp / bad_time_component /
unexpected_line / negative_time / reversed_time / beyond_duration / imported_overlap / text_too_long / draft_conflict`）。

第二步——确认（同一份 SRT + `mode` + 预览 `token`）：

```bash
# 追加（仅当无草稿冲突时成功）
curl -s -X POST http://127.0.0.1:8080/api/videos/12/srt/import \
  -F "srt=@subtitles.srt;type=application/x-subrip" \
  -F "mode=append" \
  -F "token=eyJ2IjoxMiwibSI6InByZXZpZXci…….签名"

# 替换整个草稿（仅影响草稿；已发布版本不变；导入片段均为待审）
curl -s -X POST http://127.0.0.1:8080/api/videos/12/srt/import \
  -F "srt=@subtitles.srt;type=application/x-subrip" \
  -F "mode=replace" \
  -F "token=eyJ2IjoxMiwibSI6InByZXZpZXci…….签名"
```

返回 `201 { ok, mode, imported_count, segments }`。失败约定：

| 状态 / code | 含义 |
| --- | --- |
| `422 invalid_srt` | 解析或时间校验失败（含每条行号），事务未写入 |
| `422 srt_changed` | 确认时的 SRT 内容与预览不一致，需重新预览 |
| `422 invalid_mode` | `mode` 不是 `append` / `replace` |
| `409 preview_required` | 缺失/伪造/过期（服务重启）令牌，需先预览 |
| `409 draft_changed` | 预览后草稿被修改；响应附 `current_segments`，必须重新预览后再确认 |

### 区间恢复调用示例（两步：预览 → 确认）

把已发布版本 **v1** 的 **[2000, 6000) ms** 区间整体恢复到草稿。确认体必须原样回传预览时的
`version / start_ms / end_ms`，并携带预览令牌；令牌同样随服务进程重启失效。

第一步——预览（不写入；边界穿过任一侧片段会直接 `422`）：

```bash
curl -s -X POST http://localhost:8080/api/videos/12/restore/preview \
  -H 'Content-Type: application/json' \
  -d '{"version":1,"start_ms":2000,"end_ms":6000}'
```

成功返回（节选）：

```json
{
  "version": 1,
  "range": { "start_ms": 2000, "end_ms": 6000, "duration_ms": 10000 },
  "draft_in_range": [
    { "id": 7, "start_ms": 3000, "end_ms": 5000, "text": "草稿片段", "reviewed": false, "revision": 1 }
  ],
  "snapshot_in_range": [
    { "snapshot_index": 3, "start_ms": 2000, "end_ms": 4000, "text": "历史第三句" }
  ],
  "to_remove":   [ /* 同 draft_in_range：确认后移除的草稿片段 */ ],
  "to_restore":  [ /* 同 snapshot_in_range：确认后恢复的历史片段 */ ],
  "outside_kept_count": 3,
  "removed_count": 1,
  "restored_count": 1,
  "token": "eyJ2IjoxMiwibSI6InJlc3RvcmUi…….签名"
}
```

边界穿过片段时返回 `422 boundary_crosses_segment`，`crossings[]` 逐条给出
`side=draft|snapshot`、`segment_id`（草稿）或 `snapshot_index`（历史“第 n 段”）、
`start_ms/end_ms` 与中文说明。其他参数错误：`invalid_version / invalid_time /
invalid_range / range_out_of_bounds`；版本不存在为 `404 version_not_found`。

第二步——确认（版本与区间须与预览一致）：

```bash
curl -s -X POST http://localhost:8080/api/videos/12/restore/confirm \
  -H 'Content-Type: application/json' \
  -d '{"version":1,"start_ms":2000,"end_ms":6000,"token":"eyJ2IjoxMiwibSI6InJlc3RvcmUi…….签名"}'
```

返回 `201 { ok, version, range, removed_count, restored_count, segments }`。语义：

- 区间内草稿片段整体删除；区间内历史片段作为**新草稿片段**插入（新 id、`reviewed=false`、`revision=1`）；
- 区间外草稿片段原样保留（审校状态、修订号不变）；历史发布版本与所有 SRT 导出不变；
- 整批在一个事务内完成。失败约定：

| 状态 / code | 含义 |
| --- | --- |
| `422 boundary_crosses_segment` | 区间边界穿过草稿或历史片段（含 `crossings[]`），未写入 |
| `422 invalid_range` / `range_out_of_bounds` / `invalid_time` / `invalid_version` | 区间起点不早于终点、越界、非整数毫秒、版本号非法，未写入 |
| `422 invalid_timeline` | 替换后时间线不合法（理论上由边界规则拦截，事务内再次兜底校验），未写入 |
| `422 restore_mismatch` | 确认的版本或区间与预览不一致，未写入 |
| `404 version_not_found` | 指定的历史发布版本不存在，未写入 |
| `409 preview_required` | 缺失/伪造/过期（服务重启）令牌，需先预览 |
| `409 draft_changed` | 预览后草稿发生增删改或审校变化；响应附 `current_segments`，必须重新预览 |

## 数据布局

```
data/
├── app.db            # SQLite：videos / segments / publications
└── videos/           # 上传的原始视频文件（随机化文件名）
```

> 说明：本应用面向可信的本机/小团队内网环境，未内置账号鉴权；如需公网暴露，请自行置于
> 反向代理与访问控制之后，并建议把 `HOST` 绑定到内部地址。
