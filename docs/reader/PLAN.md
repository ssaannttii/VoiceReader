# Reader — plan de mejora global (oct 2026)

Basado en la auditoría de ElevenReader 1.7.26 y en el registro de diagnóstico real del móvil.
Objetivo: que escuchar sea tan fluido y fiable como la app oficial, manteniendo todo local.

## Principios

- **Medir antes y después.** Cada fase tiene criterios de aceptación medibles en el registro de
  diagnóstico (`scripts/reader/debug-report.py`) y en las pruebas con emulación de móvil.
- **El reproductor es el núcleo.** Los cambios en `reader-player.ts` se hacen en serie; el resto
  (backend, importación, biblioteca, ajustes) puede ir en paralelo en ramas separadas.
- **Nada se rompe para los datos existentes.** Cambios de esquema con migración alembic y
  `_BASE_SCHEMA`; documentos y caché antiguos siguen funcionando.
- **Todos los textos nuevos en los 21 idiomas.** Tests de backend y frontend en verde antes de
  cada commit.

## Fase 0 — requisito (tú, 1 clic)

Activar **HTTPS Certificates** en <https://login.tailscale.com/admin/dns>. Desbloquea instalar
Reader como app, compartir hacia Reader, cámara, micrófono y almacenamiento persistente. El
lanzador pasa a HTTPS solo. Sin esto, las fases 1–2 funcionan igual; la 3 queda a medias.

## Fase 1 — Escucha perfecta (núcleo)

**Prioridad absoluta: reproducción fiable en segundo plano** (pantalla apagada / app en segundo
plano en Android) durante sesiones largas. Es el criterio principal de 1.1.

| # | Mejora | Diseño | Aceptación |
|---|---|---|---|
| 1.1 | **Audio continuo sin huecos** | Nuevo motor de reproducción con Media Source Extensions: un único `<audio>` alimentado por un `SourceBuffer` (`audio/mpeg`, modo `sequence`). Cada bloque renderizado (red o IndexedDB) se añade en orden; los inicios de bloque se toman de `buffered.end` tras cada `append`, así el resaltado sigue exacto. Saltar fuera de lo cargado crea un `MediaSource` nuevo. Se mantiene el modo actual (un archivo por bloque) como alternativa si `MediaSource.isTypeSupported('audio/mpeg')` es falso. | 0 eventos `start ready=false` en reproducción continua; 0 `waiting` a mitad de bloque; prueba real de 30 min con pantalla apagada sin pausas. |
| 1.2 | **Deshacer salto + punto más lejano** | Columna `furthest_segment` (migración 0015) actualizada con el progreso; el reproductor guarda la posición antes de cada salto. UI: marca en la barra, píldora "Volver a 12:34" 6 s tras un salto, acción "Ir al punto más lejano". | Tests de API y del reproductor; un toque accidental se deshace en un toque. |
| 1.3 | **Botones configurables** | Preferencias por dispositivo: salto 10/15/30/60 s; anterior/siguiente = frase, capítulo o ±salto. Aplicadas en Media Session (`seekbackward/forward`, `previous/nexttrack`) y en el dock. | Funciona con auriculares Bluetooth y pantalla de bloqueo en el Xiaomi. |
| 1.4 | **Estados claros del PC y el motor** | `/reader/status` informa de modelo cargado/cargando; el cliente distingue "PC inaccesible", "cargando voz (~30 s)", "sin conexión: N bloques descargados" con reintento automático y precarga del modelo al abrir Reader. | Cada estado reproducido en pruebas; sin "error" genérico. |

## Fase 2 — Pronunciación y comodidad de lectura

| # | Mejora | Diseño | Aceptación |
|---|---|---|---|
| 2.1 | **Diccionario de pronunciación** | Pulsación larga en una palabra → hoja "Pronunciar como" → `POST /pronunciation` (diccionario existente de VoiceStudio, por idioma). El render aplica el diccionario tras `normalize_for_tts` y la **clave de caché pasa a basarse en el texto final sintetizado**, así solo se regeneran los bloques afectados. Lista para gestionar entradas en el menú. | Añadir una palabra regenera solo los bloques que la contienen (test). |
| 2.2 | **Temas de lectura** | Resaltado clásico/ámbar/amarillo/azul; fuentes serif (Source Serif), sans (Inter), OpenDyslexic (licencia OFL, empaquetada); fondo papel. Variables CSS en `.rd-root`, vista previa en vivo. | Contraste AA en claro/oscuro/papel. |
| 2.3 | **Doble toque para reproducir** (opcional) y **sincronizar lectura** | Con la opción activa, un toque no salta; doble toque reproduce desde la palabra. En pausa, "Seguir desde aquí" usa el primer bloque visible. | Sin saltos accidentales con la opción activa. |
| 2.4 | **Buscar en el documento** | Búsqueda local sobre los bloques con lista de resultados; la ventana de texto salta al elegido. | Libro de 15.000 bloques: resultados en < 200 ms en móvil. |

## Fase 3 — Meter contenido sin fricción

| # | Mejora | Diseño | Aceptación |
|---|---|---|---|
| 3.1 | **Compartir → Reader** | `share_target` en el manifiesto: enlaces y texto por GET; archivos (PDF/EPUB/DOCX/imagen) por POST interceptado en el service worker y subido a `/reader/documents/file`. | Compartir un artículo desde Chrome abre Reader con el documento creado. Requiere fase 0. |
| 3.2 | **Importación sin bloquear** | La hoja se cierra al instante; fila provisional en la biblioteca con estado y progreso; importación en segundo plano en el backend. | Un PDF de 26 h no bloquea la UI. |
| 3.3 | **Capítulos en PDF** | Detección de títulos ("Capítulo N", "Parte", números romanos, líneas cortas aisladas) y, si no hay, capítulos cada ~N páginas. Lista de capítulos con escuchado / ahora / % más lejano. | El libro de Sanderson muestra sus capítulos. |
| 3.4 | **Escanear con la cámara** | `<input accept="image/*" capture multiple>`; OCR en el PC (RapidOCR/PaddleOCR en ONNX o Tesseract); páginas en orden → documento. | Foto de una página de libro → texto legible y escuchable. |
| 3.5 | **Biblioteca ordenable** | Orden por reciente/progreso/título; archivar; marcar terminado / no leído. | — |

## Fase 4 — Escucha larga

| # | Mejora | Diseño |
|---|---|---|
| 4.1 | **Marcadores con notas** | Tabla `reader_bookmarks` (migración); aviso con "Deshacer" y "Añadir nota"; hoja de marcadores con "Escuchar desde aquí" y exportar a Markdown. |
| 4.2 | **Cola** | "Añadir a la cola", reordenar, pasar al siguiente al terminar; el temporizador respeta la cola. |
| 4.3 | **Sonidos de ambiente** | 5 bucles sintetizados en el dispositivo (lluvia, ruido marrón y rosa, cafetería, chimenea; sin audio con licencia) en un segundo `<audio loop>` con volumen propio; se apagan con el temporizador. |
| 4.3b | **Ambiente automático** | Opción "Automático" (desactivada por defecto): el PC divide el documento en escenas y las etiqueta (léxico es/en + Ollama opcional; ante la duda, silencio); el dispositivo funde con suavidad entre lechos sintetizados (lluvia, tormenta, viento, mar, bosque, noche, chimenea, taberna, ciudad, habitación, cueva). Ver SPEC "Automatic ambience". |
| 4.4 | **Selector de voces** | Búsqueda, recientes, filtro por idioma (por defecto el del documento). |

## Fase 5 — Extras

| # | Mejora | Diseño |
|---|---|---|
| 5.2 | **Modo solo audio** | Oculta el texto; orbe en canvas que sigue el ritmo de las palabras (tiempos del resaltado). Sin `AnalyserNode`: pasar el audio por Web Audio rompería la reproducción en segundo plano. |
| 5.3 | **Contenido rico** | El importador emite listas, citas e imágenes además de párrafos. |
| 5.4 | **Paginado / dos columnas** ✅ | Modo alternativo de la vista de texto con zonas de toque. Hecho: "Páginas" en Texto y apariencia (una página por pantalla; dos columnas en pantallas anchas queda pendiente). Ver SPEC "Paged layout". |
| 5.5 | **Primer arranque** | Documento de ejemplo, elegir voz por defecto, avisos de un solo uso. |

## Fuera de alcance

Funciones de IA sobre el documento (preguntas, resúmenes): descartadas por decisión del usuario,
el foco es el núcleo de un lector tipo ElevenLabs Reader. Cuentas, cuotas, DRM, catálogo de pago, lectura de Kindle/Libby por inyección de scripts,
analítica de terceros, Android Auto / widgets / motor TTS del sistema (requieren app nativa;
reconsiderar con Capacitor más adelante).

## Ejecución

- Fase 1 en serie (núcleo del reproductor), con pruebas e2e en emulación de móvil y una sesión
  real tuya validada con el registro de diagnóstico.
- Fases 2–4: backend e importación en paralelo con agentes en ramas separadas; integración y
  pruebas antes de cada commit.
- Cada fase termina con: tests verdes, build web, reinicio del servicio, informe de diagnóstico
  antes/después y un resumen de lo que cambia para ti.
