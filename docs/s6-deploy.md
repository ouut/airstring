# airstring S6 部署清单（Firebase 项目 `airstring-nethack`）

代码侧已在 S6 完成并过本地门（见工作区 REPORT.md）。本清单是
把可部署物真正上线的剩余步骤，按顺序照做即可。标注
**** 的步骤必须项目所有者本人操作（账号/计费/授权
类），其余步骤任何有项目权限的人（含主线在所有者授权下）可做。

费用纪律（规格 §6.1）：全程 Blaze 档免费额度内运行，预期月费
$0；任何一步若提示将产生持续费用，先停下报用户。

## 0. 前置（所有人）

- Node ≥ 20、`firebase-tools` 与 `gcloud` CLI：
`npm install -g firebase-tools`
- 仓内构建产物就绪：`./build-wasm.sh`（产出 `out/`）。
- `firebase login`（用项目所有者的 Google 账号，或被授予
Firebase Admin 角色的账号），然后在仓根目录
`firebase use airstring-nethack`（`.firebaserc` 已指向该项目）。

## 1. 控制台启用服务

打开 console.firebase.google.com/project/airstring-nethack：

1. **计费复核**：项目设置确认已在 **Blaze** 档；到
Google Cloud Billing → Budgets & alerts 建一条预算告警
（建议 $1 起报、$5 封顶提醒）——这是上线前的硬前置。
2. **Authentication**：Build → Authentication → Get started →
Sign-in method → 启用 **Google** 提供方。Settings →
Authorized domains 里确认有 `localhost`，上线域名
`airstring.org` 在第 6 步一并加。
3. **Firestore**：Build → Firestore Database → Create database
→ **Production mode**（规则由第 3 步部署的 firestore.rules
接管，不要停留在控制台默认规则上裸奔）。
4. **Storage**：Build → Storage → Get started（默认 bucket；
若 bucket 名是 `<project>.appspot.com` 而非
`.firebasestorage.app`，把 `web/firebase-config.js` 与
verifier 的 `STORAGE_BUCKET` 环境变量改成实际值）。
5. **注册 Web App 拿 config**：Project settings → General →
Your apps → Web（`</>`）→ 注册 “airstring web” → 把给出的
`firebaseConfig` 六个字段填进 `web/firebase-config.js`
（替换全部 `REPLACE_...` 占位）。这些值是公开客户端标识，
不是密钥，可入仓；真正的访问控制在 rules 里。

## 2. 部署规则与索引

```sh
firebase deploy --only firestore:rules,firestore:indexes,storage:rules
```

部署后到控制台 Rules 页确认两份规则已生效（版本时间应为本次）。

## 3. 部署 Hosting

```sh
firebase deploy --only hosting
```

`firebase.json` 的 predeploy 钩子会先跑
`node tools/assemble-dist.mjs`，把 `web/` 与 `out/nethack.js`、
`out/nethack.wasm` 组装进 `dist/`（与本地桩的服务口径一致）。
部署完打开 `https://airstring-nethack.web.app/` 冒烟：未登录应
能完整打一局（走本地回退逻辑时上传指向同源 `/upload` 会 404
而置 uploadFailed——这是预期：生产环境应登录后走云端通道；
未登录局的录制仍可整流下载）。

## 4. 部署验真 worker（Cloud Run）

Dockerfile 在 `verifier/Dockerfile`，**构建上下文必须是仓根**
（镜像内需要 `tools/run-node-s3.mjs` 与 `out/` 与 `verifier/`
同级）：

```sh
# 一次性：Artifact Registry 仓库
gcloud artifacts repositories create airstring \
--repository-format=docker --location=us-central1 \
--project=airstring-nethack

IMG=us-central1-docker.pkg.dev/airstring-nethack/airstring/verifier:v1
docker build -f verifier/Dockerfile -t "$IMG".
docker push "$IMG"

gcloud run deploy airstring-verifier \
--image "$IMG" --region us-central1 \
--project airstring-nethack \
--allow-unauthenticated \
--set-env-vars VERIFIER_STORE=firestore,FIREBASE_PROJECT=airstring-nethack,STORAGE_BUCKET=airstring-nethack.firebasestorage.app
```

- 运行服务账号权限：给 Cloud Run 的运行服务账号授予
`roles/datastore.user`（读写 Firestore 写 verdict/回写
games.status）与 `roles/storage.objectViewer`（读
recordings/ 前缀取录制；条件限定到该 bucket 更佳）。
- `--allow-unauthenticated` 的理由：verdict 由 worker 亲自重放
计算、不采信请求方任何断言，公开调用只能浪费少量重放算力
（Cloud Run 免费额度 18 万 vCPU 秒/月量级足够 M0）。后续
硬化项：校验调用方 Firebase ID Token，见 REPORT 登记项。

## 5. 上线冒烟（部署后逐项核）

1. 打开站点 → Google 登录 → 打一局短局至局终。
2. Storage 控制台：`recordings/<uid>/<gameId>.jsonl` 与
`chunks/` 对象存在；Firestore：`games/<gameId>` 文档
status=`pending`、字段齐全。
3. 手工触发验真：
`curl -X POST <verifier-url>/verify -H 'content-type: application/json' -d '{"storagePath":"recordings/<uid>/<gameId>.jsonl"}'`
期望 `verdict: "verified"`，且 `games/<gameId>` 的 status
随即变 `verified`、`verdicts/<gameId>` 出现完整记录。
4. 榜单查询冒烟（控制台或前端）：`games where status ==
'verified'` 能列出该局；未登录状态下读 pending 局应被拒。

## 6. 自定义域名（M1 前，所有者）

Hosting → Add custom domain → `airstring.org`，按控制台给出的
记录去注册商处改 DNS；完成后回 Authentication 的 Authorized
domains 加 `airstring.org`。DNS 在所有者手里，此步不挡 M0
关期（关期验收可用 `*.web.app` 域名完成）。
