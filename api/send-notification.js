// api/send-notification.js — Vercel Serverless Function
// Variables de entorno requeridas en Vercel → Settings → Environment Variables:
//   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY

const admin = require('firebase-admin');

function getAdminApp() {
  if (admin.apps.length) return admin.app();
  return admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}

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
      notification: { title, body, channelId: 'gpc_default', defaultVibrateTimings: true, defaultSound: true },
      data: strData,
    },
    apns: {
      headers: { 'apns-priority': '10', 'apns-push-type': 'alert' },
      payload: { aps: { alert: { title, body }, badge: 1, sound: 'default', 'content-available': 1, 'mutable-content': 1 }, ...strData },
    },
    webpush: {
      headers: { Urgency: 'high', TTL: '86400' },
      notification: { title, body, icon: '/assets/Logo2.png', badge: '/assets/Logo2.png', requireInteraction: false, vibrate: [200, 100, 200] },
      fcmOptions: { link: APP_URL },
      data: strData,
    },
    data: strData,
  };
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Método no permitido' });

  // ── Verificar que las variables de entorno estén configuradas ──
  if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY) {
    return res.status(503).json({
      success: false,
      error:   'Servicio no configurado. Agrega FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL y FIREBASE_PRIVATE_KEY en Vercel → Settings → Environment Variables.',
      hint:    'Firebase Console → Configuración → Cuentas de servicio → Generar nueva clave privada',
    });
  }

  // ── Inicializar Firebase Admin (singleton por instancia) ──
  let app, db, messaging;
  try {
    app       = getAdminApp();
    db        = admin.firestore();
    messaging = admin.messaging();
  } catch (e) {
    console.error('[API] Error inicializando Firebase Admin:', e.message);
    return res.status(500).json({ success: false, error: 'Error de configuración Firebase: ' + e.message });
  }

  // ── Verificar Firebase ID Token del llamador ──
  const authHeader = (req.headers.authorization || '');
  const idToken    = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) {
    return res.status(401).json({ error: 'Se requiere Authorization: Bearer <firebase-id-token>' });
  }

  let callerUid, callerEmail;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    callerUid   = decoded.uid;
    callerEmail = decoded.email || '';
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido o expirado: ' + e.message });
  }

  // ── Validar body ──
  const { userId, title, body, data = {} } = req.body || {};
  if (!userId || !title || !body) {
    return res.status(400).json({ error: 'userId, title y body son requeridos' });
  }

  // ── Control de acceso: solo a sí mismo o si es Director ──
  const isDirector = callerEmail === 'francoguerrac@gmail.com';
  if (callerUid !== userId && !isDirector) {
    return res.status(403).json({ error: 'Solo puedes enviarte notificaciones a ti mismo' });
  }

  // ── Obtener tokens FCM del usuario (doc + subcolección) ──
  let tokens = [];
  try {
    const snap        = await db.collection('users').doc(userId).get();
    const fromDoc     = snap.exists ? (snap.data().fcmTokens || []).filter(Boolean) : [];
    const subSnap     = await db.collection('users').doc(userId).collection('tokens').get();
    const fromSub     = subSnap.docs.map(d => d.data().token).filter(Boolean);
    tokens            = [...new Set([...fromDoc, ...fromSub])];
  } catch (e) {
    return res.status(500).json({ error: 'Error leyendo tokens Firestore: ' + e.message });
  }

  if (!tokens.length) {
    return res.status(200).json({
      success: false,
      reason:  'El usuario no tiene tokens FCM. Debe activar notificaciones en la app primero.',
    });
  }

  // ── Enviar via FCM ──
  let response;
  try {
    const messages = tokens.map(t => buildMessage(t, title, body, data, userId));
    response       = await messaging.sendEach(messages);
  } catch (e) {
    return res.status(500).json({ error: 'Error FCM sendEach: ' + e.message });
  }

  // ── Limpiar tokens inválidos ──
  const invalid = response.responses
    .map((r, i) => ({ r, token: tokens[i] }))
    .filter(({ r }) => {
      const code = r.error?.code || '';
      return code.includes('not-registered') || code.includes('invalid-registration-token');
    })
    .map(({ token }) => token);

  if (invalid.length) {
    try {
      await db.collection('users').doc(userId).update({
        fcmTokens: admin.firestore.FieldValue.arrayRemove(...invalid),
      });
    } catch(e) { /* no crítico */ }
  }

  const sent   = response.responses.filter(r => r.success).length;
  const failed = tokens.length - sent;

  console.log(`[API] send-notification uid=${userId} sent=${sent} failed=${failed}`);

  return res.status(200).json({ success: sent > 0, sent, failed, invalidCleaned: invalid.length, total: tokens.length });
};
