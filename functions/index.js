/**
 * Firebase Cloud Functions — Gestión de Equipos Patio Curauma
 *
 * FUNCIONES:
 *   sendNotificationToUser  — HTTP callable: envía push a un usuario por UID
 *   onTaskAssigned          — Firestore trigger: notifica cuando cambia assignedToUid
 *   onPermissionResolved    — Firestore trigger: notifica al hijo cuando papá/mamá responde
 */

const { onCall, HttpsError }      = require('firebase-functions/v2/https');
const { onDocumentUpdated }        = require('firebase-functions/v2/firestore');
const { initializeApp }            = require('firebase-admin/app');
const { getFirestore }             = require('firebase-admin/firestore');
const { getMessaging }             = require('firebase-admin/messaging');

initializeApp();
const db        = getFirestore();
const messaging = getMessaging();

// ─────────────────────────────────────────────
// UTILIDAD: obtener tokens FCM de un usuario
// Los tokens se guardan en /users/{uid}/fcmTokens (array)
// ─────────────────────────────────────────────
async function getTokensForUser(uid) {
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) return [];
  const data = snap.data();
  const tokens = data.fcmTokens || [];
  return tokens.filter(Boolean);
}

// ─────────────────────────────────────────────
// UTILIDAD: enviar push a lista de tokens
// Limpia tokens inválidos automáticamente
// ─────────────────────────────────────────────
async function sendToTokens(tokens, title, body, data = {}) {
  if (!tokens.length) return { sent: 0, failed: 0 };

  const message = {
    notification: { title, body },
    webpush: {
      notification: {
        title,
        body,
        icon:  '/assets/Logo2.png',
        badge: '/assets/Logo2.png',
        requireInteraction: false,
        vibrate: [200, 100, 200],
      },
      fcmOptions: { link: '/' }
    },
    data: Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, String(v)])
    ),
    tokens
  };

  const response = await messaging.sendEachForMulticast(message);

  // Limpiar tokens inválidos (registros caducados)
  const invalidTokens = [];
  response.responses.forEach((res, i) => {
    if (!res.success) {
      const code = res.error?.code;
      if (
        code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token'
      ) {
        invalidTokens.push(tokens[i]);
      }
    }
  });

  if (invalidTokens.length) {
    console.log('[FCM] Limpiando tokens inválidos:', invalidTokens.length);
    // Se puede hacer una búsqueda por token en /users si se necesita cleanup global
  }

  return { sent: response.successCount, failed: response.failureCount };
}

// ─────────────────────────────────────────────
// FUNCIÓN 1: HTTP Callable
// Uso desde el cliente:
//   const sendNotification = httpsCallable(functions, 'sendNotificationToUser');
//   await sendNotification({ userId, title, body, data });
// ─────────────────────────────────────────────
exports.sendNotificationToUser = onCall(
  { region: 'us-central1' },
  async (request) => {
    // Solo usuarios autenticados pueden llamar esta función
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

    const result = await sendToTokens(tokens, title, body, data);
    console.log(`[FCM] sendNotificationToUser → uid=${userId} sent=${result.sent}`);
    return { success: true, ...result };
  }
);

// ─────────────────────────────────────────────
// FUNCIÓN 2: Trigger — tarea reasignada
// Dispara cuando cambia assignedToUid en /tasks/{taskId}
// ─────────────────────────────────────────────
exports.onTaskAssigned = onDocumentUpdated(
  { document: 'tasks/{taskId}', region: 'us-central1' },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();

    // Solo actuar si assignedToUid cambió
    if (before.assignedToUid === after.assignedToUid) return null;

    const newUid = after.assignedToUid;
    if (!newUid) return null;

    const taskText  = after.text  || 'Nueva tarea';
    const taskCtx   = after.ctx   || '';
    const ctxEmoji  = { casa:'🏠', club:'🟢', bazar:'🛍️', tienda:'🏪' }[taskCtx] || '📋';

    const tokens = await getTokensForUser(newUid);
    if (!tokens.length) return null;

    await sendToTokens(
      tokens,
      `${ctxEmoji} Nueva tarea asignada`,
      taskText,
      { taskId: event.params.taskId, type: 'task_assigned' }
    );

    console.log(`[FCM] onTaskAssigned → uid=${newUid} task="${taskText}"`);
    return null;
  }
);

// ─────────────────────────────────────────────
// FUNCIÓN 3: Trigger — permiso respondido
// Dispara cuando status cambia en /permission_requests/{reqId}
// ─────────────────────────────────────────────
exports.onPermissionResolved = onDocumentUpdated(
  { document: 'permission_requests/{reqId}', region: 'us-central1' },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();

    // Solo actuar si el status cambió de pending/evaluating a resolved
    const resolved = ['approved', 'rejected'];
    if (before.status === after.status) return null;
    if (!resolved.includes(after.status)) return null;

    const requesterUid = after.requesterId;
    if (!requesterUid) return null;

    const motivo   = after.motivo || 'tu solicitud';
    const isApproved = after.status === 'approved';
    const icon     = isApproved ? '✅' : '💙';
    const statusTx = isApproved ? '¡APROBADO!' : 'Revisada';
    const note     = after.responseNote ? `"${after.responseNote.slice(0, 60)}"` : '';

    const tokens = await getTokensForUser(requesterUid);
    if (!tokens.length) return null;

    await sendToTokens(
      tokens,
      `${icon} Permiso ${statusTx}`,
      `${motivo}${note ? ' — ' + note : ''}`,
      { reqId: event.params.reqId, type: 'permission_resolved', status: after.status }
    );

    console.log(`[FCM] onPermissionResolved → uid=${requesterUid} status=${after.status}`);
    return null;
  }
);
