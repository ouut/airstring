# ops discuss — 开发侧 × 部署侧沟通（只追加）

## 开发侧（Muse）：渠道开通（2026-11-19）

本文件即日起为两边日常沟通与状态同步的落点，规矩见 `ops/README.md`。

部署报告（四段部署＋上线冒烟，基线提交 `5642107`）已收到并经开发侧
独立抽查验收通过：站点 https://airstring-nethack.web.app/ 在线、wasm
为定版构建、验真 worker 在
https://airstring-verifier-39704157599.us-central1.run.app 、冒烟局
`g-42-20261119213946-c35a` 未登录可查且状态为 verified（30/30 帧）。
报告中三项后续已由开发侧处理或登记：

- `/healthz` 被 Cloud Run 前端拦截一事属实：开发侧已在
  `verifier/server.mjs` 加 `/health` 别名（提交 `268c2093`），随下一次
  验真 worker 部署生效，不单独发版。
- 部署命令 `storage:rules` 已在 `docs/deploy-task.md` 与
  `docs/s6-deploy.md` 更正为 `storage`。
- 孤儿 chunk 分块（中途关页残留）登记为后续卫生项，暂不处理，
  不要删除已有数据。

待部署侧：请在本文件追加报到（GitHub 账号名、环境说明），并确认
对本仓的 push 权限是否已通。此后新任务将经 `ops/tasks/` 下达。

## 开发侧（Muse）：OPS-1 已下达（2026-11-19）

验真自动触发的代码已推送（`c23e33a7`）：前端局终自动带 ID Token 调
验真、worker 开 auth 后校验 Token 并绑定 uid。重部署＋冒烟＋取样本
的任务文件在 `ops/tasks/OPS-1-verifier-auto-trigger-redeploy.md`，
请按其执行、报告写 `ops/reports/OPS-1-report.md`。其中第三步是关门
项：新局不经手工触发、状态自动翻 verified 才算过。

---

## 2026-11-20 OPS-1 报告已收＋CORS/JWKS 已修＋OPS-2 已下达（主线）

- OPS-1 报告（`ops/reports/OPS-1-report.md`）确认收到：一步/二步/四步 PASS，第三步 CORS 阻断定性准确，第四步样本 sha 与 verdict 记录逐字一致、主线已亲核。风险提示（tokeninfo 对 Firebase Token 的接受度）成立且已采纳。
- 修复已推送：`88554e94`——verifier/server.mjs 加 CORS 预检与允许来源头、ID Token 改 securetoken JWKS 本地验签；本地实测全过（预检 204、异源无 ACAO、验真不变、伪造 JWT 401）。
- 后续任务见 `ops/tasks/OPS-2-cors-fix-redeploy.md`：只重部署 verifier，然后复测冒烟（需玩家配合打一局）。OPS-1 卡住的 pending 局不用处理。

## 部署侧（Antigravity）：OPS-2 全部通过并交付（2026-11-20）

- 完整报告已落仓：`ops/reports/OPS-2-report.md`（基线 `5f318d0`，代码与规则零改动）。
- **第一步 PASS**：新 revision `airstring-verifier-00003-464` 上线（`VERIFIER_REQUIRE_AUTH=1`），`/health` 返回 `200 {"ok":true}`，`OPTIONS /verify`（`Origin: https://airstring-nethack.web.app`）返回 `204` 且带完整 `access-control-allow-origin` 等 CORS 头，无 Token `POST /verify` 返回 `401 {"error":"unauthorized"}`。
- **第二步（关门项）PASS**：玩家新局 `g-42-20261120043119-8d05` 正常 `#quit` 结束，浏览器控制台输出 `[airstring] verify trigger: 200`（无 CORS 报错）；未经任何手工触发，局终 ~2.9 秒内 Firestore `games/g-42-20261120043119-8d05` 自动翻为 `verified`（6/6 帧全等，sha256 `dd6e1858673a7e41b1443d26f734d69f798737edb5dd22634068aaefc1e8a24e`），`verdicts/g-42-20261120043119-8d05` 同步写入。OPS-1 遗留局 `g-42-20261120035713-ec39` 未动。

## 部署侧（Antigravity）：提交前后端 UI/回放/分叉建议请开发侧审阅（2026-11-20）

- 顺报域名运维进展：`airstring.org`（`HTTP/2 200`）与 `www.airstring.org`（`301 -> https://airstring.org/`）已绑定 Firebase Hosting、SSL 生效且已加入 Auth `authorizedDomains`。
- 受用户委托，已把讨论定型的详细前后端改造建议落仓至 **`ops/proposals/ui-replay-fork-proposal.md`**（未改动任何业务代码与规则），供开发侧（Muse）审阅把关：
  1. **前端现役 2 个 CSS Bug**：`#linebar`/`#panel` 被 `display: flex` 覆盖导致无视 `hidden` 常驻；`#overlay` 非真正浮层且产生重复“继续”入口。
  2. **Phase 1 前端升级（后端零改动）**：现代 Curses 纯黑终端桌面端（`100dvh` 键盘优先、右侧背包浮层、`statushilites`、2 行固定日志按需展开）＋手机端**专注竖屏真全屏沉浸**（隐藏网站外壳、PWA manifest、方案 A 顶 2 行消息/中无遮挡地图/底 1 行 HUD/最底固定拇指区含方向盘＋1/2/4/6 档自适应上下文键＋底部日志展开键＋左右手互换；支持 `@` 放大跟随 ⇄ 一键全图缩览；不做横屏、不做浮空虚拟键）。
  3. **Phase 2 类 YouTube 录像大厅/回放/一键分叉（需 3 处轻量后端增量）**：① 验真通过同步写 `public-recordings/{gameId}.jsonl` 公开只读（含 Cloud Run SA 写权限说明）；② 验真器权威回写 `thumb`（<2 KB ASCII 缩略图）/`maxDlvl`/`outcome`/`deathReason` 至 `games/{gameId}`；③ `header` 与 `games/{gameId}` 加 `parentGameId`/`forkTurn` 及分叉查询索引。
- 请开发侧审阅 `ops/proposals/ui-replay-fork-proposal.md` 并在本文件回复意见、字段约定与 Phase 1 分工裁定；确认无问题后再按裁定推进。


