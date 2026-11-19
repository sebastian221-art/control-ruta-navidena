-- =====================================================================
--  Control de ingreso · La Ruta Navideña (Cajasan Guarigua)
--  Pegar completo en Supabase → SQL Editor → Run. Se ejecuta UNA vez.
--
--  ANTES DE EJECUTAR: cambia las dos claves de la última sección
--  ('CLAVE_PORTEROS' y 'CLAVE_ADMIN').
--
--  Seguridad: las tablas no se pueden leer ni escribir directamente con
--  la anon key (RLS sin políticas). Todo pasa por funciones que exigen
--  la clave de acceso.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- Tablas ----------------------------------------------------
create table if not exists public.ingresos (
  num          text primary key,              -- número de boleta sin ceros a la izquierda
  nombre       text not null,
  ts           timestamptz not null default now(),
  jornada      date not null,                  -- noche del evento (antes de las 6 a. m. cuenta la noche anterior)
  puesto       text not null default '',
  dispositivo  text not null default ''
);
create index if not exists ingresos_jornada_idx on public.ingresos (jornada, ts desc);

create table if not exists public.ajustes (
  id            int primary key default 1 check (id = 1),
  hash_portero  text not null,
  hash_admin    text not null
);

alter table public.ingresos enable row level security;
alter table public.ajustes  enable row level security;
revoke all on public.ingresos from anon, authenticated;
revoke all on public.ajustes  from anon, authenticated;

-- ---------- Helpers ---------------------------------------------------
create or replace function public._rol(p_clave text)
returns text language sql stable security definer
set search_path = public, extensions as $$
  select case
    when p_clave is null or p_clave = '' then null
    when a.hash_admin   = crypt(p_clave, a.hash_admin)   then 'admin'
    when a.hash_portero = crypt(p_clave, a.hash_portero) then 'portero'
  end
  from public.ajustes a where a.id = 1;
$$;

create or replace function public._jornada(p_ts timestamptz)
returns date language sql immutable as $$
  select ((p_ts at time zone 'America/Bogota') - interval '6 hours')::date;
$$;

create or replace function public._fila(i public.ingresos)
returns json language sql immutable as $$
  select json_build_object('num', i.num, 'nombre', i.nombre, 'ts', i.ts,
                           'jornada', i.jornada, 'puesto', i.puesto);
$$;

-- ---------- API (lo que llama la página) ------------------------------

-- Devuelve 'portero', 'admin' o null.
create or replace function public.verificar_clave(p_clave text)
returns text language sql stable security definer
set search_path = public, extensions as $$
  select public._rol(p_clave);
$$;

-- Consulta una boleta. {estado:'libre'} o {estado:'usada', ...datos}
create or replace function public.consultar_boleta(p_clave text, p_num text)
returns json language plpgsql stable security definer
set search_path = public, extensions as $$
declare r public.ingresos;
begin
  if public._rol(p_clave) is null then raise exception 'clave_invalida' using errcode = '28000'; end if;
  select * into r from public.ingresos where num = p_num;
  if not found then return json_build_object('estado', 'libre', 'num', p_num); end if;
  return json_build_object('estado', 'usada') :: jsonb || public._fila(r) :: jsonb;
end $$;

-- Registra el ingreso. Atómico: si dos puertas mandan la misma boleta,
-- solo una entra; la otra recibe {estado:'usada'}.
create or replace function public.registrar_ingreso(
  p_clave text, p_num text, p_nombre text, p_puesto text, p_dispositivo text)
returns json language plpgsql volatile security definer
set search_path = public, extensions as $$
declare r public.ingresos; v_now timestamptz := now();
begin
  if public._rol(p_clave) is null then raise exception 'clave_invalida' using errcode = '28000'; end if;
  if coalesce(p_num, '') !~ '^[1-9][0-9]{0,6}$' then raise exception 'numero_invalido'; end if;
  if length(trim(coalesce(p_nombre, ''))) = 0 then raise exception 'nombre_vacio'; end if;

  insert into public.ingresos (num, nombre, ts, jornada, puesto, dispositivo)
  values (p_num, left(trim(p_nombre), 120), v_now, public._jornada(v_now),
          left(coalesce(p_puesto, ''), 60), left(coalesce(p_dispositivo, ''), 40))
  on conflict (num) do nothing
  returning * into r;

  if found then
    return json_build_object('estado', 'registrada') :: jsonb || public._fila(r) :: jsonb;
  end if;
  select * into r from public.ingresos where num = p_num;
  return json_build_object('estado', 'usada') :: jsonb || public._fila(r) :: jsonb;
end $$;

-- Conteo por jornada: [{jornada, total}]
create or replace function public.conteo_jornadas(p_clave text)
returns json language plpgsql stable security definer
set search_path = public, extensions as $$
begin
  if public._rol(p_clave) is null then raise exception 'clave_invalida' using errcode = '28000'; end if;
  return coalesce((select json_agg(json_build_object('jornada', jornada, 'total', total) order by jornada)
                   from (select jornada, count(*) total from public.ingresos group by jornada) t), '[]'::json);
end $$;

-- Ingresos de una jornada (más recientes primero). p_limite null = todos.
create or replace function public.listar_jornada(p_clave text, p_fecha date, p_limite int default null)
returns json language plpgsql stable security definer
set search_path = public, extensions as $$
begin
  if public._rol(p_clave) is null then raise exception 'clave_invalida' using errcode = '28000'; end if;
  return coalesce((select json_agg(public._fila(i) order by i.ts desc)
                   from (select * from public.ingresos where jornada = p_fecha
                         order by ts desc limit p_limite) i), '[]'::json);
end $$;

-- Todos los ingresos del evento (para el Excel general).
create or replace function public.listar_todo(p_clave text)
returns json language plpgsql stable security definer
set search_path = public, extensions as $$
begin
  if public._rol(p_clave) is null then raise exception 'clave_invalida' using errcode = '28000'; end if;
  return coalesce((select json_agg(public._fila(i) order by i.ts) from public.ingresos i), '[]'::json);
end $$;

-- Anula un ingreso digitado por error. Solo con la clave de administrador.
create or replace function public.anular_ingreso(p_clave text, p_num text)
returns json language plpgsql volatile security definer
set search_path = public, extensions as $$
begin
  if public._rol(p_clave) is distinct from 'admin' then raise exception 'solo_admin' using errcode = '28000'; end if;
  delete from public.ingresos where num = p_num;
  return json_build_object('estado', case when found then 'anulada' else 'no_existia' end, 'num', p_num);
end $$;

-- Permisos: la página solo puede ejecutar las funciones públicas.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.verificar_clave(text)                         to anon;
grant execute on function public.consultar_boleta(text, text)                  to anon;
grant execute on function public.registrar_ingreso(text, text, text, text, text) to anon;
grant execute on function public.conteo_jornadas(text)                         to anon;
grant execute on function public.listar_jornada(text, date, int)               to anon;
grant execute on function public.listar_todo(text)                             to anon;
grant execute on function public.anular_ingreso(text, text)                    to anon;

-- ---------- Claves de acceso (CÁMBIALAS antes de ejecutar) -------------
insert into public.ajustes (id, hash_portero, hash_admin)
values (1, extensions.crypt('CLAVE_PORTEROS', extensions.gen_salt('bf')),
           extensions.crypt('CLAVE_ADMIN',    extensions.gen_salt('bf')))
on conflict (id) do update set hash_portero = excluded.hash_portero, hash_admin = excluded.hash_admin;

-- Para cambiar las claves más adelante, vuelve a ejecutar solo el bloque
-- anterior con las claves nuevas.
