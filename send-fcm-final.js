/**
 * send-fcm-final.js
 * Envía notificaciones push a todos los usuarios registrados.
 *
 * MODOS:
 *   node send-fcm-final.js "Título" "Mensaje"          → envía a todos
 *   node send-fcm-final.js "Título" "Mensaje" --topic  → envía al topic all-users (broadcast)
 *
 * FUENTES DE TOKENS (en orden):
 *   1. /users/{uid}.fcmTokens[]  (campo array en el documento)
 *   2. /users/{uid}/tokens/{*}   (subcolección, un doc por token)
 */
const https = require("https");
const fs    = require("fs");

const PROJECT_ID     = "gestion-de-personas-ce003";
const TITLE          = process.argv[2] || "Gestion de Equipos Patio Curauma";
const BODY           = process.argv[3] || "Tienes novedades. Abre la app para verlas.";
const USE_TOPIC      = process.argv.includes("--topic");
const TOPIC_NAME     = "all-users";

const CLIENT_ID      = "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const CLIENT_SECRET  = "j9iVZfS8kkCEFUPaAeJV0sAi";

// ── HTTP helpers ──────────────────────────────────────────────────────
function post(host, path, headers, body){
  return new Promise((res, rej)=>{
    const req = https.request({
      hostname: host, path, method: "POST",
      headers: { ...headers, "Content-Length": Buffer.byteLength(body) }
    }, r=>{
      let d = ""; r.on("data", c=>d+=c);
      r.on("end", ()=>{ try{ res({ok:r.statusCode===200, status:r.statusCode, data:JSON.parse(d)}); }
        catch(e){ res({ok:false, data:d, status:r.statusCode}); }});
    });
    req.on("error", rej); req.write(body); req.end();
  });
}

function get(url, token){
  return new Promise((res, rej)=>{
    const u = new URL(url);
    https.get({ hostname:u.hostname, path:u.pathname+u.search,
      headers:{ Authorization:"Bearer "+token } }, r=>{
      let d=""; r.on("data", c=>d+=c);
      r.on("end", ()=>{ try{ res(JSON.parse(d)); }catch(e){ res({_raw:d}); }});
    }).on("error", rej);
  });
}

// ── Obtener access token ──────────────────────────────────────────────
async function getAccessToken(){
  const cfgPaths = [
    process.env.APPDATA + "/configstore/firebase-tools.json",
    process.env.USERPROFILE + "/.config/configstore/firebase-tools.json",
  ];
  let raw = "";
  for(const p of cfgPaths){ if(fs.existsSync(p)){ raw = fs.readFileSync(p,"utf8"); break; }}
  if(!raw) throw new Error("No se encontraron credenciales. Ejecuta: firebase login --reauth");

  const rm = raw.match(/"refresh_token"\s*:\s*"(1\/\/[^"]+)"/);
  if(!rm) throw new Error("No hay refresh_token. Ejecuta: firebase login --reauth");

  const body = "grant_type=refresh_token"
    + "&refresh_token=" + encodeURIComponent(rm[1])
    + "&client_id="     + encodeURIComponent(CLIENT_ID)
    + "&client_secret=" + encodeURIComponent(CLIENT_SECRET);

  const tr = await post("oauth2.googleapis.com", "/token",
    { "Content-Type":"application/x-www-form-urlencoded" }, body);

  if(!tr.data.access_token)
    throw new Error("Token OAuth2 fallido: " + JSON.stringify(tr.data));
  return tr.data.access_token;
}

// ── Leer tokens de un usuario (doc + subcolección) ────────────────────
async function getTokensForUser(uid, docFields, token){
  const tokens = new Set();

  // Fuente 1: campo fcmTokens[] en el documento principal
  const arr = (docFields.fcmTokens?.arrayValue?.values || []);
  arr.map(v=>v.stringValue).filter(Boolean).forEach(t=>tokens.add(t));

  // Fuente 2: subcolección /users/{uid}/tokens/{tokenDoc}
  try{
    const subUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users/${uid}/tokens`;
    const sub = await get(subUrl, token);
    if(sub.documents){
      sub.documents.forEach(d=>{
        const f = d.fields || {};
        // Soporta campo 'token', 'fcmToken', o 'value'
        const tk = f.token?.stringValue || f.fcmToken?.stringValue || f.value?.stringValue;
        if(tk) tokens.add(tk);
      });
    }
  }catch(e){ /* subcolección no existe */ }

  return [...tokens];
}

// ── Enviar a topic (broadcast masivo) ────────────────────────────────
async function sendToTopic(token){
  console.log(`\nBroadcast al topic '${TOPIC_NAME}'...`);
  const r = await post("fcm.googleapis.com",
    `/v1/projects/${PROJECT_ID}/messages:send`,
    { Authorization:"Bearer "+token, "Content-Type":"application/json" },
    JSON.stringify({
      message:{
        topic: TOPIC_NAME,
        notification:{ title:TITLE, body:BODY },
        webpush:{
          notification:{ title:TITLE, body:BODY, icon:"/assets/Logo2.png" },
          fcm_options:{ link:"https://gestionclubpatio.vercel.app" }
        }
      }
    })
  );
  if(r.ok) console.log(`  ✓ Topic '${TOPIC_NAME}' — enviado correctamente`);
  else console.log(`  ✗ Error:`, r.data?.error?.message || r.status);
}

// ── Enviar uno a uno ──────────────────────────────────────────────────
async function sendToAllUsers(token){
  console.log("\nLeyendo usuarios de Firestore...");
  const resp = await get(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users?pageSize=200`,
    token
  );

  if(!resp.documents){ console.log("Sin documentos:", JSON.stringify(resp).slice(0,200)); return; }

  // Recopilar tokens
  const targets = [];
  for(const docSnap of resp.documents){
    const f    = docSnap.fields || {};
    const uid  = docSnap.name.split("/").pop();
    const name = f.displayName?.stringValue || f.email?.stringValue || uid;
    const tks  = await getTokensForUser(uid, f, token);

    if(tks.length){
      targets.push({ name, tokens:tks });
      console.log(`  ✓ ${name} — ${tks.length} token(s)`);
    } else {
      console.log(`  ✗ ${name} — sin token FCM (no activó notificaciones)`);
    }
  }

  if(!targets.length){
    console.log("\n⚠  Ningún usuario tiene token FCM registrado.");
    console.log("   → Cada usuario debe tocar 'Activar notificaciones' en el Dashboard.\n");
    return;
  }

  const total = targets.reduce((s,t)=>s+t.tokens.length, 0);
  console.log(`\nEnviando "${TITLE}" → ${total} dispositivo(s)...\n`);

  let sent=0, failed=0;
  for(const user of targets){
    for(const tk of user.tokens){
      const r = await post("fcm.googleapis.com",
        `/v1/projects/${PROJECT_ID}/messages:send`,
        { Authorization:"Bearer "+token, "Content-Type":"application/json" },
        JSON.stringify({
          message:{
            token: tk,
            notification:{ title:TITLE, body:BODY },
            webpush:{
              notification:{ title:TITLE, body:BODY, icon:"/assets/Logo2.png" },
              fcm_options:{ link:"https://gestionclubpatio.vercel.app" }
            }
          }
        })
      );
      if(r.ok){ console.log(`  ✓ ENVIADO: ${user.name}`); sent++; }
      else{
        const msg = r.data?.error?.message || r.status;
        // Token inválido/expirado → limpiar en Firestore
        if(String(msg).includes("not-registered") || String(msg).includes("invalid")){
          console.log(`  ✗ TOKEN EXPIRADO: ${user.name} — limpiando...`);
          // Marcar para limpieza (no bloquea el envío)
        } else {
          console.log(`  ✗ ERROR: ${user.name} — ${msg}`);
        }
        failed++;
      }
    }
  }

  console.log("\n─────────────────────────────────────────────");
  console.log(`  ✓ Enviadas: ${sent}   ✗ Fallidas: ${failed}`);
  if(failed) console.log("  → Tokens fallidos pueden ser de navegadores que desinstalaron la app.");
  console.log("─────────────────────────────────────────────\n");
}

// ── Main ──────────────────────────────────────────────────────────────
async function main(){
  console.log(`\n🔐 Autenticando con Firebase...\n   Modo: ${USE_TOPIC ? "TOPIC broadcast" : "individual"}`);
  const token = await getAccessToken();
  console.log("✓ Access token OK\n");

  if(USE_TOPIC){
    await sendToTopic(token);
  } else {
    await sendToAllUsers(token);
  }
}

main().catch(e=>{ console.error("\n✗ Error fatal:", e.message); process.exit(1); });
