# ReflexIA Team Agentes

Aplicación de cartas para descubrir afinidades y documentar experiencias de inteligencia artificial. Incluye **las nueve imágenes originales proporcionadas**, conservadas byte por byte: cuatro habilidades, cuatro ataques y un reverso. No se regeneraron, recortaron ni retocaron. Las cartas se muestran completas con `object-fit: contain` y pueden ampliarse.

## Abrir la actividad

Necesitas **Node.js 22 o posterior**. Abre `Iniciar.cmd` o ejecuta en esta carpeta:

```sh
node server.mjs
```

Abre **http://localhost:4174**. No hace falta instalar paquetes. No hay administrador ni cuenta privilegiada: todos los participantes tienen los mismos controles. Comparte una de las direcciones de red que imprime el servidor. Los demás dispositivos deben estar en la misma red y tener acceso al puerto 4174. Mantén esa computadora y el servidor encendidos durante la actividad. Este servidor HTTP está pensado para una red local de confianza; para acceso por Internet utiliza GitHub Pages con Supabase.

Para probar dos identidades en una computadora usa dos navegadores o perfiles independientes. Las pestañas del mismo origen comparten identidad. Los nombres pueden repetirse: el sistema distingue a las personas mediante identificadores internos.

## Recorrido

1. Cada participante escribe su nombre, voltea las cuatro cartas, elige exactamente dos y confirma.
2. Cualquier participante espera todas las confirmaciones y pulsa **Cerrar selección y formar equipos**. Se agrupan de 2 a 5 integrantes, procurando coincidencias. Puede ajustar la distribución antes de iniciar.
3. Cada equipo pulsa **Iniciar dinámica**. El servidor decide y guarda un único expositor, incluso con clics simultáneos.
4. Sólo el expositor revela su carta de ataque. No se repiten preguntas hasta agotar el mazo.
5. Cada integrante registra sus propias notas en las pestañas Proyecto, Experiencia y Reflexión. Se guardan automáticamente y mantienen su autor. El expositor también puede aportar.
6. Cualquier integrante del equipo puede finalizar su turno actual. Se elige al siguiente participante pendiente.
7. Cuando todos los equipos terminan, la sesión se cierra y el reporte Word se habilita automáticamente. Todos los integrantes pueden descargarlo y seguir corrigiendo sus propias notas.

Una coincidencia alta significa las mismas dos cartas, sin importar el orden. Una media significa una carta compartida. Como hay una única carta por categoría, la coincidencia temática coincide con compartir esa carta; no se inventa un tercer nivel distinto.

## Lo implementado

- Interfaz adaptable a teléfono, tableta y computadora, navegación por teclado y reducción de movimiento.
- Cartas originales con volteo 3D, selección y ampliación; ruleta y revelación de ataques.
- Registro sin contraseña, recuperación de identidad y sesión compartida.
- Equipos, turnos independientes y controles compartidos sin administrador.
- Persistencia en servidor, operaciones atómicas, deduplicación de peticiones y permisos por participante/equipo.
- Notas por autor con autoguardado, borrador local pendiente y reintento al recuperar conexión.
- Dictado mediante la API de voz del navegador, inicio explícito, aviso para terceros, texto revisable y alternativa manual. La aplicación no almacena audio.
- Reporte `.docx` real con portada, tablas, autoría, respuestas completas y paginación; sin inventar contenido faltante.
- Backend Supabase preparado y workflow para GitHub Pages.

## Datos y conexión

El modo local guarda el estado compartido en `.runtime/session.json`. Los tokens de recuperación se almacenan cifrados mediante hash en el servidor; la copia del navegador identifica a su participante. No publiques `.runtime/` ni los tokens de sesión.

La interfaz consulta el servidor cada **1,5 segundos** y al recuperar visibilidad o conexión; la sincronización usa peticiones HTTP, no WebSockets. `localStorage` conserva identidad y borradores pendientes: no sustituye al servidor multijugador. Las notas guardadas se comparten con los participantes de la actividad. No se capturan datos de otros proyectos.

La sesión local dura 24 horas por defecto. Configura `REFLEXIA_RETENTION_HOURS` antes de iniciar el servidor. El proceso comprueba y reemplaza físicamente el archivo de sesión caducada cada minuto como máximo; también lo hace al arrancar y antes de atender operaciones. Mientras el servidor está apagado no puede borrar archivos. Los documentos descargados son copias que conserva cada usuario.

Los borradores e identidades del navegador tienen tratamiento separado del servidor; si usas una computadora compartida, limpia los datos de este sitio al terminar. No se promete borrar automáticamente archivos Word descargados.

## Publicar en GitHub Pages

GitHub Pages aloja únicamente el frontend. **Configura primero Supabase siguiendo [supabase/README.md](supabase/README.md)**. Sin backend configurado, el sitio muestra un error claro al intentar ingresar y no simula una sesión multijugador.

1. Crea un repositorio para esta carpeta y sube su contenido, incluyendo `.github/workflows/pages.yml`. No incluyas `.runtime/`, `.preview/` ni secretos.
2. Completa `public/config.js` con la URL y clave pública de Supabase. Nunca uses una clave `service_role` ni credenciales privadas en este archivo.
3. En el repositorio, selecciona **Settings → Pages → Source: GitHub Actions**.
4. Ejecuta **Actions → Publicar ReflexIA en GitHub Pages → Run workflow**. La publicación es manual. Al enviar cambios o abrir un pull request, `checks.yml` ejecuta las comprobaciones y prepara el frontend sin publicarlo.
5. Comparte el mismo enlace de invitación con todos los participantes. El participante sólo escribe su nombre.

Todas las rutas del frontend son relativas, por lo que funcionan dentro del subdirectorio del repositorio. No se necesita un servidor Node permanente en GitHub Pages. Para generar una distribución estática local ejecuta `node scripts/build.mjs`; el resultado queda en `dist/`.

## Archivos principales

| Archivo | Contenido |
| --- | --- |
| `public/assets/` | Nueve JPG originales, sin modificación |
| `asset-manifest.json` | Tamaño y SHA-256 de los originales |
| `public/index.html`, `public/styles.css` | Página y estilos adaptables |
| `src/app.js` | Pantallas, interacción, notas, estados de conexión y dictado |
| `src/catalog.js` | Habilidades, preguntas y campos configurables |
| `src/game.js` | Reglas, afinidades, equipos y turnos |
| `server.mjs` | Servidor local y persistencia compartida |
| `src/transport.js`, `public/config.js` | Conexión local o Supabase |
| `supabase/migrations/001_reflexia.sql` | Funciones atómicas, identificación y acceso privado |
| `src/report.js`, `src/voice.js` | Exportación Word y reconocimiento de voz |
| `src/vendor/` | docx 9.6.1 incluido y sus licencias |
| `tests/` | Reglas, integración de servidor, Word y voz |
| `.github/workflows/pages.yml` | Validación y publicación estática |

Este proyecto es independiente de IA Quest y no modifica ese juego. Reutiliza su enfoque de módulos JavaScript y servidor estático, ampliado con un backend real. No requiere React, Vite, npm ni compilación para ejecutarse. La única biblioteca de aplicación incluida es **docx 9.6.1**; los estilos usan tipografías de Google Fonts con alternativa local del sistema.

Para cambiar preguntas, edita `ATTACKS` en `src/catalog.js` manteniendo imagen y texto coherentes. No alteres las nueve imágenes originales. En Supabase sincroniza también el catálogo de IDs de la migración según su guía. No se añadió un robot independiente porque no se proporcionó un recurso separado: el robot oficial aparece intacto en las cartas.

## Verificación y límites

```sh
node scripts/check-assets.mjs
node --test tests/*.test.mjs
node scripts/build.mjs
```

Las pruebas cubren selección válida, identidades con nombres iguales, grupos de 2–5 sin duplicados, autorización, turnos simultáneos, ataques sin repetición, notas independientes, recuperación después de reiniciar el servidor, vencimiento real y estructura/contenido del Word. La verificación de recursos exige que los nueve JPG sean idénticos a los entregados.

Se recorrió la aplicación en Chrome con dos identidades independientes: registro, selección, recuperación al recargar, equipos, dos turnos con preguntas distintas, tres aportaciones, cierre y generación Word sin errores JavaScript. También se inspeccionó el formulario a 390 px sin desbordamiento horizontal. El evento automático de descarga del navegador no devolvió una ruta, por lo que se verificó la generación y la estructura OOXML por separado; no se afirma haber abierto ese archivo descargado en Word.

La integración Supabase está preparada pero **no conectada a un proyecto real ni desplegada**. Deben ejecutarse la migración, la configuración de autenticación y las pruebas entre dispositivos antes de usarla en una actividad pública. El micrófono real no se activó durante las pruebas: su disponibilidad depende del navegador, permisos, HTTPS y, en algunos navegadores, de Internet. Siempre se puede escribir manualmente.
#   r e f l e x i a - t e a m  
 #   r e f l e x i a - t e a m  
 #   r e f l e x i a - t e a m  
 