# Fix IURPv2

## Perche ha smesso di funzionare
Il bot dipende da yt-dlp per ricavare l'URL audio di YouTube. Il vecchio codice eseguiva direttamente
`./node_modules/youtube-dl-exec/bin/yt-dlp.exe` e non aggiornava il binario. A meta agosto 2026 YouTube
ha cambiato il modo in cui serve alcuni stream, rendendo obsolete molte versioni di yt-dlp.

Il fix:
- usa direttamente l'API di `youtube-dl-exec`, senza percorso `.exe` hardcoded;
- prova ad aggiornare yt-dlp a ogni avvio;
- abilita Node come runtime JavaScript di yt-dlp (`--js-runtimes node`);
- abilita i componenti EJS da GitHub (`--remote-components ejs:github`);
- aggiunge `ffmpeg-static` come dipendenza esplicita;
- stampa in console l'errore reale di `/play`;
- sposta il token Discord fuori dal sorgente.

## Installazione pulita su Windows
Apri il terminale nella cartella del bot e sostituisci `index.js` e `package.json` con quelli di questa cartella.

Poi esegui:

```bat
rmdir /s /q node_modules
del package-lock.json
npm install
```

Copia `.env.example` in `.env`:

```bat
copy .env.example .env
```

Apri `.env` e inserisci il NUOVO token Discord:

```text
DISCORD_TOKEN=il_tuo_nuovo_token
```

Avvia:

```bat
npm start
```

## Test rapido
Se vuoi verificare solo yt-dlp:

```bat
npm run update:ytdlp
.\\node_modules\\youtube-dl-exec\\bin\\yt-dlp.exe --version
.\\node_modules\\youtube-dl-exec\\bin\\yt-dlp.exe --js-runtimes node --remote-components ejs:github -f bestaudio/best --get-title --get-url "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
```

Se l'ultimo comando stampa prima il titolo e poi un URL molto lungo, l'estrazione YouTube funziona.

## Importante: token
Il vecchio token era scritto direttamente in `index.js`. Va rigenerato dal Discord Developer Portal prima di
riutilizzare il bot; il file corretto non contiene alcun token.
