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

// Contraseña de acceso opcional (APP_PASSWORD). Obligatoria en la práctica si la app es pública:
// sin ella cualquiera con la URL podría ver los proyectos y gastar las API keys del servidor.
function authorized(req) {
  const expected = process.env.APP_PASSWORD;
  if (!expected) return true;
  const given = String(req.headers['x-app-password'] || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// Perfil ligero: el navegador indica quién está trabajando (no es autenticación, solo autoría)
const authorFrom = (req) => {
  try { return decodeURIComponent(String(req.headers['x-user-name'] || '')).trim().slice(0, 60) || 'Alguien'; } catch { return 'Alguien'; }
};

export async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/') && !authorized(req)) {
      return send(res, 401, { error: 'Contraseña incorrecta', needsPassword: true });
    }
    if (url.pathname === '/api/state' && req.method === 'GET') {
      return send(res, 200, { db: await loadDb(), now: serverNow(), providers: providersInfo(), storage: storageKind() });
    }
    if (url.pathname === '/api/state' && req.method === 'PUT') {
      const body = await readBody(req);
      if (!body.db || !Array.isArray(body.db.projects)) return send(res, 400, { error: 'Formato inválido' });
      // El historial de actividad lo escribe solo el servidor, a partir de las diferencias
      const before = await loadDb();
      const after = body.db;
      after.activity = appendActivity(before.activity, diffActivity(before, after, authorFrom(req), serverNow()));
      await saveDb(after);
      return send(res, 200, { ok: true, activity: after.activity });
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.text && !body.attachments?.length) return send(res, 400, { error: 'Mensaje vacío' });
      try {
        const out = await chat({
          provider: body.provider, model: body.model, apiKey: body.apiKey || undefined,
          history: Array.isArray(body.history) ? body.history : [], text: body.text || 'Analiza los archivos adjuntos.',
          attachments: Array.isArray(body.attachments) ? body.attachments : [], projectId: body.projectId,
          author: `${authorFrom(req)} (vía agente)`,
        });
        return send(res, 200, out);
      } catch (err) {
        if (err.code !== 'NO_KEY') console.error('[chat]', err.status || '', err.message);
        return send(res, err.code === 'NO_KEY' ? 400 : 502, { error: describeApiError(err, body.provider) });
      }
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
    console.log(`Datos: ${storageKind()}${process.env.APP_PASSWORD ? ' · con contraseña de acceso' : ''}`);
  });
}
