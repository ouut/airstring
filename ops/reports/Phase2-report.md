# Phase 2 正式部署报告（UI/持久化/缓冲续打/公开录像/ASCII 缩略图/回放器/分叉树）

- **基线提交**：`6539672`（`main`，已合并 `feat/ui-phase1` 与 `feat/phase2`，审定基线 `15d1a32`）
- **部署时间**：2026-11-20
- **总体状态**：**✅ 基础设施、验真器 v2、规则/索引/IAM 与前端全量上线 `https://airstring.org/`**（待玩家登录后打 1 局＋分叉 1 局，补录「公开录像首例」与「分叉首例」关门证据）

---

## 一、IAM、Rules 与索引上线核验 — ✅ PASS

1. **Cloud Run SA Storage 最小权限（bucket 级）**：
   - `gs://airstring-nethack.firebasestorage.app` 已绑定 `serviceAccount:39704157599-compute@developer.gserviceaccount.com` → **`roles/storage.objectCreator`**（保留既有 `roles/storage.objectViewer`，不含 delete/overwrite）。
2. **Firestore Rules & Storage Rules**：
   - `firestore.rules` 编译并发布成功（`verdictFields()` 已锁定 `publicRecordingPath/thumb/maxDlvl/outcome/deathReason/tags` 禁止客户端写）。
   - `storage.rules` 编译并发布成功（`public-recordings/{file}` 公开只读＋客户端禁写；`saves/{uid}/{file}` 拆分 `create, update` 与 `delete`）。
   - 匿名访问 `public-recordings/nonexistent-smoke.jsonl` 返回 **`HTTP 404`**（非 403），证明公开只读规则已生效。
3. **Firestore 复合索引**：
   - 新增分叉树索引 `(parentGameId ASC, status ASC, createdAt DESC)`（ID `CICAgJim14AK`），当前状态 **`READY`**（全部 3 条复合索引均为 `READY`）。

---

## 二、验真器 v2（Cloud Run `airstring-verifier`）— ✅ PASS

- **本地真实样本冒烟**（使用 M0 实录 `g-42-20261120043119-8d05.jsonl`）：
  - `verdict: "verified"`（6/6 帧全等），提取 `maxDlvl: 1`、`outcome: "quit"`、`deathReason: "quit"`、`thumbBytes: 863 B`（< 2 KB 上限）。
- **Cloud Build**：
  - Build ID：`3f28355d-71d3-46ca-b6f6-7b2f1eb3967f`（`SUCCESS`，耗时 `16s`）
  - 镜像：`us-central1-docker.pkg.dev/airstring-nethack/airstring/verifier:v2`（`sha256:a1f9bd4c65e594c64699a1cfbbb2fc6b39f2c2c3498fdf78c2f836bc710b3d82`）
- **Cloud Run 新版本**：
  - Revision：**`airstring-verifier-00004-mvt`**（100% 流量，`VERIFIER_STORE=firestore`, `VERIFIER_REQUIRE_AUTH=1`）
  - `GET /health` → `200 {"ok":true}`
  - `OPTIONS /verify`（`Origin: https://airstring.org`）→ `204` ＋ 完整 CORS 头
  - 无 Token `POST /verify` → `401 {"error":"unauthorized"}`

---

## 三、Firebase Hosting 正式站点（`https://airstring.org/`）— ✅ PASS

- 全量上线：Phase 1（现代 Curses 桌面端＋手机竖屏全屏＋PWA manifest）＋ Phase 1.5（移除手工上传/下载、游客分流＋中途登录认领、本地 IndexedDB 每回合落盘＋`saves/{uid}/` 单文件云端同步、`BroadcastChannel` 多标签页互锁、跨端冲突自动分叉、WASM 缓冲快进）＋ Phase 2（YouTube 式公开录像大厅＋ASCII 缩略图＋帧缓存 0ms 拖拽回放器＋一键分叉＋验真护照＋分叉家族树＋`#replay/<gameId>` 直链）。
- 线上核验：`https://airstring.org/` 及 `/airstring.css`、`/airstring.js`、`/firebase.js`、`/manifest.json`、`/nethack.wasm` 全部返回 **`HTTP 200`**。

---

## 四、待补录实机闭环样本（等待玩家实测后追记）

- **公开录像首例**：待玩家登录 `https://airstring.org/` 完成 1 局后记录 `gameId`、`publicRecordingPath`、`thumb` 字节数与匿名下载 `HTTP 200` 证据。
- **分叉首例**：待玩家在回放页或局内发起 1 次分叉并结束验真后，记录子局 `gameId`、`parentGameId`、`forkTurn` 与分叉家族树实查结果。
