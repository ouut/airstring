# airstring 录制流格式（S5 定版，供 S6 接线）

一局一份录制流，JSON Lines（每行一个 JSON 对象，UTF-8）。前端在
浏览器内攒流、按块 POST 到后端（S5 为本地桩 `tools/recording-stub.mjs`
的 `/upload`；S6 换 Firestore/Storage 时记录结构不变，只是落点与
索引方式变）。

## 记录类型

按出现顺序排列，`keys` 均为 base64 编码的原始字节串（即实际送达
游戏输入漏斗的字节，验真回放时不做任何转码）。

| k | 字段 | 含义 |
|---|---|---|
| `header` | `gameId, seed, seedSource`（`given`/`random`）`, date, options, startedAt, ua, restored` | 局首，恰一份。`date` 为钉死值（规格 §2.2）；`options` 为拼装好的 NETHACKOPTIONS；`restored` 为导入存档文件名或 null |
| `turn` | `turn, frame, hash, keys` | 一回合一份：`keys` 是上一帧导出之后、本帧导出之前被游戏消费的全部按键（按 shim `key` 审计事件、仅 `src=queue` 计数）；`hash` 是本帧导出自带的帧哈希（`[hero]` 段 `hash=`），`frame`/`turn` 为帧序号与回合数 |
| `tail` | `keys` | 局终时最后一帧之后仍被消费的按键（如 #quit 的确认键），至多一份，紧邻 `end` 之前 |
| `end` | `status, turns, frames, keysTotal` | 局终封口，恰一份。`status` 为 `__airstring_game_over(status)` 的宿主完成信号值 |

## 完整按键流的还原

`header` 之后按顺序拼接所有 `turn.keys` 与 `tail.keys`（base64 解码后
直接拼接）即为本局完整按键流，与 fleck 回放格式一致，可直接喂
`tools/run-node-s3.mjs --mode replay`（同 seed/options）无头重放。

注意：由存档恢复的局（`header.restored` 非 null）按键流不自包含——
重放须先备好同一存档，不在本格式的自包含口径内。

## 帧哈希链校验

重放产物逐帧取 `hash=`，与录制流中 `turn.hash` 序列逐项比对：
全等即证明「录下的按键在同一构建上重现了同一局」。S5 门已按此
口径对完整一局做全链比对（非抽查）。

## 分块上传

前端每攒满 16 条记录或每 8 秒 POST 一次
`{gameId, seq, final, records:[...]}`，`seq` 自 0 递增；后端按到达
顺序逐条追加落盘（S5 桩为 append＋fsync）。局终以 `final:true`
的块收尾。上传失败时前端保留内存副本并提供整流下载，不丢记录。
