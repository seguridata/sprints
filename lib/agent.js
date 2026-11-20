// Agente conversacional: Claude (Anthropic) o ChatGPT (OpenAI) con herramientas que leen y
// modifican la cartera de proyectos.
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import {
  schedulePortfolio, schedulePortfolioWithBaseline, taskBaseEstimate, aiFactorFor, fromAbs, fmtDate, taskEstimate, taskRemaining, uid, weeklyHours, WEEKDAY_NAMES,
  weekdayOf, nowLocalString, setTaskStatus, setTaskRemaining, STATUSES, round1,
} from './scheduler.js';
import { loadDb, saveDb, tasksFromTemplate } from './store.js';
import { diffActivity, appendActivity } from './activity.js';
import { canSeeProject, isAdmin } from './auth.js';

export const PROVIDERS = {
  anthropic: { label: 'Claude (Anthropic)', defaultModel: process.env.CLAUDE_MODEL || 'claude-opus-5-5', envKey: 'ANTHROPIC_API_KEY' },
  openai: { label: 'ChatGPT (OpenAI)', defaultModel: process.env.OPENAI_MODEL || 'gpt-5.4', envKey: 'OPENAI_API_KEY' },
};
export const serverKeys = () => ({
  anthropic: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
  openai: Boolean(process.env.OPENAI_API_KEY),
});
// Modelos de Claude que aceptan `effort` y el fallback automático del servidor
const CLAUDE_FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);

const SYSTEM = `Eres el "Agente de Sprints": un líder de proyecto experto en estimación ágil que trabaja para un equipo de desarrollo en México.
Tu trabajo es convertir la información que te compartan (descripciones, minutas, requerimientos, documentos) en proyectos planificados por sprints, y mantenerlos al día.

Cómo calcula el sistema (no lo calcules a mano, usa las herramientas):
- Horario laboral: lunes a jueves 9:00–18:30 con 1 h de comida (8.5 h) y viernes 9:00–15:00 (6 h) = 40 h/semana. Se excluyen días festivos oficiales de México. El horario y los festivos pueden cambiarse en Configuración.
- Factor de enfoque (por defecto 80 %): porcentaje de la jornada que realmente rinde en tareas del proyecto. Cada persona tiene además un % de dedicación.
- El planificador asigna fechas automáticamente respetando dependencias, dedicación de cada persona y la prioridad entre proyectos (las personas se comparten entre proyectos).
- Los sprints arrancan en la fecha de inicio del proyecto y duran N semanas (por defecto 2).
- TODOS los proyectos se desarrollan con apoyo de Inteligencia Artificial (asistentes de código, generación de pruebas, documentación). Por eso el sistema aplica un "factor IA" por tipo de trabajo: tú estimas las horas como las haría un equipo tradicional y el sistema las multiplica por el factor del rol o la fase (p. ej. Desarrollo 0.5 = la mitad del tiempo). Consulta los factores vigentes con consultar_cartera.

Reglas de trabajo:
1. Antes de crear o modificar, consulta el estado con consultar_cartera o consultar_proyecto si no lo conoces.
2. Si falta la fecha de inicio de un proyecto nuevo, pregúntala (no la inventes). Si el usuario dice "hoy" o "el lunes", conviértela usando la fecha actual del contexto.
3. Descompón el trabajo en tareas de 2 a 16 horas tradicionales, agrupadas por fase (Análisis, Diseño, Desarrollo, QA, Despliegue, Cierre...). Si una tarea es incierta usa estimación de tres puntos (optimista, probable, pesimista); el sistema aplica PERT.
   - No reduzcas tú las horas por la IA: el factor ya lo hace. Solo usa factor_ia en una tarea cuando se aparte claramente de su tipo: trabajo que la IA casi resuelve sola (CRUD, código repetitivo, pruebas unitarias, migraciones de datos simples: 0.3-0.4) o trabajo que no se acelera (reuniones con el cliente, capacitación, esperas de terceros, trámites, revisiones de seguridad o cumplimiento: 1.0).
   - Agrega siempre tiempo de revisión humana del código generado por IA dentro de las tareas de Desarrollo o QA; la IA acelera, pero alguien debe validar.
4. Declara dependencias reales (por título de tarea) y asigna rol (Desarrollo, QA, Diseño, Análisis, Gestión) para que se asigne a la persona adecuada.
5. Si existe una plantilla que encaje, úsala como base y ajústala. Para comparar escenarios ("¿y si agregamos una persona?") usa simular_proyecto, que no guarda nada.
6. Tras crear o cambiar algo, resume en español: fecha estimada de término, número de sprints, horas con IA (y cuántas serían sin IA), carga por sprint vs capacidad y riesgos (sprints sobrecargados, tareas sin responsable, dependencias críticas). Sé concreto y breve; usa tablas Markdown cuando ayuden.
7. Cuando el usuario reporte avance ("terminé el login", "al backend le faltan 10 horas"), actualiza el estado o las horas restantes de la tarea correspondiente. Pide las horas reales al terminar: con ellas se mide el factor IA observado y se pueden recalibrar los factores en Configuración.
8. No borres proyectos ni tareas sin confirmación explícita del usuario.`;

// ---------- definición de herramientas ----------
const taskSchema = {
  type: 'object',
  properties: {
    titulo: { type: 'string' },
    descripcion: { type: 'string' },
    fase: { type: 'string', description: 'Fase o épica: Análisis, Diseño, Desarrollo, QA, Despliegue, Cierre…' },
    horas: { type: 'number', description: 'Estimación en horas como la haría un equipo tradicional SIN IA; el sistema aplica el factor IA' },
    factor_ia: { type: 'number', description: 'Opcional. Fracción del tiempo tradicional para ESTA tarea (0.3 = la IA la acelera mucho, 1 = no se acelera). Si se omite se usa el factor del rol/fase.' },
    optimista: { type: 'number', description: 'Horas en el mejor caso (estimación de tres puntos)' },
    probable: { type: 'number', description: 'Horas más probables' },
    pesimista: { type: 'number', description: 'Horas en el peor caso' },
    rol: { type: 'string', description: 'Rol requerido; se asigna a una persona del equipo con ese rol' },
    responsable_id: { type: 'string', description: 'Id de la persona del equipo (opcional)' },
    depende_de: { type: 'array', items: { type: 'string' }, description: 'Títulos o ids de tareas que deben terminar antes' },
    fecha_limite: { type: 'string', description: 'YYYY-MM-DD (opcional)' },
  },
  required: ['titulo'],
};

const TOOLS = [
  {
    name: 'consultar_cartera',
    description: 'Devuelve configuración del calendario, equipo, plantillas y un resumen de todos los proyectos con su fecha estimada de término.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'consultar_proyecto',
    description: 'Detalle de un proyecto: tareas con fechas planificadas, responsable, sprint, estado; y sprints con capacidad vs carga.',
    input_schema: { type: 'object', properties: { proyecto_id: { type: 'string' } }, required: ['proyecto_id'] },
  },
  {
    name: 'crear_proyecto',
    description: 'Crea un proyecto. Puede partir de una plantilla (plantilla_id) y/o de una lista de tareas.',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string' },
        fecha_inicio: { type: 'string', description: 'YYYY-MM-DD' },
        descripcion: { type: 'string' },
        cliente: { type: 'string' },
        semanas_sprint: { type: 'integer', description: 'Duración del sprint en semanas (1-4). Por defecto la de configuración.' },
        prioridad: { type: 'integer', description: '1 = más alta. Define quién toma primero a las personas compartidas.' },
        miembros: { type: 'array', items: { type: 'string' }, description: 'Ids del equipo asignados; vacío = todo el equipo' },
        plantilla_id: { type: 'string' },
        tareas: { type: 'array', items: taskSchema },
      },
      required: ['nombre', 'fecha_inicio'],
    },
  },
  {
    name: 'agregar_tareas',
    description: 'Agrega tareas a un proyecto existente.',
    input_schema: {
      type: 'object',
      properties: { proyecto_id: { type: 'string' }, tareas: { type: 'array', items: taskSchema } },
      required: ['proyecto_id', 'tareas'],
    },
  },
  {
    name: 'actualizar_tarea',
    description: 'Modifica una tarea: estimación, estado (todo, doing, review, done), horas restantes, horas reales, responsable, dependencias o sprint.',
    input_schema: {
      type: 'object',
      properties: {
        proyecto_id: { type: 'string' },
        tarea_id: { type: 'string' },
        cambios: {
          type: 'object',
          properties: {
            ...taskSchema.properties,
            estado: { type: 'string', enum: STATUSES.map((s) => s.id) },
            horas_restantes: { type: 'number' },
            horas_reales: { type: 'number' },
            sprint: { type: 'integer', description: 'Forzar sprint (1 = primero). 0 = automático.' },
          },
        },
      },
      required: ['proyecto_id', 'tarea_id', 'cambios'],
    },
  },
  {
    name: 'eliminar_tarea',
    description: 'Elimina una tarea (solo con confirmación del usuario).',
    input_schema: { type: 'object', properties: { proyecto_id: { type: 'string' }, tarea_id: { type: 'string' } }, required: ['proyecto_id', 'tarea_id'] },
  },
  {
    name: 'actualizar_proyecto',
    description: 'Modifica datos del proyecto: nombre, fecha de inicio, semanas por sprint, prioridad, miembros, estado (activo/archivado).',
    input_schema: {
      type: 'object',
      properties: {
        proyecto_id: { type: 'string' },
        cambios: {
          type: 'object',
          properties: {
            nombre: { type: 'string' }, fecha_inicio: { type: 'string' }, descripcion: { type: 'string' }, cliente: { type: 'string' },
            semanas_sprint: { type: 'integer' }, prioridad: { type: 'integer' },
            miembros: { type: 'array', items: { type: 'string' } }, estado: { type: 'string', enum: ['activo', 'archivado'] },
          },
        },
      },
      required: ['proyecto_id', 'cambios'],
    },
  },
  {
    name: 'fijar_linea_base',
    description: 'Guarda las fechas planificadas actuales como línea base para medir desviaciones después.',
    input_schema: { type: 'object', properties: { proyecto_id: { type: 'string' } }, required: ['proyecto_id'] },
  },
  {
    name: 'gestionar_equipo',
    description: 'Agrega, actualiza o elimina una persona del equipo. dedicacion es la fracción de tiempo disponible (1 = 100 %).',
    input_schema: {
      type: 'object',
      properties: {
        accion: { type: 'string', enum: ['agregar', 'actualizar', 'eliminar'] },
        id: { type: 'string' },
        nombre: { type: 'string' },
        rol: { type: 'string' },
        dedicacion: { type: 'number' },
      },
      required: ['accion'],
    },
  },
  {
    name: 'simular_proyecto',
    description: 'Calcula cuánto tardaría un proyecto hipotético con la carga actual del equipo, SIN guardarlo. Útil para cotizar o comparar escenarios.',
    input_schema: {
      type: 'object',
      properties: {
        fecha_inicio: { type: 'string' },
        semanas_sprint: { type: 'integer' },
        prioridad: { type: 'integer' },
        miembros: { type: 'array', items: { type: 'string' } },
        plantilla_id: { type: 'string' },
        tareas: { type: 'array', items: taskSchema },
        personas_extra: { type: 'integer', description: 'Personas adicionales hipotéticas al 100 % para el escenario' },
      },
      required: ['fecha_inicio'],
    },
  },
];
TOOLS[TOOLS.length - 1].cache_control = { type: 'ephemeral' };

// ---------- implementación ----------
const need = (cond, msg) => { if (!cond) throw new Error(msg); };
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

function findProject(db, id) {
  const p = db.projects.find((x) => x.id === id) || db.projects.find((x) => x.name.toLowerCase() === String(id).toLowerCase());
  need(p, `No existe el proyecto "${id}". Usa consultar_cartera para ver los ids.`);
  return p;
}

function buildTasks(project, inputs = [], db) {
  const created = [];
  for (const t of inputs) {
    need(t && t.titulo, 'Cada tarea necesita "titulo".');
    created.push({
      id: uid('t'),
      title: t.titulo,
      description: t.descripcion || '',
      phase: t.fase || '',
      estimate: Number(t.horas) || 0,
      optimistic: t.optimista ?? null,
      likely: t.probable ?? null,
      pessimistic: t.pesimista ?? null,
      role: t.rol || '',
      aiFactor: Number(t.factor_ia) > 0 ? Math.min(1.5, Number(t.factor_ia)) : null,
      assignee: t.responsable_id && db.team.some((m) => m.id === t.responsable_id) ? t.responsable_id : '',
      dueDate: isDate(t.fecha_limite) ? t.fecha_limite : null,
      deps: [],
      _deps: t.depende_de || [],
      status: 'todo',
      createdAt: serverNow(),
      log: [],
    });
  }
  project.tasks.push(...created);
  for (const t of created) {
    t.deps = resolveDeps(project, t._deps, t.id);
    delete t._deps;
  }
  return created;
}

function resolveDeps(project, refs, selfId) {
  const out = [];
  for (const r of refs || []) {
    const key = String(r).trim().toLowerCase();
    const hit = project.tasks.find((x) => x.id === r) || project.tasks.find((x) => x.title.trim().toLowerCase() === key);
    if (hit && hit.id !== selfId && !out.includes(hit.id)) out.push(hit.id);
  }
  return out;
}

function projectSummary(db, schedule, p) {
  const sp = schedule.projects[p.id];
  if (!sp) return { id: p.id, nombre: p.name, estado: p.status };
  const sobrecargados = sp.sprints.filter((s) => s.load > 1.05).map((s) => `${s.name} (${Math.round(s.load * 100)} %)`);
  return {
    id: p.id,
    nombre: p.name,
    cliente: p.client || '',
    prioridad: p.priority,
    inicio: p.startDate,
    fin_estimado: fromAbs(sp.end),
    fin_linea_base: p.baseline?.end ? fromAbs(p.baseline.end) : null,
    horas_totales: sp.totalHours,
    horas_sin_ia: sp.baseHours,
    ahorro_ia: sp.baseHours ? `${Math.round((1 - sp.totalHours / sp.baseHours) * 100)} %` : null,
    fin_estimado_sin_ia: sp.endWithoutAi != null ? fromAbs(sp.endWithoutAi) : null,
    horas_terminadas: sp.doneHours,
    avance: `${Math.round(sp.progress * 100)} %`,
    num_sprints: sp.sprints.length,
    semanas_sprint: p.sprintWeeks,
    sprint_actual: sp.currentSprint != null ? sp.currentSprint + 1 : null,
    sprints_sobrecargados: sobrecargados,
    tareas: p.tasks.length,
    tareas_sin_estimar: p.tasks.filter((t) => !taskEstimate(t, db.settings)).length,
    precision_historica: sp.accuracy ? `real/estimado con IA = ${round1(sp.accuracy)}` : null,
    factor_ia_observado: sp.observedAiFactor ? round1(sp.observedAiFactor) : null,
  };
}

function projectDetail(db, schedule, p) {
  const sp = schedule.projects[p.id];
  const nameOf = (id) => schedule.team.find((m) => m.id === id)?.name || id;
  return {
    ...projectSummary(db, schedule, p),
    descripcion: p.description || '',
    miembros: sp.members.map(nameOf),
    sprints: sp.sprints.map((s) => ({
      sprint: s.index + 1, inicio: s.start, fin: s.end,
      capacidad_h: s.capacity, comprometido_h: s.committed, terminado_h: s.completed,
      carga: `${Math.round(s.load * 100)} %`,
    })),
    tareas: p.tasks.map((t) => {
      const st = schedule.tasks[t.id] || {};
      return {
        id: t.id, titulo: t.title, fase: t.phase, estado: t.status,
        horas: taskEstimate(t, db.settings), horas_sin_ia: taskBaseEstimate(t), factor_ia: aiFactorFor(t, db.settings), restantes: taskRemaining(t, db.settings), reales: t.actualHours ?? null,
        responsable: nameOf(st.assignee), auto_asignada: !!st.autoAssigned, rol: t.role,
        inicio: st.start != null ? fromAbs(st.start) : null, fin: st.end != null ? fromAbs(st.end) : null,
        sprint: st.sprint != null ? st.sprint + 1 : null,
        depende_de: (t.deps || []).map((d) => p.tasks.find((x) => x.id === d)?.title).filter(Boolean),
      };
    }),
  };
}

// Hora del servidor en la zona del equipo (en Vercel el servidor corre en UTC)
export const serverNow = () => nowLocalString(new Date(), process.env.APP_TIMEZONE || 'America/Mexico_City');

// Las herramientas trabajan sobre ctx.db en memoria; chat() la guarda al final si hubo cambios.
// Herramientas que solo puede usar un administrador
const ADMIN_TOOLS = new Set(['crear_proyecto', 'actualizar_proyecto', 'fijar_linea_base', 'gestionar_equipo']);

function runTool(name, input, ctx) {
  const db = ctx.db;
  const user = ctx.user;
  if (ADMIN_TOOLS.has(name) && !isAdmin(user)) {
    throw new Error('Sin permiso: solo un administrador puede crear o modificar proyectos y el equipo. Puedes consultar, simular y trabajar las tareas de tus proyectos.');
  }
  // Un proyecto que el usuario no puede ver se trata como inexistente
  const findVisible = (id) => {
    const p = findProject(db, id);
    need(canSeeProject(user, p), `No existe el proyecto "${id}". Usa consultar_cartera para ver los ids.`);
    return p;
  };
  const now = serverNow();
  const sched = () => schedulePortfolioWithBaseline(db, now);
  const persist = (p) => {
    ctx.changed = true;
    const s = sched();
    return p ? { ok: true, proyecto: projectSummary(db, s, p), advertencias: s.warnings } : { ok: true };
  };

  switch (name) {
    case 'consultar_cartera': {
      const s = sched();
      return {
        fecha_actual: `${now} (${WEEKDAY_NAMES[weekdayOf(now)]})`,
        calendario: {
          horas_por_semana: weeklyHours(db.settings),
          factor_enfoque: db.settings.focusFactor,
          semanas_sprint_default: db.settings.sprintWeeks,
          desarrollo_con_ia: db.settings.ai?.enabled === false ? 'desactivado' : { factores_por_tipo: db.settings.ai.factors, factor_predeterminado: db.settings.ai.defaultFactor },
          dias: Object.entries(db.settings.workdays).filter(([, v]) => v).map(([d, v]) => `${WEEKDAY_NAMES[d]} ${v.start}-${v.end}${v.lunchStart ? ` (comida ${v.lunchStart}-${v.lunchEnd})` : ''}`),
          festivos_proximos: db.settings.holidays.filter((h) => h >= now.slice(0, 10)).slice(0, 8),
        },
        equipo: db.team.map((m) => ({ id: m.id, nombre: m.name, rol: m.role, dedicacion: m.allocation })),
        plantillas: db.templates.map((t) => ({ id: t.id, nombre: t.name, descripcion: t.description, horas: t.tasks.reduce((a, x) => a + (Number(x.estimate) || 0), 0), tareas: t.tasks.map((x) => x.title) })),
        proyectos: db.projects.filter((p) => canSeeProject(user, p)).map((p) => projectSummary(db, s, p)),
        advertencias: s.warnings,
      };
    }
    case 'consultar_proyecto': {
      const p = findVisible(input.proyecto_id);
      return projectDetail(db, sched(), p);
    }
    case 'crear_proyecto': {
      need(input.nombre, 'Falta nombre.');
      need(isDate(input.fecha_inicio), 'fecha_inicio debe ser YYYY-MM-DD.');
      const p = {
        id: uid('p'), name: input.nombre, client: input.cliente || '', description: input.descripcion || '',
        startDate: input.fecha_inicio, sprintWeeks: Number(input.semanas_sprint) || db.settings.sprintWeeks || 2,
        priority: Number(input.prioridad) || db.projects.length + 1,
        members: (input.miembros || []).filter((id) => db.team.some((m) => m.id === id)),
        color: pickColor(db.projects.length), status: 'activo', baseline: null, tasks: [],
      };
      if (input.plantilla_id) {
        const tp = db.templates.find((t) => t.id === input.plantilla_id || t.name === input.plantilla_id);
        need(tp, `No existe la plantilla "${input.plantilla_id}".`);
        p.tasks.push(...tasksFromTemplate(tp).map((t) => ({ ...t, createdAt: now })));
      }
      db.projects.push(p);
      buildTasks(p, input.tareas, db);
      return persist(p);
    }
    case 'agregar_tareas': {
      const p = findVisible(input.proyecto_id);
      const created = buildTasks(p, input.tareas, db);
      return { ...persist(p), tareas_creadas: created.map((t) => ({ id: t.id, titulo: t.title })) };
    }
    case 'actualizar_tarea': {
      const p = findVisible(input.proyecto_id);
      const t = p.tasks.find((x) => x.id === input.tarea_id) || p.tasks.find((x) => x.title.toLowerCase() === String(input.tarea_id).toLowerCase());
      need(t, `No existe la tarea "${input.tarea_id}".`);
      const c = input.cambios || {};
      if (c.titulo) t.title = c.titulo;
      if (c.descripcion != null) t.description = c.descripcion;
      if (c.fase != null) t.phase = c.fase;
      if (c.horas != null) t.estimate = Number(c.horas);
      if (c.optimista != null) t.optimistic = c.optimista;
      if (c.probable != null) t.likely = c.probable;
      if (c.pesimista != null) t.pessimistic = c.pesimista;
      if (c.rol != null) t.role = c.rol;
      if (c.factor_ia != null) t.aiFactor = Number(c.factor_ia) > 0 ? Math.min(1.5, Number(c.factor_ia)) : null;
      if (c.responsable_id != null) t.assignee = db.team.some((m) => m.id === c.responsable_id) ? c.responsable_id : '';
      if (c.fecha_limite != null) t.dueDate = isDate(c.fecha_limite) ? c.fecha_limite : null;
      if (c.depende_de) t.deps = resolveDeps(p, c.depende_de, t.id);
      if (c.sprint != null) t.sprintOverride = Number(c.sprint) > 0 ? Number(c.sprint) - 1 : null;
      if (c.horas_reales != null) t.actualHours = Number(c.horas_reales);
      if (c.estado) setTaskStatus(t, c.estado, now, db.settings);
      if (c.horas_restantes != null && t.status !== 'done') setTaskRemaining(t, c.horas_restantes, now);
      return persist(p);
    }
    case 'eliminar_tarea': {
      const p = findVisible(input.proyecto_id);
      const before = p.tasks.length;
      p.tasks = p.tasks.filter((x) => x.id !== input.tarea_id);
      need(p.tasks.length < before, 'Tarea no encontrada.');
      for (const t of p.tasks) t.deps = (t.deps || []).filter((d) => d !== input.tarea_id);
      return persist(p);
    }
    case 'actualizar_proyecto': {
      const p = findVisible(input.proyecto_id);
      const c = input.cambios || {};
      if (c.nombre) p.name = c.nombre;
      if (c.fecha_inicio) { need(isDate(c.fecha_inicio), 'fecha_inicio debe ser YYYY-MM-DD.'); p.startDate = c.fecha_inicio; }
      if (c.descripcion != null) p.description = c.descripcion;
      if (c.cliente != null) p.client = c.cliente;
      if (c.semanas_sprint) p.sprintWeeks = Number(c.semanas_sprint);
      if (c.prioridad) p.priority = Number(c.prioridad);
      if (c.miembros) p.members = c.miembros.filter((id) => db.team.some((m) => m.id === id));
      if (c.estado) p.status = c.estado;
      return persist(p);
    }
    case 'fijar_linea_base': {
      const p = findVisible(input.proyecto_id);
      const s = sched();
      p.baseline = {
        at: now,
        end: s.projects[p.id].end,
        tasks: Object.fromEntries(p.tasks.filter((t) => s.tasks[t.id]).map((t) => [t.id, { start: s.tasks[t.id].start, end: s.tasks[t.id].end }])),
      };
      return persist(p);
    }
    case 'gestionar_equipo': {
      if (input.accion === 'agregar') {
        need(input.nombre, 'Falta nombre.');
        const m = { id: uid('m'), name: input.nombre, role: input.rol || '', allocation: Number(input.dedicacion) || 1 };
        db.team.push(m);
        return { ...persist(), miembro: m };
      }
      const m = db.team.find((x) => x.id === input.id || x.name === input.nombre);
      need(m, 'Persona no encontrada.');
      if (input.accion === 'eliminar') {
        db.team = db.team.filter((x) => x !== m);
        for (const p of db.projects) {
          p.members = (p.members || []).filter((id) => id !== m.id);
          for (const t of p.tasks) if (t.assignee === m.id) t.assignee = '';
        }
      } else {
        if (input.nombre) m.name = input.nombre;
        if (input.rol != null) m.role = input.rol;
        if (input.dedicacion != null) m.allocation = Number(input.dedicacion);
      }
      return persist();
    }
    case 'simular_proyecto': {
      need(isDate(input.fecha_inicio), 'fecha_inicio debe ser YYYY-MM-DD.');
      const sim = structuredClone(db);
      const extra = Math.max(0, Number(input.personas_extra) || 0);
      const extraIds = [];
      for (let i = 0; i < extra; i++) {
        const id = `sim${i}`;
        extraIds.push(id);
        sim.team.push({ id, name: `Persona extra ${i + 1}`, role: '', allocation: 1 });
      }
      const p = {
        id: '__sim', name: 'Simulación', startDate: input.fecha_inicio,
        sprintWeeks: Number(input.semanas_sprint) || sim.settings.sprintWeeks || 2,
        priority: Number(input.prioridad) || 999,
        members: [...(input.miembros || []), ...(input.miembros?.length ? extraIds : [])],
        status: 'activo', tasks: [],
      };
      if (input.plantilla_id) {
        const tp = sim.templates.find((t) => t.id === input.plantilla_id || t.name === input.plantilla_id);
        need(tp, 'Plantilla no encontrada.');
        p.tasks.push(...tasksFromTemplate(tp));
      }
      sim.projects.push(p);
      buildTasks(p, input.tareas, sim);
      const s = schedulePortfolioWithBaseline(sim, now);
      return { simulacion: projectDetail(sim, s, p), nota: 'No se guardó nada.' };
    }
    default:
      throw new Error(`Herramienta desconocida: ${name}`);
  }
}

const COLORS = ['#2a78d6', '#1baa7b', '#e0832c', '#8a5cd6', '#d64f6e', '#3aa3b8', '#a68a1f'];
export const pickColor = (i) => COLORS[i % COLORS.length];

// ---------- bucle del agente ----------
// El historial se guarda en el formato nativo de cada proveedor y se devuelve completo y sin
// editar (en Claude, los bloques de razonamiento solo son válidos si el historial no cambia).
// `attachments`: [{ kind: 'pdf'|'image'|'text', name, mediaType, data }] (data en base64 o texto).
export async function chat({ provider = 'anthropic', model, apiKey, history = [], text, attachments = [], projectId, user }) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`Proveedor desconocido: ${provider}`);
  const key = apiKey || (provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY);
  if (!key && !(provider === 'anthropic' && process.env.ANTHROPIC_AUTH_TOKEN)) {
    const err = new Error(`No hay API key de ${cfg.label}. Escribe tu propia llave en "Ajustes del agente" o configura ${cfg.envKey} en el archivo .env del servidor.`);
    err.code = 'NO_KEY';
    throw err;
  }
  const db = await loadDb();
  const now = serverNow();
  const sel = projectId ? db.projects.find((p) => p.id === projectId && canSeeProject(user, p)) : null;
  const role = isAdmin(user) ? 'administrador (puede crear y modificar todo)' : 'miembro (solo ve sus proyectos y trabaja sus tareas; no puede crear proyectos ni cambiar el equipo o la configuración)';
  const context = `<contexto>Fecha y hora actual: ${now} (${WEEKDAY_NAMES[weekdayOf(now)]}). Usuario: ${user?.name || 'desconocido'}, rol ${role}.${sel ? ` Proyecto abierto en pantalla: ${sel.id} "${sel.name}".` : ''}</contexto>`;
  const run = provider === 'openai' ? runOpenAI : runClaude;
  const before = structuredClone(db);
  const ctx = { db, user, changed: false };
  const out = await run({ key, model: model || cfg.defaultModel, history, context, text, attachments, ctx });
  if (ctx.changed) {
    db.activity = appendActivity(db.activity, diffActivity(before, db, `${user?.name || 'Alguien'} (vía agente)`, serverNow()));
    await saveDb(db);
  }
  return out;
}

function execTools(calls, ctx) {
  return calls.map(({ id, name, input }) => {
    try {
      return { id, ok: true, content: JSON.stringify(runTool(name, input || {}, ctx)) };
    } catch (err) {
      return { id, ok: false, content: String(err.message || err) };
    }
  });
}

// ---------- Claude ----------
async function runClaude({ key, model, history, context, text, attachments, ctx }) {
  // Las llaves de usuario (sk-ant-usr-…) no pertenecen a un workspace: la API pide indicar cuál usar
  const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
  const opts = workspace ? { defaultHeaders: { 'anthropic-workspace-id': workspace } } : {};
  const client = key ? new Anthropic({ apiKey: key, ...opts }) : new Anthropic(opts);
  const blocks = [{ type: 'text', text: context }];
  for (const a of attachments) {
    if (a.kind === 'pdf') blocks.push({ type: 'document', title: a.name, source: { type: 'base64', media_type: 'application/pdf', data: a.data } });
    else if (a.kind === 'image') blocks.push({ type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.data } });
    else blocks.push({ type: 'document', title: a.name, source: { type: 'text', media_type: 'text/plain', data: a.data } });
  }
  blocks.push({ type: 'text', text });

  const messages = [...history];
  const last = messages[messages.length - 1];
  if (last?.role === 'user') {
    // El turno anterior terminó con resultados de herramientas: se agrega al mismo mensaje de usuario
    messages[messages.length - 1] = { role: 'user', content: [...asBlocks(last.content), ...blocks] };
  } else {
    messages.push({ role: 'user', content: blocks });
  }
  const usage = { input: 0, output: 0, cached: 0 };
  const premium = CLAUDE_FALLBACK_MODELS.has(model);

  for (let i = 0; i < 25; i++) {
    const params = {
      model,
      max_tokens: 16000,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: TOOLS,
      messages,
    };
    if (premium) Object.assign(params, { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', output_config: { effort: 'medium' } });
    const response = premium ? await client.beta.messages.create(params) : await client.messages.create(params);
    const u = response.usage || {};
    usage.input += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    usage.cached += u.cache_read_input_tokens || 0;
    usage.output += u.output_tokens || 0;
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'pause_turn') continue;
    if (response.stop_reason !== 'tool_use') {
      // Si se cortó a media llamada de herramienta, se cierra con un error para que el historial siga siendo válido
      const dangling = response.content.filter((b) => b.type === 'tool_use');
      if (dangling.length) {
        messages.push({ role: 'user', content: dangling.map((b) => ({ type: 'tool_result', tool_use_id: b.id, is_error: true, content: `No se ejecutó (stop_reason: ${response.stop_reason}).` })) });
      }
      return { messages, changed: ctx.changed, stopReason: response.stop_reason, usage, model: response.model };
    }
    const calls = response.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input }));
    const results = execTools(calls, ctx).map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, ...(r.ok ? {} : { is_error: true }) }));
    messages.push({ role: 'user', content: results });
  }
  return { messages, changed: ctx.changed, stopReason: 'max_iterations', usage, model };
}

// ---------- ChatGPT ----------
const OPENAI_TOOLS = TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));

async function runOpenAI({ key, model, history, context, text, attachments, ctx }) {
  const client = new OpenAI({ apiKey: key });
  const parts = [{ type: 'text', text: context }];
  for (const a of attachments) {
    if (a.kind === 'pdf') parts.push({ type: 'file', file: { filename: a.name, file_data: `data:application/pdf;base64,${a.data}` } });
    else if (a.kind === 'image') parts.push({ type: 'image_url', image_url: { url: `data:${a.mediaType};base64,${a.data}` } });
    else parts.push({ type: 'text', text: `Archivo adjunto "${a.name}":\n${a.data}` });
  }
  parts.push({ type: 'text', text });
  const messages = [...history, { role: 'user', content: parts }];
  const usage = { input: 0, output: 0, cached: 0 };
  let usedModel = model;

  for (let i = 0; i < 25; i++) {
    const completion = await client.chat.completions.create({
      model,
      max_completion_tokens: 16000,
      messages: [{ role: 'system', content: SYSTEM }, ...messages],
      tools: OPENAI_TOOLS,
    });
    usedModel = completion.model || model;
    usage.input += completion.usage?.prompt_tokens || 0;
    usage.cached += completion.usage?.prompt_tokens_details?.cached_tokens || 0;
    usage.output += completion.usage?.completion_tokens || 0;
    const choice = completion.choices[0];
    const msg = choice.message;
    const assistant = { role: 'assistant', content: msg.content ?? null };
    if (msg.tool_calls?.length) assistant.tool_calls = msg.tool_calls;
    if (msg.refusal) assistant.refusal = msg.refusal;
    messages.push(assistant);

    if (!msg.tool_calls?.length) {
      return { messages, changed: ctx.changed, stopReason: msg.refusal ? 'refusal' : choice.finish_reason, usage, model: usedModel };
    }
    const calls = msg.tool_calls.filter((c) => c.type === 'function').map((c) => {
      let input = null;
      try { input = JSON.parse(c.function.arguments || '{}'); } catch { /* argumentos inválidos */ }
      return { id: c.id, name: c.function.name, input };
    });
    // Cada tool_call necesita su respuesta, en el mismo orden
    for (const c of calls) {
      if (c.input === null) {
        messages.push({ role: 'tool', tool_call_id: c.id, content: 'Error: los argumentos no son JSON válido; vuelve a intentarlo.' });
        continue;
      }
      const [r] = execTools([c], ctx);
      messages.push({ role: 'tool', tool_call_id: r.id, content: r.ok ? r.content : `Error: ${r.content}` });
    }
  }
  return { messages, changed: ctx.changed, stopReason: 'max_iterations', usage, model: usedModel };
}

const asBlocks = (c) => (typeof c === 'string' ? [{ type: 'text', text: c }] : c);

export { runTool, fmtDate };
