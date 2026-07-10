// api/cron-reminders.js — Vercel Cron Job: recordatorios por fecha de vencimiento
//
// Variables de entorno requeridas (Vercel → Settings → Environment Variables):
//   FIREBASE_SERVICE_ACCOUNT_B64   Base64 del service account JSON (igual que send-notification.js)
//   CRON_SECRET                    Vercel lo genera y lo inyecta automáticamente en Cron Jobs
//
// Vercel añade "Authorization: Bearer <CRON_SECRET>" en cada llamada automática.
// Cualquier petición externa (navegador, curl) sin el secret exacto recibe 401.
//
// Schedule en vercel.json: "0 12 * * *"
//   → 12:00 UTC = 09:00 Chile hora estándar (UTC-3, mayo-agosto)
//   → 12:00 UTC = 08:00 Chile hora de verano (UTC-4, octubre-marzo)
//   Ajusta a "0 13 * * *" si prefieres garantizar las 09:00 todo el año.

'use strict';

const APP_URL            = 'https://gestionclubpatio.vercel.app';
const PROJECT_ID_DEFAULT = 'gestion-de-personas-ce003';
const { subtle }         = globalThis.crypto;

// Cache inter-request (misma Lambda instance)
let _cachedToken = null;
let _tokenExp    = 0;
let _projectId   = null;

// ─────────────────────────────────────────────────────────────────────────
// Auth: mismo flujo JWT que send-notification.js (sin dependencias externas)
// ─────────────────────────────────────────────────────────────────────────
function loadCredentials() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
    let json;
    try {
      json = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8'));
    } catch (e) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_B64 no es JSON base64 válido: ' + e.message);
    }
    if (!json.private_key || !json.client_email || !json.project_id) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_B64 incompleto (faltan private_key / client_email / project_id).');
    }
    return { projectId: json.project_id, clientEmail: json.client_email, privateKey: json.private_key };
  }
  const { FIREBASE_PROJECT_ID: p, FIREBASE_CLIENT_EMAIL: c, FIREBASE_PRIVATE_KEY: k } = process.env;
  if (!p || !c || !k) throw new Error('Configura FIREBASE_SERVICE_ACCOUNT_B64 en Vercel → Environment Variables.');
  return {
    projectId:   p,
    clientEmail: c,
    privateKey:  k.replace(/\\n/g, '\n').replace(/^['"]|['"]$/g, '').trim(),
  };
}

function pemToDER(pem) {
  const m = pem.match(/-----BEGIN ([A-Z ]+)-----\s*([\s\S]+?)\s*-----END ([A-Z ]+)-----/);
  if (!m) throw new Error('PEM inválido — debe comenzar con -----BEGIN PRIVATE KEY-----');
  return Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
}

async function buildJWT(clientEmail, pem) {
  const key = await subtle.importKey(
    'pkcs8', pemToDER(pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const now     = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: clientEmail, sub: clientEmail,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/datastore',
  })).toString('base64url');
  const sig = await subtle.sign('RSASSA-PKCS1-v1_5', key, Buffer.from(`${header}.${payload}`));
  return `${header}.${payload}.${Buffer.from(sig).toString('base64url')}`;
}

async function getAccessToken() {
  if (_cachedToken && Date.now() < _tokenExp - 60_000) return _cachedToken;
  const creds = loadCredentials();
  _projectId  = creds.projectId;
  const jwt   = await buildJWT(creds.clientEmail, creds.privateKey);
  const res   = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`OAuth2: ${data.error} — ${data.error_description || ''}`);
  _cachedToken = data.access_token;
  _tokenExp    = Date.now() + (data.expires_in || 3600) * 1000;
  return _cachedToken;
}

// ─────────────────────────────────────────────────────────────────────────
// Firestore helpers
// ─────────────────────────────────────────────────────────────────────────
function pid()           { return _projectId || process.env.FIREBASE_PROJECT_ID || PROJECT_ID_DEFAULT; }
function fsBase()        { return `https://firestore.googleapis.com/v1/projects/${pid()}/databases/(default)/documents`; }
function authHdr(token)  { return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }; }

// Firestore typed value → valor JS
function fromField(f) {
  if (!f) return undefined;
  if ('stringValue'    in f) return f.stringValue;
  if ('booleanValue'   in f) return f.booleanValue;
  if ('integerValue'   in f) return Number(f.integerValue);
  if ('doubleValue'    in f) return f.doubleValue;
  if ('timestampValue' in f) return new Date(f.timestampValue);
  if ('arrayValue'     in f) return (f.arrayValue.values || []).map(fromField);
  if ('nullValue'      in f) return null;
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// Consultar tareas pendientes cuyo dueDate vence dentro de las próximas 24h
//
// Estrategia de query:
//   - Un único fieldFilter por dueDate (no requiere índice compuesto)
//   - done y reminderSent se filtran en memoria (array pequeño en org familiar)
// ─────────────────────────────────────────────────────────────────────────
async function fetchPendingTasks(accessToken) {
  const cutoff = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // ahora + 24 h

  const query = {
    structuredQuery: {
      from: [{ collectionId: 'tasks' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'dueDate' },
          op: 'LESS_THAN_OR_EQUAL',
          value: { timestampValue: cutoff },
        },
      },
    },
  };

  const resp = await fetch(`${fsBase()}:runQuery`, {
    method:  'POST',
    headers: authHdr(accessToken),
    body:    JSON.stringify(query),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Firestore runQuery ${resp.status}: ${txt.slice(0, 200)}`);
  }

  const rows = await resp.json();

  return (Array.isArray(rows) ? rows : [])
    .filter(row => row.document)
    .map(row => {
      const f = row.document.fields || {};
      return {
        id:            row.document.name.split('/').pop(),
        title:         fromField(f.title)         || '(sin título)',
        assignedToUid: fromField(f.assignedToUid) || null,
        reminderSent:  fromField(f.reminderSent)  ?? false,
        done:          fromField(f.done)           ?? false,
        prio:          fromField(f.prio)           || 'p3',
        dueDate:       fromField(f.dueDate),        // Date | undefined
        _docName:      row.document.name,            // recurso completo para PATCH
      };
    })
    // Filtro en memoria: solo tareas activas sin recordatorio previo
    .filter(t => !t.done && !t.reminderSent);
}

// ─────────────────────────────────────────────────────────────────────────
// Leer tokens FCM del usuario (doc principal + subcolección /tokens)
// ─────────────────────────────────────────────────────────────────────────
async function getTokensForUser(uid, accessToken) {
  const base = fsBase();
  const hdrs = { Authorization: `Bearer ${accessToken}` };

  const [docRes, subRes] = await Promise.all([
    fetch(`${base}/users/${encodeURIComponent(uid)}`, { headers: hdrs }),
    fetch(`${base}/users/${encodeURIComponent(uid)}/tokens`, { headers: hdrs }),
  ]);

  const docData = await docRes.json();
  const subData = await subRes.json();

  const fromDoc = (docData.fields?.fcmTokens?.arrayValue?.values || [])
    .map(v => v.stringValue).filter(Boolean);
  const fromSub = (subData.documents || [])
    .map(d => d.fields?.token?.stringValue).filter(Boolean);

  return [...new Set([...fromDoc, ...fromSub])];
}

// ─────────────────────────────────────────────────────────────────────────
// Enviar un mensaje FCM (REST v1) — mismo formato que send-notification.js
// ─────────────────────────────────────────────────────────────────────────
async function sendOneFCM(token, title, body, extraData, uid, accessToken) {
  const deepLink = `${APP_URL}?gpc=task&id=${extraData.taskId || ''}`;
  const strData  = Object.fromEntries(
    Object.entries({ ...extraData, userId: uid, link: deepLink, gpc_link: deepLink })
      .map(([k, v]) => [k, String(v)])
  );

  const message = {
    token,
    notification: { title, body },
    android: {
      priority: 'high',
      notification: {
        title, body,
        channelId:              'gpc_default',
        defaultSound:           true,
        defaultVibrateTimings:  true,
      },
      data: strData,
    },
    apns: {
      headers: { 'apns-priority': '10', 'apns-push-type': 'alert' },
      payload: {
        aps: { alert: { title, body }, sound: 'default', badge: 1, 'content-available': 1 },
        ...strData,
      },
    },
    webpush: {
      headers: { Urgency: 'high', TTL: '86400' },
      // Sin webpush.notification → data-only → pasa por onBackgroundMessage en el SW
      fcmOptions: { link: deepLink },
      data: strData,
    },
    data: strData,
  };

  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${pid()}/messages:send`,
    {
      method:  'POST',
      headers: authHdr(accessToken),
      body:    JSON.stringify({ message }),
    }
  );
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────────
// Marcar reminderSent = true (solo esos campos, no sobrescribe el documento)
// ─────────────────────────────────────────────────────────────────────────
async function markReminderSent(docName, accessToken) {
  const url = `https://firestore.googleapis.com/v1/${docName}` +
              '?updateMask.fieldPaths=reminderSent&updateMask.fieldPaths=reminderSentAt';

  const res = await fetch(url, {
    method:  'PATCH',
    headers: authHdr(accessToken),
    body: JSON.stringify({
      fields: {
        reminderSent:   { booleanValue: true },
        reminderSentAt: { timestampValue: new Date().toISOString() },
      },
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`PATCH reminderSent ${res.status}: ${txt.slice(0, 120)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Limpiar token FCM obsoleto (UNREGISTERED) de Firestore
// ─────────────────────────────────────────────────────────────────────────
async function removeStaleToken(uid, staleToken, accessToken) {
  const base      = fsBase();
  const tokenHash = staleToken.slice(-20);

  await Promise.allSettled([
    fetch(`${base}:batchWrite`, {
      method:  'POST',
      headers: authHdr(accessToken),
      body: JSON.stringify({
        writes: [{
          transform: {
            document: `projects/${pid()}/databases/(default)/documents/users/${uid}`,
            fieldTransforms: [{
              fieldPath: 'fcmTokens',
              removeAllFromArray: { values: [{ stringValue: staleToken }] },
            }],
          },
        }],
      }),
    }),
    fetch(`${base}/users/${encodeURIComponent(uid)}/tokens/${tokenHash}`, {
      method:  'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    }),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────
// Construir label de vencimiento legible para el body del push
// ─────────────────────────────────────────────────────────────────────────
function dueDateLabel(dueDate) {
  if (!(dueDate instanceof Date) || isNaN(dueDate)) return '';
  const diffH = (dueDate - Date.now()) / (1000 * 60 * 60);
  if (diffH < 0)     return ' · vencida';
  if (diffH < 1)     return ' · vence en menos de 1 h';
  if (diffH < 3)     return ` · vence en ${Math.round(diffH)} h`;
  return ' · vence ' + dueDate.toLocaleDateString('es-CL', { day: 'numeric', month: 'short' });
}

// ─────────────────────────────────────────────────────────────────────────
// HANDLER PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  // ── 1. Verificar CRON_SECRET ──────────────────────────────────────────
  // Vercel inyecta "Authorization: Bearer <CRON_SECRET>" en llamadas automáticas.
  // Peticiones manuales sin el secret exacto reciben 401.
  const expected = process.env.CRON_SECRET;
  const received = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

  if (!expected || received !== expected) {
    console.warn('[cron-reminders] ⛔ Autorización rechazada —', new Date().toISOString());
    return res.status(401).json({ error: 'No autorizado' });
  }

  const startedAt = new Date().toISOString();
  console.log('[cron-reminders] ▶ Inicio', startedAt);

  // ── 2. Obtener access token de Google ──────────────────────────────────
  let accessToken;
  try {
    accessToken = await getAccessToken();
  } catch (e) {
    console.error('[cron-reminders] Auth error:', e.message);
    return res.status(500).json({ error: 'Auth: ' + e.message });
  }

  // ── 3. Consultar tareas pendientes ────────────────────────────────────
  let tasks;
  try {
    tasks = await fetchPendingTasks(accessToken);
  } catch (e) {
    console.error('[cron-reminders] Firestore error:', e.message);
    return res.status(500).json({ error: 'Firestore: ' + e.message });
  }

  console.log(`[cron-reminders] ${tasks.length} tarea(s) para recordar`);

  if (tasks.length === 0) {
    return res.status(200).json({
      success:   true,
      processed: 0,
      message:   'Sin tareas pendientes con vencimiento en las próximas 24 h.',
      timestamp: startedAt,
    });
  }

  // ── 4. Procesar cada tarea secuencialmente ────────────────────────────
  const results = [];

  for (const task of tasks) {
    const { id, title, assignedToUid, prio, dueDate, _docName } = task;
    const log = { taskId: id, title: title.slice(0, 40) };

    if (!assignedToUid) {
      results.push({ ...log, status: 'skipped', reason: 'sin assignedToUid' });
      continue;
    }

    // Obtener tokens FCM del asignado
    let tokens;
    try {
      tokens = await getTokensForUser(assignedToUid, accessToken);
    } catch (e) {
      results.push({ ...log, status: 'error', reason: 'getTokens: ' + e.message });
      continue;
    }

    if (!tokens.length) {
      results.push({ ...log, status: 'skipped', reason: `uid ${assignedToUid} sin tokens FCM` });
      continue;
    }

    // Construir push
    const pushTitle = '⏰ Recordatorio de tarea';
    const pushBody  = `"${title.slice(0, 70)}"${dueDateLabel(dueDate)}`;
    const pushData  = { type: 'task_reminder', taskId: id, prio };

    // Enviar a todos los tokens en paralelo
    const sends = await Promise.allSettled(
      tokens.map(t => sendOneFCM(t, pushTitle, pushBody, pushData, assignedToUid, accessToken))
    );

    let sent = 0;
    const stale = [];
    sends.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value?.name) {
        sent++;
      } else {
        const errCode   = r.value?.error?.details?.find(d => d.errorCode)?.errorCode || '';
        const errStatus = r.value?.error?.status || '';
        if (errCode === 'UNREGISTERED' || errStatus === 'NOT_FOUND') {
          stale.push(tokens[i]);
        }
        console.warn(`[cron-reminders] FCM token[${i}] fallo:`, errCode || errStatus || r.reason?.message);
      }
    });

    // Limpiar tokens obsoletos en background (no bloquea el loop)
    if (stale.length) {
      Promise.allSettled(stale.map(t => removeStaleToken(assignedToUid, t, accessToken)))
        .then(() => console.log(`[cron-reminders] ${stale.length} token(s) obsoleto(s) eliminados de ${assignedToUid}`));
    }

    // Marcar reminderSent=true si al menos un token recibió el push
    if (sent > 0) {
      try {
        await markReminderSent(_docName, accessToken);
        results.push({ ...log, status: 'sent', uid: assignedToUid, tokensSent: sent });
      } catch (e) {
        // Push enviado pero no se pudo marcar — puede volver a enviar mañana.
        // No es crítico: el usuario recibe la notificación de todas formas.
        results.push({ ...log, status: 'sent_mark_failed', uid: assignedToUid, error: e.message });
      }
    } else {
      results.push({ ...log, status: 'push_failed', uid: assignedToUid, tokensAttempted: tokens.length });
    }
  }

  const sentCount   = results.filter(r => r.status === 'sent').length;
  const skipCount   = results.filter(r => r.status === 'skipped').length;
  const errorCount  = results.filter(r => r.status === 'error' || r.status === 'push_failed').length;

  console.log(`[cron-reminders] ✅ Fin — sent:${sentCount} skipped:${skipCount} errors:${errorCount}`);

  return res.status(200).json({
    success:   true,
    processed: tasks.length,
    sent:      sentCount,
    skipped:   skipCount,
    errors:    errorCount,
    results,
    timestamp: startedAt,
  });
};
