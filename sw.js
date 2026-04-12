// Service Worker — cache offline-first
// IMPORTANT : bumper CACHE_VERSION à chaque déploiement pour invalider
// l'ancien cache sur les clients installés.
const CACHE_VERSION = 'aac-v15-foot-tip';
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './css/style.css',
  './js/app.js',
  './js/tableau.js',
  './js/prediction.js',
  './js/history.js',
  './js/calibration.js',
  './js/camera.js',
  './js/scan.js',
  './js/videosource.js',
  './js/training.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Ne jamais cacher l'API Anthropic ni les CDN dynamiques de MediaPipe
  if (url.hostname === 'api.anthropic.com') return;
  if (url.hostname === 'cdn.jsdelivr.net') {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((resp) => {
        // Cache runtime pour MediaPipe
        const copy = resp.clone();
        caches.open(CACHE_VERSION + '-runtime').then((c) => c.put(req, copy)).catch(() => {});
        return resp;
      }).catch(() => hit))
    );
    return;
  }

  // Google Fonts : runtime cache
  if (url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE_VERSION + '-fonts').then((c) => c.put(req, copy)).catch(() => {});
        return resp;
      }).catch(() => hit))
    );
    return;
  }

  // Core: cache-first
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((resp) => {
      if (resp && resp.ok && url.origin === self.location.origin) {
        const copy = resp.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
      }
      return resp;
    }).catch(() => caches.match('./index.html')))
  );
});
