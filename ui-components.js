// ui-components.js — v1.0.0
// Tablero Kanban + Vista Calendario para Gestión Club Patio Curauma
//
// Integración en index.html (4 pasos al final de este archivo).
// Sin dependencias externas. Reutiliza las CSS variables de index.html.

'use strict';

(function (w) {

  // ── 0. Namespace ──────────────────────────────────────────────────────────
  const GPC = w.GPC = w.GPC || {};

  // ── 1. Constantes visuales (alineadas con CTX_MAP / PRIO_MAP de index.html) ──
  const PRIO_COLOR = { p1: '#F25C54', p2: '#E9B872', p3: '#4A90D9', p4: '#9095A0' };
  const PRIO_LABEL = { p1: '🔴 Urgente', p2: '🟡 Alta', p3: '🔵 Normal', p4: '⚪ Opcional' };
  const CTX_EMOJI  = { casa: '🏠', bazar: '🛍️', tienda: '🏪', club: '🟢' };
  const CTX_SHORT  = { casa: 'Casa', bazar: 'Bazar', tienda: 'Tienda', club: 'Club' };

  const KANBAN_COLS = [
    { key: 'todo',   label: 'Por Hacer',   accent: '#6B7280', soft: '#F4F7F6', border: '#D1D5DB' },
    { key: 'doing',  label: 'En Progreso', accent: '#B45309', soft: '#FDF4E3', border: '#F0D998' },
    { key: 'review', label: 'En Revisión', accent: '#1E40AF', soft: '#EBF4FF', border: '#BFDBFE' },
    { key: 'done',   label: 'Listo ✓',     accent: '#059669', soft: '#DCFCE7', border: '#A7F3D0' },
  ];

  const MES_ES  = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                   'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const DOW_ES  = ['L','M','M','J','V','S','D'];

  // ── 2. CSS (inyectado una vez, espacio de nombres kb- / gc-) ─────────────
  function injectStyles() {
    if (document.getElementById('gpc-ui-css')) return;
    const s = document.createElement('style');
    s.id = 'gpc-ui-css';
    s.textContent = `
/* ═══════════════════════════════ KANBAN ═══════════════════════════════ */
#pg-kanban { display:none; flex-direction:column; }
#pg-kanban.active { display:flex; }

.kb-header {
  padding: 14px 16px 10px;
  background: var(--bg-card);
  border-bottom: 1px solid var(--border);
  position: sticky; top: 0; z-index: 10;
  display: flex; flex-direction: column; gap: 10px;
}
.kb-title {
  font-size: 14px; font-weight: 800;
  color: var(--text-main); letter-spacing: 0.02em;
}
.kb-filter { display: flex; gap: 6px; flex-wrap: wrap; }
.kb-filt {
  padding: 4px 11px; border-radius: 20px;
  border: 1.5px solid var(--border); background: transparent;
  font-size: 11px; font-weight: 600; color: var(--text-muted);
  cursor: pointer; transition: all .15s;
  font-family: 'Inter', sans-serif;
}
.kb-filt:active, .kb-filt--on {
  background: var(--primary-blue);
  border-color: var(--primary-blue); color: #fff;
}

.kb-board {
  display: flex; gap: 12px;
  padding: 14px 12px 24px;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: thin; scrollbar-color: var(--border) transparent;
  flex: 1;
}
.kb-board::-webkit-scrollbar { height: 4px; }
.kb-board::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

.kb-col {
  flex-shrink: 0; width: 245px;
  background: var(--col-soft);
  border-radius: 14px;
  border: 1.5px solid var(--col-border);
  overflow: hidden;
  display: flex; flex-direction: column;
}
.kb-col-head {
  padding: 10px 12px 9px;
  border-top: 3.5px solid var(--col-accent);
  display: flex; align-items: center; justify-content: space-between;
  flex-shrink: 0;
}
.kb-col-label {
  font-size: 10.5px; font-weight: 800;
  color: var(--col-accent);
  text-transform: uppercase; letter-spacing: .07em;
}
.kb-col-count {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10.5px; font-weight: 700;
  background: var(--col-accent); color: #fff;
  border-radius: 10px; padding: 1px 7px;
  min-width: 22px; text-align: center;
}
.kb-col-body {
  padding: 8px; display: flex; flex-direction: column; gap: 7px;
  min-height: 72px; flex: 1;
}
.kb-empty {
  font-size: 11px; color: var(--text-muted);
  text-align: center; padding: 22px 8px;
  font-style: italic; opacity: .7;
}

/* ── Kanban Card ── */
.kb-card {
  background: var(--bg-card);
  border-radius: 10px;
  border: 1px solid var(--border);
  box-shadow: 0 1px 5px rgba(45,49,66,.07);
  overflow: hidden;
  transition: box-shadow .15s;
}
.kb-card:hover { box-shadow: 0 3px 10px rgba(45,49,66,.12); }
.kb-card-bar { height: 3px; background: var(--k-prio); }
.kb-card-body { padding: 9px 10px 8px; }
.kb-card-title {
  font-size: 12px; font-weight: 600;
  color: var(--text-main); line-height: 1.4;
  margin-bottom: 5px;
  display: -webkit-box; -webkit-line-clamp: 2;
  -webkit-box-orient: vertical; overflow: hidden;
}
.kb-card-owner {
  font-size: 10px; color: var(--text-muted);
  margin-bottom: 5px;
}
.kb-card-foot {
  display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
}
.kb-ctx {
  font-size: 9.5px; font-weight: 600;
  color: var(--text-muted); background: var(--bg-main);
  border-radius: 4px; padding: 2px 5px;
}
.kb-date {
  font-size: 9.5px; font-weight: 600;
  border-radius: 4px; padding: 2px 5px;
}
.kd-ov    { background: #FDECEA; color: var(--accent-coral); }
.kd-today { background: #FDF4E3; color: #92400E; }
.kd-soon  { background: #EBF4FF; color: #1E40AF; }
.kd-ok    { background: var(--bg-main); color: var(--text-muted); }

/* ── Kanban Move Controls ── */
.kb-card-moves {
  display: flex; border-top: 1px solid var(--border);
}
.km-btn {
  flex: 1; background: transparent; border: none;
  padding: 5px 0; font-size: 15px; line-height: 1;
  color: var(--text-muted); cursor: pointer;
  font-weight: 700; transition: background .12s, color .12s;
  font-family: 'Inter', sans-serif;
}
.km-btn:active { background: var(--bg-main); color: var(--text-main); }
.km-hidden { opacity: 0; pointer-events: none; }
.km-sep { width: 1px; background: var(--border); flex-shrink: 0; }

/* ═══════════════════════════════ CALENDAR ══════════════════════════════ */
#pg-calendario { display:none; flex-direction:column; }
#pg-calendario.active { display:flex; }

.gcal { max-width: 480px; margin: 0 auto; padding-bottom: 24px; }

.gc-nav {
  display: flex; align-items: center; justify-content: space-between;
  padding: 13px 16px 12px;
  background: var(--bg-card); border-bottom: 1px solid var(--border);
  position: sticky; top: 0; z-index: 10;
}
.gc-nav-btn {
  width: 38px; height: 38px; border-radius: 50%;
  border: 1.5px solid var(--border); background: transparent;
  font-size: 22px; color: var(--text-main); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: background .12s; font-family: 'Inter', sans-serif;
  line-height: 1;
}
.gc-nav-btn:active { background: var(--bg-main); }
.gc-nav-center { text-align: center; }
.gc-month {
  font-size: 17px; font-weight: 800;
  color: var(--text-main); letter-spacing: -.01em;
}
.gc-year {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10.5px; color: var(--text-muted); margin-top: 1px;
}

.gc-grid {
  display: grid; grid-template-columns: repeat(7, 1fr);
  gap: 2px; padding: 10px 8px 6px;
}
.gc-dow {
  text-align: center; font-size: 9px; font-weight: 700;
  color: var(--text-muted); text-transform: uppercase;
  letter-spacing: .07em; padding: 4px 0 2px;
}
.gc-empty {}
.gc-cell {
  border-radius: 8px; padding: 4px 2px 5px;
  min-height: 48px; cursor: pointer;
  display: flex; flex-direction: column; align-items: center; gap: 3px;
  transition: background .12s;
}
.gc-cell:active { background: var(--sage-dim); }
.gc-num {
  font-size: 12px; font-weight: 600;
  color: var(--text-main); line-height: 1;
}
.gc-today { background: var(--primary-blue); border-radius: 8px; }
.gc-today .gc-num { color: #fff; font-weight: 800; }
.gc-today .gc-dot { box-shadow: 0 0 0 1px rgba(255,255,255,.4); }
.gc-sel { background: var(--sage-dim); box-shadow: inset 0 0 0 2px var(--primary-blue); }
.gc-sel.gc-today { box-shadow: inset 0 0 0 2px var(--accent-coral); }

.gc-dots {
  display: flex; flex-wrap: wrap; justify-content: center;
  gap: 2px; max-width: 32px;
}
.gc-dot {
  width: 5px; height: 5px; border-radius: 50%;
  display: inline-block; flex-shrink: 0;
}
.gc-dot-more {
  font-size: 7px; font-weight: 800;
  color: var(--text-muted); line-height: 6px;
}

/* ── Detail Panel ── */
.gc-detail {
  margin: 10px 12px 0;
  background: var(--bg-card);
  border-radius: 14px;
  border: 1.5px solid var(--border);
  overflow: hidden;
  box-shadow: 0 2px 10px rgba(45,49,66,.06);
}
.gc-detail-hd {
  padding: 11px 14px 10px;
  font-size: 13px; font-weight: 700; color: var(--text-main);
  border-bottom: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between;
}
.gc-detail-cnt {
  font-size: 10.5px; font-weight: 700;
  color: var(--primary-blue); background: var(--sage-dim);
  padding: 2px 9px; border-radius: 10px;
}
.gc-task {
  display: flex; align-items: center;
  padding: 10px 14px; gap: 11px;
  border-bottom: 1px solid var(--border);
  transition: background .1s;
}
.gc-task:last-child { border-bottom: none; }
.gc-task:active { background: var(--bg-main); }
.gc-t-bar {
  width: 3px; height: 34px; border-radius: 2px;
  background: var(--t-prio); flex-shrink: 0;
}
.gc-t-body { flex: 1; min-width: 0; }
.gc-t-title {
  font-size: 12px; font-weight: 600; color: var(--text-main);
  line-height: 1.35;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.gc-t-owner { font-size: 10px; color: var(--text-muted); margin-top: 2px; }
.gc-t-emoji { font-size: 17px; flex-shrink: 0; }
.gc-no-tasks {
  padding: 20px 14px; font-size: 12px;
  color: var(--text-muted); text-align: center; font-style: italic;
}

/* ── Legend ── */
.gc-legend {
  display: flex; justify-content: center;
  gap: 12px; padding: 12px 16px 0; flex-wrap: wrap;
}
.gc-leg-item {
  display: flex; align-items: center; gap: 4px;
  font-size: 10px; color: var(--text-muted);
}
.gc-leg-dot { width: 7px; height: 7px; border-radius: 50%; }
`;
    document.head.appendChild(s);
  }

  // ── 3. Task helpers ───────────────────────────────────────────────────────

  // Convierte tarea legacy (text/deadline/done) o TaskService (title/dueDate/status)
  // a un shape interno normalizado
  function normTask(t) {
    let dueDate = null;
    if (t.deadline) {
      try { dueDate = new Date(t.deadline + 'T00:00:00'); } catch (_) {}
    } else if (t.dueDate) {
      dueDate = t.dueDate.toDate ? t.dueDate.toDate() : new Date(t.dueDate);
    }
    return {
      id:      t.id,
      title:   t.title || t.text || '(sin título)',
      owner:   t.assignedToName || t.owner || '',
      prio:    t.prio   || 'p3',
      ctx:     t.ctx    || 'club',
      done:    !!(t.done || t.status === 'done'),
      dueDate,
      ts:      t.ts || 0,
    };
  }

  function allTasks() {
    return (w.tasks || []).map(normTask);
  }

  // Retorna { label, cls } para mostrarlo en tarjetas y detalle
  function dueDateInfo(d) {
    if (!d) return null;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const date  = new Date(d); date.setHours(0, 0, 0, 0);
    const diff  = Math.round((date - today) / 86400000);
    if (diff < 0)   return { label: `Venció hace ${Math.abs(diff)}d`, cls: 'kd-ov' };
    if (diff === 0)  return { label: 'Hoy',                           cls: 'kd-today' };
    if (diff === 1)  return { label: 'Mañana',                        cls: 'kd-soon' };
    if (diff <= 3)   return { label: `En ${diff} días`,               cls: 'kd-soon' };
    return {
      label: date.toLocaleDateString('es-CL', { day: 'numeric', month: 'short' }),
      cls: 'kd-ok',
    };
  }

  // Escape HTML (previene XSS en títulos de tareas con caracteres especiales)
  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── 4. Kanban: persistencia de status en localStorage ────────────────────
  // Estructura: { taskId: 'todo' | 'doing' | 'review' | 'done' }
  // Separado del campo `done` de la tarea — añade granularidad sin romper el modelo.

  const _KSK = 'gpc_kanban_v1';
  let _kmap  = {};
  try { _kmap = JSON.parse(localStorage.getItem(_KSK) || '{}'); } catch (_) {}

  function kStatus(task) {
    if (task.done) return 'done';
    const saved = _kmap[task.id];
    // Auto-heal: si la tarea fue des-marcada externamente pero kmap aún dice 'done'
    if (saved === 'done') {
      _kmap[task.id] = 'todo';
      _kSave();
      return 'todo';
    }
    return saved || 'todo';
  }

  function kSetStatus(id, status) {
    _kmap[id] = status;
    _kSave();
  }

  function _kSave() {
    try { localStorage.setItem(_KSK, JSON.stringify(_kmap)); } catch (_) {}
  }

  // ── 5. GPC.Kanban ─────────────────────────────────────────────────────────
  GPC.Kanban = {
    _ctx: 'todo', // 'todo' = todos los contextos

    render() {
      injectStyles();
      const root = document.getElementById('kanban-root');
      if (!root) return;

      const tasks    = allTasks();
      const ctxF     = this._ctx;
      const filtered = ctxF === 'todo' ? tasks : tasks.filter(t => t.ctx === ctxF);

      // Agrupar por status Kanban
      const groups = { todo: [], doing: [], review: [], done: [] };
      filtered.forEach(t => {
        const s = kStatus(t);
        (groups[s] || (groups.todo)).push(t);
      });

      // Ordenar cada columna: prioridad → fecha → ts
      const byPriority = (a, b) => {
        const po = { p1: 1, p2: 2, p3: 3, p4: 4 };
        const d  = (po[a.prio] || 9) - (po[b.prio] || 9);
        if (d !== 0) return d;
        if (a.dueDate && b.dueDate) return a.dueDate - b.dueDate;
        if (a.dueDate) return -1;
        if (b.dueDate) return 1;
        return b.ts - a.ts;
      };
      ['todo', 'doing', 'review'].forEach(k => groups[k].sort(byPriority));
      groups.done.sort((a, b) => b.ts - a.ts); // done: más reciente primero

      const filterButtons = ['todo', 'casa', 'bazar', 'tienda', 'club'].map(c => {
        const lbl   = c === 'todo' ? 'Todo' : CTX_SHORT[c] || c;
        const isOn  = ctxF === c;
        return `<button class="kb-filt${isOn ? ' kb-filt--on' : ''}"
          onclick="window.GPC.Kanban.setCtx('${c}')">${lbl}</button>`;
      }).join('');

      const colsHTML = KANBAN_COLS.map(col => {
        const colTasks = groups[col.key] || [];
        const cardsHTML = colTasks.length
          ? colTasks.map(t => this._cardHTML(t, col.key)).join('')
          : `<div class="kb-empty">Sin tareas</div>`;
        return `
          <div class="kb-col" style="--col-accent:${col.accent};--col-soft:${col.soft};--col-border:${col.border}">
            <div class="kb-col-head">
              <span class="kb-col-label">${col.label}</span>
              <span class="kb-col-count">${colTasks.length}</span>
            </div>
            <div class="kb-col-body">${cardsHTML}</div>
          </div>`;
      }).join('');

      root.innerHTML = `
        <div class="kb-header">
          <div class="kb-title">📋 Tablero de Tareas</div>
          <div class="kb-filter">${filterButtons}</div>
        </div>
        <div class="kb-board">${colsHTML}</div>`;
    },

    _cardHTML(t, colKey) {
      const di   = dueDateInfo(t.dueDate);
      const pc   = PRIO_COLOR[t.prio] || '#9095A0';
      const cols = ['todo', 'doing', 'review', 'done'];
      const idx  = cols.indexOf(colKey);

      const dateChip = di
        ? `<span class="kb-date ${di.cls}">📅 ${di.label}</span>`
        : '';
      const ownerLine = t.owner
        ? `<div class="kb-card-owner">👤 ${esc(t.owner)}</div>`
        : '';

      return `
        <div class="kb-card" style="--k-prio:${pc}">
          <div class="kb-card-bar"></div>
          <div class="kb-card-body">
            <div class="kb-card-title">${esc(t.title)}</div>
            ${ownerLine}
            <div class="kb-card-foot">
              <span class="kb-ctx">${(CTX_EMOJI[t.ctx] || '') + ' ' + (CTX_SHORT[t.ctx] || t.ctx)}</span>
              ${dateChip}
            </div>
          </div>
          <div class="kb-card-moves">
            <button class="km-btn${idx === 0 ? ' km-hidden' : ''}"
              onclick="window.GPC.Kanban.move('${t.id}','back')" title="Mover atrás">←</button>
            <span class="km-sep"></span>
            <button class="km-btn${idx === cols.length - 1 ? ' km-hidden' : ''}"
              onclick="window.GPC.Kanban.move('${t.id}','next')" title="Avanzar">→</button>
          </div>
        </div>`;
    },

    setCtx(ctx) {
      this._ctx = ctx;
      this.render();
    },

    move(id, dir) {
      const task = allTasks().find(t => t.id === id);
      if (!task) return;

      const cols = ['todo', 'doing', 'review', 'done'];
      const cur  = kStatus(task);
      const idx  = cols.indexOf(cur);

      if (dir === 'next' && idx < cols.length - 1) {
        const next = cols[idx + 1];
        // Sincronizar con el modelo principal al marcar como done
        if (next === 'done' && !task.done && w.toggleDone) w.toggleDone(id);
        kSetStatus(id, next);
      } else if (dir === 'back' && idx > 0) {
        // Sincronizar con el modelo principal al deshacer done
        if (cur === 'done' && task.done && w.toggleDone) w.toggleDone(id);
        kSetStatus(id, cols[idx - 1]);
      }
      this.render();
    },
  };

  // ── 6. GPC.Calendar ───────────────────────────────────────────────────────
  GPC.Calendar = {
    _y:   new Date().getFullYear(),
    _m:   new Date().getMonth(),
    _sel: null, // día seleccionado (número 1-31)

    render() {
      injectStyles();
      const root = document.getElementById('calendar-root');
      if (!root) return;

      const { _y: y, _m: m, _sel: sel } = this;
      const today  = new Date();

      // Tareas activas con fecha
      const tasks    = allTasks().filter(t => t.dueDate && !t.done);
      // También incluir tareas vencidas sin marcar
      const allWithDate = allTasks().filter(t => t.dueDate);

      // Mapa "YYYY-MM-DD" → task[]
      const byDay = {};
      allWithDate.forEach(t => {
        const key = this._dayKey(t.dueDate);
        (byDay[key] = byDay[key] || []).push(t);
      });

      // ── Cabecera de navegación ──
      const navHTML = `
        <div class="gc-nav">
          <button class="gc-nav-btn" onclick="window.GPC.Calendar.prev()">‹</button>
          <div class="gc-nav-center">
            <div class="gc-month">${MES_ES[m]}</div>
            <div class="gc-year">${y}</div>
          </div>
          <button class="gc-nav-btn" onclick="window.GPC.Calendar.next()">›</button>
        </div>`;

      // ── Grid ──
      const firstDow  = (new Date(y, m, 1).getDay() + 6) % 7; // 0=Mon
      const daysCount = new Date(y, m + 1, 0).getDate();

      let cells = DOW_ES.map(d => `<div class="gc-dow">${d}</div>`).join('');
      // Celdas vacías al inicio
      for (let i = 0; i < firstDow; i++) cells += `<div class="gc-empty"></div>`;
      // Días del mes
      for (let day = 1; day <= daysCount; day++) {
        const key      = this._dayKey(new Date(y, m, day));
        const dayTasks = byDay[key] || [];
        const isToday  = today.getFullYear() === y && today.getMonth() === m && today.getDate() === day;
        const isSel    = sel === day;

        cells += `
          <div class="gc-cell${isToday ? ' gc-today' : ''}${isSel ? ' gc-sel' : ''}"
               onclick="window.GPC.Calendar.pick(${day})">
            <span class="gc-num">${day}</span>
            <div class="gc-dots">${this._dots(dayTasks)}</div>
          </div>`;
      }

      // ── Panel de detalle del día seleccionado ──
      let detailHTML = '';
      if (sel !== null) {
        const key      = this._dayKey(new Date(y, m, sel));
        const selTasks = (byDay[key] || []).sort((a, b) =>
          (a.prio || 'p3').localeCompare(b.prio || 'p3')
        );
        const selDate = new Date(y, m, sel)
          .toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' });
        const hdTitle = selDate.charAt(0).toUpperCase() + selDate.slice(1);

        const taskItems = selTasks.length
          ? selTasks.map(t => `
              <div class="gc-task" style="--t-prio:${PRIO_COLOR[t.prio] || '#9095A0'}">
                <span class="gc-t-bar"></span>
                <div class="gc-t-body">
                  <div class="gc-t-title">${esc(t.title)}</div>
                  ${t.owner ? `<div class="gc-t-owner">👤 ${esc(t.owner)}</div>` : ''}
                </div>
                <span class="gc-t-emoji" title="${CTX_SHORT[t.ctx] || t.ctx}">${CTX_EMOJI[t.ctx] || '📌'}</span>
              </div>`).join('')
          : `<div class="gc-no-tasks">Día libre — sin tareas programadas ✨</div>`;

        const cntBadge = selTasks.length
          ? `<span class="gc-detail-cnt">${selTasks.length} tarea${selTasks.length > 1 ? 's' : ''}</span>`
          : '';

        detailHTML = `
          <div class="gc-detail">
            <div class="gc-detail-hd">📅 ${hdTitle} ${cntBadge}</div>
            ${taskItems}
          </div>`;
      }

      // ── Leyenda ──
      const legend = Object.entries(PRIO_COLOR).map(([k, v]) =>
        `<span class="gc-leg-item">
          <span class="gc-leg-dot" style="background:${v}"></span>
          ${PRIO_LABEL[k].replace(/[🔴🟡🔵⚪]\s?/, '')}
        </span>`
      ).join('');

      root.innerHTML = `
        <div class="gcal">
          ${navHTML}
          <div class="gc-grid">${cells}</div>
          ${detailHTML}
          <div class="gc-legend">${legend}</div>
        </div>`;
    },

    _dayKey(date) {
      const d = new Date(date);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },

    _dots(tasks) {
      if (!tasks.length) return '';
      const sorted = [...tasks].sort((a, b) => (a.prio || 'p3').localeCompare(b.prio || 'p3'));
      const dots   = sorted.slice(0, 3).map(t =>
        `<span class="gc-dot" style="background:${PRIO_COLOR[t.prio] || '#9095A0'}"></span>`
      ).join('');
      const more   = tasks.length > 3
        ? `<span class="gc-dot-more">+${tasks.length - 3}</span>`
        : '';
      return dots + more;
    },

    prev() {
      if (this._m === 0) { this._y--; this._m = 11; } else this._m--;
      this._sel = null; this.render();
    },
    next() {
      if (this._m === 11) { this._y++; this._m = 0; } else this._m++;
      this._sel = null; this.render();
    },
    pick(day) {
      this._sel = this._sel === day ? null : day;
      this.render();
    },
  };

}(window));

/* ════════════════════════════════════════════════════════════════════════════
   GUÍA DE INTEGRACIÓN EN index.html (4 pasos, sin romper lo existente)
   ════════════════════════════════════════════════════════════════════════════

   PASO 1 — Añadir el <script> al final de index.html, antes de </body>:
   ─────────────────────────────────────────────────────────────────────────
   <script src="ui-components.js"></script>

   ─────────────────────────────────────────────────────────────────────────
   PASO 2 — Añadir los containers de página al HTML (junto al resto de .page):
   ─────────────────────────────────────────────────────────────────────────
   <div id="pg-kanban" class="page">
     <div id="kanban-root"></div>
   </div>

   <div id="pg-calendario" class="page">
     <div id="calendar-root"></div>
   </div>

   ─────────────────────────────────────────────────────────────────────────
   PASO 3 — Añadir 2 líneas en showPage() (y aprovechar para convertirlo en
            dispatch table, eliminando el riesgo de los 17 if encadenados):
   ─────────────────────────────────────────────────────────────────────────

   // ANTES (fragmento):
   function showPage(p){
     // ...boilerplate de clases...
     if(p==='sprint'){renderSprint();renderMatrix();renderGoals();}
     if(p==='equipo'){renderFamily();renderTeam();renderCheckins();}
     // ...17 ifs más...
   }

   // DESPUÉS — reemplazar todos los ifs por una tabla de despacho:
   function showPage(p){
     const rc = ROLES[currentRole] || ROLES.pending;
     if(currentRole !== 'director' && !rc.nav.includes(p)){
       toast('⛔ Sin acceso a esta sección'); return;
     }
     document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
     document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
     const pg = document.getElementById('pg-' + p);
     if(pg) pg.classList.add('active');
     const nv = document.getElementById('nav-' + p);
     if(nv) nv.classList.add('active');

     // ── Tabla de despacho — cada nueva página es una línea, no un if ──
     const PAGE_RENDERERS = {
       sprint:      () => { renderSprint(); renderMatrix(); renderGoals(); },
       equipo:      () => { renderFamily(); renderTeam(); renderCheckins(); },
       coach:       () => { renderScenarios(); initMoodUI(); if(!planOrder.length) refreshDayPlan(); else renderDayPlan(); },
       control:     () => renderControlTower(),
       familia:     () => loadFamiliaPanel(),
       dashboard:   () => renderDashboard(),
       club:        () => renderClubPage(),
       bazar:       () => renderBazarPage(),
       tienda:      () => renderTiendaPage(),
       roles:       () => renderRolesPanel(),
       semana:      () => renderWeekPlanner(),
       personas:    () => renderPersonasPanel(),
       'mi-panel':  () => renderMiPanel(),
       permisos:    () => renderPermissionsCenter(),
       auditoria:   () => loadAuditData(),
       admin:       () => loadAdminPanel(),
       // ── Nuevas páginas (sin tocar el resto del código) ──
       kanban:      () => window.GPC?.Kanban.render(),
       calendario:  () => window.GPC?.Calendar.render(),
     };

     PAGE_RENDERERS[p]?.();
     window.scrollTo(0, 0);
   }

   ─────────────────────────────────────────────────────────────────────────
   PASO 4 — Añadir 'kanban' y 'calendario' en los nav de los roles deseados:
   ─────────────────────────────────────────────────────────────────────────
   // En el objeto ROLES de index.html, añadir a los roles relevantes:

   director:              { nav: [..., 'kanban', 'calendario'], ... }
   coordinadora_bazares:  { nav: [..., 'kanban', 'calendario'], ... }
   coordinadora_tienda:   { nav: [..., 'kanban'], ... }
   mama:                  { nav: [..., 'kanban', 'calendario'], ... }
   programador:           { nav: [..., 'kanban'], ... }

   // Para el nav dinámico (renderDynamicNav), añadir los íconos:
   // 'kanban'     → { icon: '📋', label: 'Kanban' }
   // 'calendario' → { icon: '📅', label: 'Calendario' }
   // (Busca el objeto NAV_ICONS o equivalente en index.html)
   ════════════════════════════════════════════════════════════════════════════ */
