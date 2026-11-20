# OPS-1 交付报告：验真自动触发上线（停步于第三步 CORS 阻断）

- **任务文件**：`ops/tasks/OPS-1-verifier-auto-trigger-redeploy.md`
- **基线提交**：`c23e33a7`（拉取至 `4002dee`，仓内代码与规则零改动）
- **总体结论**：**未过关门项（BLOCKED on Step 3）**——第一步、第二步、第四步均 PASS；第三步按预期暴露出 Cloud Run `/verify` 缺少 CORS / `OPTIONS` 预检处理，浏览器拦截了自动触发请求，新局停在 `pending`。按 `ops/README.md` 纪律停步落报告，待开发侧修复后继续。

---

## 第一步：重部署验真 worker — ✅ PASS

- **执行命令**：
  ```sh
  gcloud builds submit --config cloudbuild.yaml --project=airstring-nethack .
  gcloud run deploy airstring-verifier --image us-central1-docker.pkg.dev/airstring-nethack/airstring/verifier:v1 --region us-central1 --project airstring-nethack --allow-unauthenticated --set-env-vars VERIFIER_STORE=firestore,FIREBASE_PROJECT=airstring-nethack,STORAGE_BUCKET=airstring-nethack.firebasestorage.app,VERIFIER_REQUIRE_AUTH=1
  ```
- **Cloud Build 结果**：
  - Build ID：`c41ea7f2-08cc-4b68-bd80-b3284f59c299`（`SUCCESS`，耗时 `24s`）
  - 镜像：`us-central1-docker.pkg.dev/airstring-nethack/airstring/verifier:v1`（`sha256:9b1cd0bf4e0fde48d7981cc77901cd9837668158144801f09c275548111bf732`）
- **Cloud Run 新版本**：
  - 新 revision：**`airstring-verifier-00002-hvd`**（100% 流量，已设 `VERIFIER_REQUIRE_AUTH=1`）
  - 服务 URL：`https://airstring-verifier-39704157599.us-central1.run.app`
- **验收输出原文**：
  - `curl https://airstring-verifier-39704157599.us-central1.run.app/health`：
    ```text
    {"ok":true}
    HTTP_STATUS=200
    ```
  - `curl -X POST https://airstring-verifier-39704157599.us-central1.run.app/verify -H 'content-type: application/json' -d '{}'`（无 Token）：
    ```text
    {"error":"unauthorized"}
    HTTP_STATUS=401
    ```

---

## 第二步：重部署 Hosting — ✅ PASS

- **执行命令**：
  ```sh
  npx -y firebase-tools@latest deploy --only hosting --project airstring-nethack
  ```
- **关键输出原文**：
  ```text
  Running command: node tools/assemble-dist.mjs
  [assemble-dist] dist/ ready: .gitkeep, airstring.css, airstring.js, commands.js, firebase-config.js, firebase.js, index.html, nethack.js, nethack.wasm
  ✔  hosting: Finished running predeploy script.
  i  hosting[airstring-nethack]: found 8 files in dist
  ✔  hosting[airstring-nethack]: file upload complete
  ✔  hosting[airstring-nethack]: version finalized
  ✔  hosting[airstring-nethack]: release complete
  ✔  Deploy complete!
  Hosting URL: https://airstring-nethack.web.app
  ```
- **线上核验**：`GET https://airstring-nethack.web.app/firebase-config.js` 已含 `globalThis.AIRSTRING_VERIFIER_URL = 'https://airstring-verifier-39704157599.us-central1.run.app'`。

---

## 第三步：冒烟——自动触发全链（关门项）— ❌ BLOCKED（CORS 预检被拒）

1. **真人登录对局至局终**：
   - 玩家 Google 登录（uid：`bMwyOuJitPTGqE2gTGQhi9BhD3x1`），于 `https://airstring-nethack.web.app/` 开局并 `#quit` 正常结束。
   - **新局 ID**：`g-42-20261120035713-ec39`
   - Storage 已落盘：`gs://airstring-nethack.firebasestorage.app/recordings/bMwyOuJitPTGqE2gTGQhi9BhD3x1/g-42-20261120035713-ec39.jsonl`（`837 B`，`2026-11-20T03:58:13Z`）

2. **Firestore 状态核验（未手工触发 `/verify`，等待 >1 分钟后查询）**：
   - `games/g-42-20261120035713-ec39` 停留在 `pending`：
     - `status`: `"pending"`
     - `gameId`: `"g-42-20261120035713-ec39"`
     - `uid`: `"bMwyOuJitPTGqE2gTGQhi9BhD3x1"`
     - `seed`: `"42"`（`seedSource`: `"given"`）、`date`: `1700000000`
     - `options`: `"name:fleck,role:valkyrie,race:human,gender:female,align:lawful"`
     - `end`: `0`、`turns`: `3`、`frames`: `3`、`keysTotal`: `35`、`restored`: `null`、`createdAt`: `"2026-11-20T03:58:13.707Z"`
   - `verdicts/g-42-20261120035713-ec39`：**不存在**（`verdicts` 集合仍仅有旧冒烟局 `g-42-20261119213946-c35a`）。

3. **浏览器控制台报错原文**：
   ```text
   Access to fetch at 'https://airstring-verifier-39704157599.us-central1.run.app/verify' from origin 'https://airstring-nethack.web.app' has been blocked by CORS policy: Response to preflight request doesn't pass access control check: No 'Access-Control-Allow-Origin' header is present on the requested resource.
   firebase.js:143  POST https://airstring-verifier-39704157599.us-central1.run.app/verify net::ERR_FAILED
   firebase.js:157 [airstring] verify trigger failed: Failed to fetch
   ```

4. **CLI 预检复现与根因说明**：
   - 模拟浏览器预检：
     ```sh
     curl -sS -i -X OPTIONS https://airstring-verifier-39704157599.us-central1.run.app/verify \
       -H 'Origin: https://airstring-nethack.web.app' \
       -H 'Access-Control-Request-Method: POST' \
       -H 'Access-Control-Request-Headers: authorization,content-type'
     ```
   - 返回原文：
     ```text
     HTTP/2 404
     content-type: application/json
     {"error":"not-found"}
     ```
   - **根因**：`verifier/server.mjs` 未处理 `OPTIONS` 预检且响应未带 `Access-Control-Allow-Origin` / `Access-Control-Allow-Headers` / `Access-Control-Allow-Methods`（跨源请求从 `https://airstring-nethack.web.app` 发往 `*.run.app` 且带 `Authorization` + `application/json` 必然触发 CORS 预检）。
   - **建议改法（供开发侧裁定）**：
     - 在 `verifier/server.mjs` 放行允许来源（如 `https://airstring-nethack.web.app`、`https://airstring.org`、本地开发源）的 CORS 头并响应 `OPTIONS /verify` 返回 `204`；或在 `firebase.json` 中用 Hosting `rewrites` 将同源 `/verify` 反代到 Cloud Run `airstring-verifier`（彻底消除跨域）。
   - **顺带风险提示（建议本次一并核查，避免下一轮再卡）**：
     - `verifier/server.mjs` 中 `checkIdToken()` 当前调用 `https://oauth2.googleapis.com/tokeninfo?id_token=...` 校验 Firebase Auth ID Token。Google `oauth2/tokeninfo` 通常仅验证 Google OAuth ID Token（`iss=accounts.google.com`），对 Firebase Auth 签发的 ID Token（`iss=https://securetoken.google.com/airstring-nethack`）可能会返回 400 无效导致 401；建议开发侧在修 CORS 时同步复核（必要时改用 Google `securetoken` 公钥验签或 Identity Toolkit `accounts:lookup`）。

---

## 第四步：取已验真录制样本回仓 — ✅ PASS

- **执行命令**：
  ```sh
  gcloud storage cp gs://airstring-nethack.firebasestorage.app/recordings/bMwyOuJitPTGqE2gTGQhi9BhD3x1/g-42-20261119213946-c35a.jsonl ops/samples/smoke-g-42-20261119213946-c35a.jsonl
  ```
- **落仓路径**：`ops/samples/smoke-g-42-20261119213946-c35a.jsonl`
- **校验结果**：
  - 字节数：`4104` bytes
  - 行数：`33` 行合法 JSONL（首行 `k: "header"`、末行 `k: "end"`、`gameId: "g-42-20261119213946-c35a"`）
  - SHA-256：`4aa402891ba991c68d52d025126754f96d706be466480de457626805183c860f`（与 Firestore `verdicts/g-42-20261119213946-c35a` 的 `recordingSha256` 逐字符一致）
