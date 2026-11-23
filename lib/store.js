// Persistencia de la base de datos (un solo documento JSON):
// - Redis (Upstash, p. ej. desde el Marketplace de Vercel) si hay credenciales en el entorno.
// - Archivo data/db.json en local.
// - En Vercel sin Redis: /tmp (temporal, se pierde al reiniciar la función).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultSettings, defaultAiSettings, uid } from './scheduler.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Credenciales REST de Upstash. Vercel las nombra según el prefijo elegido al conectar la base
// (KV_REST_API_URL, STORAGE_KV_REST_API_URL, UPSTASH_REDIS_REST_URL…): se aceptan todas.
function redisEnv() {
  const env = process.env;
  for (const [u, t] of [['KV_REST_API_URL', 'KV_REST_API_TOKEN'], ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']]) {
    if (env[u] && env[t]) return { url: env[u], token: env[t] };
  }
  for (const k of Object.keys(env)) {
    if (!/REST_API_URL$|REDIS_REST_URL$/.test(k)) continue;
    const t = k.replace(/URL$/, 'TOKEN');
    if (env[t] && /^https:\/\//.test(env[k])) return { url: env[k], token: env[t] };
  }
  return null;
}
const redisUrl = () => redisEnv()?.url;
const redisToken = () => redisEnv()?.token;
const REDIS_KEY = () => process.env.DB_KEY || 'agente-sprints:db';
const dataDir = () => (process.env.VERCEL ? '/tmp/agente-sprints' : path.join(here, '..', 'data'));
const dbFile = () => path.join(dataDir(), 'db.json');

export function storageKind() {
  if (redisUrl() && redisToken()) return 'redis';
  return process.env.VERCEL ? 'temporal' : 'archivo';
}

async function redis(command) {
  const r = await fetch(redisUrl(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${redisToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Redis: ${j.error || r.status}`);
  return j.result;
}

export async function loadDb() {
  let db = null;
  if (storageKind() === 'redis') {
    const raw = await redis(['GET', REDIS_KEY()]);
    db = raw ? JSON.parse(raw) : null;
  } else if (fs.existsSync(dbFile())) {
    db = JSON.parse(fs.readFileSync(dbFile(), 'utf8'));
  }
  if (!db) {
    db = seedDb();
    await saveDb(db);
  }
  db.settings ||= defaultSettings();
  db.settings.ai ||= defaultAiSettings();
  db.team ||= [];
  db.projects ||= [];
  db.templates ||= [];
  db.users ||= [];
  return db;
}

export async function saveDb(db) {
  const json = JSON.stringify(db, null, 2);
  if (storageKind() === 'redis') {
    await redis(['SET', REDIS_KEY(), json]);
    return;
  }
  fs.mkdirSync(dataDir(), { recursive: true });
  const tmp = dbFile() + '.tmp';
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, dbFile());
}

// Plantilla: lista de tareas; `deps` son índices dentro de la misma plantilla
const tpl = (name, description, rows) => ({
  id: uid('tpl'),
  name,
  description,
  tasks: rows.map(([title, phase, estimate, role, deps = []]) => ({ title, phase, estimate, role, deps })),
});

export function defaultTemplates() {
  return [
    tpl('Desarrollo de software web', 'Ciclo completo: análisis, diseño, desarrollo, QA y despliegue', [
      ['Levantamiento de requerimientos', 'Análisis', 12, 'Análisis'],
      ['Diseño de arquitectura', 'Análisis', 8, 'Desarrollo', [0]],
      ['Diseño UI/UX (prototipos)', 'Diseño', 16, 'Diseño', [0]],
      ['Configuración de repositorio y ambientes', 'Desarrollo', 4, 'Desarrollo', [1]],
      ['Modelo de datos', 'Desarrollo', 8, 'Desarrollo', [1]],
      ['Backend / API', 'Desarrollo', 40, 'Desarrollo', [3, 4]],
      ['Frontend', 'Desarrollo', 40, 'Desarrollo', [2, 3]],
      ['Integración front-back', 'Desarrollo', 12, 'Desarrollo', [5, 6]],
      ['Pruebas QA', 'QA', 16, 'QA', [7]],
      ['Corrección de defectos', 'Desarrollo', 12, 'Desarrollo', [8]],
      ['Despliegue a producción', 'Despliegue', 6, 'Desarrollo', [9]],
      ['Capacitación y entrega', 'Cierre', 4, 'Gestión', [10]],
    ]),
    tpl('Integración vía API', 'Conectar un sistema externo mediante API', [
      ['Análisis de documentación del API', 'Análisis', 6, 'Desarrollo'],
      ['Credenciales y ambiente sandbox', 'Análisis', 3, 'Desarrollo', [0]],
      ['Desarrollo del conector', 'Desarrollo', 24, 'Desarrollo', [1]],
      ['Manejo de errores y reintentos', 'Desarrollo', 8, 'Desarrollo', [2]],
      ['Pruebas integrales', 'QA', 10, 'QA', [3]],
      ['Paso a producción', 'Despliegue', 4, 'Desarrollo', [4]],
      ['Documentación técnica', 'Cierre', 4, 'Desarrollo', [5]],
    ]),
    tpl('Implementación en cliente', 'Instalación, configuración y arranque en sitio del cliente', [
      ['Kickoff con el cliente', 'Inicio', 2, 'Gestión'],
      ['Levantamiento de infraestructura', 'Análisis', 8, 'Análisis', [0]],
      ['Instalación y configuración', 'Implementación', 12, 'Desarrollo', [1]],
      ['Parametrización', 'Implementación', 16, 'Desarrollo', [2]],
      ['Pruebas de aceptación (UAT)', 'QA', 12, 'QA', [3]],
      ['Capacitación a usuarios', 'Cierre', 6, 'Gestión', [4]],
      ['Liberación y soporte post-arranque', 'Cierre', 8, 'Desarrollo', [5]],
    ]),
  ];
}

// Convierte una plantilla en tareas reales con ids y dependencias resueltas
export function tasksFromTemplate(template) {
  const ids = template.tasks.map(() => uid('t'));
  return template.tasks.map((t, i) => ({
    id: ids[i],
    title: t.title,
    phase: t.phase || '',
    estimate: Number(t.estimate) || 0,
    role: t.role || '',
    deps: (t.deps || []).map((d) => ids[d]).filter(Boolean),
    status: 'todo',
    log: [],
  }));
}

function seedDb() {
  const team = [
    { id: 'm1', name: 'Dev 1', role: 'Desarrollo', allocation: 1 },
    { id: 'm2', name: 'Dev 2', role: 'Desarrollo', allocation: 1 },
    { id: 'm3', name: 'QA 1', role: 'QA', allocation: 0.5 },
  ];
  const templates = defaultTemplates();
  const tasks = tasksFromTemplate(templates[0]);
  // Avance de ejemplo para que las gráficas muestren datos reales
  const progress = [
    { i: 0, startedAt: '2026-10-26T09:00', doneAt: '2026-10-27T13:00', actualHours: 8, assignee: 'm1' },
    { i: 1, startedAt: '2026-10-27T15:00', doneAt: '2026-10-29T11:00', actualHours: 5, assignee: 'm1' },
    { i: 2, startedAt: '2026-10-28T09:00', doneAt: '2026-11-03T12:00', actualHours: 9, assignee: 'm2' },
    { i: 3, startedAt: '2026-10-29T11:00', doneAt: '2026-10-29T17:00', actualHours: 2.5, assignee: 'm1' },
  ];
  for (const p of progress) {
    Object.assign(tasks[p.i], { status: 'done', startedAt: p.startedAt, doneAt: p.doneAt, actualHours: p.actualHours, assignee: p.assignee, log: [{ at: p.doneAt, remaining: 0 }] });
  }
  Object.assign(tasks[4], { status: 'doing', startedAt: '2026-11-02T09:00', assignee: 'm1', remaining: 3, log: [{ at: '2026-11-03T18:00', remaining: 5 }, { at: '2026-11-05T18:00', remaining: 3 }] });
  for (const t of tasks) t.createdAt = '2026-10-26T09:00';

  return {
    settings: defaultSettings(),
    team,
    templates,
    projects: [
      {
        id: 'p_demo',
        name: 'Ejemplo — Portal de clientes',
        client: 'Cliente demo',
        description: 'Proyecto de ejemplo creado desde la plantilla "Desarrollo de software web". Puedes borrarlo.',
        startDate: '2026-10-26',
        sprintWeeks: 2,
        priority: 1,
        members: [],
        color: '#2a78d6',
        status: 'activo',
        baseline: null,
        tasks,
      },
    ],
  };
}
