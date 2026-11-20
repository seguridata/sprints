// Registro de actividad: compara la base antes y después de un guardado y describe los cambios,
// con su autor. Lo genera el servidor (el navegador no puede escribir el historial directamente).
import { STATUSES, taskBaseEstimate, uid } from './scheduler.js';

const MAX_ENTRIES = 1000;
const label = (s) => STATUSES.find((x) => x.id === s)?.label || s;
const num = (v) => (v == null || v === '' ? null : Number(v));

export function diffActivity(before, after, author, at) {
  const out = [];
  const add = (p, text) => out.push({ id: uid('a'), at, author, projectId: p?.id || null, projectName: p?.name || null, text });
  const memberName = (id) => (after.team || []).find((m) => m.id === id)?.name || (before.team || []).find((m) => m.id === id)?.name || 'asignación automática';

  const prevProjects = new Map((before.projects || []).map((p) => [p.id, p]));
  for (const p of after.projects || []) {
    const o = prevProjects.get(p.id);
    if (!o) { add(p, `creó el proyecto con ${p.tasks?.length || 0} tareas`); continue; }
    if (o.name !== p.name) add(p, `renombró el proyecto (antes "${o.name}")`);
    if (o.startDate !== p.startDate) add(p, `cambió la fecha de inicio a ${p.startDate}`);
    if (num(o.priority) !== num(p.priority)) add(p, `cambió la prioridad a ${p.priority}`);
    if (num(o.sprintWeeks) !== num(p.sprintWeeks)) add(p, `cambió los sprints a ${p.sprintWeeks} semana(s)`);
    if ((o.status || 'activo') !== (p.status || 'activo')) add(p, p.status === 'archivado' ? 'archivó el proyecto' : 'reactivó el proyecto');
    if (p.baseline && o.baseline?.at !== p.baseline.at) add(p, 'fijó la línea base');
    if (JSON.stringify([...(o.members || [])].sort()) !== JSON.stringify([...(p.members || [])].sort())) {
      add(p, p.members?.length ? `cambió quién tiene acceso: ${p.members.map(memberName).join(', ')}` : 'abrió el proyecto a todo el equipo');
    }

    const prevTasks = new Map((o.tasks || []).map((t) => [t.id, t]));
    const added = (p.tasks || []).filter((t) => !prevTasks.has(t.id));
    if (added.length > 3) add(p, `agregó ${added.length} tareas`);
    else for (const t of added) add(p, `agregó la tarea "${t.title}"`);

    for (const t of p.tasks || []) {
      const x = prevTasks.get(t.id);
      if (!x) continue;
      if (x.title !== t.title) add(p, `renombró "${x.title}" a "${t.title}"`);
      if (x.status !== t.status) add(p, `movió "${t.title}" a ${label(t.status)}`);
      if (taskBaseEstimate(x) !== taskBaseEstimate(t)) add(p, `cambió la estimación de "${t.title}" de ${taskBaseEstimate(x)} a ${taskBaseEstimate(t)} h`);
      if ((x.assignee || '') !== (t.assignee || '')) add(p, `asignó "${t.title}" a ${memberName(t.assignee)}`);
      if (num(x.aiFactor) !== num(t.aiFactor)) add(p, `cambió el factor IA de "${t.title}" a ${t.aiFactor ? Math.round(t.aiFactor * 100) + ' %' : 'el de su tipo'}`);
      if (t.status !== 'done' && x.status === t.status && num(x.remaining) !== num(t.remaining) && t.remaining != null) add(p, `reportó ${t.remaining} h restantes en "${t.title}"`);
      if (num(x.actualHours) !== num(t.actualHours) && t.actualHours != null) add(p, `registró ${t.actualHours} h reales en "${t.title}"`);
    }
    const ids = new Set((p.tasks || []).map((t) => t.id));
    for (const x of o.tasks || []) if (!ids.has(x.id)) add(p, `eliminó la tarea "${x.title}"`);
  }
  const ids = new Set((after.projects || []).map((p) => p.id));
  for (const o of before.projects || []) if (!ids.has(o.id)) add(o, 'eliminó el proyecto');

  const prevTeam = new Map((before.team || []).map((m) => [m.id, m]));
  for (const m of after.team || []) {
    const x = prevTeam.get(m.id);
    if (!x) add(null, `agregó a ${m.name} al equipo`);
    else if (x.name !== m.name || x.role !== m.role || num(x.allocation) !== num(m.allocation)) add(null, `actualizó a ${m.name} en el equipo`);
  }
  const teamIds = new Set((after.team || []).map((m) => m.id));
  for (const x of before.team || []) if (!teamIds.has(x.id)) add(null, `quitó a ${x.name} del equipo`);

  if (JSON.stringify(before.settings) !== JSON.stringify(after.settings)) add(null, 'cambió la configuración (calendario, festivos o factores de IA)');
  return out;
}

// Agrega las entradas nuevas al inicio (lo más reciente primero) y recorta el historial
export function appendActivity(previous, entries) {
  return [...entries.slice().reverse(), ...(previous || [])].slice(0, MAX_ENTRIES);
}
