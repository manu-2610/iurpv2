const fs = require('fs');
const path = require('path');
const youtubeDl = require('youtube-dl-exec');
const {
    ApplicationCommandOptionType,
    PermissionFlagsBits,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags
} = require('discord.js');

const store = require('./media-library-store');
const mediaHub = require('./media-hub');

const ADMIN_PERMISSION = PermissionFlagsBits.Administrator.toString();
const ADMIN_COMMAND_NAMES = new Set([
    'aggiungivideo',
    'modificavideo',
    'spostavideo',
    'rimuovivideo',
    'ripristinavideo',
    'infovideo',
    'aggiungicategoria',
    'modificacategoria',
    'spostacategoriaalto',
    'spostacategoriabasso',
    'rimuovicategoria',
    'resetclick',
    'classificavideo',
    'attivitalibreria'
]);

function adminCommand(data) {
    return {
        ...data,
        defaultMemberPermissions: ADMIN_PERMISSION,
        dmPermission: false
    };
}

const MEDIA_ADMIN_COMMANDS = [
    adminCommand({
        name: 'aggiungivideo',
        description: 'Aggiungi un video alla libreria',
        options: [
            { name: 'url', type: ApplicationCommandOptionType.String, description: 'URL YouTube del video', required: true },
            { name: 'categoria', type: ApplicationCommandOptionType.String, description: 'Categoria della libreria', required: true, autocomplete: true },
            { name: 'nome', type: ApplicationCommandOptionType.String, description: 'Nome breve nel catalogo (facoltativo)', required: false },
            { name: 'alias', type: ApplicationCommandOptionType.String, description: 'Alias di ricerca separati da virgola', required: false },
            { name: 'emoji', type: ApplicationCommandOptionType.String, description: 'Emoji del video (default 🎬)', required: false },
            { name: 'timestamp', type: ApplicationCommandOptionType.Integer, description: 'Secondo iniziale da cui riprodurre', required: false, minValue: 0 }
        ]
    }),
    adminCommand({
        name: 'modificavideo',
        description: 'Modifica un video della libreria',
        options: [
            { name: 'video', type: ApplicationCommandOptionType.String, description: 'Video da modificare', required: true, autocomplete: true },
            { name: 'nome', type: ApplicationCommandOptionType.String, description: 'Nuovo nome breve', required: false },
            { name: 'url', type: ApplicationCommandOptionType.String, description: 'Nuovo URL YouTube', required: false },
            { name: 'alias', type: ApplicationCommandOptionType.String, description: 'Sostituisci alias (virgole, - per svuotare)', required: false },
            { name: 'emoji', type: ApplicationCommandOptionType.String, description: 'Nuova emoji', required: false },
            { name: 'timestamp', type: ApplicationCommandOptionType.Integer, description: 'Nuovo secondo iniziale', required: false, minValue: 0 },
            { name: 'categoria_aggiungi', type: ApplicationCommandOptionType.String, description: 'Aggiungi anche questa categoria', required: false, autocomplete: true },
            { name: 'categoria_rimuovi', type: ApplicationCommandOptionType.String, description: 'Rimuovi questa categoria', required: false, autocomplete: true }
        ]
    }),
    adminCommand({
        name: 'spostavideo',
        description: 'Sposta un video da una categoria a un altra',
        options: [
            { name: 'video', type: ApplicationCommandOptionType.String, description: 'Video da spostare', required: true, autocomplete: true },
            { name: 'destinazione', type: ApplicationCommandOptionType.String, description: 'Nuova categoria', required: true, autocomplete: true },
            { name: 'origine', type: ApplicationCommandOptionType.String, description: 'Categoria da sostituire (necessaria se il video ne ha piu di una)', required: false, autocomplete: true }
        ]
    }),
    adminCommand({
        name: 'rimuovivideo',
        description: 'Rimuovi un video dalla libreria (ripristinabile)',
        options: [
            { name: 'video', type: ApplicationCommandOptionType.String, description: 'Video da rimuovere', required: true, autocomplete: true }
        ]
    }),
    adminCommand({
        name: 'ripristinavideo',
        description: 'Ripristina un video rimosso dalla libreria',
        options: [
            { name: 'video', type: ApplicationCommandOptionType.String, description: 'Video rimosso da ripristinare', required: true, autocomplete: true }
        ]
    }),
    adminCommand({
        name: 'infovideo',
        description: 'Mostra tutte le informazioni su un video',
        options: [
            { name: 'video', type: ApplicationCommandOptionType.String, description: 'Video da ispezionare', required: true, autocomplete: true }
        ]
    }),
    adminCommand({
        name: 'aggiungicategoria',
        description: 'Crea una nuova categoria nella libreria',
        options: [
            { name: 'nome', type: ApplicationCommandOptionType.String, description: 'Nome della categoria', required: true },
            { name: 'emoji', type: ApplicationCommandOptionType.String, description: 'Emoji della categoria (default 📁)', required: false }
        ]
    }),
    adminCommand({
        name: 'modificacategoria',
        description: 'Modifica nome o emoji di una categoria',
        options: [
            { name: 'categoria', type: ApplicationCommandOptionType.String, description: 'Categoria da modificare', required: true, autocomplete: true },
            { name: 'nome', type: ApplicationCommandOptionType.String, description: 'Nuovo nome', required: false },
            { name: 'emoji', type: ApplicationCommandOptionType.String, description: 'Nuova emoji', required: false }
        ]
    }),
    adminCommand({
        name: 'spostacategoriaalto',
        description: 'Sposta una categoria verso l alto nell elenco',
        options: [
            { name: 'categoria', type: ApplicationCommandOptionType.String, description: 'Categoria da spostare', required: true, autocomplete: true },
            { name: 'posti', type: ApplicationCommandOptionType.Integer, description: 'Numero di posizioni (default 1)', required: false, minValue: 1, maxValue: 24 }
        ]
    }),
    adminCommand({
        name: 'spostacategoriabasso',
        description: 'Sposta una categoria verso il basso nell elenco',
        options: [
            { name: 'categoria', type: ApplicationCommandOptionType.String, description: 'Categoria da spostare', required: true, autocomplete: true },
            { name: 'posti', type: ApplicationCommandOptionType.Integer, description: 'Numero di posizioni (default 1)', required: false, minValue: 1, maxValue: 24 }
        ]
    }),
    adminCommand({
        name: 'rimuovicategoria',
        description: 'Rimuovi una categoria e trasferisci i suoi video',
        options: [
            { name: 'categoria', type: ApplicationCommandOptionType.String, description: 'Categoria da rimuovere', required: true, autocomplete: true },
            { name: 'sposta_in', type: ApplicationCommandOptionType.String, description: 'Destinazione dei video contenuti', required: false, autocomplete: true }
        ]
    }),
    adminCommand({
        name: 'resetclick',
        description: 'Azzera le statistiche click della libreria',
        options: [
            {
                name: 'ambito',
                type: ApplicationCommandOptionType.String,
                description: 'Cosa vuoi azzerare?',
                required: true,
                choices: [
                    { name: 'Un singolo video', value: 'video' },
                    { name: 'Tutta la libreria', value: 'tutto' }
                ]
            },
            { name: 'video', type: ApplicationCommandOptionType.String, description: 'Video da azzerare', required: false, autocomplete: true }
        ]
    }),
    adminCommand({
        name: 'classificavideo',
        description: 'Mostra la classifica completa dei video piu cliccati',
        options: [
            { name: 'limite', type: ApplicationCommandOptionType.Integer, description: 'Numero di risultati (5-25)', required: false, minValue: 5, maxValue: 25 }
        ]
    }),
    adminCommand({
        name: 'attivitalibreria',
        description: 'Mostra le ultime modifiche amministrative alla libreria',
        options: [
            { name: 'limite', type: ApplicationCommandOptionType.Integer, description: 'Numero di attivita (5-20)', required: false, minValue: 5, maxValue: 20 }
        ]
    })
];

function isAdmin(interaction) {
    return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}

function ephemeral(content) {
    return { content, flags: MessageFlags.Ephemeral };
}

function parseAliases(raw) {
    if (raw === null || raw === undefined) return null;
    const text = String(raw).trim();
    if (text === '-') return [];
    return [...new Set(
        text.split(',')
            .map(value => value.trim().replace(/^!+/, '').toLowerCase())
            .filter(Boolean)
            .map(value => value.replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '').slice(0, 40))
            .filter(Boolean)
    )];
}

function validEmoji(value, fallback = '🎬') {
    const text = String(value || '').trim();
    return text ? text.slice(0, 32) : fallback;
}

function timestampFromUrl(rawUrl) {
    try {
        const url = new URL(rawUrl);
        const raw = url.searchParams.get('t') || url.searchParams.get('start');
        if (!raw) return 0;
        if (/^\d+$/.test(raw)) return Number(raw);
        const hours = Number((raw.match(/(\d+)h/) || [])[1] || 0);
        const minutes = Number((raw.match(/(\d+)m/) || [])[1] || 0);
        const seconds = Number((raw.match(/(\d+)s/) || [])[1] || 0);
        return (hours * 3600) + (minutes * 60) + seconds;
    } catch {
        return 0;
    }
}

async function inspectUrl(rawUrl) {
    const url = String(rawUrl || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('Inserisci un URL valido.');

    const flags = {
        dumpSingleJson: true,
        skipDownload: true,
        noWarnings: true,
        noPlaylist: true,
        jsRuntimes: 'node',
        remoteComponents: 'ejs:github',
        socketTimeout: 20
    };

    const cookies = path.join(__dirname, 'cookies.txt');
    if (fs.existsSync(cookies)) flags.cookies = cookies;

    let output = await youtubeDl(url, flags);
    if (typeof output === 'string') output = JSON.parse(output.trim());
    if (Array.isArray(output?.entries)) output = output.entries.find(Boolean);
    if (!output || typeof output !== 'object') throw new Error('yt-dlp non ha restituito metadati utilizzabili.');

    const title = String(output.title || '').trim();
    const canonicalUrl = String(output.webpage_url || output.original_url || url).trim();
    if (!title) throw new Error('Non riesco a recuperare il titolo del video.');

    return {
        title,
        url: canonicalUrl,
        duration: Number(output.duration) || null,
        uploader: String(output.channel || output.uploader || '').trim() || null
    };
}

function baseCatalog() {
    return mediaHub.CATALOG;
}

function baseCategories() {
    return mediaHub.CATEGORY_META;
}

function activeCatalog() {
    return mediaHub.getLibraryCatalog();
}

function allVideos() {
    return store.getAllVideoRecords(baseCatalog());
}

function activeCategories() {
    return mediaHub.getLibraryCategories();
}

function requireEditableCategory(id) {
    if (!id || store.PROTECTED_CATEGORY_IDS.has(id)) throw new Error('Categoria non valida o protetta.');
    if (!activeCategories()[id]) throw new Error('Categoria non trovata.');
}

function validateAliases(aliases, ignoreId = null) {
    if (!aliases) return;
    for (const alias of aliases) {
        const owner = store.findAliasOwner(alias, baseCatalog(), ignoreId);
        if (owner) throw new Error(`Alias "${alias}" gia usato da ${owner.title}.`);
    }
}

function formatCategories(ids) {
    const categories = activeCategories();
    return (ids || []).map(id => categories[id] ? `${categories[id].emoji} ${categories[id].label}` : id).join(', ') || 'Nessuna';
}

function videoChoiceLabel(item) {
    const prefix = item.hidden ? '🗑️ ' : `${item.emoji || '🎬'} `;
    return `${prefix}${item.title}`.slice(0, 100);
}

function categoryChoices({ includeVirtual = false } = {}) {
    return Object.entries(activeCategories())
        .filter(([id]) => includeVirtual || !store.PROTECTED_CATEGORY_IDS.has(id))
        .map(([id, meta]) => ({ name: `${meta.emoji} ${meta.label}`.slice(0, 100), value: id }));
}

function fuzzyChoices(items, query, mapper) {
    const needle = String(query || '').toLocaleLowerCase('it').trim();
    const scored = items.map(item => {
        const choice = mapper(item);
        const hay = `${choice.name} ${choice.value}`.toLocaleLowerCase('it');
        let score = 0;
        if (!needle) score = 1;
        else if (hay.startsWith(needle)) score = 4;
        else if (hay.includes(needle)) score = 2;
        return { choice, score };
    }).filter(entry => entry.score > 0);

    scored.sort((a, b) => b.score - a.score || a.choice.name.localeCompare(b.choice.name, 'it'));
    return scored.slice(0, 25).map(entry => entry.choice);
}

async function handleLibraryAdminAutocomplete(interaction) {
    if (!interaction.isAutocomplete() || !ADMIN_COMMAND_NAMES.has(interaction.commandName)) return false;
    if (!isAdmin(interaction)) {
        await interaction.respond([]);
        return true;
    }

    const focused = interaction.options.getFocused(true);
    const command = interaction.commandName;
    let choices = [];

    if (focused.name === 'video') {
        const items = command === 'ripristinavideo'
            ? store.getHiddenVideos(baseCatalog())
            : activeCatalog();
        choices = fuzzyChoices(items, focused.value, item => ({ name: videoChoiceLabel(item), value: item.id }));
    } else if (['categoria', 'destinazione', 'sposta_in', 'categoria_aggiungi', 'categoria_rimuovi'].includes(focused.name)) {
        let source = categoryChoices();
        if (focused.name === 'categoria_rimuovi' || focused.name === 'origine') {
            const videoId = interaction.options.getString('video');
            const video = videoId ? mediaHub.getMediaItem(videoId) : null;
            if (video) {
                const allowed = new Set(video.categories || []);
                source = source.filter(choice => allowed.has(choice.value));
            }
        }
        choices = fuzzyChoices(source, focused.value, item => item);
    } else if (focused.name === 'origine') {
        const videoId = interaction.options.getString('video');
        const video = videoId ? mediaHub.getMediaItem(videoId) : null;
        const source = video
            ? categoryChoices().filter(choice => (video.categories || []).includes(choice.value))
            : categoryChoices();
        choices = fuzzyChoices(source, focused.value, item => item);
    }

    await interaction.respond(choices);
    return true;
}

function confirmationRow(confirmId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(confirmId).setLabel('Conferma').setEmoji('✅').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('libadmin:cancel').setLabel('Annulla').setEmoji('❌').setStyle(ButtonStyle.Secondary)
    );
}

async function refreshAfterChange(refreshHubs) {
    if (typeof refreshHubs === 'function') {
        try { await refreshHubs(); } catch (err) { console.warn('[LIBRARY] Refresh Media Hub fallito:', err.message); }
    }
}

async function handleAddVideo(interaction, refreshHubs) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const rawUrl = interaction.options.getString('url', true);
    const category = interaction.options.getString('categoria', true);
    requireEditableCategory(category);

    const duplicate = store.findDuplicateUrl(rawUrl, baseCatalog());
    if (duplicate) return interaction.editReply(`❌ Questo video e gia presente come **${duplicate.title}**.`);

    const info = await inspectUrl(rawUrl);
    const canonicalDuplicate = store.findDuplicateUrl(info.url, baseCatalog());
    if (canonicalDuplicate) return interaction.editReply(`❌ Questo video e gia presente come **${canonicalDuplicate.title}**.`);

    const aliases = parseAliases(interaction.options.getString('alias'));
    validateAliases(aliases);
    const requestedName = interaction.options.getString('nome');
    const title = String(requestedName || info.title).trim().slice(0, 120);
    const aliasSeed = aliases?.[0] || title;
    const usedIds = new Set(allVideos().map(item => item.id));
    const id = store.uniqueId(aliasSeed, usedIds);
    const finalAliases = aliases === null ? [id] : aliases;
    validateAliases(finalAliases);

    const explicitTimestamp = interaction.options.getInteger('timestamp');
    const start = explicitTimestamp ?? timestampFromUrl(rawUrl);
    const item = store.addVideo({
        id,
        title,
        emoji: validEmoji(interaction.options.getString('emoji')),
        url: info.url,
        aliases: finalAliases,
        categories: [category],
        start,
        featuredRank: 9999
    }, baseCatalog(), interaction.user);

    store.setTitleCache(item.id, info.title);
    await refreshAfterChange(refreshHubs);

    return interaction.editReply({
        embeds: [new EmbedBuilder()
            .setColor('#35c759')
            .setTitle('✅ Video aggiunto alla libreria')
            .addFields(
                { name: '🎬 Titolo YouTube', value: info.title.slice(0, 1024) },
                { name: '📚 Nome catalogo', value: `${item.emoji} ${item.title}`, inline: true },
                { name: '📁 Categoria', value: formatCategories(item.categories), inline: true },
                { name: '🆔 ID', value: `\`${item.id}\``, inline: true },
                { name: '🏷️ Alias', value: item.aliases.length ? item.aliases.map(value => `\`${value}\``).join(', ') : 'Nessuno' }
            )]
    });
}

async function handleModifyVideo(interaction, refreshHubs) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const id = interaction.options.getString('video', true);
    const current = mediaHub.getMediaItem(id);
    if (!current) return interaction.editReply('❌ Video non trovato.');

    const patch = {};
    const name = interaction.options.getString('nome');
    const url = interaction.options.getString('url');
    const aliasRaw = interaction.options.getString('alias');
    const emoji = interaction.options.getString('emoji');
    const timestamp = interaction.options.getInteger('timestamp');
    const addCategory = interaction.options.getString('categoria_aggiungi');
    const removeCategory = interaction.options.getString('categoria_rimuovi');

    if (name !== null) {
        patch.title = String(name).trim().slice(0, 120);
        if (!patch.title) return interaction.editReply('❌ Il nome del video non puo essere vuoto.');
    }
    if (emoji !== null) patch.emoji = validEmoji(emoji, current.emoji || '🎬');
    if (timestamp !== null) patch.start = timestamp;
    if (aliasRaw !== null) {
        patch.aliases = parseAliases(aliasRaw);
        validateAliases(patch.aliases, id);
    }

    if (url !== null) {
        const duplicate = store.findDuplicateUrl(url, baseCatalog(), id);
        if (duplicate) return interaction.editReply(`❌ URL gia usato da **${duplicate.title}**.`);
        const info = await inspectUrl(url);
        const canonicalDuplicate = store.findDuplicateUrl(info.url, baseCatalog(), id);
        if (canonicalDuplicate) return interaction.editReply(`❌ URL gia usato da **${canonicalDuplicate.title}**.`);
        patch.url = info.url;
        patch.__realYoutubeTitle = info.title;
    }

    if (addCategory || removeCategory) {
        const categories = [...(current.categories || [])];
        if (addCategory) {
            requireEditableCategory(addCategory);
            if (!categories.includes(addCategory)) categories.push(addCategory);
        }
        if (removeCategory) {
            requireEditableCategory(removeCategory);
            const next = categories.filter(value => value !== removeCategory);
            if (!next.length) return interaction.editReply('❌ Un video deve appartenere ad almeno una categoria. Aggiungine una prima di rimuovere l ultima.');
            patch.categories = next;
        } else if (addCategory) {
            patch.categories = categories;
        }
    }

    if (!Object.keys(patch).length) return interaction.editReply('❌ Non hai specificato alcuna modifica.');
    const realYoutubeTitle = patch.__realYoutubeTitle;
    delete patch.__realYoutubeTitle;
    store.updateVideo(id, patch, baseCatalog(), interaction.user);
    if (realYoutubeTitle) store.setTitleCache(id, realYoutubeTitle);
    await refreshAfterChange(refreshHubs);
    return interaction.editReply(`✅ **${patch.title || current.title}** aggiornato correttamente.`);
}

async function handleMoveVideo(interaction, refreshHubs) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const id = interaction.options.getString('video', true);
    const destination = interaction.options.getString('destinazione', true);
    const origin = interaction.options.getString('origine');
    try {
        const categories = store.moveVideoCategory(id, origin, destination, baseCatalog(), baseCategories(), interaction.user);
        await refreshAfterChange(refreshHubs);
        return interaction.editReply(`✅ Video spostato. Categorie attuali: ${formatCategories(categories)}.`);
    } catch (err) {
        if (err.code === 'NEED_ORIGIN') {
            return interaction.editReply(`❌ Il video e in piu categorie (${formatCategories(err.categories)}). Ripeti il comando specificando **origine**.`);
        }
        throw err;
    }
}

async function handleRemoveVideo(interaction) {
    const id = interaction.options.getString('video', true);
    const video = mediaHub.getMediaItem(id);
    if (!video) return interaction.reply(ephemeral('❌ Video non trovato.'));
    return interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [new EmbedBuilder()
            .setColor('#ff3b30')
            .setTitle('⚠️ Conferma rimozione')
            .setDescription(`Vuoi rimuovere **${video.title}** dalla libreria?\n\nLa rimozione e reversibile con \`/ripristinavideo\`.`)],
        components: [confirmationRow(`libadmin:removevideo:${id}`)]
    });
}

async function handleRestoreVideo(interaction, refreshHubs) {
    const id = interaction.options.getString('video', true);
    const hidden = store.getVideoRecord(id, baseCatalog(), { includeHidden: true });
    if (!hidden?.hidden) return interaction.reply(ephemeral('❌ Video rimosso non trovato.'));
    store.restoreVideo(id, baseCatalog(), interaction.user);
    await refreshAfterChange(refreshHubs);
    return interaction.reply(ephemeral(`✅ **${hidden.title}** e stato ripristinato.`));
}

async function handleInfoVideo(interaction) {
    const id = interaction.options.getString('video', true);
    const video = store.getVideoRecord(id, baseCatalog(), { includeHidden: true });
    if (!video) return interaction.reply(ephemeral('❌ Video non trovato.'));
    const stats = store.loadStats();
    const realTitle = mediaHub.getCachedYoutubeTitle(video) || 'Non disponibile';
    return interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [new EmbedBuilder()
            .setColor(video.hidden ? '#666666' : '#ff0000')
            .setTitle(`${video.emoji || '🎬'} ${video.title}`)
            .addFields(
                { name: '🎬 Titolo YouTube', value: realTitle.slice(0, 1024) },
                { name: '🔗 URL', value: video.url.slice(0, 1024) },
                { name: '📁 Categorie', value: formatCategories(video.categories) },
                { name: '🏷️ Alias', value: (video.aliases || []).length ? video.aliases.map(v => `\`${v}\``).join(', ') : 'Nessuno' },
                { name: '🔥 Click', value: String(Number(stats[id] || 0)), inline: true },
                { name: '⏱️ Timestamp', value: `${Number(video.start || 0)}s`, inline: true },
                { name: '🆔 ID', value: `\`${video.id}\``, inline: true },
                { name: '📦 Provenienza', value: video.source === 'custom' ? 'Aggiunto da Discord' : 'Catalogo storico', inline: true },
                { name: '👁️ Stato', value: video.hidden ? 'Rimosso (ripristinabile)' : 'Attivo', inline: true }
            )]
    });
}

async function handleAddCategory(interaction, refreshHubs) {
    const created = store.createCategory({
        label: interaction.options.getString('nome', true),
        emoji: validEmoji(interaction.options.getString('emoji'), '📁')
    }, baseCategories(), interaction.user);
    await refreshAfterChange(refreshHubs);
    return interaction.reply(ephemeral(`✅ Categoria creata: **${created.emoji} ${created.label}** (ID \`${created.id}\`).`));
}

async function handleModifyCategory(interaction, refreshHubs) {
    const id = interaction.options.getString('categoria', true);
    const name = interaction.options.getString('nome');
    const emoji = interaction.options.getString('emoji');
    if (name === null && emoji === null) return interaction.reply(ephemeral('❌ Specifica almeno un nuovo nome o una nuova emoji.'));
    const patch = {};
    if (name !== null) patch.label = name;
    if (emoji !== null) patch.emoji = validEmoji(emoji, '📁');
    store.updateCategory(id, patch, baseCategories(), interaction.user);
    await refreshAfterChange(refreshHubs);
    const category = activeCategories()[id];
    return interaction.reply(ephemeral(`✅ Categoria aggiornata: **${category.emoji} ${category.label}**.`));
}

async function handleMoveCategoryPosition(interaction, direction, refreshHubs) {
    const id = interaction.options.getString('categoria', true);
    const steps = interaction.options.getInteger('posti') || 1;

    const categoriesBefore = activeCategories();
    const category = categoriesBefore[id];
    if (!category) {
        return interaction.reply(ephemeral('❌ Categoria non trovata.'));
    }

    const result = store.moveCategoryPosition(
        id,
        direction,
        steps,
        baseCategories(),
        interaction.user
    );

    if (!result.changed) {
        const edge = direction === 'up' ? 'in cima' : 'in fondo';
        return interaction.reply(
            ephemeral(`ℹ️ **${category.emoji} ${category.label}** e gia ${edge} all elenco.`)
        );
    }

    await refreshAfterChange(refreshHubs);

    const arrow = direction === 'up' ? '⬆️' : '⬇️';
    const directionText = direction === 'up' ? 'verso l alto' : 'verso il basso';
    const movedText = result.actualSteps === 1 ? '1 posizione' : `${result.actualSteps} posizioni`;

    return interaction.reply(
        ephemeral(
            `${arrow} **${category.emoji} ${category.label}** spostata ${directionText} di **${movedText}**.\n` +
            `Nuova posizione: **${result.toIndex + 1}/${result.total}**.`
        )
    );
}

async function handleRemoveCategory(interaction) {
    const id = interaction.options.getString('categoria', true);
    const destination = interaction.options.getString('sposta_in');
    try {
        requireEditableCategory(id);
        if (destination) requireEditableCategory(destination);
        const affected = activeCatalog().filter(video => (video.categories || []).includes(id)).length;
        if (affected && !destination) {
            return interaction.reply(ephemeral(`❌ Questa categoria contiene **${affected} video**. Ripeti il comando indicando **sposta_in**.`));
        }
        const category = activeCategories()[id];
        const destinationText = destination ? `\nI ${affected} video verranno trasferiti in **${activeCategories()[destination].label}**.` : '';
        return interaction.reply({
            flags: MessageFlags.Ephemeral,
            embeds: [new EmbedBuilder().setColor('#ff3b30').setTitle('⚠️ Conferma rimozione categoria').setDescription(`Vuoi rimuovere **${category.emoji} ${category.label}**?${destinationText}`)],
            components: [confirmationRow(`libadmin:removecategory:${id}:${destination || '_'}`)]
        });
    } catch (err) {
        return interaction.reply(ephemeral(`❌ ${err.message}`));
    }
}

async function handleResetClick(interaction) {
    const scope = interaction.options.getString('ambito', true);
    if (scope === 'tutto') {
        return interaction.reply({
            flags: MessageFlags.Ephemeral,
            embeds: [new EmbedBuilder().setColor('#ff3b30').setTitle('⚠️ Reset globale click').setDescription('Stai per azzerare **tutte** le statistiche della libreria. Questa operazione crea comunque un backup.')],
            components: [confirmationRow('libadmin:resetall')]
        });
    }
    const id = interaction.options.getString('video');
    if (!id) return interaction.reply(ephemeral('❌ Con ambito "video" devi selezionare anche un video.'));
    const video = mediaHub.getMediaItem(id);
    if (!video) return interaction.reply(ephemeral('❌ Video non trovato.'));
    return interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [new EmbedBuilder().setColor('#ff9500').setTitle('⚠️ Conferma reset click').setDescription(`Azzerare i click di **${video.title}**?`)],
        components: [confirmationRow(`libadmin:resetvideo:${id}`)]
    });
}

async function handleRanking(interaction) {
    const limit = interaction.options.getInteger('limite') || 15;
    const stats = store.loadStats();
    const items = activeCatalog()
        .map(item => ({ ...item, clicks: Number(stats[item.id] || 0) }))
        .sort((a, b) => b.clicks - a.clicks || a.title.localeCompare(b.title, 'it'))
        .slice(0, limit);
    const lines = items.map((item, index) => `**${index + 1}.** ${item.emoji || '🎬'} ${item.title} — \`${item.clicks}\``).join('\n') || 'Nessun dato.';
    return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('🏆 Classifica libreria').setDescription(lines)] });
}

async function handleActivity(interaction) {
    const limit = interaction.options.getInteger('limite') || 10;
    const entries = store.getRecentAudit(limit);
    const lines = entries.map(entry => {
        const when = Math.floor(new Date(entry.at).getTime() / 1000);
        const subject = entry.details?.title || entry.details?.id || entry.details?.label || '';
        return `• <t:${when}:R> **${entry.action}**${subject ? ` — ${subject}` : ''} · ${entry.actorTag || 'unknown'}`;
    }).join('\n') || 'Nessuna modifica registrata.';
    return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [new EmbedBuilder().setColor('#5865f2').setTitle('🧾 Attivita libreria').setDescription(lines.slice(0, 4000))] });
}

async function handleLibraryAdminCommand(interaction, { refreshHubs } = {}) {
    if (!interaction.isChatInputCommand() || !ADMIN_COMMAND_NAMES.has(interaction.commandName)) return false;
    if (!isAdmin(interaction)) {
        await interaction.reply(ephemeral('❌ Questo comando e riservato agli amministratori.'));
        return true;
    }

    try {
        switch (interaction.commandName) {
            case 'aggiungivideo': await handleAddVideo(interaction, refreshHubs); break;
            case 'modificavideo': await handleModifyVideo(interaction, refreshHubs); break;
            case 'spostavideo': await handleMoveVideo(interaction, refreshHubs); break;
            case 'rimuovivideo': await handleRemoveVideo(interaction); break;
            case 'ripristinavideo': await handleRestoreVideo(interaction, refreshHubs); break;
            case 'infovideo': await handleInfoVideo(interaction); break;
            case 'aggiungicategoria': await handleAddCategory(interaction, refreshHubs); break;
            case 'modificacategoria': await handleModifyCategory(interaction, refreshHubs); break;
            case 'spostacategoriaalto': await handleMoveCategoryPosition(interaction, 'up', refreshHubs); break;
            case 'spostacategoriabasso': await handleMoveCategoryPosition(interaction, 'down', refreshHubs); break;
            case 'rimuovicategoria': await handleRemoveCategory(interaction); break;
            case 'resetclick': await handleResetClick(interaction); break;
            case 'classificavideo': await handleRanking(interaction); break;
            case 'attivitalibreria': await handleActivity(interaction); break;
        }
    } catch (err) {
        console.error(`[LIBRARY ADMIN] ${interaction.commandName}:`, err);
        const message = `❌ ${err?.message || 'Operazione non riuscita.'}`;
        if (interaction.deferred || interaction.replied) await interaction.editReply(message).catch(() => {});
        else await interaction.reply(ephemeral(message)).catch(() => {});
    }
    return true;
}

async function handleLibraryAdminButton(interaction, { refreshHubs } = {}) {
    if (!interaction.isButton() || !interaction.customId.startsWith('libadmin:')) return false;
    if (!isAdmin(interaction)) {
        await interaction.reply(ephemeral('❌ Solo gli amministratori possono confermare questa operazione.'));
        return true;
    }

    const parts = interaction.customId.split(':');
    const action = parts[1];
    if (action === 'cancel') {
        await interaction.update({ content: '❎ Operazione annullata.', embeds: [], components: [] });
        return true;
    }

    try {
        if (action === 'removevideo') {
            const id = parts[2];
            const video = mediaHub.getMediaItem(id);
            store.hideVideo(id, baseCatalog(), interaction.user);
            await refreshAfterChange(refreshHubs);
            await interaction.update({ content: `✅ **${video?.title || id}** rimosso. Puoi ripristinarlo con \`/ripristinavideo\`.`, embeds: [], components: [] });
        } else if (action === 'removecategory') {
            const id = parts[2];
            const destination = parts[3] && parts[3] !== '_' ? parts[3] : null;
            const category = activeCategories()[id];
            const affected = store.removeCategory(id, destination, baseCatalog(), baseCategories(), interaction.user);
            await refreshAfterChange(refreshHubs);
            await interaction.update({ content: `✅ Categoria **${category?.label || id}** rimossa. Video trasferiti: ${affected}.`, embeds: [], components: [] });
        } else if (action === 'resetvideo') {
            const id = parts[2];
            const video = mediaHub.getMediaItem(id);
            const previous = store.resetVideoClicks(id, interaction.user);
            await refreshAfterChange(refreshHubs);
            await interaction.update({ content: `✅ Click di **${video?.title || id}** azzerati (prima: ${previous}).`, embeds: [], components: [] });
        } else if (action === 'resetall') {
            store.resetAllClicks(interaction.user);
            await refreshAfterChange(refreshHubs);
            await interaction.update({ content: '✅ Tutti i click della libreria sono stati azzerati.', embeds: [], components: [] });
        } else {
            await interaction.reply(ephemeral('❌ Conferma non riconosciuta.'));
        }
    } catch (err) {
        console.error('[LIBRARY ADMIN BUTTON]', err);
        if (interaction.deferred || interaction.replied) await interaction.editReply(`❌ ${err.message}`).catch(() => {});
        else await interaction.reply(ephemeral(`❌ ${err.message}`)).catch(() => {});
    }
    return true;
}

store.ensureDataFiles();

module.exports = {
    MEDIA_ADMIN_COMMANDS,
    ADMIN_COMMAND_NAMES,
    handleLibraryAdminAutocomplete,
    handleLibraryAdminCommand,
    handleLibraryAdminButton
};
