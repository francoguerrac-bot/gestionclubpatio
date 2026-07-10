// firebase-messaging-sw.js — v6 (SW único: FCM + PWA cache)
// Este archivo es el ÚNICO Service Worker registrado.
// Maneja: FCM push, offline cache, deep links, postMessage.
// Depurar: DevTools → Application → Service Workers → firebase-messaging-sw.js

const SW_VERSION    = '6.3.0';
const APP_ORIGIN    = 'https://gestionclubpatio.vercel.app';
const PROJECT_ID    = 'gestion-de-personas-ce003';
const FIRESTORE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// ── PWA Cache (fusionado desde sw.js) ────────────────────────────────────
const CACHE_NAME = 'clubpatio-v7';
const CACHE_URLS = ['/', '/index.html', '/assets/Logo2.png', '/manifest.json'];

importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

console.log(`[FCM-SW v${SW_VERSION}] Cargado — ${new Date().toISOString()} — scope: ${self.registration.scope}`);

firebase.initializeApp({
  apiKey:            'AIzaSyDxVCUM808BRJ-5_SAG4bkdmu4e8xbVQn8',
  authDomain:        'gestion-de-personas-ce003.firebaseapp.com',
  projectId:         'gestion-de-personas-ce003',
  storageBucket:     'gestion-de-personas-ce003.appspot.com',
  messagingSenderId: '943250965489',
  appId:             '1:943250965489:web:6f17d07e76789b99107a50'
});

const messaging = firebase.messaging();
console.log('[FCM-SW] Messaging inicializado');

// ── Log remoto a Firestore (diagnóstico móvil) ────────────────────────
// Escribe en DOS colecciones:
//   /notification_logs  → filtrable por userId (para el Dashboard)
//   /fcm_sw_logs        → log técnico completo (para el Director)
async function logToFirestore(event, payload, extra = {}) {
  const now      = new Date().toISOString();
  const title    = payload?.notification?.title || payload?.data?.title || '';
  const body     = payload?.notification?.body  || payload?.data?.body  || '';
  const userId   = payload?.data?.userId || extra.userId || 'unknown';
  const docId    = `${Date.now()}_${Math.random().toString(36).slice(2,7)}`;

  // Colección 1: notification_logs (por usuario — Dashboard lo lee)
  const userLog = {
    fields: {
      status:    { stringValue: event === 'background_received' ? 'received'
                              : event === 'notification_shown'   ? 'shown'
                              : event === 'notification_error'   ? 'error'
                              : event },
      event:     { stringValue: event },
      userId:    { stringValue: userId },
      title:     { stringValue: title },
      body:      { stringValue: body },
      timestamp: { stringValue: now },
      swVersion: { stringValue: SW_VERSION },
      platform:  { stringValue: /iPhone|iPad|iPod/.test(self.navigator?.userAgent||'') ? 'ios'
                              : /Android/.test(self.navigator?.userAgent||'') ? 'android' : 'web' },
    }
  };

  // Colección 2: fcm_sw_logs (log técnico completo)
  const techLog = {
    fields: {
      ...userLog.fields,
      userAgent: { stringValue: self.navigator?.userAgent?.slice(0,120) || 'unknown' },
      ...Object.fromEntries(Object.entries(extra).map(([k,v])=>[k,{stringValue:String(v)}])),
    }
  };

  await Promise.allSettled([
    fetch(`${FIRESTORE_URL}/notification_logs?documentId=nl_${docId}`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(userLog)
    }).then(()=> console.log(`[FCM-SW] → notification_logs/nl_${docId}`)),
    fetch(`${FIRESTORE_URL}/fcm_sw_logs?documentId=sw_${docId}`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(techLog)
    }).then(()=> console.log(`[FCM-SW] → fcm_sw_logs/sw_${docId}`)),
  ]);
}

// ── Coordinación push ↔ onBackgroundMessage ──────────────────────────
// La flag evita que el handler de fallback muestre duplicado cuando Firebase
// ya procesó el mensaje correctamente via onBackgroundMessage.
let _bgMessageHandled = false;

// ── onBackgroundMessage: app cerrada o en background ─────────────────
// ★ REGLA CRÍTICA ANDROID: showNotification debe llamarse SINCRÓNICAMENTE
//   (sin await previo). Chrome Android cancela el evento push si hay operaciones
//   de red ANTES de mostrar la notificación, especialmente en conexiones 4G/3G lentas.
messaging.onBackgroundMessage(function(payload) {
  _bgMessageHandled = true;  // Firebase procesó el mensaje
  console.log('[FCM-SW] ✅ onBackgroundMessage', new Date().toISOString(),
              '| tipo:', payload?.data?.type || '—');

  // Extraer datos (síncrono — sin await)
  const notif = payload.notification || {};
  const data  = payload.data         || {};
  const title = notif.title || data.title || 'Gestión de Equipos · Patio Curauma';
  const body  = notif.body  || data.body  || 'Tienes una novedad en la app.';
  const icon  = notif.icon  || '/assets/Logo2.png';
  const link  = data.link   || payload.fcmOptions?.link || APP_ORIGIN;
  const tag   = data.tag    || `gpc-${Date.now()}`;

  // Etiqueta del botón acción según tipo
  const notifType = data.type || '';
  let openLabel = '🔔 Abrir app';
  if (data.taskId || notifType.startsWith('task') || notifType.startsWith('sprint')) openLabel = '📋 Ver tarea';
  else if (notifType.startsWith('permission')) openLabel = '🔑 Ver permiso';
  else if (notifType.startsWith('kanban'))     openLabel = '📌 Ver tablero';
  else if (notifType === 'proposal_submitted') openLabel = '💡 Ver propuesta';
  else if (notifType === 'tienda_toggle' || notifType === 'emprendedor_added') openLabel = '🏪 Ver tienda';
  else if (notifType === 'role_assigned')      openLabel = '🎉 Ingresar';
  else if (notifType === 'mood_bad_hijo' || notifType === 'mood_low') openLabel = '💛 Ver familia';

  const requiresAction = notifType.startsWith('permission') ||
                         notifType === 'task_assigned'      ||
                         notifType === 'task_urgent_unassigned' ||
                         notifType === 'kanban_approval_needed' ||
                         notifType === 'mood_bad_hijo';

  const options = {
    body,
    icon,
    badge:              '/assets/Logo2.png',
    tag,
    data:               { url: link, ...data },
    vibrate:            [300, 100, 300, 100, 500],
    requireInteraction: requiresAction,
    renotify:           true,
    silent:             false,
    timestamp:          Date.now(),
    actions: [
      { action: 'open',  title: openLabel },
      { action: 'close', title: '✕ Ignorar' },
    ],
  };

  // ▶ showNotification INMEDIATAMENTE — sin await, sin red, sin logs previos.
  //   Retornar esta promesa garantiza que el SW se mantiene vivo hasta que
  //   Chrome confirme que la notificación fue encolada en el sistema.
  const notifPromise = self.registration.showNotification(title, options);

  // Logs DESPUÉS de mostrar — en paralelo, no bloquean el banner
  notifPromise
    .then(() => {
      console.log('[FCM-SW] ✅ Notificación mostrada:', title, '| tag:', tag);
      // Escribir ambos logs en paralelo (no esperamos el resultado)
      Promise.all([
        logToFirestore('notification_shown', payload, { title, tag }),
        logToFirestore('background_received', payload, {
          notifFrom: 'onBackgroundMessage',
          hasData:   String(!!payload.data),
        }),
      ]).catch(() => {});
    })
    .catch((err) => {
      console.error('[FCM-SW] ❌ showNotification error:', err.message);
      logToFirestore('notification_error', payload, { error: err.message, title, tag }).catch(() => {});
    });

  return notifPromise;
});

// ── Push raw: log + fallback garantizado si onBackgroundMessage no dispara ──
self.addEventListener('push', function(event) {
  _bgMessageHandled = false;  // Reset para este push

  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
    console.log(`[FCM-SW] push raw — tipo: ${payload?.data?.type || '—'}`);
  } catch(e) {
    console.warn('[FCM-SW] push data no es JSON');
  }

  // event.waitUntil() es OBLIGATORIO para mantener el SW vivo durante trabajo async
  event.waitUntil(
    (async () => {
      // 1. Log de diagnóstico
      await logToFirestore('push_raw', payload, { note: 'raw_handler' }).catch(() => {});

      // 2. Esperar a que Firebase SDK procese el mensaje via onBackgroundMessage.
      //    Si _bgMessageHandled queda en false después de 2s → Firebase falló → mostrar fallback.
      await new Promise(resolve => setTimeout(resolve, 2000));

      if (_bgMessageHandled) return; // Firebase lo manejó ✅ — no duplicar

      // FALLBACK: Firebase no llamó onBackgroundMessage (inicialización fallida,
      // formato inesperado, etc.). Mostrar notificación de todas formas.
      console.warn('[FCM-SW] ⚠️ onBackgroundMessage no disparó — activando fallback');
      const data  = payload.data         || {};
      const notif = payload.notification || {};
      const title = notif.title || data.title || 'Gestión de Equipos · Patio Curauma';
      const body  = notif.body  || data.body  || 'Tienes una novedad en la app.';
      const link  = data.gpc_link || data.link || APP_ORIGIN;

      await self.registration.showNotification(title, {
        body,
        icon:    '/assets/Logo2.png',
        badge:   '/assets/Logo2.png',
        tag:     `gpc-fallback-${Date.now()}`,
        data:    { url: link, ...data },
        vibrate: [300, 100, 300, 100, 500],
        requireInteraction: true,
        renotify:           true,
        silent:             false,
        actions: [
          { action: 'open',  title: '🔔 Abrir app' },
          { action: 'close', title: '✕ Ignorar' },
        ],
      }).catch(async (err) => {
        await logToFirestore('fallback_error', payload, { error: err.message }).catch(() => {});
      });

      await logToFirestore('fallback_shown', payload, { reason: 'onBackgroundMessage_not_called' }).catch(() => {});
    })()
  );
});

// ── Click en la notificación ──────────────────────────────────────────
self.addEventListener('notificationclick', function(event) {
  const action  = event.action;
  const notifData = event.notification.data || {};
  const deepUrl   = notifData.gpc_link || notifData.url || APP_ORIGIN;

  console.log('[FCM-SW] notificationclick — action:', action, '| deepUrl:', deepUrl, '| type:', notifData.type);
  event.notification.close();
  if (action === 'close') return;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes('gestionclubpatio.vercel.app') && 'focus' in c);

      if (existing) {
        // App ya abierta: enfocar Y enviar mensaje de navegación
        console.log('[FCM-SW] App abierta — postMessage GPC_NAVIGATE + focus');
        existing.postMessage({
          type:     'GPC_NAVIGATE',
          notifType: notifData.type || '',
          taskId:   notifData.taskId   || '',
          reqId:    notifData.reqId    || '',
          cardId:   notifData.cardId   || '',
          deepUrl,
        });
        return existing.focus();
      }

      // App cerrada: abrir con deep link URL
      console.log('[FCM-SW] App cerrada — openWindow:', deepUrl);
      return clients.openWindow ? clients.openWindow(deepUrl) : null;
    })
  );
});

self.addEventListener('notificationclose', e =>
  console.log('[FCM-SW] Notificación cerrada — tag:', e.notification.tag)
);

// ── Ciclo de vida (PWA cache incluido) ───────────────────────────────────
self.addEventListener('install', e => {
  console.log(`[FCM-SW v${SW_VERSION}] install — precacheando ${CACHE_URLS.length} archivos`);
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(CACHE_URLS))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[FCM-SW] Precache parcial:', err.message))
  );
});

self.addEventListener('activate', e => {
  console.log(`[FCM-SW v${SW_VERSION}] activate — limpiando caches viejas`);
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => {
          console.log('[FCM-SW] Eliminando cache antigua:', k);
          return caches.delete(k);
        })
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: Network-first para Firebase/API, Cache-first para assets ───────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Siempre desde red: Firebase, Firestore, APIs externas, Vercel functions
  if (
    url.hostname.includes('firebase') ||
    url.hostname.includes('firestore') ||
    url.hostname.includes('googleapis') ||
    url.hostname.includes('gstatic') ||
    url.pathname.startsWith('/api/')
  ) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (!response || response.status !== 200 || response.type !== 'basic') return response;
        const toCache = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, toCache));
        return response;
      }).catch(() => {
        if (event.request.destination === 'document') return caches.match('/index.html');
      });
    })
  );
});
