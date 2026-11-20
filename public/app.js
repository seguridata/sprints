import * as S from '/lib/scheduler.js';

// ================= estado =================
let db = null;
let sched = null;
let providers = {};
const ui = {
  view: 'proyecto',
  projectId: localGet('projectId'),
  tab: localGet('tab') || 'resumen',
  ganttZoom: Number(localGet('ganttZoom')) || 28,
  boardSprint: 'actual',
  boardMember: '',
  burnSprint: null,
  chatOpen: localGet('chatOpen') !== '0',
  attachments: [],
  sending: false,
};

// Cuenta con la que se inició sesión (la valida el servidor con una cookie).
// `profile.id` es la persona del Equipo ligada a la cuenta (para "Mis tareas"); puede ser null.
let me = null;
let profile = null;
let authMode = 'password'; // 'google' cuando el servidor tiene configurado el inicio con Google
let authDomain = 'seguridata.com';
const profileKey = () => me?.id || 'anon';
const isAdmin = () => me?.role === 'admin';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const h1 = (n) => (n == null ? '—' : (Math.round(n * 10) / 10).toLocaleString('es-MX'));
function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } }
function safeJson(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

const project = () => db.projects.find((p) => p.id === ui.projectId);
const memberName = (id) => db.team.find((m) => m.id === id)?.name || (id === '__equipo' ? 'Equipo' : '—');
const memberColor = (id) => {
  const i = sched.team.findIndex((m) => m.id === id);
  return `var(--s${(Math.max(0, i) % 8) + 1})`;
};
const projectColor = (p) => `var(--s${(db.projects.indexOf(p) % 8) + 1})`;
const statusLabel = (id) => S.STATUSES.find((s) => s.id === id)?.label || id;

// ================= datos =================
// Llamadas al servidor: la sesión viaja en una cookie. Si expira, se pide iniciar sesión de nuevo.
async function api(url, opts = {}) {
  const r = await fetch(url, { ...opts, credentials: 'same-origin' });
  if (r.status === 401 && url !== '/api/auth') {
    await showLogin();
    return api(url, opts);
  }
  return r;
}

const postAuth = (body) => fetch('/api/auth', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// Pantalla de inicio de sesión a página completa (la app no se muestra detrás).
// Con Google: solo el botón "Iniciar sesión con Google". Sin Google: formulario de respaldo.
const GOOGLE_ICON = '<svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';

function loginCard(inner) {
  const screen = $('#loginScreen');
  screen.innerHTML = `<main class="login-card">
      <img class="login-logo" src="/logo-seguridata.webp" alt="SeguriData — Information Security">
      <h1>Agente de Sprints</h1>
      <p class="login-sub">Planifica tus proyectos por sprints con IA: tiempos con el horario real del equipo, Gantt, tablero y burndown.</p>
      ${inner}
    </main>`;
  screen.hidden = false;
  document.body.classList.add('logged-out');
  return screen;
}
function hideLoginScreen() {
  $('#loginScreen').hidden = true;
  $('#loginScreen').innerHTML = '';
  document.body.classList.remove('logged-out');
}

async function showLogin() {
  const info = await (await fetch('/api/auth', { credentials: 'same-origin' })).json();
  if (info.user) { hideLoginScreen(); return; }
  authMode = info.mode || 'password';
  authDomain = info.domain || authDomain;
  // Error devuelto por el regreso de Google (?login_error=...)
  const params = new URLSearchParams(location.search);
  const loginError = params.get('login_error');
  if (loginError) history.replaceState(null, '', location.pathname);
  const errorHtml = (msg) => `<p class="login-error" id="authError" ${msg ? '' : 'hidden'}>${esc(msg || '')}</p>`;

  if (authMode === 'google') {
    loginCard(`
      ${errorHtml(loginError)}
      <a class="login-btn" href="/api/auth?action=google">${GOOGLE_ICON}<span>Iniciar sesión con Google</span></a>
      <p class="login-foot">Uso interno. Inicia sesión con tu cuenta @${esc(authDomain)}.</p>`);
    return new Promise(() => {}); // el navegador sale hacia Google; al volver se recarga la página
  }

  // Respaldo sin Google: crear el primer administrador o entrar con correo y contraseña
  const setup = info.needsSetup;
  return new Promise((resolve) => {
    const screen = loginCard(`
      <form id="authForm" class="login-form">
        ${setup ? `<p class="login-note">Primera vez: la cuenta que crees será de <strong>administrador</strong>.</p>
          ${info.setupNeedsCode ? '<label class="field">Código de instalación<input name="code" type="password" required autocomplete="off"></label>' : ''}
          <label class="field">Nombre<input name="name" required maxlength="60" autocomplete="name"></label>` : ''}
        <label class="field">Correo<input name="email" type="email" required autocomplete="${setup ? 'email' : 'username'}"></label>
        <label class="field">Contraseña${setup ? ' (mínimo 10 caracteres)' : ''}<input name="password" type="password" required ${setup ? 'minlength="10" autocomplete="new-password"' : 'autocomplete="current-password"'}></label>
        ${errorHtml(loginError)}
        <button class="login-btn" type="submit"><span>${setup ? 'Crear cuenta y entrar' : 'Iniciar sesión'}</span></button>
      </form>
      <p class="login-foot">${setup ? 'Uso interno de SeguriData.' : '¿Olvidaste tu contraseña? Pídele a un administrador que la restablezca.'}</p>`);
    screen.querySelector('input')?.focus();
    $('#authForm', screen).onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true;
      const r = await postAuth({ action: setup ? 'setup' : 'login', ...f });
      const j = await r.json().catch(() => ({}));
      btn.disabled = false;
      if (!r.ok) { const er = $('#authError', screen); er.textContent = j.error || 'No se pudo entrar'; er.hidden = false; return; }
      hideLoginScreen();
      resolve();
    };
  });
}

function openAccountMenu() {
  openModal('Mi cuenta', `
    <p><strong>${esc(me.name)}</strong> · ${esc(me.email)} · <span class="pill ${isAdmin() ? 'good' : ''}">${isAdmin() ? 'Administrador' : 'Miembro'}</span></p>
    <p class="muted small">${profile?.id ? `Ligada a <strong>${esc(memberName(profile.id))}</strong> del Equipo.` : 'Tu cuenta no está ligada a una persona del Equipo, así que no tienes "Mis tareas". Un administrador puede ligarla en Usuarios.'}</p>
    ${authMode === 'google' ? `<p class="muted small">Entras con tu cuenta de Google @${esc(authDomain)}; la contraseña se administra en Google.</p>
    <div class="row"><span class="spacer"></span><button type="button" class="btn danger" id="logoutBtn">Cerrar sesión</button></div>` : `
    <form id="pwForm" class="grid">
      <h3>Cambiar contraseña</h3>
      <div class="form-grid">
        <label class="field">Contraseña actual<input name="current" type="password" required autocomplete="current-password"></label>
        <label class="field">Nueva (mínimo 10 caracteres)<input name="next" type="password" required minlength="10" autocomplete="new-password"></label>
      </div>
      <p class="pill" id="pwMsg" hidden></p>
      <div class="row"><button type="button" class="btn danger" id="logoutBtn">Cerrar sesión</button><span class="spacer"></span><button class="btn primary" type="submit">Cambiar contraseña</button></div>
    </form>`}`, (el) => {
    $('#logoutBtn', el).onclick = async () => { await postAuth({ action: 'logout' }); location.reload(); };
    if (!$('#pwForm', el)) return;
    $('#pwForm', el).onsubmit = async (e) => {
      e.preventDefault();
      const r = await postAuth({ action: 'password', ...Object.fromEntries(new FormData(e.target)) });
      const j = await r.json().catch(() => ({}));
      const m = $('#pwMsg', el);
      m.hidden = false;
      m.className = `pill ${r.ok ? 'good' : 'bad'}`;
      m.textContent = r.ok ? 'Contraseña actualizada. Se cerraron tus otras sesiones.' : j.error || 'No se pudo cambiar';
      if (r.ok) e.target.reset();
    };
  });
}

let storage = 'archivo';
async function load() {
  const r = await api('/api/state');
  const data = await r.json();
  if (!r.ok) { $('#view').innerHTML = `<div class="empty">${esc(data.error || 'No se pudo cargar')}</div>`; return; }
  db = data.db;
  me = data.me;
  authMode = data.auth?.mode || authMode;
  authDomain = data.auth?.domain || authDomain;
  profile = { id: me.memberId && db.team.some((m) => m.id === me.memberId) ? me.memberId : null, name: me.name };
  document.body.classList.toggle('member', !isAdmin());
  document.body.classList.add('ready');
  providers = data.providers || {};
  storage = data.storage || 'archivo';
  if (!project() && db.projects.length) ui.projectId = db.projects[0].id;
  if (!db.projects.length && ui.view === 'proyecto') ui.view = 'cartera';
  if (!ui.profileApplied) { ui.boardMember = profile.id || ''; ui.chatState = loadChat(aiCfg().provider); }
  ui.profileApplied = true;
  if (!isAdmin() && ['equipo', 'plantillas', 'config', 'usuarios'].includes(ui.view)) ui.view = 'mis';
  recompute();
  render();
}
// Los proyectos sin acceso llegan solo como carga de trabajo (sin nombres) para que las fechas sean reales
function recompute() {
  const forSchedule = db.hiddenLoad?.length ? { ...db, projects: [...db.projects, ...db.hiddenLoad] } : db;
  sched = S.schedulePortfolioWithBaseline(forSchedule, S.nowLocalString());
}

let saveTimer = null;
function commit({ rerender = true } = {}) {
  recompute();
  if (rerender) render();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const r = await api('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ db }) });
    if (!r.ok) { alert('No se pudo guardar: ' + (await r.text())); return; }
    // El servidor devuelve el historial de actividad actualizado (con autor)
    const j = await r.json().catch(() => ({}));
    if (Array.isArray(j.activity)) {
      db.activity = j.activity;
      if (ui.tab === 'actividad' && ui.view === 'proyecto' && $('#modal').hidden) render();
    }
  }, 250);
}

// ================= render principal =================
function render() {
  localSet('projectId', ui.projectId || '');
  localSet('tab', ui.tab);
  $('.app').classList.toggle('chat-hidden', !ui.chatOpen);
  renderSidebar();
  const p = project();
  $('#storageBanner').innerHTML = storageWarning();
  const tabs = $('#tabs');
  if (ui.view === 'proyecto' && p) {
    const sp = sched.projects[p.id];
    $('#pageTitle').textContent = p.name;
    $('#pageSubtitle').innerHTML = `${esc(p.client || '')}${p.client ? ' · ' : ''}Inicio ${S.fmtDate(p.startDate)} · Término estimado <strong>${sp ? S.fmtDate(sp.end) : '—'}</strong> · Sprints de ${p.sprintWeeks} semana(s)${p.status === 'archivado' ? ' · <span class="pill">Archivado</span>' : ''}`;
    const T = [['resumen', 'Resumen'], ['tareas', 'Tareas'], ['gantt', 'Gantt'], ['tablero', 'Tablero'], ['burndown', 'Burndown'], ['actividad', 'Actividad']];
    tabs.innerHTML = T.map(([id, l]) => `<button data-tab="${id}" class="${ui.tab === id ? 'active' : ''}">${l}</button>`).join('');
    tabs.hidden = false;
    const fn = { resumen: viewResumen, tareas: viewTareas, gantt: viewGantt, tablero: viewTablero, burndown: viewBurndown, actividad: viewActividad }[ui.tab] || viewResumen;
    if (p.status === 'archivado' && ['gantt', 'tablero', 'burndown'].includes(ui.tab)) {
      $('#view').innerHTML = `<div class="empty">El proyecto está archivado y no se planifica. Reactívalo desde Resumen → Editar proyecto.</div>`;
    } else fn(p);
  } else {
    tabs.hidden = true;
    const map = {
      mis: [profile ? `Mis tareas — ${profile.name}` : 'Mis tareas', 'Lo que tienes asignado en todos los proyectos, en orden de fechas', viewMisTareas],
      cartera: ['Cartera y carga del equipo', 'Todos los proyectos en una sola línea de tiempo y la ocupación semanal de cada persona', viewCartera],
      equipo: ['Equipo', 'Personas, rol y dedicación; se comparten entre proyectos según prioridad', viewEquipo],
      plantillas: ['Plantillas', 'Arranca proyectos repetibles en segundos', viewPlantillas],
      config: ['Calendario y configuración', 'Horario laboral, días festivos, factor de enfoque y respaldo', viewConfig],
      usuarios: ['Usuarios', 'Cuentas, roles y a qué persona del Equipo corresponde cada una', viewUsuarios],
    };
    const [t, sub, fn] = map[ui.view] || map.cartera;
    $('#pageTitle').textContent = t;
    $('#pageSubtitle').textContent = sub;
    fn();
  }
  renderChat();
}

function storageWarning() {
  if (storage !== 'temporal') return '';
  return '<div class="card" style="margin:0 20px 8px;border-color:var(--warn)"><span class="pill warn">Atención</span> Los datos se guardan de forma temporal en el servidor y pueden borrarse. Conecta una base Redis (Upstash) en Vercel para conservarlos.</div>';
}

function renderSidebar() {
  $('#profileChip').innerHTML = `<span class="dot" style="background:${profile.id ? memberColor(profile.id) : 'var(--muted)'}"></span><span class="profile-name" title="${esc(me.email)}">${esc(me.name)} <span class="muted small">· ${isAdmin() ? 'Admin' : 'Miembro'}</span></span><a href="#" data-act="profile">Mi cuenta</a>`;
  const mine = profile?.id ? myTasks().filter((x) => x.t.status !== 'done').length : 0;
  $('#myCount').textContent = mine ? String(mine) : '';
  $('#myCount').hidden = !mine;
  $('#projectList').innerHTML = db.projects
    .slice()
    .sort((a, b) => (a.status === 'archivado') - (b.status === 'archivado') || (a.priority || 99) - (b.priority || 99))
    .map((p) => `<a href="#" data-project="${p.id}" class="${ui.view === 'proyecto' && ui.projectId === p.id ? 'active' : ''}" style="${p.status === 'archivado' ? 'opacity:.55' : ''}"><span class="dot" style="background:${projectColor(p)}"></span>${esc(p.name)}</a>`)
    .join('') || `<div class="muted small" style="padding:6px 8px">${isAdmin() ? 'Sin proyectos. Crea uno o pídeselo al agente.' : 'No tienes proyectos asignados. Pide a un administrador que te agregue en “Editar proyecto → Personas asignadas”.'}</div>`;
  $$('.navlink').forEach((a) => a.classList.toggle('active', ui.view === a.dataset.view));
}

// ================= mis tareas =================
// Tareas de la persona del perfil (asignadas a mano o por el planificador), en todos los proyectos activos
function myTasks() {
  if (!profile?.id) return [];
  const out = [];
  for (const p of db.projects) {
    if (p.status === 'archivado') continue;
    for (const t of p.tasks) {
      const st = sched.tasks[t.id];
      if (st && st.assignee === profile.id) out.push({ p, t, st });
    }
  }
  return out.sort((a, b) => a.st.start - b.st.start);
}

function viewMisTareas() {
  if (!profile.id) {
    $('#view').innerHTML = `<div class="empty">Tu cuenta no está ligada a una persona del Equipo, así que no tienes tareas asignadas.<br><br>${isAdmin() ? '<button class="btn" data-view="usuarios">Ligar mi cuenta en Usuarios</button>' : 'Pídele a un administrador que la ligue en <strong>Usuarios</strong>.'}</div>`;
    return;
  }
  const all = myTasks();
  const nowDay = Math.floor(sched.now / 1440);
  const weekEnd = (nowDay - ((((nowDay + 4) % 7) + 6) % 7) + 7) * 1440;
  const active = all.filter((x) => x.t.status === 'doing' || x.t.status === 'review');
  const todo = all.filter((x) => x.t.status === 'todo');
  const done = all.filter((x) => x.t.status === 'done').sort((a, b) => (b.t.doneAt || '').localeCompare(a.t.doneAt || '')).slice(0, 8);
  const pending = [...active, ...todo];
  const pendingHours = pending.reduce((a, x) => a + S.taskRemaining(x.t, db.settings), 0);
  const thisWeek = pending.filter((x) => x.st.start < weekEnd).length;
  const late = pending.filter((x) => x.st.late || (x.t.dueDate && x.st.end > S.toAbs(x.t.dueDate) + 1440));
  const freeAt = pending.length ? Math.max(...pending.map((x) => x.st.end)) : null;

  const row = (x) => `<tr data-id="${x.t.id}" data-pid="${x.p.id}">
      <td><span class="dot" style="background:${projectColor(x.p)};display:inline-block"></span> <span class="small">${esc(x.p.name)}</span></td>
      <td><strong>${esc(x.t.title)}</strong>${x.st.autoAssigned ? ' <span class="pill" title="El planificador te la asignó porque te desocupas primero">auto</span>' : ''}${x.st.late ? ' <span class="pill bad">tarde</span>' : ''}</td>
      <td style="min-width:120px"><select data-f="status">${S.STATUSES.map((s) => `<option value="${s.id}" ${x.t.status === s.id ? 'selected' : ''}>${s.label}</option>`).join('')}</select></td>
      <td style="width:80px"><input data-f="remaining" type="number" min="0" step="0.5" value="${x.t.status === 'done' ? 0 : x.t.remaining ?? ''}" placeholder="${S.taskEstimate(x.t, db.settings)}" ${x.t.status === 'done' ? 'disabled' : ''} title="Horas restantes"></td>
      <td style="width:80px"><input data-f="actualHours" type="number" min="0" step="0.5" value="${x.t.actualHours ?? ''}" title="Horas reales invertidas"></td>
      <td class="small">${x.t.status === 'done' ? `Terminó ${S.fmtDate(x.t.doneAt)}` : `${S.fmtDate(x.st.start, true)} → ${S.fmtDate(x.st.end, true)}`}</td>
      <td class="num">S${(x.st.sprint ?? 0) + 1}</td>
    </tr>`;
  const table = (title, list, empty) => `<h3>${title} <span class="muted">${list.length}</span></h3>
    <div class="table-wrap"><table class="data myTable"><thead><tr><th>Proyecto</th><th>Tarea</th><th>Estado</th><th>Restantes</th><th>Reales</th><th>Fechas</th><th class="num">Sprint</th></tr></thead>
    <tbody>${list.map(row).join('') || `<tr><td colspan="7" class="muted">${empty}</td></tr>`}</tbody></table></div>`;

  $('#view').innerHTML = `
    <div class="grid kpis">
      <div class="card kpi"><div class="label">Horas pendientes</div><div class="value">${h1(pendingHours)} h</div><div class="hint">${pending.length} tarea(s)</div></div>
      <div class="card kpi"><div class="label">Para esta semana</div><div class="value">${thisWeek}</div><div class="hint">tareas que empiezan antes del lunes</div></div>
      <div class="card kpi"><div class="label">Con riesgo</div><div class="value">${late.length}</div><div class="hint">${late.length ? 'terminarían después de su fecha límite' : 'ninguna después de su fecha límite'}</div></div>
      <div class="card kpi"><div class="label">Te desocupas</div><div class="value">${freeAt ? S.fmtDate(freeAt) : 'Ya'}</div><div class="hint">según el plan actual</div></div>
    </div>
    ${table('En curso', active, 'Nada en progreso. Arranca la siguiente de “Por hacer”.')}
    ${table('Por hacer', todo, 'Sin pendientes.')}
    ${table('Terminadas recientemente', done, 'Aún no terminas tareas.')}
    <p class="muted small">Registra las horas reales al terminar: con ellas se mide la precisión y el factor IA real.</p>`;

  $$('.myTable').forEach((tb) => tb.addEventListener('change', (e) => {
    const tr = e.target.closest('tr[data-id]');
    const p = db.projects.find((x) => x.id === tr.dataset.pid);
    const t = p?.tasks.find((x) => x.id === tr.dataset.id);
    if (!t) return;
    const f = e.target.dataset.f;
    const v = e.target.value;
    const now = S.nowLocalString();
    if (f === 'status') {
      S.setTaskStatus(t, v, now, db.settings);
      if (v === 'done' && !t.actualHours) {
        const h = prompt(`Horas reales invertidas en "${t.title}" (opcional):`, S.taskEstimate(t, db.settings));
        if (h != null && h !== '' && !isNaN(Number(h))) t.actualHours = Number(h);
      }
    } else if (f === 'remaining') S.setTaskRemaining(t, v, now);
    else if (f === 'actualHours') t.actualHours = v === '' ? null : Number(v);
    commit();
  }));
}

function activityList(entries) {
  if (!entries.length) return '<div class="empty">Sin actividad registrada todavía.</div>';
  let html = '';
  let day = null;
  for (const e of entries) {
    const d = (e.at || '').slice(0, 10);
    if (d !== day) { day = d; html += `<h3>${S.fmtDate(d)}</h3>`; }
    html += `<div class="activity-row"><span class="muted small">${(e.at || '').slice(11, 16)}</span> <strong>${esc(e.author)}</strong> ${esc(e.text)}${e.projectName && ui.view !== 'proyecto' ? ` <span class="muted small">· ${esc(e.projectName)}</span>` : ''}</div>`;
  }
  return html;
}

function viewActividad(p) {
  const entries = (db.activity || []).filter((e) => e.projectId === p.id).slice(0, 200);
  $('#view').innerHTML = `<div class="card">${activityList(entries)}</div>
    <p class="muted small">Cada cambio se firma con el nombre de la cuenta que lo hizo. Los cambios hechos por el agente dicen “vía agente”.</p>`;
}

// ================= usuarios (solo administradores) =================
async function viewUsuarios() {
  if (!isAdmin()) { $('#view').innerHTML = '<div class="empty">Solo un administrador puede ver esta sección.</div>'; return; }
  $('#view').innerHTML = '<div class="empty">Cargando…</div>';
  const r = await api('/api/users');
  const j = await r.json();
  if (!r.ok) { $('#view').innerHTML = `<div class="empty">${esc(j.error)}</div>`; return; }
  const users = j.users;
  const teamOpts = (sel) => `<option value="">— Ninguna —</option>${db.team.map((m) => `<option value="${m.id}" ${sel === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}`;
  const linked = new Set(users.map((u) => u.memberId).filter(Boolean));
  $('#view').innerHTML = `
    <div class="card" style="margin-bottom:12px">
      <h2>Cómo funcionan los permisos</h2>
      <ul class="small" style="margin:0;padding-left:18px">
        <li><strong>Administrador:</strong> ve y edita todo: proyectos, equipo, configuración, plantillas y usuarios.</li>
        <li><strong>Miembro:</strong> ve solo los proyectos donde está asignado (en “Editar proyecto → Personas asignadas”) y los que no tienen personas marcadas (de todo el equipo). Puede trabajar las tareas de esos proyectos, pero no crear o borrar proyectos ni cambiar equipo o configuración.</li>
        <li>Liga cada cuenta con su persona del <strong>Equipo</strong> para que tenga “Mis tareas” y los permisos por proyecto.</li>
        ${authMode === 'google' ? `<li><strong>Acceso con Google:</strong> cualquier cuenta @${esc(authDomain)} puede entrar; la primera vez se crea como miembro sin proyectos privados. Puedes darla de alta antes para que entre ya con su rol y su persona. Para impedirle la entrada, <strong>desactívala</strong>.</li>` : ''}
      </ul>
    </div>
    <div class="table-wrap"><table class="data" id="usersTable"><thead><tr><th>Nombre</th><th>Correo</th><th>Rol</th><th>Persona del Equipo</th><th>${authMode === 'google' ? 'Último acceso' : 'Alta'}</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr data-uid="${u.id}">
        <td><input data-f="name" value="${esc(u.name)}">${u.id === me.id ? ' <span class="pill">tú</span>' : ''}</td>
        <td class="small">${esc(u.email)}</td>
        <td style="width:140px"><select data-f="role"><option value="miembro" ${u.role !== 'admin' ? 'selected' : ''}>Miembro</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Administrador</option></select></td>
        <td style="width:180px"><select data-f="memberId">${teamOpts(u.memberId)}</select></td>
        <td class="small">${authMode === 'google' ? (u.lastLogin ? S.fmtDate(u.lastLogin, true) : '<span class="muted">Aún no entra</span>') : S.fmtDate(u.createdAt)}</td>
        <td style="white-space:nowrap">${u.disabled ? '<span class="pill bad">Desactivada</span> ' : ''}${authMode === 'google'
          ? (u.id === me.id ? '' : `<button class="btn small" data-act="user-toggle" data-disabled="${u.disabled ? '0' : '1'}">${u.disabled ? 'Reactivar' : 'Desactivar'}</button>`)
          : `<button class="btn small" data-act="user-reset">Restablecer contraseña</button>${u.id === me.id ? '' : '<button class="btn ghost small danger" data-act="user-del">✕</button>'}`}</td>
      </tr>`).join('')}
    </tbody></table></div>
    <form id="newUser" class="card" style="margin-top:12px">
      <h2>Agregar usuario</h2>
      <div class="form-grid">
        <label class="field">Nombre<input name="name" required maxlength="60"></label>
        <label class="field">Correo<input name="email" type="email" required ${authMode === 'google' ? `placeholder="nombre@${esc(authDomain)}"` : ''}></label>
        <label class="field">Rol<select name="role"><option value="miembro">Miembro</option><option value="admin">Administrador</option></select></label>
        <label class="field">Persona del Equipo<select name="memberId">${teamOpts(db.team.find((m) => !linked.has(m.id))?.id || '')}</select></label>
        ${authMode === 'google' ? '' : `<label class="field">Contraseña inicial<input name="password" required minlength="10" value="${genPassword()}"></label>`}
      </div>
      <p class="muted small">${authMode === 'google' ? `La persona entra con su cuenta de Google @${esc(authDomain)} en ${esc(location.origin)}.` : `Comparte la contraseña inicial por un canal privado y pide que la cambien en “Mi cuenta”. La URL de la app es ${esc(location.origin)}.`}</p>
      <p class="pill bad" id="userErr" hidden></p>
      <div class="row"><span class="spacer"></span><button class="btn primary" type="submit">Crear usuario</button></div>
    </form>`;

  const call = async (method, body) => {
    const res = await api('/api/users', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) { alert(out.error || 'No se pudo guardar'); return false; }
    return true;
  };
  $('#usersTable').addEventListener('change', async (e) => {
    const id = e.target.closest('tr').dataset.uid;
    if (await call('PUT', { id, [e.target.dataset.f]: e.target.value }) && id === me.id) return load();
    viewUsuarios();
  });
  $('#usersTable').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    e.stopPropagation();
    const id = b.closest('tr').dataset.uid;
    const name = b.closest('tr').querySelector('[data-f=name]').value;
    if (b.dataset.act === 'user-reset') {
      const pw = prompt(`Nueva contraseña para ${name} (mínimo 10 caracteres). Cierra sus sesiones abiertas:`, genPassword());
      if (pw && await call('PUT', { id, password: pw })) alert(`Contraseña de ${name} actualizada. Compártela por un canal privado.`);
    }
    if (b.dataset.act === 'user-toggle') {
      const disabling = b.dataset.disabled === '1';
      if (!disabling || confirm(`¿Desactivar la cuenta de ${name}? No podrá entrar aunque use su cuenta de Google.`)) {
        if (await call('PUT', { id, disabled: disabling })) viewUsuarios();
      }
    }
    if (b.dataset.act === 'user-del' && confirm(`¿Eliminar la cuenta de ${name}? Ya no podrá entrar. Sus tareas y su historial se conservan.`)) {
      if (await call('DELETE', { id })) viewUsuarios();
    }
  }, true);
  $('#newUser').onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    const res = await api('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) { const er = $('#userErr'); er.textContent = out.error; er.hidden = false; return; }
    alert(authMode === 'google' ? `Usuario dado de alta. ${body.email} ya puede entrar con su cuenta de Google.` : `Usuario creado.\n\nCorreo: ${body.email}\nContraseña inicial: ${body.password}\n\nCompártela por un canal privado.`);
    viewUsuarios();
  };
}

function genPassword() {
  const w = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const a = crypto.getRandomValues(new Uint8Array(16));
  return [...a].map((b) => w[b % w.length]).join('').match(/.{4}/g).join('-');
}

// ================= vista: resumen =================
function viewResumen(p) {
  const sp = sched.projects[p.id];
  if (!sp) return;
  const weekly = S.weeklyHours(db.settings);
  const teamWeekly = sp.members.reduce((a, id) => a + (Number(db.team.find((m) => m.id === id)?.allocation) || 1), 0) * weekly * db.settings.focusFactor;
  const cur = sp.currentSprint;
  const unassigned = p.tasks.filter((t) => t.status !== 'done' && !t.assignee).length;
  const noEstimate = p.tasks.filter((t) => !S.taskEstimate(t, db.settings)).length;
  const overloaded = sp.sprints.filter((s) => s.load > 1.05);
  const late = p.tasks.filter((t) => sched.tasks[t.id]?.late);
  const baselineDiff = p.baseline?.end != null ? Math.round(sched.cal.workBetween(Math.min(p.baseline.end, sp.end), Math.max(p.baseline.end, sp.end)) / (weekly / 5) * Math.sign(sp.end - p.baseline.end)) : null;

  const kpis = [
    ['Término estimado', S.fmtDate(sp.end), baselineDiff == null ? 'Sin línea base' : baselineDiff === 0 ? 'En línea con la línea base' : `${baselineDiff > 0 ? '+' : ''}${baselineDiff} días hábiles vs línea base`],
    ['Avance', `${Math.round(sp.progress * 100)} %`, `${h1(sp.doneHours)} de ${h1(sp.totalHours)} h`],
    ['Sprint actual', cur != null ? `${cur + 1} de ${sp.sprints.length}` : `${sp.sprints.length} sprints`, cur != null ? `${S.fmtDate(sp.sprints[cur].start)} – ${S.fmtDate(sp.sprints[cur].end)}` : sched.now < sp.start ? 'Aún no inicia' : 'Fuera de rango'],
    ['Capacidad semanal', `${h1(teamWeekly)} h`, `${sp.members.length} persona(s) · enfoque ${Math.round(db.settings.focusFactor * 100)} %`],
    ['Precisión de estimación', sp.accuracy ? `${h1(sp.accuracy)}×` : '—', sp.accuracy ? `${sp.accuracy > 1.1 ? 'Se tarda más de lo estimado' : sp.accuracy < 0.9 ? 'Se tarda menos de lo estimado' : 'Estimaciones acertadas'}${sp.observedAiFactor ? ` · factor IA real ${Math.round(sp.observedAiFactor * 100)} %` : ''}` : 'Registra horas reales al terminar'],
  ];
  if (aiOn()) {
    const saved = sp.baseHours - sp.totalHours;
    const daysSaved = sp.endWithoutAi != null ? Math.round(sched.cal.workBetween(sp.end, sp.endWithoutAi) / (weekly / 5)) : 0;
    kpis.splice(1, 0, ['Ahorro con IA', `${h1(saved)} h`, `${sp.baseHours ? Math.round((saved / sp.baseHours) * 100) : 0} % menos · sin IA terminaría ${sp.endWithoutAi != null ? S.fmtDate(sp.endWithoutAi) : '—'}${daysSaved > 0 ? ` (+${daysSaved} días hábiles)` : ''}`]);
  }

  const alerts = [];
  if (overloaded.length) alerts.push(['warn', `Sprints con carga mayor a la capacidad: ${overloaded.map((s) => `${s.name} (${Math.round(s.load * 100)} %)`).join(', ')}`]);
  if (late.length) alerts.push(['bad', `${late.length} tarea(s) terminarían después de su fecha límite: ${late.map((t) => esc(t.title)).join(', ')}`]);
  if (noEstimate) alerts.push(['warn', `${noEstimate} tarea(s) sin estimación de horas`]);
  if (unassigned) alerts.push(['', `${unassigned} tarea(s) pendientes con asignación automática (el sistema elige a quien se libere primero)`]);
  sched.warnings.forEach((w) => alerts.push(['warn', esc(w)]));

  $('#view').innerHTML = `
    <div class="grid kpis">${kpis.map(([l, v, hnt]) => `<div class="card kpi"><div class="label">${l}</div><div class="value">${v}</div><div class="hint">${hnt}</div></div>`).join('')}</div>
    <div class="row" style="margin-bottom:12px">
      <button class="admin-only btn" data-act="edit-project">Editar proyecto</button>
      <button class="admin-only btn" data-act="baseline" title="Guarda las fechas actuales para medir desviaciones">${p.baseline ? 'Actualizar línea base' : 'Fijar línea base'}</button>
      <button class="admin-only btn" data-act="save-template">Guardar como plantilla</button>
      <button class="btn" data-act="export-csv">Exportar CSV</button>
      <span class="spacer"></span>
      <button class="admin-only btn danger" data-act="delete-project">Eliminar</button>
    </div>
    ${alerts.length ? `<div class="card" style="margin-bottom:12px">${alerts.map(([k, m]) => `<div style="margin:4px 0"><span class="pill ${k}">${k === 'bad' ? 'Riesgo' : k === 'warn' ? 'Atención' : 'Nota'}</span> ${m}</div>`).join('')}</div>` : ''}
    <div class="two-col">
      <div class="card">
        <h2>Sprints</h2>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Sprint</th><th>Fechas</th><th class="num">Capacidad</th><th class="num">Comprometido</th><th>Carga</th><th class="num">Terminado</th></tr></thead>
          <tbody>${sp.sprints.map((s) => {
            const load = Math.round(s.load * 100);
            const cls = s.load > 1.05 ? 'bad' : s.load > 0.9 ? 'warn' : 'good';
            return `<tr style="${s.index === cur ? 'font-weight:600' : ''}"><td>${s.name}${s.index === cur ? ' ◀' : ''}</td><td style="white-space:nowrap">${S.fmtDate(s.start).replace(/ \d{4}$/, '')} – ${S.fmtDate(s.end)}</td><td class="num">${h1(s.capacity)} h</td><td class="num">${h1(s.committed)} h</td><td><span class="pill ${cls}">${load} %</span></td><td class="num">${h1(s.completed)} h</td></tr>`;
          }).join('')}</tbody>
        </table></div>
      </div>
      <div class="card chart">
        <h2>Velocidad por sprint</h2>
        <div class="legend"><span><i class="box" style="background:var(--s1)"></i>Comprometido (h)</span><span><i class="box" style="background:var(--s3)"></i>Terminado en el sprint (h)</span><span><i style="background:var(--ideal)"></i>Capacidad</span></div>
        <div id="velocity"></div>
      </div>
    </div>
    <div class="card chart" style="margin-top:12px">
      <h2>Burndown del proyecto (release)</h2>
      <div class="legend"><span><i style="background:var(--s1)"></i>Real</span><span><i style="background:var(--s2)"></i>Pronóstico del plan</span>${p.baseline ? '<span><i style="background:var(--ideal)"></i>Línea base</span>' : ''}</div>
      <div id="release"></div>
    </div>
    ${p.description ? `<div class="card" style="margin-top:12px"><h2>Descripción</h2><div style="white-space:pre-wrap">${esc(p.description)}</div></div>` : ''}`;

  barChart($('#velocity'), {
    labels: sp.sprints.map((s) => `S${s.index + 1}`),
    series: [
      { name: 'Comprometido', color: 'var(--s1)', values: sp.sprints.map((s) => s.committed) },
      { name: 'Terminado', color: 'var(--s3)', values: sp.sprints.map((s) => s.doneInWindow) },
    ],
    line: { name: 'Capacidad', values: sp.sprints.map((s) => s.capacity) },
  });

  // Burndown del release: horas restantes al cierre de cada sprint
  const nowDay = Math.floor(sched.now / 1440);
  const pts = [{ label: 'Inicio', end: S.dayNum(p.startDate) * 1440 }].concat(sp.sprints.map((s) => ({ label: `S${s.index + 1}`, end: s.endDay * 1440 + 1439, past: s.startDay <= nowDay })));
  const real = pts.map((pt, i) => (i === 0 ? sp.totalHours : pt.past ? p.tasks.reduce((a, t) => a + S.remainingAt(t, Math.min(pt.end, sched.now), db.settings), 0) : null));
  const forecast = pts.map((pt) => p.tasks.reduce((a, t) => {
    const st = sched.tasks[t.id];
    return a + (st && st.end > pt.end ? (pt.end < st.start ? S.taskEstimate(t, db.settings) : S.taskRemaining(t, db.settings)) : 0);
  }, 0));
  const series = [
    { name: 'Real', color: 'var(--s1)', values: real, markers: true },
    { name: 'Pronóstico', color: 'var(--s2)', values: forecast, dash: '6 4' },
  ];
  if (p.baseline) {
    series.push({
      name: 'Línea base', color: 'var(--ideal)', dash: '2 4',
      values: pts.map((pt) => p.tasks.reduce((a, t) => a + ((p.baseline.tasks[t.id]?.end ?? Infinity) > pt.end ? S.taskEstimate(t, db.settings) : 0), 0)),
    });
  }
  lineChart($('#release'), { labels: pts.map((x) => x.label), series, unit: 'h' });
}

// ================= vista: tareas =================
function viewTareas(p) {
  const team = db.team;
  const idx = Object.fromEntries(p.tasks.map((t, i) => [t.id, i + 1]));
  const rows = p.tasks.map((t, i) => {
    const st = sched.tasks[t.id] || {};
    const pert = S.taskEstimate(t, db.settings);
    return `<tr data-id="${t.id}">
      <td class="muted">${i + 1}</td>
      <td style="min-width:220px"><input data-f="title" value="${esc(t.title)}" /></td>
      <td style="min-width:110px"><input data-f="phase" value="${esc(t.phase || '')}" list="phases" /></td>
      <td style="width:70px"><input data-f="estimate" type="number" min="0" step="0.5" value="${t.estimate ?? ''}" title="Horas como las haría un equipo sin IA" /></td>
      <td style="width:56px"><input data-f="optimistic" type="number" min="0" step="0.5" value="${t.optimistic ?? ''}" title="Optimista" /></td>
      <td style="width:56px"><input data-f="likely" type="number" min="0" step="0.5" value="${t.likely ?? ''}" title="Probable" /></td>
      <td style="width:56px"><input data-f="pessimistic" type="number" min="0" step="0.5" value="${t.pessimistic ?? ''}" title="Pesimista" /></td>
      ${aiOn() ? `<td style="width:64px"><input data-f="aiFactor" type="number" min="5" max="150" step="5" value="${t.aiFactor ? Math.round(t.aiFactor * 100) : ''}" placeholder="${Math.round(S.aiFactorFor({ ...t, aiFactor: null }, db.settings) * 100)}" title="% del tiempo tradicional con IA. Vacío = el del rol/fase" /></td>` : ''}
      <td class="num"><strong>${h1(pert)}</strong></td>
      <td style="min-width:120px"><select data-f="assignee"><option value="">Auto (${esc(memberName(st.assignee))})</option>${team.map((m) => `<option value="${m.id}" ${t.assignee === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></td>
      <td style="width:80px"><input data-f="deps" value="${(t.deps || []).map((d) => idx[d]).filter(Boolean).join(', ')}" placeholder="1, 2" title="Números de las tareas de las que depende" /></td>
      <td style="min-width:110px"><select data-f="status">${S.STATUSES.map((s) => `<option value="${s.id}" ${t.status === s.id ? 'selected' : ''}>${s.label}</option>`).join('')}</select></td>
      <td style="width:64px"><input data-f="remaining" type="number" min="0" step="0.5" value="${t.status === 'done' ? 0 : t.remaining ?? ''}" placeholder="${pert}" ${t.status === 'done' ? 'disabled' : ''} title="Horas restantes" /></td>
      <td style="width:64px"><input data-f="actualHours" type="number" min="0" step="0.5" value="${t.actualHours ?? ''}" title="Horas reales invertidas" /></td>
      <td class="small">${st.start != null ? S.fmtDate(st.start, true) : '—'}</td>
      <td class="small">${st.end != null ? S.fmtDate(st.end, true) : '—'}${st.late ? ' <span class="pill bad">tarde</span>' : ''}</td>
      <td class="num">${st.sprint != null ? st.sprint + 1 : '—'}</td>
      <td style="white-space:nowrap"><button class="btn ghost small" data-act="up" title="Subir">↑</button><button class="btn ghost small" data-act="down" title="Bajar">↓</button><button class="btn ghost small" data-act="open" title="Más detalles">…</button><button class="btn ghost small danger" data-act="del" title="Eliminar">✕</button></td>
    </tr>`;
  }).join('');
  const phases = [...new Set(p.tasks.map((t) => t.phase).filter(Boolean).concat(['Análisis', 'Diseño', 'Desarrollo', 'QA', 'Despliegue', 'Cierre']))];

  $('#view').innerHTML = `
    <div class="row" style="margin-bottom:10px">
      <button class="btn primary" data-act="add-task">+ Tarea</button>
      <button class="btn" data-act="bulk">Carga rápida (pegar lista)</button>
      <span class="spacer"></span>
      <span class="muted small">El orden de la lista es la prioridad. Horas y O / M / P se capturan como las haría un equipo <em>sin IA</em> (con O/M/P se usa PERT); la columna IA % reduce el tiempo según el tipo de trabajo y “Est.” son las horas que se planifican. Los cambios se guardan solos.</span>
    </div>
    <datalist id="phases">${phases.map((f) => `<option value="${esc(f)}">`).join('')}</datalist>
    <div class="table-wrap"><table class="data" id="taskTable">
      <thead><tr><th>#</th><th>Tarea</th><th>Fase</th><th title="Horas sin IA">Horas</th><th>O</th><th>M</th><th>P</th>${aiOn() ? '<th title="% del tiempo tradicional">IA %</th>' : ''}<th class="num" title="Horas planificadas">Est.</th><th>Responsable</th><th>Depende</th><th>Estado</th><th>Rest.</th><th>Reales</th><th>Inicio plan</th><th>Fin plan</th><th>Sprint</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="18" class="empty">Sin tareas. Agrega una, usa la carga rápida o pídele al agente que desglose el proyecto.</td></tr>'}</tbody>
    </table></div>`;

  $('#taskTable').addEventListener('change', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const t = p.tasks.find((x) => x.id === tr.dataset.id);
    const f = e.target.dataset.f;
    const v = e.target.value;
    if (f === 'status') S.setTaskStatus(t, v, S.nowLocalString(), db.settings);
    else if (f === 'remaining') S.setTaskRemaining(t, v, S.nowLocalString());
    else if (f === 'deps') t.deps = v.split(/[,\s]+/).map(Number).filter((n) => n >= 1 && n <= p.tasks.length).map((n) => p.tasks[n - 1].id).filter((id) => id !== t.id);
    else if (f === 'aiFactor') t.aiFactor = v === '' || Number(v) <= 0 ? null : Math.min(1.5, Number(v) / 100);
    else if (['estimate', 'optimistic', 'likely', 'pessimistic', 'actualHours'].includes(f)) t[f] = v === '' ? null : Number(v);
    else t[f] = v;
    commit();
  });
}

// ================= vista: Gantt =================
function viewGantt(p) {
  const sp = sched.projects[p.id];
  const W = ui.ganttZoom;
  const ROW = 30, HEAD = 48;
  const items = [];
  let lastPhase = null;
  const ordered = [...p.tasks].sort((a, b) => (a.phase || '').localeCompare(b.phase || '') * 0 || 0);
  for (const t of ordered) {
    if ((t.phase || '') !== lastPhase) { items.push({ phase: t.phase || 'Sin fase' }); lastPhase = t.phase || ''; }
    items.push({ task: t, st: sched.tasks[t.id] });
  }
  if (!p.tasks.length) { $('#view').innerHTML = '<div class="empty">Sin tareas para graficar.</div>'; return; }

  const starts = p.tasks.map((t) => sched.tasks[t.id]?.start).filter((x) => x != null);
  let d0 = Math.min(S.dayNum(p.startDate), ...starts.map((a) => Math.floor(a / 1440)));
  d0 -= ((((d0 + 4) % 7) + 6) % 7); // lunes
  const d1 = Math.max(Math.floor(sp.end / 1440), ...sp.sprints.map((s) => s.endDay)) + 3;
  const days = d1 - d0 + 1;
  const width = days * W;
  const height = HEAD + items.length * ROW;
  const xOf = (abs) => {
    const day = Math.floor(abs / 1440);
    const ivs = sched.cal.intervals(day);
    let frac = 0;
    if (ivs.length) {
      const s = ivs[0][0], e = ivs[ivs.length - 1][1];
      frac = Math.min(1, Math.max(0, (abs - day * 1440 - s) / (e - s)));
    } else frac = abs - day * 1440 > 720 ? 1 : 0;
    return (day - d0) * W + frac * W;
  };
  const nowX = xOf(sched.now);
  const meses = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const holidays = new Set(db.settings.holidays);
  let svg = '';
  // fondos: fines de semana / festivos
  for (let i = 0; i < days; i++) {
    const d = d0 + i;
    const ds = S.dayStr(d);
    if (!sched.cal.isWorkday(d)) svg += `<rect x="${i * W}" y="${HEAD}" width="${W}" height="${height - HEAD}" fill="${holidays.has(ds) ? 'var(--holiday)' : 'var(--weekend)'}"/>`;
  }
  // bandas de sprint
  sp.sprints.forEach((s) => {
    const x = (s.startDay - d0) * W;
    svg += `<line x1="${x}" y1="0" x2="${x}" y2="${height}" stroke="var(--border)"/>`;
    svg += `<text x="${x + 4}" y="14" style="font-weight:600">${s.name}${s.index === sp.currentSprint ? ' (actual)' : ''}</text>`;
  });
  // encabezado de días/semanas
  for (let i = 0; i < days; i++) {
    const d = d0 + i;
    const ds = S.dayStr(d);
    const wd = S.weekdayOf(ds);
    if (W >= 20) svg += `<text x="${i * W + W / 2}" y="40" text-anchor="middle">${Number(ds.slice(8))}</text>`;
    if (wd === 1 && W < 20) svg += `<text x="${i * W + 2}" y="40">${Number(ds.slice(8))} ${meses[Number(ds.slice(5, 7)) - 1]}</text>`;
    if (ds.slice(8) === '01' || i === 0) svg += `<text x="${i * W + 2}" y="28" style="font-weight:600">${meses[Number(ds.slice(5, 7)) - 1]} ${ds.slice(0, 4)}</text>`;
  }
  svg += `<line x1="0" y1="${HEAD}" x2="${width}" y2="${HEAD}" stroke="var(--border)"/>`;
  // filas
  const rowY = {};
  items.forEach((it, r) => {
    const y = HEAD + r * ROW;
    svg += `<line x1="0" y1="${y + ROW}" x2="${width}" y2="${y + ROW}" stroke="var(--grid)"/>`;
    if (it.task) rowY[it.task.id] = y;
  });
  // fases: barra resumen
  items.forEach((it, r) => {
    if (!it.phase) return;
    const ts = p.tasks.filter((t) => (t.phase || 'Sin fase') === it.phase).map((t) => sched.tasks[t.id]).filter(Boolean);
    if (!ts.length) return;
    const x1 = xOf(Math.min(...ts.map((x) => x.start))), x2 = xOf(Math.max(...ts.map((x) => x.end)));
    const y = HEAD + r * ROW;
    svg += `<rect x="${x1}" y="${y + 12}" width="${Math.max(2, x2 - x1)}" height="6" rx="2" fill="var(--text-2)"/>`;
  });
  // dependencias
  for (const t of p.tasks) {
    const st = sched.tasks[t.id];
    for (const d of t.deps || []) {
      const sd = sched.tasks[d];
      if (!st || !sd || rowY[d] == null) continue;
      const xa = xOf(sd.end), ya = rowY[d] + ROW / 2, xb = xOf(st.start), yb = rowY[t.id] + ROW / 2;
      const mid = Math.max(xa + 6, Math.min(xb - 6, xa + 10));
      svg += `<path d="M${xa},${ya} H${mid} V${yb} H${xb - 2}" fill="none" stroke="var(--muted)" stroke-width="1" opacity=".7" marker-end="url(#arrow)"/>`;
    }
  }
  // línea base y barras
  for (const t of p.tasks) {
    const st = sched.tasks[t.id];
    if (!st) continue;
    const y = rowY[t.id];
    const bl = p.baseline?.tasks?.[t.id];
    if (bl) svg += `<rect x="${xOf(bl.start)}" y="${y + 22}" width="${Math.max(2, xOf(bl.end) - xOf(bl.start))}" height="4" rx="2" fill="var(--ideal)" opacity=".7"/>`;
    const x1 = xOf(st.start), x2 = xOf(st.end);
    const w = Math.max(3, x2 - x1);
    const color = memberColor(st.assignee);
    const done = t.status === 'done';
    const prog = done ? 1 : 1 - S.taskRemaining(t, db.settings) / (S.taskEstimate(t, db.settings) || 1);
    if (t.status === 'todo') {
      svg += `<rect class="gbar" data-id="${t.id}" x="${x1}" y="${y + 6}" width="${w}" height="16" rx="4" fill="var(--surface)" stroke="${color}" stroke-width="2"/>`;
    } else {
      svg += `<rect class="gbar" data-id="${t.id}" x="${x1}" y="${y + 6}" width="${w}" height="16" rx="4" fill="${color}" opacity="${done ? 1 : 0.45}"/>`;
      if (!done && prog > 0) svg += `<rect x="${x1}" y="${y + 6}" width="${Math.max(2, w * prog)}" height="16" rx="4" fill="${color}" pointer-events="none"/>`;
    }
    const label = `${done ? '✓ ' : ''}${memberName(st.assignee)}`;
    svg += `<text class="bar-label" x="${x2 + 6}" y="${y + 19}" pointer-events="none">${esc(label)}</text>`;
  }
  // hoy
  if (nowX >= 0 && nowX <= width) svg += `<line x1="${nowX}" y1="${HEAD - 8}" x2="${nowX}" y2="${height}" stroke="var(--today)" stroke-width="2"/><text x="${nowX + 3}" y="${HEAD - 2}" style="fill:var(--today);font-weight:600">Hoy</text>`;

  const left = items.map((it) => it.phase
    ? `<div class="g-row phase">${esc(it.phase)}</div>`
    : `<div class="g-row" title="${esc(it.task.title)}"><span class="dot" style="background:${memberColor(it.st?.assignee)}"></span><span style="overflow:hidden;text-overflow:ellipsis">${esc(it.task.title)}</span><span class="muted small" style="margin-left:auto">${h1(S.taskEstimate(it.task, db.settings))} h</span></div>`).join('');

  const legendMembers = [...new Set(p.tasks.map((t) => sched.tasks[t.id]?.assignee).filter(Boolean))];
  $('#view').innerHTML = `
    <div class="row" style="margin-bottom:10px">
      <span class="muted small">Zoom</span>
      ${[[32, 'Día'], [14, 'Semana'], [5, 'Mes']].map(([z, l]) => `<button class="btn small ${W === z ? 'primary' : ''}" data-zoom="${z}">${l}</button>`).join('')}
      <span class="spacer"></span>
      <div class="legend" style="margin:0">
        ${legendMembers.map((id) => `<span><i class="box" style="background:${memberColor(id)}"></i>${esc(memberName(id))}</span>`).join('')}
        <span><i class="box" style="border:2px solid var(--muted);background:transparent"></i>Por hacer</span>
        <span><i class="box" style="background:var(--muted);opacity:.45"></i>En curso (relleno = avance)</span>
        ${p.baseline ? '<span><i style="background:var(--ideal)"></i>Línea base</span>' : ''}
        <span><i class="box" style="background:var(--holiday);border:1px solid var(--border)"></i>Festivo</span>
      </div>
    </div>
    <div class="gantt">
      <div class="gantt-left"><div class="g-row g-head muted small" style="align-items:flex-end;padding-bottom:6px">Tarea · horas</div>${left}</div>
      <div class="gantt-right" id="ganttRight"><svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <defs><marker id="arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="var(--muted)"/></marker></defs>${svg}</svg></div>
    </div>
    <div class="muted small" style="margin-top:6px">Las barras respetan horario laboral, comida, viernes corto y festivos. Clic en una barra para editar la tarea.</div>`;

  const right = $('#ganttRight');
  right.scrollLeft = Math.max(0, nowX - 200);
  right.addEventListener('mousemove', (e) => {
    const id = e.target.dataset?.id;
    if (!id) return hideTip();
    const t = p.tasks.find((x) => x.id === id);
    const st = sched.tasks[id];
    showTip(e, `<strong>${esc(t.title)}</strong><br>${esc(memberName(st.assignee))}${st.autoAssigned ? ' (auto)' : ''} · ${statusLabel(t.status)}<br>${S.fmtDate(st.start, true)} → ${S.fmtDate(st.end, true)}<br>${h1(S.taskEstimate(t, db.settings))} h estimadas · ${h1(S.taskRemaining(t, db.settings))} h restantes · Sprint ${st.sprint + 1}`);
  });
  right.addEventListener('mouseleave', hideTip);
  right.addEventListener('click', (e) => { const id = e.target.dataset?.id; if (id) openTaskModal(p, id); });
}

// ================= vista: tablero =================
function viewTablero(p) {
  const sp = sched.projects[p.id];
  const sprintSel = ui.boardSprint === 'actual' ? (sp.currentSprint ?? 'todos') : ui.boardSprint;
  const tasks = p.tasks.filter((t) => {
    const st = sched.tasks[t.id];
    if (sprintSel !== 'todos' && st?.sprint !== Number(sprintSel)) return false;
    if (ui.boardMember && st?.assignee !== ui.boardMember) return false;
    return true;
  });
  const cols = S.STATUSES.map((s) => {
    const list = tasks.filter((t) => t.status === s.id);
    const hrs = list.reduce((a, t) => a + S.taskEstimate(t, db.settings), 0);
    return `<div class="column" data-status="${s.id}">
      <div class="column-head"><span>${s.label} <span class="muted">${list.length}</span></span><span class="muted small">${h1(hrs)} h</span></div>
      ${list.map((t) => card(p, t)).join('') || '<div class="muted small" style="padding:6px">—</div>'}
    </div>`;
  }).join('');
  const done = tasks.filter((t) => t.status === 'done').reduce((a, t) => a + S.taskEstimate(t, db.settings), 0);
  const total = tasks.reduce((a, t) => a + S.taskEstimate(t, db.settings), 0);
  $('#view').innerHTML = `
    <div class="row" style="margin-bottom:12px">
      <label class="field" style="flex-direction:row;align-items:center;gap:6px">Sprint
        <select id="boardSprint"><option value="actual" ${ui.boardSprint === 'actual' ? 'selected' : ''}>Actual${sp.currentSprint != null ? ` (S${sp.currentSprint + 1})` : ''}</option><option value="todos" ${ui.boardSprint === 'todos' ? 'selected' : ''}>Todos</option>${sp.sprints.map((s) => `<option value="${s.index}" ${String(ui.boardSprint) === String(s.index) ? 'selected' : ''}>${s.name} · ${S.fmtDate(s.start)}</option>`).join('')}</select></label>
      <label class="field" style="flex-direction:row;align-items:center;gap:6px">Persona
        <select id="boardMember"><option value="">Todas</option>${sched.team.map((m) => `<option value="${m.id}" ${ui.boardMember === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
      <span class="spacer"></span>
      <span class="muted">${h1(done)} de ${h1(total)} h terminadas</span>
      <button class="btn primary" data-act="add-task">+ Tarea</button>
    </div>
    <div class="board">${cols}</div>
    <div class="muted small" style="margin-top:8px">Arrastra las tarjetas entre columnas. Al pasar a “Hecho” se registra la fecha real y alimenta el burndown.</div>`;

  $('#boardSprint').onchange = (e) => { ui.boardSprint = e.target.value; render(); };
  $('#boardMember').onchange = (e) => { ui.boardMember = e.target.value; render(); };
  $$('.kcard').forEach((c) => {
    c.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', c.dataset.id); });
    c.addEventListener('click', () => openTaskModal(p, c.dataset.id));
  });
  $$('.column').forEach((col) => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drop'); });
    col.addEventListener('dragleave', () => col.classList.remove('drop'));
    col.addEventListener('drop', (e) => {
      e.preventDefault();
      col.classList.remove('drop');
      const t = p.tasks.find((x) => x.id === e.dataTransfer.getData('text/plain'));
      if (!t) return;
      S.setTaskStatus(t, col.dataset.status, S.nowLocalString(), db.settings);
      if (t.status === 'done' && !t.actualHours) {
        const v = prompt(`Horas reales invertidas en "${t.title}" (opcional, mejora la precisión de futuras estimaciones):`, S.taskEstimate(t, db.settings));
        if (v != null && v !== '' && !isNaN(Number(v))) t.actualHours = Number(v);
      }
      commit();
    });
  });
}

function card(p, t) {
  const st = sched.tasks[t.id] || {};
  const est = S.taskEstimate(t, db.settings);
  const rem = S.taskRemaining(t, db.settings);
  const sprint = sched.projects[p.id].sprints[st.sprint];
  const late = t.status !== 'done' && sprint && st.end > sprint.endDay * 1440 + 1439;
  return `<div class="kcard" draggable="true" data-id="${t.id}" style="border-left-color:${memberColor(st.assignee)}">
    <div class="title">${esc(t.title)}</div>
    <div class="meta">
      <span>${esc(memberName(st.assignee))}</span>·<span>${h1(est)} h</span>${t.phase ? `·<span>${esc(t.phase)}</span>` : ''}
    </div>
    <div class="meta" style="margin-top:4px">
      <span>${t.status === 'done' ? `Terminó ${S.fmtDate(t.doneAt)}` : `Fin plan ${S.fmtDate(st.end)}`}</span>
      ${late ? '<span class="pill warn">Se pasa del sprint</span>' : ''}${st.late ? '<span class="pill bad">Después de fecha límite</span>' : ''}
    </div>
    ${t.status !== 'todo' && t.status !== 'done' ? `<div class="progress" title="${h1(rem)} h restantes"><div style="width:${Math.round((1 - rem / (est || 1)) * 100)}%;background:${memberColor(st.assignee)}"></div></div>` : ''}
  </div>`;
}

// ================= vista: burndown =================
function viewBurndown(p) {
  const sp = sched.projects[p.id];
  if (!sp.sprints.length) { $('#view').innerHTML = '<div class="empty">Sin sprints.</div>'; return; }
  const idx = ui.burnSprint != null && sp.sprints[ui.burnSprint] ? ui.burnSprint : (sp.currentSprint ?? 0);
  const sprint = sp.sprints[idx];
  const bd = S.burndown(p, sprint, sched);
  const nowDay = Math.floor(sched.now / 1440);
  const lastActual = [...bd.points].reverse().find((x) => x.actual != null);
  const idealNow = bd.points.find((x) => x.day === Math.min(nowDay, sprint.endDay))?.ideal;
  let status = ['', 'El sprint aún no inicia'];
  if (lastActual && nowDay >= sprint.startDay) {
    const diff = lastActual.actual - (idealNow ?? 0);
    const tol = Math.max(2, bd.total * 0.05);
    status = diff > tol ? ['bad', `Atrasado: ${h1(diff)} h por encima de la línea ideal`] : diff < -tol ? ['good', `Adelantado: ${h1(-diff)} h por debajo de la línea ideal`] : ['good', 'En línea con el plan'];
    if (nowDay > sprint.endDay) status = lastActual.actual > 0 ? ['warn', `Sprint cerrado con ${h1(lastActual.actual)} h pendientes`] : ['good', 'Sprint completado'];
  }
  const tasks = p.tasks.filter((t) => sprint.taskIds.includes(t.id));

  $('#view').innerHTML = `
    <div class="row" style="margin-bottom:12px">
      <label class="field" style="flex-direction:row;align-items:center;gap:6px">Sprint
        <select id="burnSprint">${sp.sprints.map((s) => `<option value="${s.index}" ${s.index === idx ? 'selected' : ''}>${s.name} · ${S.fmtDate(s.start)} – ${S.fmtDate(s.end)}${s.index === sp.currentSprint ? ' (actual)' : ''}</option>`).join('')}</select></label>
      <span class="pill ${status[0]}">${status[1]}</span>
    </div>
    <div class="grid kpis">
      <div class="card kpi"><div class="label">Comprometido</div><div class="value">${h1(bd.total)} h</div><div class="hint">${tasks.length} tareas</div></div>
      <div class="card kpi"><div class="label">Capacidad del sprint</div><div class="value">${h1(sprint.capacity)} h</div><div class="hint">Carga ${Math.round(sprint.load * 100)} %</div></div>
      <div class="card kpi"><div class="label">Restante hoy</div><div class="value">${lastActual ? h1(lastActual.actual) : '—'} h</div><div class="hint">Ideal: ${idealNow != null ? h1(idealNow) : '—'} h</div></div>
      <div class="card kpi"><div class="label">Terminado</div><div class="value">${h1(sprint.completed)} h</div><div class="hint">${tasks.filter((t) => t.status === 'done').length} de ${tasks.length} tareas</div></div>
    </div>
    <div class="card chart">
      <h2>Sprint Burndown — ${sprint.name}</h2>
      <div class="legend"><span><i style="background:var(--ideal)"></i>Ideal (según horas laborales)</span><span><i style="background:var(--s1)"></i>Real</span><span><i style="background:var(--s2)"></i>Pronóstico del plan</span></div>
      <div id="burnChart"></div>
      <div class="muted small">La línea ideal baja solo en horas laborales (se aplana en fines de semana y festivos, y baja menos los viernes). La real usa las horas restantes que reportas y las tareas terminadas.</div>
    </div>
    <div class="card" style="margin-top:12px">
      <h2>Tareas del sprint</h2>
      <div class="table-wrap"><table class="data"><thead><tr><th>Tarea</th><th>Responsable</th><th>Estado</th><th class="num">Est.</th><th class="num">Restante</th><th>Fin plan</th></tr></thead>
      <tbody>${tasks.map((t) => `<tr><td>${esc(t.title)}</td><td>${esc(memberName(sched.tasks[t.id]?.assignee))}</td><td>${statusLabel(t.status)}</td><td class="num">${h1(S.taskEstimate(t, db.settings))}</td><td class="num">${h1(S.taskRemaining(t, db.settings))}</td><td>${S.fmtDate(sched.tasks[t.id]?.end)}</td></tr>`).join('')}</tbody></table></div>
    </div>`;
  $('#burnSprint').onchange = (e) => { ui.burnSprint = Number(e.target.value); render(); };
  const dias = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
  lineChart($('#burnChart'), {
    labels: bd.points.map((x, i) => (i === 0 ? 'Inicio' : `${dias[S.weekdayOf(x.label)]} ${Number(x.label.slice(8))}`)),
    shade: bd.points.map((x, i) => i > 0 && !x.workday),
    series: [
      { name: 'Ideal', color: 'var(--ideal)', values: bd.points.map((x) => x.ideal), dash: '5 4' },
      { name: 'Real', color: 'var(--s1)', values: bd.points.map((x) => x.actual), markers: true },
      { name: 'Pronóstico', color: 'var(--s2)', values: bd.points.map((x) => x.forecast), dash: '2 3' },
    ],
    marker: bd.points.findIndex((x) => x.day === nowDay),
    unit: 'h',
  });
}

// ================= vista: cartera =================
function viewCartera() {
  const active = db.projects.filter((p) => p.status !== 'archivado' && sched.projects[p.id]);
  const load = S.weeklyLoad(db, sched, 12);
  let html = `<div class="card" style="margin-bottom:12px"><h2>Línea de tiempo de proyectos</h2><div id="portfolioGantt"></div></div>`;
  html += `<div class="card" style="margin-bottom:12px"><h2>Prioridad entre proyectos</h2>
    <div class="muted small" style="margin-bottom:6px">Las personas compartidas atienden primero el proyecto de mayor prioridad (1 = más alta). Cambiar la prioridad recalcula todas las fechas.</div>
    <div class="table-wrap"><table class="data"><thead><tr><th>Prioridad</th><th>Proyecto</th><th>Inicio</th><th>Término estimado</th><th class="num">Horas</th><th>Avance</th><th></th></tr></thead><tbody>
    ${active.sort((a, b) => (a.priority || 99) - (b.priority || 99)).map((p, i) => {
      const sp = sched.projects[p.id];
      return `<tr><td>${i + 1}</td><td><a href="#" data-project="${p.id}">${esc(p.name)}</a></td><td>${S.fmtDate(p.startDate)}</td><td>${S.fmtDate(sp.end)}</td><td class="num">${h1(sp.totalHours)}</td><td>${Math.round(sp.progress * 100)} %</td>
      <td><span class="admin-only"><button class="btn ghost small" data-prio="${p.id}" data-dir="-1">↑</button><button class="btn ghost small" data-prio="${p.id}" data-dir="1">↓</button></span></td></tr>`;
    }).join('') || '<tr><td colspan="7" class="empty">Sin proyectos activos</td></tr>'}</tbody></table></div></div>`;
  html += `<div class="card"><h2>Carga semanal por persona (próximas 12 semanas)</h2>
    <div class="legend"><span><i class="box" style="background:var(--good-bg)"></i>Con capacidad libre</span><span><i class="box" style="background:#86b6ef"></i>Ocupación media</span><span><i class="box" style="background:#1c5cab"></i>Ocupación completa</span></div>
    <div class="table-wrap"><table class="data heat"><thead><tr><th>Persona</th>${load.cols.map((c) => `<th class="num">${S.fmtDate(c.label).replace(/ \d{4}$/, '')}</th>`).join('')}</tr></thead><tbody>
    ${load.rows.map((r) => `<tr><td>${esc(r.member.name)} <span class="muted small">${Math.round((Number(r.member.allocation) || 1) * 100)} %</span></td>${r.cells.map((c) => {
      const ratio = Math.min(1, c.ratio);
      const bg = c.capacity === 0 ? 'var(--weekend)' : ratio < 0.05 ? 'var(--good-bg)' : ratio < 0.5 ? '#cde2fb' : ratio < 0.85 ? '#86b6ef' : '#1c5cab';
      const fg = ratio >= 0.85 ? '#fff' : ratio < 0.05 ? 'var(--good)' : '#0b0b0b';
      return `<td class="cell" style="background:${bg};color:${fg}" title="${h1(c.used)} de ${h1(c.capacity)} h efectivas">${c.capacity === 0 ? '—' : `${Math.round(ratio * 100)}%`}</td>`;
    }).join('')}</tr>`).join('')}</tbody></table></div>
    <div class="muted small" style="margin-top:6px">Las semanas en verde son capacidad libre: ahí cabe un proyecto nuevo. Pregúntale al agente “¿cuándo terminaríamos un proyecto de 120 h si empezamos el lunes?”.</div></div>`;
  html += `<div class="card" style="margin-top:12px"><h2>Actividad reciente</h2>${activityList((db.activity || []).slice(0, 15))}</div>`;
  $('#view').innerHTML = html;

  // mini Gantt de cartera
  if (!active.length) return;
  const days0 = Math.min(...active.map((p) => S.dayNum(p.startDate)));
  const days1 = Math.max(...active.map((p) => Math.floor(sched.projects[p.id].end / 1440))) + 7;
  const span = Math.max(1, days1 - days0);
  const W = 1000, ROW = 34, H = 30 + active.length * ROW;
  const xd = (d) => ((d - days0) / span) * (W - 220) + 200;
  let svg = '';
  for (let d = days0 - ((((days0 + 4) % 7) + 6) % 7); d <= days1; d += 7) {
    const x = xd(d);
    if (x < 200) continue;
    svg += `<line x1="${x}" y1="20" x2="${x}" y2="${H}" stroke="var(--grid)"/>`;
    if (((d - days0) / 7) % Math.ceil(span / 7 / 10) < 1) svg += `<text x="${x + 2}" y="14">${S.fmtDate(S.dayStr(d)).replace(/ \d{4}$/, '')}</text>`;
  }
  active.forEach((p, i) => {
    const sp = sched.projects[p.id];
    const y = 24 + i * ROW;
    const x1 = xd(S.dayNum(p.startDate)), x2 = xd(sp.end / 1440);
    svg += `<text x="0" y="${y + 16}" class="bar-label">${esc(p.name.length > 28 ? p.name.slice(0, 27) + '…' : p.name)}</text>`;
    svg += `<rect x="${x1}" y="${y + 4}" width="${Math.max(3, x2 - x1)}" height="18" rx="4" fill="${projectColor(p)}" opacity=".35"/>`;
    svg += `<rect x="${x1}" y="${y + 4}" width="${Math.max(3, (x2 - x1) * sp.progress)}" height="18" rx="4" fill="${projectColor(p)}"/>`;
    sp.sprints.forEach((s) => { const x = xd(s.startDay); svg += `<line x1="${x}" y1="${y + 4}" x2="${x}" y2="${y + 22}" stroke="var(--surface)" stroke-width="2"/>`; });
    if (p.baseline?.end) { const xb = xd(p.baseline.end / 1440); svg += `<path d="M${xb},${y + 2} l4,-5 h-8 z" fill="var(--text-2)"/>`; }
    svg += `<text x="${x2 + 6}" y="${y + 17}">${S.fmtDate(sp.end)} · ${Math.round(sp.progress * 100)} %</text>`;
  });
  const nx = xd(sched.now / 1440);
  svg += `<line x1="${nx}" y1="18" x2="${nx}" y2="${H}" stroke="var(--today)" stroke-width="2"/>`;
  $('#portfolioGantt').innerHTML = `<div class="chart"><svg viewBox="0 0 ${W + 120} ${H}" xmlns="http://www.w3.org/2000/svg">${svg}</svg></div>
    <div class="legend"><span><i class="box" style="background:var(--muted)"></i>Barra sólida = avance</span><span>Cortes = inicio de cada sprint</span><span>▼ = término según línea base</span><span><i style="background:var(--today)"></i>Hoy</span></div>`;
}

// ================= vista: equipo =================
function viewEquipo() {
  const pendingBy = {};
  for (const st of Object.values(sched.tasks)) pendingBy[st.assignee] = (pendingBy[st.assignee] || 0) + st.remaining;
  $('#view').innerHTML = `
    <div class="row" style="margin-bottom:10px"><button class="btn primary" data-act="add-member">+ Persona</button>
    <span class="muted small">Dedicación = % del tiempo disponible para proyectos (p. ej. 50 % si también da soporte). El rol permite asignar tareas automáticamente.</span></div>
    <div class="table-wrap"><table class="data" id="teamTable"><thead><tr><th></th><th>Nombre</th><th>Rol</th><th>Dedicación %</th><th class="num">Horas pendientes</th><th>Libre a partir de</th><th></th></tr></thead><tbody>
    ${db.team.map((m) => {
      const ends = Object.values(sched.tasks).filter((x) => x.assignee === m.id).map((x) => x.end);
      const free = ends.length ? Math.max(...ends) : null;
      return `<tr data-id="${m.id}"><td><span class="dot" style="background:${memberColor(m.id)}"></span></td>
      <td><input data-f="name" value="${esc(m.name)}" /></td>
      <td><input data-f="role" value="${esc(m.role || '')}" list="roles" /></td>
      <td style="width:110px"><input data-f="allocation" type="number" min="5" max="100" step="5" value="${Math.round((Number(m.allocation) || 1) * 100)}" /></td>
      <td class="num">${h1(pendingBy[m.id] || 0)}</td>
      <td>${free && free > sched.now ? S.fmtDate(free, true) : 'Disponible'}</td>
      <td><button class="btn ghost small danger" data-act="del-member">✕</button></td></tr>`;
    }).join('') || '<tr><td colspan="7" class="empty">Sin personas: se planifica como una sola persona genérica al 100 %.</td></tr>'}
    </tbody></table></div>
    <datalist id="roles"><option value="Desarrollo"><option value="QA"><option value="Diseño"><option value="Análisis"><option value="Gestión"></datalist>`;
  $('#teamTable').addEventListener('change', (e) => {
    const tr = e.target.closest('tr[data-id]');
    const m = db.team.find((x) => x.id === tr.dataset.id);
    const f = e.target.dataset.f;
    m[f] = f === 'allocation' ? Math.min(1, Math.max(0.05, Number(e.target.value) / 100)) : e.target.value;
    commit();
  });
}

// ================= vista: plantillas =================
function viewPlantillas() {
  $('#view').innerHTML = `<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr))">${db.templates.map((t) => {
    const hrs = t.tasks.reduce((a, x) => a + (Number(x.estimate) || 0), 0);
    const ai = t.tasks.reduce((a, x) => a + S.taskEstimate(x, db.settings), 0);
    return `<div class="card"><div class="row"><h2 style="margin:0">${esc(t.name)}</h2><span class="spacer"></span>${aiOn() ? `<span class="pill good" title="Con IA">${h1(ai)} h con IA</span><span class="pill" title="Sin IA">${h1(hrs)} h</span>` : `<span class="pill">${h1(hrs)} h</span>`}</div>
      <div class="muted small" style="margin:4px 0 8px">${esc(t.description || '')} · ≈ ${h1(ai / (S.weeklyHours(db.settings) * db.settings.focusFactor))} semanas-persona${aiOn() ? ' con IA' : ''}</div>
      <ol class="small" style="padding-left:18px;margin:0 0 10px">${t.tasks.map((x) => `<li>${esc(x.title)} <span class="muted">${x.estimate} h${x.role ? ' · ' + esc(x.role) : ''}</span></li>`).join('')}</ol>
      <div class="row"><button class="btn primary small" data-act="tpl-use" data-id="${t.id}">Crear proyecto</button><button class="btn small danger" data-act="tpl-del" data-id="${t.id}">Eliminar</button></div></div>`;
  }).join('') || '<div class="empty">Sin plantillas. Usa “Guardar como plantilla” en el resumen de un proyecto.</div>'}</div>`;
}

// ================= desarrollo con IA =================
const aiOn = () => db.settings.ai?.enabled !== false;

// Factor real observado por tipo de trabajo: horas reales / horas tradicionales de tareas terminadas
function observedAiFactors() {
  const acc = {};
  for (const p of db.projects) for (const t of p.tasks) {
    if (t.status !== 'done' || !(Number(t.actualHours) > 0) || !S.taskBaseEstimate(t)) continue;
    const ai = db.settings.ai || {};
    const type = Object.keys(ai.factors || {}).find((k) => [t.role, t.phase].some((x) => x && x.toLowerCase() === k.toLowerCase())) || 'Otros';
    acc[type] ||= { actual: 0, base: 0, n: 0 };
    acc[type].actual += Number(t.actualHours);
    acc[type].base += S.taskBaseEstimate(t);
    acc[type].n++;
  }
  return acc;
}

function aiConfigCard() {
  const ai = db.settings.ai;
  const obs = observedAiFactors();
  const rows = Object.entries(ai.factors).map(([k, v]) => {
    const o = obs[k];
    return `<tr data-k="${esc(k)}"><td><input data-f="name" value="${esc(k)}"></td>
      <td style="width:120px"><input data-f="factor" type="number" min="5" max="150" step="5" value="${Math.round(v * 100)}"></td>
      <td class="num">${Math.round((1 - v) * 100)} %</td>
      <td class="small">${o ? `${Math.round((o.actual / o.base) * 100)} % <span class="muted">(${o.n} tarea${o.n > 1 ? 's' : ''})</span>` : '<span class="muted">sin datos</span>'}</td>
      <td><button class="btn ghost small danger" data-act="ai-del">✕</button></td></tr>`;
  }).join('');
  return `<div class="card" style="margin-top:12px"><div class="row"><h2 style="margin:0">Desarrollo con Inteligencia Artificial</h2><span class="spacer"></span>
      <label class="pill"><input type="checkbox" id="aiEnabled" ${aiOn() ? 'checked' : ''}> Aplicar factor IA</label></div>
    <p class="muted small">Las tareas se estiman como las haría un equipo tradicional y se multiplican por el factor de su rol o fase (la columna “IA %” de cada tarea puede sobrescribirlo). La IA acelera mucho el código y las pruebas, y poco las reuniones, las validaciones con el cliente y los despliegues. Estos valores son un punto de partida: compáralos con el “factor real” y ajústalos.</p>
    <div class="table-wrap"><table class="data" id="aiTable"><thead><tr><th>Tipo de trabajo (rol o fase)</th><th>% del tiempo tradicional</th><th class="num">Ahorro</th><th>Factor real medido</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="row" style="margin-top:8px"><button class="btn small" data-act="ai-add">+ Tipo de trabajo</button>
      <label class="field" style="flex-direction:row;align-items:center;gap:6px">Otros tipos<input id="aiDefault" type="number" min="5" max="150" step="5" value="${Math.round((ai.defaultFactor || 1) * 100)}" style="width:80px"> %</label>
      ${obs.Otros ? `<span class="muted small">Real en “otros”: ${Math.round((obs.Otros.actual / obs.Otros.base) * 100)} %</span>` : ''}
      <span class="spacer"></span><button class="btn small" data-act="ai-reset">Restaurar valores sugeridos</button></div>
  </div>`;
}

function bindAiConfig() {
  const ai = db.settings.ai;
  $('#aiEnabled').onchange = (e) => { ai.enabled = e.target.checked; commit(); };
  $('#aiDefault').onchange = (e) => { ai.defaultFactor = Math.min(1.5, Math.max(0.05, Number(e.target.value) / 100)); commit(); };
  $('#aiTable').addEventListener('change', (e) => {
    const k = e.target.closest('tr').dataset.k;
    if (e.target.dataset.f === 'factor') ai.factors[k] = Math.min(1.5, Math.max(0.05, Number(e.target.value) / 100));
    else {
      const name = e.target.value.trim();
      if (!name || ai.factors[name] != null) { e.target.value = k; return; }
      ai.factors = Object.fromEntries(Object.entries(ai.factors).map(([x, v]) => [x === k ? name : x, v]));
    }
    commit();
  });
}

// ================= vista: configuración =================
function viewConfig() {
  const s = db.settings;
  const order = [1, 2, 3, 4, 5, 6, 0];
  $('#view').innerHTML = `
    <div class="two-col">
      <div class="card"><h2>Horario laboral</h2>
        <div class="table-wrap"><table class="data" id="hoursTable"><thead><tr><th>Día</th><th>Labora</th><th>Entrada</th><th>Salida</th><th>Comida desde</th><th>Comida hasta</th><th class="num">Horas</th></tr></thead><tbody>
        ${order.map((d) => {
          const w = s.workdays[d];
          return `<tr data-d="${d}"><td>${S.WEEKDAY_NAMES[d]}</td><td><input type="checkbox" data-f="on" ${w ? 'checked' : ''} style="width:auto"></td>
          ${['start', 'end', 'lunchStart', 'lunchEnd'].map((f) => `<td><input type="time" data-f="${f}" value="${w?.[f] || ''}" ${w ? '' : 'disabled'}></td>`).join('')}
          <td class="num">${h1(S.makeCalendar({ ...s, holidays: [] }).dayHours(S.dayNum('2024-01-07') + d))}</td></tr>`;
        }).join('')}</tbody></table></div>
        <p><strong>${h1(S.weeklyHours(s))} h por semana</strong> · horas efectivas con enfoque: ${h1(S.weeklyHours(s) * s.focusFactor)} h por persona</p>
        <div class="form-grid">
          <label class="field">Factor de enfoque (%)<input id="focus" type="number" min="30" max="100" step="5" value="${Math.round(s.focusFactor * 100)}"></label>
          <label class="field">Semanas por sprint (default)<input id="sprintWeeks" type="number" min="1" max="4" value="${s.sprintWeeks}"></label>
        </div>
        <p class="muted small">El factor de enfoque descuenta juntas, correos, soporte e interrupciones. 70–85 % es lo habitual; ajústalo con la “precisión de estimación” que muestra cada proyecto.</p>
      </div>
      <div class="card"><h2>Días festivos / no laborables</h2>
        <textarea id="holidays" rows="14" style="width:100%;font-family:monospace">${s.holidays.join('\n')}</textarea>
        <div class="row" style="margin-top:8px"><input id="holYear" type="number" value="${new Date().getFullYear() + 1}" style="width:90px" class="btn"><button class="btn" data-act="add-mx">Agregar festivos oficiales de México</button></div>
        <p class="muted small">Una fecha por línea (AAAA-MM-DD). Agrega aquí vacaciones colectivas, puentes o días de la empresa.</p>
      </div>
    </div>
    ${aiConfigCard()}
    <div class="card" style="margin-top:12px"><h2>Respaldo</h2>
      <div class="row"><button class="btn" data-act="export-json">Descargar respaldo (JSON)</button>
      <label class="btn">Restaurar respaldo<input type="file" id="importJson" accept=".json" hidden></label>
      <span class="muted small">Los datos viven en <code>data/db.json</code> en el equipo donde corre el servidor.</span></div>
    </div>`;
  $('#hoursTable').addEventListener('change', (e) => {
    const d = e.target.closest('tr').dataset.d;
    const f = e.target.dataset.f;
    if (f === 'on') s.workdays[d] = e.target.checked ? { start: '09:00', end: '18:30', lunchStart: '14:00', lunchEnd: '15:00' } : null;
    else s.workdays[d][f] = e.target.value;
    commit();
  });
  bindAiConfig();
  $('#focus').onchange = (e) => { s.focusFactor = Math.min(1, Math.max(0.3, Number(e.target.value) / 100)); commit(); };
  $('#sprintWeeks').onchange = (e) => { s.sprintWeeks = Math.max(1, Number(e.target.value) || 2); commit(); };
  $('#holidays').onchange = (e) => { s.holidays = [...new Set(e.target.value.split(/\s+/).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)))].sort(); commit(); };
  $('#importJson').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!Array.isArray(data.projects)) throw new Error('Archivo sin proyectos');
      if (!confirm('Esto reemplaza todos los datos actuales. ¿Continuar?')) return;
      db = data;
      commit();
    } catch (err) { alert('Respaldo inválido: ' + err.message); }
  };
}

// ================= modales =================
function openModal(title, html, onMount, { locked = false } = {}) {
  ui.modalLocked = locked;
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = html;
  $('#modalClose').hidden = locked;
  $('#modal').hidden = false;
  onMount?.($('#modalBody'));
  $('#modalBody').querySelector('input:not([type=hidden])')?.focus();
}
// Las pantallas de acceso no se pueden cerrar con Escape ni con clic afuera
const closeModal = (force = false) => {
  if (ui.modalLocked && force !== true) return;
  ui.modalLocked = false;
  $('#modal').hidden = true;
};

function nextMonday() {
  const today = S.dayNum(S.nowLocalString());
  const wd = (((today + 4) % 7) + 7) % 7;
  return S.dayStr(today + ((8 - wd) % 7 || 7));
}

function openProjectModal(existing, templateId) {
  const p = existing || { name: '', client: '', description: '', startDate: nextMonday(), sprintWeeks: db.settings.sprintWeeks, priority: db.projects.length + 1, members: [] };
  openModal(existing ? 'Editar proyecto' : 'Nuevo proyecto', `
    <form id="projForm" class="grid">
      <div class="form-grid">
        <label class="field">Nombre<input name="name" required value="${esc(p.name)}"></label>
        <label class="field">Cliente<input name="client" value="${esc(p.client || '')}"></label>
        <label class="field">Fecha de inicio<input name="startDate" type="date" required value="${p.startDate}"></label>
        <label class="field">Semanas por sprint<input name="sprintWeeks" type="number" min="1" max="4" value="${p.sprintWeeks}"></label>
        <label class="field">Prioridad (1 = más alta)<input name="priority" type="number" min="1" value="${p.priority}"></label>
        ${existing ? `<label class="field">Estado<select name="status"><option value="activo">Activo</option><option value="archivado" ${p.status === 'archivado' ? 'selected' : ''}>Archivado</option></select></label>` : `
        <label class="field">Plantilla<select name="template"><option value="">— Vacío —</option>${db.templates.map((t) => `<option value="${t.id}" ${t.id === templateId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>`}
      </div>
      <label class="field">Descripción / alcance<textarea name="description" rows="4">${esc(p.description || '')}</textarea></label>
      <div><div class="muted small" style="margin-bottom:4px">Personas asignadas (ninguna marcada = todo el equipo)</div>
        <div class="row">${db.team.map((m) => `<label class="pill"><input type="checkbox" name="members" value="${m.id}" ${p.members?.includes(m.id) ? 'checked' : ''}> ${esc(m.name)}</label>`).join('') || '<span class="muted small">Sin equipo registrado</span>'}</div></div>
      <div class="row"><span class="spacer"></span><button class="btn primary" type="submit">${existing ? 'Guardar' : 'Crear proyecto'}</button></div>
    </form>`, (el) => {
    $('#projForm', el).onsubmit = (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const data = {
        name: f.get('name'), client: f.get('client'), startDate: f.get('startDate'), description: f.get('description'),
        sprintWeeks: Number(f.get('sprintWeeks')) || 2, priority: Number(f.get('priority')) || 1, members: f.getAll('members'),
      };
      if (existing) {
        Object.assign(existing, data, { status: f.get('status') });
      } else {
        const np = { id: S.uid('p'), ...data, status: 'activo', baseline: null, tasks: [] };
        const tpl = db.templates.find((t) => t.id === f.get('template'));
        if (tpl) {
          const ids = tpl.tasks.map(() => S.uid('t'));
          np.tasks = tpl.tasks.map((t, i) => ({ id: ids[i], title: t.title, phase: t.phase || '', estimate: Number(t.estimate) || 0, role: t.role || '', deps: (t.deps || []).map((d) => ids[d]).filter(Boolean), status: 'todo', log: [], createdAt: S.nowLocalString() }));
        }
        db.projects.push(np);
        ui.projectId = np.id;
        ui.view = 'proyecto';
        ui.tab = np.tasks.length ? 'resumen' : 'tareas';
      }
      closeModal();
      commit();
    };
  });
}

function openTaskModal(p, id) {
  const t = p.tasks.find((x) => x.id === id);
  const st = sched.tasks[id] || {};
  openModal('Tarea', `
    <form id="taskForm" class="grid">
      <label class="field">Título<input name="title" value="${esc(t.title)}" required></label>
      <div class="form-grid">
        <label class="field">Fase<input name="phase" value="${esc(t.phase || '')}"></label>
        <label class="field">Rol<input name="role" value="${esc(t.role || '')}" list="roles2"></label>
        <label class="field">Responsable<select name="assignee"><option value="">Automático (${esc(memberName(st.assignee))})</option>${db.team.map((m) => `<option value="${m.id}" ${t.assignee === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
        <label class="field">Estado<select name="status">${S.STATUSES.map((s) => `<option value="${s.id}" ${t.status === s.id ? 'selected' : ''}>${s.label}</option>`).join('')}</select></label>
        <label class="field">Horas estimadas (sin IA)<input name="estimate" type="number" step="0.5" min="0" value="${t.estimate ?? ''}"></label>
        <label class="field">IA: % del tiempo tradicional<input name="aiFactor" type="number" step="5" min="5" max="150" value="${t.aiFactor ? Math.round(t.aiFactor * 100) : ''}" placeholder="${Math.round(S.aiFactorFor({ ...t, aiFactor: null }, db.settings) * 100)} (según rol/fase)"></label>
        <label class="field">Optimista / Probable / Pesimista<span class="row" style="flex-wrap:nowrap"><input name="optimistic" type="number" step="0.5" min="0" value="${t.optimistic ?? ''}" style="width:33%"><input name="likely" type="number" step="0.5" min="0" value="${t.likely ?? ''}" style="width:33%"><input name="pessimistic" type="number" step="0.5" min="0" value="${t.pessimistic ?? ''}" style="width:33%"></span></label>
        <label class="field">Horas restantes<input name="remaining" type="number" step="0.5" min="0" value="${t.status === 'done' ? 0 : t.remaining ?? ''}" placeholder="${S.taskEstimate(t, db.settings)}"></label>
        <label class="field">Horas reales<input name="actualHours" type="number" step="0.5" min="0" value="${t.actualHours ?? ''}"></label>
        <label class="field">Fecha límite<input name="dueDate" type="date" value="${t.dueDate || ''}"></label>
        <label class="field">Forzar sprint<select name="sprintOverride"><option value="">Automático (S${(st.sprint ?? 0) + 1})</option>${(sched.projects[p.id]?.sprints || []).map((s) => `<option value="${s.index}" ${String(t.sprintOverride) === String(s.index) ? 'selected' : ''}>${s.name}</option>`).join('')}</select></label>
      </div>
      <label class="field">Depende de<select name="deps" multiple size="5">${p.tasks.filter((x) => x.id !== id).map((x) => `<option value="${x.id}" ${t.deps?.includes(x.id) ? 'selected' : ''}>${esc(x.title)}</option>`).join('')}</select></label>
      <label class="field">Descripción / notas<textarea name="description" rows="3">${esc(t.description || '')}</textarea></label>
      <div class="muted small">Plan: ${S.fmtDate(st.start, true)} → ${S.fmtDate(st.end, true)}${t.startedAt ? ` · Inició ${S.fmtDate(t.startedAt, true)}` : ''}${t.doneAt ? ` · Terminó ${S.fmtDate(t.doneAt, true)}` : ''}</div>
      <datalist id="roles2"><option value="Desarrollo"><option value="QA"><option value="Diseño"><option value="Análisis"><option value="Gestión"></datalist>
      <div class="row"><button type="button" class="btn danger" id="delTask">Eliminar</button><span class="spacer"></span><button class="btn primary" type="submit">Guardar</button></div>
    </form>`, (el) => {
    $('#delTask', el).onclick = () => { if (confirm('¿Eliminar la tarea?')) { deleteTask(p, id); closeModal(); commit(); } };
    $('#taskForm', el).onsubmit = (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const num = (k) => (f.get(k) === '' ? null : Number(f.get(k)));
      const now = S.nowLocalString();
      Object.assign(t, {
        title: f.get('title'), phase: f.get('phase'), role: f.get('role'), assignee: f.get('assignee'),
        estimate: num('estimate'), aiFactor: num('aiFactor') > 0 ? Math.min(1.5, num('aiFactor') / 100) : null, optimistic: num('optimistic'), likely: num('likely'), pessimistic: num('pessimistic'),
        actualHours: num('actualHours'), dueDate: f.get('dueDate') || null, description: f.get('description'),
        sprintOverride: f.get('sprintOverride') === '' ? null : Number(f.get('sprintOverride')), deps: f.getAll('deps'),
      });
      S.setTaskStatus(t, f.get('status'), now, db.settings);
      const rem = f.get('remaining');
      if (t.status !== 'done' && rem !== '' && Number(rem) !== Number(t.remaining)) S.setTaskRemaining(t, rem, now);
      closeModal();
      commit();
    };
  });
}

function deleteTask(p, id) {
  p.tasks = p.tasks.filter((x) => x.id !== id);
  for (const t of p.tasks) t.deps = (t.deps || []).filter((d) => d !== id);
}

function openBulkModal(p) {
  openModal('Carga rápida de tareas', `
    <p class="muted small">Una tarea por línea con el formato <code>Fase | Título | horas | depende de</code>. Lo único obligatorio es el título. “Depende de” usa los números de línea de esta lista (p. ej. <code>1,2</code>).</p>
    <textarea id="bulkText" rows="12" style="width:100%;font-family:monospace" placeholder="Análisis | Levantamiento con el cliente | 8
Desarrollo | Pantalla de login | 12 | 1
Desarrollo | API de usuarios | 16 | 1
QA | Pruebas de login | 6 | 2,3"></textarea>
    <div class="row" style="margin-top:8px"><span class="spacer"></span><button class="btn primary" id="bulkGo">Agregar</button></div>`, (el) => {
    $('#bulkGo', el).onclick = () => {
      const lines = $('#bulkText', el).value.split('\n').map((l) => l.trim()).filter(Boolean);
      const created = lines.map((l) => {
        const parts = l.split('|').map((x) => x.trim());
        let [phase, title, hours, deps] = parts.length === 1 ? ['', parts[0], '', ''] : parts.length === 2 ? ['', parts[0], parts[1], ''] : parts;
        return { id: S.uid('t'), title, phase, estimate: Number(String(hours).replace(',', '.')) || 0, _deps: deps || '', status: 'todo', deps: [], log: [], createdAt: S.nowLocalString() };
      });
      created.forEach((t) => { t.deps = String(t._deps).split(/[,\s]+/).map(Number).filter((n) => n >= 1 && n <= created.length).map((n) => created[n - 1].id).filter((x) => x !== t.id); delete t._deps; });
      p.tasks.push(...created);
      closeModal();
      commit();
    };
  });
}

// ================= acciones globales =================
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-project],[data-view],[data-tab],[data-act],[data-zoom],[data-prio]');
  if (!a) return;
  const p = project();
  if (a.dataset.project) { e.preventDefault(); ui.projectId = a.dataset.project; ui.view = 'proyecto'; ui.burnSprint = null; ui.boardSprint = 'actual'; render(); return; }
  if (a.dataset.view) { e.preventDefault(); ui.view = a.dataset.view; render(); return; }
  if (a.dataset.tab) { ui.tab = a.dataset.tab; render(); return; }
  if (a.dataset.zoom) { ui.ganttZoom = Number(a.dataset.zoom); localSet('ganttZoom', ui.ganttZoom); render(); return; }
  if (a.dataset.prio) {
    const list = db.projects.filter((x) => x.status !== 'archivado').sort((x, y) => (x.priority || 99) - (y.priority || 99));
    const i = list.findIndex((x) => x.id === a.dataset.prio);
    const j = i + Number(a.dataset.dir);
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    list.forEach((x, k) => { x.priority = k + 1; });
    commit();
    return;
  }
  const act = a.dataset.act;
  const tr = a.closest('tr[data-id]');
  switch (act) {
    case 'add-task': {
      const t = { id: S.uid('t'), title: 'Nueva tarea', phase: p.tasks[p.tasks.length - 1]?.phase || '', estimate: 4, status: 'todo', deps: [], log: [], createdAt: S.nowLocalString() };
      p.tasks.push(t);
      commit();
      if (ui.tab !== 'tareas') openTaskModal(p, t.id);
      break;
    }
    case 'bulk': openBulkModal(p); break;
    case 'up': case 'down': {
      const i = p.tasks.findIndex((x) => x.id === tr.dataset.id);
      const j = act === 'up' ? i - 1 : i + 1;
      if (j >= 0 && j < p.tasks.length) { [p.tasks[i], p.tasks[j]] = [p.tasks[j], p.tasks[i]]; commit(); }
      break;
    }
    case 'open': openTaskModal(p, tr.dataset.id); break;
    case 'del': if (confirm('¿Eliminar la tarea?')) { deleteTask(p, tr.dataset.id); commit(); } break;
    case 'edit-project': openProjectModal(p); break;
    case 'baseline': {
      const sp = sched.projects[p.id];
      p.baseline = { at: S.nowLocalString(), end: sp.end, tasks: Object.fromEntries(p.tasks.filter((t) => sched.tasks[t.id]).map((t) => [t.id, { start: sched.tasks[t.id].start, end: sched.tasks[t.id].end }])) };
      commit();
      break;
    }
    case 'save-template': {
      const name = prompt('Nombre de la plantilla:', p.name);
      if (!name) break;
      const index = Object.fromEntries(p.tasks.map((t, i) => [t.id, i]));
      db.templates.push({ id: S.uid('tpl'), name, description: p.description?.slice(0, 140) || `Basada en ${p.name}`, tasks: p.tasks.map((t) => ({ title: t.title, phase: t.phase, estimate: Number(t.actualHours) || S.taskEstimate(t, db.settings), role: t.role, deps: (t.deps || []).map((d) => index[d]).filter((x) => x != null) })) });
      commit();
      alert('Plantilla guardada (usa horas reales cuando existen, para que la próxima estimación sea más precisa).');
      break;
    }
    case 'export-csv': exportCsv(p); break;
    case 'delete-project':
      if (confirm(`¿Eliminar el proyecto "${p.name}" y todas sus tareas? No se puede deshacer.`)) {
        db.projects = db.projects.filter((x) => x !== p);
        ui.projectId = db.projects[0]?.id || null;
        if (!ui.projectId) ui.view = 'cartera';
        commit();
      }
      break;
    case 'add-member': db.team.push({ id: S.uid('m'), name: 'Nueva persona', role: 'Desarrollo', allocation: 1 }); commit(); break;
    case 'del-member': {
      const id = tr.dataset.id;
      if (!confirm('¿Eliminar a esta persona? Sus tareas quedarán con asignación automática.')) break;
      db.team = db.team.filter((m) => m.id !== id);
      db.projects.forEach((x) => { x.members = (x.members || []).filter((m) => m !== id); x.tasks.forEach((t) => { if (t.assignee === id) t.assignee = ''; }); });
      commit();
      break;
    }
    case 'tpl-use': openProjectModal(null, a.dataset.id); break;
    case 'tpl-del': if (confirm('¿Eliminar la plantilla?')) { db.templates = db.templates.filter((t) => t.id !== a.dataset.id); commit(); } break;
    case 'add-mx': {
      const y = Number($('#holYear').value);
      if (y > 2000) { db.settings.holidays = [...new Set([...db.settings.holidays, ...S.mexicanHolidays(y)])].sort(); commit(); }
      break;
    }
    case 'ai-settings': e.preventDefault(); openAiSettings(); break;
    case 'profile': e.preventDefault(); openAccountMenu(); break;
    case 'ai-add': {
      const name = prompt('Nombre del tipo de trabajo (debe coincidir con el rol o la fase de las tareas):');
      if (name && db.settings.ai.factors[name.trim()] == null) { db.settings.ai.factors[name.trim()] = 0.7; commit(); }
      break;
    }
    case 'ai-del': delete db.settings.ai.factors[tr?.dataset.k ?? a.closest('tr').dataset.k]; commit(); break;
    case 'ai-reset': if (confirm('¿Restaurar los factores de IA sugeridos?')) { db.settings.ai = S.defaultAiSettings(); commit(); } break;
    case 'export-json': download(`agente-sprints-${S.nowLocalString().slice(0, 10)}.json`, JSON.stringify(db, null, 2), 'application/json'); break;
  }
});

function exportCsv(p) {
  const rows = [['#', 'Fase', 'Tarea', 'Responsable', 'Estado', 'Horas estimadas', 'Horas restantes', 'Horas reales', 'Inicio plan', 'Fin plan', 'Sprint']];
  p.tasks.forEach((t, i) => {
    const st = sched.tasks[t.id] || {};
    rows.push([i + 1, t.phase, t.title, memberName(st.assignee), statusLabel(t.status), S.taskEstimate(t, db.settings), S.taskRemaining(t, db.settings), t.actualHours ?? '', st.start != null ? S.fromAbs(st.start).replace('T', ' ') : '', st.end != null ? S.fromAbs(st.end).replace('T', ' ') : '', (st.sprint ?? 0) + 1]);
  });
  download(`${p.name}.csv`, '﻿' + rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n'), 'text/csv');
}
function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('#btnNewProject').onclick = () => openProjectModal();
$('#modalClose').onclick = closeModal;
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
$('#btnToggleChat').onclick = () => { ui.chatOpen = !ui.chatOpen; localSet('chatOpen', ui.chatOpen ? '1' : '0'); render(); };

// ================= gráficas SVG =================
function showTip(e, html) {
  const tip = $('#tooltip');
  tip.innerHTML = html;
  tip.hidden = false;
  const x = Math.min(window.innerWidth - tip.offsetWidth - 8, e.clientX + 14);
  const y = Math.min(window.innerHeight - tip.offsetHeight - 8, e.clientY + 14);
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
}
const hideTip = () => { $('#tooltip').hidden = true; };

function niceMax(v) {
  if (v <= 0) return 10;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

function lineChart(el, { labels, series, marker = -1, shade = [], unit = '' }) {
  const W = 760, H = 280, L = 44, R = 12, T = 12, B = 34;
  const max = niceMax(Math.max(1, ...series.flatMap((s) => s.values.filter((v) => v != null))));
  const n = labels.length;
  const x = (i) => L + (n === 1 ? 0 : (i / (n - 1)) * (W - L - R));
  const y = (v) => T + (1 - v / max) * (H - T - B);
  let svg = '';
  const step = (W - L - R) / Math.max(1, n - 1);
  shade.forEach((s, i) => { if (s) svg += `<rect x="${x(i) - step / 2}" y="${T}" width="${step}" height="${H - T - B}" fill="var(--weekend)"/>`; });
  for (let k = 0; k <= 4; k++) {
    const v = (max / 4) * k;
    svg += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${h1(v)}</text>`;
  }
  const every = Math.ceil(n / 14);
  labels.forEach((l, i) => { if (i % every === 0 || i === n - 1) svg += `<text x="${x(i)}" y="${H - 12}" text-anchor="middle">${esc(l)}</text>`; });
  if (marker >= 0) svg += `<line x1="${x(marker)}" x2="${x(marker)}" y1="${T}" y2="${H - B}" stroke="var(--today)" stroke-dasharray="3 3"/><text x="${x(marker) + 4}" y="${T + 10}" style="fill:var(--today)">Hoy</text>`;
  for (const s of series) {
    let d = '';
    s.values.forEach((v, i) => { if (v == null) return; d += `${d && s.values[i - 1] != null ? 'L' : 'M'}${x(i)},${y(v)} `; });
    svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''} stroke-linejoin="round" stroke-linecap="round"/>`;
    if (s.markers) s.values.forEach((v, i) => { if (v != null) svg += `<circle cx="${x(i)}" cy="${y(v)}" r="4" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`; });
  }
  svg += `<line class="xhair" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="var(--text-2)" stroke-width="1" visibility="hidden"/>`;
  svg += `<rect class="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>`;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${svg}</svg>`;
  const svgEl = el.querySelector('svg');
  const hit = el.querySelector('.hit');
  const xh = el.querySelector('.xhair');
  hit.addEventListener('mousemove', (e) => {
    const r = svgEl.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - L) / (W - L - R)) * (n - 1))));
    xh.setAttribute('x1', x(i)); xh.setAttribute('x2', x(i)); xh.setAttribute('visibility', 'visible');
    showTip(e, `<strong>${esc(labels[i])}</strong><br>${series.map((s) => `<span style="color:${s.color}">■</span> ${s.name}: ${s.values[i] == null ? '—' : h1(s.values[i]) + ' ' + unit}`).join('<br>')}`);
  });
  hit.addEventListener('mouseleave', () => { xh.setAttribute('visibility', 'hidden'); hideTip(); });
}

function barChart(el, { labels, series, line }) {
  const W = 760, H = 260, L = 44, R = 12, T = 12, B = 30;
  const all = series.flatMap((s) => s.values).concat(line ? line.values : []);
  const max = niceMax(Math.max(1, ...all));
  const n = labels.length;
  const band = (W - L - R) / Math.max(1, n);
  const bw = Math.min(28, (band * 0.7) / series.length);
  const y = (v) => T + (1 - v / max) * (H - T - B);
  let svg = '';
  for (let k = 0; k <= 4; k++) {
    const v = (max / 4) * k;
    svg += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${h1(v)}</text>`;
  }
  labels.forEach((l, i) => {
    const cx = L + band * i + band / 2;
    svg += `<text x="${cx}" y="${H - 10}" text-anchor="middle">${esc(l)}</text>`;
    series.forEach((s, k) => {
      const v = s.values[i] || 0;
      const x0 = cx - (bw * series.length + 2 * (series.length - 1)) / 2 + k * (bw + 2);
      const hgt = Math.max(0, y(0) - y(v));
      if (hgt > 0) svg += `<path d="M${x0},${y(0)} V${y(v) + Math.min(4, hgt)} q0,-4 4,-4 H${x0 + bw - 4} q4,0 4,4 V${y(0)} Z" fill="${s.color}"/>`;
    });
    svg += `<rect class="hitbar" data-i="${i}" x="${L + band * i}" y="${T}" width="${band}" height="${H - T - B}" fill="transparent"/>`;
  });
  if (line) {
    const d = line.values.map((v, i) => `${i ? 'L' : 'M'}${L + band * i + 4},${y(v)} H${L + band * (i + 1) - 4}`).join(' ');
    svg += `<path d="${d}" fill="none" stroke="var(--ideal)" stroke-width="2" stroke-dasharray="4 3" pointer-events="none"/>`;
  }
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${svg}</svg>`;
  el.querySelectorAll('.hitbar').forEach((r) => {
    r.addEventListener('mousemove', (e) => {
      const i = Number(r.dataset.i);
      showTip(e, `<strong>${esc(labels[i])}</strong><br>${series.map((s) => `<span style="color:${s.color}">■</span> ${s.name}: ${h1(s.values[i])} h`).join('<br>')}${line ? `<br>${line.name}: ${h1(line.values[i])} h` : ''}`);
    });
    r.addEventListener('mouseleave', hideTip);
  });
}

// ================= chat con el agente =================
function md(src) {
  const lines = esc(src).split('\n');
  let out = '', i = 0;
  const inline = (s) => s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('```')) {
      let code = ''; i++;
      while (i < lines.length && !lines[i].startsWith('```')) code += lines[i++] + '\n';
      i++; out += `<pre><code>${code}</code></pre>`; continue;
    }
    if (/^\s*\|/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      const body = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
      out += `<table><thead><tr>${cells(body[0]).map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body.slice(1).map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      continue;
    }
    if (/^#{1,4} /.test(l)) { out += `<p><strong>${inline(l.replace(/^#+ /, ''))}</strong></p>`; i++; continue; }
    if (/^\s*([-*]|\d+\.) /.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      let items = '';
      while (i < lines.length && /^\s*([-*]|\d+\.) /.test(lines[i])) items += `<li>${inline(lines[i++].replace(/^\s*([-*]|\d+\.) /, ''))}</li>`;
      out += ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
      continue;
    }
    if (l.trim()) out += `<p>${inline(l)}</p>`;
    i++;
  }
  return out;
}

const TOOL_LABELS = {
  consultar_cartera: 'Consultó la cartera', consultar_proyecto: 'Consultó el proyecto', crear_proyecto: 'Creó un proyecto',
  agregar_tareas: 'Agregó tareas', actualizar_tarea: 'Actualizó una tarea', eliminar_tarea: 'Eliminó una tarea',
  actualizar_proyecto: 'Actualizó el proyecto', fijar_linea_base: 'Fijó línea base', gestionar_equipo: 'Actualizó el equipo', simular_proyecto: 'Simuló un escenario',
};

// ---------- ajustes del agente (por navegador) ----------
// Cada persona elige proveedor y modelo, y puede usar su propia API key. La llave propia se guarda
// solo en este navegador y viaja al servidor en cada mensaje; si no hay, se usa la del .env del servidor.
// Proveedor y modelo se guardan por perfil en el servidor (te siguen a cualquier computadora).
// La API key propia y el historial del chat se quedan solo en este navegador.
const aiCfg = () => {
  const pref = db?.profilePrefs?.[profileKey()];
  return {
    provider: pref?.provider || localGet('aiProvider') || 'anthropic',
    model: (p) => (pref?.models ? pref.models[p] || '' : localGet(`aiModel_${p}`) || ''),
    key: (p) => localGet(`aiKey_${p}`) || '',
  };
};
const chatKey = (p) => `chat_${p}_${profileKey()}`;
function loadChat(p) {
  const raw = safeJson(localGet(chatKey(p))) || (p === 'anthropic' && Array.isArray(safeJson(localGet('chatHistory'))) ? { messages: safeJson(localGet('chatHistory')), usage: {} } : null);
  return raw && Array.isArray(raw.messages) ? raw : { messages: [], usage: {} };
}
function saveChat() {
  try {
    localStorage.setItem(chatKey(aiCfg().provider), JSON.stringify(ui.chatState));
  } catch {
    // Si los adjuntos llenan el almacenamiento, se guarda la conversación sin ellos persistida
    ui.chatNote = 'La conversación es muy grande para guardarse en este navegador; se perderá al recargar.';
  }
}
ui.chatState = loadChat(aiCfg().provider);

function providerStatus() {
  const cfg = aiCfg();
  const info = providers[cfg.provider];
  if (!info) return '';
  const model = cfg.model(cfg.provider) || info.defaultModel;
  const source = cfg.key(cfg.provider) ? 'tu llave' : info.serverKey ? 'llave del servidor' : 'sin llave';
  return `${info.label.split(' ')[0]} · ${model} · ${source}`;
}

function openAiSettings() {
  const cfg = aiCfg();
  const opts = Object.entries(providers);
  openModal('Ajustes del agente', `
    <form id="aiForm" class="grid">
      <label class="field">Proveedor de IA<select name="provider">${opts.map(([id, p]) => `<option value="${id}" ${cfg.provider === id ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select></label>
      ${opts.map(([id, p]) => `
      <fieldset class="card" data-prov="${id}" style="${cfg.provider === id ? '' : 'display:none'}">
        <div class="form-grid">
          <label class="field">Modelo<input name="model_${id}" value="${esc(cfg.model(id))}" placeholder="${esc(p.defaultModel)} (predeterminado)"></label>
          <label class="field">Tu API key (opcional)<input name="key_${id}" type="password" autocomplete="off" value="${esc(cfg.key(id))}" placeholder="${p.serverKey ? 'Vacío = usar la del servidor' : 'El servidor no tiene llave'}"></label>
        </div>
        <div class="small muted" style="margin-top:6px">Llave del servidor: ${p.serverKey ? '<span class="pill good">configurada</span>' : '<span class="pill">no configurada</span>'}</div>
      </fieldset>`).join('')}
      <div class="small muted">
        <p><strong>¿Quién paga?</strong> Cada llave pertenece a una organización de la consola de Anthropic o de OpenAI, y el consumo se cobra a esa organización con su propio saldo y sus propios límites. Las suscripciones de claude.ai o de ChatGPT Plus/Pro no incluyen uso de API.</p>
        <p>Si escribes tu propia llave, tus mensajes se cobran a tu cuenta. Si la dejas vacía, se cobran a la cuenta dueña de la llave del servidor (compartida por todos). La llave propia se guarda solo en este navegador y se envía al servidor de esta app en cada mensaje. Si la app se usa desde otra computadora sin HTTPS, la llave viaja sin cifrar por la red local.</p>
      </div>
      <div class="row"><button type="button" class="btn danger" id="aiForget">Borrar mis llaves de este navegador</button><span class="spacer"></span><button class="btn primary" type="submit">Guardar</button></div>
    </form>`, (el) => {
    const form = $('#aiForm', el);
    form.provider.onchange = () => $$('fieldset[data-prov]', el).forEach((f) => { f.style.display = f.dataset.prov === form.provider.value ? '' : 'none'; });
    $('#aiForget', el).onclick = () => { for (const id of Object.keys(providers)) localSet(`aiKey_${id}`, ''); closeModal(); renderChat(); };
    form.onsubmit = (e) => {
      e.preventDefault();
      const f = new FormData(form);
      for (const id of Object.keys(providers)) {
        localSet(`aiModel_${id}`, String(f.get(`model_${id}`) || '').trim());
        localSet(`aiKey_${id}`, String(f.get(`key_${id}`) || '').trim());
      }
      const prov = f.get('provider');
      if (profile) {
        db.profilePrefs ||= {};
        db.profilePrefs[profileKey()] = { provider: prov, models: Object.fromEntries(Object.keys(providers).map((id) => [id, String(f.get(`model_${id}`) || '').trim()])) };
        commit({ rerender: false });
      }
      if (prov !== cfg.provider) {
        // Cada proveedor guarda su propia conversación (los formatos de mensajes no son compatibles)
        localSet('aiProvider', prov);
        ui.chatState = loadChat(prov);
        ui.chatError = null;
      }
      closeModal();
      renderChat();
    };
  });
}

const fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toLocaleString('es-MX', { maximumFractionDigits: 1 })} mil` : String(n));
const usageLine = (u) => `${u.model || ''} · ${fmtTokens(u.input)} tokens de entrada${u.cached ? ` (${fmtTokens(u.cached)} en caché)` : ''} · ${fmtTokens(u.output)} de salida`;

function renderChat() {
  const cfg = aiCfg();
  const info = providers[cfg.provider];
  const ready = Boolean(cfg.key(cfg.provider) || info?.serverKey);
  $('#chatStatus').textContent = providerStatus();
  $('#chatStatus').title = 'Proveedor, modelo y llave en uso';
  const log = $('#chatLog');
  const msgs = ui.chatState.messages;
  let html = '';
  if (!ready) {
    html += `<div class="msg error">No hay API key para ${esc(info?.label || cfg.provider)}. Abre <a href="#" data-act="ai-settings">Ajustes</a> y escribe tu llave, o configúrala en el archivo .env del servidor.</div>`;
  }
  if (!msgs.length) {
    html += `<div class="msg assistant">${md(`Hola. Platícame el proyecto y lo planifico por sprints con tu horario (L–J 9:00–18:30 con comida, V 9:00–15:00).

Ejemplos:
- *"Nuevo proyecto: app de citas para Clínica X. Inicia el lunes 16 de noviembre. Login, agenda, notificaciones por correo y panel admin. Lo hacen Dev 1 y QA 1."*
- *"¿Cuándo terminaríamos un proyecto de 200 h si empezamos el 1 de diciembre?"*
- *"Terminé el modelo de datos, me tomó 10 horas."*
- Adjunta un PDF con requerimientos y pide que lo desglose.`)}</div>`;
  }
  msgs.forEach((m, i) => {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content || []);
    if (m.role === 'tool' || m.role === 'system') return;
    if (m.role === 'user') {
      const parts = blocks.filter((b) => b.type === 'text' && !b.text.startsWith('<contexto>') && !b.text.startsWith('Archivo adjunto "')).map((b) => esc(b.text));
      const files = blocks.filter((b) => ['document', 'image', 'image_url', 'file'].includes(b.type) || (b.type === 'text' && b.text.startsWith('Archivo adjunto "')))
        .map((b) => `📎 ${esc(b.title || b.file?.filename || (b.type === 'text' ? b.text.match(/^Archivo adjunto "([^"]+)"/)?.[1] : '') || (b.type.startsWith('image') ? 'imagen' : 'documento'))}`);
      if (parts.length || files.length) html += `<div class="msg user">${[...files, ...parts].join('\n')}</div>`;
    } else {
      for (const b of blocks) {
        if (b.type === 'text' && b.text.trim()) html += `<div class="msg assistant">${md(b.text)}</div>`;
        if (b.type === 'tool_use') html += `<div class="msg tool">↳ ${TOOL_LABELS[b.name] || b.name}</div>`;
      }
      for (const c of m.tool_calls || []) html += `<div class="msg tool">↳ ${TOOL_LABELS[c.function?.name] || c.function?.name}</div>`;
      if (m.refusal) html += `<div class="msg error">${esc(m.refusal)}</div>`;
    }
    const u = ui.chatState.usage?.[i];
    if (u) html += `<div class="msg tool">${esc(usageLine(u))}</div>`;
  });
  if (ui.sending) html += `<div class="msg tool typing">El agente está trabajando…</div>`;
  if (ui.chatError) html += `<div class="msg error">${esc(ui.chatError)}</div>`;
  if (ui.chatNote) html += `<div class="msg tool">${esc(ui.chatNote)}</div>`;
  const totals = Object.values(ui.chatState.usage || {}).reduce((a, u) => ({ input: a.input + u.input, output: a.output + u.output }), { input: 0, output: 0 });
  if (totals.input) html += `<div class="msg tool">Total de esta conversación: ${fmtTokens(totals.input)} tokens de entrada · ${fmtTokens(totals.output)} de salida</div>`;
  log.innerHTML = html;
  log.scrollTop = log.scrollHeight;
  $('#attachments').innerHTML = ui.attachments.map((a, i) => `<span class="pill">📎 ${esc(a.name)} <a href="#" data-rm="${i}">✕</a></span>`).join('');
  $('#btnSend').disabled = ui.sending;
}

$('#attachments').addEventListener('click', (e) => {
  const i = e.target.dataset?.rm;
  if (i == null) return;
  e.preventDefault();
  ui.attachments.splice(Number(i), 1);
  renderChat();
});

// Adjuntos en formato neutral; el servidor los convierte al formato de cada proveedor
$('#fileInput').onchange = async (e) => {
  for (const f of e.target.files) {
    if (f.size > 25 * 1024 * 1024) { alert(`${f.name} supera 25 MB`); continue; }
    const name = f.name;
    if (/\.pdf$/i.test(name)) ui.attachments.push({ name, kind: 'pdf', mediaType: 'application/pdf', data: await toBase64(f) });
    else if (/^image\//.test(f.type)) ui.attachments.push({ name, kind: 'image', mediaType: f.type, data: await toBase64(f) });
    else ui.attachments.push({ name, kind: 'text', mediaType: 'text/plain', data: await f.text() });
  }
  e.target.value = '';
  renderChat();
};
function toBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

$('#chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chatForm').requestSubmit(); }
});

$('#chatForm').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('#chatInput').value.trim();
  if ((!text && !ui.attachments.length) || ui.sending) return;
  const cfg = aiCfg();
  const provider = cfg.provider;
  const attachments = ui.attachments;
  const prev = ui.chatState;
  // vista optimista
  const preview = [...attachments.map((a) => ({ type: 'document', title: a.name })), { type: 'text', text: text || 'Analiza el/los archivo(s) adjunto(s) y propón cómo planificarlo.' }];
  ui.chatState = { ...prev, messages: [...prev.messages, { role: 'user', content: preview }] };
  ui.sending = true;
  ui.chatError = null;
  ui.attachments = [];
  $('#chatInput').value = '';
  renderChat();
  try {
    const r = await api('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider, model: cfg.model(provider) || undefined, apiKey: cfg.key(provider) || undefined,
        history: prev.messages, text: text || 'Analiza el/los archivo(s) adjunto(s) y propón cómo planificarlo.',
        attachments: attachments.map(({ name, kind, mediaType, data }) => ({ name, kind, mediaType, data })),
        projectId: ui.view === 'proyecto' ? ui.projectId : null,
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Error del servidor');
    const usage = { ...(prev.usage || {}) };
    if (data.usage) usage[data.messages.length - 1] = { ...data.usage, model: data.model };
    ui.chatState = { messages: data.messages, usage };
    if (data.stopReason === 'refusal') ui.chatError = 'El modelo no pudo atender esta solicitud. Intenta reformularla.';
    if (data.stopReason === 'max_tokens' || data.stopReason === 'length') ui.chatError = 'La respuesta se cortó por longitud. Pide que continúe.';
    saveChat();
    if (data.changed) {
      const before = new Set(db.projects.map((p) => p.id));
      await load();
      const created = db.projects.find((p) => !before.has(p.id));
      if (created) { ui.projectId = created.id; ui.view = 'proyecto'; ui.tab = 'resumen'; }
    }
  } catch (err) {
    ui.chatState = prev;
    ui.chatError = err.message;
    ui.attachments = attachments;
    $('#chatInput').value = text;
  } finally {
    ui.sending = false;
    render();
  }
};
$('#btnClearChat').onclick = () => { ui.chatState = { messages: [], usage: {} }; ui.chatError = null; ui.chatNote = null; saveChat(); renderChat(); };
$('#btnAiSettings').onclick = openAiSettings;

// Recalcular "hoy" cada 5 minutos
setInterval(() => { if (db && $('#modal').hidden) { recompute(); render(); } }, 5 * 60 * 1000);
(async () => { await showLogin(); await load(); })();
