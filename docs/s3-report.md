# airstring M0 · S3 施工报告

日期：2026-11-19。施工方：主线子代理（S3）。基线：仓 HEAD `32dc9807`
（tree `ab52d8d7`，S2 成果）。工作区：`~/workspace/airstring-work/s3/`。
构建：`./build-wasm.sh` 一条命令，emsdk 钉版 6.0.13，exit 0；
产物 `out/nethack.wasm` 8,285,406 B、`out/nethack.js` 204,723 B
（S2 为 3.91 MB——ASYNCIFY 全程序插桩的体积成本，约 2.1×，属预期）。

**结论：S3 全部硬门通过。** G1 三种喂法（replay / queue / async）
与 G2 两种喂法（replay / async）均与金标逐字节一致；S2 harness 的
replay 回归不破；原生（不定义 CROSS_TO_WASM）构建同树复跑 G1/G2
逐字节一致，定宽批红线成立；存档落 MEMFS 并可经 JS 导出 blob。

---

## 一、S3 本体

### 1. ASYNCIFY 异步等键

- `oracle/win/stub/winstub.c`：同步键桥换为
  `EM_ASYNC_JS(int, shim_js_next_key_async, ...)`，await 宿主
  `globalThis.__airstring_take_key_async()`。队列空时 Promise 挂起、
  wasm 栈展开等待——是等待而不是 EOF；宿主关输入后 resolve -1，
  沿 S2 的 EOF 语义干净 exit 0。
- 构建参数（`oracle/sys/unix/hints/linux-wasm-s1`，逐项登记）：
  - `LFLAGS+=-s ASYNCIFY=1`
  - `LFLAGS+=-s ASYNCIFY_IMPORTS='["shim_js_next_key_async"]'`
    ——**白名单仅此一项**（桥函数符号名即导入名）。
  - `LFLAGS+=-s ASYNCIFY_STACK_SIZE=65536`
  - pre-js 改指 `../../tools/pre-s3.js`。
- 完成语义（实测定的根因，契约已登记）：ASYNCIFY 下模块工厂
  Promise 在**第一次栈展开时即 resolve**，且 keep-alive 运行时下
  `exit()` 不触发 `onExit`、EOF 路径不经 `exit_nhwindows`。故
  winstub 新增 `EM_JS shim_js_game_over`＋`shim_signal_game_over()`，
  在 EOF 路径与 `shim_exit_nhwindows` 两处各触发一次（静态标志保证
  只发一次），宿主以 `__airstring_game_over(status)` 为完成信号；
  replay 模式从不调异步导入，工厂 Promise 保持 S2 语义仍权威。
  **注意：S2 harness 的 queue 模式在 S3 构建下会踩同一陷阱**
  （它以工厂 Promise 为完成信号）——门只要求其 replay 模式回归，
  已过；S5 前端接线时勿沿用 S2 harness 的 queue 完成口径。

### 2. JS 注入参数

沿用 S2 的 preRun/ENV 口径不变（`tools/pre-s3.js` 为 pre-s2 超集）：
FLECK_SEED / FLECK_DATE / NETHACKOPTIONS / FLECK_EXPORT /
FLECK_RNGLOG 在 preRun 注入 ENV，MEMFS 目录骨架（games/lib/
nethackdir、save/）同 S2。

### 3. 帧 / rnglog 推流

- `oracle/src/fleck.c`（`#ifdef __EMSCRIPTEN__` 门控，原生为空操作）：
  新增 EM_JS 回调 `fleck_js_frame(buf,len)` / `fleck_js_rngline(line)`，
  分别调宿主 `globalThis.__airstring_frame` / `__airstring_rngline`。
  帧在 fwrite+fflush 后整帧推送；rnglog 改为 snprintf 成行后
  fputs＋推流（**文件字节不变**，金标逐字节一致为证）。MEMFS 文件
  仍写、仍是权威记录；harness 每跑校验推流副本与 MEMFS 逐字节
  一致（全部门跑均 identical-to-memfs: true）。

### 4. 存档导出

pre-s3.js 提供 `__airstring_list_saves()`（readdir `/save`，滤
`.keep`）与 `__airstring_read_save(name)`（返回 Uint8Array 供转
Blob）。实测：自造按键流（3 空格＋S＋y…）在 async 模式下完成
存档退出，`/save/0fleck` 生成并导出——38,096 B，
sha256 `cabea4c2f3f47915cd734a57f0008563187757547227b5ef2190d8d208551e9f`
（存档在 `runs/save-export/0fleck`）。存档只需 wasm 内部自洽，
不在跨构建字节口径内。

### 5. JS 侧文件

- `tools/pre-s3.js`（新）：pre-s2 超集＋异步键队列 API
  （`__airstring_push_keys/__airstring_close_keys/
  __airstring_take_key_async`，等待者 Promise＋挂起计数
  `__airstring_key_waits`；无 `closed` 字段的预置队列按 S2 固定
  脚本处理、耗尽即 EOF）＋推流默认收集器＋存档接口；同步
  `__airstring_next_key` 保留兼容。
- `tools/run-node-s3.mjs`（新）：replay/queue/async 三模式 harness；
  async 分块推键（--chunk/--delay/--initial-delay）；推流与 MEMFS
  自检并打印 sha；--saves 导出存档。（一处 harness 竞态已修：
  feeder 须等 preRun 装好 push API 再推键。）

## 二、数据格式定宽修复批（全部 `#ifdef CROSS_TO_WASM` 门控）

仿 S1 `version_uint` 先例：磁盘类型在 wasm 下为 32 位、原生保持
`long`，内存类型不变，只在读写边界转换。

### quest.dat（LP64 写 / ILP32 读错位）

- `oracle/include/qtext.h`：新增 `qt_disk_long` typedef；
  `struct qtmsg` 的 `offset`、`struct qthdr` 的 `size` 改用之。
- `oracle/util/makedefs.c`：`adjust_qt_hdrs` 的 hdr_offset 计算与
  `put_qt_hdrs` 的 fwrite 改用 `sizeof(qt_disk_long)`。
- `oracle/src/questpgr.c`：`qt_offsets[]` 改 `qt_disk_long`，
  Fread 改 `sizeof(qt_disk_long)`。
- 证据：wasm 构建的 quest.dat 由 119,478 B 变为 **110,506 B**；
  按 32 位布局解析完全自洽（14 类、首类 55 条消息编号
  1,2,3,5,6…、类偏移 102/1206/2290/3374）；G1 事件流中
  「com_pager: message 1 not found」计数为 0（S2 的错误消失）；
  原生构建同树生成的 quest.dat 仍为 119,478 B（门控双向生效）。

### .lev 格式（同族字段全量排查登记）

磁盘字段逐项核查（`sp_lev.c` 读 / `lev_main.c` 写）：

| 字段 | 磁盘类型（原生） | 结论 |
|---|---|---|
| version_info | S1 已钉 `version_uint` | ✓ 不动 |
| n_opcodes | `long` | **已修** |
| _opcode.opcode | `int` | ✓ |
| spovartyp | `xchar` | ✓ |
| vardata.l（LEV_ROOM/LEV_STAIR/… 的 long 变体） | `long` | **已修** |
| 字符串长度前缀（sp_lev str 版本） | 读写均 `int` | ✓ |

- `oracle/include/sp_lev.h`：新增 `sp_disk_long`/`sp_disk_ulong`
  typedef＋登记注释。
- `oracle/src/sp_lev.c`：`sp_level_loader` 对 n_opcodes 与
  vardata.l 经磁盘类型临时变量边界转换（内存仍 `long`）。
- `oracle/util/lev_main.c`：`write_maze` 同两处边界转换。
- 附带排查：`dungeon.dat` 磁盘结构只有 char/short/int 字段、
  两 ABI 布局一致，干净，不动。
- 证据：G2 全程通过（见下）——S2 时 G2 在第 286 帧后因 .lev
  错位崩塌，本批后 4328 帧全程逐字节一致。

## 三、G2 途中第三个平台差异：qsort 并列次序（根因＋修复）

定宽批后 G2 推进到帧 441（Dlvl 10）再分歧：rng 第 30164 号抽数
金标 `rn2(6)`、wasm `rn2(5)`。逐层 bracket（帧↔抽数对齐→
mklev 阶段标记→房间数组转储，诊断插桩已全部还原、树 diff 为证）
钉死根因：

- `mklev.c` 的 `sort_rooms()` 比较器 `do_comp()` **只比 lx**，
  并列房间的次序由 libc qsort 实现决定。金标产自 glibc（qsort
  走稳定合并排序路径）；musl 的 qsort 不稳定。Dlvl 10 有两个
  lx=4 的房间（pre[4] hx=8、pre[7] hx=9），musl 把这对并列元素
  交换了次序，上楼梯选房（rooms[rn2(7)=1]）因此选到另一个
  房间：somex 模数 5 对金标 6，与实测分歧逐项吻合。
- 隔离实验：去掉 ASYNCIFY 的构建分歧一字不变——ASYNCIFY 无罪。
- 修复（只在 wasm 侧、共享源码零改动）：`oracle/win/stub/
  winstub.c`（原生构建不编译此文件）提供**稳定合并排序版
  `qsort`** 覆盖整个 wasm 构建，复刻 glibc msort 语义；全序
  比较器不受影响。修复后 G2 全程逐字节通过。

登记（供 S4 审计）：全仓 qsort 调用点共 7 处（mklev sort_rooms、
invent sortloot、end vanqsort、files strcmp_wrap、spell
spell_cmp、do_name cmp_coord_distu、fleck 导出四表）——wasm 侧
现已统一稳定语义；原生侧维持 glibc 原样。

## 四、门证据（最终构建，2026-11-19 18:4x–18:5x）

金标：`~/workspace/verify-fleck/r0-golden/`（未动）。

| 门 | 模式 | 结果 |
|---|---|---|
| G1（seed 42＋smoke-01，93 帧） | replay | frames 475,696 B sha `09c48b071a…`、rng 6,850 行 sha `845c33ac…`，cmp 全等 |
| G1 | queue | game-over-0、键位 97/97、cmp 全等 |
| G1 | async（chunk 8 / delay 5ms / initial-delay 150ms） | game-over-0、**挂起等待 14 次**、cmp 全等、推流＝MEMFS |
| G1 回归 | **S2 harness** replay | cmp 全等 |
| G2（seed 37＋slice-17） | replay | frames 25,586,024 B（4328 帧）sha `53e5154f…`、rng 205,683 行 sha `1dda3070…`，cmp 全等 |
| G2 | async（chunk 8192） | game-over-0、挂起 4 次、cmp 全等 |
| 原生红线 | 同树原生构建（hints/linux，无 CROSS_TO_WASM） | G1、G2 均与金标逐字节一致 |
| 存档 | async＋--saves | `/save/0fleck` 38,096 B 导出成功（sha 见上） |
| 构建 | `./build-wasm.sh` | exit 0 |

运行产物在工作区 `runs/`（g1f-*、g2-final、g2-async、save-export/）；
原生复核在 `~/workspace/airstring-work/s3-native/`（构建日志＋
g1-native/g2-native 产物）。

## 五、改动文件集（仓内相对路径，树 diff 自证）

修改（9）：
- `oracle/include/qtext.h`、`oracle/include/sp_lev.h`
- `oracle/src/questpgr.c`、`oracle/src/sp_lev.c`、
  `oracle/src/fleck.c`
- `oracle/util/makedefs.c`、`oracle/util/lev_main.c`
- `oracle/win/stub/winstub.c`
- `oracle/sys/unix/hints/linux-wasm-s1`

新增（2）：`tools/pre-s3.js`、`tools/run-node-s3.mjs`

文档（1）：`docs/window-contract.md` 追加 S3 附记（传输/推流/
存档三节，Input 节以附记为准）。

构建产物（非源码、由新工具链再生，仓内原为旧构建产物）：
`oracle/dat/quest.dat`（110,506 B）、`oracle/dat/*.lev` 共 120 个
（lev_comp 定宽后重编）、`oracle/include/date.h` 与各级 Makefile
（setup 生成）。入仓时建议连同产物一并更新，或在 S4 构建流程里
明确「产物不入仓、构建再生」——请主线裁定。

诊断还原自证：诊断期临时改动（fleck.c 帧↔序号打印与
fleck_diag_seq、mklev.c 阶段标记与房间转储、nethack.js 打桩）
已全部还原/重编，最终树 `grep DIAG-TEMP` 为 0，树 diff 只含
上述文件。

环境插曲（一句）：施工中途本 VM rootfs 重建、一度缺 curses.h
致原生 check-dlb 阶段失败，系统 apt 恢复进程补回后正常，与
源码无关。
