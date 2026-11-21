# API-1 — airstring 导入/导出与管理查询接口规范

下发：开发侧（主线），2026-11-21。本规范经仓主 2026-11-21 批准接口清单后起草，**取代同日已下发的 MCP-1（提交 8ebfd10），MCP-1 作废**。

部署侧交付物只有一件事：在现有 Firebase 后端上加下面 10 个普通 HTTPS 接口（Cloud Functions 即可，**不新建 Cloud Run 服务**）。统计、筛选、拼包、验真等数据处理全部在外部（开发侧）完成，不进部署侧代码。

## 口径变更（先说清）

- **验真全部在外部做。** 导入接口只落库、**不触发站内验真**；导入对局的状态与 verdict 按导入包内字段记。
- 冻结清单原「verdict 只归站内验真器」一条，对**导入数据**按仓主 2026-11-21 裁定变更为「外部验真、随包带入」。站内玩家对局的既有验真流程不在本规范范围、不受影响。
- 其余冻结项仍不动：录制流格式、既有字段语义、种子/日期锁定、关 bones。

## 统一约定

- **鉴权**：单个管理令牌，请求头 `X-Admin-Token: <token>`。无令牌或令牌错一律 401。不分 scope、不走 OAuth。
- **响应信封**：成功 `{"ok": true, "data": {...}}`；失败 `{"ok": false, "error": {"code": "...", "message": "..."}}`。
- **时间**：一律 UTC、ISO 8601（如 `2026-11-21T10:00:00Z`）。
- **分页**：列表类统一 `page`（从 1 起）＋`pageSize`（默认 50、上限 200），响应带 `total` 与 `hasMore`。
- **错误码**（只这几个）：`UNAUTHORIZED`（401）、`BAD_REQUEST`（400，参数或包格式不合）、`NOT_FOUND`（404）、`CONFLICT`（409，批次号重复提交）、`TOO_LARGE`（413，超单包上限）、`INTERNAL`（500）。

## 数据包格式（导入/导出共用，沿 IMPORT-1 包）

- 形态：`tar.gz`，内含 `MANIFEST.json`＋`MANIFEST.md`＋`recordings/`。
- MANIFEST 顶层：`batch`（批次名）、`source`（来源标识）、`createdAt`、`count`。
- MANIFEST 逐条：`gameId`、`seed`、`role`、`depth`（终局 Dlvl）、`outcome`、`frames`、`keysBytes`、来源谱系 id（如有）、录制文件在 `recordings/` 下的相对路径。
- **类别字段** `kind`：`complete`＝A 类完整录制；`stub`＝B 类未完残局。B 类另带 `status="incomplete-unverified"`，且逐条另带 `keysComplete`（布尔：keys 是否为从开局起的完整前缀流；外部日后做续打/转正处理时以此字段为准）。
- **外部验真字段**（A 类可选带）：`verdict`（`verified`/`rejected`）、`verdictBy`（验真方标识）、`verifiedAt`。不带 verdict 的导入局就是普通落库局，不进榜单展示（见验收）。
- **幂等键**：`gameId`。重复导入同一 gameId 不产生双份（Storage 写防覆、文档建前查存，口径同 IMPORT-1）。

## 接口清单

### 导出类

**① 导出录制包** — `GET /api/export/package`
- 用途：把站内对局录制整包导出给外部处理。
- 参数：`since`（可选，水位：只导此后新增/变更的对局）、`status`（可选，粗过滤）。
- 响应：`{downloadUrl（限时）, sha256, count, newWatermark, expiresAt}`。
- 备注：水位语义＝两次增量拼接与全量等价、不重不漏（验收口径）；`newWatermark` 由外部保存、下次回传。

**② 导出对局清单** — `GET /api/export/games`
- 用途：只出元数据清单，外部先看清单再决定拉哪些录制。
- 参数：分页＋可选 `since`、`status`。
- 响应条目：`{gameId, player, seed, role, depth, outcome, status, createdAt}`。

### 导入类

**③ 导入录制包** — `POST /api/import/package`
- 用途：外部拼好的录制包整包收下、幂等落库。
- 请求：JSON `{packageUrl, sha256}`（包放临时下载地址，站方拉取；sha 不符整批拒收回 `BAD_REQUEST`）。
- 响应：`{batchId, received}`（`received`＝包内条数）。处理可异步，结果走 ④ 回查。
- 备注：只落库、不触发验真；状态与 verdict 按包内字段记（见数据包格式）；B 类只落库＋打 `stub` 标记，站内呈现不在本规范范围；归属账号沿 IMPORT-1 的官方机器人账号口径。

**④ 导入批次回查** — `GET /api/import/batches/{batchId}`
- 用途：查一批导入的逐条结果。
- 响应：`{batchId, status（processing/done/failed）, total, results: [{gameId, result, reason?}]}`，`result` ∈ `imported`/`duplicate`/`rejected`，拒收必带原因。

### 管理查询类

**⑤ 对局列表查询** — `GET /api/admin/games`
- 用途：管理视角查对局，含站内大厅看不到的未验真与被拒局。
- 参数：`status`、`player`、`seed`、`from`、`to` 过滤＋分页。
- 响应条目：同 ②，另加 `verdict`、来源 `source`/`batch`（如有）。

**⑥ 单局详情** — `GET /api/admin/games/{gameId}`
- 用途：一条对局的全部信息。
- 响应：全量元数据（同 ⑤ 条目＋`frames`、`keysBytes`、验真字段全套）＋`recordingUrl`（限时下载引用）。不存在回 `NOT_FOUND`。

**⑦ 统计概览** — `GET /api/admin/stats`
- 用途：站内现成数据的只读汇总读出（**不做任何新的统计逻辑，只是把已有计数聚合返回**）。
- 响应：`{total, byStatus, byDepth, byRole, addedLast7d, addedLast30d}`。

**⑧ 榜单快照** — `GET /api/admin/leaderboard`
- 用途：当前排行榜原样一份。
- 响应：`{generatedAt, entries: [{rank, gameId, player, seed, role, depth, outcome, score?}]}`，口径与站内展示一致。

**⑨ 玩家查询** — `GET /api/admin/players/{player}`
- 用途：按玩家（uid 或显示名）看其全部对局与最佳成绩。
- 响应：`{player, gameCount, best: {gameId, depth, outcome}, games: [同 ⑤ 条目]}`（games 分页）。

**⑩ 对局下架/恢复** — `POST /api/admin/games/{gameId}/visibility`
- 用途：管理类唯一写操作：软标记一条对局是否在站内展示。
- 请求：`{visible: false}` 下架 / `{visible: true}` 恢复。
- 响应：`{gameId, visible}`。只改展示标记，不删数据、不动 verdict。

## 验收标准

1. **幂等重入**：同一包经 ③ 导入两次，第二批逐条全 `duplicate`、站内零新增。
2. **增量水位**：① 两次增量导出拼接与一次全量导出条目集合相等，不重不漏。
3. **榜单纪律**：不带 verdict 字段的导入局不出现在 ⑧ 与站内榜单展示中；带 `verdict="verified"` 的按包内字段展示。
4. **下架即时生效**：⑩ 下架后，该局立即从站内列表/榜单消失，⑥ 仍可查到且标记 `visible=false`。
5. **端到端一例**：外部经 ① 导出一条对局 → 外部处理 → 改包经 ③ 导入 → ④ 查到 `imported` → ⑥ 可见落库结果。

## 待部署侧回话（只两点）

1. 管理令牌的保管方式（部署侧密钥管理即可，确认存放位置与轮换做法）。
2. 单包大小上限的建议值（条数与体积；超限回 `TOO_LARGE`，数值部署侧按 Functions 实测给）。

其余疑问在 `ops/discuss.md` 本规范下发段回帖。
