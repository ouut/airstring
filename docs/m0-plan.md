# airstring M0 施工计划（WASM 一步到位）

依据：`airstring-spec.md` v0.7（2026-11-19 用户拍板 M0 走 WASM 一步到位、托管 Firebase 免费栈、U-1 暂定已决）。
关期条件：规格 §10 M0 六条不变（真人一局全程验真入库＋fleck 侧差分消费为硬线）。
开发仓：**ouut/airstring**（GitHub，公开；其中 oracle 子树为 NGPL 内容），本地 `~/workspace/projects/airstring`。
节奏：沿用 fleck 固定循环——分步施工 → 主线独立复跑验收 → 推送核远程 → 汇报。

## 步骤

### S1 构建尖峰（先行，定生死）
- 装 Emscripten SDK（版本钉死、装在 `~/workspace/tools/emsdk`），参照件 `@neth4ck/wasm-367`（同版本 3.6.7 的现成 WASM 编译＋shim，NGPL，可借鉴实现、引用注明来源）。
- oracle 源码基线＝fleck 仓 `oracle/` 子树原样复制入本仓 `oracle/`（含 fleck 插桩与 ARM 求值顺序修复；记录来源提交 fleck `eee15cc8`／oracle 补丁 `30c97cb1`）。
- 先本机编 host 工具（makedefs/lev_comp/dgn_comp 等生成器），再 emcc 编游戏本体；窗口层先用最小桩（winprocs 挂空实现＋nhgetch 喂固定键）求链接通过、在 Node 里跑到第一个读键点。
- **门**：产出 .wasm＋.js、Node 加载启动成功、能到达读键。过门才继续 S2；构建若卡死超过 2 天无进展，回报主线重估（回退口径见「风险与回退」）。

### S2 窗口层 shim
- 新写 winprocs 实现（约 50 个入口、实作约一半），输出**结构化状态**给 JS：地图网格（字符＋颜色）、状态行字段、消息、菜单/物品列表、提问类型；不做终端转义解析。
- 交付形态：JS 回调/共享结构，前端（S5）与无头验真（S4/S6）共用同一份输出契约（契约写进 `docs/window-contract.md`）。

### S3 异步输入＋插桩改造
- 阻塞读键改异步：Emscripten **ASYNCIFY** 挂起等键，白名单只圈 nhgetch 及其调用链；键由 JS 队列供给。
- 插桩改造：种子/钉死日期/角色参数由 JS 注入（代 env）；帧导出与随机数审计改走 JS 回调推流；存档落 MEMFS 并可导出 blob（供 S5 同步）。
- **门**：Node 无头喂 G1 按键流（seed 42＋smoke-01）能跑完一局不挂死。

### S4 护照（与原生 oracle 逐字节对账）
- Node 无头重放 G1（seed 42＋smoke-01）、G2（seed 37＋slice-17），frames 与 rnglog 与金标逐字节比对（金标在主线 `verify-fleck/r0-golden/`：G1 93 帧、G2 4328 帧）。
- 种子 1–50 对扫：同一批短按键流下 wasm 版与原生 oracle 帧/审计逐字节一致率。
- **门**：全等才算过。出现平台差异（wasm32 的 long 位宽、求值顺序、浮点等）按 ARM 线的方法定根因、逐项登记；**不许改判据、不许改金标**。护照不过，S5/S6 不开工。

### S5 前端（Firebase Hosting 就绪的静态站）
- 网格渲染（等宽字符网格、颜色）、物理键盘全键位直通。
- 移动端基础版：响应式布局＋上下文操作栏四态（主命令/方向/物品选择/是非，规格 §4.2）＋全部命令面板兜底；点按一律翻译成原按键序列。
- 录制：以回合数为索引的交错事件流（本回合键＋回合末帧哈希），前端攒流分块上传（先对本地后端桩，S6 换 Firestore/Storage）；存档导出/导入走通跨设备续玩。
- **门**：桌面与手机浏览器各完整打一局（含 --More--、菜单、方向提问、文本输入），录制流完整。

### S6 Firebase 接线＋Cloud Run 验真 worker
- **前置（用户动手）**：用户在其 Google 账号下建 Cloud/Firebase 项目并开通 Blaze＋预算告警；主线届时给逐步清单。此前本步只做可部署物与本地桩联调，不挡 S1–S5。
- 接线：Hosting 部署、Auth（Google 登录）、Firestore（账号/榜单/元数据，按局终汇总写入）、Storage（按键流/存档/归档包）。
- 验真 worker：容器化 Node＋同一 wasm 产物，Cloud Run 部署；收到归档包后无头重放、逐回合比帧哈希、回写验真结论与轨迹库索引/标签。

## M0 关期验收（主线执行）
规格 §10 M0 六条逐条核：真人局（内测者）→ 按键流完整落盘与自动归档 → 验真 worker 自动回放逐字节通过 → 入轨迹库索引且标签正确 → fleck 侧取该局完成一次差分消费 → 移动端基础版＋跨设备续玩走通。

## 用户待办（仅两件，均不挡 S1–S5）
1. S6 前：建 Google Cloud/Firebase 项目（主线给清单，约十分钟点击）。
2. M1 前：airstring.org 的 DNS 指向（注册商在用户手里）。

## 风险与回退
- ASYNCIFY 圈定失败 → 备选 Worker＋Atomics.wait（需 COOP/COEP 头，Firebase Hosting 可配），工期 +数天。
- S4 护照出现成片平台差异且两周内收敛不了 → 回报用户，重议 §6.1 过渡形态（服务端模式），已写的窗口层/录制/前端大部分可平移。
- Firebase 免费额度口径以落地时官方价格页复核为准（规格 §11 U-1 附记 3）。
