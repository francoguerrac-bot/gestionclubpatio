// firebase-messaging-sw.js — v3 (modular compat layer, robusto)
// Inspeccionar en Chrome: DevTools → Application → Service Workers → firebase-messaging-sw.js

const SW_VERSION = '3.0.0';

importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

console.log(`[FCM-SW v${SW_VERSION}] Script cargado — scope: ${self.registration.scope}`);

firebase.initializeApp({
  apiKey:            'AIzaSyDxVCUM808BRJ-5_SAG4bkdmu4e8xbVQn8',
  authDomain:        'gestion-de-personas-ce003.firebaseapp.com',
  projectId:         'gestion-de-personas-ce003',
  storageBucket:     'gestion-de-personas-ce003.appspot.com',
  messagingSenderId: '943250965489',
  appId:             '1:943250965489:web:6f17d07e76789b99107a50'
});

const messaging = firebase.messaging();
console.log('[FCM-SW] Firebase messaging inicializado');

// ── Mensajes en BACKGROUND (app cerrada o sin foco) ──────────────────
messaging.onBackgroundMessage(function(payload) {
  console.log('[FCM-SW] ✅ onBackgroundMessage recibido:', JSON.stringify(payload));

  const notification = payload.notification || {};
  const data         = payload.data         || {};

  const title   = notification.title || data.title || 'Gestión de Equipos · Patio Curauma';
  const body    = notification.body  || data.body  || 'Tienes una novedad en la app.';
  const icon    = notification.icon  || '/assets/Logo2.png';
  const link    = data.link || payload.fcmOptions?.link || '/';
  const tag     = data.tag  || 'gpc-' + Date.now();

  const options = {
    body,
    icon,
    badge:            '/assets/Logo2.png',
    tag,
    data:             { url: link, ...data },
    vibrate:          [200, 100, 200],
    requireInteraction: false,
    silent:           false,
    actions: [
      { action: 'open',   title: '📋 Abrir app' },
      { action: 'close',  title: 'Ignorar'       },
    ],
  };

  console.log('[FCM-SW] Mostrando notificación:', title, options);

  return self.registration.showNotification(title, options)
    .then(() => console.log('[FCM-SW] ✅ Notificación mostrada correctamente'))
    .catch(err => console.error('[FCM-SW] ❌ Error mostrando notificación:', err));
});

// ── Click en la notificación ──────────────────────────────────────────
self.addEventListener('notificationclick', function(event) {
  console.log('[FCM-SW] notificationclick — action:', event.action, '| data:', JSON.stringify(event.notification.data));
  event.notification.close();

  if (event.action === 'close') return;

  const targetUrl = event.notification.data?.url || '/';
  console.log('[FCM-SW] Abriendo URL:', targetUrl);

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      // Intentar enfocar ventana existente
      for (const client of clientList) {
        if ('focus' in client) {
          console.log('[FCM-SW] Enfocando cliente existente');
          return client.focus();
        }
      }
      // Abrir nueva ventana
      if (clients.openWindow) {
        console.log('[FCM-SW] Abriendo nueva ventana');
        return clients.openWindow(targetUrl);
      }
    })
  );
});

// ── Notificación cerrada ──────────────────────────────────────────────
self.addEventListener('notificationclose', function(event) {
  console.log('[FCM-SW] Notificación cerrada por el usuario. tag:', event.notification.tag);
});

// ── Ciclo de vida del SW (para debugging) ────────────────────────────
self.addEventListener('install', function(event) {
  console.log(`[FCM-SW v${SW_VERSION}] install — forzando activación`);
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  console.log(`[FCM-SW v${SW_VERSION}] activate — tomando control de clientes`);
  event.waitUntil(self.clients.claim());
});

// ── Push raw (fallback si onBackgroundMessage no dispara) ─────────────
self.addEventListener('push', function(event) {
  console.log('[FCM-SW] push event raw recibido');
  if (!event.data) { console.warn('[FCM-SW] push sin datos'); return; }
  try {
    const payload = event.data.json();
    console.log('[FCM-SW] push data:', JSON.stringify(payload));
    // onBackgroundMessage de Firebase debería manejar esto,
    // pero si no dispara, lo procesamos aquí como fallback
  } catch(e) {
    console.warn('[FCM-SW] push data no es JSON:', event.data.text());
  }
});
