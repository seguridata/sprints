# Agente de Sprints

Herramienta local para planificar proyectos por sprints. Le platicas cada proyecto a un agente (o le mandas documentos). El agente puede ser **Claude (Anthropic)** o **ChatGPT (OpenAI)**. Crea las tareas, las estima y calcula cuánto tiempo llevará todo con el horario real del equipo.

## Qué incluye

| Vista | Para qué sirve |
|---|---|
| **Agente (chat)** | Le describes el proyecto, pegas una minuta o adjuntas PDF/TXT/CSV/imagen. El agente crea el proyecto, desglosa tareas (2–16 h, con PERT si hay incertidumbre), dependencias y roles, y te dice la fecha de término, cuántos sprints son y qué riesgos hay. También registra avances ("terminé el login, me tomó 10 h") y simula escenarios sin guardar ("¿y si agregamos una persona?"). |
| **Resumen** | Término estimado, % de avance, sprint actual, capacidad, precisión de estimación, alertas, tabla de sprints (capacidad vs comprometido), gráfica de velocidad y burndown del proyecto completo. |
| **Tareas** | Tabla editable: horas u O/M/P (PERT), responsable, dependencias, estado, horas restantes y reales. Incluye una carga rápida para pegar listas. |
| **Gantt** | Barras por tarea con el horario laboral real (comida, viernes corto, fines de semana y festivos sombreados), sprints, dependencias, línea de "hoy" y línea base. |
| **Tablero** | Kanban (Por hacer, En progreso, En revisión, Hecho) filtrable por sprint y persona; se arrastran las tarjetas. |
| **Burndown** | Sprint burndown con línea ideal (baja solo en horas laborales), real y pronóstico. |
| **Cartera** | Todos los proyectos en una línea de tiempo, su prioridad, y un mapa de carga semanal por persona para ver dónde cabe un proyecto nuevo. |
| **Plantillas** | Proyectos que se repiten (web, integración API, implementación en cliente). Puedes guardar cualquier proyecto como plantilla; usa las horas reales para que la siguiente estimación salga más precisa. |

## Cuentas y permisos

Cada persona entra con **su correo y su contraseña**. Las contraseñas se guardan cifradas (scrypt) y la sesión dura 7 días en una cookie firmada.

**Primer arranque:** la primera persona que abre la app crea la cuenta de **administrador**. En Vercel se pide un **código de instalación** (`SETUP_CODE`, o `APP_PASSWORD` si ya existía), para que nadie más pueda adelantarse.

**Roles**

| | Administrador | Miembro |
|---|---|---|
| Proyectos que ve | Todos | Los que tienen asignada a su persona del Equipo, y los que no tienen personas marcadas (de todo el equipo) |
| Tareas de esos proyectos | Crear, editar, borrar | Crear, editar, borrar |
| Crear, editar o borrar proyectos; línea base; prioridades | Sí | No |
| Equipo, plantillas, calendario, factores de IA | Sí | No |
| Usuarios | Sí | No |
| Agente | Todo lo anterior | Las mismas restricciones (no puede crear proyectos ni ver los ajenos) |

- **Usuarios** (solo administradores): alta de cuentas con contraseña inicial, rol, persona del Equipo ligada, restablecer contraseña y baja.
- **Mi cuenta** (en la barra lateral): cambiar la contraseña (cierra las demás sesiones) y cerrar sesión.
- **Mis tareas:** las tareas de la persona del Equipo ligada a tu cuenta.
- **Actividad:** cada cambio queda firmado con el nombre de la cuenta; lo genera el servidor.
- **Privacidad entre proyectos:** el servidor solo envía los proyectos que puedes ver y rechaza cambios fuera de tu rol. De los proyectos sin acceso solo llega la carga de trabajo, sin nombres ni descripciones, para que las fechas de las personas compartidas salgan correctas.
- **En tu navegador** quedan tu API key propia y tu historial del chat, separados por cuenta.

## Cómo calcula los tiempos

- **Horario:** lunes a jueves 9:00–18:30 con 1 h de comida (14:00–15:00) = 8.5 h. Viernes 9:00–15:00 = 6 h. **Total: 40 h/semana.** Se puede cambiar en *Calendario y configuración*.
- **Festivos:** ya vienen los días de descanso obligatorio de México (LFT) de 2026 a 2028. Puedes agregar vacaciones, puentes o días de la empresa.
- **Desarrollo con IA:** todos los proyectos se hacen con apoyo de IA. Las horas se capturan como las estimaría un equipo tradicional y se multiplican por un factor según el tipo de trabajo (rol o fase). Valores sugeridos:

  | Tipo de trabajo | % del tiempo tradicional |
  |---|---|
  | Desarrollo | 50 % |
  | Diseño, QA | 60 % |
  | Análisis | 70 % |
  | Despliegue, Implementación | 80 % |
  | Gestión, Cierre | 90 % |
  | Inicio (reuniones con el cliente) | 100 % |
  | Otros tipos | 70 % |

  - **Por tarea:** la columna *IA %* permite sobrescribir el factor (por ejemplo 30 % para un CRUD o 100 % para una capacitación).
  - **Resumen:** muestra las horas ahorradas y la fecha en que se terminaría sin IA.
  - **Calibración:** con las horas reales de las tareas terminadas se calcula el *factor real medido* por tipo, en *Calendario y configuración*; úsalo para ajustar los factores.
  - **Activar o desactivar:** hay un interruptor en esa misma pantalla.
- **Factor de enfoque (80 % por defecto):** la parte de la jornada que de verdad se dedica a tareas del proyecto (descuenta juntas, soporte e interrupciones). Una tarea de 8 h la termina una persona al 100 % en 10 h de calendario.
- **Dedicación por persona:** alguien al 50 % tarda el doble de calendario.
- **Prioridad entre proyectos:** las personas se comparten entre proyectos y atienden primero al proyecto de mayor prioridad. Si cambias la prioridad, se recalculan todas las fechas.
- **Planificación:** respeta dependencias y asigna cada tarea sin responsable a quien se desocupe primero (con el rol indicado, si lo tiene). Lo que está pendiente nunca se planifica en el pasado, así que la fecha de término es un **pronóstico vivo**.
- **Sprints:** empiezan en la fecha de inicio del proyecto y duran N semanas. Cada tarea cuenta en el sprint en el que termina (se puede forzar otro sprint).
- **Línea base:** "Fijar línea base" guarda las fechas actuales para medir desviaciones después.

## Instalación

Requiere Node.js 20 o superior.

```bash
npm install
```

Para usar el chat necesitas al menos una API key: de Claude (https://platform.claude.com) o de OpenAI (https://platform.openai.com). Hay dos formas de configurarla y se pueden combinar.

**1. Llave del servidor (compartida).** Copia `.env.example` como `.env` y llena `ANTHROPIC_API_KEY` y/o `OPENAI_API_KEY`:

```bash
cp .env.example .env
```

**2. Llave de cada usuario.** En el chat, el botón **Ajustes** permite elegir el proveedor (Claude o ChatGPT) y el modelo, y escribir una llave propia. Esa llave se guarda solo en el navegador de esa persona.

Arranca el servidor:

```bash
npm start
```

Después abre http://localhost:3210. Sin ninguna llave funciona todo menos el chat.

Para compartirlo con el equipo, córrelo en un equipo o servidor interno y entren desde `http://<ip>:3210`. Los datos se guardan en `data/db.json`. Respáldalo desde *Configuración → Descargar respaldo*.

## Publicar en Vercel (para pruebas)

El proyecto ya está preparado: la interfaz se sirve como sitio estático y `/api/state` y `/api/chat` corren como funciones de Vercel con el mismo código que el servidor local.

**1. Base de datos (obligatoria para no perder datos).** El disco de Vercel se borra en cada reinicio, así que los datos se guardan en Redis:
- En el proyecto de Vercel ve a **Storage → Create Database → Upstash for Redis** (plan gratuito) y conéctala al proyecto.
- Vercel agrega solo las variables `KV_REST_API_URL` y `KV_REST_API_TOKEN` (o `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`).
- Sin Redis la app funciona, pero muestra un aviso: los datos son temporales.

**2. Variables de entorno** (en **Settings → Environment Variables**):

| Variable | Para qué |
|---|---|
| `SESSION_SECRET` | **Obligatoria.** Firma las sesiones. Genera un valor aleatorio largo (ver `.env.example`). |
| `SETUP_CODE` (o `APP_PASSWORD`) | **Obligatoria.** Código para crear la primera cuenta de administrador. |
| `ANTHROPIC_API_KEY` y/o `OPENAI_API_KEY` | Llaves del servidor (opcionales si cada usuario usa la suya). |
| `ANTHROPIC_WORKSPACE_ID` | Solo si la llave de Claude empieza con `sk-ant-usr-`. |
| `APP_TIMEZONE` | Opcional; por defecto `America/Mexico_City` (los servidores de Vercel usan UTC). |

**3. Desplegar** (una de dos):
- **Con la CLI:**
  1. Inicia sesión (se abre el navegador):
     ```bash
     npx vercel login
     ```
  2. Despliega desde la carpeta del proyecto:
     ```bash
     npx vercel deploy
     ```
     Agrega `--prod` para publicar en la URL principal.
- **Con GitHub:** sube el proyecto a un repositorio e impórtalo en vercel.com → *Add New → Project*.

`.vercelignore` evita que se suban `.env` y `data/`. Las llaves solo viven en las variables de entorno de Vercel.

**Límites a considerar:**
- Cada mensaje del chat puede tardar hasta 300 s (configurado en `vercel.json`; requiere *Fluid compute*, que viene activo por defecto).
- El cuerpo de una solicitud no puede pasar de 4.5 MB, así que los PDF adjuntos deben pesar menos de ~3 MB.
- Varias personas editando a la vez pueden sobrescribirse cambios (la base se guarda completa en cada cambio). Para pruebas está bien; para uso diario conviene pasar a una base por registros.

## ¿A quién se le cobra el uso de la API?

- **Cada API key pertenece a una organización** (cuenta) de la consola de Anthropic o de OpenAI. Todo lo que se consume con esa llave se cobra al saldo de esa organización y cuenta para sus límites. No depende de quién esté usando la app.
- **Las suscripciones no cuentan:** claude.ai Pro/Max y ChatGPT Plus/Pro son productos aparte y no incluyen uso de API. La API se paga por tokens, con créditos o facturación en la consola.
- **En esta app:**
  - Si una persona escribe su propia llave en *Ajustes*, sus mensajes se cobran a **su** cuenta.
  - Si la deja vacía, se usa la llave del `.env` y se cobra a la **cuenta dueña del servidor**. Es compartida por todos.
- **Para controlar el gasto con una sola cuenta:** en las dos consolas puedes crear una llave por persona o por proyecto (o workspaces/proyectos con límite de gasto). Así ves el consumo de cada quien.
- **Tokens por respuesta:** el chat muestra los tokens que consumió cada respuesta y el total de la conversación, para que estimes el costo con la tabla de precios de cada proveedor.
- **Seguridad de la llave propia:** se guarda en el navegador y viaja al servidor de esta app en cada mensaje. Si usan la app desde otra computadora por `http://` (sin HTTPS), la llave viaja sin cifrar por la red local. Para uso compartido conviene poner la app detrás de HTTPS o usar solo la llave del servidor.

## Notas técnicas

- `lib/scheduler.js` es el motor del calendario, la planificación, los sprints y el burndown. Se comparte entre servidor y navegador. Pruebas: `npm test`.
- `lib/agent.js` contiene el agente y las mismas herramientas (consultar, crear, actualizar, simular) para los dos proveedores:
  - **Claude:** usa el SDK oficial `@anthropic-ai/sdk`. El modelo predeterminado es `claude-opus-5-5`; en Opus 5.5 se activa el *fallback* del servidor (`fallbacks: "default"`).
  - **ChatGPT:** usa el SDK oficial `openai` (Chat Completions con *function calling*). El modelo predeterminado es `gpt-5.4`.
  - Los modelos predeterminados se cambian con `CLAUDE_MODEL` / `OPENAI_MODEL`, o cada usuario elige el suyo en *Ajustes*.
- El historial del chat se guarda en el navegador de cada persona, separado por proveedor. El botón "Limpiar" empieza una conversación nueva.
- Los documentos Word (.docx) no se leen directamente: guárdalos como PDF o pega el texto.
