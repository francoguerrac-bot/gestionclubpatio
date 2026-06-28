/**
 * send-now.js — Envío de notificaciones usando credenciales de firebase login
 * No requiere Cloud Functions ni service account
 */
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PROJECT_ID = 'gestion-de-personas-ce003';
const TITLE      = process.argv[2] || '🔔 Gestión de Equipos · Patio Curauma';
const BODY       = process.argv[3] || 'Tienes novedades en el sistema. Abre la app para verlas.';

// ── 1. Leer credenciales del firebase CLI ─────────────────────────────
function getFirebaseCreds() {
  const paths = [
    path.join(process.env.APPDATA || '', 'configstore', 'firebase-tools.json'),
    path.join(process.env.USERPROFILE || '', '.config', 'configstore', 'firebase-tools.json'),
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf8');
      // Extraer tokens con regex para evitar problemas de JSON con claves duplicadas
      const refreshMatch = raw.match(/"refresh_token"\s*:\s*"([^"]+)"/);
      const clientIdMatch = raw.match(/"client_id"\s*:\s*"([^"]+)"/);
      const clientSecretMatch = raw.match(/"client_secret"\s*:\s*"([^"]+)"/);
      if (refreshMatch) {
        return {
          refresh_token: refreshMatch[1],
          client_id: clientIdMatch ? clientIdMatch[1] : '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
          client_secret: clientSecretMatch ? clientSecretMatch[1] : 'j9iVZfS8ub1IDpGx5xxNwc4J',
        };
      }
    }
  }
  throw new Error('No se encontraron credenciales de Firebase. Ejecuta: firebase login');
}

// ── 2. Obtener access token fresco usando refresh token ────────────────
function refreshAccessToken(creds) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: creds.refresh_token,
      client_id:     creds.client_id,
      client_secret: creds.client_secret,
    }).toString();

    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path:     '/token',
      method:   'POST',
      headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.access_token) resolve(parsed.access_token);
          else reject(new Error('No access_token en respuesta: ' + data));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── 3. Leer usuarios de Firestore REST API ─────────────────────────────
function getUsers(token) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'firestore.googleapis.com',
      path: `/v1/projects/${PROJECT_ID}/databases/(default)/documents/users`,
      headers: { Authorization: `Bearer ${token}` }
    };
    https.get(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Error parsing Firestore: ' + data.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

// ── 4. Enviar FCM v1 message ───────────────────────────────────────────
function sendFCM(token, fcmToken, title, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      message: {
        token: fcmToken,
        notification: { title, body },
        webpush: {
          notification: { title, body, icon: '/assets/Logo2.png', badge: '/assets/Logo2.png' },
          fcm_options: { link: 'https://gestionclubpatio.vercel.app' }
        }
      }
    });
    const req = https.request({
      hostname: 'fcm.googleapis.com',
      path:     `/v1/projects/${PROJECT_ID}/messages:send`,
      method:   'POST',
      headers: {
        'Authorization':  `Bearer ${token}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          resolve({ ok: res.statusCode === 200, status: res.statusCode, data: r });
        } catch(e) { resolve({ ok: false, status: res.statusCode, data }); }
      });
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.write(payload);
    req.end();
  });
}

// ── Main ───────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🔐 Obteniendo credenciales...');
  const creds = getFirebaseCreds();
  const token = await refreshAccessToken(creds);
  console.log('✅ Token renovado\n');

  console.log('📡 Leyendo usuarios de Firestore...');
  const result = await getUsers(token);

  if (!result.documents || !result.documents.length) {
    console.log('⚠️  No hay usuarios en /users o ninguno tiene token FCM');
    if (result.error) console.log('Error Firestore:', result.error.message);
    return;
  }

  // Extraer tokens FCM de cada usuario
  const targets = [];
  result.documents.forEach(doc => {
    const fields = doc.fields || {};
    const name   = fields.displayName?.stringValue || fields.email?.stringValue || doc.name.split('/').pop();
    const arr    = fields.fcmTokens?.arrayValue?.values || [];
    const tokens = arr.map(v => v.stringValue).filter(Boolean);
    if (tokens.length) {
      targets.push({ name, tokens });
      console.log(`  ✅ ${name} — ${tokens.length} token(s)`);
    } else {
      console.log(`  ⚪ ${name} — sin token FCM`);
    }
  });

  if (!targets.length) {
    console.log('\n⚠️  Ningún usuario tiene token FCM registrado.');
    console.log('   → Los usuarios deben tocar "Activar notificaciones" en el Dashboard.\n');
    return;
  }

  console.log(`\n📨 Enviando "${TITLE}" a ${targets.reduce((s,t) => s+t.tokens.length, 0)} dispositivos...\n`);

  let sent = 0, failed = 0;
  for (const user of targets) {
    for (const fcmToken of user.tokens) {
      const res = await sendFCM(token, fcmToken, TITLE, BODY);
      if (res.ok) {
        console.log(`  ✅ ${user.name}`);
        sent++;
      } else {
        const errCode = res.data?.error?.details?.[0]?.errorCode || res.data?.error?.message || res.status;
        console.log(`  ❌ ${user.name} — ${errCode}`);
        failed++;
      }
    }
  }

  console.log('\n─────────────────────────────────────────');
  console.log(`  ✅ Enviadas: ${sent}   ❌ Fallidas: ${failed}`);
  console.log('─────────────────────────────────────────\n');
}

main().catch(err => {
  console.error('\n❌ Error fatal:', err.message);
  process.exit(1);
});
