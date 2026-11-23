# Control de ingreso · La Ruta Navideña

Sistema web para registrar el ingreso al evento **La Ruta Navideña** (Cajasan Guarigua, del 26 de noviembre al 11 de enero) a partir del número de la boleta. Corre completo en **Railway**: un servidor Node que sirve la página y una base de datos PostgreSQL.

## Qué hace

| Rol | Puede |
|---|---|
| **Portero** | Registrar ingresos y buscar boletas |
| **Administrador** | Todo lo del portero, más ver Jornadas, descargar Excel, anular ingresos y administrar usuarios |

- Cada persona entra con **su usuario y su contraseña**. Cada ingreso queda firmado con el nombre de quien lo registró.
- Cada boleta sirve **una sola vez**, cualquier noche. Si dos puertas digitan la misma boleta al mismo tiempo, la base de datos solo deja pasar una.
- Si se corta la señal en el momento de registrar y el portero vuelve a tocar "Registrar", no se duplica.
- La sesión queda abierta en el celular hasta tocar **Cerrar sesión**. Recargar o cerrar la página no borra nada; lo que se estaba escribiendo también se conserva.
- **Jornadas:** calendario con el conteo por noche, lista de cada día con filtro, **Excel de ese día** y **Excel general** del evento.
- Lo que entra antes de las 6:00 a. m. cuenta para la noche anterior.
- Anular un ingreso deja constancia en la tabla `anulaciones` (qué boleta, a nombre de quién estaba y quién la anuló).

## Despliegue en Railway

1. **New Project → Deploy from GitHub repo** → este repositorio.
2. En el mismo proyecto: **+ Create → Database → PostgreSQL**.
3. En el servicio de la app, pestaña **Variables**:

   | Variable | Valor |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
   | `ADMIN_PASSWORD` | contraseña del primer administrador (si no está, se usa `CLAVE_ADMIN`) |
   | `ADMIN_USUARIO` | opcional, por defecto `admin` |

4. **Settings → Networking → Generate Domain** (puerto 8080).

El servidor crea las tablas solo al arrancar. El primer administrador se crea **únicamente si no existe ningún usuario**; después todo se maneja desde la pestaña **Usuarios**.

## Primer uso

1. Entra con el usuario `admin` y la contraseña de `ADMIN_PASSWORD` (o `CLAVE_ADMIN`).
2. En **Usuarios** crea tu propio administrador y los porteros. Al crear cada uno aparece una tarjeta con enlace, usuario y contraseña, con un botón para copiarla y mandarla por WhatsApp.
3. Si quieres, desactiva después el usuario `admin`.

## Manejo de usuarios
- **Editar** permite cambiar nombre, usuario, rol, contraseña y si está activo.
- Al cambiar la contraseña, el rol o desactivar a alguien, sus sesiones se cierran de inmediato.
- No se puede desactivar ni quitar el rol al último administrador activo, ni a uno mismo.
- Los usuarios no se borran (sus ingresos quedan firmados); se desactivan.
- Tras 8 contraseñas erradas seguidas para un usuario desde una misma conexión, ese intento queda bloqueado 10 minutos.

## Probar en tu computador

```bash
npm install
DATABASE_URL=postgres://usuario:clave@localhost:5432/basedatos ADMIN_PASSWORD=una-clave PGSSL=off npm start
# abre http://localhost:3000
```

## Importante
Sin internet no se puede validar si una boleta ya entró por otra puerta. Aseguren señal o un módem en la entrada.
