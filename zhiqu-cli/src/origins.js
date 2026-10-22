// 哪些 user 消息不是用户打的：goal 模式推的下一轮、命令行自己补的说明（截断了接着说、清单没做完推一下）。
// 新记录带 origin 标记；发给模型的消息数组里没有标记（旧记录也没有），靠这几句固定开头认。
// /resume 回放（不冒充「› …」）和压缩（「用户说过的原话」只收用户真说过的）都用它。
export const LEGACY_GOAL = /^(目标：[\s\S]*\n开始做。$|继续朝目标推进：|核对没通过：|目标还没有宣告完成。接着做)/;
export const LEGACY_SYSTEM = /^（(你的回答被输出上限截断了|任务清单里还有)/;
export const SUMMARY_PREFIX = '【之前对话的摘要';

/** 'goal' | 'system' | null（null = 用户自己说的）。压缩留下的摘要消息算 'system'。 */
export function generatedOrigin(text) {
  const s = String(text || '');
  if (LEGACY_GOAL.test(s)) return 'goal';
  if (LEGACY_SYSTEM.test(s) || s.startsWith(SUMMARY_PREFIX)) return 'system';
  return null;
}
