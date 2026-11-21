# IMPORT-1 执行报告 — beam-seed-001 初始数据导入（50/50 verified）

- **执行日期**：2026-11-21
- **任务书**：`ops/tasks/IMPORT-1-beam-seed-data.md`
- **数据包**：`beam-seed-001.tar.gz`（15,719,713 字节，SHA-256 `709b50c6cab25c2316fea3df15f9c7faca5da087c0aff9154716000e08d05e5f` 校验完全一致；解压后 `recordings/` 共 50 文件、75,290,091 字节）
- **脚本执行时间（全量 50 条）**：`2026-11-21T10:02:17.229Z` ～ `2026-11-21T10:10:10.986Z`（总墙钟耗时 **473.8s**，4 路并发，单条均值 36.2s）
- **最终结果**：**50 / 50 `verified`**（`rejected=0`，`errors=0`），累计线上逐帧复现校验 **324,854 帧**；50/50 均产出 `public-recordings/{gameId}.jsonl`，50/50 均产出 ASCII 缩略图（863 B）。

---

## 一、导入口径合规说明

严格遵循 `IMPORT-1` 裁定（**未开发常驻导入 API、未签发长期静态 token、未放宽任何 Firestore/Storage 客户端规则**）：

1. **官方机器人账号**：通过 Firebase Identity Toolkit Admin API 创建官方机器人账号：
   - `uid`：`ia3yu8PARXcT7d0WSfrpWE2WxxC2`
   - `displayName`：`Beam Search`
   - `email`：`beam-search@airstring.org`（`emailVerified: true`，无静态口令暴露）
2. **落库与幂等**：
   - Storage：全部 50 条录制上传至 `recordings/ia3yu8PARXcT7d0WSfrpWE2WxxC2/<gameId>.jsonl`，写入强制带 `ifGenerationMatch=0`（已验证重跑遇 HTTP 412 幂等跳过，前 2 条重跑日志为 `st=exists fs=exists`）。
   - Firestore：建文档前先查存，按客户端同款字段写入 `games/{gameId}`（`status="pending"`、`date=1700000000`、`restored=null`、不含任何 verdict 字段），另附 `displayName="Beam Search"`、`source="beam-import"`、`batch="beam-seed-001"`、`lineageId`（MANIFEST 的 `lineage`）、`provenance`。
3. **线上验真器鉴权与零静态密钥**：
   - 未放宽 `VERIFIER_REQUIRE_AUTH=1`，也未创建/下载任何服务账号 JSON 私钥。
   - 临时对 `firebase-adminsdk-fbsvc@airstring-nethack.iam.gserviceaccount.com` 授予 `roles/iam.serviceAccountTokenCreator`，由脚本调用 IAM Credentials `signJwt` 签发短期 Custom Token → 换取真实 Firebase ID Token（`sub === ia3yu8PARXcT7d0WSfrpWE2WxxC2`）→ 逐条 `POST /verify` 触发生产 Cloud Run 验真器。
   - **导入完成后已立即收回该临时 `roles/iam.serviceAccountTokenCreator` 绑定**，`get-iam-policy` 核验已清空。

---

## 二、执行中发现并修复的深层局 OOM 问题（附带加固）

首次试跑 7,264 帧 L20 深层局（`g-55-20261120202308-abd8`）时，线上 `airstring-verifier` 触发 Cloud Run OOM（HTTP 503）：

1. **根因定位（两层叠加）**：
   - **层 1（可优化）**：`tools/run-node-s3.mjs` 默认将全量 `--events`（每步 80×24 地图 JSON）与 `rngChunks` 缓存在内存数组并写至 Cloud Run 内存盘 `/tmp`（tmpfs），导致 512 MiB / 1 GiB 容器超限。
   - **层 2（WASM 原生堆）**：即使屏蔽 `events` / `exportPath=/dev/null` / `rngPath=/dev/null`，本地实测 7,264 帧局的 `nethack.wasm` 进程本身原生 RSS 仍达 **~1,581 MiB**（JS 堆仅 14 MiB，余下为 WASM 线性内存/C 堆）。
2. **线上加固措施（零改动 WASM 与验真判据）**：
   - 在 `tools/run-node-s3.mjs` 新增可选 `--events-summary <file>` O(1) 流式摘要模式（不改变默认 `--events` 行为，已验证 S3/S4 兼容性 `identical-to-memfs: true`），并在 `verifier/verify.mjs` 启用（commits `221adb1`、`519ab8f`）；
   - 构建发布镜像 `us-central1-docker.pkg.dev/airstring-nethack/airstring/verifier:v2-stream`（Cloud Build `89b6d86d-6c71-4227-aec0-7bb98c58fde6`，`sha256:7ac2467391d808ddcab720c61c5dc2dc859058f8db64c9ae2535d1283398d451`）；
   - Cloud Run 服务 `airstring-verifier` 升级至 revision **`airstring-verifier-00008-t89`**（`4Gi` 内存 / `2 vCPU` / `concurrency=1` / `timeout=300s`）。50 条深局总计消耗约 3,000 GiB-秒（< 月免费额度 360,000 GiB-秒的 1%，维持 $0 成本），且后续真实玩家深层飞升局也可稳定验真。
3. **前端配套更新（`https://airstring.org/` `?v=p2fix5`）**：
   - 大厅公开录像拉取上限由 `24` 提升至 `100`（现已完整展示全部 52 条已验真局：M0 原有 2 条 + 本批 50 条）；
   - 卡片标题、搜索与回放护照支持展示 `displayName`（`Beam Search`）以及导入 `batch` / `lineageId` 溯源信息。

---

## 三、公开录像首例、大厅与分叉入口可用性确认

- **匿名公开查询（同前端大厅请求）**：`POST firestore .../documents:runQuery`（`status == "verified"`, `limit: 100`）返回 **HTTP 200**，共 **52 条**公开已验真记录（含本批 **50/50**，全部具备 `publicRecordingPath` 与 `863 B` ASCII 缩略图）。
- **公开录像下载 CORS 核验**：`OPTIONS https://firebasestorage.googleapis.com/v0/b/airstring-nethack.firebasestorage.app/o/public-recordings%2Fg-55-20261120202308-abd8.jsonl?alt=media` 返回 **HTTP 200**，带 `access-control-allow-origin: *`。
- **公开录像首例与分叉入口（均已线上可访问）**：
  - 招牌最深局（L20，7,264 帧）：`https://airstring.org/#replay/g-55-20261120202308-abd8` → `public-recordings/g-55-20261120202308-abd8.jsonl`（支持任意回合「⚡ 从当前回合分叉由我来打」与「同种子开局」）；
  - 续打版（L19 `#quit`，7,170 帧）：`https://airstring.org/#replay/g-55-20261120213533-885a` → `public-recordings/g-55-20261120213533-885a.jsonl`。

---

## 四、异常与边界观测（供开发侧知悉，零改数据）

- **全批 50/50 帧哈希链严格 `verified`，无任何 `rejected` 或验真报错**。
- **结局分类小观测**：验真器基于事件流文本启发式将本批 50 条判为 **48 条 `died` + 2 条 `quit`**：
  - 其中第 50 条 `g-55-20261120213533-885a` 本身即为 `#quit` 续打版（与 MANIFEST 一致）；
  - 第 3 条 `g-55-20261120202431-8d8e`（MANIFEST `provenance=beam-dead`）因死局按键流截断于死亡瞬时、未含死亡后阅卷提示且末帧消息未触发 `rip`/死亡关键词匹配，验真器默认归为 `outcome="quit"`（7,485/7,485 帧哈希链全对，`maxDlvl=19`）。按任务书口径未手工修改任何 verdict 字段，特此记录备查。
- **层数说明**：验真器 `maxDlvl` 取全程抵达过的最大地牢层数，因此部分先下到更深层后上楼阵亡的局（如 `fb32` 终局 L17 但曾达 Dlvl 18、`e5fd` 终局 L12 但曾达 Dlvl 14）`maxDlvl >= manifestEndLevel`，属正常现象。

---

## 五、逐条 Verdict 清单（50 / 50）

| # | gameId | 来源谱系（简写） | 终局层 / 验真 maxDlvl | 帧校验 | 体积 | 结局 (来源) | Verdict | 公开录像 / 缩略图 | 耗时 |
|---:|---|---|---|---:|---:|---|---|---|---|
| 1 | `g-55-20261120202308-abd8` | `s0-root-00-…00-02-02-01-00` | L20 / Dlvl 20 | 7264/7264 | 1591 KB | died (beam-dead) | **verified** | `pub` (863 B) | 39.45s |
| 2 | `g-55-20261120202226-be83` | `s0-root-00-…00-02-00-01-01` | L19 / Dlvl 19 | 7495/7495 | 1657 KB | died (beam-dead) | **verified** | `pub` (863 B) | 38.1s |
| 3 | `g-55-20261120202431-8d8e` | `s0-root-00-…01-00-01-02-02` | L19 / Dlvl 19 | 7485/7485 | 1655 KB | quit (beam-dead) | **verified** | `pub` (863 B) | 39.06s |
| 4 | `g-55-20261120202604-0b95` | `s0-root-00-…00-01-00-00-00` | L19 / Dlvl 19 | 7463/7463 | 1653 KB | died (beam-dead) | **verified** | `pub` (863 B) | 39.71s |
| 5 | `g-55-20261120202737-f9c7` | `s0-root-00-…00-01-00-01-00` | L19 / Dlvl 19 | 7447/7447 | 1651 KB | died (beam-dead) | **verified** | `pub` (863 B) | 37.26s |
| 6 | `g-55-20261120202907-6df5` | `s0-root-00-…00-02-02-00-02` | L19 / Dlvl 19 | 7221/7221 | 1617 KB | died (beam-dead) | **verified** | `pub` (863 B) | 36.66s |
| 7 | `g-55-20261120203034-5738` | `s0-root-00-…00-02-02-00-01` | L19 / Dlvl 19 | 7169/7169 | 1610 KB | died (beam-dead) | **verified** | `pub` (863 B) | 36.99s |
| 8 | `g-55-20261120202138-93bb` | `s0-root-00-…02-01-01-00-03` | L18 / Dlvl 18 | 7670/7670 | 2060 KB | died (beam-dead) | **verified** | `pub` (863 B) | 37.05s |
| 9 | `g-55-20261120202348-4b22` | `s0-root-00-…01-02-01-02-00` | L18 / Dlvl 18 | 7577/7577 | 1968 KB | died (beam-dead) | **verified** | `pub` (863 B) | 39.09s |
| 10 | `g-55-20261120203200-d702` | `s0-root-00-…02-01-01-00-02` | L18 / Dlvl 18 | 7576/7576 | 2043 KB | died (beam-dead) | **verified** | `pub` (863 B) | 38.18s |
| 11 | `g-55-20261120202516-4a57` | `s0-root-00-…01-01-01-02-03` | L18 / Dlvl 18 | 7527/7527 | 2024 KB | died (beam-dead) | **verified** | `pub` (863 B) | 38.32s |
| 12 | `g-55-20261120202649-77b0` | `s0-root-00-…00-02-02-01-01` | L18 / Dlvl 18 | 7525/7525 | 2032 KB | died (beam-dead) | **verified** | `pub` (863 B) | 37.63s |
| 13 | `g-55-20261120203248-c72e` | `s0-root-00-…00-02-02-01-01` | L18 / Dlvl 18 | 7092/7092 | 1553 KB | died (beam-dead) | **verified** | `pub` (863 B) | 35s |
| 14 | `g-55-20261120202820-873d` | `s0-root-00-…03-03-02-03-01` | L18 / Dlvl 18 | 6980/6980 | 1913 KB | died (beam-dead) | **verified** | `pub` (864 B) | 35.17s |
| 15 | `g-55-20261120202949-1865` | `s0-root-00-…00-00-01-01-00` | L18 / Dlvl 18 | 6889/6889 | 1658 KB | died (beam-dead) | **verified** | `pub` (865 B) | 34.36s |
| 16 | `g-55-20261120203330-222f` | `s0-root-00-…00-00-01-01-01` | L18 / Dlvl 18 | 6883/6883 | 1657 KB | died (beam-dead) | **verified** | `pub` (865 B) | 36.91s |
| 17 | `g-55-20261120203412-e2d5` | `s0-root-00-…03-03-02-03-03` | L18 / Dlvl 18 | 6508/6508 | 1849 KB | died (beam-dead) | **verified** | `pub` (864 B) | 38.64s |
| 18 | `g-55-20261120203117-ad14` | `s0-root-00-…01-03-00-02-00` | L18 / Dlvl 18 | 6304/6304 | 1652 KB | died (beam-dead) | **verified** | `pub` (865 B) | 38.18s |
| 19 | `g-55-20261120203653-fb32` | `s0-root-00-…01-02-02-00-00` | L17 / Dlvl 18 | 7907/7907 | 1988 KB | died (beam-dead) | **verified** | `pub` (863 B) | 38.44s |
| 20 | `g-55-20261120203928-91ae` | `s0-root-00-…02-00-02-01-01` | L17 / Dlvl 17 | 7477/7477 | 1490 KB | died (beam-dead) | **verified** | `pub` (863 B) | 37.62s |
| 21 | `g-55-20261120204206-d4d7` | `s0-root-00-…03-03-00-02-00` | L17 / Dlvl 17 | 7458/7458 | 1963 KB | died (beam-dead) | **verified** | `pub` (863 B) | 37.67s |
| 22 | `g-55-20261120203613-6271` | `s0-root-00-…02-00-00-01-00` | L15 / Dlvl 15 | 6714/6714 | 1527 KB | died (beam-dead) | **verified** | `pub` (863 B) | 37.12s |
| 23 | `g-55-20261120203850-9f9d` | `s0-root-00-…00-02-02-00-01` | L15 / Dlvl 15 | 6499/6499 | 1316 KB | died (beam-dead) | **verified** | `pub` (863 B) | 38.59s |
| 24 | `g-55-20261120204129-5813` | `s0-root-00-…00-00-02-02-01` | L15 / Dlvl 15 | 6271/6271 | 1255 KB | died (beam-dead) | **verified** | `pub` (863 B) | 36.24s |
| 25 | `g-55-20261120204406-7158` | `s0-root-00-…00-01-00-00-00` | L15 / Dlvl 15 | 6136/6136 | 1749 KB | died (beam-dead) | **verified** | `pub` (863 B) | 31.47s |
| 26 | `g-55-20261120203532-d7e9` | `s0-root-00-…01-03-03-00-01` | L14 / Dlvl 14 | 6459/6459 | 1753 KB | died (beam-dead) | **verified** | `pub` (863 B) | 36.44s |
| 27 | `g-55-20261120203813-d5ef` | `s0-root-00-…02-02-00-00-00` | L14 / Dlvl 14 | 6429/6429 | 1374 KB | died (beam-dead) | **verified** | `pub` (863 B) | 36.86s |
| 28 | `g-55-20261120204049-41c6` | `s0-root-00-…00-00-00-02-00` | L14 / Dlvl 14 | 6198/6198 | 1227 KB | died (beam-dead) | **verified** | `pub` (863 B) | 36.61s |
| 29 | `g-55-20261120204325-9890` | `s0-root-00-…00-01-00-03-03` | L14 / Dlvl 14 | 5951/5951 | 1689 KB | died (beam-dead) | **verified** | `pub` (864 B) | 36.87s |
| 30 | `g-55-20261120203455-4ce0` | `s0-root-00-…02-00-00-01-02` | L13 / Dlvl 13 | 6355/6355 | 1135 KB | died (beam-dead) | **verified** | `pub` (865 B) | 36.65s |
| 31 | `g-55-20261120203737-8ebc` | `s0-root-00-…00-01-01-01-00` | L13 / Dlvl 13 | 6207/6207 | 1048 KB | died (beam-dead) | **verified** | `pub` (863 B) | 36.73s |
| 32 | `g-55-20261120204013-f275` | `s0-root-00-…02-02-00-00-02` | L13 / Dlvl 13 | 6109/6109 | 1035 KB | died (beam-dead) | **verified** | `pub` (863 B) | 35.88s |
| 33 | `g-55-20261120204252-d4d2` | `s0-root-00-…00-01-00-01-02` | L13 / Dlvl 13 | 5299/5299 | 995 KB | died (beam-dead) | **verified** | `pub` (863 B) | 35.31s |
| 34 | `g-55-20261120204530-e5fd` | `s0-root-00-…02-01-02-03-00` | L12 / Dlvl 14 | 6847/6847 | 1177 KB | died (beam-dead) | **verified** | `pub` (863 B) | 36.7s |
| 35 | `g-55-20261120204650-a975` | `s0-root-00-…00-02-02-03-00` | L12 / Dlvl 12 | 6404/6404 | 1134 KB | died (beam-dead) | **verified** | `pub` (863 B) | 36.27s |
| 36 | `g-55-20261120204806-8f44` | `s0-root-00-…02-02-03-03-00` | L12 / Dlvl 12 | 6372/6372 | 1709 KB | died (beam-dead) | **verified** | `pub` (863 B) | 30.49s |
| 37 | `g-55-20261120204923-47b0` | `s0-root-00-…00-00-00-00-02` | L12 / Dlvl 12 | 6199/6199 | 1038 KB | died (beam-dead) | **verified** | `pub` (863 B) | 36.82s |
| 38 | `g-55-20261120205036-cec8` | `s0-root-00-…02-00-00-00-01` | L12 / Dlvl 12 | 6051/6051 | 1161 KB | died (beam-dead) | **verified** | `pub` (863 B) | 34.8s |
| 39 | `g-55-20261120205145-81f4` | `s0-root-00-…02-00-02-02-01` | L12 / Dlvl 12 | 5945/5945 | 1061 KB | died (beam-dead) | **verified** | `pub` (863 B) | 35.96s |
| 40 | `g-55-20261120204448-d302` | `s0-root-00-…02-03-00-02-02` | L11 / Dlvl 12 | 6153/6153 | 1543 KB | died (beam-dead) | **verified** | `pub` (863 B) | 30.68s |
| 41 | `g-55-20261120204608-1427` | `s0-root-00-…00-03-02-03-03` | L11 / Dlvl 12 | 5808/5808 | 1715 KB | died (beam-dead) | **verified** | `pub` (863 B) | 37.84s |
| 42 | `g-55-20261120204727-cef6` | `s0-root-00-…03-00-02-00-00` | L11 / Dlvl 12 | 5800/5800 | 1579 KB | died (beam-dead) | **verified** | `pub` (863 B) | 39.02s |
| 43 | `g-55-20261120204845-2d3f` | `s0-root-00-…00-03-01-03-03` | L11 / Dlvl 12 | 5799/5799 | 1682 KB | died (beam-dead) | **verified** | `pub` (863 B) | 35s |
| 44 | `g-55-20261120204958-ede5` | `s0-root-00-…00-03-00-03-00` | L11 / Dlvl 12 | 5707/5707 | 1718 KB | died (beam-dead) | **verified** | `pub` (863 B) | 29.89s |
| 45 | `g-55-20261120205111-e0ec` | `s0-root-00-…02-00-00-01-01` | L11 / Dlvl 13 | 5681/5681 | 876 KB | died (beam-dead) | **verified** | `pub` (863 B) | 37.45s |
| 46 | `g-55-20261120205850-c840` | `s0-root-00-01-02` | L9 / Dlvl 9 | 3569/3569 | 439 KB | died (beam-dead) | **verified** | `pub` (863 B) | 37.07s |
| 47 | `g-55-20261120205255-7217` | `s0-root-00-02-02-00` | L8 / Dlvl 8 | 3963/3963 | 489 KB | died (beam-dead) | **verified** | `pub` (863 B) | 30.2s |
| 48 | `g-55-20261120202104-e24d` | `s0-root-00-02-01` | L7 / Dlvl 7 | 3087/3087 | 379 KB | died (beam-dead) | **verified** | `pub` (863 B) | 33.31s |
| 49 | `g-55-20261120205221-c6ba` | `s0-root-00-02-00` | L5 / Dlvl 7 | 6755/6755 | 828 KB | died (beam-dead) | **verified** | `pub` (863 B) | 30.49s |
| 50 | `g-55-20261120213533-885a` | `s0-root-00-…02-00-02-02-00` | L19 / Dlvl 19 | 7170/7170 | 1610 KB | quit (continued) | **verified** | `pub` (863 B) | 35.68s |
