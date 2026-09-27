// 上下文窗口（第十二轮）。用户 2026-09-28：「我的这个 deepseekv4pro（自己配置的模型是有 1m 上下文的）」，命令行却按 64000 算、
// 压缩了两次、服务器又裁掉 22 条 —— 因为那个模型配置里没填窗口，没填就按默认 64000；网页「模型设置」里能填，但命令行里没人告诉用户。
// 现在：没填的时候启动就说；/window 直接设（只能设自己的模型，范围和网页那一处同一个校验）。
export const MIN_WINDOW = 8000;
export const MAX_WINDOW = 1_000_000;

/** 「1000000」「1m」「128k」「200K」→ token 数；认不出来返回 null。 */
export function parseWindow(arg) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kKmM]?)\s*$/.exec(String(arg || ''));
  if (!m) return null;
  const unit = m[2].toLowerCase() === 'm' ? 1_000_000 : m[2].toLowerCase() === 'k' ? 1000 : 1;
  return Math.round(Number(m[1]) * unit);
}

const fmt = (n) => (n >= 1_000_000 && n % 1_000_000 === 0 ? `${n / 1_000_000}M` : n >= 1000 && n % 1000 === 0 ? `${n / 1000}K` : String(n));

/** 模型的窗口说明；没填窗口时带上怎么设。 */
export function windowLine(model) {
  if (!model) return '';
  const eff = model.effectiveContextWindow || 64_000;
  if (model.contextWindowTokens) return `上下文 ${fmt(eff)} token`;
  return `上下文按默认 ${fmt(eff)} token 算（这个模型没填窗口；它实际更大的话用 /window 设，比如 /window 1m）`;
}

/** /window [数]：不带参数看现在的；带了就设（服务器上这个模型的配置，网页里也跟着变）。返回要打印的一句话。 */
export async function setWindow(ctx, arg) {
  if (!arg) return windowLine(ctx.model);
  const tokens = parseWindow(arg);
  if (!tokens || tokens < MIN_WINDOW || tokens > MAX_WINDOW) {
    return `上下文窗口要在 ${fmt(MIN_WINDOW)}–${fmt(MAX_WINDOW)} token 之间，比如 /window 128k、/window 1m`;
  }
  const r = await ctx.api.post(`/api/harness/models/${ctx.model.id}/context-window`, { tokens });
  ctx.model.contextWindowTokens = r.contextWindowTokens;
  ctx.model.effectiveContextWindow = r.effectiveContextWindow;
  return `已把「${ctx.model.label}」的上下文窗口设为 ${fmt(r.effectiveContextWindow)} token（服务器上的配置，网页里也一样；之后按它压缩、裁剪）`;
}
