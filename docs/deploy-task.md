# airstring 部署任务书（交给部署/运维 agent 执行）

## 背景

- 项目：airstring.org 的 web 版 NetHack（收录可验真的对局录制）。代码仓
  `https://github.com/ouut/airstring`（公开仓，直接 clone，无需凭据）。
- Firebase 项目：`airstring-nethack`。部署目标：Firebase Hosting（前端）、
  Firestore/Storage 安全规则与索引、Cloud Run 验真 worker（`airstring-verifier`）。
- 仓内现状（已就绪，不要改动）：`web/firebase-config.js` 已填真实 config；
  `out/` 已含定版 wasm 构建产物（部署组装直接取用，无需本地编译）；
  `firebase.json`、`.firebaserc`、`firestore.rules`、`storage.rules`、
  `firestore.indexes.json`、`verifier/`（含 Dockerfile）、`cloudbuild.yaml`
  均已备好。**本任务只部署、不改代码与规则**；如认为必须改文件，先停下、
  把原因和改法写进交付报告，不要自行改动后继续。

## 执行环境要求

- 一个对项目 `airstring-nethack` 有 Owner 或 Firebase Admin＋Cloud Run Admin
  权限的 Google 账号，全程用该账号操作。
- 工具：Node ≥ 20、`firebase-tools`（`npm install -g firebase-tools`）、
  `gcloud` CLI。先 `firebase login` 与 `gcloud auth login`（如环境已登录则跳过）。
- 费用纪律（硬约束）：项目为 Blaze 按量档，目标是只用免费额度。若任何一步
  提示将启用付费资源、超出免费额度或要求改计费设置，**停下并在报告中注明**，
  不要继续。

## 第一段：规则与索引

在仓根目录执行：

```sh
firebase deploy --only firestore:rules,firestore:indexes,storage:rules --project airstring-nethack
```

验收：命令成功退出；到 Firebase 控制台 Firestore → Rules 与 Storage → Rules
页确认规则更新时间已变为本次部署时间。把命令输出原文存入交付报告。

## 第二段：Hosting 上线

```sh
firebase deploy --only hosting --project airstring-nethack
```

`firebase.json` 的 predeploy 钩子会自动把 `web/` 与 `out/` 组装进 `dist/`
再上传（日志里应出现 `[assemble-dist] dist/ ready`）。

验收：打开 `https://airstring-nethack.web.app/`，页面能加载、能进入开局界面；
浏览器开发者工具网络面板中 `nethack.wasm` 请求返回 200。截图或文字记录均可，
写入交付报告。

## 第三段：验真 worker（Cloud Run）

```sh
gcloud artifacts repositories create airstring --repository-format=docker --location=us-central1 --project=airstring-nethack
gcloud builds submit --config cloudbuild.yaml --project=airstring-nethack .
gcloud run deploy airstring-verifier --image us-central1-docker.pkg.dev/airstring-nethack/airstring/verifier:v1 --region us-central1 --project=airstring-nethack --allow-unauthenticated --set-env-vars VERIFIER_STORE=firestore,FIREBASE_PROJECT=airstring-nethack,STORAGE_BUCKET=airstring-nethack.firebasestorage.app
```

说明：若第一条报仓库已存在，跳过即可；`gcloud` 若提示启用 API
（artifactregistry / cloudbuild / run），逐个同意启用（均在免费额度内）。

然后给运行服务账号授权：

```sh
PN=$(gcloud projects describe airstring-nethack --format='value(projectNumber)')
gcloud projects add-iam-policy-binding airstring-nethack --member="serviceAccount:${PN}-compute@developer.gserviceaccount.com" --role=roles/datastore.user
gcloud projects add-iam-policy-binding airstring-nethack --member="serviceAccount:${PN}-compute@developer.gserviceaccount.com" --role=roles/storage.objectViewer
```

验收：`gcloud run services describe airstring-verifier --region us-central1
--project airstring-nethack` 能取到服务 URL；`curl <服务URL>/healthz`
返回 `{"ok":true}`。**服务 URL 必须写入交付报告**（后续接线要用）。

## 第四段：上线冒烟（逐项执行并记录结果）

1. 打开站点，用 Google 账号登录，完整打一局短局到局终（自然死亡或退出均可）。
2. 到 Storage 控制台确认存在 `recordings/<你的uid>/<gameId>.jsonl`；
   到 Firestore 确认 `games/<gameId>` 文档存在且 `status` 为 `pending`、
   字段含 seed/date/options/uid/end/turns/frames/keysTotal。
3. 手工触发验真（把尖括号换成第 2 项的实际值）：

   ```sh
   curl -X POST <服务URL>/verify -H 'content-type: application/json' -d '{"storagePath":"recordings/<uid>/<gameId>.jsonl"}'
   ```

   期望返回 JSON 中 `verdict` 为 `verified`；随后 Firestore 中
   `games/<gameId>` 的 `status` 变为 `verified`，且出现 `verdicts/<gameId>`
   文档。把 curl 的返回原文写入交付报告。
4. 规则冒烟：在未登录状态下尝试读取第 2 项那局（pending 时）应被拒；
   对 `games` 做 `status == 'verified'` 的查询应能列出已验真的局。
   记录实际结果（成功/被拒与提示原文）。

## 交付报告（必交）

逐项列明：每段命令的成败与关键输出原文、Hosting 站点 URL、Cloud Run
服务 URL、冒烟四项的逐项结果与证据（gameId、文档字段、curl 返回）。
任何一步失败：停在该段、报告失败命令与完整报错原文，不要改代码或规则
绕过。全部完成后把报告交回任务下达方。

## 不要做的事

- 不改仓内任何代码、规则、配置（含 `web/firebase-config.js`）。
- 不新建本任务书之外的云资源；不改项目名/项目 ID；不删除任何已有数据。
- 不把任何凭据、私钥写进仓或报告（本任务不需要任何私钥文件）。
