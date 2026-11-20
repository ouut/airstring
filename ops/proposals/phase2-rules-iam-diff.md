# Phase 1.5 持久化定案说明 ＋ Phase 2 Rules / 索引 / IAM 拟变更 Diff（请开发侧轻量过目）

- **起草方**：部署侧（Antigravity）
- **日期**：2026-11-20
- **关联审定**：`ops/discuss.md`（基线 `b5fdbd1`）
- **前置预览分支**：`feat/ui-phase1`（commit `05a03e5`，预览通道 `https://airstring-nethack--ui-phase1-a9hmffse.web.app`）

---

## 一、与用户补充收敛的产品与持久化决策（已在 `feat/ui-phase1` 前端落地，零后端/规则变更）

在 Phase 1 预览验收过程中，用户补充定案以下 5 条规则，现同步备案：

1. **彻底移除手工上传与下载入口**：前端移除 `.save` 导入/导出与 `.jsonl` 手工下载按钮，所有进度由平台按按键流自动托管；`header.restored` 恒为 `null`（整局 100% 自包含可验真）。
2. **游客 vs 登录分流**：未登录游客明确提示「游客试玩不保存进度、不入榜单」，不写本地 IndexedDB 也不上云；若游客试玩途中通过 Google 弹窗登录，前端无缝认领当前内存对局并落盘上云。
3. **无“单活跃局”死限制 & 任意状态可分叉**：
   - 未完对局与已完对局均基于同一套按键流记录；已完对局不限数量；未完对局仅要求走满 ≥ 1 步才落库，宽松软上限 50 局，超过 30 天未操作自动折叠至「已搁置」（不删除）。
   - 允许对进行中对局或已结束对局随时发起分叉（如实记录 `seedSource: 'fork'`、`parentGameId`、`forkTurn`），分叉局仍是从第 1 步起的完整自包含按键流，照旧走现有验真口径。
4. **本地即时落盘 ＋ 云端单文件同步 ＋ 多端防冲突**：
   - 已登录用户每回合（及键消费防抖）即时写按 `uid` 隔离的浏览器 `IndexedDB`（断网/刷新 0 丢失）；
   - 云端同步复用了现役 `storage.rules` 已放行的 `saves/{uid}/` 目录（`saves/{uid}/{gameId}.json` 单文件覆盖 ＋ `saves/{uid}/_index.json` 索引），每 30 秒 / 每 50 回合 / `visibilitychange` 同步，**不再产生 `chunk-*.json` 孤儿分片**；
   - 同设备多标签页通过 `BroadcastChannel` 互斥锁定；跨设备双端分歧时自动将本端原地派生为一条分叉新局，两边进度均保留；
   - 刷新/跨设备续打/分叉启动采用 **WASM 静音分片缓冲快进**（显示视频式进度条，并逐帧校验历史 hash）。
5. **冻结清单零触碰确认**：`.jsonl` `header/turn/tail/end` 格式、帧哈希验真判定、`games/verdicts` 既有字段语义、固定日期 `1700000000`、关 bones、禁用 wizard/explore 均**未做任何修改**。

---

## 二、Phase 2 拟部署的 Rules / 索引 / IAM 最终 Diff（按 `b5fdbd1` 护栏送审）

以下 4 处变更**尚未部署**，请开发侧（Muse）轻量过目确认无误后，部署侧再实施 Phase 2（`verifier/` 增量＋回放/缩略图墙/分叉树前端＋上述配置上线）。

### 2.1 `firestore.rules` 拟变更 Diff

将 Phase 2 由验真器权威回写的 6 个字段并入 `verdictFields()`，客户端创建与更新时一律禁止写入；`parentGameId` / `forkTurn` 在 `create` 时可选携带，在 `update` 时因不在 `hasOnly` 白名单内而保持不可变：

```diff
--- a/firestore.rules
+++ b/firestore.rules
@@ -32,9 +32,12 @@ service cloud.firestore {
     // include any of them fail the create/update checks below).
     function verdictFields() {
       return ['verdict', 'verdictReason', 'verifiedAt',
               'framesCompared', 'framesMatched', 'firstMismatch',
-              'recordingSha256'];
+              'recordingSha256',
+              'publicRecordingPath', 'thumb', 'maxDlvl',
+              'outcome', 'deathReason', 'tags'];
     }
```

### 2.2 `storage.rules` 拟变更 Diff

1. 新增公开只读目录 `public-recordings/{file}`（仅验真器经 Admin/Service Account 写入，客户端永不可写，访客可读用于公开回放与分叉）；
2. 修复 `saves/{uid}/{file}` 的 `delete` 规则：现役 `allow write` 同时校验了 `request.resource.size < 5 * 1024 * 1024`，但 Storage `DELETE` 请求的 `request.resource` 为 `null`，会导致客户端清理已结束活跃槽位时报 403；拆分为 `allow create, update` 与 `allow delete` 后可干净物理删除，不再留 16 字节墓碑对象。

```diff
--- a/storage.rules
+++ b/storage.rules
@@ -41,12 +41,20 @@ service firebase.storage {
                    && request.resource.size < 1024 * 1024;
     }
 
-    // Save-game blobs for cross-device resume.
+    // Active-game key-stream snapshots for cross-device resume.
     match /saves/{uid}/{file} {
       allow read: if ownUid(uid);
-      allow write: if ownUid(uid)
-                   && request.resource.size < 5 * 1024 * 1024;
+      allow create, update: if ownUid(uid)
+                            && request.resource.size < 5 * 1024 * 1024;
+      allow delete: if ownUid(uid);
     }
 
+    // Public read-only recordings of verified games (written ONLY by
+    // the Cloud Run verifier via its service account).
+    match /public-recordings/{file} {
+      allow read: if true;
+      allow write: if false;
+    }
+
     match /{allPaths=**} {
       allow read, write: if false;
     }
```

### 2.3 `firestore.indexes.json` 拟变更 Diff

为分叉树查询（`where('parentGameId', '==', id).where('status', '==', 'verified').orderBy('createdAt', 'desc')`）新增 1 条复合索引：

```diff
--- a/firestore.indexes.json
+++ b/firestore.indexes.json
@@ -1 +1,28 @@
-{"fieldOverrides":[],"indexes":[{"collectionGroup":"games","fields":[{"fieldPath":"status","order":"ASCENDING"},{"fieldPath":"createdAt","order":"DESCENDING"}],"queryScope":"COLLECTION"},{"collectionGroup":"games","fields":[{"fieldPath":"uid","order":"ASCENDING"},{"fieldPath":"createdAt","order":"DESCENDING"}],"queryScope":"COLLECTION"}]}
+{
+  "fieldOverrides": [],
+  "indexes": [
+    {
+      "collectionGroup": "games",
+      "queryScope": "COLLECTION",
+      "fields": [
+        { "fieldPath": "status", "order": "ASCENDING" },
+        { "fieldPath": "createdAt", "order": "DESCENDING" }
+      ]
+    },
+    {
+      "collectionGroup": "games",
+      "queryScope": "COLLECTION",
+      "fields": [
+        { "fieldPath": "uid", "order": "ASCENDING" },
+        { "fieldPath": "createdAt", "order": "DESCENDING" }
+      ]
+    },
+    {
+      "collectionGroup": "games",
+      "queryScope": "COLLECTION",
+      "fields": [
+        { "fieldPath": "parentGameId", "order": "ASCENDING" },
+        { "fieldPath": "status", "order": "ASCENDING" },
+        { "fieldPath": "createdAt", "order": "DESCENDING" }
+      ]
+    }
+  ]
+}
```

### 2.4 Cloud Run 验真器 IAM 最小权限增量

- **对象**：`gs://airstring-nethack.firebasestorage.app`（仅限定该 bucket，非项目级）
- **主体**：`serviceAccount:39704157599-compute@developer.gserviceaccount.com`
- **新增角色**：`roles/storage.objectCreator`（保留既有 `roles/storage.objectViewer`，不含 delete/overwrite 权限）
- **幂等写入约定**：`verifier/gcp.mjs` 写入 `public-recordings/{gameId}.jsonl` 时带 `ifGenerationMatch=0`，若对象已存在收到 HTTP `412 Precondition Failed` 则视为幂等成功跳过。

---

请开发侧在 `ops/discuss.md` 回复确认以上 4 处 Diff 无异议；确认后部署侧即推进 Phase 2 实施与部署。
