# API-1 交付与验收报告（2026-11-21）

- **对应任务**：`ops/tasks/API-1-airstring-interfaces.md`（提交 `f9ca789`，已取代作废的 `MCP-1`）
- **生产入口**：`https://airstring.org/api/...`（经 Firebase Hosting `/api/**` 转发至 Cloud Functions v2 `api`）
- **部署资源**：
  - HTTP 函数：`projects/airstring-nethack/locations/us-central1/functions/api`（Node.js 22，`1 GiB`，超时 `300s`，URI `https://api-bzy4dyvupq-uc.a.run.app`）
  - 后台异步导入触发器：`projects/airstring-nethack/locations/northamerica-northeast2/functions/processImportBatch`（Firestore `onDocumentCreated('import_batches/{batchId}')`，与数据库同区，Node.js 22，`1 GiB`，超时 `540s`）
  - 凭据托管：GCP Secret Manager `AIRSTRING_ADMIN_TOKENS`（JSON 数组格式支持新旧双令牌零停机轮换；`X-Admin-Token` 恒定时间比对）
  - 临时目录自动清理：Bucket `airstring-nethack.firebasestorage.app` 已配置 1 天 Lifecycle 规则，仅针对 `exports/` 与 `import-inbox/` 前缀

---

## 一、10 个接口上线清单

| # | 方法与路径 | 说明 |
|---|---|---|
| ① | `GET /api/export/package` | 支持 `since`（水位或 ISO 8601）与 `status`，打包 `MANIFEST.json` + `MANIFEST.md` + `recordings/`，返回 6 小时 V4 签名 `downloadUrl` + `sha256` + `count` + `newWatermark` + `expiresAt` |
| ② | `GET /api/export/games` | 分页（`page`/`pageSize`≤200）＋ `since`/`status` 元数据清单 |
| ③ | `POST /api/import/package` | 接收 `{packageUrl, sha256}`（HTTPS + SSRF 防护 + 整包 SHA-256 核验 + 安全解压防路径穿越/zip bomb），入队并触发 `processImportBatch` 异步幂等落库（不触发站内验真，外部 verdict 随包落库；支持 A 类 `complete` 与 B 类 `stub`） |
| ④ | `GET /api/import/batches/{batchId}` | 回查批次状态（`processing`/`done`/`failed`）与逐条 `imported`/`duplicate`/`rejected` 清单 |
| ⑤ | `GET /api/admin/games` | 管理视角查询（含未验真、被拒、B 类残局），支持 `status`/`player`/`seed`/`from`/`to` 与分页 |
| ⑥ | `GET /api/admin/games/{gameId}` | 全量元数据 + 1 小时 V4 签名 `recordingUrl`（不存在回 `404 NOT_FOUND`） |
| ⑦ | `GET /api/admin/stats` | 只读汇总：`total`、`byStatus`、`byDepth`、`byRole`、`addedLast7d`、`addedLast30d` |
| ⑧ | `GET /api/admin/leaderboard` | 现行榜单快照（仅 `status=="verified" && visible!==false && !hiddenByOwner`，按 `depth DESC, turns DESC` 排序） |
| ⑨ | `GET /api/admin/players/{player}` | 按 uid 或显示名查玩家对局总数、最佳成绩与分页列表 |
| ⑩ | `POST /api/admin/games/{gameId}/visibility` | 软标记 `{visible: true/false}`，不删数据、不动 verdict，与站内大厅及 ⑧ 榜单实时联动 |

---

## 二、待回话两项定案

1. **管理令牌保管与轮换**：
   - 存放于 GCP Secret Manager `AIRSTRING_ADMIN_TOKENS`（JSON 数组 `["<current>", "<previous>"]`），通过 Functions v2 `defineSecret` 注入，不入仓、不落日志。
   - 轮换步骤：向 Secret 新增包含 `[新令牌, 旧令牌]` 的版本 → 通知外部切换 → 再发仅含 `[新令牌]` 的版本并禁用旧版本，全程无停机，且保持在 Secret Manager 免费额度（6 活跃版本）内。
   - 获取方式：`firebase functions:secrets:access AIRSTRING_ADMIN_TOKENS --project airstring-nethack`（或 `gcloud secrets versions access latest --secret=AIRSTRING_ADMIN_TOKENS --project=airstring-nethack`）。
2. **单包上限数值**：
   - 压缩包体积 **≤ 256 MiB**（解压总字节安全护栏 **≤ 1 GiB**）；
   - 条数上限：**A 类 ≤ 200 条**、**B 类 `stub` ≤ 500 条**（可直接一包导入现有 299 条残局）；超限统一回 `413 TOO_LARGE`。

---

## 三、全部 5 条验收标准实测记录（线上生产 `https://airstring.org/api/...`）

| 验收项 | 实测步骤与结果 | 结论 |
|---|---|---|
| **鉴权与错误码** | 无头/错令牌访问 `GET /api/admin/stats` → `401 UNAUTHORIZED`；查不存在局 → `404 NOT_FOUND`；③ 申报错误 SHA-256 → `400 BAD_REQUEST` | **PASS** |
| **验收 1（幂等重入）** | ① 导出全量 52 局（14.8 MB）后将其 `downloadUrl` 原样经 ③ 重导 → **52 / 52 `duplicate`**；合成测试包（A 类已验真 + A 类未验真 + B 类 stub）连续经 ③ 提交两次 → 首批 3/3 `imported`，第二批 **3 / 3 `duplicate`**、库内零新增 | **PASS** |
| **验收 2（增量水位）** | 导入前全量导出 `count=52` 得水位 `wm1`；导入 1 条新 verified 局后以 `since=wm1` 增量导出 → `count=1`（恰为新导入局），两包交集为 `0`、并集 `53 === 全量导出 53`；再用新水位续拉 → `count=0` | **PASS** |
| **验收 3（榜单纪律）** | 查 ⑧ `GET /api/admin/leaderboard`：带 `verdict="verified"` 的测试局正常入榜（`rank: 1`）；不带 `verdict` 的测试局与 B 类 `stub` 均未出现在榜单中 | **PASS** |
| **验收 4（下架即时生效）** | ⑩ `POST /api/admin/games/{id}/visibility {"visible":false}` → ⑧ 榜单立即移除（`false`），⑥ 详情仍可查且 `visible: false, verdict: "verified"` 不变；恢复 `{"visible":true}` → 立即重现榜单；前端大厅已同步过滤 `visible !== false` | **PASS** |
| **验收 5（端到端闭环）** | ① 导出实局 `.jsonl` → 外部改包（含 A 类已验真/未验真与 B 类残局）→ ③ 导入 → ④ 查到全部 `imported` → ⑥ 查到完整元数据与 `recordingUrl` | **PASS** |

- **测试后清理验证**：全部合成测试文档与 Storage 测试文件已彻底清理，清理后 `GET /api/admin/stats` 回归干净基线：`total: 53`（`verified: 52`, `pending: 1`）。
- **冻结清单与安全规则检查**：`firestore.rules` 与 `storage.rules` 零改动，站内玩家自动验真链路（`airstring-verifier`）未受任何影响。
