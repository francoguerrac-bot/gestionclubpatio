// Service Worker — Club Patio Curauma PWA
const CACHE_NAME = 'clubpatio-v1';
const CACHE_URLS = [
  '/',
  '/index.html',
  '/assets/Logo2.png'
];

// Instalación: precachear el shell de la app
self.addEventListener('install', event => {
  console.log('[SW] Instalando...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Precacheando archivos');
        return cache.addAll(CACHE_URLS);
      })
      .then(() => self.skipWaiting())
  );
});

// Activación: limpiar caches antiguas
self.addEventListener('activate', event => {
  console.log('[SW] Activado');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => {
          console.log('[SW] Eliminando cache vieja:', k);
          return caches.delete(k);
        })
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch: Network-first para Firebase/API, Cache-first para assets
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Siempre desde red: Firebase, Firestore, APIs externas
  if (
    url.hostname.includes('firebase') ||
    url.hostname.includes('firestore') ||
    url.hostname.includes('googleapis') ||
    url.hostname.includes('gstatic') ||
    url.hostname.includes('fonts.googleapis') ||
    url.hostname.includes('wa.me')
  ) {
    return; // dejar pasar sin interceptar
  }

  // Assets locales: Cache-first
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }
        const toCache = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, toCache));
        return response;
      }).catch(() => {
        // Offline: devolver index.html para navegación SPA
        if (event.request.destination === 'document') {
          return caches.match('/index.html');
        }
      });
    })
  );
});
