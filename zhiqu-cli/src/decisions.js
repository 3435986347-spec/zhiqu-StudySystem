export const OTHER_OPTION = '__other__';

export function askUserSchema() {
  const option = {
    type: 'object',
    properties: {
      label: { type: 'string', description: '方案名，简洁明确' },
      description: { type: 'string', description: '这个方案的影响或代价，可选' },
      recommended: { type: 'boolean', description: '是否是你推荐的方案；每题最多一个' },
    },
    required: ['label'],
  };
  return {
    type: 'function',
    function: {
      name: 'ask_user',
      description: '需要用户决定需求或实现方案时，给出一批结构化问题。只用于不同选择会导致不同结果、且无法从上下文确定答案的决策；不要用于权限确认或琐碎选择。必须单独调用，等用户提交全部答案后再行动。每题给出 2–6 个方案，可以标一个推荐项；允许用户选择其他输入。',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            minItems: 1,
            maxItems: 4,
            items: {
              type: 'object',
              properties: {
                header: { type: 'string', description: '短分类名，可选' },
                question: { type: 'string', description: '需要用户决定的完整问题' },
                options: { type: 'array', minItems: 2, maxItems: 6, items: option },
                allowOther: { type: 'boolean', description: '是否提供其他输入，默认 true' },
              },
              required: ['question', 'options'],
            },
          },
        },
        required: ['questions'],
      },
    },
  };
}

const object = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value, max, name, { optional = false } = {}) => {
  if (value == null && optional) return { value: '' };
  if (typeof value !== 'string') return { error: `${name}必须是文字` };
  const trimmed = value.trim();
  if (!trimmed && !optional) return { error: `${name}不能为空` };
  if (value.length > max) return { error: `${name}最多 ${max} 字` };
  return { value: trimmed };
};

export function normalizeDecisionQuestions(args) {
  if (!object(args) || !Array.isArray(args.questions)) return { error: 'questions 必须是一个数组' };
  if (args.questions.length < 1 || args.questions.length > 4) return { error: '一次只能提出 1–4 个问题' };
  const questions = [];
  for (const [qi, raw] of args.questions.entries()) {
    if (!object(raw)) return { error: `第 ${qi + 1} 个问题必须是对象` };
    const question = text(raw.question, 1000, `第 ${qi + 1} 个问题`);
    if (question.error) return { error: question.error };
    const header = text(raw.header, 40, `第 ${qi + 1} 个问题的分类`, { optional: true });
    if (header.error) return { error: header.error };
    if (!Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > 6) return { error: `第 ${qi + 1} 个问题要有 2–6 个方案` };
    if (raw.allowOther !== undefined && typeof raw.allowOther !== 'boolean') return { error: `第 ${qi + 1} 个问题的 allowOther 必须是布尔值` };
    const options = [];
    let recommended = 0;
    for (const [oi, item] of raw.options.entries()) {
      if (!object(item)) return { error: `第 ${qi + 1} 个问题的第 ${oi + 1} 个方案必须是对象` };
      const label = text(item.label, 120, `第 ${qi + 1} 个问题的方案名`);
      if (label.error) return { error: label.error };
      const description = text(item.description, 500, `第 ${qi + 1} 个问题的方案说明`, { optional: true });
      if (description.error) return { error: description.error };
      if (item.recommended !== undefined && typeof item.recommended !== 'boolean') return { error: 'recommended 必须是布尔值' };
      const marked = item.recommended === true;
      if (marked) recommended++;
      options.push({ id: `o${oi + 1}`, label: label.value, description: description.value, recommended: marked });
    }
    if (recommended > 1) return { error: `第 ${qi + 1} 个问题最多只能有一个推荐方案` };
    questions.push({ id: `q${qi + 1}`, header: header.value, question: question.value, options, allowOther: raw.allowOther !== false });
  }
  return { questions };
}

export function normalizeDecisionAnswers(questions, raw) {
  if (!Array.isArray(questions) || !Array.isArray(raw)) return { error: '答案必须是数组' };
  if (raw.length !== questions.length) return { error: `要回答全部 ${questions.length} 个问题，不能多答或漏答` };
  const byId = new Map();
  for (const answer of raw) {
    if (!object(answer) || typeof answer.questionId !== 'string') return { error: '每个答案都要有 questionId' };
    if (byId.has(answer.questionId)) return { error: `问题 ${answer.questionId} 重复回答了` };
    byId.set(answer.questionId, answer);
  }
  const answers = [];
  for (const question of questions) {
    const answer = byId.get(question.id);
    if (!answer) return { error: `还没有回答问题 ${question.id}` };
    if (answer.optionId === OTHER_OPTION) {
      if (!question.allowOther) return { error: `问题 ${question.id} 不允许其他输入` };
      const other = text(answer.otherText, 2000, `问题 ${question.id} 的其他输入`);
      if (other.error) return { error: other.error };
      answers.push({ questionId: question.id, optionId: OTHER_OPTION, otherText: other.value });
      continue;
    }
    const option = question.options.find((item) => item.id === answer.optionId);
    if (!option) return { error: `问题 ${question.id} 没有方案 ${String(answer.optionId)}` };
    if (answer.otherText != null && String(answer.otherText).trim()) return { error: `问题 ${question.id} 选择了已有方案，不能同时带其他输入` };
    answers.push({ questionId: question.id, optionId: option.id });
  }
  if (byId.size !== questions.length) return { error: '答案里有不认识的问题编号' };
  return { answers };
}

export function formatDecisionResult(questions, outcome) {
  if (!outcome || outcome.cancelled) return '用户取消了这次决策，没有选择任何方案。不要替用户默认采用推荐项；可以说明取舍，或等用户进一步指示。';
  const normalized = normalizeDecisionAnswers(questions, outcome.answers);
  if (normalized.error) return `用户的答案无效：${normalized.error}`;
  const byId = new Map(normalized.answers.map((answer) => [answer.questionId, answer]));
  const lines = [`用户已提交 ${questions.length} 个问题的答案：`];
  questions.forEach((question, index) => {
    const answer = byId.get(question.id);
    const option = question.options.find((item) => item.id === answer.optionId);
    const chosen = answer.optionId === OTHER_OPTION ? `其他输入：${answer.otherText}` : `${option.label}${option.recommended ? '（推荐）' : ''}`;
    lines.push(`${index + 1}. ${question.header ? `【${question.header}】` : ''}${question.question}\n   用户选择：${chosen}`);
  });
  return lines.join('\n');
}
