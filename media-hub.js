const fs = require('fs');
const path = require('path');
const youtubeDl = require('youtube-dl-exec');
const libraryStore = require('./media-library-store');

const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder
} = require('discord.js');

const STATS_PATH = path.join(__dirname, 'media-stats.json');
// ============================================================
// REAL_YOUTUBE_TITLE_CACHE
// ============================================================

const TITLES_PATH =
    path.join(
        __dirname,
        'media-titles.json'
    );

// MEDIA_TITLE_FAILURE_CACHE_V2
const TITLE_FAILURES_PATH =
    path.join(
        __dirname,
        'media-title-failures.json'
    );

const TITLE_FAILURE_TTL_MS =
    6 * 60 * 60 * 1000;

let titleRefreshPromise = null;


function cleanYoutubeTitle(value) {

    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim();
}


function loadTitleCache() {

    try {

        if (!fs.existsSync(TITLES_PATH)) {

            fs.writeFileSync(
                TITLES_PATH,
                '{}\n',
                'utf8'
            );

            return {};
        }

        const parsed =
            JSON.parse(
                fs.readFileSync(
                    TITLES_PATH,
                    'utf8'
                )
            );

        if (
            parsed &&
            typeof parsed === 'object'
        ) {

            return parsed;
        }

    } catch (err) {

        console.warn(
            '[MEDIA HUB] Errore lettura media-titles.json:',
            err.message
        );
    }

    return {};
}


function saveTitleCache(cache) {

    try {

        fs.writeFileSync(
            TITLES_PATH,
            `${JSON.stringify(cache, null, 2)}\n`,
            'utf8'
        );

    } catch (err) {

        console.warn(
            '[MEDIA HUB] Errore salvataggio media-titles.json:',
            err.message
        );
    }
}


function loadTitleFailureCache() {
    try {
        if (!fs.existsSync(TITLE_FAILURES_PATH)) return {};

        const parsed =
            JSON.parse(
                fs.readFileSync(
                    TITLE_FAILURES_PATH,
                    'utf8'
                )
            );

        return (
            parsed &&
            typeof parsed === 'object'
        )
            ? parsed
            : {};

    } catch (err) {
        console.warn(
            '[MEDIA HUB] Errore lettura media-title-failures.json:',
            err.message
        );
        return {};
    }
}


function saveTitleFailureCache(cache) {
    try {
        fs.writeFileSync(
            TITLE_FAILURES_PATH,
            JSON.stringify(cache, null, 2) + '\n',
            'utf8'
        );
    } catch (err) {
        console.warn(
            '[MEDIA HUB] Errore salvataggio media-title-failures.json:',
            err.message
        );
    }
}


function canAttemptMediaTitle(
    itemId,
    force = false
) {
    if (force) return true;

    const cache =
        loadTitleFailureCache();

    const nextRetryAt =
        Number(
            cache[itemId]?.nextRetryAt || 0
        );

    return (
        !Number.isFinite(nextRetryAt) ||
        nextRetryAt <= Date.now()
    );
}


function markMediaTitleFailure(itemId) {
    const cache =
        loadTitleFailureCache();

    const failedAt =
        Date.now();

    cache[itemId] = {
        failedAt,
        nextRetryAt:
            failedAt +
            TITLE_FAILURE_TTL_MS
    };

    saveTitleFailureCache(cache);
}


function clearMediaTitleFailure(itemId) {
    const cache =
        loadTitleFailureCache();

    if (!cache[itemId]) return;

    delete cache[itemId];
    saveTitleFailureCache(cache);
}


function getCachedYoutubeTitle(item) {

    const cache =
        loadTitleCache();

    return cleanYoutubeTitle(
        cache[item.id]
    );
}


async function fetchTitleWithOEmbed(item) {

    const controller =
        new AbortController();

    const timer =
        setTimeout(
            () => controller.abort(),
            7000
        );

    try {

        const endpoint =
            'https://www.youtube.com/oembed' +
            `?url=${encodeURIComponent(item.url)}` +
            '&format=json';

        const response =
            await fetch(
                endpoint,
                {
                    signal:
                        controller.signal
                }
            );

        if (!response.ok) {
            return '';
        }

        const data =
            await response.json();

        return cleanYoutubeTitle(
            data?.title
        );

    } catch {

        return '';

    } finally {

        clearTimeout(timer);
    }
}


async function fetchTitleWithYtDlp(item) {

    try {

        const flags = {
            dumpSingleJson: true,
            skipDownload: true,
            noWarnings: true,
            noPlaylist: true,
            jsRuntimes: 'node',
            remoteComponents: 'ejs:github'
        };

        if (
            fs.existsSync(
                path.join(
                    __dirname,
                    'cookies.txt'
                )
            )
        ) {

            flags.cookies =
                path.join(
                    __dirname,
                    'cookies.txt'
                );
        }

        const result =
            await youtubeDl(
                item.url,
                flags
            );

        let info =
            result;

        if (typeof info === 'string') {

            try {

                info =
                    JSON.parse(
                        info.trim()
                    );

            } catch {

                info =
                    null;
            }
        }

        if (
            Array.isArray(
                info?.entries
            )
        ) {

            info =
                info.entries.find(
                    Boolean
                );
        }

        return cleanYoutubeTitle(
            info?.title
        );

    } catch (err) {

        console.warn(
            `[MEDIA HUB] yt-dlp titolo fallito per ${item.id}:`,
            err?.message || err
        );

        return '';
    }
}


async function fetchRealYoutubeTitle(item) {
    // Prima oEmbed: leggero e senza avviare yt-dlp.
    let title =
        await fetchTitleWithOEmbed(
            item
        );

    if (title) {
        clearMediaTitleFailure(
            item.id
        );
        return title;
    }

    // Su Railway non lanciamo yt-dlp per ogni titolo mancante:
    // protegge l'IP cloud dai rate-limit. Si puo' riabilitare
    // esplicitamente con MEDIA_TITLE_YTDLP_FALLBACK=1.
    const allowYtDlpFallback =
        !process.env.POT_PROVIDER_URL ||
        process.env.MEDIA_TITLE_YTDLP_FALLBACK === '1';

    if (!allowYtDlpFallback) {
        markMediaTitleFailure(
            item.id
        );
        return '';
    }

    title =
        await fetchTitleWithYtDlp(
            item
        );

    if (title) {
        clearMediaTitleFailure(
            item.id
        );
        return title;
    }

    markMediaTitleFailure(
        item.id
    );

    return '';
}


async function refreshMediaTitles({
    force = false
} = {}) {

    if (
        titleRefreshPromise &&
        !force
    ) {

        return titleRefreshPromise;
    }

    titleRefreshPromise =
        (async () => {

            const cache =
                loadTitleCache();

            const missing =
                getLibraryCatalog().filter(
                    item =>
                        (
                            force ||
                            !cleanYoutubeTitle(
                                cache[item.id]
                            )
                        ) &&
                        canAttemptMediaTitle(
                            item.id,
                            force
                        )
                );

            if (!missing.length) {

                console.log(
                    '[MEDIA HUB] Cache titoli YouTube completa.'
                );

                return cache;
            }

            console.log(
                `[MEDIA HUB] Recupero ${missing.length} titoli YouTube...`
            );

            let cursor = 0;
            let recovered = 0;

            // Quattro worker in parallelo:
            // abbastanza veloci senza bombardare YouTube.
            const worker = async () => {

                while (true) {

                    const index =
                        cursor++;

                    if (
                        index >=
                        missing.length
                    ) {
                        return;
                    }

                    const item =
                        missing[index];

                    const title =
                        await fetchRealYoutubeTitle(
                            item
                        );

                    if (title) {

                        cache[item.id] =
                            title;

                        recovered++;

                        // Salvataggio progressivo.
                        saveTitleCache(
                            cache
                        );

                        console.log(
                            `[MEDIA HUB] ${item.id} -> ${title}`
                        );

                    } else {

                        console.warn(
                            `[MEDIA HUB] Titolo reale non disponibile per ${item.id}`
                        );
                    }
                }
            };

            const workerCount =
                process.env.POT_PROVIDER_URL
                    ? 1
                    : 2;

            await Promise.all(
                Array.from(
                    {
                        length:
                            Math.min(
                                workerCount,
                                missing.length
                            )
                    },
                    () => worker()
                )
            );

            saveTitleCache(
                cache
            );

            console.log(
                `[MEDIA HUB] Titoli recuperati: ${recovered}/${missing.length}`
            );

            return cache;

        })()
        .finally(
            () => {

                titleRefreshPromise =
                    null;
            }
        );

    return titleRefreshPromise;
}
const PAGE_SIZE = 10;

const CATEGORY_META = {
    popular: {
        label: 'Popolari',
        emoji: '\u{1F525}'
    },

    malgioglio: {
        label: 'Malgioglio',
        emoji: '\u{1F3A4}'
    },

    dipre: {
        label: 'Dipre & soci',
        emoji: '\u{1F48A}'
    },

    algero: {
        label: '1727 / Algero',
        emoji: '\u{1F6A8}'
    },

    musica: {
        label: 'Musica',
        emoji: '\u{1F3B5}'
    },

    cult: {
        label: 'Meme / Cult',
        emoji: '\u{1F602}'
    },

    all: {
        label: 'Tutti i video',
        emoji: '\u{1F4FA}'
    }
};

const CATALOG = [

    {
        id: 'piriti',
        title: "Ossi' Ghosi'",
        emoji: '\u{1F4A8}',
        url: 'https://youtu.be/0W0UmfcMLss',
        aliases: ['piriti'],
        categories: ['cult'],
        featuredRank: 20
    },

    {
        id: 'cosino',
        title: "Cosi' no",
        emoji: '\u{1F6AB}',
        url: 'https://youtu.be/BRAjJ9gNZbw',
        aliases: ['cosino'],
        categories: ['cult'],
        featuredRank: 19
    },

    {
        id: 'scopata',
        title: 'Stai parcheggiata',
        emoji: '\u{1F697}',
        url: 'https://www.youtube.com/watch?v=8zcC90HfA9w',
        aliases: ['scopata'],
        categories: ['cult'],
        featuredRank: 18
    },

    {
        id: 'coca',
        title: 'Coca',
        emoji: '\u{1F964}',
        url: 'https://www.youtube.com/watch?v=6mSveZMatXg',
        aliases: ['coca'],
        categories: ['cult'],
        featuredRank: 17
    },

    {
        id: 'malgiogliomarito',
        title: 'Mi sono innamorato ma di tuo marito',
        emoji: '\u{1F48D}',
        url: 'https://www.youtube.com/watch?v=IGh2Sgyli8I&ab_channel=CRISTIANOMALGIOGLIO',
        aliases: ['malgiogliomarito'],
        categories: ['malgioglio'],
        featuredRank: 8
    },

    {
        id: 'amarcord',
        title: 'Amarcord',
        emoji: '\u{1F3B6}',
        url: 'https://www.youtube.com/watch?v=LKda2tqAebc&pp=ygUIYW1hcmNvcmQ%3D',
        aliases: ['amarcord'],
        categories: ['musica'],
        featuredRank: 12
    },

    {
        id: 'fernando',
        title: 'Fernando',
        emoji: '\u2600\uFE0F',
        url: 'https://www.youtube.com/watch?v=m8aU5NyuWCs&pp=ygUTZmVybmFuZG8gbWFsZ2lvZ2xpbw%3D%3D',
        aliases: ['fernando'],
        categories: ['malgioglio'],
        featuredRank: 3
    },

    {
        id: 'gelato',
        title: 'Gelato al cioccolato',
        emoji: '\u{1F366}',
        url: 'https://www.youtube.com/watch?v=K1XcMymj_2U&pp=ygUfZ2VsYXRvIGFsIGNpb2Njb2xhdG8gbWFsZ2lvZ2xpbw%3D%3D',
        aliases: ['gelato'],
        categories: ['malgioglio'],
        featuredRank: 1
    },

    {
        id: 'rosa',
        title: 'Rosa Tormento',
        emoji: '\u{1F339}',
        url: 'https://youtu.be/xnhin995UWg',
        aliases: ['rosa'],
        categories: ['malgioglio'],
        featuredRank: 2
    },

    {
        id: 'malgiogliosuca',
        title: 'Sucu Sucu',
        emoji: '\u{1F525}',
        url: 'https://youtu.be/zso_jpGUdTk',
        aliases: ['malgiogliosuca'],
        categories: ['malgioglio'],
        featuredRank: 6
    },

    {
        id: 'porno',
        title: 'Vita Porno',
        emoji: '\u{1F3AC}',
        url: 'https://www.youtube.com/watch?v=Htad-2b6xng&pp=ygUKdml0YSBwb3Jubw%3D%3D',
        aliases: ['porno'],
        categories: ['malgioglio'],
        featuredRank: 10
    },

    {
        id: 'fiorella',
        title: 'Fiorella',
        emoji: '\u{1F3A4}',
        url: 'https://youtu.be/GMq56oaBPYo',
        aliases: ['fiorella'],
        categories: ['musica', 'cult'],
        featuredRank: 30
    },

    {
        id: 'cassidio',
        title: 'Cassidio ragassi',
        emoji: '\u{1F4A5}',
        url: 'https://www.youtube.com/watch?v=U_1flPO1bI8&t=117s&pp=ygUMYW5kcmVhIGRpcHJl',
        aliases: ['cassidio'],
        categories: ['dipre'],
        start: 117,
        featuredRank: 11
    },

    {
        id: 'italy',
        title: 'Made in Italy',
        emoji: '\u{1F1EE}\u{1F1F9}',
        url: 'https://youtu.be/3rXTZ9eWMC0',
        aliases: ['italy'],
        categories: ['musica'],
        featuredRank: 16
    },

    {
        id: 'dipreroma',
        title: 'Dipre a Roma',
        emoji: '\u{1F3DB}\uFE0F',
        url: 'https://youtu.be/g7yGopUqo_U',
        aliases: ['dipreroma'],
        categories: ['dipre'],
        featuredRank: 21
    },

    {
        id: 'terzamarcia',
        title: 'Terza marcia fratelli',
        emoji: '\u{1F697}',
        url: 'https://youtu.be/GJdH4RGQozU',
        aliases: ['terzamarcia'],
        categories: ['algero', 'cult'],
        featuredRank: 22
    },

    {
        id: 'fabietto',
        title: 'Fabietto',
        emoji: '\u{1F4A3}',
        url: 'https://www.youtube.com/watch?v=s1br_h3ji0E',
        aliases: ['fabietto'],
        categories: ['algero'],
        featuredRank: 15
    },

    {
        id: 'petolicchio',
        title: 'Petolicchio',
        emoji: '\u{1F4E2}',
        url: 'https://youtu.be/oHL7UzdBcI8?si=7Xjir7ZB_qEB9osX',
        aliases: ['petolicchio'],
        categories: ['algero'],
        featuredRank: 14
    },

    {
        id: 'fracicone',
        title: 'Gorretini',
        emoji: '\u{1F3AD}',
        url: 'https://www.youtube.com/watch?v=oH6RnJKJeJ8&t=12s',
        aliases: ['fracicone'],
        categories: ['algero', 'cult'],
        start: 12,
        featuredRank: 23
    },

    {
        id: 'algeropicchia',
        title: 'Algero picchia',
        emoji: '\u{1F44A}',
        url: 'https://www.youtube.com/watch?v=m0tJEK_X330',
        aliases: ['algeropicchia'],
        categories: ['algero'],
        featuredRank: 7
    },

    {
        id: 'algeropala',
        title: 'Algero con la pala',
        emoji: '\u26CF\uFE0F',
        url: 'https://youtu.be/w4ZaiR9XNR4',
        aliases: ['algeropala'],
        categories: ['algero'],
        featuredRank: 4
    },

    {
        id: 'melodrama',
        title: 'Melodrama',
        emoji: '\u{1F3B5}',
        url: 'https://youtu.be/SqF0MSpPcj8',
        aliases: ['melodrama'],
        categories: ['musica'],
        featuredRank: 24
    },

    {
        id: 'capretto',
        title: 'Capretto',
        emoji: '\u{1F410}',
        url: 'https://youtu.be/KCggVmjNUTo',
        aliases: ['capretto'],
        categories: ['cult'],
        featuredRank: 25
    },

    {
        id: 'diprecomanda',
        title: 'Dipre comanda',
        emoji: '\u{1F451}',
        url: 'https://www.youtube.com/shorts/zAVz-jhoBVo?feature=share',
        aliases: ['diprecomanda'],
        categories: ['dipre'],
        featuredRank: 9
    },

    {
        id: 'obambaoplomo',
        title: 'O bamba o plomo',
        emoji: '\u{1F4B0}',
        url: 'https://youtu.be/YTt-uHiy_ZY',
        aliases: ['obambaoplomo'],
        categories: ['algero', 'cult'],
        featuredRank: 26
    },

    {
        id: 'angelina',
        title: 'Angelina / Cricetina',
        emoji: '\u{1F439}',
        url: 'https://youtu.be/psiytW9Or2s',
        aliases: ['angelina', 'cricetina'],
        categories: ['musica'],
        featuredRank: 13
    },

    {
        id: 'cash',
        title: 'Cash',
        emoji: '\u{1F4B8}',
        url: 'https://www.youtube.com/watch?v=OYmnP1DNsWM',
        aliases: ['cash'],
        categories: ['musica', 'cult'],
        featuredRank: 27
    },

    {
        id: 'inseguimento',
        title: 'Inseguimento',
        emoji: '\u{1F6A8}',
        url: 'https://www.youtube.com/watch?v=J1Ds7DKKHbY',
        aliases: ['inseguimento'],
        categories: ['algero'],
        featuredRank: 5
    },

    {
        id: 'ollare',
        title: 'Ollare',
        emoji: '\u{1F504}',
        url: 'https://www.youtube.com/watch?v=tuju-FX4xRE',
        aliases: ['ollare'],
        categories: ['cult'],
        featuredRank: 28
    },

    {
        id: 'lean',
        title: 'Lean',
        emoji: '\u{1F964}',
        url: 'https://youtu.be/gM2N6G9VabI',
        aliases: ['lean'],
        categories: ['dipre'],
        featuredRank: 29
    },

    {
        id: 'bobbe',
        title: 'Bobbe',
        emoji: '\u{1F921}',
        url: 'https://youtu.be/LeNDyj2fXp4',
        aliases: ['bobbe'],
        categories: ['algero', 'cult'],
        featuredRank: 31
    },

    {
        id: 'battito',
        title: 'Battito',
        emoji: '\u{1F493}',
        url: 'https://www.youtube.com/watch?v=c0S_f-1EYN8&pp=ygUHYmF0dGl0bw%3D%3D',
        aliases: ['battito'],
        categories: ['musica'],
        featuredRank: 32
    },

    {
        id: 'amoredelbot',
        title: 'Amore del bot',
        emoji: '\u2764\uFE0F',
        url: 'https://youtu.be/K_iaQPLdmJU',
        aliases: [
            'amoredelbot',
            'nali',
            'amoredimenfi'
        ],
        categories: ['musica'],
        featuredRank: 33
    },

    {
        id: 'arte',
        title: "L'arte e' liberta'",
        emoji: '\u{1F3A8}',
        url: 'https://youtu.be/FI9KcH2VGKs',
        aliases: ['arte'],
        categories: ['dipre'],
        featuredRank: 5
    },

    {
        id: 'algerino',
        title: 'Algerino',
        emoji: '\u{1F3AF}',
        url: 'https://www.youtube.com/watch?v=3QgBsvZ0lME&t=65s&ab_channel=99fareshi',
        aliases: ['algerino'],
        categories: ['algero'],
        start: 65,
        featuredRank: 34
    },

    {
        id: 'nikita',
        title: 'Nikita',
        emoji: '\u{1F483}',
        url: 'https://youtu.be/TBD1f_6ghtY',
        aliases: ['nikita'],
        categories: ['cult'],
        featuredRank: 35
    },

    {
        id: 'algerino2',
        title: 'Algero 2',
        emoji: '\u{1F52B}',
        url: 'https://www.youtube.com/shorts/lzSoFhEqbcY?&ab_channel=TheFutbolista',
        aliases: [
            'algerino2',
            'algero'
        ],
        categories: ['algero'],
        featuredRank: 36
    },

    {
        id: 'litigio',
        title: 'Litigio Algero',
        emoji: '\u{1F4A2}',
        url: 'https://www.youtube.com/watch?v=IULtmLbNnNU&t=4s&pp=ygUpMTcyNyB3cmxkc3RhciAtIGFsZ2VybyBsaXRpZ2EgcGVzYW50ZW1lbnQ%3D',
        aliases: ['litigio'],
        categories: ['algero'],
        start: 4,
        featuredRank: 37
    },

    {
        id: 'clown',
        title: 'Clown',
        emoji: '\u{1F921}',
        url: 'https://www.youtube.com/watch?v=7v-tJSGkYfE&t=23s',
        aliases: ['clown'],
        categories: ['algero', 'cult'],
        start: 23,
        featuredRank: 38
    }
];

function getLibraryCatalog() {
    return libraryStore.getEffectiveCatalog(CATALOG);
}

function getLibraryCategories() {
    return libraryStore.getEffectiveCategories(CATEGORY_META);
}

function ensureStatsFile() {
    if (!fs.existsSync(STATS_PATH)) {
        fs.writeFileSync(
            STATS_PATH,
            '{}\n',
            'utf8'
        );
    }
}

function loadStats() {
    ensureStatsFile();

    try {
        const parsed = JSON.parse(
            fs.readFileSync(
                STATS_PATH,
                'utf8'
            )
        );

        return (
            parsed &&
            typeof parsed === 'object'
        )
            ? parsed
            : {};

    } catch {
        return {};
    }
}

function saveStats(stats) {
    fs.writeFileSync(
        STATS_PATH,
        `${JSON.stringify(stats, null, 2)}\n`,
        'utf8'
    );
}

function getPlayCount(
    id,
    stats = loadStats()
) {
    const value =
        Number(stats[id] || 0);

    return (
        Number.isFinite(value) &&
        value > 0
    )
        ? Math.floor(value)
        : 0;
}

function incrementPlay(id) {
    const stats =
        loadStats();

    stats[id] =
        getPlayCount(id, stats) + 1;

    saveStats(stats);

    return stats[id];
}

function getMediaItem(id) {
    return (
        getLibraryCatalog().find(
            item => item.id === id
        ) ||
        null
    );
}

function normalized(value) {
    return String(value || '')
        .toLocaleLowerCase('it')
        .normalize('NFD')
        .replace(
            /[\u0300-\u036f]/g,
            ''
        )
        .trim();
}

function searchItems(query) {
    const needle =
        normalized(query);

    if (!needle) {
        return [];
    }

    return getLibraryCatalog().filter(item => {

        const haystack = [
            item.id,
            item.title,
            ...(item.aliases || []),
            ...(item.categories || [])
        ]
            .map(normalized)
            .join(' ');

        return haystack.includes(
            needle
        );
    });
}

function getTopItems(
    limit = 5,
    stats = loadStats()
) {
    return [...getLibraryCatalog()]
        .sort((a, b) => {

            const countDiff =
                getPlayCount(
                    b.id,
                    stats
                ) -
                getPlayCount(
                    a.id,
                    stats
                );

            if (countDiff !== 0) {
                return countDiff;
            }

            return (
                (a.featuredRank || 999) -
                (b.featuredRank || 999)
            );
        })
        .slice(0, limit);
}

function getItemsForView(
    category,
    query,
    stats
) {
    if (query) {

        return searchItems(query)
            .sort(
                (a, b) =>
                    getPlayCount(
                        b.id,
                        stats
                    ) -
                    getPlayCount(
                        a.id,
                        stats
                    )
            );
    }

    if (category === 'popular') {

        return [...getLibraryCatalog()]
            .sort((a, b) => {

                const countDiff =
                    getPlayCount(
                        b.id,
                        stats
                    ) -
                    getPlayCount(
                        a.id,
                        stats
                    );

                if (countDiff !== 0) {
                    return countDiff;
                }

                return (
                    (a.featuredRank || 999) -
                    (b.featuredRank || 999)
                );
            });
    }

    if (category === 'all') {

        return [...getLibraryCatalog()]
            .sort(
                (a, b) =>
                    a.title.localeCompare(
                        b.title,
                        'it'
                    )
            );
    }

    return getLibraryCatalog()
        .filter(
            item =>
                item.categories.includes(
                    category
                )
        )
        .sort(
            (a, b) =>
                a.title.localeCompare(
                    b.title,
                    'it'
                )
        );
}

function shortLabel(
    value,
    max = 80
) {
    const text =
        String(value || 'Video');

    if (text.length <= max) {
        return text;
    }

    return (
        text.slice(
            0,
            Math.max(
                1,
                max - 3
            )
        ) +
        '...'
    );
}

function buildMediaHub({
    category = 'popular',
    page = 0,
    query = ''
} = {}) {

    const stats =
        loadStats();

    const libraryCategories =
        getLibraryCategories();

    const libraryCatalog =
        getLibraryCatalog();

    const resolvedCategory =
        query || libraryCategories[category]
            ? category
            : 'popular';

    const top =
        getTopItems(
            5,
            stats
        );

    const items =
        getItemsForView(
            resolvedCategory,
            query,
            stats
        );

    const totalPages =
        Math.max(
            1,
            Math.ceil(
                items.length /
                PAGE_SIZE
            )
        );

    const safePage =
        Math.min(
            Math.max(
                0,
                Number(page) || 0
            ),
            totalPages - 1
        );

    const pageItems =
        items.slice(
            safePage * PAGE_SIZE,
            (safePage + 1) *
                PAGE_SIZE
        );

    // ========================================================
    // CATALOGO VISIBILE NELL'EMBED
    // ========================================================

    const catalogLines =
        pageItems.length
            ? pageItems.map(
                (item, index) => {

                    const absoluteIndex =
                        (safePage * PAGE_SIZE) +
                        index +
                        1;

                    const count =
                        getPlayCount(
                            item.id,
                            stats
                        );

                    return (
                        `**${absoluteIndex}.** ` +
                        `${item.emoji} ` +
                        `${item.title} ` +
                        `\`${count} click\``
                    );
                }
            )
            : [
                'Nessun video trovato.'
            ];

    // Discord limita ogni field dell'embed a 1024 caratteri.
    // Creiamo quindi piu' blocchi automaticamente se necessario.

    const catalogChunks = [];

    let currentCatalogChunk = '';

    for (const line of catalogLines) {

        const candidate =
            currentCatalogChunk
                ? `${currentCatalogChunk}\n${line}`
                : line;

        if (candidate.length > 1000) {

            if (currentCatalogChunk) {
                catalogChunks.push(
                    currentCatalogChunk
                );
            }

            currentCatalogChunk =
                line;

        } else {

            currentCatalogChunk =
                candidate;
        }
    }

    if (currentCatalogChunk) {
        catalogChunks.push(
            currentCatalogChunk
        );
    }
    const topLines =
        top
            .map(
                (item, index) => {

                    const count =
                        getPlayCount(
                            item.id,
                            stats
                        );

                    return (
                        `**${index + 1}.** ` +
                        `${item.emoji} ` +
                        `${item.title} - ` +
                        `\`${count}\` click`
                    );
                }
            )
            .join('\n');

    const categoryInfo =
        query
            ? {
                label:
                    `Ricerca: ${query}`,

                emoji:
                    '\u{1F50E}'
            }
            : (
                libraryCategories[
                    resolvedCategory
                ] ||
                libraryCategories.popular
            );

    const embed =
        new EmbedBuilder()
            .setTitle(
                '\u{1F4FA} IURP MEDIA HUB'
            )
            .setColor(
                '#ff0000'
            )
            .setDescription(
                '**La vostra libreria cult, tutta a un tocco.**\n' +
                'Scegli un video dal menu oppure usa uno dei Top 5 qui sotto.'
            )
            .addFields(

                {
                    name:
                        '\u{1F525} Piu\' cliccati',

                    value:
                        topLines ||
                        'Nessun dato disponibile.',

                    inline:
                        false
                },

                {
                    name:
                        `${categoryInfo.emoji} Sezione`,

                    value:
                        `**${categoryInfo.label}**\n` +
                        `${items.length} video disponibili`,

                    inline:
                        true
                },

                {
                    name:
                        '\u{1F4A1} Come si usa',

                    value:
                        'Top 5 = riproduzione immediata. ' +
                        'Il menu video contiene tutta la sezione corrente.',

                    inline:
                        true
                }
            )
            .setFooter({
                text:
                    `Pagina ${safePage + 1}/${totalPages} | ` +
                    `${libraryCatalog.length} video nel catalogo`
            });

    // ========================================================
    // FIELD DEL CATALOGO
    // ========================================================

    for (
        let i = 0;
        i < catalogChunks.length;
        i++
    ) {

        embed.addFields({
            name:
                i === 0
                    ? `\u{1F4DA} Catalogo - Pagina ${safePage + 1}`
                    : '\u{1F4DA} Catalogo - continua',

            value:
                catalogChunks[i],

            inline:
                false
        });
    }
    const topRow =
        new ActionRowBuilder();

    for (const item of top) {

        topRow.addComponents(

            new ButtonBuilder()
                .setCustomId(
                    `media_play:${item.id}`
                )
                .setLabel(
                    shortLabel(
                        item.title,
                        18
                    )
                )
                .setEmoji(
                    item.emoji
                )
                .setStyle(
                    ButtonStyle.Primary
                )
        );
    }

    const categoryMenu =
        new StringSelectMenuBuilder()
            .setCustomId(
                'media_category'
            )
            .setPlaceholder(
                'Scegli una categoria...'
            );

    for (
        const [
            value,
            meta
        ]
        of
        Object.entries(
            libraryCategories
        )
    ) {

        categoryMenu.addOptions(

            new StringSelectMenuOptionBuilder()
                .setLabel(
                    meta.label
                )
                .setValue(
                    value
                )
                .setEmoji(
                    meta.emoji
                )
                .setDefault(
                    !query &&
                    value === resolvedCategory
                )
        );
    }

    const categoryRow =
        new ActionRowBuilder()
            .addComponents(
                categoryMenu
            );

    const videoMenu =
        new StringSelectMenuBuilder()
            .setCustomId(
                'media_video'
            )
            .setPlaceholder(
                pageItems.length
                    ? 'Scegli un video da riprodurre...'
                    : 'Nessun video trovato'
            )
            .setDisabled(
                pageItems.length === 0
            );

    if (
        pageItems.length === 0
    ) {

        videoMenu.addOptions(

            new StringSelectMenuOptionBuilder()
                .setLabel(
                    'Nessun risultato'
                )
                .setValue(
                    '__none__'
                )
        );

    } else {

        for (
            const item
            of
            pageItems
        ) {

            const aliases =
                (item.aliases || [])
                    .map(
                        alias =>
                            `!${alias}`
                    )
                    .join(', ');

            const count =
                getPlayCount(
                    item.id,
                    stats
                );

            // Testo visualizzato nel dropdown:
            //
            // LABEL       = comando / alias
            // DESCRIPTION = titolo associato + click
            //
            // Esempio:
            //
            // !gelato
            // Gelato al cioccolato | 5 click

            const realYoutubeTitle =
                getCachedYoutubeTitle(
                    item
                );

            const dropdownDisplayTitle =
                shortLabel(
                    realYoutubeTitle ||
                        item.title ||
                        'Video',
                    95
                );

            const dropdownCatalogReference =
                shortLabel(
                    item.title ||
                        'Video',
                    78
                );

            videoMenu.addOptions(

                new StringSelectMenuOptionBuilder()
                    .setLabel(
                        dropdownDisplayTitle
                    )
                    .setValue(
                        item.id
                    )
                    .setEmoji(
                        item.emoji
                    )
                    .setDescription(
                        shortLabel(
                            `${dropdownCatalogReference} | ${count} click`,
                            100
                        )
                    )
            );
        }
    }

    const videoRow =
        new ActionRowBuilder()
            .addComponents(
                videoMenu
            );

    const navRow =
        new ActionRowBuilder()
            .addComponents(

                new ButtonBuilder()
                    .setCustomId(
                        'media_prev'
                    )
                    .setLabel(
                        'Indietro'
                    )
                    .setEmoji(
                        '\u25C0\uFE0F'
                    )
                    .setStyle(
                        ButtonStyle.Secondary
                    )
                    .setDisabled(
                        safePage <= 0
                    ),

                new ButtonBuilder()
                    .setCustomId(
                        'media_search'
                    )
                    .setLabel(
                        'Cerca'
                    )
                    .setEmoji(
                        '\u{1F50E}'
                    )
                    .setStyle(
                        ButtonStyle.Success
                    ),

                new ButtonBuilder()
                    .setCustomId(
                        'media_refresh'
                    )
                    .setLabel(
                        'Aggiorna'
                    )
                    .setEmoji(
                        '\u{1F504}'
                    )
                    .setStyle(
                        ButtonStyle.Secondary
                    ),

                new ButtonBuilder()
                    .setCustomId(
                        'media_next'
                    )
                    .setLabel(
                        'Avanti'
                    )
                    .setEmoji(
                        '\u25B6\uFE0F'
                    )
                    .setStyle(
                        ButtonStyle.Secondary
                    )
                    .setDisabled(
                        safePage >=
                        totalPages - 1
                    )
            );

    return {

        payload: {
            embeds: [
                embed
            ],

            components: [
                topRow,
                categoryRow,
                videoRow,
                navRow
            ]
        },

        state: {
            category:
                resolvedCategory,
            page:
                safePage,
            query,
            totalPages,
            totalItems:
                items.length
        }
    };
}

module.exports = {
    CATALOG,
    CATEGORY_META,
    buildMediaHub,
    getMediaItem,
    getLibraryCatalog,
    getLibraryCategories,
    getCachedYoutubeTitle,
    incrementPlay,
    searchItems,
    refreshMediaTitles
};