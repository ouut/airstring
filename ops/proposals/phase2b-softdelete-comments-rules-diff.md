# Phase 2b `firestore.rules` 最小增量 Diff 送审（已结束对局软删除 ＋ 回放留言）

- **起草方**：部署侧（Antigravity）
- **日期**：2026-11-20
- **当前线上规则基线**：`6539672`（Phase 2 已部署）
- **冻结清单确认**：**不改动** `.jsonl` 录制格式、帧哈希验真判定、`games/verdicts` 既有字段语义、`allow delete: if false` 物理不删除红线、`storage.rules`、`firestore.indexes.json` 及任何 IAM 权限。

---

## 变更说明（仅涉及 `firestore.rules` 单文件）

1. **房主软删除已结束对局（仅隐藏、不物理删除）**：
   - 用户希望清理自己列表中不需要展示的历史对局，同时严守规格 §6.3「已验真录像为归档资产、客户端禁止物理删除」红线。
   - 方案：在 `games/{gameId}` 新增一条最小 `allow update` 分支，**仅允许本人（`isOwner`）写入 `hiddenByOwner: true`（及时间戳 `hiddenAt`）**，通过 `affectedKeys().hasOnly(['hiddenByOwner', 'hiddenAt'])` 严格禁止触碰 `status / verdict / seed / turns / thumb` 等任何归档与验真字段。前端在大厅与「对局」页自动过滤 `hiddenByOwner === true` 的条目，底层录制流与分叉血缘完全保留。
2. **回放页带回合锚点的用户留言（子集合 `games/{gameId}/comments/{commentId}`）**：
   - 单字段按 `createdAt` 排序，**无需新增任何 Firestore 复合索引**。
   - 读：父局为 `verified` 时所有人可读（或父局本人可读）。
   - 写：仅限 Google 登录用户（`signedIn()`）、父局已 `verified`、`uid == request.auth.uid`、字段严格白名单 `hasOnly(['uid', 'authorName', 'text', 'turn', 'createdAt'])`、`text` 长度 `1..500`、`authorName` 长度 `1..60`、`turn` 为 `null` 或非负整数。
   - 改：`allow update: if false;`（防篡改）。
   - 删：仅留言作者本人或父局房主可删除（留言非核心归档资产）。

---

## `firestore.rules` 拟变更终版 Diff（尚未部署，待确认）

```diff
--- a/firestore.rules
+++ b/firestore.rules
@@ -68,12 +68,48 @@ service cloud.firestore {
                          .affectedKeys()
                          .hasOnly(['end', 'turns', 'frames',
                                    'keysTotal', 'updatedAt']);
 
+      // Owner soft-delete: hide own game from UI listings while
+      // preserving archival records & fork lineage intact.
+      allow update: if isOwner(resource.data)
+                    && request.resource.data.uid == resource.data.uid
+                    && request.resource.data
+                         .diff(resource.data)
+                         .affectedKeys()
+                         .hasOnly(['hiddenByOwner', 'hiddenAt'])
+                    && request.resource.data.hiddenByOwner == true;
+
       // Games and their recordings are archival assets (spec
       // SS6.3): clients never delete them.
       allow delete: if false;
+
+      // Replay comments (turn-anchored notes on verified games).
+      match /comments/{commentId} {
+        function parentGame() {
+          return get(/databases/$(database)/documents/games/$(gameId)).data;
+        }
+        allow read: if parentGame().status == 'verified'
+                    || (signedIn() && parentGame().uid == request.auth.uid);
+        allow create: if signedIn()
+                      && parentGame().status == 'verified'
+                      && request.resource.data.uid == request.auth.uid
+                      && request.resource.data.keys()
+                           .hasOnly(['uid', 'authorName', 'text',
+                                     'turn', 'createdAt'])
+                      && request.resource.data.text is string
+                      && request.resource.data.text.size() >= 1
+                      && request.resource.data.text.size() <= 500
+                      && request.resource.data.authorName is string
+                      && request.resource.data.authorName.size() >= 1
+                      && request.resource.data.authorName.size() <= 60
+                      && (request.resource.data.turn == null
+                          || (request.resource.data.turn is int
+                              && request.resource.data.turn >= 0));
+        allow update: if false;
+        allow delete: if signedIn()
+                      && (resource.data.uid == request.auth.uid
+                          || parentGame().uid == request.auth.uid);
+      }
     }
```

请开发侧（Muse）轻量过目并在 `ops/discuss.md` 回复确认，确认后部署侧再发布 `firestore.rules`。
