# airstring M0 · S4 护照报告（与原生 oracle 逐字节对账）

日期：2026-11-19。施工方：主线子代理（S4）。性质：验收期——
**未改任何源码**（检出 `git status` 除本报告/日志/运行产物外零改动，
见 §5）。不推仓，等主线验收。

## 结论：护照 PASS

- G1（seed 42＋smoke-01）、G2（seed 37＋slice-17）在 replay 与
  async 两模式下，frames 与 rnglog 均与金标**逐字节一致**。
- 种子 1–50 对扫：50/50 颗全等（wasm replay、wasm async 各与原生
  oracle 比 frames＋rnglog，共 200 项比对全 EQ），一致率 100%。
- 数据产物政策验证：干净检出构建确实再生 quest.dat 与全部 .lev
  且门全过——**再生政策成立**。另有一项构建卫生登记（S3 工作区
  .lev 带陈旧尾巴，根因 lev_comp 输出未带 O_TRUNC，见 §4），
  不影响干净构建与任何门。

## 1. 起点与构建

- 干净检出：`git clone` 本地仓 `~/workspace/projects/airstring`
  到 `~/workspace/airstring-work/s4/`，HEAD `8cd4782`（S3 PASS，
  即远程 `9d34c20b`），tree `308cee134781265b946f7b5edfa48aaf570e108a`
  与主线验收记录逐位一致。未复用 s1/s2/s3 工作区的任何构建产物。
- 构建：检出内 `./build-wasm.sh` 一条命令端到端完成（emsdk
  6.0.13），日志 `build-s4.log`（11,948 行）：Phase 0 reset →
  Setup（hints/linux-wasm-s1）→ Phase 1a 原生 makedefs＋生成头 →
  Phase 1b 原生工具＋数据＋原生游戏（check-dlb）→ Phase 2
  wasm-data → Phase 3 emcc 本体 → `=== Done ===`；全文
  `error:` 计数 0。
- 产物：`out/nethack.js` 204,723 B；`out/nethack.wasm`
  8,169,787 B，sha256
  `d2a5673c32b5d7fd378214988a4441712886dc9568d5097f9fd4c157ca6572c0`。
  （比 S3 的 8,285,406 B 小 115,619 B——差额来自 nhdat：S4 的
  nhdat 1,259,329 B vs S3 的 1,375,821 B，相差恰 116,492 B，
  即 §4 的 .lev 陈旧尾巴总量，dlb 打包口径差约 0.9 KB。）

## 2. 门一：G1 / G2 双模式对金标

金标：`~/workspace/verify-fleck/r0-golden/`（未动；开工前亲算
sha 与任务书一致）。工具：仓内 `tools/run-node-s3.mjs`；
G1 按键流 `fleck/replays/smoke-01.txt`（97 B），G2
`fleck/replays/slice-17.txt`（107,459 B）；async 口径：G1
`--chunk 8 --delay 5 --initial-delay 150`，G2 默认 chunk 8192。

| 跑 | frames 字节 / 帧数 | frames sha256 | rnglog 字节 / 行数 | rnglog sha256 | 对金标 |
|---|---|---|---|---|---|
| G1 replay | 475,696 / 93 | `09c48b071a835162e4cd0f3216594c30fc343bc5bcf8136ade13dbd1e186b0f4` | 123,627 / 6,850 | `845c33acf93207230470115a729f84a18449960b5e5df32358f859dba526b4fb` | cmp 全等 |
| G1 async | 475,696 / 93 | 同上 | 123,627 / 6,850 | 同上 | cmp 全等 |
| G2 replay | 25,586,024 / 4,328 | `53e5154f2ea7de7c629c15844a5b7eb46b7217d1b2dcd1b3936ca2be659d2929` | 3,888,697 / 205,683 | `1dda307085d21351232e5c14defd2345e40f66681dcb1cfbf86f63e7cced8bda` | cmp 全等 |
| G2 async | 25,586,024 / 4,328 | 同上 | 3,888,697 / 205,683 | 同上 | cmp 全等 |

附带自检（四跑全过）：推流副本（stream.frames / stream.rng）
与 MEMFS 权威副本逐字节一致；async 真挂起等待——G1 14 次、
G2 10 次（次数随分块/时序变，产物字节不受影响）；四跑
node exit 0。产物在 `passport-runs/g1-replay.*`、`g1-async.*`、
`g2-replay.*`、`g2-async.*`（含 .log/.stream.*）。

## 3. 门二：种子 1–50 对扫

口径（两侧钉一致）：

- 按键流：同一条 `smoke-01.txt`（97 B，sha256
  `b21dfd7b240ef0082e6601f221a0aac1506ba6df7fdac1517e9ae0c5dd751611`），
  覆盖开局若干回合（移动/战斗/进食尝试/--More-- 等）。
- 角色与日期：两侧同为 `name:fleck,role:valkyrie,race:human,
  gender:female,align:neutral`、FLECK_DATE=1700000000——原生侧由
  `run_oracle.sh` 钉死，wasm 侧为 `run-node-s3.mjs` 默认值，
  逐字相同。
- 原生侧经 `~/workspace/verify-fleck/run_oracle.sh SEED KEYS OUT`
  串行跑（TZ=UTC、无并发 oracle 进程）；wasm 侧同一检出构建，
  每颗跑 replay 与 async 两模式。
- 口径自检：seed 42 一行与 G1 金标完全重合（原生 frames sha
  `09c48b071a…`、93 帧 / 6,850 行），证明对扫口径与金标口径同源。
- 帧数说明：固定流在不同地牢里被 --More--/失败命令吃键的速率
  不同，导出帧数 3–93 不等（短跑均为英雄存活、回放耗尽退出，
  transcript 尾 `FLECK: replay exhausted; exiting.` 为证）；
  rnglog 行数则始终在 2,073–6,850（开局建层抽数已充分覆盖）。
  三方（原生 / wasm-replay / wasm-async）在每一颗上都逐字节
  一致，短跑不削弱比对效力。

结果：**50/50 颗、200/200 项比对全 EQ，一致率 100%，无平台
差异**。逐颗结果（原生 sha 为基准，EQ＝与原生逐字节一致）：

| seed | native frames sha256 | native rng sha256 | wasm-replay frames | wasm-replay rng | wasm-async frames | wasm-async rng | 帧数 | rng 行数 |
|---|---|---|---|---|---|---|---|---|
| 1 | `56f66fe5450eaef7b6ae455c59bf5901e3766ec68afba9c0987aaa943cadbe16` | `4b1a5cd267f0bf00d5c8a38a8acbfb640d7e6f772aabbcb3aaca11875eeaf594` | EQ | EQ | EQ | EQ | 14 | 3125 |
| 2 | `91eb87f002895bbe56f6df4c0b64fc8d5985eb49bc8070ba3cf2657954f01f07` | `2aa973b88ea01c8098d29e541600a8bdc707d7eb254e7b87c0211a8eb0e5518a` | EQ | EQ | EQ | EQ | 33 | 2905 |
| 3 | `0266efc3c5569175d1f3d641d3d47c8a00424b0c76ade876b0294108cde68780` | `0686ac99cf7757bfd54b221e590cd4069b30e91c636db0142a241c2be6679754` | EQ | EQ | EQ | EQ | 34 | 3442 |
| 4 | `65f6875d97b1bc567b5cb90e2c5baaf1fdb693183446dc77cc6664754829c5eb` | `26197c97435703ec09ccae12f15e14dd92afe68a126d6af800e552f22534e63d` | EQ | EQ | EQ | EQ | 37 | 2564 |
| 5 | `c4c83b6d5fa1730de9008d4a20295d1376821bbd6d6773c7cb28e4825da17a84` | `67f199360719c6a217bb84e8fc95458e1f963918c21347f88499ff3bdafd3c0e` | EQ | EQ | EQ | EQ | 32 | 3112 |
| 6 | `4de80986f632df391d79b013e4ea9d67a48f0028fb1c4bd7f44678df7e77775a` | `bb1e55ee7324097c8a3e26d3de7aca867cae609a77c660b5b559cb86fd4b7245` | EQ | EQ | EQ | EQ | 22 | 3144 |
| 7 | `e2d5f9e1d123dc9f6ca41251c8656703d4e8e820f24b24f00d947138ff8b7b0f` | `71ea4fc31579df3aacd2927ce16835531a046730dd5dfed7d54a073e92ca27b9` | EQ | EQ | EQ | EQ | 15 | 2915 |
| 8 | `9f55704241c19b7fe72bcc9aa517bf70169e321895a503d1a6180496edccdac0` | `fd273180c9170e2a76025056f7450697c077cfef320179d282de7aeede951dc9` | EQ | EQ | EQ | EQ | 3 | 2151 |
| 9 | `7e87e23d454ac705ae9dc773493f9eaa38e9b4574e3ef4c2b33612ac7e6bf51a` | `49821cce728d774aea8f3091ec2345c617c970628df113c59f5e7fc6b8be67f9` | EQ | EQ | EQ | EQ | 32 | 2942 |
| 10 | `cf97a8a7a3daa386c89a99b0f75d425accaf794c35da2da1e003f51a601dd7c3` | `f2a1cb85c10c883bb23870c88c5edb7d364d1e9de85160147d8cad73fc18f46b` | EQ | EQ | EQ | EQ | 18 | 3000 |
| 11 | `90c54d619d279c8b8ce7c425c15261a82d94e0d3eb160c54b4a0039aa0216263` | `3574e9ba754b0d7c37bf446d45bceeed8d16aa6ee17539c7d22766655f8d3132` | EQ | EQ | EQ | EQ | 13 | 2368 |
| 12 | `7f0c5cf767097f14c8ada78637b461a99fea4d51a7cdb7734331fd6a1a6d842e` | `12d3158313884d3137997f5da7e6b28753b98f37a3345f33608e8084c6ab64e6` | EQ | EQ | EQ | EQ | 39 | 3633 |
| 13 | `a07404fd99a3be9ece5502b6bf38bdd0d45be5f97b7a1650ebeb0ed49927c288` | `3ef231eae0610ebefe7fb7fbbed5a446bac1bbeaca25f95a78a78cf05d42ca2e` | EQ | EQ | EQ | EQ | 29 | 3004 |
| 14 | `50b8a24e483cc5cc276689ca3ddac5c0bc60b5e973bb863d9a5f9761c3aa784d` | `6f2d38d7b205c2f880d4d2506d5ef261bb1ffa5d9934a916b56ee00671631127` | EQ | EQ | EQ | EQ | 19 | 3511 |
| 15 | `ba8aa00da87eda35ec46a4d95a90fcf2c30cd711da2f3cc62554c28833d4c55a` | `f5896cb0fcd68ef2057505774aa7702f03b9e9823fb4e98ed74007f5ce14317d` | EQ | EQ | EQ | EQ | 43 | 4005 |
| 16 | `1ab83866993f01af386e645e4c0ff5fc809dd4243fbe29af34aeec127bdc1511` | `a84176ade36580416293bf7d3c5e376c7b3f839ef2e85f53df3549d548e6ebb4` | EQ | EQ | EQ | EQ | 15 | 2772 |
| 17 | `540a50f7dbc690cd8272fa782b635d2673489fcc2c59905580205a3c1e693635` | `e9f06d57e0345a9e1d02bd26e611dd28c8fe5a3e1c77810fcd2d2c9990e5b22b` | EQ | EQ | EQ | EQ | 6 | 2532 |
| 18 | `011acd1d4a0ba3d2e1404a14318c8116c2b5daccf14db24ac05f771e10fd566c` | `c3fe19e066776c872c310091c7ce78b02e88edc34a5084432157ec995d7491c9` | EQ | EQ | EQ | EQ | 21 | 3232 |
| 19 | `77a74e796d4ef0466d1ee825dd10283e2bea7ad01fdea551797f89b42538eb3f` | `981e8acedf7775645e3bf78fe9b01878e261e9cc30c1f4765bcc2b1425775e24` | EQ | EQ | EQ | EQ | 16 | 3044 |
| 20 | `e60734c8d3cb08648f1a87a998c97b99e822d0231c7f8fc51789af59a0ebdd33` | `7cec966ccaf173eac4d48b1ad78ee88d631c500cffd39a290a1aa74f3ea50f67` | EQ | EQ | EQ | EQ | 4 | 2073 |
| 21 | `0e925946e42ba5322c60d4645613699121968d0d16ef5b8dea3de0af9a061564` | `976b24c3f66808a62adb046902cf78bfda7bc85273635451137576f73e0de0af` | EQ | EQ | EQ | EQ | 4 | 2904 |
| 22 | `a25475ec219c94b54d1253a06df306b000769d7767446e041ec349d091bed057` | `a3b343647a07dd9b94dff34d6cb6564b4766ecc17bce1ab4fd4af71116640224` | EQ | EQ | EQ | EQ | 6 | 2660 |
| 23 | `5d13e901a9a1edc7af8e3f9bd6d91da363044e6d25d53a6ede4d2a5f771c4200` | `02f9eb3e164c07d95f5882ef7501cce4f7f16d435c39ac129781f9a7109fb51f` | EQ | EQ | EQ | EQ | 22 | 2688 |
| 24 | `9cd4148a8a8bcdfde71188814fee15d4fa8b3563b8fffa662019037ae624a399` | `07601ec37570f7082292ecc1f1759de65e4e4da1bb05c3fd99c21dc4cafdf68f` | EQ | EQ | EQ | EQ | 14 | 3095 |
| 25 | `00f5edcefda5e78fe2d73840087bf326ec66bb6aec5837dee69b5e77d40676ce` | `4eddc448dc9a7eb0dd6eb685ba6c3142fb4e5f9e845643c398d5490df2b681bd` | EQ | EQ | EQ | EQ | 24 | 3279 |
| 26 | `47af01df3a666b5c1f8139e4fd249d9f2007019113e7a57d5400d9272a8d11e3` | `68be4f18b16e85be671737984006185586b5c070296607d75dc041f00bdaffe4` | EQ | EQ | EQ | EQ | 38 | 3286 |
| 27 | `9bf725d38400c46618e044d0a29b3a81b72d63e3b5799eb92d9dfa5b66185001` | `17f853080ee476965fef5f99efda9933c1c73afefe6805f6198884f8152718b2` | EQ | EQ | EQ | EQ | 6 | 2173 |
| 28 | `5da53eef834e66fbeea4e8612d33eb838c4394767811361776d035c0ed1f6433` | `fd48182461e3ed37e986351c2f114a601bb2653bee025c625258ee475ac8693f` | EQ | EQ | EQ | EQ | 42 | 3093 |
| 29 | `2377d81c4cc70df565f3cf743c4aeb96ac67b4330140117ba704a89e5e0cf3d9` | `e26babc39af2417f0dd67ec65bc6ba6c8836ef31b09aed540b61e1f9c5afdc1e` | EQ | EQ | EQ | EQ | 38 | 2656 |
| 30 | `ddc684841322f8717156394800aaefe2ff440b599c8344fb9c4a1617c800499c` | `093d80303fa7f5e0d96b7a771035806f24fc99ed3ef871c3c5399fa10af132fe` | EQ | EQ | EQ | EQ | 50 | 3922 |
| 31 | `0c9a9785d16e8eeed9268cf26888ad86eebb3810898eac093f506c0145233ba5` | `2554a7ab6d48dbccf7e03477d819ee04e67cd0862d687bd7382683bb3c8877f8` | EQ | EQ | EQ | EQ | 43 | 3673 |
| 32 | `0a07c45792fc2f1040604103e3f046e368f23ff8bea24b7ab4e23d62b67ef287` | `5b1ded2e871a9d75fd224a6f7a192802c5ce9b4e6d36f31a77d038ae0a7a0217` | EQ | EQ | EQ | EQ | 31 | 3319 |
| 33 | `7eb64d3702c4c6159d1fd719420f0ad1cf1ce4ae7703a2ef51ae12747d7dd737` | `d3c99df73e0e5ded95966543f0dcf5f4630d75bef3dee4fee31700d531fb2ca5` | EQ | EQ | EQ | EQ | 36 | 3694 |
| 34 | `0d6160cc6dccbd6811bf6fd1b76121d45e4384927bf9b07831f161f0434ae8e8` | `597e58c2599e0c34e19225f8574a531497b98e303a47f8a65c759a9050e6507e` | EQ | EQ | EQ | EQ | 34 | 3681 |
| 35 | `8b0b1597009b993af586c2ac7d5aefbfe1da4a215b4f7c955dcc6cb33e1a368a` | `8c4b910bdd81f453eefeeee9e90cc983be203dc3901121fe43a22495e02a806b` | EQ | EQ | EQ | EQ | 28 | 3251 |
| 36 | `1f5a03592e48f55e608f3e40bf4917d32e60445124c18382bb100a9af172452c` | `86043b0e188e31cdca01316993d7799bb5640bbc9fb4f062231aae3e4d1c0c54` | EQ | EQ | EQ | EQ | 47 | 3555 |
| 37 | `bcf4ce90f774840b1b678eb3c4ea7e026bd493b37ecc764f2ef71668376ed912` | `ea31668e7999ee3463aa79cb61b1e6929073276c96e28cc7ca3fb24a73f49041` | EQ | EQ | EQ | EQ | 17 | 3079 |
| 38 | `2abf35e4a37e24d0d94d750ed2eae0bb7ac8a92ccb2b0428d16ef339c3359856` | `0579e39cf3f72439d05b70c4145e77cd7017f8ac7e61acb4f1f1ab5fb4dc4652` | EQ | EQ | EQ | EQ | 44 | 3380 |
| 39 | `57c08d861a875d35466c86f4782d77118ff097416217c6b79497ca61a6c08e5d` | `a56d966c1f4fe901fbb31e9932b15660dd8ce87d6c62e466066a460d1830d144` | EQ | EQ | EQ | EQ | 60 | 4391 |
| 40 | `111de2b114f700fa569afa29f957233fc8f25195da8a59f7c5a131b72919c3da` | `c9bd91d278261f55b53d637109acfee23c1cbbe7e4ff5046069c1811f7c22a14` | EQ | EQ | EQ | EQ | 31 | 3294 |
| 41 | `6599b3ebcf829f5f52f34c6ae8d102e203d40eae0406bb044cdc2280970ad0a2` | `7647d62fe8ee14dc763af6c9a2edf2fed2ae26ea07babc4e03de80848d9d048d` | EQ | EQ | EQ | EQ | 23 | 3163 |
| 42 | `09c48b071a835162e4cd0f3216594c30fc343bc5bcf8136ade13dbd1e186b0f4` | `845c33acf93207230470115a729f84a18449960b5e5df32358f859dba526b4fb` | EQ | EQ | EQ | EQ | 93 | 6850 |
| 43 | `4fbdb12b8b43bdfc0a8489bde1c4890292f2de26cd8a2a4d2194e62284f71c5d` | `069aa5b71140fd923bdd681ad90d38db6cdd5cd6a9f1f229dda61a6665af9066` | EQ | EQ | EQ | EQ | 25 | 2463 |
| 44 | `aa8af711b7d9c0e88d3322f3247e01992c8c621e05f3961146527bd6b8a20d33` | `569daf332a7e4c6e795d4b96401296af01e76cd25571033a731156bd846ae045` | EQ | EQ | EQ | EQ | 23 | 3066 |
| 45 | `6cc2f77346b9301ac9fdbb2a6bc9fab075670b2bdd2d82abfed041971d4a314a` | `cb0886e85f977ce57b38c883dc7678f7d653165306664b990eca1e9bf963bd96` | EQ | EQ | EQ | EQ | 23 | 2568 |
| 46 | `761fd5b8da6344e16f42f44b2d70a4c0a94ed4ccea741a5cae27e151b8c85c28` | `e3feebb1b0d65941a817a3425e7089c6f0a619c60293f7514f69efb2f06fa7b4` | EQ | EQ | EQ | EQ | 43 | 3200 |
| 47 | `045704b2da94bfd8a4dbc1ea61e7ac2c28953a5c11c3be34d854b72b10f1b762` | `87039efb4d8ebe72f55ec94f87596fa2cd05a95281dd4a208f4974e22287f86d` | EQ | EQ | EQ | EQ | 35 | 3427 |
| 48 | `22099d7d6071b42f4eb2b51b753ab6efeb461308d2d514388ff81ff2941ab456` | `7231d364cf289742b720a44825c448a7e7232eb517391c9dd6017c1f46c8345c` | EQ | EQ | EQ | EQ | 32 | 3339 |
| 49 | `9c246bfcfff47f2cb348565adde365588bdd10375c55b44c427f31ec36bc2c32` | `6b7b10b6809fefdbcd9fe6fe319aef286fafc0d0036e95798c5313bef2c47aff` | EQ | EQ | EQ | EQ | 36 | 3228 |
| 50 | `867b26cbb6ada9df96393727e25c76f7889766da98063d8561224cdfbe8f4197` | `db3c413c3930d0696597cc9136017ed21eaa67dc5f258e3d3e1e5f3081de5611` | EQ | EQ | EQ | EQ | 32 | 3066 |

产物全量保留在 `passport-runs/sweep/`（每颗 native/wreplay/
wasync 的 .frames/.rng/.log＋native .transcript），汇总
`passport-runs/sweep/summary.tsv`；驱动脚本
`passport-runs/run-gates.sh`、`passport-runs/run-sweep.sh`。

## 4. 数据产物政策验证（dat/quest.dat 与 dat/*.lev）

先纠正任务书前提一处：quest.dat 与 *.lev **不在 git 仓内**
（`oracle/dat/.gitignore` 明列 `quest.dat` 与 `*.lev`）——所谓
「仓内旧构建产物」只存在于主线工作树
`~/workspace/projects/airstring/oracle/dat/`（quest.dat
119,478 B 的旧 LP64 布局＋120 个 .lev）。干净检出里两者
**不存在**，构建必须从零再生。验证结果：

- **quest.dat：再生且正确。** 构建后 110,506 B，sha256
  `414a24da79a91a842d6d340be24e044e48552081e862fc35acc3a4c67418ed32`，
  与 S3 工作区产物 **逐字节一致**（新定宽布局；旧产物
  119,478 B）。
- **.lev：再生 120 个，且是唯一正确的定版。** 与 S3 工作区
  产物逐个比对：120/120 字节不同，但 S4 产物是 S3 产物的
  **严格字节前缀**（120/120 成立；如 castle.lev：S4
  10,211 B ⊂ S3 13,207 B；总量 S4 396,139 B vs S3
  512,631 B）。根因（已钉死）：`oracle/util/lev_main.c:1580`
  以 `open(lbuf, O_WRONLY | O_CREAT | O_BINARY)` 打开输出
  ——**没有 O_TRUNC**。S3 施工期的树内重构时，lev_comp 先写
  出过修复前的主机宽（LP64）布局 .lev（更长），定宽修复后
  重跑只覆写文件头部、旧尾巴残留拼接在后。游戏加载器只读
  到 opcode 流终止符为止，陈旧尾巴是惰性的——这解释了 S3
  的门为何照常全过，也解释了 §1 的 nhdat/wasm 体积差。
  S4 干净构建无前置文件，产物即定宽格式本体。
- **门仍全过**：§2 的 G1/G2（G2 全程含特殊层加载）就是用
  这批再生数据跑的，逐字节对金标全等——再生政策成立。

登记（构建卫生，非平台差异、不拦门）：lev_comp 不截断输出
是上游行为，其无害前提是「输出路径无旧文件」。建议主线在
构建纪律里固化一条：凡在旧树上重跑 build-wasm.sh，先清
`oracle/dat/*.lev`（或依赖 Phase 0 的 dat clean 覆盖到 .lev，
本报告未核该覆盖范围——S3 树内残留说明至少其当时的构建
路径未清掉）。S4 按验收期纪律未改源码，此项只登记。

## 5. 平台差异登记与源码状态

- 本期新发现平台差异：**无**。G1/G2/对扫共 204 项逐字节
  比对零分歧。
- S3 已登记三项（定宽 quest.dat、定宽 .lev、稳定 qsort）在
  本期干净构建上全部复验有效（体现在 §2/§3 全等结果里）。
- §4 的 O_TRUNC 事项为构建产物卫生问题，根因与证据已登记，
  与运行时平台差异无关。
- 源码状态：构建后 `git status --porcelain` 仅有未跟踪的
  `build-s4.log` 与 `passport-runs/`（构建产物与本报告均在
  gitignore/未跟踪侧），**受跟踪文件零改动**——S4 未动任何
  源码、未动判据、未动金标。

## 6. 交付物

- 本报告：`~/workspace/airstring-work/s4/REPORT.md`
- 构建日志：`~/workspace/airstring-work/s4/build-s4.log`
- 门产物：`~/workspace/airstring-work/s4/passport-runs/`
  （g1/g2 四跑全套＋sweep 50 颗全套＋两支驱动脚本）
- 检出与构建：`~/workspace/airstring-work/s4/`（含 `out/`）

**护照结论：PASS。** 按计划口径，S5/S6 的前置（护照全等）
已满足。
