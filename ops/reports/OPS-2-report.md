# OPS-2 交付报告：verifier CORS 修复重部署＋自动触发冒烟复测

- **任务文件**：`ops/tasks/OPS-2-cors-fix-redeploy.md`
- **基线提交**：`5f318d0`（含 `88554e94` CORS＋securetoken JWKS 修复；仓内代码与规则零改动）
- **总体结论**：**✅ ALL PASS（关门项通过）**——新 revision `airstring-verifier-00003-464` 已上线，预检 204 与 CORS 头齐全、无 Token 401 不变；玩家新局 `g-42-20261120043119-8d05` 未经任何手工触发，局终 ~2.9 秒内自动完成验真并将 `games/` 状态翻转为 `verified`（6/6 帧全等）。

---

## 第一步：重部署 `airstring-verifier` — ✅ PASS

- **范围**：按任务书仅重部署 verifier，未重部署 Hosting。
- **Cloud Build 结果**：
  - Build ID：`352b3f96-6cce-421a-b407-0f3e77a43b8b`（`SUCCESS`，耗时 `23s`）
  - 镜像：`us-central1-docker.pkg.dev/airstring-nethack/airstring/verifier:v1`（`sha256:e3b41cd0388f558f93b5899243e68d9c1d8536a70eb5056f4c30b5c7dd1b22d4`）
- **Cloud Run 新版本**：
  - 新 revision：**`airstring-verifier-00003-464`**（100% 流量，`VERIFIER_REQUIRE_AUTH=1`）
  - 服务 URL：`https://airstring-verifier-39704157599.us-central1.run.app`
- **验收输出原文**：
  1. `GET /health`：
     ```text
     {"ok":true}
     HTTP_STATUS=200
     ```
  2. `OPTIONS /verify` 预检（`Origin: https://airstring-nethack.web.app`）：
     ```text
     HTTP/2 204
     access-control-allow-headers: authorization, content-type
     access-control-allow-methods: POST, GET, OPTIONS
     access-control-allow-origin: https://airstring-nethack.web.app
     access-control-max-age: 86400
     content-type: text/html
     date: Fri, 20 Nov 2026 04:28:00 GMT
     server: Google Frontend
     vary: Origin
     ```
  3. 无 Token `POST /verify`：
     ```text
     {"error":"unauthorized"}
     HTTP_STATUS=401
     ```

---

## 第二步：冒烟复测（关门项，全程无手工 `/verify` 触发）— ✅ PASS

- **玩家对局与前端触发**：
  - 玩家 Google 登录（uid：`bMwyOuJitPTGqE2gTGQhi9BhD3x1`），于 `https://airstring-nethack.web.app/` 开局并 `#quit` 正常结束。
  - **新局 ID**：`g-42-20261120043119-8d05`
  - **浏览器控制台输出**：`[airstring] verify trigger: 200`（无任何 CORS 报错）。
  - **Storage 落盘**：`gs://airstring-nethack.firebasestorage.app/recordings/bMwyOuJitPTGqE2gTGQhi9BhD3x1/g-42-20261120043119-8d05.jsonl`（`1173 B`，`2026-11-20T04:31:22Z`）。

- **Firestore `games/g-42-20261120043119-8d05` 自动翻转核验**：
  - `createTime`：`2026-11-20T04:31:23.040209Z` → `updateTime`：`2026-11-20T04:31:25.914759Z`（局终后 **2.9 秒**内自动翻转）
  - `status`：**`"verified"`**
  - `seed`：`"42"`（`seedSource`: `"given"`）、`date`：`1700000000`
  - `options`：`"name:fleck,role:valkyrie,race:human,gender:female,align:lawful"`
  - `end`：`0`、`turns`：`6`、`frames`：`6`、`keysTotal`：`24`、`restored`：`null`
  - `framesCompared`：`6`、`framesMatched`：`6`
  - `verdictReason`：`"hash-chain: all 6 frame hashes reproduced by headless replay"`
  - `verifiedAt`：`"2026-11-20T04:31:23.825Z"`
  - `recordingSha256`：`"dd6e1858673a7e41b1443d26f734d69f798737edb5dd22634068aaefc1e8a24e"`

- **Firestore `verdicts/g-42-20261120043119-8d05` 关键字段**：
  - `createTime`：`2026-11-20T04:31:25.728295Z`
  - `verdict`：**`"verified"`**
  - `verdictReason`：`"hash-chain: all 6 frame hashes reproduced by headless replay"`
  - `framesCompared`：`6`、`framesMatched`：`6`、`firstMismatch`：`null`
  - `endStatus`：`0`、`seed`：`"42"`、`seedSource`：`"given"`
  - `verifiedAt`：`"2026-11-20T04:31:23.825Z"`
  - `verifier`：`"airstring-verifier/1 (S6)"`
  - `recordingSha256`：`"dd6e1858673a7e41b1443d26f734d69f798737edb5dd22634068aaefc1e8a24e"`

- **备注**：OPS-1 遗留的 `g-42-20261120035713-ec39` 按要求保持不动（仍为 `pending`）。
