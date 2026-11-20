// Paso de build en Vercel: publica el motor de cálculo junto a la interfaz estática.
// En local no hace falta: el servidor sirve /lib/scheduler.js directamente.
import fs from 'node:fs';
fs.mkdirSync('public/lib', { recursive: true });
fs.copyFileSync('lib/scheduler.js', 'public/lib/scheduler.js');
console.log('public/lib/scheduler.js listo');
