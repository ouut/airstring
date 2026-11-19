# S6 报告：Firebase 接线（代码侧＋本地端到端门）

基线：仓 HEAD `7c15612`（远程 `7a88ca8d`），S1–S5 已验收。
工作区 `~/workspace/airstring-work/s6/`。**结论：交付文件齐备，
本地门 G1–G4 实跑全过，G5 按口径人工逐条核对（如实声明未用
模拟器）。未做真实部署、未产生云费用、未猜任何凭据。**

## 1. 交付文件清单（工作区内、仓内相对路径）

| 文件 | 内容 |
|---|---|
| `.firebaserc` | 默认项目指向 `airstring-nethack` |
| `firebase.json` | Hosting（public=`dist`，predeploy 跑组装脚本；wasm/js 一周缓存头，规格 §6.1 的包缓存要求）＋Firestore rules/indexes 挂接＋Storage rules 挂接＋emulators 端口预留。Cloud Run 不归 firebase.json 管，见部署文档 |
| `firestore.indexes.json` | 榜单（status＋createdAt 降序）与个人历史（uid＋createdAt 降序）两个复合索引 |
| `firestore.rules` | 见 §2 |
| `storage.rules` | 见 §2 |
| `tools/assemble-dist.mjs` | predeploy 组装：`web/` ＋ `out/nethack.js/.wasm` → `dist/`（与本地桩的服务口径一致；桩文件头注释早已预告此形态） |
| `verifier/server.mjs` | Cloud Run worker 入口：`POST /verify`（录制 JSONL 直传 / JSON 信封 `{recording}` / `{storagePath}` 三种入参）＋`GET /healthz`；幂等查表后才重放 |
| `verifier/verify.mjs` | 验真核心：格式解析＋结构校验（turn 序号、keys 总数与 end 对账、日期钉死、种子 64 位）→拼按键流→`tools/run-node-s3.mjs --mode replay` 无头重放→逐帧比对 `[hero] hash=` 与 `turn.hash` |
| `verifier/store.mjs` | 幂等存储适配器：`get(gameId, recordingSha256)`/`put(record)`；memory 与 file（原子写）两种实现 |
| `verifier/gcp.mjs` | 生产侧适配：REST 版 Firestore verdict 存储（写 `verdicts/{gameId}` 全量记录＋回写 `games/{gameId}` 的 status 与摘要）与 Storage 对象下载；令牌取自 Cloud Run 元数据服务器或 `GOOGLE_ACCESS_TOKEN`。零 SDK 依赖 |
| `verifier/package.json` | 零运行时依赖，`npm start` 即跑（Node ≥ 20） |
| `verifier/Dockerfile` | `node:20-slim`；**构建上下文须为仓根**（镜像内 `verifier/`、`tools/run-node-s3.mjs`、`out/` 同级；pre-s3 已编入 wasm 构建的 pre-js，运行时不需要） |
| `web/firebase-config.js` | 占位 config（六字段，注释写明真实值来自控制台注册 Web App、属公开标识可入仓） |
| `web/firebase.js` | 云端传输层（新文件）：SDK 经 gstatic CDN 懒加载（8 秒超时、失败即静默回退）；Google 登录 UI 渲染进 `#auth-box`；`uploadChunk`（Storage 按 seq 命名的 chunk 对象，幂等覆写）与 `finalizeGame`（规范录制对象＋Firestore games 文档，status=`pending`） |
| `web/index.html` | 仅两处加法：顶栏 `#auth-box` 占位、模块脚本前加载 `firebase-config.js` |
| `web/airstring.js` | 仅三处加法（见 §3），已验逻辑零改动 |
| `docs/s6-deploy.md` | 上线清单：控制台启用服务、拿 config、部署 rules/hosting、Cloud Run 部署与服务账号权限、上线冒烟、自定义域名 |

非交付物：`dist/`（predeploy 生成物）、`evidence/`（门证据）、
`out/`（复用 S5 的 S4 定版构建，wasm sha `d2a5673c…`）。

## 2. 规则口径

- **Firestore**：`/games/{gameId}` 创建须本人 uid、status 必须
`pending`、不得携带任何 verdict 字段、date 必须为钉死值；
本人更新只许动 `end/turns/frames/keysTotal/updatedAt` 且
status 钉在 `pending`（uid/seed/date/options 不可变由 diff
白名单保证）；删除恒禁（归档资产）；读＝verified 公开
（榜单）或本人。`/verdicts/{id}` 客户端恒禁（verifier 经
IAM/Admin 口径绕过 rules 写）。其余路径全拒。
**rules 不是过滤器**：榜单查询必须自带
`where('status','==','verified')`、个人历史必须自带
`where('uid','==',uid)`，否则查询被规则引擎整体拒绝——
此口径已写入 rules 文件头注释与部署文档。
- **Storage**：`recordings/<uid>/…`、`saves/<uid>/…` 一律
owner-only 前缀；规范录制限 `.jsonl` 后缀＋
`application/x-ndjson`＋5 MiB 上限；chunk 限
`chunk-<seq>.json` 命名＋1 MiB。录制本身不公开（榜单只露
Firestore 元数据）。verifier 以服务账号读，不受 rules 约束。

## 3. web 接线（加法明细）

`web/airstring.js` 与基线的 diff 只有三处，其余逐字节未动：

1. 顶部懒加载 `firebase.js`（失败即 `cloud=null`）＋
`cloudActive()` 判定（已配置且已登录）。
2. `flushRecords` 内二选一：云端活跃 → `cloud.uploadChunk`
（Storage）；否则原 S5 的 `fetch('./upload')` 代码原样。
失败处理与 S5 一致（置 `uploadFailed`、录制留内存）。
3. `handleGameOver`：云端活跃时在上传链尾追加
`cloud.finalizeGame`（规范录制＋games 文档）；局终文案仅
云端路径多一个分支，桩路径文案与 S5 逐字相同。

未登录/未配置时整条云端路径不触发——**不登录照样能玩**，
与 S5 行为一致（登录只决定录制落云还是落桩）。

## 4. 本地门证据（`evidence/`）

verifier 以 `VERIFIER_STORE=file`、`VERDICT_FILE=evidence/
verdicts.json`、`AIRSTRING_ROOT=<工作区>` 在 8086 端口实跑：

- **G1 过**：`POST` S5 的 `desktop-recording.jsonl` →
`verified`，reason「hash-chain: all 11 frame hashes
reproduced by headless replay」，framesCompared/Matched
11/11，耗时约 1.2 s（`g1-verdict.json`）。
- **G2 过**（三例均 `rejected`＋明确 reason，`g2-*.json`）：
(a) 改 turn 2 按键一字节 → 重放只产 6 帧，
`frame-count-mismatch: replay produced 6 frames, recording
claims 11`；(b) 改 turn 5 的 hash 一位 → `hash-mismatch at
frame 4 (turn 5)`，10/11 匹配，定位精确到被改帧；
(c) 改 header.seed 42→43 → `hash-mismatch at frame 0`。
- **G3 过**：同一录制第二次 `POST` → `idempotent: true`，
verdict 与比对摘要与第一次逐字段一致（脚本比对 8 个字段，
`g3-verdict.json`）。
- **附带验证**：JSON 信封形式（mobile 录制）→ `verified`
11/11（`g-envelope.json`）；恢复局变体（header.restored=
`0fleck`）→ `rejected`，reason 明示
`restored-not-self-contained` 口径（`g-restored.json`）。
- **G4 过**：`node tools/assemble-dist.mjs` 组装成功；
recording-stub 以接线后的 `web/` 起服务（8378 端口），
`/`、`/airstring.js`、`/firebase-config.js`、`/firebase.js`、
`/commands.js`、`/airstring.css`、`/nethack.js`、
`/nethack.wasm` 全部 **200**（大小与源文件一致）。
- **G5 人工核对（如实声明）**：本机无 firebase CLI、无
模拟器、无 docker，**规则未经模拟器验证**。已逐条人工核：
两份 rules 的 `rules_version`/service/match 骨架、函数定义
先于使用、`keys().hasAny()`/`diff().affectedKeys().
hasOnly()`/`matches()`（RE2 全串匹配）等 API 用法、
create/update 字段约束与 `web/firebase.js` 实际写入字段的
对应（date=1700000000、contentType、chunk 命名均对齐）、
catch-all 拒绝不覆盖先行 allow（OR 语义）。上线时须按
部署文档 §5 第 4 项做一次真实规则冒烟补验。

## 5. 纪律自查

- oracle 源码未复制未触碰；`tools/pre-s3.js` 与基线逐字节
一致（diff 核过）；`web/` 与 `tools/` 对基线的 diff 恰为
§1/§3 所列加法，无夹带。
- 未尝试真实部署、未登录任何账号、未产生云费用；Dockerfile
未在本机 build（无 docker CLI），属部署步的一部分。

## 6. 登记项（请主线裁定/知悉）

1. **施工中修掉一个真 bug**：server 初版按「body 以 `{` 开头」
嗅探 JSON 信封，而 JSONL 每行都是 JSON 对象、首行必以
`{` 开头，G1 首跑即被误判 `bad-json-body`。已改判据：
整 body 能 parse 成单个 JSON 值且带 `recording`/
`storagePath` 键才算信封，其余一律作录制文本交解析器。
2. **验真触发尚未自动接线**：客户端局终只把局置 `pending`；
目前无自动调用方触发 `POST /verify`（部署文档 §5 用手工
curl 冒烟）。已定方向（待排期）：`finalizeGame` 成功后由
客户端以 `{storagePath}` 调一次 verifier；worker 公开可调
的抗滥用硬化（校验 Firebase ID Token）同批做。在此之前
局会停留在 `pending`，不影响数据完整性。
3. **恢复局的 verdict 映射**：按本期二值口径判 `rejected`，
reason 明示是自包含限制而非篡改。若主线希望与「作弊
拒绝」区分，可将来加第三态 `unverifiable`；verdict 记录
里 reason 已可机读区分（前缀 `restored-not-self-contained`）。
4. **GCP 生产路径未实测**：`gcp.mjs` 的 Firestore REST 写入、
Storage 下载、元数据令牌三条路径无凭据可测，只做了代码
审查；首次实测即部署文档 §5 第 3 项冒烟。Dockerfile 同理
未在本机构建过。
5. **Storage rules 的命名模式依赖 `matches()` 作用于路径
变量**：属标准 rules API，但同样只经人工核对（见 G5）。
若真实引擎表现不符，降级方案是去掉命名模式——安全边界
在 uid 前缀检查上，命名模式只是卫生约束。
6. **大种子精度（既有口径继承）**：前端随机种子是 64 位十
进制串，而重放 harness 的 `--seed` 走 JS `parseInt`，
超过 2^53 的种子在记录端（config 注入）与重放端走的是
同一数值路径，行为一致、验真口径自洽（S5 已按此验收）；
若将来要让种子全程精确，应把种子改为字符串/BigInt 贯通，
属 harness 层改造，不在 S6 范围。
7. **生产未登录局的上传落点**：Hosting 上同源 `/upload` 不
存在，未登录局的录制会置 `uploadFailed` 并保留在页面
内存＋可整流下载（S5 既有语义在生产的表现）。M0 可接受；
若要未登录局也入云，需另议匿名通道口径。

## 7. 部署剩余事项

全部收敛在 `docs/s6-deploy.md`：控制台启用 Auth(Google)/
Firestore/Storage 与注册 Web App 拿 config、Blaze 与预算
告警复核；`firebase deploy` 规则/索引/Hosting；
Cloud Run 部署 verifier 与服务账号授权；上线冒烟四项；
自定义域名排 M1 前（所有者 DNS）。M0 关期验收（真人局→
归档→自动验真→入索引→fleck 侧差分消费）待部署后由主线
执行，其中「自动验真」一项依赖登记项 2 的触发接线。
