// api/send-notification.js — Vercel Serverless Function
// Envía notificaciones FCM usando Firebase Admin SDK (sin necesitar Firebase Functions)
// Variables de entorno requeridas en Vercel:
//   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY

const admin = require('firebase-admin');

// Singleton — se inicializa solo una vez por instancia de la función
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Vercel env vars escapan \n como \\n — esto lo restaura
      privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}

const db        = admin.firestore();
const messaging = admin.messaging();

// ── Construir payload FCM con alta prioridad (idéntico a functions/index.js) ──
function buildMessage(token, title, body, data, uid) {
  const APP_URL = 'https://gestionclubpatio.vercel.app';
  const strData = Object.fromEntries(
    Object.entries({ ...data, userId: uid, link: APP_URL })
      .map(([k, v]) => [k, String(v)])
  );

  return {
    token,
    notification: { title, body },
    android: {
      priority: 'high',
      notification: {
        title, body,
        channelId:         'gpc_default',
        defaultVibrateTimings: true,
        defaultSound:      true,
      },
      data: strData,
    },
    apns: {
      headers: { 'apns-priority': '10', 'apns-push-type': 'alert' },
      payload: {
        aps: {
          alert:             { title, body },
          badge:             1,
          sound:             'default',
          'content-available': 1,
          'mutable-content':   1,
        },
        ...strData,
      },
    },
    webpush: {
      headers: { Urgency: 'high', TTL: '86400' },
      notification: {
        title, body,
        icon:    '/assets/Logo2.png',
        badge:   '/assets/Logo2.png',
        requireInteraction: false,
        vibrate: [200, 100, 200],
      },
      fcmOptions: { link: APP_URL },
      data: strData,
    },
    data: strData,
  };
}

// ── Obtener todos los FCM tokens de un usuario (doc + subcolección) ──
async function getTokensForUser(uid) {
  const snap  = await db.collection('users').doc(uid).get();
  if (!snap.exists) return [];

  const tokensFromDoc = (snap.data().fcmTokens || []).filter(Boolean);

  const subSnap = await db.collection('users').doc(uid).collection('tokens').get();
  const tokensFromSub = subSnap.docs.map(d => d.data().token).filter(Boolean);

  return [...new Set([...tokensFromDoc, ...tokensFromSub])];
}

// ── Limpiar tokens inválidos de Firestore ──
async function cleanInvalidTokens(uid, invalid) {
  if (!invalid.length) return;
  try {
    await db.collection('users').doc(uid).update({
      fcmTokens: admin.firestore.FieldValue.arrayRemove(...invalid),
    });
    const subSnap = await db.collection('users').doc(uid).collection('tokens').get();
    const batch   = db.batch();
    subSnap.docs.forEach(d => { if (invalid.includes(d.data().token)) batch.delete(d.ref); });
    await batch.commit();
  } catch (e) {
    console.warn('[API] cleanInvalidTokens error:', e.message);
  }
}

// ── Handler principal ──────────────────────────────────────────────────
module.exports = async (req, res) => {

  // CORS (mismo dominio en producción, útil en dev local)
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Método no permitido' });

  // ── 1. Verificar Firebase ID Token del llamador ──
  const authHeader = req.headers.authorization || '';
  const idToken    = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!idToken) {
    return res.status(401).json({ error: 'Se requiere Authorization: Bearer <firebase-id-token>' });
  }

  let callerUid, callerEmail;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    callerUid    = decoded.uid;
    callerEmail  = decoded.email || '';
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido o expirado: ' + e.message });
  }

  // ── 2. Validar body ──
  const { userId, title, body, data = {} } = req.body || {};
  if (!userId || !title || !body) {
    return res.status(400).json({ error: 'userId, title y body son requeridos' });
  }

  // ── 3. Control de acceso: solo puede enviarse a sí mismo o si es Director ──
  const DIRECTOR_EMAIL = 'francoguerrac@gmail.com';
  const isDirector     = callerEmail === DIRECTOR_EMAIL;
  if (callerUid !== userId && !isDirector) {
    return res.status(403).json({ error: 'Solo puedes enviarte notificaciones a ti mismo' });
  }

  // ── 4. Obtener tokens del destinatario ──
  let tokens;
  try {
    tokens = await getTokensForUser(userId);
  } catch (e) {
    console.error('[API] Error leyendo tokens:', e.message);
    return res.status(500).json({ error: 'Error leyendo tokens: ' + e.message });
  }

  if (!tokens.length) {
    return res.status(200).json({
      success: false,
      reason:  'El usuario no tiene tokens FCM. Debe activar notificaciones en la app.',
    });
  }

  // ── 5. Enviar via FCM ──
  const messages = tokens.map(t => buildMessage(t, title, body, data, userId));
  let response;
  try {
    response = await messaging.sendEach(messages);
  } catch (e) {
    console.error('[API] messaging.sendEach error:', e.message);
    return res.status(500).json({ error: 'Error FCM: ' + e.message });
  }

  // ── 6. Limpiar tokens inválidos automáticamente ──
  const invalid = response.responses
    .map((r, i) => ({ r, token: tokens[i] }))
    .filter(({ r }) => {
      const code = r.error?.code || '';
      return code.includes('not-registered') || code.includes('invalid-registration-token');
    })
    .map(({ token }) => token);

  if (invalid.length) await cleanInvalidTokens(userId, invalid);

  const sent   = response.responses.filter(r => r.success).length;
  const failed = tokens.length - sent;

  console.log(`[API] send-notification uid=${userId} sent=${sent} failed=${failed} tokens=${tokens.length}`);

  return res.status(200).json({
    success:        sent > 0,
    sent,
    failed,
    invalidCleaned: invalid.length,
    total:          tokens.length,
  });
};
