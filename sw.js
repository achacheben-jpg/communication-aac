// Service Worker — cache offline-first avec stratégie network-first pour les
// navigations et l'app shell (index.html, js, css), stale-while-revalidate
// pour le reste. Évite les caches collants qui empêchent la propagation
// des déploiements sans bump manuel.
const CACHE_VERSION = 'aac-v26-toe-tip';
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

// Permet à la page d'ordonner au SW de passer en "waiting → active" tout de suite
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/** Network-first avec fallback cache. Si la réponse réseau est OK, on met
 *  à jour le cache au passage. Utilisé pour index.html + js + css : les
 *  futures mises à jour de code se propagent sans avoir à bumper la
 *  version du cache à chaque déploiement. */
function networkFirst(event, req) {
  return fetch(req).then((resp) => {
    if (resp && resp.ok) {
      const copy = resp.clone();
      caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
    }
    return resp;
  }).catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')));
}

/** Stale-while-revalidate : renvoie le cache immédiatement (rapide) mais
 *  déclenche une mise à jour en arrière-plan pour le prochain chargement. */
function staleWhileRevalidate(event, req, cacheName) {
  return caches.match(req).then((hit) => {
    const networkPromise = fetch(req).then((resp) => {
      if (resp && resp.ok) {
        const copy = resp.clone();
        caches.open(cacheName || CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
      }
      return resp;
    }).catch(() => hit);
    return hit || networkPromise;
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Le proxy IA (Cloudflare Worker) ne doit jamais être servi depuis le cache :
  // les réponses sont dynamiques par requête utilisateur.
  if (url.hostname.endsWith('.workers.dev')) return;

  // MediaPipe / CDN jsDelivr — stale-while-revalidate avec cache runtime
  if (url.hostname === 'cdn.jsdelivr.net') {
    event.respondWith(staleWhileRevalidate(event, req, CACHE_VERSION + '-runtime'));
    return;
  }

  // Google Fonts — stale-while-revalidate
  if (url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith(staleWhileRevalidate(event, req, CACHE_VERSION + '-fonts'));
    return;
  }

  // Navigation (document HTML) → NETWORK-FIRST : on veut toujours tenter
  // le serveur pour récupérer la dernière version de l'UI.
  const isNav = req.mode === 'navigate' || req.destination === 'document';
  if (isNav && url.origin === self.location.origin) {
    event.respondWith(networkFirst(event, req));
    return;
  }

  // Scripts / styles / manifest / icônes de l'app shell → network-first
  // pour que les correctifs JS se déploient automatiquement.
  if (url.origin === self.location.origin) {
    const dest = req.destination;
    if (dest === 'script' || dest === 'style' || dest === 'manifest' || req.url.endsWith('.js') || req.url.endsWith('.css')) {
      event.respondWith(networkFirst(event, req));
      return;
    }
    // Autres ressources même-origin (images, svg, etc.) : stale-while-revalidate
    event.respondWith(staleWhileRevalidate(event, req, CACHE_VERSION));
    return;
  }

  // Cross-origin autre : fetch normal (sans cache)
});
