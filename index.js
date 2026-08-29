const {
    Client, GatewayIntentBits, ApplicationCommandOptionType, Events,
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ActivityType, MessageFlags, Routes, ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    entersState,
    generateDependencyReport,
    StreamType
} = require('@discordjs/voice');
const fs = require('fs');
const spawn = require('child_process').spawn;
const ffmpegStaticPath = require('ffmpeg-static');

const ffmpegPath =
    process.env.FFMPEG_PATH ||
    ffmpegStaticPath;

console.log(`🎬 FFmpeg utilizzato: ${ffmpegPath}`);
const youtubeDl = require('youtube-dl-exec');
const {
    buildMediaHub,
    getMediaItem,
    incrementPlay,
    refreshMediaTitles
} = require('./media-hub');
const dynamicText = require('./dynamic-text');

// Conserva il contesto HTTP restituito da yt-dlp per ogni URL CDN.
// Alcuni flussi YouTube richiedono gli stessi header usati durante
// l'estrazione; in cloud un URL nudo può chiudersi senza produrre audio.
const streamPlaybackContext = new Map();
const {
    MEDIA_ADMIN_COMMANDS,
    handleLibraryAdminAutocomplete,
    handleLibraryAdminCommand,
    handleLibraryAdminButton
} = require('./media-library-admin');

// yt-dlp: usa il wrapper ufficiale invece di un percorso .exe hardcoded.
// Questo rende il bot portabile e permette di gestire gli aggiornamenti di YouTube.
async function extractAudioInfo(input) {
    const isDirectUrl = /^https?:\/\//i.test(input);

    const fallbackTitle = isDirectUrl
        ? 'Brano YouTube'
        : input.trim() || 'Brano YouTube';

    function baseFlags() {
        const flags = {
            noWarnings: true,
            jsRuntimes: 'node',
            remoteComponents: 'ejs:github',

            // Rendiamo yt-dlp piu' tollerante ai problemi temporanei.
            extractorRetries: 3,
            retries: 3,
            fragmentRetries: 3,
            socketTimeout: 20
        };

        if (fs.existsSync('./cookies.txt')) {
            flags.cookies = './cookies.txt';
        }

        return flags;
    }

    function parseInfo(output) {
        if (!output) return null;

        let info = output;

        if (typeof info === 'string') {
            const trimmed = info.trim();

            if (!trimmed) return null;

            try {
                info = JSON.parse(trimmed);
            } catch {
                return null;
            }
        }

        // ytsearch puo' restituire un contenitore playlist.
        if (Array.isArray(info?.entries)) {
            info = info.entries.find(Boolean) || null;
        }

        return info && typeof info === 'object'
            ? info
            : null;
    }

    function pickStreamUrl(info) {
        if (!info) return null;

        // Caso migliore: yt-dlp ci ha gia' dato il formato selezionato.
        if (
            typeof info.url === 'string' &&
            /^https?:\/\//i.test(info.url)
        ) {
            return info.url;
        }

        const collections = [
            info.requested_downloads,
            info.requested_formats,
            info.formats
        ];

        for (const collection of collections) {
            if (!Array.isArray(collection)) continue;

            // Prima preferiamo un formato solo audio.
            const audioOnly = collection.find(format =>
                typeof format?.url === 'string' &&
                /^https?:\/\//i.test(format.url) &&
                format.acodec &&
                format.acodec !== 'none' &&
                (!format.vcodec || format.vcodec === 'none')
            );

            if (audioOnly) {
                return audioOnly.url;
            }

            // Ma se non esiste, va bene anche audio+video.
            // FFmpeg estrarra' semplicemente la traccia audio.
            const anyPlayable = collection.find(format =>
                typeof format?.url === 'string' &&
                /^https?:\/\//i.test(format.url) &&
                (!format.acodec || format.acodec !== 'none')
            );

            if (anyPlayable) {
                return anyPlayable.url;
            }
        }

        return null;
    }

    function getHttpHeadersForStream(info, selectedUrl) {
        if (!info || !selectedUrl) return null;

        const candidates = [
            info,
            ...(Array.isArray(info.requested_downloads) ? info.requested_downloads : []),
            ...(Array.isArray(info.requested_formats) ? info.requested_formats : []),
            ...(Array.isArray(info.formats) ? info.formats : [])
        ];

        // Preferiamo gli header del formato che possiede esattamente
        // l'URL che poi passeremo a FFmpeg.
        const exact = candidates.find(candidate =>
            candidate &&
            candidate.url === selectedUrl &&
            candidate.http_headers &&
            typeof candidate.http_headers === 'object'
        );

        const source = exact || (
            info.http_headers &&
                typeof info.http_headers === 'object'
                ? info
                : null
        );

        if (!source?.http_headers) return null;

        const headers = {};

        for (const [key, value] of Object.entries(source.http_headers)) {
            if (value == null) continue;

            const cleanKey = String(key).replace(/[\r\n:]/g, '').trim();
            const cleanValue = String(value).replace(/[\r\n]+/g, ' ').trim();

            if (cleanKey && cleanValue) {
                headers[cleanKey] = cleanValue;
            }
        }

        return Object.keys(headers).length
            ? headers
            : null;
    }

    function normalizeResult(
        info,
        hints = {},
        forcedUrl = null
    ) {
        const url =
            forcedUrl ||
            pickStreamUrl(info);

        // L'URL riproducibile resta l'unico dato realmente obbligatorio.
        if (!url) {
            return null;
        }

        const title =
            info?.title?.trim?.() ||
            hints.title?.trim?.() ||
            fallbackTitle;

        const channel =
            info?.channel?.trim?.() ||
            info?.uploader?.trim?.() ||
            hints.channel?.trim?.() ||
            'YouTube';

        const sourceUrl =
            info?.webpage_url ||
            info?.original_url ||
            (/^https?:\/\//i.test(hints.sourceUrl || '') ? hints.sourceUrl : null);

        const parsedDuration = Number(info?.duration ?? hints.duration);
        const duration = Number.isFinite(parsedDuration) && parsedDuration > 0
            ? parsedDuration
            : null;

        const result = {
            title,
            url,
            channel,
            sourceUrl,
            duration,
            artist: info?.artist || hints.artist || null,
            track: info?.track || hints.track || null,
            album: info?.album || hints.album || null,
            categories: info?.categories || hints.categories || null
        };

        const httpHeaders =
            getHttpHeadersForStream(
                info,
                url
            );

        const playbackContext = {
            httpHeaders,
            sourceUrl:
                sourceUrl ||
                hints.sourceUrl ||
                null,
            createdAt: Date.now()
        };

        streamPlaybackContext.set(
            url,
            playbackContext
        );

        // Evita che la Map cresca indefinitamente su un bot 24/7.
        while (streamPlaybackContext.size > 250) {
            const oldestKey =
                streamPlaybackContext.keys().next().value;

            if (!oldestKey) break;
            streamPlaybackContext.delete(oldestKey);
        }

        dynamicText.rememberMetadata(result);
        return result;
    }

    function getErrorText(err) {
        return String(
            err?.stderr ||
            err?.stdout ||
            err?.message ||
            err ||
            'errore sconosciuto'
        ).trim();
    }

    async function resolveTarget(
        target,
        hints = {},
        attempts = 1
    ) {
        let lastError = null;

        for (
            let attempt = 1;
            attempt <= attempts;
            attempt++
        ) {

            // ==================================================
            // A) METADATI JSON
            // ==================================================
            //
            // Proviamo prima il formato audio migliore.
            // Poi accettiamo anche "best" audio+video.
            //
            // L'importante e' trovare un URL che FFmpeg possa
            // aprire.

            for (const format of [
                'bestaudio/best',
                'best'
            ]) {
                try {
                    const flags = {
                        ...baseFlags(),
                        dumpSingleJson: true,
                        format,
                        noPlaylist: true
                    };

                    const output =
                        await youtubeDl(target, flags);

                    const info =
                        parseInfo(output);

                    const result =
                        normalizeResult(info, hints);

                    if (result) {
                        if (
                            !info?.title ||
                            !(info?.channel || info?.uploader)
                        ) {
                            console.warn(
                                `[YT] Flusso trovato con metadati parziali: ${result.channel} - ${result.title}`
                            );
                        }

                        return result;
                    }

                } catch (err) {
                    lastError = err;

                    console.warn(
                        `[YT] JSON ${format} fallito ` +
                        `(${attempt}/${attempts}): ` +
                        getErrorText(err)
                            .split(/\r?\n/)[0]
                    );
                }
            }

            // ==================================================
            // B) SOLO URL
            // ==================================================
            //
            // Qui titolo, channel ecc. non ci interessano.
            //
            // Se yt-dlp riesce a fornirci un URL del flusso,
            // NOI LO RIPRODUCIAMO.

            for (const format of [
                'bestaudio/best',
                'best'
            ]) {
                try {
                    const flags = {
                        ...baseFlags(),
                        getUrl: true,
                        format,
                        noPlaylist: true
                    };

                    const output =
                        await youtubeDl(target, flags);

                    const lines =
                        String(output || '')
                            .split(/\r?\n/)
                            .map(line => line.trim())
                            .filter(Boolean);

                    const streamUrl =
                        lines.find(line =>
                            /^https?:\/\//i.test(line)
                        );

                    if (streamUrl) {
                        const result =
                            normalizeResult(
                                null,
                                hints,
                                streamUrl
                            );

                        console.warn(
                            `[YT] Fallback senza metadati completi: ` +
                            `${result.channel} - ${result.title}`
                        );

                        return result;
                    }

                } catch (err) {
                    lastError = err;

                    console.warn(
                        `[YT] get-url ${format} fallito ` +
                        `(${attempt}/${attempts}): ` +
                        getErrorText(err)
                            .split(/\r?\n/)[0]
                    );
                }
            }

            // Piccola pausa prima di un secondo tentativo.
            if (attempt < attempts) {
                await new Promise(
                    resolve =>
                        setTimeout(resolve, 750)
                );
            }
        }

        throw (
            lastError ||
            new Error(
                'Nessun flusso riproducibile trovato.'
            )
        );
    }

    // ==========================================================
    // LINK DIRETTO
    // ==========================================================
    //
    // Non sostituiamo arbitrariamente il video scelto
    // dall'utente.
    //
    // Proviamo pero' due volte e accettiamo anche un flusso
    // privo di titolo/canale.

    if (isDirectUrl) {
        try {
            return await resolveTarget(
                input,
                {
                    title: fallbackTitle,
                    sourceUrl: input
                },
                2
            );

        } catch (err) {
            throw new Error(
                `Il video indicato non espone al momento ` +
                `un flusso riproducibile. ` +
                `Ultimo errore yt-dlp: ` +
                getErrorText(err)
            );
        }
    }

    // ==========================================================
    // RICERCA TESTUALE
    // ==========================================================
    //
    // Invece di fermarci al primo risultato YouTube,
    // recuperiamo CINQUE candidati.
    //
    // Se il primo e' bloccato, privato, una Premiere,
    // age restricted, ecc. passiamo al successivo.

    let candidates = [];

    try {
        const searchFlags = {
            ...baseFlags(),

            dumpSingleJson: true,
            flatPlaylist: true,
            skipDownload: true,
            ignoreErrors: true
        };

        const searchOutput =
            await youtubeDl(
                `ytsearch5:${input}`,
                searchFlags
            );

        let searchInfo = searchOutput;

        if (typeof searchInfo === 'string') {
            try {
                searchInfo =
                    JSON.parse(searchInfo.trim());
            } catch {
                searchInfo = null;
            }
        }

        const entries =
            Array.isArray(searchInfo?.entries)
                ? searchInfo.entries.filter(Boolean)
                : [];

        candidates =
            entries
                .map(entry => {
                    let target = null;

                    if (
                        typeof entry.webpage_url === 'string' &&
                        /^https?:\/\//i.test(
                            entry.webpage_url
                        )
                    ) {
                        target = entry.webpage_url;

                    } else if (
                        typeof entry.original_url === 'string' &&
                        /^https?:\/\//i.test(
                            entry.original_url
                        )
                    ) {
                        target = entry.original_url;

                    } else if (
                        typeof entry.url === 'string' &&
                        /^https?:\/\//i.test(entry.url)
                    ) {
                        target = entry.url;

                    } else if (entry.id) {
                        target =
                            `https://www.youtube.com/watch?v=${entry.id}`;
                    }

                    if (!target) {
                        return null;
                    }

                    return {
                        target,
                        sourceUrl: target,

                        title:
                            entry.title ||
                            fallbackTitle,

                        channel:
                            entry.channel ||
                            entry.uploader ||
                            'YouTube',

                        duration: entry.duration || null,
                        artist: entry.artist || null,
                        track: entry.track || null,
                        album: entry.album || null,
                        categories: entry.categories || null
                    };
                })
                .filter(Boolean);

    } catch (err) {
        console.warn(
            `[YT] Ricerca multipla fallita. ` +
            `Provo comunque ytsearch1: ` +
            getErrorText(err)
                .split(/\r?\n/)[0]
        );
    }

    let lastSearchError = null;

    // ==========================================================
    // PROVA I RISULTATI UNO ALLA VOLTA
    // ==========================================================

    for (
        let i = 0;
        i < candidates.length;
        i++
    ) {
        const candidate =
            candidates[i];

        try {
            const result =
                await resolveTarget(
                    candidate.target,
                    {
                        title:
                            candidate.title,

                        channel:
                            candidate.channel,

                        sourceUrl:
                            candidate.sourceUrl,

                        duration:
                            candidate.duration,

                        artist:
                            candidate.artist,

                        track:
                            candidate.track,

                        album:
                            candidate.album,

                        categories:
                            candidate.categories
                    },
                    1
                );

            if (i > 0) {
                console.log(
                    `[YT] Risultato #1 non utilizzabile. ` +
                    `Riproduco il risultato #${i + 1}.`
                );
            }

            return result;

        } catch (err) {
            lastSearchError = err;

            console.warn(
                `[YT] Risultato #${i + 1} ` +
                `non riproducibile. ` +
                `Provo il successivo.`
            );
        }
    }

    // ==========================================================
    // ULTIMA RETE DI SICUREZZA
    // ==========================================================
    //
    // Anche se la ricerca multipla non ha funzionato,
    // lasciamo a yt-dlp un ultimo tentativo diretto.

    try {
        return await resolveTarget(
            `ytsearch1:${input}`,
            {
                title: fallbackTitle,
                channel: 'YouTube'
            },
            2
        );

    } catch (err) {
        const finalError =
            err ||
            lastSearchError;

        throw new Error(
            `Nessuno dei risultati YouTube provati ` +
            `espone un flusso riproducibile. ` +
            `Ultimo errore yt-dlp: ` +
            getErrorText(finalError)
        );
    }
}

async function updateYtDlp() {
    try {
        const result = await youtubeDl.update();
        const text = [result?.stdout, result?.stderr].filter(Boolean).join(' ').trim();
        console.log(`✅ yt-dlp aggiornato${text ? `: ${text}` : ''}`);
    } catch (err) {
        // Non impediamo l'avvio: se l'update fallisce, proviamo comunque col binario installato.
        console.warn('⚠️ Impossibile aggiornare yt-dlp automaticamente:', err?.stderr || err?.message || err);
    }
}

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const players = new Map();
const mediaHubSessions = new Map();
const mediaHubMessages = new Map();
const AUTO_JOIN_ID = "901131299794849862";
const MEDIA_HUB_CHANNEL_ID = '1021078303412584539';
const JUMPSCARE_URL = "https://www.youtube.com/watch?v=qA1ihB1Vedg"; // Cristiano Malgioglio - Quanti uccelli in aria

// PLAYLIST PERSONALIZZATA DI CRISTIANO MALGIOGLIO
const MALGIOGLIO_PLAYLIST = [
    { title: "Mi sono innamorato ma di tuo marito", url: "https://youtu.be/IGh2Sgyli8I?list=RDIGh2Sgyli8I" },
    { title: "Sucu Sucu", url: "https://youtu.be/zso_jpGUdTk" },
    { title: "Fernando", url: "https://youtu.be/m8aU5NyuWCs?list=RDm8aU5NyuWCs" },
    { title: "Rosa Tormento", url: "https://www.youtube.com/watch?v=xnhin995UWg&list=RDxnhin995UWg&start_radio=1&pp=ygUNcm9zYSB0b3JtZW50b6AHAQ%3D%3D" },
    { title: "Gelato al cioccolato", url: "https://youtu.be/K1XcMymj_2U?list=RDK1XcMymj_2U" },
    { title: "Dolceamaro", url: "https://www.youtube.com/watch?v=wY_Gb27_qZw&list=RDwY_Gb27_qZw&start_radio=1&pp=ygUKZG9sY2VhbWFyb6AHAQ%3D%3D" },
    { title: "Vita Porno", url: "https://www.youtube.com/watch?v=Htad-2b6xng&list=RDHtad-2b6xng&start_radio=1&pp=ygUKdml0YSBwb3Jub6AHAQ%3D%3D" }
];

function shuffleArray(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// Ottiene la prossima canzone escludendo l'ultima riprodotta
function getNextRouletteSong(state) {
    if (!state.rouletteQueue || state.rouletteQueue.length === 0) {
        state.rouletteQueue = shuffleArray(MALGIOGLIO_PLAYLIST);
    }

    let availableSongs = state.rouletteQueue.filter(song => song.url !== state.lastPlayedSongUrl);

    if (availableSongs.length === 0) {
        availableSongs = [...state.rouletteQueue];
    }

    const nextSong = availableSongs[0];
    state.rouletteQueue = state.rouletteQueue.filter(song => song.url !== nextSong.url);

    return nextSong;
}

// Spostata fuori per essere accessibile globalmente ed evitare ReferenceError
function applyRandomFilter(s) {
    // 1. Reset dei filtri
    s.filters.bassboost = false;
    s.filters.nightcore = false;
    s.filters.vaporwave = false;

    // 2. Bassboost: ha il 50% di probabilità di essere attivato, 
    // indipendentemente dagli altri effetti
    if (Math.random() < 0.5) {
        s.filters.bassboost = true;
    }

    // 3. Nightcore o Vaporwave: sono esclusivi.
    // Usiamo un numero casuale per decidere quale (se nessuno, nightcore o vaporwave)
    const pitchRand = Math.random();
    if (pitchRand < 0.33) {
        s.filters.nightcore = true;
    } else if (pitchRand < 0.66) {
        s.filters.vaporwave = true;
    }
    // Se pitchRand >= 0.66, nessuno dei due viene attivato (effetto "normale" per il pitch)
}

function isPlayerPaused(state) {
    return state?.player?.state?.status === AudioPlayerStatus.Paused;
}

function getPanelStatus(state) {
    return isPlayerPaused(state) ? 'paused' : 'playing';
}

function createMusicPanel(
    title,
    user,
    loopActive = false,
    filters = { bassboost: false, nightcore: false, vaporwave: false, roulette: false },
    status = 'playing',
    playbackState = null
) {
    const paused = status === 'paused';
    const stopped = status === 'stopped';

    const description = stopped
        ? `⏹️ Riproduzione terminata: **${title}**`
        : paused
            ? `⏸️ In pausa: **${title}**`
            : `🎶 In riproduzione: **${title}**`;

    const embed = new EmbedBuilder()
        .setTitle('🎵 SUGNU GIGGETTO VENGU I PALIEMMU')
        .setDescription(dynamicText.decorateDescription(description, playbackState, stopped))
        .addFields(
            { name: '👤 Richiesto da', value: `${user}`, inline: true },
            { name: '🔁 Loop', value: loopActive ? '✅ Attivo' : '❌ Disattivato', inline: true },
            {
                name: '🎛️ Filtri Attivi',
                value: `🔊 Bassboost: ${filters.bassboost ? '✅' : '❌'}\n⚡ Nightcore: ${filters.nightcore ? '✅' : '❌'}\n🌊 Vaporwave: ${filters.vaporwave ? '✅' : '❌'}\n🎰 Malgioglio Roulette: ${filters.roulette ? '🔥 ATTIVA 🔥' : '❌'}`,
                inline: false
            }
        )
        .setColor(stopped ? '#666666' : '#ff0000');

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('pause_res')
            .setLabel(paused ? '▶️ Riprendi' : '⏸️ Pausa')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(stopped),
        new ButtonBuilder().setCustomId('skip_btn').setLabel('⏭️ Skip').setStyle(ButtonStyle.Primary).setDisabled(stopped),
        new ButtonBuilder().setCustomId('loop_btn').setLabel('🔁 Loop').setStyle(loopActive ? ButtonStyle.Success : ButtonStyle.Danger).setDisabled(stopped),
        new ButtonBuilder().setCustomId('stop_btn').setLabel('🛑 Stop').setStyle(ButtonStyle.Danger).setDisabled(stopped)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('filter_bassboost').setLabel('🔊 Bassboost').setStyle(filters.bassboost ? ButtonStyle.Success : ButtonStyle.Danger).setDisabled(stopped),
        new ButtonBuilder().setCustomId('filter_nightcore').setLabel('⚡ Nightcore').setStyle(filters.nightcore ? ButtonStyle.Success : ButtonStyle.Danger).setDisabled(stopped),
        new ButtonBuilder().setCustomId('filter_vaporwave').setLabel('🌊 Vaporwave').setStyle(filters.vaporwave ? ButtonStyle.Success : ButtonStyle.Danger).setDisabled(stopped));

    const transcriptRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('transcript_btn')
            .setLabel('\u{1F4DC} Trascrizione')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(stopped)
    );

    const seekRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('seek_back_10')
            .setLabel('\u23EA 10s')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(stopped),

        new ButtonBuilder()
            .setCustomId('seek_open_modal')
            .setLabel('\u{1F3AF} Vai a...')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(stopped),

        new ButtonBuilder()
            .setCustomId('seek_forward_10')
            .setLabel('10s \u23E9')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(stopped)
    );
    return { embeds: [embed], components: [row1, row2, seekRow, transcriptRow] };
}

async function updateLivePanel(state, status = getPanelStatus(state)) {
    if (state && state.panelMessage && state.current) {
        try {
            await state.panelMessage.edit(
                createMusicPanel(state.current.title, state.current.user, state.loop, state.filters, status, state)
            );
        } catch (err) {
            console.error("Impossibile aggiornare l'embed dinamico:", err.message);
        }
    }
}

async function setVoiceChannelStatus(state, status) {
    const channelId = state?.connection?.joinConfig?.channelId;
    if (!channelId) return false;

    const normalizedStatus = status == null
        ? null
        : String(status).trim().slice(0, 500);

    // Evita richieste REST inutili quando seek/filtri riavviano FFmpeg
    // senza cambiare realmente brano.
    if (state.lastVoiceChannelStatus === normalizedStatus) {
        return true;
    }

    try {
        await client.rest.put(
            Routes.channelVoiceStatus(channelId),
            { body: { status: normalizedStatus } }
        );

        state.lastVoiceChannelStatus = normalizedStatus;
        return true;

    } catch (err) {
        const code = err?.code ?? err?.rawError?.code ?? 'sconosciuto';

        console.warn(
            `Impossibile impostare lo stato del canale vocale ${channelId} (codice ${code}):`,
            err?.message || err
        );

        return false;
    }
}

async function refreshAllMediaHubs() {
    for (const [messageId, message] of mediaHubMessages.entries()) {
        if (!message) {
            mediaHubMessages.delete(messageId);
            mediaHubSessions.delete(messageId);
            continue;
        }

        const currentSession =
            mediaHubSessions.get(messageId) || {
                category: 'popular',
                page: 0,
                query: ''
            };

        try {
            const hub = buildMediaHub(currentSession);
            await message.edit(hub.payload);
            mediaHubSessions.set(messageId, hub.state);
        } catch (err) {
            console.warn(`[MEDIA HUB] Rimozione sessione non piu aggiornabile ${messageId}:`, err.message);
            mediaHubMessages.delete(messageId);
            mediaHubSessions.delete(messageId);
        }
    }
}

client.once(Events.ClientReady, async () => {
    // ========================================================
    // MEDIA HUB AUTOMATICO ALL'AVVIO
    // ========================================================

    try {

        // =================================================
        // TITOLI REALI YOUTUBE - STARTUP
        // =================================================
        //
        // Prima di costruire il Media Hub recuperiamo
        // eventuali titoli YouTube ancora mancanti.
        //
        // Se YouTube/yt-dlp falliscono, il bot continua
        // normalmente usando il titolo interno del catalogo.

        try {

            await refreshMediaTitles();

        } catch (titleErr) {

            console.warn(
                '[MEDIA HUB] Refresh titoli startup fallito:',
                titleErr?.message || titleErr
            );
        }
        const mediaHubChannel =
            await client.channels.fetch(
                MEDIA_HUB_CHANNEL_ID
            );

        if (
            mediaHubChannel &&
            mediaHubChannel.isTextBased()
        ) {

            const startupHub =
                buildMediaHub({
                    category: 'popular',
                    page: 0,
                    query: ''
                });

            const startupHubMessage =
                await mediaHubChannel.send(
                    startupHub.payload
                );

            mediaHubSessions.set(
                startupHubMessage.id,
                startupHub.state
            );
            mediaHubMessages.set(
                startupHubMessage.id,
                startupHubMessage
            );

            console.log(
                `Media Hub inviato automaticamente in #${mediaHubChannel.name}`
            );

        } else {

            console.warn(
                `MEDIA_HUB_CHANNEL_ID ${MEDIA_HUB_CHANNEL_ID} non e' un canale testuale.`
            );
        }

    } catch (err) {

        console.error(
            'Invio automatico Media Hub fallito:',
            err
        );
    }

    console.log(`🚀 BOT ONLINE: ${client.user.tag}`);

    try {
        await client.application.commands.set([
            {
                name: 'play',
                description: 'Riproduci musica (Titolo o Link)',
                options: [{ name: 'query', type: ApplicationCommandOptionType.String, description: 'Cosa vuoi ascoltare?', required: true }]
            },
            { name: 'libreria', description: 'Apri IURP Media Hub' },
            ...MEDIA_ADMIN_COMMANDS,
            { name: 'pausa', description: 'Mette in pausa la musica' },
            { name: 'riprendi', description: 'Riprende la riproduzione' },
            { name: 'skip', description: 'Salta il brano corrente' },
            { name: 'loop', description: 'Attiva/Disattiva il loop' },
            { name: 'stop', description: 'Ferma la musica' },
            { name: 'bassboost', description: 'Attiva/Disattiva l\'effetto Bass Boost' },
            { name: 'nightcore', description: 'Attiva/Disattiva l\'effetto Nightcore' },
            { name: 'vaporwave', description: 'Attiva/Disattiva l\'effetto Vaporwave' },
            { name: 'roulette', description: 'Attiva il Remix Roulette ULTRA CAOTICO di Cristiano Malgioglio!' },
            {
                name: 'pausain',
                description: 'Mette in pausa tra X secondi',
                options: [{ name: 'secondi', type: ApplicationCommandOptionType.Integer, description: 'Secondi?', required: true, minValue: 1 }]
            },
            {
                name: 'avanti',
                description: 'Salta avanti di X secondi',
                options: [{ name: 'secondi', type: ApplicationCommandOptionType.Integer, description: 'Secondi?', required: true, minValue: 1 }]
            },
            {
                name: 'indietro',
                description: 'Torna indietro di X secondi',
                options: [{ name: 'secondi', type: ApplicationCommandOptionType.Integer, description: 'Secondi?', required: true, minValue: 1 }]
            }
        ]);
        console.log('✅ Slash command sincronizzati.');
    } catch (e) {
        console.error('❌ Errore durante la sincronizzazione degli slash command:', e);
    }

    try {
        const channel = await client.channels.fetch(AUTO_JOIN_ID);
        if (channel?.isVoiceBased()) {
            joinVoiceChannel({
                channelId: channel.id,
                guildId: channel.guild.id,
                adapterCreator: channel.guild.voiceAdapterCreator,
            });
        } else if (channel) {
            console.warn(`⚠️ AUTO_JOIN_ID ${AUTO_JOIN_ID} non punta a un canale vocale.`);
        }
    } catch (e) {
        console.log("❌ Errore auto-join:", e.message);
    }
});


client.on(Events.InteractionCreate, async (interaction) => {
    const guildId = interaction.guildId;
    let state = players.get(guildId);

    if (await handleLibraryAdminAutocomplete(interaction)) {
        return;
    }

    if (await handleLibraryAdminButton(interaction, { refreshHubs: refreshAllMediaHubs })) {
        return;
    }

    if (await handleLibraryAdminCommand(interaction, { refreshHubs: refreshAllMediaHubs })) {
        return;
    }

    if (
        (interaction.isButton() || interaction.isStringSelectMenu()) &&
        interaction.customId?.startsWith('media_') &&
        interaction.message
    ) {
        mediaHubMessages.set(interaction.message.id, interaction.message);
    }

    function getActualSeek(s) {
        if (!s) return 0;

        const playbackMilliseconds = Number(s.player?.state?.playbackDuration || 0);

        let speedModifier = 1.0;
        if (s.filters.nightcore) speedModifier = 1.25;
        else if (s.filters.vaporwave) speedModifier = 0.75;

        return Math.max(0, (s.currentSeek || 0) + ((playbackMilliseconds / 1000) * speedModifier));
    }

    function clearPauseTimer(s) {
        if (s?.pauseTimeout) {
            clearTimeout(s.pauseTimeout);
            s.pauseTimeout = null;
        }
    }

    function scheduleRouletteEffect(guildId) {
        const s = players.get(guildId);
        if (!s || !s.filters.roulette || s.isHandlingJumpscare || isPlayerPaused(s)) return;

        if (s.rouletteTimeout) clearTimeout(s.rouletteTimeout);

        const delay = (Math.floor(Math.random() * 3) + 18) * 1000;
        s.rouletteTimeout = setTimeout(() => {
            s.rouletteTimeout = null;
            triggerSurpriseEffect(guildId).catch(err => {
                console.error('❌ Errore timer Roulette:', err);
            });
        }, delay);
    }

    function pauseState(s, guildId) {
        if (!s?.current) return false;
        const paused = s.player.pause();

        if (paused && s.rouletteTimeout) {
            clearTimeout(s.rouletteTimeout);
            s.rouletteTimeout = null;
        }

        return paused;
    }

    function resumeState(s, guildId) {
        if (!s?.current) return false;
        const resumed = s.player.unpause();

        if (resumed && s.filters.roulette) {
            scheduleRouletteEffect(guildId);
        }

        return resumed;
    }

    function attachPlayerListeners(player, guildId) {
        player.on(AudioPlayerStatus.Idle, () => {
            handleNext(guildId).catch(err => {
                console.error(`❌ Errore gestione Idle [${guildId}]:`, err);
            });
        });

        player.on('stateChange', (oldState, newState) => {
            if (oldState.status !== newState.status) {
                console.log(`[AUDIO ${guildId}] ${oldState.status} -> ${newState.status}`);
            }
        });

        player.on('error', err => {
            console.error(`❌ AudioPlayer error [${guildId}]:`, err);
        });
    }

    function instrumentVoiceConnection(connection, guildId, label = 'voice') {
        if (!connection || connection.__iurpDiagnosticsAttached) return connection;
        connection.__iurpDiagnosticsAttached = true;

        console.log(`[VOICE ${guildId}] ${label}: stato iniziale = ${connection.state.status}`);

        connection.on('stateChange', (oldState, newState) => {
            if (oldState.status !== newState.status) {
                console.log(`[VOICE ${guildId}] ${label}: ${oldState.status} -> ${newState.status}`);
            }
        });

        connection.on('error', err => {
            console.error(
                `[VOICE ${guildId}] ${label}: errore connessione:`,
                err?.stack || err?.message || err
            );
        });

        return connection;
    }

    async function waitForVoiceReady(connection, guildId, label = 'voice') {
        instrumentVoiceConnection(connection, guildId, label);

        if (connection.state.status === VoiceConnectionStatus.Ready) {
            console.log(`[VOICE ${guildId}] ${label}: READY`);
            return connection;
        }

        try {
            await entersState(connection, VoiceConnectionStatus.Ready, 20000);
            console.log(`[VOICE ${guildId}] ${label}: READY`);
            return connection;
        } catch (err) {
            const status = connection?.state?.status || 'unknown';
            console.error(
                `[VOICE ${guildId}] ${label}: NON ha raggiunto READY entro 20s. Stato finale: ${status}`
            );
            throw new Error(`Connessione vocale Discord non pronta (stato: ${status})`);
        }
    }

    async function connectStateToVoiceChannel(s, voiceChannel, guild) {
        const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
        });

        await waitForVoiceReady(connection, guild.id, 'reconnect');

        connection.subscribe(s.player);
        s.connection = connection;
        return connection;
    }

    function isStateInVoiceChannel(s, voiceChannel) {
        const currentChannelId = s?.connection?.joinConfig?.channelId;
        return !currentChannelId || currentChannelId === voiceChannel.id;
    }

    async function handleUnifiedPlayRequest(interaction, query) {
        const voiceChannel = interaction.member.voice.channel;
        if (!voiceChannel) return interaction.editReply("❌ Devi essere in un vocale!");

        if (state?.current && !isStateInVoiceChannel(state, voiceChannel)) {
            return interaction.editReply("❌ Il bot sta già riproducendo musica in un altro canale vocale.");
        }

        try {
            const { title: actualTitle, url: finalUrl, channel: youtubeChannel } = await extractAudioInfo(query);

            if (!state) {
                const player = createAudioPlayer();
                const connection = joinVoiceChannel({
                    channelId: voiceChannel.id,
                    guildId: guildId,
                    adapterCreator: interaction.guild.voiceAdapterCreator,
                });

                await waitForVoiceReady(connection, guildId, 'play');

                connection.subscribe(player);

                state = {
                    player, connection, queue: [],
                    current: { url: finalUrl, title: actualTitle, channel: youtubeChannel, user: interaction.user },
                    loop: false, process: null, textChannel: interaction.channel, currentSeek: 0,
                    filters: { bassboost: false, nightcore: false, vaporwave: false, roulette: false },
                    isHandlingJumpscare: false,
                    lastPlayedSongUrl: null,
                    panelMessage: null,
                    pauseTimeout: null,
                    rouletteTimeout: null
                };
                players.set(guildId, state);

                attachPlayerListeners(player, guildId);
                await playResource(guildId, finalUrl, actualTitle, 0);
                state.panelMessage = await interaction.editReply(createMusicPanel(actualTitle, interaction.user, false, state.filters, getPanelStatus(state), state));
            } else if (!state.current) {
                await connectStateToVoiceChannel(state, voiceChannel, interaction.guild);
                state.current = { url: finalUrl, title: actualTitle, channel: youtubeChannel, user: interaction.user };
                state.textChannel = interaction.channel;
                state.filters = { bassboost: false, nightcore: false, vaporwave: false, roulette: false };

                await playResource(guildId, finalUrl, actualTitle, 0);
                state.panelMessage = await interaction.editReply(createMusicPanel(actualTitle, interaction.user, state.loop, state.filters, getPanelStatus(state), state));
            } else {
                state.queue.push({ url: finalUrl, title: actualTitle, channel: youtubeChannel, user: interaction.user });
                await interaction.editReply(`✅ In coda: **${actualTitle}**`);
            }
        } catch (e) {
            console.error('❌ [PLAY] Errore yt-dlp/FFmpeg:', e?.stderr || e?.message || e);
            await interaction.editReply(`❌ Errore di riproduzione. Controlla la console del bot per il dettaglio.`);
        }
    }

    async function playResource(guildId, url, title, seek = 0, isJumpscareActive = false) {
        const s = players.get(guildId);
        if (!s) return;

        const oldProcess = s.process;
        s.currentSeek = Math.max(0, seek);

        dynamicText.mergeMetadata(url, s.current);
        if (s.current?.title) {
            title = s.current.title;
        }

        const youtubeChannel = s.current?.channel || 'YouTube';
        const playbackLabel = `${youtubeChannel} - ${title}`;

        try {
            let presenceText = playbackLabel;

            // Discord limita la lunghezza del nome dell'attivita'.
            if (presenceText.length > 128) {
                presenceText = `${presenceText.slice(0, 125)}...`;
            }

            client.user.setPresence({
                activities: [
                    {
                        name: presenceText,
                        type: ActivityType.Listening
                    }
                ],
                status: 'online'
            });
        } catch (err) {
            console.error("Errore nell'impostazione della presenza:", err.message);
        }

        // Aggiorna anche lo stato visualizzato direttamente sul canale vocale.
        // L'errore viene gestito internamente e non interrompe la riproduzione.
        await setVoiceChannelStatus(s, playbackLabel);

        const filterArgs = [];

        if (isJumpscareActive) {
            filterArgs.push('anequalizer=c0 f=1000 w=200 g=15|c1 f=1000 w=200 g=15,highpass=f=150,acontrast=30,volume=5.5');
        } else {
            if (s.filters.bassboost) {
                filterArgs.push(
                    'volume=0.44,' +
                    'anequalizer=' +

                    // Sub-bass molto forte
                    'c0 f=52 w=95 g=17|' +
                    'c1 f=52 w=95 g=17|' +

                    // Basso principale / punch
                    'c0 f=125 w=155 g=10|' +
                    'c1 f=125 w=155 g=10|' +

                    // Un minimo di corpo senza impastare
                    'c0 f=240 w=220 g=1.5|' +
                    'c1 f=240 w=220 g=1.5|' +

                    // Mantiene voce, piatti e dettagli nitidi
                    'c0 f=4800 w=3000 g=2.5|' +
                    'c1 f=4800 w=3000 g=2.5,' +

                    // Protezione contro clipping/gracchi
                    'alimiter=level_in=1:level_out=1:limit=0.95:attack=3:release=70:asc=1'
                );
            }
            if (s.filters.nightcore) {
                filterArgs.push('asetrate=48000*1.25,aresample=48000');
            } else if (s.filters.vaporwave) {
                filterArgs.push('asetrate=48000*0.75,aresample=48000');
            }
        }

        const playbackContext =
            streamPlaybackContext.get(url) ||
            {};

        const requestHeaders = {
            ...(playbackContext.httpHeaders || {})
        };

        const hasHeader = name =>
            Object.keys(requestHeaders)
                .some(key =>
                    key.toLowerCase() === name.toLowerCase()
                );

        // yt-dlp normalmente fornisce gia' User-Agent e altri header.
        // Questi fallback servono soprattutto per il percorso get-url.
        if (!hasHeader('User-Agent')) {
            requestHeaders['User-Agent'] =
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                'Chrome/151.0.0.0 Safari/537.36';
        }

        if (!hasHeader('Referer')) {
            requestHeaders['Referer'] =
                playbackContext.sourceUrl &&
                    /^https?:\/\//i.test(playbackContext.sourceUrl)
                    ? playbackContext.sourceUrl
                    : 'https://www.youtube.com/';
        }

        const headerBlob =
            Object.entries(requestHeaders)
                .filter(([key]) =>
                    !['host', 'content-length', 'range']
                        .includes(key.toLowerCase())
                )
                .map(([key, value]) =>
                    `${key}: ${String(value).replace(/[\r\n]+/g, ' ')}\r\n`
                )
                .join('');

        const ffmpegArgs = [
            '-hide_banner', '-loglevel', 'warning'
        ];

        if (headerBlob) {
            ffmpegArgs.push(
                '-headers',
                headerBlob
            );
        }

        ffmpegArgs.push(
            '-reconnect', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '5',
            '-ss', s.currentSeek.toString(),
            '-i', url
        );

        try {
            const inputHost =
                new URL(url).hostname;

            console.log(
                `[FFMPEG ${guildId}] input=${inputHost} ` +
                `headers=${Object.keys(requestHeaders).join(',') || 'nessuno'}`
            );
        } catch {
            console.log(
                `[FFMPEG ${guildId}] input URL non analizzabile`
            );
        }

        if (filterArgs.length > 0) {
            ffmpegArgs.push('-af', filterArgs.join(','));
        }

        ffmpegArgs.push('-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1');

        const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
        let ffmpegError = '';

        ffmpegProcess.stderr.on('data', chunk => {
            const text =
                chunk.toString();

            ffmpegError =
                (ffmpegError + text)
                    .slice(-6000);
        });

        ffmpegProcess.on('error', err => {
            console.error('❌ Impossibile avviare FFmpeg:', err);
        });

        ffmpegProcess.on('close', (code, signal) => {
            if (s.process === ffmpegProcess) {
                s.process = null;
            }

            const stderrText =
                ffmpegError.trim();

            console.log(
                `[FFMPEG ${guildId}] chiuso: ` +
                `code=${code ?? 'null'} ` +
                `signal=${signal || 'none'} ` +
                `killed=${ffmpegProcess.killed}`
            );

            if (
                stderrText &&
                !ffmpegProcess.killed
            ) {
                console.warn(
                    `[FFMPEG ${guildId}] stderr: ${stderrText}`
                );
            }

            if (
                code &&
                !ffmpegProcess.killed
            ) {
                console.error(
                    `❌ FFmpeg terminato con codice ${code}`
                );
            }
        });

        const resource = createAudioResource(ffmpegProcess.stdout, {
            inputType: StreamType.Raw,
            inlineVolume: true
        });

        try {
            // Sostituiamo prima la risorsa nel player e solo dopo chiudiamo il vecchio
            // processo: evita falsi eventi Idle durante seek/cambio filtro.
            s.player.play(resource);
            s.process = ffmpegProcess;

            if (oldProcess && oldProcess !== ffmpegProcess && !oldProcess.killed) {
                oldProcess.kill();
            }

            dynamicText.start(
                s,
                () => updateLivePanel(s),
                () => isPlayerPaused(s)
            );
        } catch (err) {
            if (!ffmpegProcess.killed) ffmpegProcess.kill();
            throw err;
        }
    }

    async function triggerMalgioglioJumpscare(guildId) {
        const s = players.get(guildId);
        if (!s || s.isHandlingJumpscare || !s.current) return;

        s.isHandlingJumpscare = true;
        console.log(`⚠️ [JUMPSCARE] Estrazione 10% colpita nel cambio effetto! Avvio Malgioglio Earrape.`);

        if (s.rouletteTimeout) {
            clearTimeout(s.rouletteTimeout);
            s.rouletteTimeout = null;
        }

        const savedTrack = { ...s.current };
        const savedSeek = Math.floor(getActualSeek(s));
        let idleListenerWasReplaced = false;

        try {
            const { url: finalJumpscareUrl, channel: youtubeChannel } = await extractAudioInfo(JUMPSCARE_URL);

            // Rimuoviamo l'handler Idle normale solo quando siamo certi di poter
            // avviare il jumpscare. In questo modo un errore yt-dlp non duplica listener.
            s.player.removeAllListeners(AudioPlayerStatus.Idle);
            idleListenerWasReplaced = true;

            s.current = {
                title: "🔥 MALGIOGLIO JUMPSCARE: QUANTI UCCELLI IN ARIA!!! 🔥",
                url: finalJumpscareUrl,
                channel: youtubeChannel,
                user: client.user
            };
            await updateLivePanel(s);

            await playResource(guildId, finalJumpscareUrl, s.current.title, 0, true);

            s.player.once(AudioPlayerStatus.Idle, async () => {
                try {
                    // Se nel frattempo è stato eseguito Stop, non "resuscitiamo"
                    // il brano salvato.
                    if (!s.filters.roulette || !s.isHandlingJumpscare) {
                        s.isHandlingJumpscare = false;
                        return;
                    }

                    console.log(`[JUMPSCARE] Fine effetto shock. Ripristino del brano originario.`);

                    s.isHandlingJumpscare = false;
                    s.current = savedTrack;
                    applyRandomFilter(s);
                    s.isSecondHalf = true;

                    await playResource(guildId, s.current.url, s.current.title, savedSeek);
                    await updateLivePanel(s);
                    scheduleRouletteEffect(guildId);
                } catch (err) {
                    console.error('❌ Errore nel ripristino dopo il jumpscare:', err);
                    s.isHandlingJumpscare = false;
                } finally {
                    // Garantiamo sempre un solo handler Idle normale.
                    s.player.removeAllListeners(AudioPlayerStatus.Idle);
                    s.player.on(AudioPlayerStatus.Idle, () => {
                        handleNext(guildId).catch(err => {
                            console.error(`❌ Errore gestione Idle [${guildId}]:`, err);
                        });
                    });
                }
            });

        } catch (err) {
            console.error("Errore durante l'esecuzione del jumpscare:", err);
            s.isHandlingJumpscare = false;

            if (idleListenerWasReplaced) {
                s.player.removeAllListeners(AudioPlayerStatus.Idle);
                s.player.on(AudioPlayerStatus.Idle, () => {
                    handleNext(guildId).catch(innerErr => {
                        console.error(`❌ Errore gestione Idle [${guildId}]:`, innerErr);
                    });
                });
            }

            scheduleRouletteEffect(guildId);
        }
    }

    async function triggerSurpriseEffect(guildId) {
        const s = players.get(guildId);
        if (!s || !s.filters.roulette || s.isHandlingJumpscare || isPlayerPaused(s)) return;

        if (s.isSecondHalf) {
            s.isSecondHalf = false;

            if (s.current) {
                s.lastPlayedSongUrl = s.current.url;
            }

            const randomSong = getNextRouletteSong(s);
            const randomSeek = Math.floor(Math.random() * 60) + 30;

            try {
                const { title: actualTitle, url: finalUrl, channel: youtubeChannel } = await extractAudioInfo(randomSong.url);

                s.current = { url: finalUrl, title: actualTitle, channel: youtubeChannel, user: client.user };

                applyRandomFilter(s);
                await playResource(guildId, finalUrl, actualTitle, randomSeek);
                await updateLivePanel(s);

            } catch (err) {
                console.error("Errore nel cambio canzone:", err);
            }
        } else {
            if (Math.random() <= 0.10) {
                return triggerMalgioglioJumpscare(guildId);
            }

            if (!s.current) return;

            s.isSecondHalf = true;
            const exactSeek = getActualSeek(s);

            applyRandomFilter(s);
            await playResource(guildId, s.current.url, s.current.title, Math.floor(exactSeek));
            await updateLivePanel(s);
        }
        scheduleRouletteEffect(guildId);
    }

    async function handleNext(guildId) {
        const s = players.get(guildId);
        if (!s || s.isHandlingJumpscare) return;

        if (s.rouletteTimeout) {
            clearTimeout(s.rouletteTimeout);
            s.rouletteTimeout = null;
        }
        clearPauseTimer(s);

        // Se la roulette è attiva, il "prossimo brano" viene scelto dalla playlist dedicata.
        if (s.filters.roulette) {
            s.isSecondHalf = false;

            if (s.current) {
                s.lastPlayedSongUrl = s.current.url;
            }

            const randomSong = getNextRouletteSong(s);
            const randomSeek = Math.floor(Math.random() * 60) + 20;

            try {
                const { title: actualTitle, url: finalUrl, channel: youtubeChannel } = await extractAudioInfo(randomSong.url);

                s.current = { url: finalUrl, title: actualTitle, channel: youtubeChannel, user: client.user };
                applyRandomFilter(s);

                await playResource(guildId, finalUrl, actualTitle, randomSeek);
                await updateLivePanel(s);
            } catch (err) {
                console.error('❌ Errore nel passaggio al prossimo brano Roulette:', err);

                // Il player è già Idle: ritentiamo il passaggio invece di avviare
                // un timer "effetto sorpresa" su una traccia che non sta suonando.
                s.rouletteTimeout = setTimeout(() => {
                    s.rouletteTimeout = null;
                    handleNext(guildId).catch(innerErr => {
                        console.error('❌ Errore retry Roulette:', innerErr);
                    });
                }, 5000);
                return;
            }

            scheduleRouletteEffect(guildId);
            return;
        }

        if (s.loop && s.current) {
            await playResource(guildId, s.current.url, s.current.title, 0);
            await updateLivePanel(s);
            return;
        }

        if (s.queue.length > 0) {
            const next = s.queue.shift();
            s.current = next;

            // Se l'elemento in coda è l'attivatore della modalità Roulette.
            if (next.isRouletteTrigger) {
                s.filters.roulette = true;
                s.rouletteQueue = shuffleArray(MALGIOGLIO_PLAYLIST);
                s.isSecondHalf = false;
                return handleNext(guildId);
            }

            try {
                await playResource(guildId, next.url, next.title, Number(next.startSeek || 0));

                // Manteniamo un solo pannello "vivo" invece di lasciare vecchi
                // messaggi con pulsanti ancora cliccabili.
                if (s.panelMessage) {
                    try {
                        await s.panelMessage.edit(createMusicPanel(next.title, next.user, s.loop, s.filters, getPanelStatus(s), s));
                    } catch (err) {
                        console.warn('⚠️ Vecchio pannello non modificabile, ne creo uno nuovo:', err.message);
                        s.panelMessage = null;
                    }
                }

                if (!s.panelMessage && s.textChannel) {
                    s.panelMessage = await s.textChannel.send(createMusicPanel(next.title, next.user, s.loop, s.filters, getPanelStatus(s), s));
                }
            } catch (err) {
                console.error(`❌ Impossibile avviare il brano in coda "${next.title}":`, err);
                s.current = null;
                return handleNext(guildId);
            }
            return;
        }

        const finishedTrack = s.current;
        const finishedPanel = s.panelMessage;

        dynamicText.stop(s);
        s.current = null;
        s.panelMessage = null;

        if (s.process && !s.process.killed) {
            s.process.kill();
        }
        s.process = null;

        await setVoiceChannelStatus(s, null);
        client.user.setPresence({ activities: [], status: 'online' });

        if (finishedPanel && finishedTrack) {
            try {
                await finishedPanel.edit(
                    createMusicPanel(
                        finishedTrack.title,
                        finishedTrack.user,
                        false,
                        s.filters,
                        'stopped'
                    )
                );
            } catch (err) {
                console.warn('⚠️ Impossibile disattivare il pannello terminato:', err.message);
            }
        }
    }

    function getSeekDurationSeconds(s) {
        const candidates = [
            s?.current?.duration,
            s?.current?.durationSeconds,
            s?.duration,
            s?.dynamicText?.duration,
            s?.current?.dynamicText?.duration,
            s?.textData?.duration,
            s?.current?.textData?.duration
        ];

        for (const candidate of candidates) {
            const value = Number(candidate);

            if (Number.isFinite(value) && value > 0) {
                return value;
            }
        }

        return null;
    }

    function clampSeekPosition(s, seconds) {
        let value = Math.max(0, Number(seconds) || 0);

        const duration = getSeekDurationSeconds(s);

        if (duration) {
            // Evitiamo di posizionarci oltre l'ultimo frame utile.
            const maximum = Math.max(0, duration - 0.25);
            value = Math.min(value, maximum);
        }

        return value;
    }

    function parseSeekInput(value) {
        const raw = String(value || '').trim();

        if (!raw) return null;

        // Solo numero = secondi.
        if (/^\d+$/.test(raw)) {
            return Number(raw);
        }

        const parts = raw.split(':');

        if (parts.length !== 2 && parts.length !== 3) {
            return null;
        }

        if (!parts.every(part => /^\d+$/.test(part))) {
            return null;
        }

        const numbers = parts.map(Number);

        if (parts.length === 2) {
            const [minutes, seconds] = numbers;

            if (seconds >= 60) return null;

            return (minutes * 60) + seconds;
        }

        const [hours, minutes, seconds] = numbers;

        if (minutes >= 60 || seconds >= 60) {
            return null;
        }

        return (
            (hours * 3600) +
            (minutes * 60) +
            seconds
        );
    }

    function formatSeekPosition(seconds) {
        const total = Math.max(
            0,
            Math.floor(Number(seconds) || 0)
        );

        const hours = Math.floor(total / 3600);

        const minutes = Math.floor(
            (total % 3600) / 60
        );

        const secs = total % 60;

        if (hours > 0) {
            return (
                `${hours}:` +
                `${String(minutes).padStart(2, '0')}:` +
                `${String(secs).padStart(2, '0')}`
            );
        }

        return (
            `${minutes}:` +
            `${String(secs).padStart(2, '0')}`
        );
    }

    if (
        interaction.isModalSubmit() &&
        interaction.customId === 'seek_to_modal'
    ) {
        if (!state || !state.current) {
            return interaction.reply({
                content: "Questo brano non e' piu' in riproduzione.",
                flags: MessageFlags.Ephemeral
            });
        }

        if (state.isHandlingJumpscare) {
            return interaction.reply({
                content: "Seek non disponibile durante il jumpscare.",
                flags: MessageFlags.Ephemeral
            });
        }

        const rawValue =
            interaction.fields.getTextInputValue('seek_time');

        const parsed =
            parseSeekInput(rawValue);

        if (
            parsed === null ||
            !Number.isFinite(parsed) ||
            parsed < 0
        ) {
            return interaction.reply({
                content:
                    "Formato non valido. Usa ad esempio 1:35, " +
                    "1:02:30 oppure 95.",
                flags: MessageFlags.Ephemeral
            });
        }

        const target =
            clampSeekPosition(
                state,
                parsed
            );

        const wasPaused =
            isPlayerPaused(state);

        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        try {
            await playResource(
                guildId,
                state.current.url,
                state.current.title,
                target
            );

            if (wasPaused) {
                pauseState(
                    state,
                    guildId
                );
            }

            await updateLivePanel(
                state,
                wasPaused
                    ? 'paused'
                    : 'playing'
            );

            await interaction.editReply(
                `Posizione impostata a ${formatSeekPosition(target)}.`
            );

        } catch (err) {
            console.error(
                'Errore seek tramite modal:',
                err
            );

            await interaction.editReply(
                "Non sono riuscito a spostare la riproduzione."
            );
        }

        return;
    }
    async function playMediaHubItem(
        componentInteraction,
        item
    ) {
        if (!item) {

            return componentInteraction.reply({
                content:
                    "Video non trovato nella libreria.",

                flags:
                    MessageFlags.Ephemeral
            });
        }

        const voiceChannel =
            componentInteraction
                .member
                .voice
                .channel;

        if (!voiceChannel) {

            return componentInteraction.reply({
                content:
                    "Devi essere in un canale vocale per riprodurre un video.",

                flags:
                    MessageFlags.Ephemeral
            });
        }

        if (
            state?.current &&
            !isStateInVoiceChannel(
                state,
                voiceChannel
            )
        ) {

            return componentInteraction.reply({
                content:
                    "Il bot sta gia' riproducendo musica in un altro canale vocale.",

                flags:
                    MessageFlags.Ephemeral
            });
        }

        const wasBusy =
            Boolean(
                state?.current
            );

        const hubMessage =
            componentInteraction.message;

        const hubSession =
            mediaHubSessions.get(
                hubMessage?.id
            ) || {
                category:
                    'popular',

                page:
                    0,

                query:
                    ''
            };

        // Il ranking misura davvero i CLICK nel Media Hub.
        incrementPlay(
            item.id
        );

        // La risposta resta pubblica perche',
        // quando non c'e' musica, questa diventa
        // il vero pannello del player.
        await componentInteraction.deferReply();

        await handleUnifiedPlayRequest(
            componentInteraction,
            item.url
        );

        // Alcuni vecchi comandi partivano da
        // timestamp specifici (?t=...).
        //
        // Manteniamo quel comportamento anche
        // nel nuovo Media Hub.
        if (
            Number(item.start || 0) > 0
        ) {

            if (
                wasBusy &&
                state?.queue?.length
            ) {

                const queued =
                    state.queue[
                    state.queue.length - 1
                    ];

                if (queued) {
                    queued.startSeek =
                        Number(
                            item.start
                        );
                }

            } else if (
                state?.current
            ) {

                state.current.startSeek =
                    Number(
                        item.start
                    );

                await playResource(
                    guildId,
                    state.current.url,
                    state.current.title,
                    Number(item.start)
                );

                await updateLivePanel(
                    state
                );
            }
        }

        // Aggiorna subito il Top 5 dopo il click.
        if (hubMessage) {

            try {

                const refreshed =
                    buildMediaHub(
                        hubSession
                    );

                await hubMessage.edit(
                    refreshed.payload
                );

                mediaHubSessions.set(
                    hubMessage.id,
                    refreshed.state
                );

            } catch (err) {

                console.warn(
                    'Impossibile aggiornare il Media Hub:',
                    err.message
                );
            }
        }
    }


    // ========================================================
    // RICERCA MEDIA HUB
    // ========================================================

    if (
        interaction.isModalSubmit() &&
        interaction.customId.startsWith(
            'media_search_modal:'
        )
    ) {

        const messageId =
            interaction
                .customId
                .split(':')[1];

        const query =
            interaction
                .fields
                .getTextInputValue(
                    'media_search_query'
                )
                .trim();

        const session =
            mediaHubSessions.get(
                messageId
            ) || {
                category:
                    'all',

                page:
                    0,

                query:
                    ''
            };

        const hub =
            buildMediaHub({
                category:
                    session.category ||
                    'all',

                page:
                    0,

                query
            });

        try {

            const hubMessage =
                await interaction
                    .channel
                    .messages
                    .fetch(
                        messageId
                    );

            await hubMessage.edit(
                hub.payload
            );

            mediaHubSessions.set(
                messageId,
                hub.state
            );

        } catch (err) {

            return interaction.reply({
                content:
                    "Non riesco piu' ad aggiornare quel Media Hub.",

                flags:
                    MessageFlags.Ephemeral
            });
        }

        return interaction.reply({
            content:
                query
                    ? `Ricerca aggiornata: ${query}`
                    : 'Ricerca azzerata.',

            flags:
                MessageFlags.Ephemeral
        });
    }


    // ========================================================
    // SELECT MENU MEDIA HUB
    // ========================================================

    if (
        interaction.isStringSelectMenu()
    ) {

        if (
            interaction.customId ===
            'media_category'
        ) {

            const category =
                interaction.values[0];

            const hub =
                buildMediaHub({
                    category,
                    page: 0,
                    query: ''
                });

            mediaHubSessions.set(
                interaction.message.id,
                hub.state
            );

            return interaction.update(
                hub.payload
            );
        }


        if (
            interaction.customId ===
            'media_video'
        ) {

            const itemId =
                interaction.values[0];

            if (
                itemId === '__none__'
            ) {

                return interaction.reply({
                    content:
                        'Nessun video selezionabile in questa pagina.',

                    flags:
                        MessageFlags.Ephemeral
                });
            }

            return playMediaHubItem(
                interaction,
                getMediaItem(
                    itemId
                )
            );
        }
    }


    // ========================================================
    // BUTTON MEDIA HUB
    // ========================================================

    if (
        interaction.isButton() &&
        (
            interaction.customId.startsWith(
                'media_play:'
            ) ||

            interaction.customId ===
            'media_prev' ||

            interaction.customId ===
            'media_next' ||

            interaction.customId ===
            'media_search' ||

            interaction.customId ===
            'media_refresh'
        )
    ) {

        // Top 5 = un solo click.
        if (
            interaction.customId.startsWith(
                'media_play:'
            )
        ) {

            const itemId =
                interaction.customId.slice(
                    'media_play:'.length
                );

            return playMediaHubItem(
                interaction,
                getMediaItem(
                    itemId
                )
            );
        }


        const currentSession =
            mediaHubSessions.get(
                interaction.message.id
            ) || {
                category:
                    'popular',

                page:
                    0,

                query:
                    ''
            };


        // ====================================================
        // CERCA
        // ====================================================

        if (
            interaction.customId ===
            'media_search'
        ) {

            mediaHubSessions.set(
                interaction.message.id,
                currentSession
            );

            const modal =
                new ModalBuilder()
                    .setCustomId(
                        `media_search_modal:${interaction.message.id}`
                    )
                    .setTitle(
                        'Cerca nella libreria'
                    );

            const input =
                new TextInputBuilder()
                    .setCustomId(
                        'media_search_query'
                    )
                    .setLabel(
                        'Titolo, alias o parola chiave'
                    )
                    .setPlaceholder(
                        'es. algero, malgioglio, gelato...'
                    )
                    .setStyle(
                        TextInputStyle.Short
                    )
                    .setRequired(
                        false
                    )
                    .setMaxLength(
                        60
                    );

            modal.addComponents(

                new ActionRowBuilder()
                    .addComponents(
                        input
                    )
            );

            await interaction.showModal(
                modal
            );

            return;
        }


        // ====================================================
        // PAGINAZIONE / REFRESH
        // ====================================================

        const nextState = {
            ...currentSession
        };

        if (
            interaction.customId ===
            'media_prev'
        ) {

            nextState.page =
                Math.max(
                    0,
                    Number(
                        nextState.page ||
                        0
                    ) - 1
                );

        } else if (
            interaction.customId ===
            'media_next'
        ) {

            nextState.page =
                Number(
                    nextState.page ||
                    0
                ) + 1;
        }

        const hub =
            buildMediaHub(
                nextState
            );

        mediaHubSessions.set(
            interaction.message.id,
            hub.state
        );

        return interaction.update(
            hub.payload
        );
    }

    if (interaction.isButton()) {

        // ====================================================
        // CONTROLLI SEEK
        // ====================================================

        const isSeekControl =
            interaction.customId === 'seek_back_10' ||
            interaction.customId === 'seek_forward_10' ||
            interaction.customId === 'seek_open_modal';

        if (isSeekControl) {

            if (!state || !state.current) {
                return interaction.reply({
                    content: "Questo pannello non controlla piu' alcun brano.",
                    flags: MessageFlags.Ephemeral
                });
            }

            if (state.isHandlingJumpscare) {
                return interaction.reply({
                    content: "Seek non disponibile durante il jumpscare.",
                    flags: MessageFlags.Ephemeral
                });
            }
        }


        // ====================================================
        // MODAL "VAI A..."
        // ====================================================

        if (interaction.customId === 'seek_open_modal') {

            const modal = new ModalBuilder()
                .setCustomId('seek_to_modal')
                .setTitle('Vai a un punto della traccia');

            const seekInput = new TextInputBuilder()
                .setCustomId('seek_time')
                .setLabel('Tempo: 1:35, 1:02:30 oppure 95')
                .setPlaceholder('es. 1:35')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(10);

            const inputRow =
                new ActionRowBuilder()
                    .addComponents(seekInput);

            modal.addComponents(inputRow);

            await interaction.showModal(modal);

            return;
        }


        // ====================================================
        // SEEK RAPIDO +/- 10 SECONDI
        // ====================================================

        if (
            interaction.customId === 'seek_back_10' ||
            interaction.customId === 'seek_forward_10'
        ) {

            // ACK immediato dell'interazione Discord.
            await interaction.deferUpdate();

            state.panelMessage =
                interaction.message;

            const wasPaused =
                isPlayerPaused(state);

            const currentPosition =
                getActualSeek(state);

            const delta =
                interaction.customId === 'seek_forward_10'
                    ? 10
                    : -10;

            const target =
                clampSeekPosition(
                    state,
                    currentPosition + delta
                );

            try {

                await playResource(
                    guildId,
                    state.current.url,
                    state.current.title,
                    target
                );

                // Se era in pausa prima del seek,
                // deve rimanere in pausa.
                if (wasPaused) {
                    pauseState(
                        state,
                        guildId
                    );
                }

                // Forza subito l'aggiornamento di:
                //
                // - barra
                // - minutaggio
                // - lyrics/trascrizione
                //
                // senza aspettare il prossimo tick dinamico.
                await updateLivePanel(
                    state,
                    wasPaused
                        ? 'paused'
                        : 'playing'
                );

            } catch (err) {

                console.error(
                    'Errore seek rapido:',
                    err
                );
            }

            return;
        }

        if (await dynamicText.handleButton(interaction, state)) {
            return;
        }

        if (!state || !state.current) {
            return interaction.reply({
                content: "❌ Questo pannello non controlla più alcun brano.",
                flags: MessageFlags.Ephemeral
            });
        }

        // Stop deve restare sempre disponibile, anche durante il jumpscare.
        if (state.isHandlingJumpscare && interaction.customId !== 'stop_btn') {
            return interaction.reply({
                content: "🤫 Malgioglio sta urlando in aria: durante il jumpscare puoi usare solo Stop.",
                flags: MessageFlags.Ephemeral
            });
        }

        if (interaction.customId === 'loop_btn' && state.filters.roulette) {
            return interaction.reply({
                content: "❌ Il loop non è configurabile in modalità Roulette.",
                flags: MessageFlags.Ephemeral
            });
        }

        // Ogni click valido viene ACKato subito. Senza deferUpdate Discord mostra
        // "L'applicazione non ha risposto" anche se l'azione audio è avvenuta.
        await interaction.deferUpdate();

        state.panelMessage = interaction.message;
        let filterChanged = false;
        let refreshPanel = false;

        switch (interaction.customId) {
            case 'pause_res':
                if (isPlayerPaused(state)) {
                    resumeState(state, guildId);
                } else {
                    pauseState(state, guildId);
                }
                refreshPanel = true;
                break;

            case 'skip_btn': {
                clearPauseTimer(state);
                state.loop = false;

                const oldProcess = state.process;
                state.process = null;
                state.player.stop(true);

                if (oldProcess && !oldProcess.killed) oldProcess.kill();
                // L'evento Idle gestirà coda/pannello.
                return;
            }

            case 'loop_btn':
                state.loop = !state.loop;
                refreshPanel = true;
                break;

            case 'stop_btn': {
                const stoppedTrack = state.current;

                if (state.rouletteTimeout) {
                    clearTimeout(state.rouletteTimeout);
                    state.rouletteTimeout = null;
                }
                clearPauseTimer(state);

                state.loop = false;
                state.queue = [];
                state.filters.roulette = false;
                state.rouletteQueue = [];
                state.lastPlayedSongUrl = null;
                state.isHandlingJumpscare = false;
                dynamicText.stop(state);
                state.current = null;

                const oldProcess = state.process;
                state.process = null;
                state.player.stop(true);
                if (oldProcess && !oldProcess.killed) oldProcess.kill();

                await setVoiceChannelStatus(state, null);
                client.user.setPresence({ activities: [], status: 'online' });

                try {
                    await interaction.message.edit(
                        createMusicPanel(
                            stoppedTrack.title,
                            stoppedTrack.user,
                            false,
                            state.filters,
                            'stopped'
                        )
                    );
                } catch (err) {
                    console.warn('⚠️ Impossibile aggiornare il pannello dopo Stop:', err.message);
                }

                state.panelMessage = null;
                return;
            }

            case 'filter_bassboost':
                state.filters.bassboost = !state.filters.bassboost;
                filterChanged = true;
                break;

            case 'filter_nightcore':
                state.filters.nightcore = !state.filters.nightcore;
                if (state.filters.nightcore) state.filters.vaporwave = false;
                filterChanged = true;
                break;

            case 'filter_vaporwave':
                state.filters.vaporwave = !state.filters.vaporwave;
                if (state.filters.vaporwave) state.filters.nightcore = false;
                filterChanged = true;
                break;

            default:
                return;
        }

        if (filterChanged && state.current) {
            const wasPaused = isPlayerPaused(state);
            const exactSeek = getActualSeek(state);

            await playResource(guildId, state.current.url, state.current.title, Math.floor(exactSeek));

            if (wasPaused) {
                pauseState(state, guildId);
            }

            refreshPanel = true;
        }

        if (refreshPanel && state.current) {
            try {
                await interaction.message.edit(
                    createMusicPanel(
                        state.current.title,
                        state.current.user,
                        state.loop,
                        state.filters,
                        getPanelStatus(state),
                        state
                    )
                );
            } catch (err) {
                console.error('❌ Errore aggiornamento pannello pulsanti:', err);
            }
        }

        return;
    }

    if (!interaction.isChatInputCommand()) return;

    if (!interaction.inGuild()) {
        return interaction.reply({
            content: "❌ I comandi musicali funzionano solo all'interno di un server.",
            flags: MessageFlags.Ephemeral
        });
    }

    const { commandName } = interaction;

    switch (commandName) {
        case 'roulette':
            await interaction.deferReply();
            const voiceCh = interaction.member.voice.channel;
            if (!voiceCh) return interaction.editReply("❌ Devi essere in un canale vocale per attivare il delirio!");

            if (state?.current && !isStateInVoiceChannel(state, voiceCh)) {
                return interaction.editReply("❌ Il bot sta già riproducendo musica in un altro canale vocale.");
            }

            // CONTROLLO SE QUALCOSA È IN RIPRODUZIONE
            if (state && state.current) {
                // Mette in coda il trigger per attivare la roulette quando tocca a lei
                state.queue.push({ isRouletteTrigger: true, title: "🎰 Malgioglio Roulette (In coda)", user: interaction.user });
                return interaction.editReply("🎰 Il server è occupato! **Il delirio della Roulette di Malgioglio è stato messo in coda.**");
            }

            if (state && state.rouletteTimeout) clearTimeout(state.rouletteTimeout);

            let initialRouletteQueue = shuffleArray(MALGIOGLIO_PLAYLIST);
            const randomSong = initialRouletteQueue.shift();
            const startSeek = 0;

            try {
                const { title: actualTitle, url: finalUrl, channel: youtubeChannel } = await extractAudioInfo(randomSong.url);

                if (!state) {
                    const player = createAudioPlayer();
                    const connection = joinVoiceChannel({
                        channelId: voiceCh.id,
                        guildId: guildId,
                        adapterCreator: interaction.guild.voiceAdapterCreator,
                    });

                    await waitForVoiceReady(connection, guildId, 'roulette');

                    connection.subscribe(player);

                    state = {
                        player, connection, queue: [],
                        current: { url: finalUrl, title: actualTitle, channel: youtubeChannel, user: interaction.user },
                        loop: false, process: null, textChannel: interaction.channel, currentSeek: 0,
                        filters: { bassboost: false, nightcore: false, vaporwave: false, roulette: true },
                        lastEffect: 'none',
                        isSecondHalf: false,
                        isHandlingJumpscare: false,
                        rouletteQueue: initialRouletteQueue,
                        lastPlayedSongUrl: null,
                        panelMessage: null,
                        pauseTimeout: null,
                        rouletteTimeout: null
                    };
                    players.set(guildId, state);
                    attachPlayerListeners(player, guildId);
                } else {
                    await connectStateToVoiceChannel(state, voiceCh, interaction.guild);
                    state.textChannel = interaction.channel;
                    state.filters.roulette = true;
                    state.current = { url: finalUrl, title: actualTitle, channel: youtubeChannel, user: interaction.user };
                    state.isSecondHalf = false;
                    state.isHandlingJumpscare = false;
                    state.queue = [];
                    state.rouletteQueue = initialRouletteQueue;
                    state.lastPlayedSongUrl = null;
                }

                applyRandomFilter(state);

                await playResource(guildId, finalUrl, actualTitle, startSeek);
                await interaction.editReply(`🎰 **MALGIOGLIO ROULETTE ATTIVATA!**`);

                state.panelMessage = await interaction.channel.send(createMusicPanel(actualTitle, interaction.user, false, state.filters, getPanelStatus(state), state));
                scheduleRouletteEffect(guildId);

            } catch (e) {
                console.error(e);
                await interaction.editReply("❌ Errore ad avviare la roulette. Riprova!");
            }
            break;

        case 'play': {
            await interaction.deferReply();

            const query =
                interaction.options.getString(
                    'query'
                );

            await handleUnifiedPlayRequest(
                interaction,
                query
            );

            break;
        }

        case 'libreria': {
            await interaction.deferReply();

            try {

                await refreshMediaTitles();

            } catch (titleErr) {

                console.warn(
                    '[MEDIA HUB] Refresh titoli /libreria fallito:',
                    titleErr?.message || titleErr
                );
            }

            const hub =
                buildMediaHub({
                    category: 'popular',
                    page: 0,
                    query: ''
                });

            const hubMessage =
                await interaction.editReply(
                    hub.payload
                );

            mediaHubSessions.set(
                hubMessage.id,
                hub.state
            );
            mediaHubMessages.set(
                hubMessage.id,
                hubMessage
            );

            break;
        }

        case 'avanti':
        case 'indietro': {
            if (!state || !state.current) return interaction.reply("❌ Nulla in riproduzione.");
            if (state.isHandlingJumpscare) return interaction.reply("❌ Non puoi scorrere il brano durante un jumpscare!");

            const sec = interaction.options.getInteger('secondi');
            if (!Number.isInteger(sec) || sec <= 0) {
                return interaction.reply("❌ Specifica un numero di secondi maggiore di zero.");
            }

            const wasPaused = isPlayerPaused(state);
            const currentPos = getActualSeek(state);
            const newSeek = commandName === 'avanti'
                ? currentPos + sec
                : Math.max(0, currentPos - sec);

            await interaction.deferReply();
            await playResource(guildId, state.current.url, state.current.title, Math.floor(newSeek));

            if (wasPaused) {
                pauseState(state, guildId);
            }

            await updateLivePanel(state);
            await interaction.editReply(
                `${commandName === 'avanti' ? '⏩' : '⏪'} Posizione aggiornata a: ${Math.floor(newSeek)}s`
            );
            break;
        }

        case 'pausa': {
            if (!state || !state.current) return interaction.reply("❌ Nulla in riproduzione.");
            if (state.isHandlingJumpscare) return interaction.reply("❌ Non puoi mettere in pausa lo spavento!");
            if (isPlayerPaused(state)) return interaction.reply("⏸️ Il brano è già in pausa.");

            const paused = pauseState(state, guildId);
            await interaction.reply(paused ? "⏸️ In pausa." : "❌ Non sono riuscito a mettere in pausa il player.");
            if (paused) await updateLivePanel(state, 'paused');
            break;
        }

        case 'riprendi': {
            if (!state || !state.current) return interaction.reply("❌ Nulla in riproduzione.");
            if (state.isHandlingJumpscare) return interaction.reply("❌ Non puoi modificare la riproduzione durante il jumpscare.");
            if (!isPlayerPaused(state)) return interaction.reply("▶️ Il brano è già in riproduzione.");

            const resumed = resumeState(state, guildId);
            await interaction.reply(resumed ? "▶️ Ripreso." : "❌ Non sono riuscito a riprendere il player.");
            if (resumed) await updateLivePanel(state, 'playing');
            break;
        }

        case 'skip': {
            if (!state || !state.current) return interaction.reply("❌ Nulla da saltare.");
            if (state.isHandlingJumpscare) {
                return interaction.reply("❌ Durante il jumpscare usa /stop se vuoi interrompere tutto.");
            }

            clearPauseTimer(state);
            state.loop = false;

            const oldProcess = state.process;
            state.process = null;
            state.player.stop(true);
            if (oldProcess && !oldProcess.killed) oldProcess.kill();

            await interaction.reply("⏭️ Brano saltato.");
            break;
        }

        case 'loop':
            if (!state || !state.current) return interaction.reply("❌ Nulla in esecuzione.");
            if (state.filters.roulette) return interaction.reply("❌ Il loop non è configurabile in modalità Roulette.");

            state.loop = !state.loop;
            await interaction.reply(`🔁 Loop: ${state.loop ? 'ATTIVO' : 'DISATTIVATO'}`);
            await updateLivePanel(state);
            break;

        case 'bassboost':
        case 'nightcore':
        case 'vaporwave': {
            if (!state || !state.current) return interaction.reply("❌ Nulla in riproduzione.");
            if (state.isHandlingJumpscare) {
                return interaction.reply("❌ I filtri non sono modificabili durante il jumpscare.");
            }

            const wasPaused = isPlayerPaused(state);
            const exactSeek = Math.floor(getActualSeek(state));

            if (commandName === 'bassboost') {
                state.filters.bassboost = !state.filters.bassboost;
            } else if (commandName === 'nightcore') {
                state.filters.nightcore = !state.filters.nightcore;
                if (state.filters.nightcore) state.filters.vaporwave = false;
            } else {
                state.filters.vaporwave = !state.filters.vaporwave;
                if (state.filters.vaporwave) state.filters.nightcore = false;
            }

            await interaction.deferReply();
            await playResource(guildId, state.current.url, state.current.title, exactSeek);

            if (wasPaused) {
                pauseState(state, guildId);
            }

            await updateLivePanel(state);

            const enabled = state.filters[commandName];
            const label = commandName === 'bassboost'
                ? 'Bassboost'
                : commandName === 'nightcore'
                    ? 'Nightcore'
                    : 'Vaporwave';

            await interaction.editReply(`🎛️ ${label}: ${enabled ? 'ATTIVO' : 'DISATTIVATO'}`);
            break;
        }

        case 'stop': {
            if (!state || !state.current) return interaction.reply("❌ Nulla da fermare.");

            const stoppedTrack = state.current;
            const stoppedPanel = state.panelMessage;

            if (state.rouletteTimeout) {
                clearTimeout(state.rouletteTimeout);
                state.rouletteTimeout = null;
            }
            clearPauseTimer(state);

            state.queue = [];
            state.loop = false;
            state.filters.roulette = false;
            state.rouletteQueue = [];
            state.lastPlayedSongUrl = null;
            state.isHandlingJumpscare = false;
            dynamicText.stop(state);
            state.current = null;

            const oldProcess = state.process;
            state.process = null;
            state.player.stop(true);
            if (oldProcess && !oldProcess.killed) oldProcess.kill();

            await setVoiceChannelStatus(state, null);
            client.user.setPresence({ activities: [], status: 'online' });
            await interaction.reply("🛑 Musica fermata.");

            if (stoppedPanel) {
                try {
                    await stoppedPanel.edit(
                        createMusicPanel(
                            stoppedTrack.title,
                            stoppedTrack.user,
                            false,
                            state.filters,
                            'stopped'
                        )
                    );
                } catch (err) {
                    console.warn('⚠️ Impossibile aggiornare il pannello dopo /stop:', err.message);
                }
            }

            state.panelMessage = null;
            break;
        }

        case 'pausain': {
            if (!state || !state.current) return interaction.reply("❌ Nulla in riproduzione.");
            if (state.isHandlingJumpscare) return interaction.reply("❌ Comando non disponibile durante il jumpscare.");

            const seconds = interaction.options.getInteger('secondi');
            if (!Number.isInteger(seconds) || seconds <= 0) {
                return interaction.reply("❌ Specifica un numero di secondi maggiore di zero.");
            }

            clearPauseTimer(state);
            const scheduledUrl = state.current.url;

            state.pauseTimeout = setTimeout(async () => {
                const latestState = players.get(guildId);

                // Il timer appartiene al brano per cui è stato creato: se nel
                // frattempo è cambiata traccia, non deve mettere in pausa quella nuova.
                if (
                    !latestState ||
                    !latestState.current ||
                    latestState.current.url !== scheduledUrl ||
                    latestState.isHandlingJumpscare
                ) {
                    return;
                }

                latestState.pauseTimeout = null;
                if (!isPlayerPaused(latestState) && pauseState(latestState, guildId)) {
                    await updateLivePanel(latestState, 'paused');
                }
            }, seconds * 1000);

            await interaction.reply(`⏳ Pausa programmata tra ${seconds}s.`);
            break;
        }
    }
});

async function bootstrap() {
    console.log(`ℹ️ Node ${process.version}`);

    try {
        console.log('\n=== DISCORD VOICE DEPENDENCY REPORT ===');
        console.log(generateDependencyReport());
        console.log('=======================================\n');
    } catch (err) {
        console.warn(
            'Impossibile generare il dependency report Discord Voice:',
            err?.message || err
        );
    }

    // Node 22 può caricare nativamente .env: così funzionano sia `npm start`
    // sia `node .` da VS Code/PowerShell.
    if (!process.env.DISCORD_TOKEN && fs.existsSync('./.env') && typeof process.loadEnvFile === 'function') {
        process.loadEnvFile('./.env');
    }

    if (!process.env.DISCORD_TOKEN) {
        throw new Error('DISCORD_TOKEN mancante. Inseriscilo in .env come DISCORD_TOKEN=...');
    }

    await updateYtDlp();
    await client.login(process.env.DISCORD_TOKEN);
}

async function shutdown(signal) {
    console.log(`\n🛑 ${signal}: chiusura pulita del bot...`);

    for (const state of players.values()) {
        if (state.rouletteTimeout) clearTimeout(state.rouletteTimeout);
        if (state.pauseTimeout) clearTimeout(state.pauseTimeout);
        dynamicText.stop(state);

        if (state.process && !state.process.killed) {
            state.process.kill();
        }

        try {
            await setVoiceChannelStatus(state, null);
            state.player?.stop(true);
            state.connection?.destroy();
        } catch (err) {
            console.warn('⚠️ Errore durante la chiusura di una connessione vocale:', err.message);
        }
    }

    client.destroy();
}

process.once('SIGINT', async () => {
    await shutdown('SIGINT');
    process.exit(0);
});

process.once('SIGTERM', async () => {
    await shutdown('SIGTERM');
    process.exit(0);
});

process.on('unhandledRejection', err => {
    console.error('❌ Promise non gestita:', err);
});

client.on('error', err => {
    console.error('❌ Discord client error:', err);
});

bootstrap().catch(err => {
    console.error('❌ Avvio del bot fallito:', err);
    process.exitCode = 1;
});
