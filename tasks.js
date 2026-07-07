/**
 * tasks.js — TaskService · Club Patio Curauma
 *
 * Módulo de servicio para la colección /tasks en Firestore.
 * Integración: añade al final de index.html, ANTES de </body>:
 *
 *   <script type="module" src="tasks.js"></script>
 *
 * Expone: window.TaskService
 *   · addTask(taskData)
 *   · getTasksForUser(uid?)
 *   · updateTaskStatus(taskId, newStatus)
 *   · migrateLocalStorageToFirestore()
 *
 * Compatibilidad: usa los mismos globals que ya existen en index.html
 *   (window.currentProfile, window.toast, window.tasks, window.renderTasks)
 */

import { getApps, getApp, initializeApp }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, collection, doc,
  addDoc, getDocs, updateDoc, deleteDoc,
  query, where, orderBy, limit,
  serverTimestamp, Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// ─── Constantes ────────────────────────────────────────────────────────────
const FIREBASE_CONFIG = {
  apiKey:            'AIzaSyDxVCUM808BRJ-5_SAG4bkdmu4e8xbVQn8',
  authDomain:        'gestion-de-personas-ce003.firebaseapp.com',
  projectId:         'gestion-de-personas-ce003',
  storageBucket:     'gestion-de-personas-ce003.firebasestorage.app',
  messagingSenderId: '943250965489',
  appId:             '1:943250965489:web:6f17d07e76789b99107a50',
};
const ORG_ID         = 'curauma_001';
const LS_KEY         = 'carolina_v4_tasks';       // clave actual en localStorage
const MIGRATION_FLAG = 'gpc_tasks_migrated_v1';   // flag para no re-migrar

// Roles con acceso de lectura ampliada (pueden ver tareas de toda la org)
const EXEC_ROLES = new Set([
  'director', 'mama', 'coordinadora_bazares', 'coordinadora_tienda',
]);

// ─── Bootstrap Firebase (reutiliza la app ya inicializada por index.html) ──
const _app  = getApps().length > 0 ? getApp() : initializeApp(FIREBASE_CONFIG);
const _db   = getFirestore(_app);
const _auth = getAuth(_app);

// ─── Helper: usuario actual ─────────────────────────────────────────────────
function _user() {
  const u = _auth.currentUser;
  if (!u) throw new Error('Sin sesión activa. Inicia sesión primero.');
  return u;
}

// ─── Helper: perfil actual (lee el global de index.html) ──────────────────
function _profile() {
  return window.currentProfile || null;
}

// ─── Helper: es ejecutivo? ─────────────────────────────────────────────────
function _isExec() {
  return EXEC_ROLES.has(_profile()?.role);
}

// ─── Helper: toast (usa el de index.html si existe) ───────────────────────
function _toast(msg) {
  if (typeof window.toast === 'function') window.toast(msg);
  else console.info('[TaskService]', msg);
}

// ═══════════════════════════════════════════════════════════════════════════
// MODELO DE DATOS
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Documento Firestore /tasks/{id}
 * ──────────────────────────────
 * orgId            string    'curauma_001'       siempre presente (requerido por reglas)
 * title            string    texto de la tarea
 * description      string    notas adicionales   (nuevo)
 * ctx              string    'casa'|'bazar'|'tienda'|'club'
 * prio             string    'p1'|'p2'|'p3'|'p4'
 * freq             string    'unica'|'diaria'|'semanal'|'casual'
 * status           string    'todo'|'doing'|'review'|'done'   (nuevo)
 * done             boolean   alias de status === 'done'        (backward compat)
 * dueDate          Timestamp fecha+hora límite                 (era deadline:string)
 * time             string    'HH:mm'
 * dur              number    duración en minutos
 * assignedToUid    string    UID de Firebase del responsable   (nuevo, era owner:texto)
 * assignedToName   string    nombre para mostrar               (era owner)
 * createdByUid     string    UID del creador                   (nuevo)
 * createdAt        Timestamp serverTimestamp al crear          (nuevo)
 * updatedAt        Timestamp serverTimestamp al actualizar     (nuevo)
 * reminders        number[]  minutos de anticipación [60,1440] (nuevo, para cron)
 * reminderSent     boolean   flag para el cron job             (nuevo)
 * legacyId         string?   id original de localStorage       (solo en migradas)
 */

// ─── Convierte una tarea vieja (localStorage) al formato Firestore ─────────
function _oldToNew(old, uid, displayName) {
  // Convierte deadline:'YYYY-MM-DD' + time:'HH:mm' → Timestamp
  let dueDate = null;
  if (old.deadline) {
    try {
      const [y, m, d] = old.deadline.split('-').map(Number);
      const [h, min]  = (old.time || '00:00').split(':').map(Number);
      dueDate = Timestamp.fromDate(new Date(y, m - 1, d, h || 0, min || 0));
    } catch (_) { /* deadline mal formateado — ignorar */ }
  }

  return {
    orgId:           ORG_ID,
    title:           old.text || old.title || '',
    description:     old.description || '',
    ctx:             old.ctx || 'club',
    prio:            old.prio || 'p3',
    freq:            old.freq || 'unica',
    status:          old.done ? 'done' : (old.status || 'todo'),
    done:            !!old.done,
    dueDate,
    time:            old.time || '',
    dur:             old.dur  || 0,
    assignedToUid:   old.assignedToUid || uid,   // UID real si existe, sino el usuario actual
    assignedToName:  old.owner || displayName || 'Sin asignar',
    createdByUid:    uid,
    createdAt:       old.ts ? Timestamp.fromMillis(old.ts) : serverTimestamp(),
    updatedAt:       serverTimestamp(),
    reminders:       [],
    reminderSent:    false,
    legacyId:        old.id || null,
  };
}

// ─── Convierte un DocumentSnapshot → objeto plano compatible con index.html ─
function _snapToTask(snap) {
  const d = snap.data();
  // Expone los campos legacy (text, owner, deadline, done) para que
  // renderTasks() de index.html siga funcionando sin cambios.
  return {
    // ── campos nuevos ──────────────────────────────────
    ...d,
    id:            snap.id,
    // ── alias legacy ──────────────────────────────────
    text:          d.title,
    owner:         d.assignedToName,
    deadline:      d.dueDate ? d.dueDate.toDate().toISOString().split('T')[0] : '',
    done:          d.done || d.status === 'done',
    ts:            d.createdAt?.toMillis?.() ?? Date.now(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CRUD
// ═══════════════════════════════════════════════════════════════════════════

/**
 * addTask(taskData) → Promise<task>
 * Acepta el mismo objeto que usa index.html (con campo `text`, `deadline`, etc.)
 * y lo guarda en Firestore con el esquema nuevo.
 */
async function addTask(taskData) {
  const user = _user();
  const profile = _profile();

  let dueDate = null;
  if (taskData.deadline) {
    try {
      const [y, m, d] = taskData.deadline.split('-').map(Number);
      const [h, min]  = (taskData.time || '00:00').split(':').map(Number);
      dueDate = Timestamp.fromDate(new Date(y, m - 1, d, h || 0, min || 0));
    } catch (_) {}
  }

  const newDoc = {
    orgId:          ORG_ID,
    title:          taskData.text || taskData.title || '',
    description:    taskData.description || '',
    ctx:            taskData.ctx  || 'club',
    prio:           taskData.prio || 'p3',
    freq:           taskData.freq || 'unica',
    status:         taskData.done ? 'done' : (taskData.status || 'todo'),
    done:           !!taskData.done,
    dueDate,
    time:           taskData.time || '',
    dur:            taskData.dur  || 0,
    assignedToUid:  taskData.assignedToUid || user.uid,
    assignedToName: taskData.owner || profile?.displayName || user.email,
    createdByUid:   user.uid,
    createdAt:      serverTimestamp(),
    updatedAt:      serverTimestamp(),
    reminders:      taskData.reminders || [],
    reminderSent:   false,
  };

  const ref  = await addDoc(collection(_db, 'tasks'), newDoc);
  return { id: ref.id, ...newDoc };
}

/**
 * getTasksForUser(uid?) → Promise<task[]>
 *
 * Sin uid → usa el usuario actual.
 * Director/Ejecutivos ven todas las tareas de la org.
 * Usuarios regulares ven solo las asignadas a ellos.
 *
 * Retorna el array en formato compatible con index.html (incluye campos legacy).
 */
async function getTasksForUser(uid) {
  const user = _user();
  const targetUid = uid || user.uid;

  let snap;

  if (_isExec() && !uid) {
    // Ejecutivos sin uid específico: todas las tareas de la org
    // Nota: este query no necesita índice compuesto (solo where)
    const q = query(
      collection(_db, 'tasks'),
      where('orgId', '==', ORG_ID),
      limit(300),
    );
    snap = await getDocs(q);
  } else {
    // Usuario regular o director viendo a alguien en específico
    const q = query(
      collection(_db, 'tasks'),
      where('orgId',         '==', ORG_ID),
      where('assignedToUid', '==', targetUid),
      limit(200),
    );
    snap = await getDocs(q);
  }

  const tasks = snap.docs.map(_snapToTask);

  // Ordenar en JS (evita requerir índice compuesto en Firestore)
  tasks.sort((a, b) => {
    // Primero por deadline (ascendente), null al final
    if (a.deadline && b.deadline) return a.deadline > b.deadline ? 1 : -1;
    if (a.deadline) return -1;
    if (b.deadline) return 1;
    // Sin deadline: por timestamp de creación desc
    return (b.ts || 0) - (a.ts || 0);
  });

  return tasks;
}

/**
 * updateTaskStatus(taskId, newStatus) → Promise<void>
 *
 * newStatus: 'todo' | 'doing' | 'review' | 'done'
 * También actualiza el campo `done` por backward compat.
 */
async function updateTaskStatus(taskId, newStatus) {
  _user(); // valida sesión

  const VALID = ['todo', 'doing', 'review', 'done'];
  if (!VALID.includes(newStatus)) {
    throw new Error(`Status inválido: "${newStatus}". Usa: ${VALID.join(' | ')}`);
  }

  await updateDoc(doc(_db, 'tasks', taskId), {
    status:    newStatus,
    done:      newStatus === 'done',
    updatedAt: serverTimestamp(),
  });
}

/**
 * deleteTask(taskId) → Promise<void>
 */
async function deleteTask(taskId) {
  _user();
  await deleteDoc(doc(_db, 'tasks', taskId));
}

// ═══════════════════════════════════════════════════════════════════════════
// MIGRACIÓN localStorage → Firestore
// ═══════════════════════════════════════════════════════════════════════════

/**
 * migrateLocalStorageToFirestore() → Promise<result>
 *
 * Flujo:
 *  1. Verifica sesión activa
 *  2. Comprueba si ya se migró antes (flag en localStorage)
 *  3. Lee 'carolina_v4_tasks' de localStorage
 *  4. Convierte cada tarea al nuevo formato Firestore
 *  5. Escribe en /tasks/* con Promise.allSettled (fallos parciales no detienen)
 *  6. Si todas tuvieron éxito → marca migración y archiva backup
 *  7. Sincroniza el array global window.tasks con los nuevos ids de Firestore
 *
 * Retorna { success, succeeded, failed, total, message }
 */
async function migrateLocalStorageToFirestore() {
  // 1. Verificar sesión
  let user;
  try { user = _user(); }
  catch (_) {
    return { success: false, message: 'Sin sesión activa. Inicia sesión primero.' };
  }

  // 2. ¿Ya migrado?
  if (localStorage.getItem(MIGRATION_FLAG)) {
    return {
      success: true,
      message: 'Las tareas ya fueron migradas anteriormente.',
      succeeded: 0, failed: 0, total: 0,
    };
  }

  // 3. Leer localStorage
  const raw = localStorage.getItem(LS_KEY);
  if (!raw) {
    localStorage.setItem(MIGRATION_FLAG, new Date().toISOString());
    return {
      success: true,
      message: 'No había tareas en localStorage. Nada que migrar.',
      succeeded: 0, failed: 0, total: 0,
    };
  }

  let localData;
  try { localData = JSON.parse(raw); }
  catch (e) {
    return { success: false, message: 'Error al parsear localStorage: ' + e.message };
  }

  // Soporta tanto array plano como objeto {tasks:[...]}
  const localTasks = Array.isArray(localData)
    ? localData
    : Array.isArray(localData.tasks) ? localData.tasks : [];

  if (!localTasks.length) {
    localStorage.setItem(MIGRATION_FLAG, new Date().toISOString());
    return {
      success: true,
      message: 'localStorage estaba vacío o sin tareas.',
      succeeded: 0, failed: 0, total: 0,
    };
  }

  const displayName = _profile()?.displayName || user.email;

  // 4+5. Convertir y escribir en Firestore en paralelo
  const results = await Promise.allSettled(
    localTasks.map(t =>
      addDoc(collection(_db, 'tasks'), _oldToNew(t, user.uid, displayName))
    )
  );

  const succeeded = results.filter(r => r.status === 'fulfilled').length;
  const failed    = results.filter(r => r.status === 'rejected').length;
  const total     = localTasks.length;

  if (failed > 0) {
    console.warn(
      '[TaskService] Migración parcial:',
      results
        .filter(r => r.status === 'rejected')
        .map(r => r.reason?.message)
    );
  }

  // 6. Marcar migración si fue completa
  if (failed === 0) {
    localStorage.setItem(MIGRATION_FLAG, new Date().toISOString());

    // Archivar backup (no eliminar inmediatamente — el usuario debe verificar)
    localStorage.setItem(`${LS_KEY}_backup_${Date.now()}`, raw);
    // NO borramos carolina_v4_tasks todavía; el usuario verifica primero
  }

  // 7. Sincronizar array global (para que renderTasks() refleje los nuevos ids)
  try {
    const freshTasks = await getTasksForUser();
    if (Array.isArray(window.tasks)) {
      window.tasks.length = 0;
      window.tasks.push(...freshTasks);
      if (typeof window.renderTasks === 'function') window.renderTasks();
    }
  } catch (_) { /* no crítico */ }

  const message = failed === 0
    ? `✅ ${succeeded} tarea${succeeded !== 1 ? 's' : ''} migrada${succeeded !== 1 ? 's' : ''} correctamente a Firestore.`
    : `⚠️ Migración parcial: ${succeeded} OK, ${failed} con errores. Revisa la consola.`;

  return { success: failed === 0, succeeded, failed, total, message };
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILIDADES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * clearMigrationFlag() — solo para desarrollo/testing
 * Permite volver a correr la migración desde cero.
 */
function clearMigrationFlag() {
  localStorage.removeItem(MIGRATION_FLAG);
  console.info('[TaskService] Flag de migración limpiado. Puedes volver a migrar.');
}

/**
 * syncToGlobal() → carga las tareas de Firestore en window.tasks
 * y dispara renderTasks() para refrescar la UI.
 * Llama a esto en bootApp() para reemplazar la carga desde localStorage.
 */
async function syncToGlobal() {
  try {
    const firestoreTasks = await getTasksForUser();
    if (Array.isArray(window.tasks)) {
      window.tasks.length = 0;
      window.tasks.push(...firestoreTasks);
    }
    if (typeof window.renderTasks === 'function') window.renderTasks();
    return firestoreTasks;
  } catch (e) {
    console.warn('[TaskService] syncToGlobal falló:', e.message);
    return [];
  }
}

// ─── Exponer al scope global ────────────────────────────────────────────────
window.TaskService = {
  // CRUD principal
  addTask,
  getTasksForUser,
  updateTaskStatus,
  deleteTask,
  // Migración
  migrateLocalStorageToFirestore,
  clearMigrationFlag,    // solo desarrollo
  // Utilidades
  syncToGlobal,
};

console.info('[TaskService v1] Módulo listo. Usa window.TaskService desde la consola o el código.');
