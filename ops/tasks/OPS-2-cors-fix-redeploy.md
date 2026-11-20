# OPS-2：verifier CORS 修复重部署＋自动触发冒烟复测

- **背景**：OPS-1 第三步 BLOCKED 已定位：`verifier/server.mjs` 无
  CORS 预检处理。开发侧已修复并推送（提交 `88554e94`）：
  ① `OPTIONS` 预检回 204、允许来源（web.app / firebaseapp.com /
  airstring.org / www.airstring.org）带
  `Access-Control-Allow-Origin` 等头，所有响应透传 CORS 头；
  ② 顺带把 ID Token 校验从 `tokeninfo` 端点换为 **securetoken
  JWKS 本地 RS256 验签**（采纳 OPS-1 报告的风险提示，消除
  tokeninfo 对 Firebase Token 接受度的不确定性）。
  开发侧本地实测：预检 204＋头齐、异源无 ACAO、验真 200 不变、
  伪造 JWT 401、无 token 401。
- **本单只动 verifier**（Hosting 无需重部署）。

## 第一步：重部署 verifier

```sh
gcloud builds submit --config cloudbuild.yaml --project=airstring-nethack .
gcloud run deploy airstring-verifier \
  --image us-central1-docker.pkg.dev/airstring-nethack/airstring/verifier:v1 \
  --region us-central1 --project airstring-nethack --allow-unauthenticated \
  --set-env-vars VERIFIER_STORE=firestore,FIREBASE_PROJECT=airstring-nethack,STORAGE_BUCKET=airstring-nethack.firebasestorage.app,VERIFIER_REQUIRE_AUTH=1
```

验收：
- `curl -s https://airstring-verifier-39704157599.us-central1.run.app/health`
  → `{"ok":true}`；
- 预检复现 OPS-1 的 curl：
  `curl -s -i -X OPTIONS .../verify -H 'Origin: https://airstring-nethack.web.app'
  -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: authorization,content-type'`
  → **204** 且带 `access-control-allow-origin: https://airstring-nethack.web.app`；
- 无 token POST /verify → 401（不变）。

## 第二步：冒烟复测（关门项，需玩家配合打一局）

1. 玩家在 `https://airstring-nethack.web.app/` 登录、打一局短局
   `#quit` 结束（请记下新局 gameId）；
2. **不许手工 curl 触发**。等约 10 秒，查 Firestore：
   - `games/<新gameId>` 的 `status` 应自动翻为 `verified`（或
     `rejected` 并附 verdicts 中的 reason）；
   - `verdicts/<新gameId>` 文档应存在；
   - 浏览器控制台应有 `[airstring] verify trigger: 200` 一行、
     无 CORS 报错。
3. 若仍失败：把控制台原文＋games 文档状态记入报告并停步。

注：OPS-1 卡住的 pending 局 `g-42-20261120035713-ec39` 不用管
（客户端只在局终触发；该局留档即可，将来如需补验真走人工流程）。

## 报告

落 `ops/reports/OPS-2-report.md`：新 revision 号、预检输出原文、
新局 gameId 与 status 翻转结果、verdicts 文档关键字段。
