import test from 'node:test';
import assert from 'node:assert/strict';
import { aiFactorFor, defaultSettings, makeCalendar, toAbs, fromAbs, weeklyHours, mexicanHolidays, schedulePortfolio, taskEstimate } from '../lib/scheduler.js';

const s = defaultSettings();
const cal = makeCalendar(s);

test('semana laboral = 40 h (L-J 8.5 h, V 6 h)', () => {
  assert.equal(weeklyHours(s), 40);
});

test('festivos México 2026', () => {
  assert.deepEqual(mexicanHolidays(2026), ['2026-01-01', '2026-02-02', '2026-03-16', '2026-05-01', '2026-09-16', '2026-11-16', '2026-12-25']);
});

test('saltar comida, viernes corto y fin de semana', () => {
  // lunes 2026-11-09 9:00 + 5 h -> 14:00 (inicio comida) ; +6 h -> 16:00
  assert.equal(fromAbs(cal.addWork(toAbs('2026-11-09T09:00'), 6)), '2026-11-09T16:00');
  // jueves 12 nov 9:00 + 8.5 h -> 18:30 ; + 9 h -> viernes 9:30
  assert.equal(fromAbs(cal.addWork(toAbs('2026-11-12T09:00'), 8.5)), '2026-11-12T18:30');
  assert.equal(fromAbs(cal.addWork(toAbs('2026-11-12T09:00'), 9)), '2026-11-13T09:30');
  // viernes 13 nov 9:00 + 7 h -> lunes 16 es festivo -> martes 17 10:00
  assert.equal(fromAbs(cal.addWork(toAbs('2026-11-13T09:00'), 7)), '2026-11-17T10:00');
  assert.equal(cal.workBetween(toAbs('2026-11-09T00:00'), toAbs('2026-11-14T00:00')), 40);
  assert.equal(fromAbs(cal.subWork(toAbs('2026-11-17T10:00'), 7)), '2026-11-13T09:00');
});

test('planificación con dependencias, enfoque y dos personas', () => {
  const db = {
    settings: { ...s, focusFactor: 1, ai: { ...s.ai, enabled: false } },
    team: [{ id: 'a', name: 'Ana', allocation: 1 }, { id: 'b', name: 'Beto', allocation: 0.5 }],
    projects: [{ id: 'p', name: 'P', startDate: '2026-11-09', sprintWeeks: 1, tasks: [
      { id: 't1', title: 'A', estimate: 8.5, status: 'todo' },
      { id: 't2', title: 'B', estimate: 8.5, status: 'todo' },
      { id: 't3', title: 'C', estimate: 4, status: 'todo', deps: ['t1', 't2'] },
    ] }],
  };
  const r = schedulePortfolio(db, '2026-11-01T08:00');
  assert.equal(r.tasks.t1.assignee, 'a');
  assert.equal(fromAbs(r.tasks.t1.end), '2026-11-09T18:30');
  // Beto al 50%: 8.5 h efectivas = 17 h de calendario -> termina mar 10 18:30
  assert.equal(fromAbs(r.tasks.t2.end), '2026-11-10T18:30');
  assert.equal(fromAbs(r.tasks.t3.start), '2026-11-11T09:00');
  assert.equal(r.projects.p.sprints.length, 1);
  assert.equal(taskEstimate({ optimistic: 2, likely: 4, pessimistic: 12 }), 5);
});

test('factor de IA por rol, fase, tarea y desactivado', () => {
  const settings = defaultSettings();
  assert.equal(taskEstimate({ estimate: 10, role: 'Desarrollo' }, settings), 5);
  assert.equal(taskEstimate({ estimate: 10, phase: 'qa' }, settings), 6);
  assert.equal(taskEstimate({ estimate: 10, phase: 'Otra cosa' }, settings), 7);
  assert.equal(taskEstimate({ estimate: 10, role: 'Desarrollo', aiFactor: 1 }, settings), 10);
  assert.equal(aiFactorFor({ role: 'Desarrollo' }, { ...settings, ai: { ...settings.ai, enabled: false } }), 1);
  // sin configuración (llamadas antiguas) no se aplica factor
  assert.equal(taskEstimate({ estimate: 10, role: 'Desarrollo' }), 10);
});

test('la planificación usa las horas con IA', () => {
  const db = {
    settings: { ...s, focusFactor: 1 },
    team: [{ id: 'a', name: 'Ana', allocation: 1 }],
    projects: [{ id: 'p', name: 'P', startDate: '2026-11-09', sprintWeeks: 1, tasks: [
      { id: 't1', title: 'API', estimate: 17, role: 'Desarrollo', status: 'todo' },
    ] }],
  };
  const r = schedulePortfolio(db, '2026-11-01T08:00');
  // 17 h tradicionales x 0.5 = 8.5 h = un día completo de lunes
  assert.equal(fromAbs(r.tasks.t1.end), '2026-11-09T18:30');
  assert.equal(r.projects.p.totalHours, 8.5);
  assert.equal(r.projects.p.baseHours, 17);
});

test('registro de actividad describe cambios con autor', async () => {
  const { diffActivity, appendActivity } = await import('../lib/activity.js');
  const before = { team: [{ id: 'a', name: 'Ana' }], settings: {}, projects: [{ id: 'p', name: 'P', startDate: '2026-11-09', tasks: [
    { id: 't1', title: 'Login', estimate: 8, status: 'todo' },
    { id: 't2', title: 'Viejo', estimate: 2, status: 'todo' },
  ] }] };
  const after = structuredClone(before);
  after.projects[0].tasks[0].status = 'doing';
  after.projects[0].tasks[0].assignee = 'a';
  after.projects[0].tasks.splice(1, 1);
  after.projects[0].tasks.push({ id: 't3', title: 'Nuevo', estimate: 3, status: 'todo' });
  const e = diffActivity(before, after, 'Ana', '2026-11-20T10:00');
  const texts = e.map((x) => x.text);
  assert.ok(texts.includes('movió "Login" a En progreso'));
  assert.ok(texts.includes('asignó "Login" a Ana'));
  assert.ok(texts.includes('agregó la tarea "Nuevo"'));
  assert.ok(texts.includes('eliminó la tarea "Viejo"'));
  assert.ok(e.every((x) => x.author === 'Ana' && x.projectId === 'p'));
  assert.equal(diffActivity(before, structuredClone(before), 'Ana', 'x').length, 0);
  assert.equal(appendActivity([{ id: 'old' }], e)[0].id, e[e.length - 1].id);
});

test('cuentas: contraseñas, sesiones y permisos por rol', async () => {
  process.env.SESSION_SECRET = 'secreto-de-prueba';
  const A = await import('../lib/auth.js');
  const h = A.hashPassword('una-clave-larga');
  assert.ok(A.verifyPassword('una-clave-larga', h));
  assert.ok(!A.verifyPassword('otra', h));
  assert.ok(A.passwordProblem('corta'));

  const admin = { id: 'u1', name: 'Admin', role: 'admin', sessionVersion: 0 };
  const ana = { id: 'u2', name: 'Ana', role: 'miembro', memberId: 'm1', sessionVersion: 0 };
  const token = A.createSessionToken(ana);
  assert.equal(A.readSessionToken(token).uid, 'u2');
  assert.equal(A.readSessionToken(token.slice(0, -2) + 'xx'), null); // firma alterada

  const db = {
    users: [admin, ana], team: [{ id: 'm1', name: 'Ana' }, { id: 'm2', name: 'Beto' }], settings: {}, templates: [],
    profilePrefs: { u1: { provider: 'openai' }, u2: { provider: 'anthropic' } },
    activity: [{ projectId: 'secreto', text: 'x' }, { projectId: null, text: 'config' }, { projectId: 'equipo', text: 'y' }],
    projects: [
      { id: 'equipo', name: 'De todos', startDate: '2026-12-01', members: [], tasks: [{ id: 't1', title: 'A', status: 'todo' }] },
      { id: 'mio', name: 'De Ana', startDate: '2026-12-01', members: ['m1'], tasks: [{ id: 't2', title: 'B', status: 'todo' }] },
      { id: 'secreto', name: 'De Beto', startDate: '2026-12-01', members: ['m2'], tasks: [{ id: 't3', title: 'C', status: 'todo' }] },
    ],
  };
  const v = A.viewFor(db, ana);
  assert.deepEqual(v.projects.map((p) => p.id), ['equipo', 'mio']);
  assert.equal(v.users, undefined);
  assert.deepEqual(Object.keys(v.profilePrefs), ['u2']);
  assert.deepEqual(v.activity.map((e) => e.text), ['y']);
  assert.equal(A.viewFor(db, admin).projects.length, 3);

  // Un miembro solo puede cambiar tareas de sus proyectos; lo demás se ignora
  const fromAna = structuredClone(v);
  fromAna.projects[1].tasks[0].status = 'done';
  fromAna.projects[1].name = 'Renombrado';
  fromAna.projects.push({ id: 'nuevo', name: 'No permitido', tasks: [] });
  fromAna.team = [];
  const merged = A.mergeFromUser(db, fromAna, ana);
  assert.equal(merged.projects.find((p) => p.id === 'mio').tasks[0].status, 'done');
  assert.equal(merged.projects.find((p) => p.id === 'mio').name, 'De Ana');
  assert.ok(!merged.projects.some((p) => p.id === 'nuevo'));
  assert.equal(merged.projects.find((p) => p.id === 'secreto').tasks.length, 1);
  assert.equal(merged.team.length, 2);
  assert.equal(merged.users.length, 2);
  assert.equal(merged.profilePrefs.u1.provider, 'openai');

  // El agente respeta los permisos
  const { runTool } = await import('../lib/agent.js');
  const full = { ...structuredClone(db), settings: (await import('../lib/scheduler.js')).defaultSettings() };
  assert.throws(() => runTool('crear_proyecto', { nombre: 'X', fecha_inicio: '2026-12-01' }, { db: full, user: ana }), /Sin permiso/);
  assert.throws(() => runTool('consultar_proyecto', { proyecto_id: 'secreto' }, { db: full, user: ana }), /No existe/);
  const cartera = runTool('consultar_cartera', {}, { db: full, user: ana });
  assert.deepEqual(cartera.proyectos.map((p) => p.id), ['equipo', 'mio']);
});

test('Google: solo acepta cuentas verificadas del dominio de la empresa', async () => {
  process.env.GOOGLE_CLIENT_ID = 'cliente-prueba';
  process.env.GOOGLE_CLIENT_SECRET = 'secreto';
  process.env.ALLOWED_DOMAIN = 'seguridata.com';
  const G = await import('../lib/google.js');
  const req = { headers: { host: 'localhost:3210' } };
  const { url, state } = G.startUrl(req);
  assert.ok(url.startsWith('https://accounts.google.com/') && url.includes('hd=seguridata.com') && url.includes(`state=${state}`));
  assert.ok(url.includes(encodeURIComponent('http://localhost:3210/api/auth')));

  const realFetch = globalThis.fetch;
  const token = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
  const base = { iss: 'https://accounts.google.com', aud: 'cliente-prueba', exp: Date.now() / 1000 + 300, email_verified: true };
  const tryClaims = async (claims) => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ id_token: token({ ...base, ...claims }) }) });
    try { return await G.finishLogin(req, 'codigo'); } finally { globalThis.fetch = realFetch; }
  };
  const ok = await tryClaims({ email: 'Ana@SeguriData.com', hd: 'seguridata.com', name: 'Ana' });
  assert.equal(ok.email, 'ana@seguridata.com');
  await assert.rejects(tryClaims({ email: 'ana@gmail.com' }), /Solo se permiten cuentas @seguridata.com/);
  await assert.rejects(tryClaims({ email: 'ana@seguridata.com.mx', hd: 'seguridata.com.mx' }), /Solo se permiten/);
  await assert.rejects(tryClaims({ email: 'ana@seguridata.com', hd: 'seguridata.com', aud: 'otra-app' }), /no es para esta aplicación/);
  await assert.rejects(tryClaims({ email: 'ana@seguridata.com', hd: 'seguridata.com', email_verified: false }), /no está verificado/);
  delete process.env.GOOGLE_CLIENT_ID; delete process.env.GOOGLE_CLIENT_SECRET;
});
