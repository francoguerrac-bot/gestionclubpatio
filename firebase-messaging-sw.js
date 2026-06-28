// firebase-messaging-sw.js — v4 (alta prioridad + log Firestore)
// Depurar: DevTools → Application → Service Workers → firebase-messaging-sw.js

const SW_VERSION    = '4.0.0';
const PROJECT_ID    = 'gestion-de-personas-ce003';
const FIRESTORE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

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

// ── onBackgroundMessage: app cerrada o sin foco ───────────────────────
messaging.onBackgroundMessage(async function(payload) {
  const ts = new Date().toISOString();
  console.log(`[FCM-SW ${ts}] ✅ onBackgroundMessage:`, JSON.stringify(payload));

  // Log remoto — confirma que el mensaje llegó al SW
  await logToFirestore('background_received', payload, {
    notifFrom: 'onBackgroundMessage',
    hasNotification: String(!!payload.notification),
    hasData: String(!!payload.data),
  });

  const notif = payload.notification || {};
  const data  = payload.data         || {};
  const title = notif.title || data.title || 'Gestión de Equipos · Patio Curauma';
  const body  = notif.body  || data.body  || 'Tienes una novedad en la app.';
  const icon  = notif.icon  || '/assets/Logo2.png';
  const link  = data.link   || payload.fcmOptions?.link || 'https://gestionclubpatio.vercel.app';
  const tag   = data.tag    || `gpc-${Date.now()}`;

  const options = {
    body,
    icon,
    badge:              '/assets/Logo2.png',
    tag,
    data:               { url: link, ...data },
    vibrate:            [200, 100, 200],
    requireInteraction: false,
    silent:             false,
    timestamp:          Date.now(),
    actions: [
      { action: 'open',  title: '📋 Abrir app' },
      { action: 'close', title: 'Ignorar'       },
    ],
  };

  return self.registration.showNotification(title, options)
    .then(async () => {
      console.log('[FCM-SW] ✅ Notificación mostrada:', title);
      await logToFirestore('notification_shown', payload, { title, tag });
    })
    .catch(async (err) => {
      console.error('[FCM-SW] ❌ Error mostrando notificación:', err.message);
      await logToFirestore('notification_error', payload, { error: err.message });
    });
});

// ── Push raw (fallback — detecta si llega pero onBackgroundMessage no dispara) ──
self.addEventListener('push', async function(event) {
  const ts = new Date().toISOString();
  console.log(`[FCM-SW ${ts}] push raw recibido`);

  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
    console.log('[FCM-SW] push data:', JSON.stringify(payload));
  } catch(e) {
    console.warn('[FCM-SW] push data no es JSON:', event.data?.text?.());
  }

  // Solo logueamos — onBackgroundMessage de Firebase maneja el show
  // Si ves este log pero NO 'background_received', hay un bug en la inicialización
  await logToFirestore('push_raw', payload, { note: 'fallback_handler' });
});

// ── Click en la notificación ──────────────────────────────────────────
self.addEventListener('notificationclick', function(event) {
  const action = event.action;
  const url    = event.notification.data?.url || 'https://gestionclubpatio.vercel.app';
  console.log('[FCM-SW] notificationclick — action:', action, '| url:', url);

  event.notification.close();
  if (action === 'close') return;

  event.waitUntil(
    clients.matchAll({ type:'window', includeUncontrolled:true }).then(list => {
      const existing = list.find(c => c.url.includes('gestionclubpatio.vercel.app') && 'focus' in c);
      if (existing) { console.log('[FCM-SW] Enfocando ventana existente'); return existing.focus(); }
      console.log('[FCM-SW] Abriendo nueva ventana:', url);
      return clients.openWindow ? clients.openWindow(url) : null;
    })
  );
});

self.addEventListener('notificationclose', e =>
  console.log('[FCM-SW] Notificación cerrada — tag:', e.notification.tag)
);

// ── Ciclo de vida ─────────────────────────────────────────────────────
self.addEventListener('install',  e => { console.log(`[FCM-SW v${SW_VERSION}] install`); self.skipWaiting(); });
self.addEventListener('activate', e => { console.log(`[FCM-SW v${SW_VERSION}] activate`); e.waitUntil(self.clients.claim()); });
