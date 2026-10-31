// 极简路由：route(method, path, ...middlewares, handler)。中间件按顺序跑，有一个拦下就不往下走。
export function createRouter() {
  const routes = [];
  return {
    route(method, path, ...fns) {
      routes.push({ method, path, guards: fns.slice(0, -1), handler: fns.at(-1) });
    },
    handle(req) {
      const r = routes.find((x) => x.method === req.method && x.path === req.path);
      if (!r) return { status: 404, body: { error: '没有这个地址' } };
      for (const guard of r.guards) {
        const stop = guard(req);
        if (stop) return stop;
      }
      return { status: 200, body: r.handler(req) };
    },
  };
}
