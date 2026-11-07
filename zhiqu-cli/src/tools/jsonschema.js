// JSON Schema 校验（第一百一十三轮，zhiqu exec --output-schema）：够用的一小部分，没有依赖。
// 认的关键字：type、enum、const、required、properties、additionalProperties、items、minItems、maxItems、uniqueItems、
// minLength、maxLength、pattern、minimum、maximum、exclusiveMinimum、exclusiveMaximum、anyOf、oneOf、allOf、not、$ref（#/...）。
// 别的关键字不管（format、title、description 这些）。

const typeOf = (v) => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
};
const matchesType = (v, type) => {
  if (type === 'integer') return Number.isInteger(v);
  return typeOf(v) === type;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function resolveRef(root, ref) {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return undefined;
  let at = root;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (at == null || typeof at !== 'object' || !(key in at)) return undefined;
    at = at[key];
  }
  return at;
}

/** 返回错误的列表（空的就是符合）。路径写成 $.a[0].b */
export function validate(schema, value, { root = schema, at = '$', depth = 0 } = {}) {
  if (schema === true || schema === undefined) return [];
  if (schema === false) return [`${at}：这里不该有值`];
  if (depth > 64) return [`${at}：schema 嵌套太深`];
  const next = (sub, v, where) => validate(sub, v, { root, at: where, depth: depth + 1 });
  const errors = [];
  if (schema.$ref) {
    const target = resolveRef(root, schema.$ref);
    if (target === undefined) return [`${at}：schema 里的 $ref 找不到：${schema.$ref}`];
    errors.push(...next(target, value, at));
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${at}：应当是 ${types.join(' / ')}，实际是 ${typeOf(value)}`);
      return errors;   // 类型都不对，下面的说了也没用
    }
  }
  if (schema.enum && !schema.enum.some((e) => same(e, value))) errors.push(`${at}：只能是 ${JSON.stringify(schema.enum)} 之一`);
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && !same(schema.const, value)) errors.push(`${at}：只能是 ${JSON.stringify(schema.const)}`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}：不能小于 ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}：不能大于 ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push(`${at}：要大于 ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) errors.push(`${at}：要小于 ${schema.exclusiveMaximum}`);
  }
  if (typeof value === 'string') {
    const n = [...value].length;
    if (schema.minLength !== undefined && n < schema.minLength) errors.push(`${at}：至少 ${schema.minLength} 个字符`);
    if (schema.maxLength !== undefined && n > schema.maxLength) errors.push(`${at}：最多 ${schema.maxLength} 个字符`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) errors.push(`${at}：要符合 ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}：至少 ${schema.minItems} 项`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}：最多 ${schema.maxItems} 项`);
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) errors.push(`${at}：不能有重复的项`);
    if (schema.items !== undefined) value.forEach((v, i) => errors.push(...next(schema.items, v, `${at}[${i}]`)));
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${at}：缺少 ${key}`);
    }
    const props = schema.properties || {};
    for (const [key, v] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(props, key)) errors.push(...next(props[key], v, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}：不该有 ${key}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') errors.push(...next(schema.additionalProperties, v, `${at}.${key}`));
    }
  }
  if (schema.allOf) for (const sub of schema.allOf) errors.push(...next(sub, value, at));
  if (schema.anyOf && !schema.anyOf.some((sub) => next(sub, value, at).length === 0)) errors.push(`${at}：不符合 anyOf 里的任何一个`);
  if (schema.oneOf) {
    const hits = schema.oneOf.filter((sub) => next(sub, value, at).length === 0).length;
    if (hits !== 1) errors.push(`${at}：要正好符合 oneOf 里的一个，符合了 ${hits} 个`);
  }
  if (schema.not !== undefined && next(schema.not, value, at).length === 0) errors.push(`${at}：不该符合 not 里的`);
  return errors;
}

/** 模型的回答里的 JSON：整段是 JSON，或者包了一层代码块。别的不猜（前面带一段话的算不符合，推回去重写） */
export function extractJson(text) {
  const t = String(text ?? '').trim();
  const fenced = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(t);
  try {
    return { value: JSON.parse(fenced ? fenced[1] : t) };
  } catch (e) {
    return { error: `不是合法的 JSON：${e.message}` };
  }
}
