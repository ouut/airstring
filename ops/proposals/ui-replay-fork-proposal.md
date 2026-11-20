# 前后端迭代建议：现代 Curses 游玩界面＋手机竖屏全屏＋类 YouTube ASCII 录像大厅/回放/分叉

- **起草方**：部署侧（受用户委托整理并提交给开发侧 Muse 审阅）
- **日期**：2026-11-20
- **当前基线**：`277a73c`（M0 自动验真已过关门，`https://airstring.org/` 与 `www` 301 跳转已上线生效）
- **红线约束**：
  1. 严守 `docs/airstring-spec.md` §0.3：坚持纯字符 ASCII 终端，**不做 Tiles 图块**；
  2. 不改动 WASM 内核、按键流漏斗与帧哈希验真口径；
  3. 严守 Blaze \$0 免费额度纪律（不引入图片/视频转码存储，不产生持续超额流量）。

---

## 一、现役前端已定位的 2 个高优 Bug（建议优先修）

结合线上实机截图与 `web/index.html`、`web/airstring.css` 源码定位：

1. **幽灵表单框常驻显示**：
   - `web/index.html` 中 `#linebar` 与 `#panel` 虽然带 `hidden` 属性，但 `web/airstring.css` 对两者声明了 `display: flex`，覆盖了浏览器默认 `[hidden] { display: none; }`，导致空输入框（提交/取消）与命令搜索框（搜索全部命令…/关闭）始终裸露在地图下方。
   - **改法**：在 `web/airstring.css` 顶部补一条 `[hidden] { display: none !important; }`。
2. **`#overlay` 非真正浮层且出现重复确认入口**：
   - `web/airstring.css` 中 `#overlay` 使用 `position: relative`，开场白（Book of Tyr）和菜单直接插入普通文档流撑爆页面，且与 `#msg` 的 `--More--`、`#actionbar` 的黄色“继续”同时出现三个重复入口。
   - **改法**：将 `#overlay` 改为地牢舞台容器内的真正浮层（见下方前端设计）。

---

## 二、前端 UI/UX 改造建议（已与用户完成讨论并收敛定型）

整体气质定调为 **「现代 NetHack Curses 纯黑终端」＋「Lichess 极简竞技感」**（参考 NAO/Hardfought Curses 界面与 Lichess，**不做 CRT 扫描线/荧光绿滤镜**，避免长局眼疲劳）。

### 2.1 视觉系统与通用终端规范
- **色彩**：主舞台纯黑 `#000000`，外框深炭黑（`#0b0d10` / `#0f131a`），直角或极微圆角（`0–3px`），去掉现有 SaaS 后台风的大块蓝边框卡片。
- **NetHack 16 色调优**：严格保留经典 16 色语义不乱改，对黑底发糊的暗色（深蓝/暗灰/棕）略提亮度确保可辨；英雄 `@` 给极轻高亮标识。
- **状态栏（`statushilites`）**：保留老玩家熟悉的紧凑字段排版，按血量区间动态着色（满血绿/中性、≤55% 琥珀黄、≤25% 警报红），配一条极细 `2px` 血条与醒目饥饿/虚弱标签。
- **日志区（桌面与手机保持一致）**：
  - 正常态**固定 2 行**（最新一行亮白、上一行暗灰，或长句自动折为 2 行），**按按键展开**最近 200 条完整滚动历史（再次点按或按移动键自动收起）。
- **低频工程信息退藏**：`gameId`、种子详情、`下载录制流`、`导出存档`、`回开局页` 收进极简折叠菜单（`☰`），不常驻抢占主视觉。

### 2.2 游玩页 — 桌面端
- 锁定 `100dvh` 一屏无滚动条，默认**纯净键盘模式**（隐藏大号触控操作栏，仅保留极轻呼出开关）。
- 经典三段式：**顶 2 行消息 → 中 `80×21` 纯黑地牢舞台 → 底 `statushilites` 状态栏**。
- 右上角提供 **`⛶` 专注全屏**（调用浏览器原生 Fullscreen API，同时隐藏网站顶栏）。
- **真浮层交互**：
  - 背包 `i` / 物品菜单：Curses 风格**右侧半透明浮层**（翻背包时左半边地图与周围怪物仍清晰可见）；
  - 开场白 / 文本窗 / 局终 R.I.P. 战报（附「✓ 已验真」徽章与种子揭晓）：**居中暗色遮罩浮层**，单确认入口，按空格/`Esc` 瞬关。

### 2.3 游玩页 — 手机端（用户明确收敛约束：专注竖屏，不做横屏，不做浮空虚拟键）
- **真全屏沉浸**：
  - 进入游玩页自动隐藏整个网站大导航栏与页脚，锁死 `100dvh` 并禁用滚动/下拉刷新（`overscroll-behavior: none`）。
  - Android 支持右上角 `⛶` 原生 Fullscreen API；同步补一份轻量 **PWA `manifest.json`**（`display: "standalone"` + 纯黑状态栏）让 iOS 用户“添加到主屏幕”后零地址栏全屏运行。
- **竖屏四段布局（方案 A：与桌面一致的上下顺序，地图零遮挡）**：
  1. **顶层（固定 2 行消息）**：与桌面端一致；右角嵌两个极轻图标 `⛶`（全屏）与 `☰`（局菜单抽屉）。
  2. **中层（无遮挡纯黑地图舞台，`flex: 1`）**：
     - 默认 **「以 `@` 为中心放大跟随」**（约 `25×13` 格、`15–16px` 护眼字号，**零平滑过渡动画、瞬间硬切居中**防晕屏）；
     - 地图右下角常驻半透明切换胶囊：**`🗺 全图缩览` ⇄ `◎ 跟随 @`**，0.1 秒切换整层拓扑。
  3. **地图正下方（极细 1 行 HUD + 2px 血条）**：紧凑展示 `HP / Pw / AC / Dlvl / $ / T` 及饥饿高亮。
  4. **最底固定独立拇指区（贴 `env(safe-area-inset-bottom)`，平时绝不弹系统键盘）**：
     - **主操控排**：一侧紧凑 `3×3` 方向盘（含中心 `休 .`），另一侧**等高自适应上下文动作区**——按当前情境动作数量分 4 档重排（1 键铺满 / 2 键均分 / 3–4 键 `2×2` / 5–6 键 `2×3`，超 6 键末尾出「更多 +N」），总高度锁死不跳动；
     - **底部拇指快捷栏**：`[ 背包 i ] [ 搜索 s ] [ 日志 ▾ ] [ 命令 ] [ ⇄ 换手 ]`——日志展开键放底部单手拇指可直达（同时保留点顶部消息区也可展开），`⇄ 换手` 一键互换方向盘与上下文动作区左右位置。

### 2.4 开局页
- 由三块原生 `fieldset` 升级为紧凑的「角色速选卡片＋种子模式」界面（导入存档与验真口径折叠至次级区域），点击主按钮秒进地牢。

### 2.5 大厅录像库＋YouTube 式回放与一键分叉（Phase 2）
- **大厅（列表页）**：3–4 列响应式纯黑卡片墙。每张卡片顶部直接用极小号彩色等宽字渲染该局 **ASCII 缩略图**（零视频/图片存储），叠放角标（`🏆 飞升` / `💀 YASD` / `✓ 已验真`、`Dlvl`、`T`）与筛选条（全部已验真 / 飞升 / 精彩暴毙 / 热门分叉 / 每日种子 / 搜索）。
- **回放页（观看页）**：
  - 复用游玩页纯黑终端舞台，下方配视频播放器式控制条：**播放/暂停、倍速（0.5x/1x/2x/4x）、`←`/`→` 单步前进后退、可拖拽进度条与关键事件打点**。
  - 前端在 Web Worker 中用同一份 `nethack.wasm` 预跑缓存帧流（短/中局全帧存内存实现丝滑 Seek；超长局采用关键帧快照＋diff 控内存），**服务端零视频算力与带宽消耗**。
- **一键分叉（Fork）**：
  - 在回放页任意第 `K` 回合点击 **「⚡ 从第 K 回合分叉接玩」** → 前端用同 `seed/date/options` 无头重放前 `K` 回合按键前缀，随后将输入队列无缝切回玩家键盘，继续往同一条 `.jsonl` 录制流追加新按键。
  - 产生的分叉局从头到尾仍是完整自包含按键流，**100% 沿用现有验真器验真，无需改动验真核心算法**。
  - 右侧栏展示本局验真护照（SHA-256、帧数一致比）、**分叉家族树（Fork Tree）**及同种子其他对局。

---

## 三、后端数据模型与规则最小增量建议（仅 Phase 2 需要）

对照现役 `firestore.rules`、`firestore.indexes.json`、`storage.rules`、`web/firebase.js`、`verifier/gcp.mjs` 逐项盘点：

> **Phase 1（游玩页＋手机全屏＋开局页＋基础列表）后端零改动，现役模型 100% 支持。**
> 以下 3 处轻量增量仅用于点亮 Phase 2（公开回放、ASCII 缩略图墙、分叉树）：

### 增量 1：公开只读录像路径（解决访客回放他人录像 403 问题）
- **现状**：`storage.rules` 中 `recordings/{uid}/{gameId}.jsonl` 为严格本人可读（`ownUid(uid)`），他人无法下载回放。
- **建议改法**：
  1. `verifier/gcp.mjs` 在判定 `verdict === 'verified'` 后，将同一份已验真 `.jsonl` 复制/写入 `public-recordings/{gameId}.jsonl`；
  2. `storage.rules` 增加：
     ```
     match /public-recordings/{file} {
       allow read: if true;
       allow write: if false;
     }
     ```
     （未验真局与 `recordings/{uid}/**` 仍保持严格私密，客户端不可写公开目录。）
  3. `games/{gameId}` 由验真器同步回写 `publicRecordingPath: "public-recordings/{gameId}.jsonl"`。
  4. **运维/IAM 配套提醒**：当前 Cloud Run 运行服务账号 `39704157599-compute@developer.gserviceaccount.com` 仅授予了 `roles/storage.objectViewer`；若采纳本方案，部署侧需在配套任务中为其补充 Storage 对象写入权限（如限定至该 bucket 的 `roles/storage.objectAdmin` 或 `roles/storage.objectCreator`）。

### 增量 2：验真器权威回写大厅摘要与 ASCII 缩略图（防客户端造假）
- **现状**：`games/{gameId}` 仅有 `turns / frames / end`，缺少大厅卡片所需的封面图、到达深度、结局与死因。
- **建议改法**：
  - 验真器无头重放结束时，由服务端从最终状态/帧流提取并回写至 `games/{gameId}`（客户端 `firestore.rules` 的 `verdictFields()` 同步禁止客户端写入这些字段）：
    - `thumb`：末帧（或高光帧）以英雄为中心裁切的紧凑 ASCII＋16 色编码（例如 `35×11` 格，控制在 **1–2 KB** 内，直接随 `games` 列表查询返回，零额外 Storage 请求）；
    - `maxDlvl`（int）：到达最深层数；
    - `outcome`（string）：`"ascended" | "died" | "quit"`；
    - `deathReason`（string）：简短结局/死因描述；
    - `tags`（string[]，可选）：顺带对接规格 §5.3 标签（如 `stage20-ascension`、`quest-<role>`）。
  - 客户端建局文档时可选增加展示字段 `displayName`（玩家昵称，不用于鉴权）。

### 增量 3：分叉元数据与查询索引
- **现状**：录制 `header` 与 `games/{gameId}` 无父局关联字段。
- **建议改法**：
  1. 录制流 `header` 与 `games/{gameId}` 增加两个可选字段：
     - `parentGameId`: `string | null`
     - `forkTurn`: `int | null`
  2. `firestore.rules`：`allow create` 允许携带可选 `parentGameId`/`forkTurn`，`allow update` 保持不可变；
  3. `firestore.indexes.json`：新增复合索引：
     - `(parentGameId ASC, status ASC, createdAt DESC)`（查询某局的全部已验真子分叉，构建分叉家族树）；
     - 可选按需补充 `(status ASC, outcome ASC, createdAt DESC)` 与 `(status ASC, seed ASC, createdAt DESC)`（如初期总对局 < 500 条也可前端拉取后本地筛选，暂不急加）。

---

## 四、建议分期落地与请开发侧（Muse）裁定事项

- **Phase 1（后端零改动，可最快上线）**：修掉 2 个 CSS Bug ＋ 上线现代 Curses 桌面端 & 手机竖屏全屏游玩页 ＋ 紧凑开局页 ＋ PWA `manifest.json` ＋ 基础已验真列表。可先在独立分支推 Firebase Hosting 预览频道（~5 秒增量部署）供用户真机手机+电脑验收。
- **Phase 2（前后端联调）**：按开发侧审定的后端增量更新 `verifier/`、`storage.rules`、`firestore.rules`、`firestore.indexes.json`（及 Cloud Run SA Storage 写权限），再上线公开回放器、ASCII 缩略图墙与分叉家族树。

**请开发侧审阅并回复以下 3 点（写入 `ops/discuss.md` 即可）**：
1. 对整体前后端建议与两期拆分有无异议或需修正之处？
2. Phase 2 后端 3 处增量（公开录像路径＋IAM 权限、验真器回写 `thumb/maxDlvl/outcome/deathReason`、`parentGameId/forkTurn` 字段名）是否认可，或有更优字段/结构约定？
3. Phase 1 前端改动是由开发侧统一实施，还是授权部署侧开独立分支先行落预览版供用户真机试玩？
