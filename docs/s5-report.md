# S5 报告：静态前端＋移动端基础版＋录制/存档

基线：仓 HEAD `52e48925`（S4 护照已过），构建产物
`out/nethack.js`＋`out/nethack.wasm`（8,169,787 B，沿用 S4 干净
构建，未重编）。**结论：门全过**——桌面（1280×800）与手机
（390×844）两视口各完整打完一局，五类交互全覆盖，录制流帧
哈希链与无头重放**全链逐帧一致**，存档导出→导入→同局续玩
往返成立。oracle 源码零改动，`tools/pre-s3.js` 零改动（存档
导入用的是工厂参数对象的 `preRun` 属性这一宿主侧机制，见
§6）。

## 1. 交付文件清单（工作区内、仓内相对路径）

| 文件 | 行数 | 内容 |
|---|---|---|
| `web/index.html` | 121 | 开局页（种子指定/随机、名字与职业/种族/性别/阵营联动、存档导入、口径明示）＋游戏页（种子横幅、消息区、21×80 网格、状态行、菜单/文本 overlay、行输入条、上下文操作栏、全部命令面板、消息历史、存档工具区、局终区） |
| `web/airstring.css` | 127 | 深色主题、NH 16 色、响应式布局、≥44px 触控目标、操作栏 sticky、方向盘网格 |
| `web/airstring.js` | 958 | 主逻辑：会话状态机、事件渲染、键盘直通、操作栏、命令面板、地图点按、录制器（分块上传）、存档导出/导入、局终处理 |
| `web/commands.js` | 120 | 3.6.7 命令表（约 70 条：键序字节串＋是否需方向）＋方向键表；按站点口径不含 #wish/#levelport/#teleport/'X' |
| `docs/recording-format.md` | 40 | 录制流格式定版（header/turn/tail/end 四类记录、哈希链口径、分块上传协议），供 S6 |
| `tools/recording-stub.mjs` | 104 | 本地后端桩：静态服务（`web/` 于 `/`，`/nethack.js`、`/nethack.wasm` 映射 `out/`）＋`POST /upload` 逐条 append 落盘 `recordings/<gameId>.jsonl`＋`GET /recordings[/<id>.jsonl]` |
| `tools/drive-s5.mjs` | 441 | 门驱动（Playwright）：双视口全流程＋录制对账＋存档往返，断言汇总写 `evidence/drive-summary.json` |

非交付脚手架（留工作区、不入仓）：`tools/package.json`、
`tools/node_modules/`（Playwright 依赖）、`evidence/`、
`recordings/`（运行产物）。`tools/run-node-s3.mjs` 是仓内同名
文件的逐字节相同副本（驱动对账时按其相对路径解析
`../out/`），仓内已有、无变更。

## 2. 一条龙命令

```sh
# 构建（如需重编；本期沿用 S4 产物）
./build-wasm.sh                      # 产出 out/nethack.js + out/nethack.wasm

# 起服务（静态 + 录制接收桩，端口 8377）
node tools/recording-stub.mjs --port 8377
# 浏览器打开 http://127.0.0.1:8377/ 即可游玩

# 跑门（双视口全流程；可加 --only desktop / --only mobile）
cd tools && npm install playwright-core playwright  # 首次
node drive-s5.mjs                    # 期望末行 DRIVE ALL PASS
```

## 3. 门结果：双视口各完整一局（seed 42 / Valkyrie）

驱动流程：开局（介绍文本窗→三次 --More--）→ `e` 吃（物品
提示）→ `i` 背包菜单 → `o` 开门方向提问（方向盘答）→ 命令
面板点按发键 → `#quit` 行输入 → Really quit? yn → 局终四问
答 n → `__airstring_game_over(0)`。两视口断言全 PASS，五类
交互计数（两视口相同）：

| 交互 | 证据 |
|---|---|
| --More-- | more=7（开局 3 次＋局内 4 次），空格/点按均可消 |
| 菜单选择 | menu=1（`i` 背包，5 个可选类目项渲染为按钮，点按发字母键）；截图 `evidence/{desktop,mobile}-menu.png` |
| 方向提问 | dir=1（`o` 后提示 "In what direction?"，方向盘点按答 `k`，游戏回 "You see no door there."） |
| yn 提问 | yn=7（吃食确认链、Really quit?、局终四问等），操作栏渲染 是/否/取消 |
| 文本输入 | line=1（`#` 后行输入条手打 `quit` 回车）；另有文本窗 text=2（开局介绍＋局终 overview） |

局终信号：两视口均经 `__airstring_game_over(status)` 收到
status=0（未用工厂 Promise/EOF 口径）。桌面走物理键盘直通
路径，移动走点按路径（操作栏按钮/方向盘/命令面板），两条
路径的按键流一致（各 27 键、11 帧）。

## 4. 录制流与对账

格式见 `docs/recording-format.md`：以回合（帧）为索引，
`turn` 记录＝本回合消费的全部按键（key 审计事件
src==='queue'，base64）＋回合末帧 sha256；局终未成回合的
尾键入 `tail`；`header` 记 seed/date/角色/options（随机种子
只记 source，局终由 `end.seed` 揭晓）。前端每 16 条或 8 秒
分块 POST 到桩，桩逐条 append＋fsync。

对账口径（**全链、非抽查**）：取桩落盘的
`recordings/<gameId>.jsonl`，按序拼全部按键 → 写
`replay.keys` → 以仓内 `tools/run-node-s3.mjs` 的 replay
口径无头重放（同 seed/date/options）→ 逐帧比对帧哈希（帧块
内第一个 `hash=`）。结果（两视口各一次）：

- 录制 11 帧 vs 重放 11 帧，**逐帧哈希全等**；
- 重放帧流与浏览器推流帧流（`__airstring_frame` 副本）亦
  逐字节一致（`evidence/*-replayA.stream.frames` 对照）。

## 5. 存档往返证据（跨设备续玩口径）

两视口各跑：局 B 打 3 步后按 `S` 存档 → MEMFS 出现
`/save/0fleck` → 经 `__airstring_read_save` 导出 blob
**38,168 B** 下载 → 新开一局在开局页导入该文件 → 游戏打印
"Restoring save file..." 并恢复：

- 回合数 saved moves=4 → restored moves=4；
- 英雄位置 saved (45,5) → restored (45,5)；
- 恢复局可正常打到局终（status 0）。

实现注记（踩过的坑，供 S6/维护参考）：

- 导入文件名必须保持游戏原名（`0fleck`，uid＋角色名形
  式），改名会使游戏找不到存档而开新局；导出下载名即原名。
- 导入写入走工厂参数 `modArg.preRun`：回调在 pre-s3 的
  preRun **之前**执行（数组在前），此时 MEMFS 骨架未建，
  须先 `FS.mkdir('/save')` 再 `writeFile`，否则 ENOENT。
- 恢复成功后存档文件被游戏消费删除，属原版行为。

## 6. 宿主接口使用（无 pre-s3 改动）

- 配置注入：`globalThis.__airstring_config {seed, date:
  1700000000, options, mode:'async'}`＋`__airstring_event`
  在实例化前设置（照 pre-s3 契约）；角色选项经
  NETHACKOPTIONS（name/role/race/gender/align）传入。
- 完成信号：`globalThis.__airstring_game_over(status)`，
  pre-s3 默认实现之外由前端接管（揭晓随机种子、刷新存档
  列表、收尾录制 end 记录）。
- 帧/rng 推流：覆盖 `__airstring_frame` 收集帧哈希入录制
  流（rnglog 不在前端收集，验真侧由重放再生）。
- 存档：`__airstring_list_saves()` / `__airstring_read_save
  (name)` 照 S3 接口使用。

## 7. 实测与契约文档的出入（登记，请主线裁定是否回写契约）

1. **status 事件在现行构建中从不发出**（G1/G2 事件文件与
   本期全部对局均为 0 条；winstub 已注册 shim_status_update
   但 BL_FLUSH 路径未触发）。前端对策：status 事件到达时用
   其 lines，否则用推流帧 `[hero]` 字段渲染状态行（两行制
   式：名衔/属性/AC 等＋HP/Pw/XP/回合等）。
2. **方向提问以 prompt 事件到达**（`{kind:'yn', choices:
   null, q:"In what direction?"}`），与 window-contract
   「方向是普通 key 消费」的说法不符；前端按问题文本含
   "direction" 分类为方向态、渲染方向盘。
3. 物品提示下按 `?` **不开 menu 事件**：prompt-end 后以
   message 打印清单＋more（`evidence/eat.events.jsonl`）。
   真正的 menu 事件来自 `i` 等（how=0）。
4. map 事件的 colors 恒为 8（全部样本），前端按调色板
   8＝默认前景渲染；glyph 字符本身已足以辨识。

以上均为前端适配，未改游戏语义与判据。

## 8. 已知缺口（留 M1 及后续）

- 触控打磨（规格 §4.2 的 M1 项）：物品提示的反选/多选、
  点按查看（getpos）补全、长按重复与计数前缀输入、操作栏
  间距与拇指区调校。本期地图点按已含：相邻格＝方向键、
  英雄格＝`.`、远格＝`_` travel（getpos 游标步进＋`.`）。
- 状态行在 status 事件缺位期间靠帧字段拼装，字段集以帧
  `[hero]` 为限（如无 hunger 细分档位图标语义化）。
- 录制上传失败时仅保留内存副本＋手动下载按钮，无断点续
  传；S6 换 Firestore/Storage 时按 `docs/recording-
  format.md` §3 的幂等口径实现重试。
- 恢复局的录制流不自包含（按键流自恢复点起），格式文档
  已注记，S6 入库时须与原局拼接或标注 parent。
- 消息历史区为只读回看，未做过滤/搜索。

## 9. 纪律自查

- oracle 源码零改动；`tools/pre-s3.js` 零改动（§6 均为其
  既有宿主接口）；未改任何判据/金标。
- 点按一律翻译成原按键序列入异步键队列，无旁路：录制流
  只记按键、且已由 §4 全链对账证明点按路径与键盘路径等
  价（两视口同为 27 键 11 帧、哈希链全等）。
- 开局口径照规格 §2.5：种子必记录（指定或随机抽取后锁
  定；随机局中只显示「随机（局终揭晓）」，局终揭晓并入
  录制 end 记录——另以随机种子局单独验证：gameId 内种子
  与局终揭晓一致）、日期钉死 1700000000 并在开局页明
  示、bones 关闭、wizard/explore 不提供入口。
