// api/send-notification.js — Vercel Serverless Function
// CERO dependencias externas: usa solo Node.js 20 built-ins (crypto + fetch global)
// Variables de entorno requeridas en Vercel → Settings → Environment Variables:
//   FIREBASE_PROJECT_ID   → gestion-de-personas-ce003
//   FIREBASE_CLIENT_EMAIL → firebase-adminsdk-...@....iam.gserviceaccount.com
//   FIREBASE_PRIVATE_KEY  → -----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n

'use strict';
const crypto = require('crypto');

const PROJECT_ID  = process.env.FIREBASE_PROJECT_ID || 'gestion-de-personas-ce003';
const APP_URL     = 'https://gestionclubpatio.vercel.app';
const WEB_API_KEY = 'AIzaSyDxVCUM808BRJ-5_SAG4bkdmu4e8xbVQn8'; // Firebase Web config (público)
const DIRECTOR_EMAIL = 'francoguerrac@gmail.com';

// ── Cache del access token (persiste entre requests en la misma Lambda) ──
let _cachedAccessToken = null;
let _tokenExpiresAt    = 0;

// ─────────────────────────────────────────────────────────────────────────
// Sanitizador de clave PEM — robusto ante cualquier formato de Vercel
//
// Maneja todos los casos de copia/pegado:
//   · \\n literales (lo más común en Vercel env vars)
//   · Una sola línea sin saltos
//   · Con o sin comillas envolventes
//   · Saltos \r\n de Windows
//   · Base64 sin el wrapping de 64 chars que exige OpenSSL 3.x (Node 20)
// ─────────────────────────────────────────────────────────────────────────
function sanitizePEM(raw) {
  if (!raw) throw new Error('FIREBASE_PRIVATE_KEY no está configurada en las variables de entorno de Vercel.');

  // 1. Convertir \\n literales a saltos de línea reales
  let key = raw.replace(/\\n/g, '\n');

  // 2. Normalizar line endings (Windows → Unix)
  key = key.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 3. Quitar comillas envolventes (si el usuario las incluyó al pegar)
  key = key.replace(/^['"]|['"]$/g, '').trim();

  // 4. Extraer partes del PEM con regex flexible (ignora espacios extra)
  const match = key.match(/-----BEGIN ([A-Z ]+)-----\s*([\s\S]+?)\s*-----END ([A-Z ]+)-----/);

  if (!match) {
    // Log diagnóstico sin exponer la key completa
    const preview = key.slice(0, 40).replace(/\n/g, '↵');
    throw new Error(
      `FIREBASE_PRIVATE_KEY no tiene formato PEM válido. ` +
      `Inicio detectado: "${preview}...". ` +
      `Debe comenzar con -----BEGIN PRIVATE KEY----- y terminar con -----END PRIVATE KEY-----.`
    );
  }

  const type      = match[1].trim();
  const body      = match[2].trim();
  // 5. Eliminar todo espacio del cuerpo y re-envolver en líneas de 64 chars
  //    (OpenSSL 3.x / Node 20 es estricto con el wrapping del PEM base64)
  const cleanB64  = body.replace(/\s+/g, '');
  const wrapped   = (cleanB64.match(/.{1,64}/g) || []).join('\n');

  return `-----BEGIN ${type}-----\n${wrapped}\n-----END ${type}-----\n`;
}

// ─────────────────────────────────────────────────────────────────────────
// JWT + OAuth2 para autenticar el Service Account con Google
// ─────────────────────────────────────────────────────────────────────────
function buildJWT(clientEmail, privateKeyPem) {
  const now     = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss:   clientEmail,
    sub:   clientEmail,
    aud:  'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
    scope: 'https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/datastore',
  })).toString('base64url');

  const signer    = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKeyPem, 'base64url');
  return `${header}.${payload}.${signature}`;
}

async function getGoogleAccessToken() {
  if (_cachedAccessToken && Date.now() < _tokenExpiresAt - 60_000) {
    return _cachedAccessToken;
  }

  const email = process.env.FIREBASE_CLIENT_EMAIL;

  // Sanitizar y validar la clave antes de usarla
  let privateKey;
  try {
    privateKey = sanitizePEM(process.env.FIREBASE_PRIVATE_KEY);
  } catch (e) {
    throw new Error('[PEM] ' + e.message);
  }

  // Firmar el JWT — el error 1E08010C ocurre aquí si el PEM sigue malformado
  let jwt;
  try {
    jwt = buildJWT(email, privateKey);
  } catch (e) {
    throw new Error(
      `[JWT] Error firmando con la clave privada (${e.message}). ` +
      `Asegúrate de que la clave sea PKCS#8 RSA (BEGIN PRIVATE KEY, no BEGIN RSA PRIVATE KEY). ` +
      `Genera una nueva clave en Firebase Console → Cuentas de servicio si el problema persiste.`
    );
  }

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await resp.json();

  if (!data.access_token) {
    throw new Error(`OAuth2 falló: ${data.error} — ${data.error_description || ''}`);
  }

  _cachedAccessToken = data.access_token;
  _tokenExpiresAt    = Date.now() + ((data.expires_in || 3600) * 1000);
  return _cachedAccessToken;
}

// ─────────────────────────────────────────────────────────────────────────
// Verificar Firebase ID token (Firebase Identity Toolkit REST API)
// ─────────────────────────────────────────────────────────────────────────
async function verifyFirebaseIdToken(idToken) {
  const url  = `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${WEB_API_KEY}`;
  const resp = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ idToken }),
  });
  const data = await resp.json();

  if (data.error || !data.users?.[0]) {
    throw new Error(data.error?.message || 'Token de sesión inválido o expirado');
  }
  // Retorna { localId: uid, email, ... }
  return data.users[0];
}

// ─────────────────────────────────────────────────────────────────────────
// Leer tokens FCM desde Firestore REST API
// ─────────────────────────────────────────────────────────────────────────
async function getFCMTokensForUser(uid, accessToken) {
  const BASE    = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
  const headers = { Authorization: `Bearer ${accessToken}` };

  // Documento principal: users/{uid}.fcmTokens[]
  const docResp = await fetch(`${BASE}/users/${encodeURIComponent(uid)}`, { headers });
  const doc     = await docResp.json();
  const fromDoc = (doc.fields?.fcmTokens?.arrayValue?.values || [])
    .map(v => v.stringValue).filter(Boolean);

  // Subcolección: users/{uid}/tokens/
  const subResp = await fetch(`${BASE}/users/${encodeURIComponent(uid)}/tokens`, { headers });
  const subData = await subResp.json();
  const fromSub = (subData.documents || [])
    .map(d => d.fields?.token?.stringValue).filter(Boolean);

  return [...new Set([...fromDoc, ...fromSub])];
}

// ─────────────────────────────────────────────────────────────────────────
// Construir mensaje FCM con alta prioridad (Android + iOS + Web)
// ─────────────────────────────────────────────────────────────────────────
function buildFCMMessage(token, title, body, extraData, uid) {
  const strData = Object.fromEntries(
    Object.entries({ ...extraData, userId: uid, link: APP_URL })
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
        defaultSound:      true,
        defaultVibrateTimings: true,
      },
      data: strData,
    },
    apns: {
      headers: { 'apns-priority': '10', 'apns-push-type': 'alert' },
      payload: {
        aps: {
          alert:             { title, body },
          sound:             'default',
          badge:             1,
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
        vibrate: [200, 100, 200],
      },
      fcmOptions: { link: APP_URL },
      data: strData,
    },
    data: strData,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Enviar un mensaje FCM via REST API v1
// ─────────────────────────────────────────────────────────────────────────
async function sendOneFCM(token, title, body, data, uid, accessToken) {
  const url  = `https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`;
  const resp = await fetch(url, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ message: buildFCMMessage(token, title, body, data, uid) }),
  });
  return resp.json(); // { name: "projects/.../messages/..." } en éxito, o { error: {...} }
}

// ─────────────────────────────────────────────────────────────────────────
// HANDLER PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Método no permitido' });

  // ── 1. Verificar variables de entorno ──
  if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY) {
    return res.status(503).json({
      success: false,
      error:   'Variables de entorno faltantes: configura FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL y FIREBASE_PRIVATE_KEY en Vercel → Settings → Environment Variables.',
    });
  }

  // ── 2. Autenticar al llamador con su Firebase ID token ──
  const authHeader = req.headers.authorization || '';
  const idToken    = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) {
    return res.status(401).json({ error: 'Falta header: Authorization: Bearer <firebase-id-token>' });
  }

  let caller;
  try {
    caller = await verifyFirebaseIdToken(idToken);
  } catch (e) {
    return res.status(401).json({ success: false, error: 'Sesión inválida: ' + e.message });
  }

  // ── 3. Validar cuerpo de la request ──
  const { userId, title, body, data = {} } = req.body || {};
  if (!userId || !title || !body) {
    return res.status(400).json({ error: 'Faltan campos: userId, title y body son requeridos' });
  }

  // ── 4. Control de acceso ──
  if (caller.localId !== userId && caller.email !== DIRECTOR_EMAIL) {
    return res.status(403).json({ error: 'No autorizado: solo puedes enviarte notificaciones a ti mismo' });
  }

  // ── 5. Obtener access token de Google para Firestore y FCM ──
  let accessToken;
  try {
    accessToken = await getGoogleAccessToken();
  } catch (e) {
    console.error('[API] OAuth2 error:', e.message);
    return res.status(500).json({ success: false, error: 'Error de autenticación con Google: ' + e.message });
  }

  // ── 6. Leer tokens FCM del destinatario ──
  let tokens;
  try {
    tokens = await getFCMTokensForUser(userId, accessToken);
  } catch (e) {
    console.error('[API] Firestore error:', e.message);
    return res.status(500).json({ success: false, error: 'Error leyendo Firestore: ' + e.message });
  }

  if (!tokens.length) {
    return res.status(200).json({
      success: false,
      reason:  'Sin tokens FCM: el usuario debe activar las notificaciones en la app primero (Notificaciones Push → Activar).',
    });
  }

  // ── 7. Enviar a todos los tokens en paralelo ──
  const results = await Promise.allSettled(
    tokens.map(t => sendOneFCM(t, title, body, data, userId, accessToken))
  );

  let sent = 0, failed = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value?.name) {
      sent++;
    } else {
      failed++;
      const errMsg = r.reason?.message || r.value?.error?.message || r.value?.error?.status || 'desconocido';
      console.warn(`[API] Token[${i}] error:`, errMsg);
    }
  });

  console.log(`[API] uid=${userId} sent=${sent}/${tokens.length} failed=${failed}`);

  return res.status(200).json({
    success: sent > 0,
    sent,
    failed,
    total: tokens.length,
  });
};
