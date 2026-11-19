# airstring M0 · S1 构建尖峰报告

日期：2026-11-19
施工方：S1 尖峰子代理
工作目录：`~/workspace/airstring-work/s1/`（构建源 `oracle-src/` 为 fleck 仓 `oracle/` 子树的整树副本；fleck 仓本体未动、未 push 任何仓）

## 结论：S1 门 ✅ 通过

门定义：产出.wasm＋.js、Node 加载启动成功、能到达读键点。三项全过，且远超门线：

- `out/nethack.wasm` **3,881,490 B**（sha256 前缀 `c6b105c89a3528f9…`）＋ `out/nethack.js` **178,795 B**，由 `build-wasm-s1.sh` 一条命令端到端构建（实测 exit=0，日志 `build-script-run1.log`）。
- Node（v24.22.1）加载运行：游戏完成启动、进入主循环，桩窗口层 `nhgetch` 被调用 **41 次**（40 个脚本键被逐个消费为真实命令/回合，含 32 个 `.` 等待回合），脚本耗尽后按 fleck 回放 EOF 语义干净退出（status 0），控制权回到 harness（日志 `node-run6.log`）。
- fleck 插桩在 WASM 下完整工作：`FLECK_EXPORT` 导出帧文件 168,121 B / 3055 行、`FLECK_RNGLOG` 导出审计 57,859 B / 3228 行，均经 harness 从 MEMFS 读回落盘（`wasm-fleck.frames` / `wasm-fleck.rng`）。

**S4 预演信号（强）**：seed 42、同角色钉法下——

- **帧 0 与原生 G1 金标逐字节一致**（首分歧在第 99 行＝帧 1 的 `hunger`：金标 1059 vs 本跑 899；原因是按键流不同——smoke-01 开局吃东西、桩脚本只是等待——不是平台差异）。
- **rnglog 前 2536 行与金标逐字节一致**，第 2537 行首分歧（见「阻塞清单」第 1 条，未裁定）。

## 环境与版本

| 项 | 值 |
|---|---|
| Emscripten SDK | **6.0.13**（`~/workspace/tools/emsdk`，emsdk 激活版；emcc 6.0.13, git e13ee988ce3d87a738dd8f3661d02223308c412a），自带 Node 24.19.0 |
| harness Node | 系统 Node v24.22.1 |
| 宿主 | x86_64 Linux，gcc/make/bison/flex/libncurses-dev 齐备（原生构建前置） |
| 源码基线 | fleck 仓 `oracle/`（NetHack 3.6.7＋fleck 插桩＋ARM 求值顺序修复），整树复制为 `oracle-src/` |

## 原生构建结论（树完好性）

按 fleck 仓 `docs/build-oracle.md` 配方（`setup.sh sys/unix/hints/linux` → 串行 `make all/install`）：

- 先到的「3 秒构建成功」是假象（复制时带入了 fleck 树的 128 个旧.o）；`make clean` 后**真干净重编 exit=0，耗时 1m24s**，产物 nethack 9,142,144 B、nhdat 1,384,991 B。
- 冒烟验真：以 seed 42＋smoke-01 回放经 pty 驱动跑本副本的原生构建，导出 **frames sha256 `09c48b071a835162…`、rnglog `845c33acf932072…`（6850 行）与主线金标 `verify-fleck/r0-golden/` 逐字节吻合**（`native-smoke.frames/.rng`）。树是好的，插桩口径无误。

## 参照件（NGPL 注明）

- `npm pack @neth4ck/wasm-367`（v2.1.2，`ref/package/`）：只含产物（nethack.wasm 4,920,739 B＋胶水 JS），无构建脚本。
- 浅克隆其源码仓只读参照（`ref/monorepo/`、`ref/nh-fork/` = apowers313/neth4ck-monorepo 与 apowers313/NetHack 的 wasm-3.6.7 分支，均为 NGPL）。
- **借鉴的是架构与机制，未复制代码**：单 hints 文件贯穿 host 工具与游戏（保证 -D 一致）、shim 式窗口层、数据文件 32 位格式 typedef 解法、makedefs 的 window_opts 需登记新窗口系统、src/Makefile 的 no-op 规则防 emcc 重建 host 工具。本尖峰的 hints、winstub.c、源码补丁均为针对本树的自研实现。

## 对 oracle-src 副本的全部改动（补丁面）

| 文件 | 改动 |
|---|---|
| `include/global.h` | 新增 `version_uint` typedef：`CROSS_TO_WASM` 时为 `unsigned int`，否则 `unsigned long`；`version_info`/`savefile_info` 两结构体改用之（LP64 宿主工具写、wasm32 游戏读的二进制数据文件头必须等宽） |
| `include/config.h` | COMPRESS 默认值条件加 `&&!defined(STUB_GRAPHICS)`（wasm 下无外部压缩程序，存档走未压缩路径） |
| `src/windows.c` | `STUB_GRAPHICS` 下登记 `stub_procs`（extern＋winchoices 一行） |
| `util/makedefs.c` | window_opts 表加 `stub` 条目（makedefs 的 windowing_sanity 要求 DEFAULT_WINDOW_SYS 在已知窗口系统表内） |
| `win/stub/winstub.c` | **新文件**：自研最小桩窗口层（419 行），全部 winprocs 入口齐备；输出类为空实现（消息窗口 putstr 与 raw_print 转 stderr 留痕）；`display_nhwindow(blocking)` 按真实端口语义消费一个键（--More-- 机制）；`nhgetch`/`nh_poskey` 走同一喂键器：喂固定脚本（空格×8＋`.`×32）、逐键打计数标记、耗尽后 `exit(0)` |
| `sys/unix/hints/linux-wasm-s1` | **新文件**：CC/LINK=emcc/emar；CFLAGS 含 `-DDLB -DNO_SIGNAL -DSYSCF -DSYSCF_FILE=\"/sysconf\" -DSECURE -DHACKDIR=\"/\" -DNOTTYGRAPHICS -DSTUB_GRAPHICS -DDEFAULT_WINDOW_SYS=\"stub\" -DCROSS_TO_WASM -std=gnu17`；LFLAGS 含 MODULARIZE＋EXPORT_ES6、EXIT_RUNTIME=0、ALLOW_MEMORY_GROWTH、STACK_SIZE=1MB、`--embed-file../wasm-data@/`、`--pre-js../../pre-spike.js`；POST 段 GAME=nethack.js＋winstub.o 规则。SYSSRC 保持 pristine 默认（ioctl/unixtty/unixmain/unixunix/unixres——砍掉 unixtty 会缺 intron/introff/dosuspend/控制台符号，实测） |
| `pre-spike.js`（s1/ 下） | 构建期 --pre-js：注册 preRun 回调注入 FLECK_SEED=42、FLECK_DATE=1700000000、FLECK_EXPORT/RNGLOG 路径、NETHACKOPTIONS（name:s1spike,role:valkyrie,race:human,gender:female,align:neutral）、MAIL=/no-mail-spool |
| `src/Makefile.wasm-noop` | 构建期生成：host 工具与生成头的 no-op 规则，仅在 emcc 相临时挂进 src/Makefile（脚本管理挂载/卸载） |

## 构建流程（build-wasm-s1.sh，相位纪律是血的教训）

1. **Phase 0**：`make clean`＋清 src/util 的.o（两种编译器的.o 绝不可混：makedefs 链接 `../src/monst.o/objects.o`，混入 wasm.o 直接 `file format not recognized`）。
2. **Setup**：`setup.sh sys/unix/hints/linux-wasm-s1`——全树只用这一份 hints。
3. **Phase 1a**：原生 `makedefs` 先行，随即用 src/Makefile 自带规则**显式再生全部生成头**（onames.h/pm.h/date.h/vis_tab.h/vis_tab.c）——必须在 lev_comp（靠 pm.h 解析怪物名）、dgn_comp（靠 date.h 盖 version_info）之前。
4. **Phase 1b**：原生 lev_comp/dgn_comp/dlb → `make -C dat`（clean 后重造）→ `make check-dlb`（连带原生编一遍游戏生成 dat/options 并打包 nhdat；nhdat 终值 1,384,793 B）。校验点：生成的 **pm.h、onames.h 与 fleck 原生构建逐字一致**（实测 diff 为空）。
5. **Phase 2**：组 wasm-data/（nhdat、sysconf、symbols、license＋空 perm/record/logfile/xlogfile＋save/），链接时整目录嵌入 MEMFS 根。
6. **Phase 3**：清 src/*.o、挂 no-op 规则、`make -C src`（emcc），产出后卸 no-op。

构建中实测踩过并已解的坑（按出现顺序）：

- makedefs `Configuration error: no windowing systems enabled` → window_opts 表登记 stub（见补丁面）。
- 链接缺 `check_linux_console/init_linux_cons/linux_mapon/off/dosuspend/intron/introff` → SYSSRC 恢复 pristine 默认集（含 unixtty.c/ioctl.c）。
- 链接缺 `genl_outrip` → rip.c 仅在 TTY/X11/…/DUMPLOG 任一定义时才生成 TEXT_TOMBSTONE 版 genl_outrip；桩端口自带 `stub_outrip` 空实现（参照件的 shim 端口同法）。
- `-DNOMAIL` 曾使 PM_MAIL_DAEMON 被 monst.c 排除、311 号后怪物编号全体 −1（帧 `form=340≠341` 当场照出）→ **去掉 NOMAIL**。教训：任何改变生成表的 -D 都是护照级事故，wasm 侧 flag 集必须以原生 oracle 的生成表（pm.h/onames.h diff 为空）为准绳。
- dungeon 版本校验失败（`Configuration incompatibility for file "dungeon"`）→ 陈旧 version.o 把旧 date.h 的 SANITY1（0x211c517d）写进 dungeon、游戏期望新值 0x211c617e；相位纪律（1a 先再生头）根除。注：本跑 SANITY1 与 fleck 原生值相同（0x211c617e，实体哈希与平台无关）；SANITY2 不同（0x48c24958 vs 原生 0x148c24958，源于 CROSS_TO_WASM 改变 version_info 的 sizeof 哈希输入）——文件与游戏同源 date.h、自洽，但**wasm 构建的数据/存档文件与原生 oracle 不可互换**（预期内，S4 比的是文本帧/审计，不受影响）。
- `main → getmailstatus → strlen` 空指针崩溃（带符号调试构建定位）→ mail.c:112 对 `getpwuid()->pw_name` 不判空，而 Emscripten 的 getpwuid() 返回 NULL；注入 `MAIL` 环境变量走第一分支绕过，未改源码。

## Node 运行证据（node-run6.log）

```
[stub] init_nhwindows / create_nhwindow x4 / player_selection
[stub] raw: Velkommen s1spike, welcome to NetHack! You are a neutral human Valkyrie.
[stub] nhgetch #1..#41（空格被报 Unknown command、'.' 逐个成回合）
[harness] run ended: main-returned（exit 0 干净退出）
[harness] /fleck.frames: 168121 bytes, 3055 lines
[harness] /fleck.rng: 57859 bytes, 3228 lines
```

角色四项（name/race/gender/align）与种子钉法全部生效。

## 阻塞清单（按严重度）

1. **rnglog 第 2537 行分歧未裁定**：金标 `2537 rn2 9 -1 2` vs wasm `2537 rn2 5 -1 0`（参数与结果都不同＝调用点/参数来源不同）。前 2536 行逐字节一致（含全部建角与第一层生成）。头号嫌疑是按键流不同（smoke-01 是真实命令流、本跑是空格＋等待，帧 1 的 hunger 分歧已证两流从第 1 回合起玩法不同）；但也不能排除某处参数依赖平台（如以 long/sizeof 推导的界值）。**裁定方法**：S3 把 FLECK_REPLAY 重新挂进 shim 的 nhgetch 后，用同一 smoke-01 回放喂 wasm 构建逐行比——那时若仍在 2537 分歧即为真平台差异，按 ARM 线方法定根因。
2. **回放钩子不在本构建里**：FLECK_REPLAY 钩在 `win/tty/wintty.c:tty_nhgetch`，tty 端口不参与 wasm 构建，回放完全失效（本跑靠桩的内置脚本喂键）。且桩的 `getlin/yn_function/select_menu` 不消费键流（getlin 恒回 "s1spike"、yn 恒回默认、菜单恒回 0 选）——tty 端口是把全部输入收敛到 nhgetch 一个漏斗的，回放才逐字节成立。S3 的 shim 必须照此收敛（yn/getlin/菜单/poskey 全走 nhgetch 漏斗），并把 fleck 的回放读取点搬进 shim_nhgetch。
3. **环境注入机制**：Emscripten 6.0.13 **不读 process.env**，且工厂传入的 `Module.ENV` 会被运行时以自身空对象覆盖（生成 JS 第 4580 行 `Module['ENV'] = ENV`）；`noInitialRun`＋事后改 ENV 也来不及（environ 在 init 阶段已物化，探针实测）。唯一实测可行的注入点是 **preRun 回调**（--pre-js 注册，运行时 ENV 对象已存在、main 未跑）。产品侧照此：页面在加载模块前备好配置，pre-js 把 seed/日期/角色/导出目标写进 ENV。探针在 `probe/`（envprobe.c/run-probe*.mjs）可复跑。
4. **getpwuid() = NULL 的雷区**：mail.c 已绕；其余 getpwuid/getlogin 调用点（如 files.c、options.c 的用户名路径）建议 S2 开工时全仓扫一遍逐个定性，能 env 绕的 env 绕、不能的再议源码补丁（补丁要记入与 fleck oracle 的源码差分台账）。
5. **启动期一条 pager 异常**：`com_pager: message 1 not found.`＋`Program in disorder!`（原生 transcript 无此现象），随后问候语与游戏流程正常。疑似 quest 文本（quest.dat 在 nhdat 内）的 pager 查找路径在 MEMFS/DLB 下有差，或 display_file 类调用被桩空实现吞掉所致。S2 做结构化输出时顺路定位。
6. **构建脆弱性**：上述相位纪律全靠 build-wasm-s1.sh 维持；换人/换机复跑请直接用脚本，不要手工分步（手工交错相位在本尖峰里造成了 3 次假失败）。脚本已实测一遍全通。

## 对 S2/S3 的具体建议

- **S2（窗口层 shim）**：以 winstub.c 为骨架扩写即可——winprocs 收敛、注册、构建链都已通。结构化输出建议走「C 侧回调 JS 函数」路线（参照件 shim 的 local_callback 模式）：S2 开工先定 `docs/window-contract.md` 的事件契约，nhgetch/poskey/yn/getlin/菜单五类输入事件全部经同一回调漏斗返回键码，与第 2 条的回放收敛天然合流。print_glyph 是地图数据的主通道（本跑为空实现，帧导出不受影响是因为 fleck 导出读的是游戏内部状态、不是窗口层——S4 的帧比对不依赖 shim 输出，这一点已实证）。
- **S3（异步＋插桩改造）**：① 输入漏斗收敛后，把 fleck.c 的回放读取（现 `fleck_replay_getch` 经 wintty 调用）改挂 shim_nhgetch，env 注入沿用 preRun 模式（本尖峰已验）；② ASYNCIFY 白名单预计只需圈 nhgetch 漏斗及其 JS 回调，桩跑通的同步喂键可先平移到「JS 队列同步取键」做中间验收，再上真异步；③ 存档：COMPRESS 已摘（存档未压缩），MEMFS 存档导出 blob 的路径通畅；④ 顺手把 getpwuid 审计（第 4 条）做掉。
- **S4 预告**：帧 0 已逐字节命中金标、rnglog 命中 2536 行——护照的起点比预期高。第 1 条分歧点（rnglog:2537）就是 S4 的第一个案子，案情与裁定方法已记录在案。

## 交付物清单（~/workspace/airstring-work/s1/）

- `REPORT.md`（本文件）
- `build-wasm-s1.sh`（一键构建，实测 exit=0）
- `out/nethack.wasm`（3,881,490 B）、`out/nethack.js`（178,795 B）
- `run-node.mjs`（Node 驾驶＋MEMFS 导出读回）、`pre-spike.js`（env 注入）
- `node-run6.log`（最终运行日志）、`wasm-fleck.frames`、`wasm-fleck.rng`（插桩导出实物）
- `native-smoke.frames/.rng/.transcript`（原生副本冒烟，与金标逐字节一致）
- `oracle-src/`（构建源副本，含全部补丁；树内 `src/nethack.js/.wasm` 为同一产物）
- `dbg/`（带符号＋断言的调试构建，定位 getmailstatus 崩溃用）
- `probe/`（env 注入机制探针）、`ref/`（参照件，只读）
- 各阶段日志：`native-*.log`、`wasm-*.log`、`build-script-run1.log`
