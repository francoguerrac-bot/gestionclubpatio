// api/send-notification.js — Vercel Serverless Function
// CERO dependencias externas: solo Node.js 20 built-ins (crypto.webcrypto + fetch global)
//
// Variable de entorno recomendada (Vercel → Settings → Environment Variables):
//
//   FIREBASE_SERVICE_ACCOUNT_B64
//     → Base64 del archivo JSON completo del Service Account.
//     → Genera el valor con este comando en PowerShell (en la carpeta del JSON):
//         node -e "process.stdout.write(require('fs').readFileSync('NOMBRE_ARCHIVO.json').toString('base64'))"
//     → Copia la salida y pégala como valor de FIREBASE_SERVICE_ACCOUNT_B64 en Vercel.
//
// (Alternativa legacy — problemática con copy-paste):
//   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY

'use strict';

const APP_URL        = 'https://gestionclubpatio.vercel.app';
const WEB_API_KEY    = 'AIzaSyDxVCUM808BRJ-5_SAG4bkdmu4e8xbVQn8';
const DIRECTOR_EMAIL = 'francoguerrac@gmail.com';

// Acceso a WebCrypto (Node.js 18+ built-in)
const { subtle } = globalThis.crypto;

// Cache del access token entre requests (misma Lambda instance)
let _cachedAccessToken = null;
let _tokenExpiresAt    = 0;
let _projectId         = null;

// ─────────────────────────────────────────────────────────────────────────
// Cargar credenciales del Service Account
//
// Prioridad 1: FIREBASE_SERVICE_ACCOUNT_B64 (base64 del JSON completo)
//   → JSON.parse maneja todos los \n correctamente — sin problemas de formato
//
// Prioridad 2: FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY (legacy)
//   → Propenso a corrupción por copy-paste; usar solo como fallback
// ─────────────────────────────────────────────────────────────────────────
function loadCredentials() {
  // ── Prioridad 1: JSON completo en base64 ──────────────────────────────
  if (process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
    let json;
    try {
      const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8');
      json = JSON.parse(decoded);
    } catch (e) {
      throw new Error(
        'FIREBASE_SERVICE_ACCOUNT_B64 no es JSON válido en base64: ' + e.message +
        '. Regenera el valor con: node -e "process.stdout.write(require(\'fs\').readFileSync(\'SERVICE_ACCOUNT.json\').toString(\'base64\'))"'
      );
    }
    if (!json.private_key || !json.client_email || !json.project_id) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_B64 no contiene los campos requeridos (private_key, client_email, project_id).');
    }
    // JSON.parse convierte \n → saltos reales — la clave ya está en formato correcto
    return {
      projectId:   json.project_id,
      clientEmail: json.client_email,
      privateKey:  json.private_key,  // string PEM con newlines reales
    };
  }

  // ── Prioridad 2: variables individuales (legacy) ──────────────────────
  const projectId   = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const rawKey      = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !rawKey) {
    throw new Error(
      'Configura FIREBASE_SERVICE_ACCOUNT_B64 en Vercel → Settings → Environment Variables. ' +
      'Instrucciones: node -e "process.stdout.write(require(\'fs\').readFileSync(\'SERVICE_ACCOUNT.json\').toString(\'base64\'))"'
    );
  }

  // Sanitizar la clave en caso de que use el método legacy
  let key = rawKey
    .replace(/\\n/g, '\n')    // \\n literal → salto real
    .replace(/\r\n/g, '\n')   // Windows → Unix
    .replace(/\r/g, '\n')
    .replace(/^['"]|['"]$/g, '') // comillas envolventes
    .trim();

  return { projectId, clientEmail, privateKey: key };
}

// ─────────────────────────────────────────────────────────────────────────
// Extraer bytes DER desde un string PEM (con newlines reales)
// ─────────────────────────────────────────────────────────────────────────
function pemToDER(pemString) {
  const match = pemString.match(/-----BEGIN ([A-Z ]+)-----\s*([\s\S]+?)\s*-----END ([A-Z ]+)-----/);
  if (!match) {
    const preview = pemString.slice(0, 60).replace(/\n/g, '↵');
    throw new Error(`PEM inválido. Inicio: "${preview}". Debe comenzar con -----BEGIN PRIVATE KEY-----.`);
  }
  const cleanBase64 = match[2].replace(/\s+/g, '');
  return Buffer.from(cleanBase64, 'base64');
}

// ─────────────────────────────────────────────────────────────────────────
// Firmar JWT con WebCrypto SubtleCrypto (importKey PKCS#8 DER directo)
// ─────────────────────────────────────────────────────────────────────────
async function buildJWT(clientEmail, pemString) {
  const derBytes = pemToDER(pemString);

  let privateKey;
  try {
    privateKey = await subtle.importKey(
      'pkcs8',
      derBytes,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );
  } catch (e) {
    throw new Error(
      `subtle.importKey falló: ${e.message}. ` +
      `Usa FIREBASE_SERVICE_ACCOUNT_B64 en lugar de FIREBASE_PRIVATE_KEY para evitar problemas de formato.`
    );
  }

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
  return `${message}.${Buffer.from(sigBuffer).toString('base64url')}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Obtener access token de Google OAuth2 (con cache)
// ─────────────────────────────────────────────────────────────────────────
async function getGoogleAccessToken() {
  if (_cachedAccessToken && Date.now() < _tokenExpiresAt - 60_000) {
    return _cachedAccessToken;
  }

  let creds;
  try {
    creds = loadCredentials();
  } catch (e) {
    throw new Error('[Config] ' + e.message);
  }

  _projectId = creds.projectId; // guardar para usarlo en las llamadas a Firestore/FCM

  let jwt;
  try {
    jwt = await buildJWT(creds.clientEmail, creds.privateKey);
  } catch (e) {
    throw new Error('[JWT] ' + e.message);
  }

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await resp.json();

  if (!data.access_token) {
    throw new Error(`[OAuth2] ${data.error}: ${data.error_description || ''}`);
  }

  _cachedAccessToken = data.access_token;
  _tokenExpiresAt    = Date.now() + ((data.expires_in || 3600) * 1000);
  return _cachedAccessToken;
}

// ─────────────────────────────────────────────────────────────────────────
// Verificar Firebase ID token (Identity Toolkit REST API)
// ─────────────────────────────────────────────────────────────────────────
async function verifyFirebaseIdToken(idToken) {
  const resp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${WEB_API_KEY}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ idToken }),
    }
  );
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
  const projectId = _projectId || process.env.FIREBASE_PROJECT_ID || 'gestion-de-personas-ce003';
  const BASE      = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const headers   = { Authorization: `Bearer ${accessToken}` };

  const docResp = await fetch(`${BASE}/users/${encodeURIComponent(uid)}`, { headers });
  const doc     = await docResp.json();
  const fromDoc = (doc.fields?.fcmTokens?.arrayValue?.values || [])
    .map(v => v.stringValue).filter(Boolean);

  const subResp = await fetch(`${BASE}/users/${encodeURIComponent(uid)}/tokens`, { headers });
  const subData = await subResp.json();
  const fromSub = (subData.documents || [])
    .map(d => d.fields?.token?.stringValue).filter(Boolean);

  return [...new Set([...fromDoc, ...fromSub])];
}

// ─────────────────────────────────────────────────────────────────────────
// Construir mensaje FCM
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
  const projectId = _projectId || process.env.FIREBASE_PROJECT_ID || 'gestion-de-personas-ce003';
  const resp      = await fetch(
    `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body:    JSON.stringify({ message: buildFCMMessage(token, title, body, data, uid) }),
    }
  );
  return resp.json();
}

// ─────────────────────────────────────────────────────────────────────────
// HANDLER PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Método no permitido' });

  // ── 1. Verificar que hay alguna configuración de credenciales ──
  const hasB64    = !!process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  const hasLegacy = !!(process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY);
  if (!hasB64 && !hasLegacy) {
    return res.status(503).json({
      success: false,
      error:   'Configura FIREBASE_SERVICE_ACCOUNT_B64 en Vercel → Settings → Environment Variables.',
      hint:    'Comando: node -e "process.stdout.write(require(\'fs\').readFileSync(\'SERVICE_ACCOUNT.json\').toString(\'base64\'))"',
    });
  }

  // ── 2. Verificar Firebase ID token del llamador ──
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
    return res.status(500).json({ success: false, error: e.message });
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
      reason:  'Sin tokens FCM: activa las notificaciones en la app primero.',
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
