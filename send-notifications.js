/**
 * send-notifications.js
 * Envía una notificación push a todos los usuarios con token FCM registrado.
 * Uso: node send-notifications.js "Título" "Mensaje"
 * Ejemplo: node send-notifications.js "🔔 Hola equipo" "Nueva tarea asignada hoy"
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore }  = require('firebase-admin/firestore');
const { getMessaging }  = require('firebase-admin/messaging');

// ── Configuración ──────────────────────────────────────────────────────
const PROJECT_ID = 'gestion-de-personas-ce003';

// Título y mensaje: se pasan por argumento o usan el valor por defecto
const title   = process.argv[2] || '🔔 Gestión de Equipos · Patio Curauma';
const body    = process.argv[3] || 'Tienes novedades en el sistema. Abre la app para verlas.';

// ── Inicializar con Application Default Credentials ────────────────────
// (funciona porque hiciste `firebase login` — usa tus credenciales de Google)
const app = getApps().length
  ? getApps()[0]
  : initializeApp({ projectId: PROJECT_ID });

const db        = getFirestore(app);
const messaging = getMessaging(app);

// ── Main ───────────────────────────────────────────────────────────────
async function sendToAll() {
  console.log('\n📡 Leyendo usuarios de Firestore...');
  const snap = await db.collection('users').get();

  if (snap.empty) {
    console.log('⚠️  No hay documentos en /users');
    process.exit(0);
  }

  // Recopilar todos los tokens válidos
  const tokens = [];
  const tokenToUser = {};

  snap.forEach(doc => {
    const data   = doc.data();
    const name   = data.displayName || data.email || doc.id;
    const fcmTks = Array.isArray(data.fcmTokens) ? data.fcmTokens.filter(Boolean) : [];
    if (fcmTks.length) {
      fcmTks.forEach(t => { tokens.push(t); tokenToUser[t] = name; });
      console.log(`  ✅ ${name} — ${fcmTks.length} token(s)`);
    } else {
      console.log(`  ⚪ ${name} — sin token FCM`);
    }
  });

  if (!tokens.length) {
    console.log('\n⚠️  Ningún usuario tiene token FCM registrado.');
    console.log('    Los usuarios deben tocar "Activar notificaciones" en el Dashboard.');
    process.exit(0);
  }

  console.log(`\n📨 Enviando a ${tokens.length} token(s)...\n`);

  // FCM multicast (máx 500 tokens por llamada)
  const BATCH = 500;
  let totalSent = 0, totalFailed = 0;

  for (let i = 0; i < tokens.length; i += BATCH) {
    const batch = tokens.slice(i, i + BATCH);
    const msg = {
      tokens: batch,
      notification: { title, body },
      webpush: {
        notification: {
          title, body,
          icon:  '/assets/Logo2.png',
          badge: '/assets/Logo2.png',
          requireInteraction: false,
        },
        fcmOptions: { link: 'https://gestionclubpatio.vercel.app' }
      }
    };

    const res = await messaging.sendEachForMulticast(msg);
    totalSent   += res.successCount;
    totalFailed += res.failureCount;

    res.responses.forEach((r, idx) => {
      const user = tokenToUser[batch[idx]] || '?';
      if (r.success) {
        console.log(`  ✅ ${user}`);
      } else {
        const code = r.error?.code || 'unknown';
        console.log(`  ❌ ${user} — ${code}`);
      }
    });
  }

  console.log('\n─────────────────────────────────────');
  console.log(`✅ Enviadas: ${totalSent}   ❌ Fallidas: ${totalFailed}`);
  console.log('─────────────────────────────────────\n');
}

sendToAll().catch(err => {
  console.error('\n❌ Error:', err.message);
  if (err.message.includes('credential') || err.message.includes('auth')) {
    console.error('   → Asegúrate de haber ejecutado: firebase login');
  }
  process.exit(1);
});
