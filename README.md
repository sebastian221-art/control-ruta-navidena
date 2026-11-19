# Control de ingreso · La Ruta Navideña

Sistema web para registrar el ingreso al evento **La Ruta Navideña** (Cajasan Guarigua, del 26 de noviembre al 11 de enero) a partir del número de la boleta. Corre completo en **Railway**: un servidor Node que sirve la página y una base de datos PostgreSQL.

- El portero escribe el número y el sistema dice si la boleta está **disponible** o **ya fue usada** (con día, hora, nombre y puerta).
- Si está disponible, escribe el nombre de la persona y registra. Cada boleta sirve **una sola vez**, cualquier día.
- Si dos puertas digitan la misma boleta al mismo tiempo, solo una la registra (lo garantiza la base de datos).
- **Jornadas:** calendario con el conteo por noche, lista de cada día, filtro y Excel del día o general.
- **Buscar boleta:** quién entró con ella, cuándo y por qué puerta. El administrador puede anular un ingreso mal digitado.
- Lo que entra antes de las 6:00 a. m. cuenta para la noche anterior.
- Nada se pierde al recargar: los ingresos están en la base de datos, y la sesión y lo que se estaba escribiendo quedan guardados en el celular.

## Archivos

| Archivo | Qué es |
|---|---|
| `server.js` | Servidor: API, claves de acceso y creación automática de la tabla |
| `public/index.html` | La página |
| `public/config.js` | Fechas del evento |

## Despliegue en Railway

1. En [railway.com](https://railway.com) → **New Project → Deploy from GitHub repo** → elige este repositorio.
2. En el mismo proyecto: **+ Create → Database → PostgreSQL**.
3. En el servicio de la app, pestaña **Variables**, agrega:

   | Variable | Valor |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (referencia a la base de datos) |
   | `CLAVE_PORTEROS` | la clave que usarán los porteros |
   | `CLAVE_ADMIN` | tu clave de administrador (permite anular ingresos) |

4. Pestaña **Settings → Networking → Generate Domain** para obtener el enlace público.
5. Al arrancar, el servidor crea la tabla solo. No hay que ejecutar SQL.

Cada push a `main` se vuelve a desplegar solo.

## Prueba antes del evento
Con dos celulares: registra una boleta en uno, intenta usarla en el otro (debe salir en rojo) y luego anúlala entrando con la clave de administrador en **Buscar boleta**.

## Uso diario
- Cada portero entra con la clave de porteros y el nombre de su puesto (por ejemplo, "Puerta principal · Carlos"). El celular lo recuerda hasta tocar **Salir**.
- Para cambiar una clave, cámbiala en **Variables** de Railway. Todos tendrán que volver a entrar.
- Tras 10 claves incorrectas desde una misma conexión, el servidor bloquea esa conexión 10 minutos.

## Probar en tu computador

```bash
npm install
DATABASE_URL=postgres://usuario:clave@localhost:5432/basedatos CLAVE_PORTEROS=puerta CLAVE_ADMIN=jefe npm start
# abre http://localhost:3000
```

## Importante
Sin internet no se puede validar si una boleta ya entró por otra puerta. Aseguren señal o un módem en la entrada.
