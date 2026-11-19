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
