import { createRouter } from './router.mjs';
import { requireLogin } from './middleware/auth.mjs';

export function buildApp(db) {
  const app = createRouter();
  app.route('GET', '/health', () => ({ ok: true }));
  app.route('GET', '/me', requireLogin, (req) => ({ name: req.user.name }));
  app.route('GET', '/admin/users', requireLogin, () => db.users.map((u) => u.name));
  app.route('POST', '/admin/users/delete', requireLogin, (req) => {
    db.users = db.users.filter((u) => u.name !== req.body.name);
    return { deleted: req.body.name };
  });
  return app;
}
