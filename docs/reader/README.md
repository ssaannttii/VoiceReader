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
- **Offline**: menú del documento → *Descargar*. El PC pre-genera todo el audio y el móvil lo
  guarda; después se escucha sin conexión.
- **Teclado (PC)**: Espacio reproducir/pausa, ←/→ frase anterior/siguiente, +/− velocidad.

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
