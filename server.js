'use strict';
// Control de ingreso · La Ruta Navideña
// Servidor para Railway: sirve la página y la API, guarda todo en PostgreSQL.
//
// Variables de entorno:
//   DATABASE_URL     conexión a PostgreSQL (obligatoria)
//   ADMIN_USUARIO    usuario del primer administrador (por defecto "admin")
//   ADMIN_PASSWORD   contraseña del primer administrador (si falta, se usa CLAVE_ADMIN)
//   EVENTO_INICIO    primera noche del evento (por defecto 2026-11-26)
//   EVENTO_FIN       última noche del evento (por defecto 2027-01-11)
//   PORT             lo pone Railway
// El primer administrador solo se crea cuando no existe ningún usuario.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool, types } = require('pg');
const ExcelJS = require('exceljs');

types.setTypeParser(1082, v => v);               // date -> 'YYYY-MM-DD'
types.setTypeParser(20, v => parseInt(v, 10));   // bigint -> number

const env = process.env;
const PORT = Number(env.PORT) || 3000;
const TZ = 'America/Bogota';
const EVENTO_INICIO = /^\d{4}-\d{2}-\d{2}$/.test(env.EVENTO_INICIO || '') ? env.EVENTO_INICIO : '2026-11-26';
const EVENTO_FIN = /^\d{4}-\d{2}-\d{2}$/.test(env.EVENTO_FIN || '') ? env.EVENTO_FIN : '2027-01-11';
const SESION_DIAS = 60;        // una sesión sin uso durante 60 días se cierra sola
const JORNADA_SQL = `((now() at time zone '${TZ}') - interval '6 hours')::date`;

if (!env.DATABASE_URL) { console.error('Falta la variable DATABASE_URL'); process.exit(1); }
const local = /localhost|127\.0\.0\.1|\.railway\.internal/.test(env.DATABASE_URL) || env.PGSSL === 'off';
const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: local ? false : { rejectUnauthorized: false },
  max: Number(env.PG_POOL_MAX) || 15,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});
pool.on('error', e => console.error('[pg] conexión inactiva con error:', e.message));

// ---------------------------------------------------------------------------
// Base de datos
// ---------------------------------------------------------------------------
async function migrar() {
  const c = await pool.connect();
  try {
    await c.query('select pg_advisory_lock(727274001)');
    await c.query(`
      create table if not exists usuarios (
        id             serial primary key,
        usuario        text not null unique,
        nombre         text not null,
        rol            text not null check (rol in ('admin', 'portero')),
        pass_hash      text not null,
        activo         boolean not null default true,
        creado         timestamptz not null default now(),
        ultimo_acceso  timestamptz
      );
      create table if not exists sesiones (
        token_hash  text primary key,
        usuario_id  int not null references usuarios(id) on delete cascade,
        creado      timestamptz not null default now(),
        ultimo_uso  timestamptz not null default now()
      );
      create index if not exists sesiones_usuario_idx on sesiones (usuario_id);
      create table if not exists ingresos (
        num          text primary key,
        nombre       text not null,
        ts           timestamptz not null default now(),
        jornada      date not null,
        puesto       text not null default '',
        dispositivo  text not null default ''
      );
      alter table ingresos add column if not exists usuario_id int references usuarios(id);
      alter table ingresos add column if not exists solicitud text;
      create index if not exists ingresos_jornada_idx on ingresos (jornada, ts desc);
      create index if not exists ingresos_usuario_idx on ingresos (usuario_id);
      create table if not exists anulaciones (
        id            serial primary key,
        num           text not null,
        nombre        text not null,
        ts_ingreso    timestamptz not null,
        jornada       date not null,
        registrado_por text not null default '',
        anulado_por   text not null,
        anulado_en    timestamptz not null default now()
      );
    `);
    const { rows } = await c.query('select count(*)::int as n from usuarios');
    if (rows[0].n === 0) {
      const usuario = normUsuario(env.ADMIN_USUARIO || 'admin');
      const pass = env.ADMIN_PASSWORD || env.CLAVE_ADMIN;
      if (!pass || pass.length < 6 || !usuarioValido(usuario)) {
        console.warn('No hay usuarios. Define ADMIN_PASSWORD (6+ caracteres) para crear el primer administrador.');
      } else {
        await c.query(`insert into usuarios (usuario, nombre, rol, pass_hash) values ($1, 'Administrador', 'admin', $2)`,
          [usuario, await hashPass(pass)]);
        console.log(`Primer administrador creado con el usuario "${usuario}".`);
      }
    }
  } finally {
    await c.query('select pg_advisory_unlock(727274001)').catch(() => {});
    c.release();
  }
}

// ---------------------------------------------------------------------------
// Contraseñas, sesiones y límites
// ---------------------------------------------------------------------------
const scrypt = (pw, salt) => new Promise((res, rej) =>
  crypto.scrypt(String(pw), salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => e ? rej(e) : res(k)));
async function hashPass(pw) {
  const salt = crypto.randomBytes(16);
  return `s1$${salt.toString('base64')}$${(await scrypt(pw, salt)).toString('base64')}`;
}
async function checkPass(pw, stored) {
  const [v, s, h] = String(stored).split('$');
  if (v !== 's1' || !s || !h) return false;
  const k = await scrypt(pw, Buffer.from(s, 'base64'));
  const hb = Buffer.from(h, 'base64');
  return hb.length === k.length && crypto.timingSafeEqual(hb, k);
}
let HASH_FALSO = null; // para que un usuario inexistente tarde lo mismo que uno real

const normUsuario = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/\s+/g, '.');
const usuarioValido = u => /^[a-z0-9][a-z0-9._-]{1,29}$/.test(u);
const limpiaNombre = s => String(s || '').trim().replace(/\s+/g, ' ').slice(0, 80);
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

const fallos = new Map(); // clave -> {n, t}
const VENTANA = 10 * 60 * 1000;
function bloqueado(k, max) { const f = fallos.get(k); return !!f && f.n >= max && Date.now() - f.t < VENTANA; }
function sumarFallo(k) { const f = fallos.get(k); if (!f || Date.now() - f.t > VENTANA) fallos.set(k, { n: 1, t: Date.now() }); else f.n++; }
setInterval(() => { const now = Date.now(); for (const [k, f] of fallos) if (now - f.t > VENTANA) fallos.delete(k); }, 60000).unref();

async function autenticar(req) {
  const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const th = sha256(m[1]);
  const { rows } = await pool.query(
    `select s.token_hash, s.ultimo_uso, u.id, u.usuario, u.nombre, u.rol
       from sesiones s join usuarios u on u.id = s.usuario_id
      where s.token_hash = $1 and u.activo and s.ultimo_uso > now() - interval '${SESION_DIAS} days'`, [th]);
  const u = rows[0];
  if (!u) return null;
  if (Date.now() - new Date(u.ultimo_uso).getTime() > 5 * 60 * 1000) {
    pool.query(`update sesiones set ultimo_uso = now() where token_hash = $1`, [th]).catch(() => {});
    pool.query(`update usuarios set ultimo_acceso = now() where id = $1`, [u.id]).catch(() => {});
  }
  return u;
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
class ApiError extends Error { constructor(code, status = 400) { super(code); this.code = code; this.status = status; } }
const numValido = n => typeof n === 'string' && /^[1-9][0-9]{0,6}$/.test(n);
const normNum = n => String(n ?? '').replace(/\D/g, '').replace(/^0+/, '');
const fechaValida = f => /^\d{4}-\d{2}-\d{2}$/.test(String(f || ''));
const COLS = 'num, nombre, ts, jornada, puesto';
const fila = r => r && ({ num: r.num, nombre: r.nombre, ts: r.ts, jornada: r.jornada, por: r.puesto });
const pubUsuario = u => ({ id: u.id, usuario: u.usuario, nombre: u.nombre, rol: u.rol });

function diasEvento() {
  const out = [];
  for (let t = Date.parse(EVENTO_INICIO + 'T00:00:00Z'); t <= Date.parse(EVENTO_FIN + 'T00:00:00Z'); t += 864e5)
    out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
const horaFmt = new Intl.DateTimeFormat('es-CO', { timeZone: TZ, hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
const hora = ts => horaFmt.format(new Date(ts)).replace(/\s/g, ' ');
const WDL = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const fechaLarga = f => { const d = new Date(f + 'T00:00:00Z'); return `${WDL[d.getUTCDay()]} ${d.getUTCDate()} de ${MES[d.getUTCMonth()]} de ${d.getUTCFullYear()}`; };
const pad4 = n => String(n).padStart(4, '0');

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------
const AZUL = 'FF1B2456', CREMA = 'FFF7F2E5', DORADO = 'FFF4B740';
function hojaIngresos(wb, nombreHoja, titulo, rows) {
  const ws = wb.addWorksheet(nombreHoja, { views: [{ state: 'frozen', ySplit: 3 }] });
  ws.columns = [{ width: 7 }, { width: 13 }, { width: 36 }, { width: 13 }, { width: 18 }, { width: 28 }];
  ws.mergeCells('A1:F1');
  ws.getCell('A1').value = titulo;
  ws.getCell('A1').font = { bold: true, size: 14, color: { argb: AZUL } };
  ws.mergeCells('A2:F2');
  ws.getCell('A2').value = `${rows.length} ingreso${rows.length === 1 ? '' : 's'} · generado el ${new Intl.DateTimeFormat('es-CO', { timeZone: TZ, dateStyle: 'long', timeStyle: 'short' }).format(new Date())}`;
  ws.getCell('A2').font = { italic: true, size: 10, color: { argb: 'FF555555' } };
  const head = ws.getRow(3);
  head.values = ['#', 'N.° boleta', 'Nombre', 'Jornada', 'Hora de ingreso', 'Registrado por'];
  head.eachCell(c => { c.font = { bold: true, color: { argb: CREMA } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AZUL } }; c.alignment = { vertical: 'middle' }; });
  head.height = 20;
  rows.forEach((r, i) => {
    const row = ws.addRow([i + 1, pad4(r.num), r.nombre, r.jornada, hora(r.ts), r.puesto]);
    if (i % 2 === 1) row.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CREMA } }; });
  });
  ws.autoFilter = { from: 'A3', to: `F${Math.max(3, rows.length + 3)}` };
  return ws;
}
async function excelDia(fecha) {
  const { rows } = await pool.query(`select ${COLS} from ingresos where jornada = $1 order by ts`, [fecha]);
  const wb = new ExcelJS.Workbook(); wb.creator = 'Control Ruta Navideña';
  hojaIngresos(wb, 'Ingresos ' + fecha, `La Ruta Navideña · ${fechaLarga(fecha)}`, rows);
  return wb.xlsx.writeBuffer();
}
async function excelGeneral() {
  const { rows } = await pool.query(`select ${COLS} from ingresos order by ts`);
  const porDia = {}; for (const r of rows) porDia[r.jornada] = (porDia[r.jornada] || 0) + 1;
  const dias = diasEvento();
  for (const f of Object.keys(porDia)) if (!dias.includes(f)) dias.push(f);
  dias.sort();
  const wb = new ExcelJS.Workbook(); wb.creator = 'Control Ruta Navideña';
  const ws = wb.addWorksheet('Resumen por jornada', { views: [{ state: 'frozen', ySplit: 3 }] });
  ws.columns = [{ width: 14 }, { width: 34 }, { width: 12 }];
  ws.mergeCells('A1:C1'); ws.getCell('A1').value = 'La Ruta Navideña · Ingresos por jornada';
  ws.getCell('A1').font = { bold: true, size: 14, color: { argb: AZUL } };
  ws.mergeCells('A2:C2'); ws.getCell('A2').value = `Total del evento: ${rows.length} ingresos`;
  ws.getCell('A2').font = { italic: true, size: 10, color: { argb: 'FF555555' } };
  const head = ws.getRow(3); head.values = ['Jornada', 'Día', 'Ingresos'];
  head.eachCell(c => { c.font = { bold: true, color: { argb: CREMA } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AZUL } }; });
  for (const f of dias) ws.addRow([f, fechaLarga(f), porDia[f] || 0]);
  const tot = ws.addRow(['TOTAL', '', rows.length]);
  tot.eachCell(c => { c.font = { bold: true }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: DORADO } }; });
  hojaIngresos(wb, 'Todos los ingresos', 'La Ruta Navideña · Todos los ingresos', rows);
  return wb.xlsx.writeBuffer();
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
const R = {}; // nombre -> { auth: 'no' | 'si' | 'admin', fn(body, usuario, ctx) }

R.login = { auth: 'no', async fn(b, _u, ctx) {
  const usuario = normUsuario(b.usuario), pass = String(b.password || '');
  const kIp = 'ip:' + ctx.ip, kUs = 'us:' + usuario + '|' + ctx.ip;
  if (bloqueado(kIp, 40) || bloqueado(kUs, 8)) throw new ApiError('demasiados_intentos', 429);
  const { rows } = await pool.query(`select * from usuarios where usuario = $1`, [usuario]);
  const u = rows[0];
  const ok = await checkPass(pass, u ? u.pass_hash : HASH_FALSO);
  if (!u || !ok || !u.activo) { sumarFallo(kIp); sumarFallo(kUs); throw new ApiError('credenciales', 401); }
  fallos.delete(kUs);
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query(`insert into sesiones (token_hash, usuario_id) values ($1, $2)`, [sha256(token), u.id]);
  await pool.query(`update usuarios set ultimo_acceso = now() where id = $1`, [u.id]);
  pool.query(`delete from sesiones where ultimo_uso < now() - interval '${SESION_DIAS} days'`).catch(() => {});
  return { token, usuario: pubUsuario(u), evento: { inicio: EVENTO_INICIO, fin: EVENTO_FIN } };
} };

R.logout = { auth: 'si', async fn(b, u) {
  await pool.query(`delete from sesiones where token_hash = $1`, [u.token_hash]);
  return { ok: true };
} };

R.yo = { auth: 'si', async fn(b, u) {
  return { usuario: pubUsuario(u), evento: { inicio: EVENTO_INICIO, fin: EVENTO_FIN } };
} };

R.estado = { auth: 'si', async fn(b, u) {
  const { rows } = await pool.query(`
    with h as (select ${JORNADA_SQL} as hoy)
    select h.hoy,
           (select count(*)::int from ingresos where jornada = h.hoy) as total_hoy,
           (select coalesce(json_agg(x order by x.ts desc), '[]'::json)
              from (select ${COLS} from ingresos where jornada = h.hoy order by ts desc limit 15) x) as recientes
      from h`);
  const out = { hoy: rows[0].hoy, totalHoy: rows[0].total_hoy, recientes: rows[0].recientes.map(fila), servidor: new Date().toISOString() };
  if (u.rol === 'admin') {
    const c = await pool.query(`select jornada, count(*)::int as total from ingresos group by jornada`);
    out.conteo = Object.fromEntries(c.rows.map(r => [r.jornada, r.total]));
  }
  return out;
} };

R.consultar = { auth: 'si', async fn(b) {
  const n = normNum(b.num);
  if (!numValido(n)) throw new ApiError('numero_invalido');
  const { rows } = await pool.query(`select ${COLS} from ingresos where num = $1`, [n]);
  return rows[0] ? { estado: 'usada', ...fila(rows[0]) } : { estado: 'libre', num: n };
} };

// Atómico e idempotente: la misma boleta solo entra una vez; si el celular
// reintenta la misma solicitud (porque se cortó la señal) no se duplica.
R.registrar = { auth: 'si', async fn(b, u) {
  const n = normNum(b.num);
  if (!numValido(n)) throw new ApiError('numero_invalido');
  const nombre = limpiaNombre(b.nombre).slice(0, 120);
  if (!nombre) throw new ApiError('nombre_vacio');
  const sol = /^[A-Za-z0-9_-]{8,64}$/.test(String(b.solicitud || '')) ? b.solicitud : null;
  const ins = await pool.query(
    `insert into ingresos (num, nombre, jornada, puesto, usuario_id, solicitud)
     values ($1, $2, ${JORNADA_SQL}, $3, $4, $5)
     on conflict (num) do nothing
     returning ${COLS}`, [n, nombre, u.nombre, u.id, sol]);
  if (ins.rows[0]) return { estado: 'registrada', ...fila(ins.rows[0]) };
  const { rows } = await pool.query(`select ${COLS}, usuario_id, solicitud from ingresos where num = $1`, [n]);
  const r = rows[0];
  if (!r) throw new ApiError('reintentar', 409); // se anuló justo en ese instante
  if (sol && r.solicitud === sol && r.usuario_id === u.id) return { estado: 'registrada', ...fila(r) };
  return { estado: 'usada', ...fila(r) };
} };

R.jornada = { auth: 'admin', async fn(b) {
  if (!fechaValida(b.fecha)) throw new ApiError('fecha_invalida');
  const { rows } = await pool.query(`select ${COLS} from ingresos where jornada = $1 order by ts desc`, [b.fecha]);
  return rows.map(fila);
} };

R.anular = { auth: 'admin', async fn(b, u) {
  const n = normNum(b.num);
  if (!numValido(n)) throw new ApiError('numero_invalido');
  const { rows } = await pool.query(`
    with d as (delete from ingresos where num = $1 returning *)
    insert into anulaciones (num, nombre, ts_ingreso, jornada, registrado_por, anulado_por)
    select num, nombre, ts, jornada, puesto, $2 from d
    returning num`, [n, u.nombre]);
  return { estado: rows.length ? 'anulada' : 'no_existia', num: n };
} };

R.usuarios = { auth: 'admin', async fn() {
  const { rows } = await pool.query(`
    select u.id, u.usuario, u.nombre, u.rol, u.activo, u.creado, u.ultimo_acceso,
           (select count(*)::int from ingresos i where i.usuario_id = u.id) as ingresos
      from usuarios u
     order by u.activo desc, case u.rol when 'admin' then 0 else 1 end, lower(u.nombre)`);
  return rows;
} };

function validarClave(p) { if (String(p || '').length < 6) throw new ApiError('clave_corta'); if (String(p).length > 100) throw new ApiError('clave_larga'); }

R.crear_usuario = { auth: 'admin', async fn(b) {
  const nombre = limpiaNombre(b.nombre); if (!nombre) throw new ApiError('nombre_vacio');
  const usuario = normUsuario(b.usuario); if (!usuarioValido(usuario)) throw new ApiError('usuario_invalido');
  const rol = b.rol === 'admin' ? 'admin' : 'portero';
  validarClave(b.password);
  try {
    const { rows } = await pool.query(
      `insert into usuarios (usuario, nombre, rol, pass_hash) values ($1, $2, $3, $4) returning id, usuario, nombre, rol`,
      [usuario, nombre, rol, await hashPass(b.password)]);
    return rows[0];
  } catch (e) { if (e.code === '23505') throw new ApiError('usuario_existe', 409); throw e; }
} };

R.editar_usuario = { auth: 'admin', async fn(b, u) {
  const id = Number(b.id); if (!Number.isInteger(id)) throw new ApiError('no_existe', 404);
  const cambios = {};
  if (b.nombre !== undefined) { cambios.nombre = limpiaNombre(b.nombre); if (!cambios.nombre) throw new ApiError('nombre_vacio'); }
  if (b.usuario !== undefined) { cambios.usuario = normUsuario(b.usuario); if (!usuarioValido(cambios.usuario)) throw new ApiError('usuario_invalido'); }
  if (b.rol !== undefined) cambios.rol = b.rol === 'admin' ? 'admin' : 'portero';
  if (b.activo !== undefined) cambios.activo = !!b.activo;
  if (b.password) { validarClave(b.password); cambios.pass_hash = await hashPass(b.password); }

  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`select id from usuarios where rol = 'admin' and activo for update`);
    const cur = (await c.query(`select * from usuarios where id = $1 for update`, [id])).rows[0];
    if (!cur) throw new ApiError('no_existe', 404);
    const rol = cambios.rol ?? cur.rol, activo = cambios.activo ?? cur.activo;
    if (id === u.id && (rol !== 'admin' || !activo)) throw new ApiError('propio');
    if (cur.rol === 'admin' && cur.activo && (rol !== 'admin' || !activo)) {
      const n = (await c.query(`select count(*)::int as n from usuarios where rol = 'admin' and activo`)).rows[0].n;
      if (n <= 1) throw new ApiError('ultimo_admin');
    }
    const campos = Object.keys(cambios);
    if (campos.length) {
      await c.query(`update usuarios set ${campos.map((k, i) => `${k} = $${i + 2}`).join(', ')} where id = $1`,
        [id, ...campos.map(k => cambios[k])]);
    }
    // Contraseña, rol o desactivación: se cierran sus sesiones (menos la tuya actual).
    if (cambios.pass_hash || (cambios.rol && cambios.rol !== cur.rol) || (cambios.activo === false)) {
      await c.query(`delete from sesiones where usuario_id = $1 and token_hash <> $2`, [id, u.token_hash]);
    }
    await c.query('commit');
  } catch (e) {
    await c.query('rollback').catch(() => {});
    if (e.code === '23505') throw new ApiError('usuario_existe', 409);
    throw e;
  } finally { c.release(); }
  return { ok: true };
} };

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const PUBLIC = path.join(__dirname, 'public');
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const SEGURIDAD = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' };

function enviar(res, status, data) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEGURIDAD });
  res.end(JSON.stringify(data));
}
function leerBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', ch => { data += ch; if (data.length > 20000) { reject(new ApiError('cuerpo_muy_grande', 413)); req.destroy(); } });
    req.on('end', () => { try { const o = data ? JSON.parse(data) : {}; resolve(o && typeof o === 'object' ? o : {}); } catch (e) { reject(new ApiError('json_invalido')); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  let url; try { url = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); return res.end(); }
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  if (url.pathname === '/health') {
    try { await pool.query('select 1'); return enviar(res, 200, { ok: true }); }
    catch (e) { return enviar(res, 503, { ok: false }); }
  }

  // Excel (descarga binaria)
  if (url.pathname === '/api/excel') {
    try {
      if (req.method !== 'POST') throw new ApiError('no_existe', 404);
      const b = await leerBody(req);
      const u = await autenticar(req);
      if (!u) throw new ApiError('sesion', 401);
      if (u.rol !== 'admin') throw new ApiError('solo_admin', 403);
      let buf, nombre;
      if (b.fecha) { if (!fechaValida(b.fecha)) throw new ApiError('fecha_invalida'); buf = await excelDia(b.fecha); nombre = `Ruta-Navidena-ingresos-${b.fecha}.xlsx`; }
      else { buf = await excelGeneral(); nombre = `Ruta-Navidena-ingresos-general.xlsx`; }
      res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${nombre}"`, 'Cache-Control': 'no-store', ...SEGURIDAD });
      return res.end(Buffer.from(buf));
    } catch (e) {
      if (e instanceof ApiError) return enviar(res, e.status, { error: e.code });
      console.error('excel', e); return enviar(res, 500, { error: 'error_servidor' });
    }
  }

  if (url.pathname.startsWith('/api/')) {
    const nombre = url.pathname.slice(5);
    const ruta = Object.hasOwn(R, nombre) ? R[nombre] : null;
    try {
      if (!ruta || req.method !== 'POST') throw new ApiError('no_existe', 404);
      const b = await leerBody(req);
      let u = null;
      if (ruta.auth !== 'no') {
        u = await autenticar(req);
        if (!u) throw new ApiError('sesion', 401);
        if (ruta.auth === 'admin' && u.rol !== 'admin') throw new ApiError('solo_admin', 403);
      }
      return enviar(res, 200, await ruta.fn(b, u, { ip }));
    } catch (e) {
      if (e instanceof ApiError) return enviar(res, e.status, { error: e.code });
      console.error(`[api ${nombre}]`, e);
      return enviar(res, 500, { error: 'error_servidor' });
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let rel;
  try { rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, ''); }
  catch (e) { res.writeHead(400); return res.end(); }
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('No encontrado'); }
    res.writeHead(200, { 'Content-Type': TIPOS[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SEGURIDAD });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 120000;

async function arrancar() {
  HASH_FALSO = await hashPass(crypto.randomBytes(12).toString('hex'));
  for (let i = 1; ; i++) {
    try { await migrar(); break; }
    catch (e) {
      console.error(`No se pudo preparar la base de datos (intento ${i}):`, e.message);
      if (i >= 30) process.exit(1);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  server.listen(PORT, () => console.log(`Control Ruta Navideña escuchando en el puerto ${PORT}`));
}

function apagar(sig) {
  console.log(`${sig} recibido, cerrando…`);
  server.close(() => pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGTERM', () => apagar('SIGTERM'));
process.on('SIGINT', () => apagar('SIGINT'));
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));

if (require.main === module) arrancar();
module.exports = { server, pool, migrar };
