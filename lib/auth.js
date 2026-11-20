// Cuentas de usuario: contraseñas con scrypt, sesiones firmadas en cookie y permisos.
// Roles:
//   admin   → ve y edita todo (proyectos, equipo, configuración, plantillas, usuarios).
//   miembro → ve solo los proyectos donde está asignado (o los que son "de todo el equipo")
//             y puede trabajar sus tareas; no crea ni borra proyectos ni toca la configuración.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SESSION_COOKIE = 'sprints_session';
const SESSION_DAYS = 7;

// ---------- contraseñas ----------
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt:${salt.toString('base64')}:${hash.toString('base64')}`;
}
export function verifyPassword(password, stored) {
  const [kind, salt, hash] = String(stored || '').split(':');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}
export function passwordProblem(password) {
  const p = String(password || '');
  if (p.length < 10) return 'La contraseña debe tener al menos 10 caracteres.';
  return null;
}

// ---------- sesiones ----------
// En Vercel cada instancia de la función debe firmar con el mismo secreto: SESSION_SECRET es obligatorio.
// En local, si no existe, se genera uno y se guarda en data/.session-secret.
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.VERCEL) throw Object.assign(new Error('Falta la variable SESSION_SECRET en Vercel (Settings → Environment Variables).'), { status: 500 });
  const file = path.join(here, '..', 'data', '.session-secret');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'));
  }
  return fs.readFileSync(file, 'utf8').trim();
}
const mac = (body) => crypto.createHmac('sha256', sessionSecret()).update(body).digest('base64url');

export function createSessionToken(user) {
  const body = Buffer.from(JSON.stringify({ uid: user.id, v: user.sessionVersion || 0, exp: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
  return `${body}.${mac(body)}`;
}
export function readSessionToken(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expected = mac(body);
  if (expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
export function sessionCookie(token, req) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || process.env.VERCEL ? '; Secure' : '';
  return token
    ? `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`
    : `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}
// Usuario de la sesión (o null). La versión de sesión invalida cookies viejas al cambiar contraseña o borrar al usuario.
export function userFromRequest(req, db) {
  const p = readSessionToken(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  if (!p) return null;
  const u = (db.users || []).find((x) => x.id === p.uid);
  return u && (u.sessionVersion || 0) === p.v && !u.disabled ? u : null;
}

// ---------- permisos ----------
export const isAdmin = (u) => u?.role === 'admin';
// Un proyecto sin miembros marcados es "de todo el equipo"; con miembros, solo lo ven ellos (y los admins)
export function canSeeProject(user, project) {
  if (isAdmin(user)) return true;
  const members = project.members || [];
  return members.length === 0 || Boolean(user?.memberId && members.includes(user.memberId));
}
export function publicUser(u) {
  if (!u) return null;
  const { passwordHash, sessionVersion, ...rest } = u;
  return rest;
}

// Lo que el navegador de este usuario puede ver
export function viewFor(db, user) {
  const visible = new Set((db.projects || []).filter((p) => canSeeProject(user, p)).map((p) => p.id));
  const { users, profilePrefs, activity, ...rest } = db;
  // Los proyectos ocultos se mandan sin nombres ni descripciones, solo con la carga de trabajo:
  // así las fechas que calcula el navegador coinciden con la realidad (las personas son compartidas).
  const LOAD_FIELDS = ['id', 'estimate', 'optimistic', 'likely', 'pessimistic', 'role', 'phase', 'aiFactor', 'assignee', 'deps', 'status', 'startedAt', 'doneAt', 'actualHours', 'remaining', 'sprintOverride'];
  const hiddenLoad = (db.projects || []).filter((p) => !visible.has(p.id) && p.status !== 'archivado').map((p, i) => ({
    id: `oculto-${i}`, name: 'Proyecto sin acceso', startDate: p.startDate, priority: p.priority, sprintWeeks: p.sprintWeeks, members: p.members || [], status: p.status,
    tasks: (p.tasks || []).map((t) => Object.fromEntries(LOAD_FIELDS.filter((k) => t[k] !== undefined).map((k) => [k, t[k]]))),
  }));
  return {
    ...rest,
    hiddenLoad,
    projects: (db.projects || []).filter((p) => visible.has(p.id)),
    activity: (activity || []).filter((e) => (e.projectId ? visible.has(e.projectId) : isAdmin(user))),
    profilePrefs: profilePrefs?.[user.id] ? { [user.id]: profilePrefs[user.id] } : {},
  };
}

// Aplica lo que el navegador mandó, aceptando solo lo que el rol permite.
// Los usuarios, la actividad y las preferencias ajenas siempre vienen del servidor.
export function mergeFromUser(serverDb, clientDb, user) {
  const prefs = { ...(serverDb.profilePrefs || {}) };
  if (clientDb.profilePrefs?.[user.id]) prefs[user.id] = clientDb.profilePrefs[user.id];
  if (isAdmin(user)) {
    const { hiddenLoad, ...data } = clientDb;
    return { ...data, users: serverDb.users || [], activity: serverDb.activity || [], profilePrefs: prefs };
  }
  // Miembro: solo cambian las tareas de los proyectos que puede ver; lo demás se conserva del servidor
  const fromClient = new Map((clientDb.projects || []).map((p) => [p.id, p]));
  const projects = (serverDb.projects || []).map((sp) => {
    const cp = fromClient.get(sp.id);
    if (!cp || !canSeeProject(user, sp) || !Array.isArray(cp.tasks)) return sp;
    return { ...sp, tasks: cp.tasks };
  });
  return { ...serverDb, projects, profilePrefs: prefs };
}
