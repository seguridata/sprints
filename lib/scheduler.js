// Motor de calendario laboral, planificación y sprints.
// Módulo ES compartido por el servidor (agente) y el navegador (gráficas).
// El tiempo se maneja como "minuto absoluto" = díasDesde1970 * 1440 + minutoDelDía,
// sin zonas horarias, para que el cálculo sea idéntico en servidor y navegador.

export const STATUSES = [
  { id: 'todo', label: 'Por hacer' },
  { id: 'doing', label: 'En progreso' },
  { id: 'review', label: 'En revisión' },
  { id: 'done', label: 'Hecho' },
];

export const WEEKDAY_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

export function defaultSettings() {
  const full = { start: '09:00', end: '18:30', lunchStart: '14:00', lunchEnd: '15:00' };
  const years = [2026, 2027, 2028];
  return {
    // Horario: lunes a jueves 9:00–18:30 con 1 h de comida (8.5 h), viernes 9:00–15:00 (6 h) = 40 h/semana
    workdays: {
      0: null,
      1: { ...full },
      2: { ...full },
      3: { ...full },
      4: { ...full },
      5: { start: '09:00', end: '15:00', lunchStart: '', lunchEnd: '' },
      6: null,
    },
    holidays: years.flatMap(mexicanHolidays),
    // Porcentaje de las horas laborales que realmente se dedica a tareas del proyecto
    // (descuenta juntas, correos, soporte, interrupciones).
    focusFactor: 0.8,
    sprintWeeks: 2,
    ai: defaultAiSettings(),
  };
}

// Desarrollo asistido con IA: las horas se estiman como las haría un equipo tradicional y se
// multiplican por un factor según el tipo de trabajo (rol o fase). 0.5 = la mitad del tiempo.
// El código se acelera mucho; reuniones, pruebas con el cliente y despliegues, poco.
export function defaultAiSettings() {
  return {
    enabled: true,
    defaultFactor: 0.7,
    factors: {
      'Desarrollo': 0.5,
      'Diseño': 0.6,
      'QA': 0.6,
      'Análisis': 0.7,
      'Despliegue': 0.8,
      'Implementación': 0.8,
      'Gestión': 0.9,
      'Cierre': 0.9,
      'Inicio': 1,
    },
  };
}

// Días de descanso obligatorio (Art. 74 LFT, México)
export function mexicanHolidays(year) {
  const nthMonday = (month, n) => {
    let d = 1;
    while (weekdayOf(dateStr(year, month, d)) !== 1) d++;
    return dateStr(year, month, d + 7 * (n - 1));
  };
  const list = [
    dateStr(year, 1, 1),
    nthMonday(2, 1),
    nthMonday(3, 3),
    dateStr(year, 5, 1),
    dateStr(year, 9, 16),
    nthMonday(11, 3),
    dateStr(year, 12, 25),
  ];
  if ((year - 2024) % 6 === 0) list.push(dateStr(year, 10, 1));
  return list;
}

// ---------- utilidades de fecha ----------
const pad = (n) => String(n).padStart(2, '0');
export const dateStr = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

export function dayNum(str) {
  const [y, m, d] = str.slice(0, 10).split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}
export function dayStr(num) {
  const dt = new Date(num * 86400000);
  return dateStr(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}
export const weekdayOf = (str) => (((dayNum(str) + 4) % 7) + 7) % 7;
export const hm = (s) => {
  if (!s) return null;
  const [h, m] = s.split(':').map(Number);
  return h * 60 + (m || 0);
};
export const fmtHM = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

// "YYYY-MM-DD" o "YYYY-MM-DDTHH:MM" -> minuto absoluto
export function toAbs(str) {
  if (!str) return null;
  const day = dayNum(str);
  const t = str.length > 10 ? hm(str.slice(11, 16)) : 0;
  return day * 1440 + t;
}
export function fromAbs(abs) {
  const day = Math.floor(abs / 1440);
  return `${dayStr(day)}T${fmtHM(abs - day * 1440)}`;
}
// Fecha y hora local "YYYY-MM-DDTHH:MM". Con `timeZone` (p. ej. en el servidor, que en la nube
// corre en UTC) se calcula para esa zona; sin él, se usa la hora local de quien ejecuta.
export function nowLocalString(d = new Date(), timeZone) {
  if (timeZone) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(d).map((x) => [x.type, x.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  }
  return `${dateStr(d.getFullYear(), d.getMonth() + 1, d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fmtDate(strOrAbs, withTime = false) {
  if (strOrAbs == null) return '—';
  const s = typeof strOrAbs === 'number' ? fromAbs(strOrAbs) : strOrAbs;
  const [y, m, d] = s.slice(0, 10).split('-');
  const meses = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const base = `${Number(d)} ${meses[Number(m) - 1]} ${y}`;
  return withTime && s.length > 10 ? `${base} ${s.slice(11, 16)}` : base;
}

// ---------- calendario laboral ----------
export function makeCalendar(settings) {
  const holidays = new Set(settings.holidays || []);
  const cache = new Map();

  function intervals(day) {
    if (cache.has(day)) return cache.get(day);
    const str = dayStr(day);
    let res = [];
    const wd = settings.workdays?.[weekdayOf(str)];
    if (wd && !holidays.has(str)) {
      const s = hm(wd.start), e = hm(wd.end), ls = hm(wd.lunchStart), le = hm(wd.lunchEnd);
      if (ls != null && le != null && ls > s && le < e && le > ls) res = [[s, ls], [le, e]];
      else res = [[s, e]];
    }
    cache.set(day, res);
    return res;
  }
  const dayHours = (day) => intervals(day).reduce((a, [s, e]) => a + (e - s), 0) / 60;
  const isWorkday = (day) => intervals(day).length > 0;

  // Avanza `hours` horas laborales desde `abs`
  function addWork(abs, hours) {
    let left = Math.max(0, hours) * 60;
    let day = Math.floor(abs / 1440);
    let min = abs - day * 1440;
    for (let guard = 0; guard < 365 * 20; guard++) {
      for (const [s, e] of intervals(day)) {
        if (min >= e) continue;
        const from = Math.max(min, s);
        if (left <= 0) return day * 1440 + from;
        const avail = e - from;
        if (left <= avail) return day * 1440 + from + Math.round(left);
        left -= avail;
        min = e;
      }
      day++;
      min = 0;
    }
    throw new Error('Calendario sin días laborables');
  }

  // Retrocede `hours` horas laborales desde `abs`
  function subWork(abs, hours) {
    let left = Math.max(0, hours) * 60;
    let day = Math.floor(abs / 1440);
    let min = abs - day * 1440;
    for (let guard = 0; guard < 365 * 20; guard++) {
      const ivs = intervals(day);
      for (let i = ivs.length - 1; i >= 0; i--) {
        const [s, e] = ivs[i];
        if (min <= s) continue;
        const to = Math.min(min, e);
        const avail = to - s;
        if (left <= avail) return day * 1440 + to - Math.round(left);
        left -= avail;
        min = s;
      }
      day--;
      min = 1440;
    }
    throw new Error('Calendario sin días laborables');
  }

  // Horas laborales entre dos instantes
  function workBetween(a, b) {
    if (b <= a) return 0;
    let total = 0;
    for (let day = Math.floor(a / 1440); day <= Math.floor(b / 1440); day++) {
      for (const [s, e] of intervals(day)) {
        const from = Math.max(day * 1440 + s, a);
        const to = Math.min(day * 1440 + e, b);
        if (to > from) total += to - from;
      }
    }
    return total / 60;
  }

  // Inicio del siguiente intervalo laboral (o el mismo instante si ya es laboral)
  const normalize = (abs) => addWork(abs, 0);
  const dayStartAbs = (day) => day * 1440 + (intervals(day)[0]?.[0] ?? 0);
  const dayEndAbs = (day) => {
    const ivs = intervals(day);
    return day * 1440 + (ivs.length ? ivs[ivs.length - 1][1] : 1440);
  };

  return { intervals, dayHours, isWorkday, addWork, subWork, workBetween, normalize, dayStartAbs, dayEndAbs };
}

export function weeklyHours(settings) {
  const cal = makeCalendar({ ...settings, holidays: [] });
  let t = 0;
  for (let d = 0; d < 7; d++) t += cal.dayHours(dayNum('2024-01-07') + d);
  return t;
}

// ---------- estimación ----------
// Horas tradicionales (sin IA). Si hay estimación de tres puntos usa PERT: (O + 4M + P) / 6
export function taskBaseEstimate(t) {
  const o = Number(t.optimistic), m = Number(t.likely), p = Number(t.pessimistic);
  if (o > 0 && m > 0 && p > 0) return Math.round(((o + 4 * m + p) / 6) * 10) / 10;
  return Number(t.estimate) || 0;
}
// Factor de IA aplicable: el de la tarea, o el de su rol, o el de su fase, o el predeterminado
export function aiFactorFor(t, settings) {
  const ai = settings?.ai;
  if (!ai || ai.enabled === false) return 1;
  const own = Number(t.aiFactor);
  if (own > 0) return Math.min(1.5, own);
  const find = (k) => {
    if (!k) return null;
    const key = Object.keys(ai.factors || {}).find((x) => x.toLowerCase() === String(k).trim().toLowerCase());
    return key ? Number(ai.factors[key]) : null;
  };
  return find(t.role) ?? find(t.phase) ?? (Number(ai.defaultFactor) || 1);
}
// Horas planificadas (con IA si está activada)
export function taskEstimate(t, settings) {
  return Math.round(taskBaseEstimate(t) * aiFactorFor(t, settings) * 10) / 10;
}
// Horas que faltan por trabajar (lo que reporta el equipo ya son horas reales)
export function taskRemaining(t, settings) {
  if (t.status === 'done') return 0;
  if (t.remaining != null && t.remaining !== '') return Number(t.remaining);
  return taskEstimate(t, settings);
}

// ---------- sprints ----------
export function sprintsFor(project, cal, untilAbs) {
  const weeks = Number(project.sprintWeeks) || 2;
  const start = dayNum(project.startDate);
  const out = [];
  const lastDay = Math.max(Math.floor(untilAbs / 1440), start);
  for (let i = 0; i < 200; i++) {
    const s = start + i * weeks * 7;
    if (i > 0 && s > lastDay) break;
    const e = s + weeks * 7 - 1;
    let hours = 0;
    for (let d = s; d <= e; d++) hours += cal.dayHours(d);
    out.push({ index: i, name: `Sprint ${i + 1}`, startDay: s, endDay: e, start: dayStr(s), end: dayStr(e), workHours: hours });
  }
  return out;
}
const sprintIndexOf = (sprints, day) => {
  for (const s of sprints) if (day >= s.startDay && day <= s.endDay) return s.index;
  return sprints.length ? sprints[sprints.length - 1].index : 0;
};

// ---------- planificación de cartera ----------
// Asigna fechas a todas las tareas de todos los proyectos respetando:
// calendario laboral, días festivos, dependencias, dedicación de cada persona,
// factor de enfoque y prioridad entre proyectos (personas compartidas).
export function schedulePortfolio(db, nowStr = nowLocalString()) {
  const settings = db.settings || defaultSettings();
  const cal = makeCalendar(settings);
  const focus = Number(settings.focusFactor) || 1;
  const now = toAbs(nowStr);
  const team = db.team?.length ? db.team : [{ id: '__equipo', name: 'Equipo', role: '', allocation: 1 }];
  const cursor = Object.fromEntries(team.map((m) => [m.id, -Infinity]));
  const memberById = Object.fromEntries(team.map((m) => [m.id, m]));
  const result = { settings, cal, now, projects: {}, tasks: {}, warnings: [], team };

  const projects = [...(db.projects || [])]
    .filter((p) => p.status !== 'archivado')
    .sort((a, b) => (Number(a.priority) || 99) - (Number(b.priority) || 99) || a.startDate.localeCompare(b.startDate));

  for (const p of projects) {
    const pStart = cal.normalize(toAbs(p.startDate) + 0);
    const members = (p.members?.length ? p.members : team.map((m) => m.id)).filter((id) => memberById[id]);
    const pool = members.length ? members : team.map((m) => m.id);
    const done = {};
    const tasks = p.tasks || [];
    const pending = [...tasks];
    let guard = 0;
    while (pending.length && guard++ < 10000) {
      let idx = pending.findIndex((t) => (t.deps || []).every((d) => done[d] || !tasks.some((x) => x.id === d)));
      if (idx === -1) {
        result.warnings.push(`Dependencia circular en "${p.name}"; se ignoraron dependencias de "${pending[0].title}".`);
        idx = 0;
      }
      const t = pending.splice(idx, 1)[0];
      const est = taskEstimate(t, settings);
      const depEnd = Math.max(pStart, ...(t.deps || []).map((d) => done[d]?.end ?? -Infinity));
      const rateOf = (mid) => Math.max(0.05, (Number(memberById[mid]?.allocation) || 1) * focus);

      let assignee = t.assignee && memberById[t.assignee] ? t.assignee : null;
      let start, end;

      if (t.status === 'done' && t.doneAt) {
        assignee = assignee || pool[0];
        end = toAbs(t.doneAt);
        const hrs = Number(t.actualHours) || est;
        start = t.startedAt ? toAbs(t.startedAt) : cal.subWork(end, hrs / rateOf(assignee));
        if (start > end) start = end;
        cursor[assignee] = Math.max(cursor[assignee], end);
      } else {
        const workLeft = taskRemaining(t, settings);
        let earliest = depEnd;
        if (t.status !== 'done') earliest = Math.max(earliest, now); // lo pendiente no puede ocurrir en el pasado
        if (t.status === 'doing' && t.startedAt) earliest = Math.max(depEnd, now);
        const candidates = assignee ? [assignee] : pool.filter((mid) => !t.role || !memberById[mid].role || memberById[mid].role.toLowerCase() === t.role.toLowerCase());
        const list = candidates.length ? candidates : pool;
        let best = null;
        for (const mid of list) {
          const s = cal.normalize(Math.max(earliest, cursor[mid]));
          const e = cal.addWork(s, workLeft / rateOf(mid));
          if (!best || e < best.e) best = { mid, s, e };
        }
        assignee = best.mid;
        start = best.s;
        end = best.e;
        if (t.status === 'doing' && t.startedAt) start = Math.min(start, toAbs(t.startedAt));
        cursor[assignee] = Math.max(cursor[assignee], best.e);
      }
      done[t.id] = { end };
      result.tasks[t.id] = {
        id: t.id, projectId: p.id, start, end, assignee, autoAssigned: !t.assignee,
        estimate: est, remaining: taskRemaining(t, settings),
        late: t.status !== 'done' && t.dueDate ? end > toAbs(t.dueDate) + 1440 : false,
      };
    }

    const ts = tasks.map((t) => result.tasks[t.id]).filter(Boolean);
    const end = ts.length ? Math.max(...ts.map((x) => x.end)) : pStart;
    const sprints = sprintsFor(p, cal, end);
    for (const t of tasks) {
      const st = result.tasks[t.id];
      if (!st) continue;
      st.sprint = t.sprintOverride != null && t.sprintOverride !== '' ? Number(t.sprintOverride) : sprintIndexOf(sprints, Math.floor((st.end - 1) / 1440)); // la tarea cuenta en el sprint donde termina
    }
    const capRate = pool.reduce((a, mid) => a + (Number(memberById[mid]?.allocation) || 1) * focus, 0);
    for (const s of sprints) {
      s.capacity = Math.round(s.workHours * capRate * 10) / 10;
      const inS = tasks.filter((t) => result.tasks[t.id]?.sprint === s.index);
      s.taskIds = inS.map((t) => t.id);
      s.committed = round1(inS.reduce((a, t) => a + taskEstimate(t, settings), 0));
      s.completed = round1(inS.filter((t) => t.status === 'done').reduce((a, t) => a + taskEstimate(t, settings), 0));
      // Horas terminadas dentro de las fechas del sprint (velocidad real)
      s.doneInWindow = round1(tasks.filter((t) => t.status === 'done' && t.doneAt && dayNum(t.doneAt) >= s.startDay && dayNum(t.doneAt) <= s.endDay).reduce((a, t) => a + taskEstimate(t, settings), 0));
      s.load = s.capacity ? s.committed / s.capacity : 0;
    }
    const totalHours = round1(tasks.reduce((a, t) => a + taskEstimate(t, settings), 0));
    const doneHours = round1(tasks.filter((t) => t.status === 'done').reduce((a, t) => a + taskEstimate(t, settings), 0));
    const doneWithActual = tasks.filter((t) => t.status === 'done' && Number(t.actualHours) > 0);
    const actualSum = doneWithActual.reduce((a, t) => a + Number(t.actualHours), 0);
    const accuracy = doneWithActual.length ? actualSum / (doneWithActual.reduce((a, t) => a + taskEstimate(t, settings), 0) || 1) : null;
    const observedAiFactor = doneWithActual.length ? actualSum / (doneWithActual.reduce((a, t) => a + taskBaseEstimate(t), 0) || 1) : null;
    const baseHours = round1(tasks.reduce((a, t) => a + taskBaseEstimate(t), 0));
    const baselineEnd = p.baseline?.end ?? null;
    result.projects[p.id] = {
      id: p.id, start: pStart, end, sprints, totalHours, doneHours,
      progress: totalHours ? doneHours / totalHours : 0,
      members: pool, accuracy, observedAiFactor, baseHours,
      slipDays: baselineEnd != null ? Math.round(cal.workBetween(Math.min(baselineEnd, end), Math.max(baselineEnd, end)) / 8 * Math.sign(end - baselineEnd) * 10) / 10 : null,
      currentSprint: sprints.find((s) => Math.floor(now / 1440) >= s.startDay && Math.floor(now / 1440) <= s.endDay)?.index ?? null,
    };
  }
  return result;
}

// ---------- burndown ----------
export function burndown(project, sprint, schedule) {
  const cal = schedule.cal;
  const settings = schedule.settings;
  const tasks = (project.tasks || []).filter((t) => sprint.taskIds.includes(t.id));
  const total = tasks.reduce((a, t) => a + taskEstimate(t, settings), 0);
  const days = [];
  for (let d = sprint.startDay; d <= sprint.endDay; d++) days.push(d);
  const workDays = days.filter((d) => cal.isWorkday(d));
  const sprintHours = workDays.reduce((a, d) => a + cal.dayHours(d), 0) || 1;
  const nowDay = Math.floor(schedule.now / 1440);

  let burned = 0;
  const points = [{ day: sprint.startDay - 1, label: 'Inicio', ideal: total, actual: nowDay >= sprint.startDay ? total : null, forecast: nowDay < sprint.startDay ? total : null }];
  for (const d of days) {
    burned += cal.dayHours(d);
    const ideal = Math.max(0, total * (1 - burned / sprintHours));
    const endOfDay = d * 1440 + 1439;
    let actual = null;
    if (d <= nowDay) {
      actual = tasks.reduce((a, t) => a + remainingAt(t, endOfDay, settings), 0);
    }
    const forecast = d < nowDay ? null : tasks.reduce((a, t) => {
      const st = schedule.tasks[t.id];
      if (!st) return a;
      if (st.end <= endOfDay) return a;
      if (st.start >= endOfDay) return a + taskRemaining(t, settings);
      const worked = cal.workBetween(st.start, endOfDay);
      const span = cal.workBetween(st.start, st.end) || 1;
      return a + taskRemaining(t, settings) * (1 - worked / span);
    }, 0);
    points.push({ day: d, label: dayStr(d), ideal: round1(ideal), actual: actual == null ? null : round1(actual), forecast: forecast == null ? null : round1(forecast), workday: cal.isWorkday(d) });
  }
  return { total: round1(total), points };
}

export function remainingAt(t, abs, settings) {
  const est = taskEstimate(t, settings);
  if (t.createdAt && toAbs(t.createdAt) > abs) return 0;
  if (t.status === 'done' && t.doneAt && toAbs(t.doneAt) <= abs) return 0;
  let val = est;
  for (const e of t.log || []) {
    if (toAbs(e.at) <= abs && e.remaining != null) val = Number(e.remaining);
  }
  return val;
}

// Carga semanal (horas planificadas) por persona — para detectar sobrecarga/capacidad libre
export function weeklyLoad(db, schedule, weeks = 12) {
  const cal = schedule.cal;
  const nowDay = Math.floor(schedule.now / 1440);
  const monday = nowDay - ((((nowDay + 4) % 7) + 6) % 7);
  const focus = Number(schedule.settings.focusFactor) || 1;
  const cols = [];
  for (let w = 0; w < weeks; w++) {
    const s = monday + w * 7;
    let hrs = 0;
    for (let d = s; d < s + 7; d++) hrs += cal.dayHours(d);
    cols.push({ startDay: s, label: dayStr(s), workHours: hrs });
  }
  const rows = schedule.team.map((m) => {
    const cells = cols.map((c) => {
      const a = c.startDay * 1440, b = (c.startDay + 7) * 1440;
      let used = 0;
      for (const st of Object.values(schedule.tasks)) {
        if (st.assignee !== m.id || st.end <= a || st.start >= b) continue;
        used += cal.workBetween(Math.max(st.start, a), Math.min(st.end, b));
      }
      // `used` = horas de calendario ocupadas; se convierten a horas efectivas con dedicación y enfoque
      const rate = (Number(m.allocation) || 1) * focus;
      return { used: round1(used * rate), capacity: round1(c.workHours * rate), ratio: c.workHours ? used / c.workHours : 0 };
    });
    return { member: m, cells };
  });
  return { cols, rows };
}

// Cambia el estado de una tarea registrando fechas reales e historial para el burndown
export function setTaskStatus(t, status, now = nowLocalString(), settings = null) {
  if (!STATUSES.some((s) => s.id === status) || t.status === status) return;
  const wasDone = t.status === 'done';
  t.status = status;
  if ((status === 'doing' || status === 'review') && !t.startedAt) t.startedAt = now;
  if (status === 'done') {
    t.doneAt = now;
    t.log = [...(t.log || []), { at: now, remaining: 0 }];
  } else if (wasDone) {
    t.doneAt = null;
    t.remaining = null;
    t.log = [...(t.log || []), { at: now, remaining: taskEstimate(t, settings) }];
  }
}
export function setTaskRemaining(t, remaining, now = nowLocalString()) {
  const r = Math.max(0, Number(remaining) || 0);
  t.remaining = r;
  t.log = [...(t.log || []), { at: now, remaining: r }];
}

export const round1 = (n) => Math.round(n * 10) / 10;
export const uid = (p = 't') => p + Math.random().toString(36).slice(2, 9);

// Planificación normal + escenario "sin IA" (mismas tareas y equipo, factor 1) para comparar fechas
export function schedulePortfolioWithBaseline(db, nowStr = nowLocalString()) {
  const result = schedulePortfolio(db, nowStr);
  const settings = db.settings || defaultSettings();
  if (settings.ai?.enabled === false) return result;
  const noAi = schedulePortfolio({ ...db, settings: { ...settings, ai: { ...settings.ai, enabled: false } } }, nowStr);
  for (const [id, p] of Object.entries(result.projects)) p.endWithoutAi = noAi.projects[id]?.end ?? null;
  return result;
}
