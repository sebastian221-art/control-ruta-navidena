// Control de ingreso · La Ruta Navideña
// Servidor para Railway: sirve la página y la API, y guarda todo en PostgreSQL.
// Variables de entorno: DATABASE_URL, CLAVE_PORTEROS, CLAVE_ADMIN, PORT (Railway la pone sola).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool, types } = require('pg');

types.setTypeParser(1082, v => v); // columnas date como texto 'YYYY-MM-DD'

const { DATABASE_URL, CLAVE_PORTEROS, CLAVE_ADMIN } = process.env;
const PORT = process.env.PORT || 3000;
if (!DATABASE_URL) { console.error('Falta la variable DATABASE_URL'); process.exit(1); }
if (!CLAVE_PORTEROS || !CLAVE_ADMIN) { console.error('Faltan las variables CLAVE_PORTEROS y CLAVE_ADMIN'); process.exit(1); }

const local = /localhost|127\.0\.0\.1|railway\.internal|host=\//.test(DATABASE_URL) || process.env.PGSSL === 'off';
const pool = new Pool({ connectionString: DATABASE_URL, ssl: local ? false : { rejectUnauthorized: false }, max: 10 });

const JORNADA = `((now() at time zone 'America/Bogota') - interval '6 hours')::date`;
const COLS = 'num, nombre, ts, jornada, puesto';

async function migrar() {
  await pool.query(`
    create table if not exists ingresos (
      num          text primary key,
      nombre       text not null,
      ts           timestamptz not null default now(),
      jornada      date not null,
      puesto       text not null default '',
      dispositivo  text not null default ''
    );
    create index if not exists ingresos_jornada_idx on ingresos (jornada, ts desc);
  `);
}

// ---------- Claves ----------
const igual = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
const rolDe = clave => !clave ? null : igual(clave, CLAVE_ADMIN) ? 'admin' : igual(clave, CLAVE_PORTEROS) ? 'portero' : null;

// Freno simple a quien prueba claves al azar: 10 fallos por IP cada 10 minutos.
const fallos = new Map();
function bloqueado(ip) { const f = fallos.get(ip); return f && f.n >= 10 && Date.now() - f.t < 600000; }
function fallo(ip) { const f = fallos.get(ip); if (!f || Date.now() - f.t > 600000) fallos.set(ip, { n: 1, t: Date.now() }); else f.n++; }

class ApiError extends Error { constructor(code, status = 400) { super(code); this.code = code; this.status = status; } }
const fila = r => r && ({ num: r.num, nombre: r.nombre, ts: r.ts, jornada: r.jornada, puesto: r.puesto });
const numValido = n => typeof n === 'string' && /^[1-9][0-9]{0,6}$/.test(n);

// ---------- API ----------
const api = {
  async verificar_clave(b, rol) { return rol; },

  async consultar_boleta(b) {
    if (!numValido(b.p_num)) throw new ApiError('numero_invalido');
    const { rows } = await pool.query(`select ${COLS} from ingresos where num = $1`, [b.p_num]);
    return rows[0] ? { estado: 'usada', ...fila(rows[0]) } : { estado: 'libre', num: b.p_num };
  },

  // Atómico: si dos puertas mandan la misma boleta, solo una entra.
  async registrar_ingreso(b) {
    if (!numValido(b.p_num)) throw new ApiError('numero_invalido');
    const nombre = String(b.p_nombre || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!nombre) throw new ApiError('nombre_vacio');
    const ins = await pool.query(
      `insert into ingresos (num, nombre, jornada, puesto, dispositivo)
       values ($1, $2, ${JORNADA}, $3, $4)
       on conflict (num) do nothing
       returning ${COLS}`,
      [b.p_num, nombre, String(b.p_puesto || '').slice(0, 60), String(b.p_dispositivo || '').slice(0, 40)]);
    if (ins.rows[0]) return { estado: 'registrada', ...fila(ins.rows[0]) };
    const { rows } = await pool.query(`select ${COLS} from ingresos where num = $1`, [b.p_num]);
    return { estado: 'usada', ...fila(rows[0]) };
  },

  async conteo_jornadas() {
    const { rows } = await pool.query(`select jornada, count(*)::int as total from ingresos group by jornada order by jornada`);
    return rows;
  },

  async listar_jornada(b) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.p_fecha))) throw new ApiError('fecha_invalida');
    const lim = Number.isInteger(b.p_limite) && b.p_limite > 0 ? Math.min(b.p_limite, 100000) : null;
    const { rows } = await pool.query(
      `select ${COLS} from ingresos where jornada = $1 order by ts desc ${lim ? 'limit ' + lim : ''}`, [b.p_fecha]);
    return rows.map(fila);
  },

  async listar_todo() {
    const { rows } = await pool.query(`select ${COLS} from ingresos order by ts`);
    return rows.map(fila);
  },

  async anular_ingreso(b, rol) {
    if (rol !== 'admin') throw new ApiError('solo_admin', 403);
    if (!numValido(b.p_num)) throw new ApiError('numero_invalido');
    const r = await pool.query(`delete from ingresos where num = $1`, [b.p_num]);
    return { estado: r.rowCount ? 'anulada' : 'no_existia', num: b.p_num };
  }
};

// ---------- HTTP ----------
const PUBLIC = path.join(__dirname, 'public');
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function enviar(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function leerBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e5) { reject(new ApiError('cuerpo_muy_grande', 413)); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new ApiError('json_invalido')); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  if (url.pathname === '/health') return enviar(res, 200, { ok: true });

  if (url.pathname.startsWith('/api/')) {
    const fn = url.pathname.slice(5);
    if (req.method !== 'POST' || !Object.hasOwn(api, fn)) return enviar(res, 404, { message: 'no_existe' });
    try {
      if (bloqueado(ip)) throw new ApiError('demasiados_intentos', 429);
      const body = await leerBody(req);
      const rol = rolDe(body.p_clave);
      if (fn === 'verificar_clave') { if (!rol) fallo(ip); return enviar(res, 200, rol); }
      if (!rol) { fallo(ip); throw new ApiError('clave_invalida', 401); }
      return enviar(res, 200, await api[fn](body, rol));
    } catch (e) {
      if (e instanceof ApiError) return enviar(res, e.status, { message: e.code });
      console.error(fn, e);
      return enviar(res, 500, { message: 'error_servidor' });
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('No encontrado'); }
    res.writeHead(200, { 'Content-Type': TIPOS[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});

migrar()
  .then(() => server.listen(PORT, () => console.log(`Control Ruta Navideña escuchando en el puerto ${PORT}`)))
  .catch(e => { console.error('No se pudo preparar la base de datos:', e); process.exit(1); });
