// Inicio de sesión con Google (OpenID Connect, flujo de código de autorización).
// Solo se aceptan cuentas del dominio de Google Workspace de la empresa (ALLOWED_DOMAIN).
import crypto from 'node:crypto';

export const googleEnabled = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
export const allowedDomain = () => (process.env.ALLOWED_DOMAIN || 'seguridata.com').toLowerCase();
export const STATE_COOKIE = 'sprints_oauth_state';

// URL a la que Google regresa. Debe registrarse tal cual en Google Cloud (URIs de redireccionamiento).
export function redirectUri(req) {
  if (process.env.APP_URL) return `${process.env.APP_URL.replace(/\/$/, '')}/api/auth`;
  const proto = req.headers['x-forwarded-proto'] || (process.env.VERCEL ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/api/auth`;
}

export function startUrl(req) {
  const state = crypto.randomBytes(24).toString('base64url');
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    hd: allowedDomain(), // sugerencia para Google; el dominio se valida de verdad al regresar
    prompt: 'select_account',
  });
  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, state };
}

// Cambia el código por el id_token y valida que la cuenta sea del dominio permitido.
// El id_token llega directo del endpoint de Google por TLS autenticado con el client_secret,
// por eso basta con validar sus campos (OpenID Connect Core §3.1.3.7).
export async function finishLogin(req, code) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(req),
      grant_type: 'authorization_code',
    }),
  });
  const tok = await r.json().catch(() => ({}));
  if (!r.ok || !tok.id_token) throw new Error(`Google rechazó el inicio de sesión (${tok.error || r.status}).`);
  const claims = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString('utf8'));
  const email = String(claims.email || '').toLowerCase();
  const domain = allowedDomain();
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)) throw new Error('Emisor del token no válido.');
  if (claims.aud !== process.env.GOOGLE_CLIENT_ID) throw new Error('El token no es para esta aplicación.');
  if (!claims.exp || claims.exp * 1000 < Date.now()) throw new Error('El token de Google expiró. Intenta de nuevo.');
  if (!claims.email_verified) throw new Error('Tu correo de Google no está verificado.');
  if (claims.hd !== domain || !email.endsWith(`@${domain}`)) throw new Error(`Solo se permiten cuentas @${domain}.`);
  return { email, name: claims.name || email.split('@')[0], picture: claims.picture || '' };
}

export const adminEmails = () => String(process.env.ADMIN_EMAILS || '').toLowerCase().split(/[\s,;]+/).filter(Boolean);
