# OPS-1：验真自动触发上线（验真 worker 重部署＋前端重部署＋冒烟）

开发侧提交基线：`c23e33a7`（含本任务文件）。本任务只部署、不改代码；
失败停步、按 `ops/README.md` 纪律把报告写到 `ops/reports/OPS-1-report.md`。

## 背景（本次改动内容，部署侧只需知道验收点）

- 前端：局终 finalize 后，浏览器会带玩家 ID Token 自动调用
  `POST <verifier>/verify {storagePath}`，玩家不再需要任何手工触发。
- 验真 worker：新增 `/health` 健康路径（`/healthz` 在 Cloud Run
  到不了容器）；开启 `VERIFIER_REQUIRE_AUTH=1` 后，`/verify` 要求
  Firebase ID Token 且 Token 的 uid 必须与录制路径中的 uid 一致。
- 开发侧本地已测：关 auth 时旧录制照常 verified；开 auth 时无
  Token/假 Token 均 401、`/health` 200。带真 Token 的成功路径
  只能在生产由本次冒烟验。

## 第一步：重部署验真 worker

```sh
gcloud builds submit --config cloudbuild.yaml --project=airstring-nethack .
gcloud run deploy airstring-verifier --image us-central1-docker.pkg.dev/airstring-nethack/airstring/verifier:v1 --region us-central1 --project airstring-nethack --allow-unauthenticated --set-env-vars VERIFIER_STORE=firestore,FIREBASE_PROJECT=airstring-nethack,STORAGE_BUCKET=airstring-nethack.firebasestorage.app,VERIFIER_REQUIRE_AUTH=1
```

验收：`curl https://airstring-verifier-39704157599.us-central1.run.app/health`
返回 `{"ok":true}`；再 `curl -X POST .../verify`（不带 Token）应返回
401 `{"error":"unauthorized"}`。两条输出原文入报告。

## 第二步：重部署 Hosting（前端自动触发代码上线）

```sh
firebase deploy --only hosting --project airstring-nethack
```

## 第三步：冒烟——自动触发全链（本任务的关门项）

1. 打开站点、Google 登录、完整打一局到局终（自然结束或 #quit 均可）。
2. **不要手工 curl /verify**。等约 10 秒后查 Firestore
   `games/<新局id>`：`status` 应已自动变为 `verified`（或 `rejected`，
   但须是验真器回写的状态而非一直停在 `pending`），且 `verdicts/<新局id>`
   存在。把新局 id 与两处文档关键字段写入报告。
3. 若状态一直停在 `pending`：记录浏览器控制台里
   `[airstring] verify trigger:` 一行的内容（状态码或报错）入报告，
   停步等开发侧裁定，不要改代码绕过。

## 第四步：取一局已验真录制样本回仓（供开发侧差分消费）

把冒烟局 `g-42-20261119213946-c35a` 的定版录制取回并落仓：

```sh
gcloud storage cp gs://airstring-nethack.firebasestorage.app/recordings/bMwyOuJitPTGqE2gTGQhi9BhD3x1/g-42-20261119213946-c35a.jsonl ops/samples/smoke-g-42-20261119213946-c35a.jsonl
```

校验文件为 JSONL（首行 `k` 为 `header`、末行 `k` 为 `end`），随报告
一并 commit＋push，并在报告中写明文件 sha256 与字节数。

## 交付

`ops/reports/OPS-1-report.md`：逐项成败与输出原文、新 revision 号、
第三步新局 id 与状态变化证据、第四步样本 sha256。凭据不入仓、不入报告。
