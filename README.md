# airstring

**airstring.org** — 带种子记录、可逐回合验真的 web 版 NetHack。

- 游戏内核：NetHack 3.6.7 插桩版（fleck 项目的 oracle），编译为 **WASM** 在浏览器内运行。
- 全站对局锁定种子与固定日期、关 bones：每一局都只凭「种子＋按键流」即可在服务端以同一 wasm 产物无头重放、逐回合比对帧哈希验真。
- 托管：Google Firebase 全家桶（Hosting / Auth / Firestore / Storage / Cloud Run 验真），预期月费 $0。
- 用途：为 fleck（NetHack 3.6.7 的 Flecs/Rust 移植）收集真人轨迹——通关局、13 职业 Quest 局与长尾场景局。

规格与计划见 `docs/`：

- `docs/airstring-spec.md` — 产品规格（v0.7）
- `docs/m0-plan.md` — M0 内测施工计划（S1 构建尖峰 → S6 Firebase 接线）

## 许可

- `oracle/` 子树是 NetHack 3.6.7 的衍生源码（fleck 插桩版），依 **NetHack General Public License (NGPL)** 提供，见该目录内许可证文件。
- 本仓其余代码（前端、验真器、工具）为项目自有代码，随仓提供。

## 状态

M0 内测开发中（2026-11-19 开工）。
