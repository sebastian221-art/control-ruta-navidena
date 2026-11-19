# Control de ingreso · La Ruta Navideña

Página web para registrar el ingreso al evento **La Ruta Navideña** (Cajasan Guarigua, del 26 de noviembre al 11 de enero) a partir del número de la boleta.

- El portero escribe el número y el sistema dice si la boleta está **disponible** o **ya fue usada** (con día, hora, nombre y puerta).
- Si está disponible, escribe el nombre de la persona y registra. Cada boleta sirve **una sola vez**, cualquier día.
- Si dos puertas digitan la misma boleta al mismo tiempo, solo una la registra (lo garantiza la base de datos).
- **Jornadas:** calendario con el conteo por noche, lista de cada día, filtro y Excel del día o general.
- **Buscar boleta:** quién entró con ella, cuándo y por qué puerta. El administrador puede anular un ingreso mal digitado.
- Lo que entra antes de las 6:00 a. m. cuenta para la noche anterior.
- Nada se pierde al recargar: los ingresos están en Supabase y la sesión y lo que se estaba escribiendo quedan en el celular.

## Archivos

| Archivo | Qué es |
|---|---|
| `index.html` | La página completa |
| `config.js` | URL y anon key de Supabase, fechas del evento |
| `supabase/schema.sql` | Tablas, funciones y claves de acceso (se ejecuta una vez) |

## Puesta en marcha

### 1. Supabase
1. Crea un proyecto gratis en [supabase.com](https://supabase.com).
2. Abre `supabase/schema.sql`, cambia `CLAVE_PORTEROS` y `CLAVE_ADMIN` al final del archivo por las claves que quieras.
3. En Supabase ve a **SQL Editor**, pega todo el archivo y dale **Run**.
4. En **Project Settings → API** copia la **Project URL** y la **anon public key**.

> No uses ni compartas la **service_role key**. La página solo necesita la anon key, que es pública por diseño: sin la clave de acceso no puede leer ni escribir nada.

### 2. Configuración
Edita `config.js` con la URL y la anon key, y haz commit.

### 3. Vercel
1. En [vercel.com](https://vercel.com) → **Add New → Project** → importa este repositorio.
2. Framework Preset: **Other**. No necesita build ni variables de entorno.
3. **Deploy.** Cada push a `main` se publica solo.

### 4. Prueba antes del evento
Con dos celulares: registra una boleta en uno, intenta usarla en el otro (debe salir en rojo) y luego anúlala entrando con la clave de administrador en **Buscar boleta**.

## Uso diario
- Cada portero entra con la clave de porteros y el nombre de su puesto (por ejemplo, "Puerta principal · Carlos"). El celular la recuerda hasta tocar **Salir**.
- La clave de administrador da lo mismo más el botón **Anular este ingreso**.
- Para cambiar las claves, vuelve a ejecutar en Supabase solo el último bloque de `schema.sql` con las claves nuevas. Todos tendrán que volver a entrar.

## Importante
- Sin internet no se puede validar si una boleta ya entró por otra puerta. Aseguren señal o un módem en la entrada.
- El plan gratis de Supabase pausa el proyecto tras 7 días **sin uso**. Durante el evento hay uso diario; si lo dejan quieto antes del 26, entren al panel de Supabase y reactívenlo.
