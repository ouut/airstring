# IMPORT-1 — beam 束搜索初始数据导入（开发侧交付，部署侧执行）

下发：开发侧（主线），2026-11-20。仓主已批准本批数据与导入口径。

## 数据包

- 内容：**50 条录制**（49 条 beam 死亡谱系完整局＋1 条最深活谱系续打版，#quit 关局），全部已在开发侧用仓内 verifier 本地模式按生产同判据验真，**50/50 verified**（结构校验＋无头重放逐帧哈希链全对；另以原生 oracle 交叉核验 49 条帧 sha 与 WASM 一致）。
- 构成：L20×1、L19×7、L18×11、L17×3、L15×4、L14×4、L13×4、L12×6、L11×6、L5–9×4、续打版（L19 quit）×1。逐条清单（gameId、来源谱系、end 层/XL、结局、frames、keys 字节、入选理由）在包内 `MANIFEST.md`／`MANIFEST.json`，方法与对账口径在 `REPORT.md`。
- 下载：https://muse.ai/files/1496095776913049/2104604980201550/trfnxdykytonw0eqbv15h22r/beam-seed-001.tar.gz
  - sha256：`709b50c6cab25c2316fea3df15f9c7faca5da087c0aff9154716000e08d05e5f`（15,719,713 字节，解开后 recordings/ 共 75,290,091 字节）
  - **链接 2026-11-22T21:42Z 过期**，请在此之前取走；过期未取请在 ops/discuss.md 留言，开发侧重传。
- 兼容性（已实测，导入无需适配）：录制 header 的 options 与站方默认 NETHACKOPTIONS 逐字相同、date 同为钉死值 1700000000、seed=55（seedSource=given）。ua 字段标注离线生成，属实。

## 导入口径（仓主已裁定）

管理端脚本导入，**不开发常驻导入 API、不发长期静态 token、不放宽客户端 Firestore/Storage 规则**：

1. **归属账号**：为导入局建一个官方机器人账号（Firebase Auth／Google 登录），显示名建议 `Beam Search`。全部 50 条挂在该 uid 名下，榜单与录像页按乙案口径（验真即上榜、不分人机）正常展示，并以该账号身份自明来源。
2. **落库**：部署侧以服务账号＋Admin SDK 执行一次性脚本：录制文件落 `recordings/<bot-uid>/<gameId>.jsonl`（或现行规范路径），games 文档按客户端同款字段创建（status=pending、不带任何 verdict 字段、seed/date/options 与录制 header 一致），另加来源元数据：`source="beam-import"`、`batch="beam-seed-001"`、来源谱系 id（MANIFEST 的「来源谱系」列）。
3. **幂等**：以 gameId 为键——Storage 写用 `ifGenerationMatch=0`、Firestore 建文档前查存；脚本可安全重跑，不产生双份。
4. **验真**：落库后逐条以现行机制触发验真器（verdict 仍只由验真器写）。预期 50/50 verified（开发侧同判据已全过）；如有 rejected，**不要改数据、不要手写 verdict**，把 gameId 与验真器原文回报开发侧判读。
5. **公开与分叉**：verified 后按 Phase 1/2 既有口径生成公开录像（publicRecordingPath 等字段由验真器侧流程产出），这批局即站上首批可回放、可分叉的初始库。
6. **报告**：导入完成后在 `ops/reports/` 落 IMPORT-1 报告：脚本执行时间、落库条数、逐条 verdict、公开录像首例与分叉入口可用性确认、异常原文（如有）。

## 不在本批范围

- 续打版的卡死点存档（incomplete，未完局）留开发侧存档，不导入。
- 另有 313 条 beam 深层未完局残局包正在开发侧整理（原始数据存档、未验真），其上站方式（需先有终局）另行议定，不并入本批。
