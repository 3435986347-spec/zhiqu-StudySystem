const ZHIQU_CACHE = 'zhiqu-shell-v20261112-r142';

// 核心资源：必须全部缓存成功，否则安装失败、保留旧 Worker（旧缓存不被清理），避免一次网络抖动就丢掉离线能力。
// 只放普通用户每天要开的页面和共用的壳（第一百二十轮减量）：线上服务器只有 1.5 Mbps，每个新访客、每次换令牌都要把这张单子整个下一遍。
// 后台四页（普通用户根本不该下载）、KaTeX 和它的 20 个字体（只有带公式的 Wiki 页用）不预先下载 ——
// 打开过的页面、用到过的文件会被下面的 fetch 处理器顺手缓存，离线时照样有。
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
    '/mini.html',
    '/assets/zhiqu-ui.css',
    '/assets/zhiqu-ui.js',
    '/assets/zhiqu-api.js',
    '/assets/settings.js',
    // 页面模块（assets/pages/，第三十一轮起）也不预先下载：后台那一个普通用户根本不该下载
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(ZHIQU_CACHE)
            // 核心资源 addAll 失败会 reject → waitUntil 失败 → 新 Worker 不激活，旧 Worker 继续可用
            .then((cache) => cache.addAll(CORE_ASSETS))
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

// ---- 以下两个处理器目前到不了 ----
// 系统没有 Web Push：没有任何代码调用 pushManager.subscribe()，后端也没有推送发送方
// （提醒走 PUSHPLUS / WECOM / QQ 三个渠道，见 service/notification/）。
// 没有订阅就不会有 push 事件，所以这两段是死代码，留着是为了将来真做推送时不用重写。
//
// 之所以要写这句：在此之前，读到这里的人会合理地推断「推送是通的」——
// 部署文档甚至教运维去配一个 VAPID 公钥（那个配置项已经退掉了，因为没有任何代码读它）。
// 要真正接通，缺的是三件：前端订阅并上报 endpoint、存订阅的表、以及一个带 VAPID 私钥的发送方。
self.addEventListener('push', (event) => {
    let payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch (ignored) {
        payload = { title: '知趣提醒', body: event.data ? event.data.text() : '你有新的提醒' };
    }
    const title = payload.title || '知趣提醒';
    const options = {
        body: payload.body || payload.content || '你有新的提醒',
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
