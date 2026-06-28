/**
 * Firebase Cloud Functions — Gestión de Equipos Patio Curauma
 *
 * FUNCIONES:
 *   sendNotificationToUser  — HTTP callable: push a un usuario por UID
 *   onTaskAssigned          — trigger: notifica cuando cambia assignedToUid
 *   onPermissionResolved    — trigger: notifica al hijo cuando padres responden
 */

const { onCall, HttpsError }  = require('firebase-functions/v2/https');
const { onDocumentUpdated }   = require('firebase-functions/v2/firestore');
const { initializeApp }       = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging }        = require('firebase-admin/messaging');

initializeApp();
const db        = getFirestore();
const messaging = getMessaging();

const ORG_ID = 'curauma_001';

// ── Obtener tokens FCM de un usuario (doc + subcolección) ─────────────
async function getTokensForUser(uid) {
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) return [];
  const data = snap.data();

  // Fuente 1: campo fcmTokens[] en el documento principal
  const tokensFromDoc = (data.fcmTokens || []).filter(Boolean);

  // Fuente 2: subcolección /users/{uid}/tokens/
  const subSnap = await db.collection('users').doc(uid).collection('tokens').get();
  const tokensFromSub = subSnap.docs
    .map(d => d.data().token)
    .filter(Boolean);

  // Deduplicar
  return [...new Set([...tokensFromDoc, ...tokensFromSub])];
}

// ── Limpiar tokens inválidos de Firestore ─────────────────────────────
async function cleanInvalidTokens(uid, invalidTokens) {
  if (!invalidTokens.length) return;
  try {
    // Eliminar del array en el doc principal
    await db.collection('users').doc(uid).update({
      fcmTokens: FieldValue.arrayRemove(...invalidTokens)
    });
    // Eliminar de la subcolección
    const subSnap = await db.collection('users').doc(uid).collection('tokens').get();
    const batch = db.batch();
    subSnap.docs.forEach(d => {
      if (invalidTokens.includes(d.data().token)) batch.delete(d.ref);
    });
    await batch.commit();
    console.log(`[FCM] Tokens inválidos eliminados para uid=${uid}:`, invalidTokens.length);
  } catch(e) {
    console.warn('[FCM] Error limpiando tokens:', e.message);
  }
}

// ── Construir payload FCM con alta prioridad para móvil ───────────────
function buildMessage(token, title, body, data = {}, link = 'https://gestionclubpatio.vercel.app', uid = '') {
  // uid en data.userId permite que el SW identifique al destinatario en los logs
  const strData = Object.fromEntries(
    Object.entries({ ...data, link, userId: uid }).map(([k, v]) => [k, String(v)])
  );

  return {
    token,
    notification: { title, body },

    // ── Android: alta prioridad para despertar pantalla ──
    android: {
      priority: 'high',                  // 'high' = FCM empuja inmediatamente
      notification: {
        title,
        body,
        icon:              'ic_notification',
        color:             '#5BC0BE',
        channelId:         'gpc_default',
        priority:          'high',
        defaultVibrateTimings: true,
        defaultSound:      true,
        clickAction:       'FLUTTER_NOTIFICATION_CLICK',
        notificationCount: 1,
      },
      data: strData,
    },

    // ── Apple (iOS/iPadOS): prioridad 10 = entrega inmediata ──
    apns: {
      headers: {
        'apns-priority':   '10',          // 10 = inmediata, 5 = conserva batería
        'apns-push-type':  'alert',       // obligatorio en iOS 13+
        'apns-expiration': '0',           // no expira nunca
      },
      payload: {
        aps: {
          alert:         { title, body },
          badge:         1,
          sound:         'default',
          'content-available': 1,         // despierta app en background
          'mutable-content':   1,         // permite modificar la notif
        },
        ...strData,
      },
    },

    // ── Web Push ──
    webpush: {
      headers:  { Urgency: 'high', TTL: '86400' },
      notification: {
        title,
        body,
        icon:    '/assets/Logo2.png',
        badge:   '/assets/Logo2.png',
        requireInteraction: false,
        vibrate: [200, 100, 200],
      },
      fcmOptions: { link },
      data: strData,
    },

    data: strData,
  };
}

// ── Enviar a lista de tokens ──────────────────────────────────────────
async function sendToTokens(uid, tokens, title, body, data = {}) {
  if (!tokens.length) return { sent: 0, failed: 0 };

  const messages = tokens.map(t => buildMessage(t, title, body, data, undefined, uid));

  // sendEachForMulticast acepta max 500 tokens — dividir si fuera necesario
  const results = [];
  const BATCH   = 500;
  for (let i = 0; i < messages.length; i += BATCH) {
    const chunk = messages.slice(i, i + BATCH);
    const resp  = await messaging.sendEach(chunk);
    results.push(...resp.responses.map((r, idx) => ({ r, token: tokens[i + idx] })));
  }

  const invalid = results.filter(({ r }) => {
    const code = r.error?.code || '';
    return code.includes('not-registered') || code.includes('invalid-registration-token');
  }).map(({ token }) => token);

  if (invalid.length && uid) await cleanInvalidTokens(uid, invalid);

  const sent   = results.filter(({ r }) => r.success).length;
  const failed = results.length - sent;
  return { sent, failed, invalidCleaned: invalid.length };
}

// ─────────────────────────────────────────────────────────────────────
// FUNCIÓN 1: sendNotificationToUser — HTTP Callable
// Uso desde el cliente:
//   const fn = httpsCallable(functions, 'sendNotificationToUser');
//   await fn({ userId, title, body, data });
// ─────────────────────────────────────────────────────────────────────
exports.sendNotificationToUser = onCall(
  { region: 'us-central1' },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Se requiere autenticación.');
    }

    const { userId, title, body, data = {} } = request.data;
    if (!userId || !title || !body) {
      throw new HttpsError('invalid-argument', 'userId, title y body son obligatorios.');
    }

    const tokens = await getTokensForUser(userId);
    if (!tokens.length) {
      return { success: false, reason: 'El usuario no tiene tokens FCM registrados.' };
    }

    const result = await sendToTokens(userId, tokens, title, body, data);
    console.log(`[FCM] sendNotificationToUser uid=${userId}`, result);
    return { success: true, ...result };
  }
);

// ─────────────────────────────────────────────────────────────────────
// FUNCIÓN 2: onTaskAssigned — tarea reasignada
// ─────────────────────────────────────────────────────────────────────
exports.onTaskAssigned = onDocumentUpdated(
  { document: 'tasks/{taskId}', region: 'us-central1' },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();

    if (before.assignedToUid === after.assignedToUid) return null;
    const uid = after.assignedToUid;
    if (!uid) return null;

    const ctx    = after.ctx || '';
    const emoji  = { casa:'🏠', club:'🟢', bazar:'🛍️', tienda:'🏪' }[ctx] || '📋';
    const tokens = await getTokensForUser(uid);
    if (!tokens.length) return null;

    await sendToTokens(uid, tokens,
      `${emoji} Nueva tarea asignada`,
      after.text || 'Tienes una nueva tarea.',
      { taskId: event.params.taskId, type: 'task_assigned' }
    );
    return null;
  }
);

// ─────────────────────────────────────────────────────────────────────
// FUNCIÓN 3: onPermissionResolved — permiso respondido por padres
// ─────────────────────────────────────────────────────────────────────
exports.onPermissionResolved = onDocumentUpdated(
  { document: 'permission_requests/{reqId}', region: 'us-central1' },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();

    if (before.status === after.status) return null;
    if (!['approved','rejected'].includes(after.status)) return null;

    const uid = after.requesterId;
    if (!uid) return null;

    const isApproved = after.status === 'approved';
    const motivo     = after.motivo || 'tu solicitud';
    const note       = after.responseNote ? ` — "${after.responseNote.slice(0,60)}"` : '';
    const tokens     = await getTokensForUser(uid);
    if (!tokens.length) return null;

    await sendToTokens(uid, tokens,
      isApproved ? `✅ Permiso Aprobado` : `💙 Permiso Revisado`,
      `${motivo}${note}`,
      { reqId: event.params.reqId, type: 'permission_resolved', status: after.status }
    );
    return null;
  }
);
