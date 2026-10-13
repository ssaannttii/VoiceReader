# Reader — tu "ElevenLabs Reader" local

Reader convierte cualquier texto (PDF, EPUB, DOCX, TXT/Markdown, HTML, artículos web o texto
pegado) en audio narrado con resaltado palabra a palabra. Todo se genera en tu PC con
VoiceStudio (OmniVoice en la GPU); el móvil solo reproduce.

Especificación técnica y contrato de API: [SPEC.md](SPEC.md).

## Arranque automático (recomendado)

Una vez, en PowerShell:

```powershell
.\scriptseader\install-autostart.ps1
```

Desde entonces Reader arranca solo y oculto al iniciar sesión en Windows, se reinicia si se cae y
queda publicado en tu tailnet. El enlace para el móvil se guarda en
`%APPDATA%\OmniVoiceeader-links.txt`; el registro en `reader-launcher.log`. Para quitarlo:
`.\scriptseader\install-autostart.ps1 -Remove`.

## Arrancar a mano

Doble clic en `scripts\reader\Reader.bat` (o `.\scripts\reader\start-reader.ps1`).

El script:
1. Compila la interfaz web si ha cambiado el código (`bun run build:web`).
2. Arranca el backend en `http://127.0.0.1:3900` (sirve también la interfaz).
3. Lo publica para tus dispositivos:
   - **Tailscale** (por defecto si está activo): abre en el móvil la URL `http://<tu-pc>.<tailnet>.ts.net/#/reader`
     desde casa o fuera. Si activas *HTTPS Certificates* en
     <https://login.tailscale.com/admin/dns>, la URL pasa a `https://` y Reader se puede
     **instalar como app** (PWA) desde Chrome → "Instalar app".
   - **LAN con PIN** (`-Lan`): `http://<ip-del-pc>:3910/?pin=XXXXXXXX#/reader`. El PIN es fijo
     (guardado en `%APPDATA%\OmniVoice\reader-share-pin.txt`) y el móvil lo recuerda un año.

Opciones: `-Lan`, `-NoTailscale`, `-NoBuild`, `-Port 3900`, `-KeepServe` (deja `tailscale serve`
activo al cerrar).

En el PC también puedes usar Reader dentro de la app de escritorio (`bun run dev`) → menú
**Reader**.

## Uso

- **Biblioteca**: botón **+** → pegar texto, subir archivo o pegar un enlace. "Seguir
  escuchando" retoma el último documento donde lo dejaste (el progreso se guarda en el PC, así
  que es el mismo en móvil y escritorio).
- **Lector**: toca cualquier frase para saltar a ella (o, con *Doble toque para reproducir*,
  tócala dos veces). La vista sigue la lectura; si te desplazas, aparece "Volver a la
  lectura" y, en pausa, "Seguir desde aquí". Tras cualquier salto, "Volver a 12:34" lo deshace
  durante 6 s; la marca de la barra y "Ir al punto más lejano" llevan a donde más lejos
  llegaste.
- **Reproductor**: audio continuo sin cortes entre frases (también con la pantalla apagada),
  velocidad 0.5–3× sin cambiar el tono, saltos de 10/15/30/60 s, anterior/siguiente por frase,
  capítulo o salto (menú → *Controles*), temporizador de apagado (minutos o fin de capítulo),
  voces, capítulos, tamaño de texto. Controles en pantalla de bloqueo y auriculares (Media
  Session). Si el PC no responde o la voz se está cargando, el reproductor lo dice y reintenta
  solo.
- **Pronunciación**: mantén pulsada una palabra (en el PC, clic derecho) → *Pronunciar como*:
  escribe cómo suena, *Probar* la escucha en la frase y *Guardar* la aplica a todos los
  documentos de ese idioma (también en VoiceStudio). Menú → *Pronunciaciones* lista y borra las
  entradas. Solo se regeneran las frases que contienen la palabra; las descargas offline
  conservan el audio anterior hasta volver a descargarlas. En el móvil, la pulsación larga sobre
  el texto abre esta hoja en lugar de seleccionar texto.
- **Marcadores**: menú → *Añadir marcador aquí* (o tecla **B** en el PC). El aviso ofrece
  *Deshacer* y *Añadir nota*. Menú → *Marcadores*: tocar uno lo muestra en el texto, *Escuchar
  desde aquí* reproduce desde él, y *Exportar a Markdown* descarga marcadores y notas. Las frases
  marcadas llevan una pequeña cinta.
- **Capítulos**: cada capítulo indica si ya está escuchado (✓), el actual (*Ahora*) o hasta qué
  % llegaste.
- **Escanear páginas**: botón **+** → *Escanear* → *Hacer fotos* (cámara) o *Elegir fotos*;
  ordena o quita páginas y pulsa *Escanear y añadir*. El texto se reconoce en el PC (OCR) en
  segundo plano. Una importación fallida muestra *Reintentar* en la biblioteca.
- **Compartir → Reader** (Android): con Reader **instalado como app** desde una URL `https://`
  (Tailscale con *HTTPS Certificates*), aparece en el menú *Compartir* del sistema. Un enlace o
  texto compartido se importa y se abre; los archivos (PDF, EPUB, DOCX, TXT/Markdown/HTML) se
  suben al PC y las fotos se unen en un único escaneo. Por HTTP plano o sin instalar la app no
  aparece (lo exige el navegador: hace falta el service worker). Si cambias la app de versión,
  ábrela una vez antes de compartir para que el service worker nuevo quede activo.
- **Offline**: menú del documento → *Descargar*. El PC pre-genera todo el audio y el móvil lo
  guarda; después se escucha sin conexión.
- **Teclado (PC)**: Espacio reproducir/pausa, ←/→ frase anterior/siguiente, +/− velocidad,
  B marcador.

## Sonidos de ambiente grabados (opcional)

Los ambientes (lluvia, chimenea, cafetería y el modo *Automático*) pueden usar grabaciones reales
de dominio público (CC0, de Freesound.org) en lugar de los sonidos sintetizados. El audio no va en
git: se descarga y prepara una vez en una carpeta del PC.

```powershell
uv run --no-sync python scripts/reader/fetch-ambience.py --out E:\VoiceReaderData\ambience
```

Después indica al backend dónde está, añadiendo esta línea a
`%APPDATA%\OmniVoice\reader-env.ps1` (el lanzador lo carga al arrancar) y reinicia Reader:

```powershell
$env:OMNIVOICE_AMBIENCE_DIR = 'E:\VoiceReaderData\ambience'
```

(Sin la variable se busca en `%APPDATA%\OmniVoice\reader\ambience`.) En la hoja de sonido del
móvil aparece **Sonidos grabados** (activado por defecto); cada grabación se descarga una vez y
queda guardada para escuchar sin conexión. Si falta alguna, suena la versión sintetizada. Fuentes,
autores y licencias: `scripts/reader/ambience-sources.json` y la tabla de créditos de
[SPEC.md](SPEC.md#recorded-beds-ambience-pack).

## Música de fondo (Laboratorio, opcional)

Música instrumental muy suave bajo la narración (−30 LUFS por defecto, ajustable), generada en el PC con
**Stable Audio Open 1.0** solo para los documentos en que la pidas (Laboratorio). El modelo no se
instala en el venv de Reader: corre en un venv aparte como proceso independiente, y solo cuando la
voz está inactiva (descarga OmniVoice antes y se detiene en cuanto vuelves a escuchar algo sin
generar). Configuración en `%APPDATA%\OmniVoice\reader-env.ps1`:

```powershell
# Python del venv con torch + diffusers + soundfile + scipy (por defecto, el del spike si existe)
$env:OMNIVOICE_MUSIC_PYTHON = 'E:\VoiceReaderData\engines\music-spike\ace-step-1.5\.venv\Scripts\python.exe'
# Carpeta HF con los pesos (modelo con licencia aceptada en Hugging Face; nunca se descarga solo)
$env:OMNIVOICE_MUSIC_HF_HOME = 'E:\VoiceReaderData\hf_cache'
```

Los cues se guardan en `%APPDATA%\OmniVoice\reader\music` (o `$env:OMNIVOICE_MUSIC_DIR`). Para
tenerlos en E:, crea antes una unión de directorios:

```powershell
New-Item -ItemType Junction -Path "$env:APPDATA\OmniVoice\reader\music" -Target 'E:\VoiceReaderData\music'
```

Cada libro usa unos 6 estados de ánimo × 3 variaciones de 47 s (~0,4 MB cada una); cada variación
tarda ~70 s en una RTX 2070 SUPER (dos semillas, se queda la más discreta): ~20 min por libro. Para probar el plan
de un libro sin el backend: `scripts/reader/music-plan.py` (ver [SPEC.md](SPEC.md#background-music-labs)).
Licencia del modelo: Stability AI Community License — *Powered by Stability AI*.

## Voces

Si un documento no tiene voz elegida, Reader usa la voz por defecto de su idioma: márcala con la
**estrella** en el selector de voces. Sin estrella, elige un perfil del idioma (prefiere los de
personalidad *Reader*). La voz queda fijada en el documento para que no cambie entre frases.

Para crear voces nuevas usa VoiceStudio → **Voice design** (describe la voz) o **Voice
cloning** (graba/sube 10–20 s de referencia limpia, con permiso de la persona). Aparecen en el
selector de voces de Reader al momento.

## Rendimiento (RTX 2070 SUPER 8 GB, OmniVoice)

- Primera frase: ~1,5 s (el modelo tarda ~30 s en cargarse la primera vez tras arrancar).
- Generación ~4–6× más rápida que tiempo real; el reproductor mantiene al menos 3 frases y
  60 s de audio preparados por delante.
- El audio se cachea en `%APPDATA%\OmniVoice\reader\audio`: volver a escuchar es instantáneo.

## Seguridad

- Por Tailscale solo acceden tus dispositivos de la tailnet; entran como si fueran el propio PC
  (acceso completo a VoiceStudio). No compartas el nodo con otras personas.
- Por LAN, cualquier petición desde otra IP necesita el PIN.

## Mantenerse al día con VoiceStudio

```powershell
git fetch upstream
git merge upstream/main
bun install; bun run setup:api
```
