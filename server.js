// Servidor: sirve la interfaz, guarda los datos y conecta el chat con Claude o ChatGPT.
// En local se ejecuta con `npm start`; en Vercel, las funciones de /api reutilizan `handler`.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { loadDb, saveDb, storageKind } from './lib/store.js';
import { chat, PROVIDERS, serverKeys, serverNow } from './lib/agent.js';
import { diffActivity, appendActivity } from './lib/activity.js';
import {
  hashPassword, verifyPassword, passwordProblem, createSessionToken, sessionCookie, userFromRequest,
  isAdmin, publicUser, viewFor, mergeFromUser,
} from './lib/auth.js';
import { uid } from './lib/scheduler.js';
import { googleEnabled, allowedDomain, startUrl, finishLogin, adminEmails, STATE_COOKIE } from './lib/google.js';
import { parseCookies } from './lib/auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3210;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.json': 'application/json' };
const STATIC_ROOTS = { '/lib/': path.join(here, 'lib'), '/': path.join(here, 'public') };

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

// En Vercel el cuerpo máximo de una solicitud es 4.5 MB (los adjuntos en base64 cuentan)
const BODY_LIMIT = process.env.VERCEL ? 4.5 * 1024 * 1024 : 40 * 1024 * 1024;

function readBody(req, limit = BODY_LIMIT) {
  // Vercel puede entregar el cuerpo ya interpretado
  if (process.env.VERCEL && req.body !== undefined) {
    return Promise.resolve(typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {});
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error(`El mensaje es demasiado grande (máx. ${Math.round(limit / 1048576)} MB con adjuntos)`), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  for (const [prefix, dir] of Object.entries(STATIC_ROOTS)) {
    if (!url.startsWith(prefix)) continue;
    const rel = url.slice(prefix.length) || 'index.html';
    const file = path.resolve(dir, rel);
    if (!file.startsWith(dir + path.sep) && file !== dir) return send(res, 403, 'Prohibido', 'text/plain');
    if (prefix === '/lib/' && path.basename(file) !== 'scheduler.js') continue; // solo se publica el motor de cálculo
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
    }
  }
  send(res, 404, 'No encontrado', 'text/plain');
}

const providersInfo = () => {
  const keys = serverKeys();
  return Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => [id, { label: p.label, defaultModel: p.defaultModel, serverKey: keys[id] }]));
};

// ---------- cuentas y permisos ----------
const clean = (v, max = 120) => String(v ?? '').trim().slice(0, max);
const normEmail = (v) => clean(v, 200).toLowerCase();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Código para crear el primer administrador: SETUP_CODE, o APP_PASSWORD si ya estaba configurada.
// En Vercel es obligatorio, para que el primer visitante de la URL no pueda volverse administrador.
function setupCodeOk(code) {
  const expected = process.env.SETUP_CODE || process.env.APP_PASSWORD;
  if (!expected) return !process.env.VERCEL;
  const a = crypto.createHash('sha256').update(String(code || '')).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function redirectWithCookies(res, location, cookies) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', 'Set-Cookie': cookies });
  res.end();
}
const stateCookie = (value, req) => {
  const secure = req.headers['x-forwarded-proto'] === 'https' || process.env.VERCEL ? '; Secure' : '';
  return `${STATE_COOKIE}=${value || ''}; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=${value ? 600 : 0}${secure}`;
};

// Regreso de Google: valida el estado, el dominio y crea o actualiza la cuenta.
// Si la cuenta no existía se crea como miembro; los correos de ADMIN_EMAILS (o la primera
// persona, si aún no hay administradores) quedan como administradores.
async function googleCallback(req, res, q, db) {
  const fail = (msg) => redirectWithCookies(res, `/?login_error=${encodeURIComponent(msg)}`, [stateCookie(null, req)]);
  if (q.get('error')) return fail(q.get('error') === 'access_denied' ? 'Cancelaste el inicio de sesión.' : `Google respondió: ${q.get('error')}`);
  const expected = parseCookies(req.headers.cookie)[STATE_COOKIE];
  if (!expected || expected !== q.get('state')) return fail('La sesión de inicio expiró. Intenta de nuevo.');
  let g;
  try { g = await finishLogin(req, q.get('code')); } catch (err) { return fail(err.message); }
  db.users ||= [];
  let u = db.users.find((x) => x.email === g.email);
  const noAdmins = !db.users.some((x) => x.role === 'admin' && !x.disabled);
  const shouldBeAdmin = adminEmails().includes(g.email) || noAdmins;
  if (!u) {
    u = { id: uid('u'), email: g.email, name: g.name, role: shouldBeAdmin ? 'admin' : 'miembro', memberId: '', sessionVersion: 0, createdAt: serverNow(), provider: 'google' };
    db.users.push(u);
    db.activity = appendActivity(db.activity, [{ id: uid('a'), at: serverNow(), author: g.name, projectId: null, projectName: null, text: `entró por primera vez (${u.role === 'admin' ? 'administrador' : 'miembro'})` }]);
  } else {
    if (u.disabled) return fail('Tu cuenta está desactivada. Habla con un administrador.');
    if (adminEmails().includes(g.email)) u.role = 'admin';
    if (!u.name || u.name === u.email) u.name = g.name;
  }
  u.picture = g.picture;
  u.lastLogin = serverNow();
  await saveDb(db);
  return redirectWithCookies(res, '/', [sessionCookie(createSessionToken(u), req), stateCookie(null, req)]);
}

function sendWithCookie(res, code, body, cookie) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': cookie });
  res.end(JSON.stringify(body));
}

// Rutas /api/auth: consultar sesión, primer administrador, entrar, salir y cambiar contraseña
async function handleAuth(req, res, url) {
  const db = await loadDb();
  const users = db.users || [];
  const google = googleEnabled();
  if (req.method === 'GET') {
    const q = url.searchParams;
    if (google && q.get('action') === 'google') {
      const { url: to, state } = startUrl(req);
      return redirectWithCookies(res, to, [stateCookie(state, req)]);
    }
    if (google && (q.get('code') || q.get('error'))) return googleCallback(req, res, q, db);
    const u = userFromRequest(req, db);
    return send(res, 200, {
      user: publicUser(u), mode: google ? 'google' : 'password', domain: allowedDomain(), storage: storageKind(),
      needsSetup: !google && users.length === 0, setupNeedsCode: Boolean(process.env.SETUP_CODE || process.env.APP_PASSWORD || process.env.VERCEL),
    });
  }
  const body = await readBody(req);
  // Con Google activado, solo se entra con la cuenta de la empresa (sin contraseñas locales)
  if (google && ['setup', 'login', 'password'].includes(body.action)) {
    return send(res, 400, { error: `El acceso es con tu cuenta de Google @${allowedDomain()}.` });
  }
  switch (body.action) {
    case 'setup': {
      if (users.length) return send(res, 409, { error: 'Ya existe un administrador. Inicia sesión.' });
      if (!setupCodeOk(body.code)) { await wait(600); return send(res, 403, { error: 'Código de instalación incorrecto.' }); }
      const email = normEmail(body.email);
      const name = clean(body.name, 60);
      if (!email.includes('@') || !name) return send(res, 400, { error: 'Escribe nombre y correo.' });
      const problem = passwordProblem(body.password);
      if (problem) return send(res, 400, { error: problem });
      const user = { id: uid('u'), email, name, role: 'admin', memberId: db.team.some((m) => m.id === body.memberId) ? body.memberId : '', passwordHash: hashPassword(body.password), sessionVersion: 0, createdAt: serverNow() };
      db.users = [user];
      db.activity = appendActivity(db.activity, [{ id: uid('a'), at: serverNow(), author: name, projectId: null, projectName: null, text: 'creó la cuenta de administrador' }]);
      await saveDb(db);
      return sendWithCookie(res, 200, { user: publicUser(user) }, sessionCookie(createSessionToken(user), req));
    }
    case 'login': {
      const u = users.find((x) => x.email === normEmail(body.email) && !x.disabled);
      if (!u || !verifyPassword(body.password, u.passwordHash)) { await wait(600); return send(res, 401, { error: 'Correo o contraseña incorrectos.' }); }
      return sendWithCookie(res, 200, { user: publicUser(u) }, sessionCookie(createSessionToken(u), req));
    }
    case 'logout':
      return sendWithCookie(res, 200, { ok: true }, sessionCookie(null, req));
    case 'password': {
      const u = userFromRequest(req, db);
      if (!u) return send(res, 401, { error: 'Inicia sesión.', needsLogin: true });
      if (!verifyPassword(body.current, u.passwordHash)) { await wait(600); return send(res, 403, { error: 'La contraseña actual no es correcta.' }); }
      const problem = passwordProblem(body.next);
      if (problem) return send(res, 400, { error: problem });
      u.passwordHash = hashPassword(body.next);
      u.sessionVersion = (u.sessionVersion || 0) + 1; // cierra las demás sesiones
      await saveDb(db);
      return sendWithCookie(res, 200, { ok: true }, sessionCookie(createSessionToken(u), req));
    }
    default:
      return send(res, 400, { error: 'Acción desconocida' });
  }
}

// Rutas /api/users: solo administradores
async function handleUsers(req, res, me, db) {
  if (!isAdmin(me)) return send(res, 403, { error: 'Solo un administrador puede gestionar usuarios.' });
  const users = db.users || [];
  const save = async (text) => {
    db.activity = appendActivity(db.activity, [{ id: uid('a'), at: serverNow(), author: me.name, projectId: null, projectName: null, text }]);
    await saveDb(db);
    return send(res, 200, { users: users.map(publicUser) });
  };
  if (req.method === 'GET') return send(res, 200, { users: users.map(publicUser) });
  const body = await readBody(req);
  const memberOk = (id) => (db.team.some((m) => m.id === id) ? id : '');
  if (req.method === 'POST') {
    const email = normEmail(body.email);
    const name = clean(body.name, 60);
    if (!email.includes('@') || !name) return send(res, 400, { error: 'Escribe nombre y correo.' });
    if (users.some((x) => x.email === email)) return send(res, 409, { error: 'Ya existe un usuario con ese correo.' });
    const google = googleEnabled();
    if (google && !email.endsWith(`@${allowedDomain()}`)) return send(res, 400, { error: `Solo se pueden dar de alta correos @${allowedDomain()}.` });
    if (!google) {
      const problem = passwordProblem(body.password);
      if (problem) return send(res, 400, { error: problem });
    }
    // En modo Google se da de alta "por adelantado": entra con su cuenta y hereda rol y persona
    users.push({ id: uid('u'), email, name, role: body.role === 'admin' ? 'admin' : 'miembro', memberId: memberOk(body.memberId), ...(google ? { provider: 'google' } : { passwordHash: hashPassword(body.password) }), sessionVersion: 0, createdAt: serverNow() });
    db.users = users;
    return save(`creó la cuenta de ${name}`);
  }
  const u = users.find((x) => x.id === body.id);
  if (!u) return send(res, 404, { error: 'Usuario no encontrado.' });
  const admins = users.filter((x) => x.role === 'admin' && !x.disabled);
  if (req.method === 'PUT') {
    if (body.role && body.role !== 'admin' && u.role === 'admin' && admins.length === 1) return send(res, 400, { error: 'Debe quedar al menos un administrador.' });
    if (body.name) u.name = clean(body.name, 60);
    if (body.role) u.role = body.role === 'admin' ? 'admin' : 'miembro';
    if (body.memberId !== undefined) u.memberId = memberOk(body.memberId);
    if (body.disabled !== undefined) {
      if (u.id === me.id) return send(res, 400, { error: 'No puedes desactivar tu propia cuenta.' });
      if (body.disabled && u.role === 'admin' && admins.length === 1) return send(res, 400, { error: 'Debe quedar al menos un administrador.' });
      u.disabled = Boolean(body.disabled);
      u.sessionVersion = (u.sessionVersion || 0) + 1; // cierra su sesión
    }
    if (body.password) {
      const problem = passwordProblem(body.password);
      if (problem) return send(res, 400, { error: problem });
      u.passwordHash = hashPassword(body.password);
      u.sessionVersion = (u.sessionVersion || 0) + 1;
    }
    return save(body.password ? `restableció la contraseña de ${u.name}` : body.disabled !== undefined ? `${u.disabled ? 'desactivó' : 'reactivó'} la cuenta de ${u.name}` : `actualizó la cuenta de ${u.name}`);
  }
  if (req.method === 'DELETE') {
    if (u.id === me.id) return send(res, 400, { error: 'No puedes borrar tu propia cuenta.' });
    if (u.role === 'admin' && admins.length === 1) return send(res, 400, { error: 'Debe quedar al menos un administrador.' });
    db.users = users.filter((x) => x !== u);
    if (db.profilePrefs) delete db.profilePrefs[u.id];
    return save(`eliminó la cuenta de ${u.name}`);
  }
  return send(res, 405, { error: 'Método no permitido' });
}

export async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/auth') return await handleAuth(req, res, url);
    if (url.pathname.startsWith('/api/')) {
      const db = await loadDb();
      const me = userFromRequest(req, db);
      if (!me) return send(res, 401, { error: 'Inicia sesión.', needsLogin: true, needsSetup: !(db.users || []).length });

      if (url.pathname === '/api/users') return await handleUsers(req, res, me, db);

      if (url.pathname === '/api/state' && req.method === 'GET') {
        return send(res, 200, { db: viewFor(db, me), me: publicUser(me), auth: { mode: googleEnabled() ? 'google' : 'password', domain: allowedDomain() }, now: serverNow(), providers: providersInfo(), storage: storageKind() });
      }
      if (url.pathname === '/api/state' && req.method === 'PUT') {
        const body = await readBody(req);
        if (!body.db || !Array.isArray(body.db.projects)) return send(res, 400, { error: 'Formato inválido' });
        // Se aplica solo lo que el rol permite; la actividad la escribe el servidor con el nombre de la sesión
        const after = mergeFromUser(db, body.db, me);
        after.activity = appendActivity(db.activity, diffActivity(db, after, me.name, serverNow()));
        await saveDb(after);
        return send(res, 200, { ok: true, activity: viewFor(after, me).activity });
      }
      if (url.pathname === '/api/chat' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.text && !body.attachments?.length) return send(res, 400, { error: 'Mensaje vacío' });
        try {
          const out = await chat({
            provider: body.provider, model: body.model, apiKey: body.apiKey || undefined,
            history: Array.isArray(body.history) ? body.history : [], text: body.text || 'Analiza los archivos adjuntos.',
            attachments: Array.isArray(body.attachments) ? body.attachments : [], projectId: body.projectId,
            user: me,
          });
          return send(res, 200, out);
        } catch (err) {
          if (err.code !== 'NO_KEY') console.error('[chat]', err.status || '', err.message);
          return send(res, err.code === 'NO_KEY' ? 400 : 502, { error: describeApiError(err, body.provider) });
        }
      }
      return send(res, 404, { error: 'Ruta no encontrada' });
    }
    if (req.method === 'GET') return serveStatic(req, res);
    send(res, 405, { error: 'Método no permitido' });
  } catch (err) {
    console.error(err);
    send(res, err.status || 500, { error: String(err.message || err) });
  }
}

// Los dos SDK exponen las mismas clases de error; se traducen a mensajes claros en español.
function describeApiError(err, provider) {
  const name = provider === 'openai' ? 'OpenAI' : 'Anthropic';
  for (const SDK of [Anthropic, OpenAI]) {
    if (err instanceof SDK.AuthenticationError) return `La API key de ${name} es inválida o fue revocada. Revísala en "Ajustes del agente" o en el .env del servidor.`;
    if (err instanceof SDK.PermissionDeniedError) return `La API key de ${name} no tiene permiso para este modelo. Prueba con otro modelo en "Ajustes del agente".`;
    if (err instanceof SDK.NotFoundError) return `El modelo no existe o tu cuenta de ${name} no tiene acceso a él. Cambia el modelo en "Ajustes del agente".`;
    if (err instanceof SDK.RateLimitError) {
      if (/quota|credit|billing/i.test(err.message)) return `La cuenta de ${name} no tiene saldo o alcanzó su límite de gasto. Agrega créditos en su consola de facturación.`;
      return `Límite de uso de ${name} alcanzado. Intenta de nuevo en un momento.`;
    }
    if (err instanceof SDK.BadRequestError) {
      if (/credit balance|billing/i.test(err.message)) return `La cuenta de ${name} no tiene saldo. Agrega créditos en su consola de facturación.`;
      if (/anthropic-workspace-id/i.test(err.message)) return 'Esta llave de Claude es de usuario (sk-ant-usr-) y no pertenece a un workspace. Pon el ID del workspace en ANTHROPIC_WORKSPACE_ID dentro del .env y reinicia, o crea una llave dentro de un workspace (empieza con sk-ant-api).';
      return `Solicitud rechazada por ${name}: ${err.message}`;
    }
    if (err instanceof SDK.APIConnectionError) return `No hay conexión con ${name}. Revisa tu red o proxy.`;
    if (err instanceof SDK.APIError) return `Error de ${name} (${err.status}): ${err.message}`;
  }
  return String(err?.message || err);
}

// Solo se levanta el servidor HTTP cuando se ejecuta directamente (no al importarlo desde /api)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  http.createServer(handler).listen(PORT, () => {
    console.log(`Agente de Sprints listo en http://localhost:${PORT}`);
    const keys = serverKeys();
    console.log(`API keys del servidor: Claude ${keys.anthropic ? 'sí' : 'no'} · ChatGPT ${keys.openai ? 'sí' : 'no'} (cada usuario también puede usar su propia llave desde el navegador)`);
    console.log(`Datos: ${storageKind()} · acceso con cuentas de usuario`);
  });
}
