const ZHIQU_CACHE = 'zhiqu-shell-v20260707-wire-all18';

// 核心资源：必须全部缓存成功，否则安装失败、保留旧 Worker（旧缓存不被清理），避免一次网络抖动就丢掉离线能力
const CORE_ASSETS = [
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
    '/assets/zhiqu-api.js',
    '/assets/vendor/katex/katex.min.css',
    '/assets/vendor/katex/katex.min.js'
];

// KaTeX 字体：尽力而为，个别失败不阻断安装（离线缺字形会在联网时自然补齐），不拖累核心离线能力
const FONT_ASSETS = [
    '/assets/vendor/katex/fonts/KaTeX_AMS-Regular.woff2',
    '/assets/vendor/katex/fonts/KaTeX_Caligraphic-Bold.woff2',
    '/assets/vendor/katex/fonts/KaTeX_Caligraphic-Regular.woff2',
    '/assets/vendor/katex/fonts/KaTeX_Fraktur-Bold.woff2',
    '/assets/vendor/katex/fonts/KaTeX_Fraktur-Regular.woff2',
    '/assets/vendor/katex/fonts/KaTeX_Main-Bold.woff2',
    '/assets/vendor/katex/fonts/KaTeX_Main-BoldItalic.woff2',
    '/assets/vendor/katex/fonts/KaTeX_Main-Italic.woff2',
    '/assets/vendor/katex/fonts/KaTeX_Main-Regular.woff2',
    '/assets/vendor/katex/fonts/KaTeX_Math-BoldItalic.woff2',
    '/assets/vendor/katex/fonts/KaTeX_Math-Italic.woff2',
    '/assets/vendor/katex/fonts/KaTeX_SansSerif-Bold.woff2',
    '/assets/vendor/katex/fonts/KaTeX_SansSerif-Italic.woff2',
    '/assets/vendor/katex/fonts/KaTeX_SansSerif-Regular.woff2',
    '/assets/vendor/katex/fonts/KaTeX_Script-Regular.woff2',
    '/assets/vendor/katex/fonts/KaTeX_Size1-Regular.woff2',
    '/assets/vendor/katex/fonts/KaTeX_Size2-Regular.woff2',
    '/assets/vendor/katex/fonts/KaTeX_Size3-Regular.woff2',
    '/assets/vendor/katex/fonts/KaTeX_Size4-Regular.woff2',
    '/assets/vendor/katex/fonts/KaTeX_Typewriter-Regular.woff2'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(ZHIQU_CACHE)
            // 核心资源 addAll 失败会 reject → waitUntil 失败 → 新 Worker 不激活，旧 Worker 继续可用
            .then((cache) => cache.addAll(CORE_ASSETS)
                .then(() => Promise.all(FONT_ASSETS.map((u) => cache.add(u).catch(() => undefined)))))
            .then(() => self.skipWaiting())
    );
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
