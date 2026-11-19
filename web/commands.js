/* airstring S5: NetHack 3.6.7 command table.
 *
 * Single source for the "all commands" panel and for action-bar
 * labels.  `seq` is the exact byte sequence a tap sends into the
 * key queue -- taps never bypass the queue; follow-up input the
 * command needs (item letter, direction, text) is prompted by the
 * game itself and answered through the normal prompt UI.
 *
 * Sequences are strings; each char is one byte (charCode).  For
 * extended commands the sequence is "#name\n": '#' opens the
 * extended-command line prompt and the rest fills it.
 *
 * Site rules (spec SS2.5): wizard/explore are not offered, so
 * #wish / #levelport / #teleport / 'X' are deliberately absent.
 */
export const COMMANDS = [
  /* --- movement (also on the direction pad) --- */
  { name: '向西移动', key: 'h', seq: 'h', cat: '移动', desc: '向西走一格（或攻击）' },
  { name: '向南移动', key: 'j', seq: 'j', cat: '移动', desc: '向南走一格（或攻击）' },
  { name: '向北移动', key: 'k', seq: 'k', cat: '移动', desc: '向北走一格（或攻击）' },
  { name: '向东移动', key: 'l', seq: 'l', cat: '移动', desc: '向东走一格（或攻击）' },
  { name: '向西北移动', key: 'y', seq: 'y', cat: '移动', desc: '向西北走一格（或攻击）' },
  { name: '向东北移动', key: 'u', seq: 'u', cat: '移动', desc: '向东北走一格（或攻击）' },
  { name: '向西南移动', key: 'b', seq: 'b', cat: '移动', desc: '向西南走一格（或攻击）' },
  { name: '向东南移动', key: 'n', seq: 'n', cat: '移动', desc: '向东南走一格（或攻击）' },
  { name: '等待一回合', key: '.', seq: '.', cat: '移动', desc: '原地等待（休息）' },
  { name: '上楼', key: '<', seq: '<', cat: '移动', desc: '走上楼梯' },
  { name: '下楼', key: '>', seq: '>', cat: '移动', desc: '走下楼梯' },
  { name: '远行', key: '_', seq: '_', cat: '移动', desc: '指定目标格自动寻路（再点目标）' },

  /* --- common actions --- */
  { name: '拾取', key: ',', seq: ',', cat: '动作', desc: '拾取脚下物品' },
  { name: '搜索', key: 's', seq: 's', cat: '动作', desc: '搜索周围隐藏门/陷阱' },
  { name: '开门', key: 'o', seq: 'o', cat: '动作', desc: '打开相邻的门（随后选方向）', needsDir: true },
  { name: '关门', key: 'c', seq: 'c', cat: '动作', desc: '关上相邻的门（随后选方向）', needsDir: true },
  { name: '踢', key: '^D', seq: '\x04', cat: '动作', desc: '踢（随后选方向）', needsDir: true },
  { name: '强行攻击', key: 'F', seq: 'F', cat: '动作', desc: '朝方向攻击（随后选方向）', needsDir: true },
  { name: '看脚下', key: ':', seq: ':', cat: '动作', desc: '查看脚下有什么' },
  { name: '远望', key: ';', seq: ';', cat: '动作', desc: '查看远处格子（再点目标）' },
  { name: '识别陷阱', key: '^', seq: '^', cat: '动作', desc: '指出已知陷阱（再点目标）' },

  /* --- items --- */
  { name: '背包', key: 'i', seq: 'i', cat: '物品', desc: '查看背包' },
  { name: '吃', key: 'e', seq: 'e', cat: '物品', desc: '吃食物（随后选物品）' },
  { name: '喝', key: 'q', seq: 'q', cat: '物品', desc: '喝药水/泉水（随后选物品）' },
  { name: '读', key: 'r', seq: 'r', cat: '物品', desc: '读卷轴/书（随后选物品）' },
  { name: '使用工具', key: 'a', seq: 'a', cat: '物品', desc: '使用工具（随后选物品）' },
  { name: '投掷', key: 't', seq: 't', cat: '物品', desc: '投掷物品（随后选物品与方向）' },
  { name: '射击', key: 'f', seq: 'f', cat: '物品', desc: '用箭筒里的弹药射击（随后选方向）', needsDir: true },
  { name: '点燃魔杖', key: 'z', seq: 'z', cat: '物品', desc: '激发魔杖（随后选物品与方向）' },
  { name: '手持武器', key: 'w', seq: 'w', cat: '物品', desc: '把武器拿在手里（随后选物品）' },
  { name: '交换武器', key: 'x', seq: 'x', cat: '物品', desc: '交换主/副武器' },
  { name: '选箭筒', key: 'Q', seq: 'Q', cat: '物品', desc: '选择箭筒弹药（随后选物品）' },
  { name: '穿盔甲', key: 'W', seq: 'W', cat: '物品', desc: '穿一件盔甲（随后选物品）' },
  { name: '脱盔甲', key: 'T', seq: 'T', cat: '物品', desc: '脱一件盔甲（随后选物品）' },
  { name: '戴饰品', key: 'P', seq: 'P', cat: '物品', desc: '戴上戒指/护符（随后选物品）' },
  { name: '摘饰品', key: 'R', seq: 'R', cat: '物品', desc: '摘下戒指/护符（随后选物品）' },
  { name: '卸下全部', key: 'A', seq: 'A', cat: '物品', desc: '卸下全部穿戴' },
  { name: '丢弃', key: 'd', seq: 'd', cat: '物品', desc: '丢弃物品（随后选物品）' },
  { name: '批量丢弃', key: 'D', seq: 'D', cat: '物品', desc: '按类别批量丢弃' },
  { name: '付账', key: 'p', seq: 'p', cat: '物品', desc: '在商店里付账' },
  { name: '施法', key: 'Z', seq: 'Z', cat: '物品', desc: '施放法术（随后选法术）' },
  { name: '法术列表', key: '+', seq: '+', cat: '物品', desc: '查看已学法术' },
  { name: '刻字', key: 'E', seq: 'E', cat: '物品', desc: '在地上刻字（随后输入文本）' },
  { name: '数金币', key: '$', seq: '$', cat: '物品', desc: '数一数身上的金币' },
  { name: '已发现物品', key: '\\', seq: '\\', cat: '物品', desc: '列出已识别的物品类别' },

  /* --- extended commands (# prefix; seq fills the line prompt) --- */
  { name: '祈祷', key: '#pray', seq: '#pray\n', cat: '扩展', desc: '向你的神祈祷' },
  { name: '献祭', key: '#offer', seq: '#offer\n', cat: '扩展', desc: '在祭坛上献祭（随后选物品）' },
  { name: '搜掠容器', key: '#loot', seq: '#loot\n', cat: '扩展', desc: '打开脚下/相邻的箱子' },
  { name: '交谈', key: '#chat', seq: '#chat\n', cat: '扩展', desc: '与相邻生物交谈（随后选方向）', needsDir: true },
  { name: '蘸取', key: '#dip', seq: '#dip\n', cat: '扩展', desc: '把物品蘸进泉水/药水（随后选物品）' },
  { name: '开锁', key: '#unlock', seq: '#unlock\n', cat: '扩展', desc: '用工具开锁（随后选物品与方向）' },
  { name: '拆陷阱', key: '#untrap', seq: '#untrap\n', cat: '扩展', desc: '拆除相邻陷阱（随后选方向）', needsDir: true },
  { name: '跳跃', key: '#jump', seq: '#jump\n', cat: '扩展', desc: '跳到指定格（再点目标）' },
  { name: '骑乘', key: '#ride', seq: '#ride\n', cat: '扩展', desc: '骑上/下坐骑（随后选方向）', needsDir: true },
  { name: '坐下', key: '#sit', seq: '#sit\n', cat: '扩展', desc: '坐下休息' },
  { name: '擦拭', key: '#wipe', seq: '#wipe\n', cat: '扩展', desc: '擦脸' },
  { name: '擦油', key: '#rub', seq: '#rub\n', cat: '扩展', desc: '摩擦物品（如神灯，随后选物品）' },
  { name: '召唤', key: '#invoke', seq: '#invoke\n', cat: '扩展', desc: '激发神器的召唤能力（随后选物品）' },
  { name: '强化技能', key: '#enhance', seq: '#enhance\n', cat: '扩展', desc: '提升武器/法术技能' },
  { name: '命名', key: '#name', seq: '#name\n', cat: '扩展', desc: '给物品/怪物命名（随后输入文本）' },
  { name: '调整背包', key: '#adjust', seq: '#adjust\n', cat: '扩展', desc: '调整物品的背包字母' },
  { name: '标注本层', key: '#annotate', seq: '#annotate\n', cat: '扩展', desc: '给当前层写注记（随后输入文本）' },
  { name: '概览', key: '#overview', seq: '#overview\n', cat: '扩展', desc: '查看已探索地牢概览' },
  { name: '守则', key: '#conduct', seq: '#conduct\n', cat: '扩展', desc: '查看本局守则完成情况' },
  { name: '驱散不死', key: '#turn', seq: '#turn\n', cat: '扩展', desc: '驱散不死生物（骑士/祭司）' },
  { name: '武技', key: '#technique', seq: '#technique\n', cat: '扩展', desc: '使用职业武技' },
  { name: '本层地形', key: '#terrain', seq: '#terrain\n', cat: '扩展', desc: '切换地形显示' },
  { name: '退出游戏', key: '#quit', seq: '#quit\n', cat: '扩展', desc: '放弃本局退出' },

  /* --- system --- */
  { name: '存档退出', key: 'S', seq: 'S', cat: '系统', desc: '存档并退出（下次可续玩）' },
  { name: '帮助', key: '?', seq: '?', cat: '系统', desc: '帮助菜单' },
  { name: '命令帮助', key: '&', seq: '&', cat: '系统', desc: '查询某个命令的说明' },
  { name: '查符号', key: '/', seq: '/', cat: '系统', desc: '查询一个地图符号是什么（随后输入字符）' },
  { name: '选项', key: 'O', seq: 'O', cat: '系统', desc: '查看/修改游戏选项' },
  { name: '版本', key: 'v', seq: 'v', cat: '系统', desc: '显示版本号' },
  { name: '历史消息', key: '^P', seq: '\x10', cat: '系统', desc: '重看上一条消息' },
  { name: '重绘屏幕', key: '^R', seq: '\x12', cat: '系统', desc: '重绘' },
  { name: '取消', key: 'Esc', seq: '\x1b', cat: '系统', desc: '取消当前提示/关闭窗口' },
];

/* direction byte for a (dx, dy) step, vi-key layout */
export function dirByte(dx, dy) {
  const table = {
    '-1,-1': 'y', '0,-1': 'k', '1,-1': 'u',
    '-1,0': 'h',               '1,0': 'l',
    '-1,1': 'b',  '0,1': 'j',  '1,1': 'n',
    '0,0': '.',
  };
  return table[dx + ',' + dy] || null;
}

export const DIRS = [
  { dx: -1, dy: -1, label: '↖' }, { dx: 0, dy: -1, label: '↑' }, { dx: 1, dy: -1, label: '↗' },
  { dx: -1, dy: 0,  label: '←' }, { dx: 0, dy: 0,  label: '·' }, { dx: 1, dy: 0,  label: '→' },
  { dx: -1, dy: 1,  label: '↙' }, { dx: 0, dy: 1,  label: '↓' }, { dx: 1, dy: 1,  label: '↘' },
];
