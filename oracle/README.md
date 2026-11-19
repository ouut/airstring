# oracle/ — NetHack 3.6.7 插桩版源码（NGPL）

基线：fleck 仓 `oracle/` 子树（来源提交 fleck `eee15cc8`，含 ARM 求值顺序修复 `30c97cb1` 与 fleck 帧导出/随机数审计插桩），2026-11-19 随 S1 整树复制入仓。

WASM 构建（仓根目录执行）：`./build-wasm.sh`（Emscripten 6.0.13，emsdk 在构建机 `~/workspace/tools/emsdk`；相位纪律见脚本头注释）。S1 尖峰报告见 `docs/s1-report.md`：产物 nethack.wasm 3,881,490 B，Node 加载运行到达读键、帧 0 与原生 G1 金标逐字节一致。

WASM 侧改动（相对 fleck 基线）：`sys/unix/hints/linux-wasm-s1`（单 hints 贯穿宿主工具与游戏）、`win/winstub.c` 桩窗口层、`include/global.h` 的 `version_uint` 位宽 typedef（CROSS_TO_WASM 时 32 位）等，明细见 S1 报告。注意：wasm 侧生成表（pm.h/onames.h）必须与原生构建 diff 为空（NOMAIL 教训，见报告）。
