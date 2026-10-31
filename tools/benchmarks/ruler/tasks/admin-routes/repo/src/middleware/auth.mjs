// 鉴权中间件。中间件的形状：(req) => null 表示放行；返回 { status, body } 表示拦下。
export function requireLogin(req) {
  if (!req.user) return { status: 401, body: { error: '请先登录' } };
  return null;
}

/** 要求登录、并且角色在 roles 里。没登录 401，登录了但角色不对 403。 */
export function requireRole(...roles) {
  return (req) => {
    const unauth = requireLogin(req);
    if (unauth) return unauth;
    if (!roles.includes(req.user.role)) return { status: 403, body: { error: '没有权限' } };
    return null;
  };
}
