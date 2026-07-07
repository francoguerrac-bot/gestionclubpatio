// api/send-notification.js — Vercel Serverless Function
// CERO dependencias externas: solo Node.js 20 built-ins (crypto.webcrypto + fetch global)
//
// Variables de entorno requeridas (Vercel → Settings → Environment Variables):
//   FIREBASE_PROJECT_ID   → gestion-de-personas-ce003
//   FIREBASE_CLIENT_EMAIL → firebase-adminsdk-...@....iam.gserviceaccount.com
//   FIREBASE_PRIVATE_KEY  → -----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n

'use strict';

const PROJECT_ID     = process.env.FIREBASE_PROJECT_ID || 'gestion-de-personas-ce003';
const APP_URL        = 'https://gestionclubpatio.vercel.app';
const WEB_API_KEY    = 'AIzaSyDxVCUM808BRJ-5_SAG4bkdmu4e8xbVQn8';
const DIRECTOR_EMAIL = 'francoguerrac@gmail.com';

// Acceso a WebCrypto (Node.js 18+)
const { subtle } = globalThis.crypto;

// Cache del access token entre requests (misma Lambda instance)
let _cachedAccessToken = null;
let _tokenExpiresAt    = 0;

// ─────────────────────────────────────────────────────────────────────────
// Extraer el cuerpo DER (base64 limpio) desde la FIREBASE_PRIVATE_KEY
//
// Maneja todos los formatos que puede generar Vercel al guardar env vars:
//   · \\n literales  →  saltos reales
//   · Comillas envolventes
//   · \r\n de Windows
//   · Base64 en una sola línea o con wrapping incorrecto
// ─────────────────────────────────────────────────────────────────────────
function extractDERFromPEM(rawEnvValue) {
  if (!rawEnvValue) {
    throw new Error('FIREBASE_PRIVATE_KEY no está configurada en Vercel → Settings → Environment Variables.');
  }

  // Paso 1: convertir \\n literales → saltos de línea reales
  let key = rawEnvValue.replace(/\\n/g, '\n');

  // Paso 2: normalizar line endings (Windows → Unix)
  key = key.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Paso 3: quitar comillas envolventes (si el usuario las incluyó al pegar)
  key = key.replace(/^['"]|['"]$/g, '').trim();

  // Paso 4: extraer el cuerpo base64 entre los markers PEM
  const match = key.match(/-----BEGIN ([A-Z ]+)-----\s*([\s\S]+?)\s*-----END ([A-Z ]+)-----/);
  if (!match) {
    const preview = key.slice(0, 50).replace(/\n/g, '↵');
    throw new Error(
      `Formato PEM inválido. Primeros 50 chars recibidos: "${preview}". ` +
      `La clave debe comenzar con -----BEGIN PRIVATE KEY----- y terminar con -----END PRIVATE KEY-----.`
    );
  }

  // Paso 5: devolver el base64 limpio (sin espacios ni saltos) — DER puro
  return match[2].replace(/\s+/g, '');
}

// ─────────────────────────────────────────────────────────────────────────
// Construir y firmar el JWT usando WebCrypto SubtleCrypto
//
// Por qué SubtleCrypto en lugar de crypto.createSign():
//   · importKey('pkcs8') importa el DER directamente — sin pasar por el
//     decoder PEM de OpenSSL 3.x que causa el error 1E08010C
//   · RSASSA-PKCS1-v1_5 + SHA-256 = RS256 (estándar JWT de Google)
// ─────────────────────────────────────────────────────────────────────────
async function buildJWT(clientEmail, keyBase64) {
  // Convertir base64 → bytes DER (estructura binaria de la clave PKCS#8)
  const derBytes   = Uint8Array.from(Buffer.from(keyBase64, 'base64'));

  // Importar como clave RSA PKCS#8 para firmar con SHA-256
  let privateKey;
  try {
    privateKey = await subtle.importKey(
      'pkcs8',
      derBytes,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,    // no exportable
      ['sign']
    );
  } catch (e) {
    throw new Error(
      `importKey falló: ${e.message}. ` +
      `La clave debe ser RSA PKCS#8 (BEGIN PRIVATE KEY). ` +
      `Si el error persiste, genera una nueva clave en Firebase Console → Cuentas de servicio.`
    );
  }

  // Construir header y payload del JWT
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

  const message   = `${header}.${payload}`;
  const sigBuffer = await subtle.sign('RSASSA-PKCS1-v1_5', privateKey, Buffer.from(message));
  const signature = Buffer.from(sigBuffer).toString('base64url');

  return `${message}.${signature}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Obtener access token de Google OAuth2 (con cache)
// ─────────────────────────────────────────────────────────────────────────
async function getGoogleAccessToken() {
  // Reutilizar token si sigue vigente (rota 1 min antes de expirar)
  if (_cachedAccessToken && Date.now() < _tokenExpiresAt - 60_000) {
    return _cachedAccessToken;
  }

  const email = process.env.FIREBASE_CLIENT_EMAIL;
  if (!email) throw new Error('FIREBASE_CLIENT_EMAIL no configurada.');

  // Extraer DER de la clave y firmar el JWT
  let keyBase64;
  try {
    keyBase64 = extractDERFromPEM(process.env.FIREBASE_PRIVATE_KEY);
  } catch (e) {
    throw new Error('[PEM] ' + e.message);
  }

  let jwt;
  try {
    jwt = await buildJWT(email, keyBase64);
  } catch (e) {
    throw new Error('[JWT] ' + e.message);
  }

  // Intercambiar JWT por access token
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await resp.json();

  if (!data.access_token) {
    throw new Error(`[OAuth2] ${data.error}: ${data.error_description || 'sin descripción'}`);
  }

  _cachedAccessToken = data.access_token;
  _tokenExpiresAt    = Date.now() + ((data.expires_in || 3600) * 1000);
  return _cachedAccessToken;
}

// ─────────────────────────────────────────────────────────────────────────
// Verificar Firebase ID token del usuario (Identity Toolkit REST API)
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
  return data.users[0]; // { localId: uid, email }
}

// ─────────────────────────────────────────────────────────────────────────
// Leer tokens FCM del usuario (Firestore REST API)
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
      notification: { title, body, channelId: 'gpc_default', defaultSound: true, defaultVibrateTimings: true },
      data: strData,
    },
    apns: {
      headers: { 'apns-priority': '10', 'apns-push-type': 'alert' },
      payload: {
        aps: { alert: { title, body }, sound: 'default', badge: 1, 'content-available': 1, 'mutable-content': 1 },
        ...strData,
      },
    },
    webpush: {
      headers: { Urgency: 'high', TTL: '86400' },
      notification: { title, body, icon: '/assets/Logo2.png', badge: '/assets/Logo2.png', vibrate: [200, 100, 200] },
      fcmOptions: { link: APP_URL },
      data: strData,
    },
    data: strData,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Enviar un mensaje FCM (REST API v1)
// ─────────────────────────────────────────────────────────────────────────
async function sendOneFCM(token, title, body, data, uid, accessToken) {
  const url  = `https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`;
  const resp = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body:    JSON.stringify({ message: buildFCMMessage(token, title, body, data, uid) }),
  });
  return resp.json();
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
  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    return res.status(503).json({
      success: false,
      error:   'Variables de entorno faltantes. Configura FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL y FIREBASE_PRIVATE_KEY en Vercel → Settings → Environment Variables.',
    });
  }

  // ── 2. Autenticar al llamador ──
  const authHeader = req.headers.authorization || '';
  const idToken    = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) {
    return res.status(401).json({ error: 'Falta header Authorization: Bearer <firebase-id-token>' });
  }

  let caller;
  try {
    caller = await verifyFirebaseIdToken(idToken);
  } catch (e) {
    return res.status(401).json({ success: false, error: 'Sesión inválida: ' + e.message });
  }

  // ── 3. Validar body ──
  const { userId, title, body, data = {} } = req.body || {};
  if (!userId || !title || !body) {
    return res.status(400).json({ error: 'Faltan campos: userId, title y body son requeridos' });
  }

  // ── 4. Control de acceso ──
  if (caller.localId !== userId && caller.email !== DIRECTOR_EMAIL) {
    return res.status(403).json({ error: 'No autorizado' });
  }

  // ── 5. Obtener access token de Google ──
  let accessToken;
  try {
    accessToken = await getGoogleAccessToken();
  } catch (e) {
    console.error('[API] Auth error:', e.message);
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
      reason:  'Sin tokens FCM: el usuario debe activar las notificaciones en la app (Panel → Notificaciones Push → Activar).',
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
      console.warn(`[API] Token[${i}]:`, r.reason?.message || JSON.stringify(r.value?.error));
    }
  });

  console.log(`[API] uid=${userId} sent=${sent}/${tokens.length}`);
  return res.status(200).json({ success: sent > 0, sent, failed, total: tokens.length });
};
