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
