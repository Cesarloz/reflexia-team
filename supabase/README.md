# Conectar ReflexIA con Supabase y GitHub Pages

La aplicación puede ejecutarse ahora con el servidor Node local. GitHub Pages sirve archivos estáticos y necesita un backend externo para que varios dispositivos compartan una actividad. Esta integración utiliza Supabase Auth anónimo y funciones PostgreSQL; no necesita cuentas con contraseña ni claves de servicios de IA. **La actividad no tiene administrador: todos los participantes tienen los mismos permisos y entran por el mismo enlace.** La preparación inicial del alojamiento y la base de datos corresponde a quien publica el repositorio; no crea un rol especial dentro del juego.

**Estado de verificación:** la migración recibió revisión estática, pero no se ejecutó contra una instancia PostgreSQL/Supabase en este entorno. No se proporcionaron credenciales. El transporte JavaScript pasó la comprobación de sintaxis. Antes de una actividad real, aplica la migración en un proyecto de prueba y realiza el recorrido con dos navegadores distintos, incluidas las restricciones de permisos.

## 1. Preparar el proyecto

1. Crea o elige un proyecto Supabase dedicado a ReflexIA.
2. En **Authentication → Sign In / Providers**, habilita **Anonymous Sign-Ins**. Los participantes serán usuarios anónimos identificados internamente por UUID.
3. En **SQL Editor**, ejecuta una vez el contenido completo de `migrations/001_reflexia.sql`. La migración crea sus tablas dentro del esquema privado `reflexia_private`. Usa un proyecto nuevo: no es un script de actualización repetible.
4. Copia la URL del proyecto y su clave pública **anon** o **publishable** desde la configuración de API. No copies `service_role`, una clave secreta ni la contraseña de PostgreSQL al frontend.
5. Edita `public/config.js` con esos dos valores:

```js
window.REFLEXIA_CONFIG = {
  supabaseUrl: 'https://TU-PROYECTO.supabase.co',
  supabaseAnonKey: 'TU-CLAVE-PUBLICA',
  sessionId: '',
  invitationToken: '',
  pollIntervalMs: 1500,
};
```

No hacen falta variables de compilación. `public/config.js` es un archivo público y sólo debe contener configuración pública. El enlace de invitación se suministra mediante el fragmento de URL para mantener la actividad fuera del código publicado.

La sincronización usa peticiones autenticadas cada 1,5 segundos y actualización inmediata después de cada acción. No utiliza Supabase Realtime/WebSocket. La base compartida es la fuente de verdad; `localStorage` conserva sólo las credenciales de recuperación, y la interfaz mantiene por separado los borradores pendientes.

## 2. Configurar el acceso único

Durante la configuración inicial del backend, ejecuta `configure-activity.sql` desde **SQL Editor**, o su equivalente:

```sql
select reflexia_private.create_session(24);
```

El argumento indica las horas de conservación, de 1 a 720. El resultado contiene `sessionId`, `invitationToken` y `expiresAt`. La invitación se almacena en la base únicamente como hash. No se genera ninguna clave de administrador.

Para que todos entren directamente en la misma actividad, copia `sessionId` e `invitationToken` al archivo `public/config.js`. Así, la URL principal del sitio abre la actividad y sólo pide el nombre. La invitación quedará visible para toda persona que pueda leer el sitio. Los registros exigen identificarse como miembro mediante la API autenticada.

Si prefieres compartir una invitación por enlace sin fijarla en la configuración pública, usa el mismo enlace para todas las personas:

```text
https://TU-USUARIO.github.io/TU-REPOSITORIO/#session=SESSION_ID&invite=INVITATION_TOKEN
```

Sustituye los marcadores con los valores que devolvió SQL. No hace falta que una persona específica entre primero. Cada participante escribe su nombre, sin códigos ni selección de salas. Cuando la actividad venza, crea otra con el mismo procedimiento y actualiza sus datos públicos o comparte el nuevo enlace. No se renuevan actividades caducadas silenciosamente.

## 3. Permisos y recuperación

- Las tablas privadas tienen RLS habilitado y carecen de permisos directos para `anon` y `authenticated`. Las únicas operaciones del navegador son las funciones públicas `reflexia_join`, `reflexia_state` y `reflexia_action`.
- Las funciones comprueban la identidad autenticada, pertenencia a la actividad, caducidad, fase y equipo. El cliente no puede elegir el autor de una aportación ni enviar un resultado de ruleta.
- `SELECT FOR UPDATE` serializa las acciones de una actividad. Los identificadores de solicitud evitan repetir acciones, y el identificador del turno evita que un cierre atrasado termine el siguiente turno.
- Cualquier participante puede formar los equipos cuando todas las selecciones estén confirmadas, ajustarlos antes del inicio e iniciar la actividad. Cualquier integrante puede girar la ruleta y finalizar un turno de su propio equipo. Nadie puede intervenir en turnos ajenos a su equipo. Sólo quien está exponiendo revela su carta de ataque. Cada persona edita exclusivamente sus propias aportaciones.
- Cuando finaliza el último equipo, la actividad se cierra y el reporte se habilita automáticamente. Todos los participantes pueden descargarlo. No incluyas información sensible que no quieras compartir con el grupo.
- Una recarga conserva la identidad. Borrar datos del navegador o utilizar otro dispositivo no recupera automáticamente esa identidad. Un fallo transitorio de red nunca crea otro participante.
- El transporte expone `forgetIdentity()` para una acción explícita de la interfaz, por ejemplo **Entrar a una nueva actividad**, cuando las credenciales anteriores ya no sirven. No debe llamarse automáticamente ante un error de red. No lo uses para cambiar de nombre dentro de la misma actividad: crearía una identidad distinta.
- El audio no se guarda. El reconocimiento de voz, cuando existe, depende del navegador y de sus servicios; sólo se activa tras la acción y el consentimiento de la persona.

## 4. Caducidad y eliminación real

La caducidad bloquea el acceso inmediatamente, pero **la eliminación automática requiere configurar un trabajo de Cron**. La migración crea la función de borrado; no activa un programador silenciosamente.

Activa **Cron / pg_cron** en el panel Supabase y ejecuta en SQL Editor:

```sql
select cron.schedule(
  'reflexia-purge-expired',
  '*/15 * * * *',
  'select reflexia_private.purge_expired();'
);
```

Comprueba que el trabajo esté activo y que tenga ejecuciones correctas:

```sql
select jobid, jobname, schedule, active from cron.job
where jobname = 'reflexia-purge-expired';

select d.status, d.start_time, d.end_time, d.return_message
from cron.job_run_details d
join cron.job j on j.jobid = d.jobid
where j.jobname = 'reflexia-purge-expired'
order by d.start_time desc limit 5;
```

Para ejecutar una limpieza manual:

```sql
select reflexia_private.purge_expired();
```

Se eliminan la actividad, sus miembros, registros y solicitudes por cascada. Las cuentas anónimas de Supabase Auth no se eliminan con esta función; su mantenimiento corresponde al responsable del backend. Las copias descargadas del reporte y los borradores que permanezcan en navegadores no se borran a distancia. Las políticas de respaldo y conservación del proveedor se administran por separado.

## 5. Publicar en GitHub Pages

1. Sube el contenido de la carpeta `reflexia-team` como raíz de un repositorio GitHub. Incluye `public/`, `src/`, `tests/`, `server.mjs` y `.github/workflows/pages.yml`. No subas `.runtime/`, registros de participantes ni claves privadas.
2. Completa únicamente las claves públicas de `public/config.js` y guarda el cambio.
3. En **Settings → Pages → Build and deployment**, selecciona **GitHub Actions**.
4. En **Actions**, ejecuta **Publicar ReflexIA en GitHub Pages → Run workflow**. La publicación se inicia manualmente; los cambios enviados y los pull requests ejecutan `checks.yml` para comprobar y compilar el frontend sin publicarlo.
5. El workflow ejecuta las pruebas, copia `public/` y `src/` al artefacto estático y lo publica. La aplicación usa rutas relativas, por lo que funciona dentro del subdirectorio del repositorio sin modificar una base de Vite.
6. Abre el enlace final. Si configuraste `sessionId` e `invitationToken`, el acceso es directo; en caso contrario, añade el fragmento de invitación descrito arriba. Prueba el mismo enlace en navegadores separados.

No es necesario un servidor Node permanente para GitHub Pages. En esa modalidad, Node sólo se usa en las comprobaciones del workflow; Supabase atiende la sesión compartida.

## 6. Cartas y configuración

Las nueve imágenes aportadas se sirven sin editar. Nombres, preguntas y rutas se definen en `src/catalog.js`. El servidor local toma ese catálogo directamente. En Supabase, `configure-activity.sql` contiene la lista de identificadores del mazo; pásala al crear la actividad. Cada sesión conserva su mazo y calcula automáticamente su tamaño y el ciclo de no repetición. Los identificadores deben coincidir con `ATTACKS` en `src/catalog.js`. No alteres el mazo de una actividad ya iniciada. La configuración actual contiene exactamente las cuatro preguntas oficiales y conserva todas las imágenes originales.

## 7. Comprobación antes de uso público

En dos navegadores diferentes confirma: entrada y recuperación tras recarga; selección exacta de dos cartas; equipos sin duplicados; coincidencia del turno y ataque; exclusión de personas que ya participaron; conservación separada de aportaciones; rechazo de acciones de otro equipo; cierre y descarga del reporte. Prueba también una invitación incorrecta y una actividad vencida. La prueba con navegador y el servidor local no sustituye esta comprobación de la instancia Supabase configurada.

Fuentes oficiales: [acceso anónimo](https://supabase.com/docs/guides/auth/auth-anonymous), [funciones y permisos](https://supabase.com/docs/guides/database/functions), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security) y [programación con Cron](https://supabase.com/docs/guides/cron/quickstart).
