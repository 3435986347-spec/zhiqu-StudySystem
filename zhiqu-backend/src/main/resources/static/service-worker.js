const ZHIQU_CACHE = 'zhiqu-shell-v20260707-wire-all14';

const SHELL_ASSETS = [
    '/',
    '/index.html',
    '/dashboard.html',
    '/tasks.html',
    '/routines.html',
    '/statistics.html',
    '/achievement.html',
    '/profile.html',
    '/shared-plans.html',
    '/knowledge-wiki.html',
    '/ai-assistant.html',
    '/admin.html',
    '/account-admin.html',
    '/feedback-admin.html',
    '/shared-plan-admin.html',
    '/assets/zhiqu-ui.css',
    '/assets/zhiqu-ui.js',
    '/assets/zhiqu-api.js'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(ZHIQU_CACHE)
            .then((cache) => cache.addAll(SHELL_ASSETS))
            .catch(() => undefined)
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => Promise.all(
            keys.filter((key) => key.startsWith('zhiqu-shell-') && key !== ZHIQU_CACHE)
                .map((key) => caches.delete(key))
        ))
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

    const isNavigation = request.mode === 'navigate' || request.destination === 'document';

    event.respondWith(
        fetch(request)
            .then((response) => {
                if (response && response.ok) {
                    const copy = response.clone();
                    caches.open(ZHIQU_CACHE)
                        .then((cache) => cache.put(request, copy))
                        .catch(() => undefined);
                }
                return response;
            })
            .catch(() => caches.match(request, { ignoreSearch: true }).then((cached) => {
                if (cached) return cached;
                if (isNavigation) return caches.match('/index.html');
                return Response.error();
            }))
    );
});

self.addEventListener('push', (event) => {
    let payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch (ignored) {
        payload = { title: '知趣提醒', body: event.data ? event.data.text() : '你有新的学习提醒' };
    }
    const title = payload.title || '知趣提醒';
    const options = {
        body: payload.body || payload.content || '你有新的学习提醒',
        tag: payload.tag || 'zhiqu-reminder',
        data: payload.url || '/dashboard.html'
    };
    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const target = event.notification.data || '/dashboard.html';
    event.waitUntil(self.clients.openWindow(target));
});
