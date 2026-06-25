// firebase-messaging-sw.js
// Service Worker para mensajes FCM en segundo plano (background)
// Compatible con Firebase v9+ (compat layer para SW)

importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey:            "AIzaSyDxVCUM808BRJ-5_SAG4bkdmu4e8xbVQn8",
  authDomain:        "gestion-de-personas-ce003.firebaseapp.com",
  projectId:         "gestion-de-personas-ce003",
  storageBucket:     "gestion-de-personas-ce003.appspot.com",
  messagingSenderId: "943250965489",
  appId:             "1:943250965489:web:6f17d07e76789b99107a50"
});

const messaging = firebase.messaging();

// Mensajes en segundo plano (app cerrada o sin foco)
messaging.onBackgroundMessage(function(payload) {
  console.log('[FCM-SW] Mensaje en background:', payload);

  const { title, body, icon, badge, data } = payload.notification || {};
  const notifOptions = {
    body:    body   || 'Tienes una novedad en Gestión de Equipos Patio Curauma.',
    icon:    icon   || '/assets/Logo2.png',
    badge:   badge  || '/assets/Logo2.png',
    data:    data   || {},
    vibrate: [200, 100, 200],
    actions: [
      { action: 'abrir', title: '📋 Abrir app' },
      { action: 'cerrar', title: 'Ignorar'      }
    ],
    tag: 'gpc-notification',           // reemplaza la anterior del mismo tag
    renotify: true,
    requireInteraction: false
  };

  self.registration.showNotification(
    title || 'Gestión de Equipos · Patio Curauma',
    notifOptions
  );
});

// Click en la notificación → abrir / enfocar la app
self.addEventListener('notificationclick', function(event) {
  event.notification.close();

  if (event.action === 'cerrar') return;

  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(function(clientList) {
        // Si la app ya está abierta, enfocarla
        for (const client of clientList) {
          if (client.url.includes(self.location.origin) && 'focus' in client) {
            return client.focus();
          }
        }
        // Si no está abierta, abrirla
        if (clients.openWindow) {
          return clients.openWindow(targetUrl);
        }
      })
  );
});
