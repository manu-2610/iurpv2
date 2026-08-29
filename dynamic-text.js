const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { fetchTranscript } = require('youtube-transcript-plus');
const { Client: LrclibClient } = require('lrclib-api');

const lrclib = new LrclibClient({
    timeoutMs: 10000,
    fetch: (input, init = {}) => {
        const headers = new Headers(init.headers || {});
        headers.set('Lrclib-Client', 'IURPv2 Discord Bot/1.0');
        return fetch(input, { ...init, headers });
    }
});
const metadata = new Map();
const textCache = new Map();
const sessions = new Map();
const TICK_MS = 2000;

function clean(v) {
    return String(v || '').replace(/<[^>]+>/g, '').replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#39;/g, "'")
        .replace(/&quot;/gi, '"').replace(/\s+/g, ' ').trim();
}

function rememberMetadata(result) {
    if (!result?.url) return;
    metadata.set(result.url, { ...result });
    if (metadata.size > 250) metadata.delete(metadata.keys().next().value);
}

function mergeMetadata(url, track) {
    const data = metadata.get(url);
    if (!data || !track) return;
    const user = track.user;
    Object.assign(track, data);
    track.url = url;
    track.user = user;
}

function seek(state) {
    const ms = Number(state?.player?.state?.playbackDuration || 0);
    let speed = 1;
    if (state?.filters?.nightcore) speed = 1.25;
    else if (state?.filters?.vaporwave) speed = 0.75;
    return Math.max(0, (Number(state?.currentSeek) || 0) + (ms / 1000) * speed);
}

function fmt(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function bar(current, duration, len = 18) {
    const d = Number(duration);
    let pos;
    if (Number.isFinite(d) && d > 0) {
        pos = Math.min(len - 1, Math.round(Math.max(0, Math.min(1, current / d)) * (len - 1)));
    } else {
        const cycle = (len - 1) * 2;
        const step = Math.floor(current / 2) % cycle;
        pos = step <= len - 1 ? step : cycle - step;
    }
    const chars = Array(len).fill('\u2501');
    chars[pos] = '\u25CF';
    return chars.join('');
}

function withEnds(cues, duration) {
    const rows = (cues || []).filter(x => Number.isFinite(Number(x.start)) && clean(x.text))
        .sort((a, b) => Number(a.start) - Number(b.start));
    return rows.map((x, i) => {
        const start = Number(x.start);
        const explicit = Number(x.end);
        const next = rows[i + 1]?.start;
        const end = Number.isFinite(explicit) && explicit > start ? explicit
            : Number.isFinite(Number(next)) ? Math.max(start + .2, Number(next) - .05)
            : Number(duration) > start ? Number(duration) : start + 6;
        return { start, end, text: clean(x.text) };
    });
}

function activeCue(track, now) {
    const cues = track?.timedText?.cues;
    if (!Array.isArray(cues) || !cues.length) return null;
    let lo = 0, hi = cues.length - 1, found = null;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (cues[mid].start <= now) { found = cues[mid]; lo = mid + 1; }
        else hi = mid - 1;
    }
    return found && now <= found.end + .4 ? found : null;
}

function decorateDescription(description, state, stopped = false) {
    if (stopped || !state?.current) return description;
    const track = state.current;
    const now = seek(state);
    const duration = Number(track.duration);
    let line;

    if (track.timedTextStatus === 'loading') line = '\u23F3 *Recupero testo/trascrizione\u2026*';
    else if (track.timedText?.cues?.length) {
        const cue = activeCue(track, now);
        const icon = track.timedText.source === 'lrclib' ? '\uD83C\uDFA4' : '\uD83D\uDCAC';
        line = cue?.text ? `${icon} **${cue.text.slice(0, 900)}**` : `${icon} *\u2026*`;
    } else if (track.timedText?.fullText) line = '\uD83D\uDCDC *Testo disponibile dal pulsante Trascrizione, ma non sincronizzato.*';
    else if (track.timedTextStatus === 'unavailable') line = '\uD83D\uDCAC *Testo/trascrizione non disponibile.*';
    else line = '\u23F3 *Preparazione informazioni della traccia\u2026*';

    return `${description}\n\n${line}\n\n\`${fmt(now)}\`  ${bar(now, duration)}  \`${duration > 0 ? fmt(duration) : '?:??'}\``;
}

function songIdentity(track) {
    let title = String(track?.track || track?.title || '')
        .replace(/\s*[\[(].*?\b(official|video|audio|lyrics?|visualizer|4k|hd).*?[\])]\s*/gi, ' ')
        .replace(/\s+/g, ' ').trim();
    let artist = String(track?.artist || '').trim();
    if (!artist && title.includes(' - ')) {
        const parts = title.split(' - ');
        artist = parts.shift().trim();
        title = parts.join(' - ').trim();
    }
    return { title, artist };
}

function parseLrc(raw, duration) {
    const cues = [];
    for (const row of String(raw || '').split(/\r?\n/)) {
        const m = row.match(/^\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]\s*(.*)$/);
        if (!m) continue;
        const start = Number(m[1]) * 60 + Number(m[2]);
        const text = clean(m[3]);
        if (Number.isFinite(start) && text) cues.push({ start, text });
    }
    return withEnds(cues, duration);
}

async function lyrics(track) {
    const { title, artist } = songIdentity(track);
    const musical = track?.track || track?.artist ||
        track?.categories?.some?.(x => /music/i.test(String(x))) ||
        /\b(official\s+(music\s+)?video|official\s+audio|lyrics?|visualizer)\b/i.test(track?.title || '') ||
        /\s-\s/.test(track?.title || '') || /(?:- Topic|VEVO)$/i.test(track?.channel || '');
    if (!musical || !title) return null;

    try {
        let found = null;
        if (artist) {
            try {
                found = await lrclib.findLyrics({
                    track_name: title,
                    artist_name: artist,
                    ...(Number(track.duration) > 0 ? { duration: Math.round(Number(track.duration) * 1000) } : {})
                });
            } catch {}
        }

        if (!found) {
            const results = await lrclib.searchLyrics({ query: [artist, title].filter(Boolean).join(' ') });
            if (Array.isArray(results)) {
                const d = Number(track.duration);
                found = results.find(x => {
                    if (!x?.syncedLyrics && !x?.plainLyrics) return false;
                    if (!(d > 0) || !(Number(x.duration) > 0)) return true;
                    return Math.abs(d - Number(x.duration)) <= Math.max(30, d * .10);
                }) || null;
            }
        }

        if (!found) return null;
        const cues = parseLrc(found.syncedLyrics, Number(found.duration) || Number(track.duration));
        const fullText = String(found.plainLyrics || cues.map(x => x.text).join('\n') || '').trim();
        return cues.length || fullText ? { source: 'lrclib', sourceLabel: 'Testo', cues, fullText } : null;
    } catch (err) {
        console.warn('\u26A0\uFE0F LRCLIB non disponibile:', err?.message || err);
        return null;
    }
}

async function transcript(track) {
    if (!/^https?:\/\//i.test(track?.sourceUrl || '')) return null;
    try {
        const result = await fetchTranscript(track.sourceUrl, { videoDetails: true, retries: 2, retryDelay: 750 });
        const segments = Array.isArray(result) ? result : result?.segments;
        const details = Array.isArray(result) ? null : result?.videoDetails;
        if (!Array.isArray(segments) || !segments.length) return null;

        if (!(Number(track.duration) > 0) && Number(details?.lengthSeconds) > 0) {
            track.duration = Number(details.lengthSeconds);
        }

        const cues = withEnds(segments.map(x => ({
            start: Number(x.offset),
            end: Number(x.offset) + Number(x.duration || 0),
            text: x.text
        })), track.duration);

        return cues.length ? {
            source: 'youtube',
            sourceLabel: 'Trascrizione',
            cues,
            fullText: cues.map(x => x.text).join('\n')
        } : null;
    } catch (err) {
        console.warn('\u26A0\uFE0F Trascrizione YouTube non disponibile:', err?.message || err);
        return null;
    }
}

function key(track) {
    return track ? [track.sourceUrl || track.url || '', track.channel || '', track.title || ''].join('|') : null;
}

async function load(track) {
    const l = await lyrics(track);
    if (l?.cues?.length) return l;
    const t = await transcript(track);
    return t?.cues?.length ? t : (l?.fullText ? l : null);
}

async function ensure(state, updatePanel) {
    const track = state?.current;
    const k = key(track);
    if (!track || !k) return;
    if (state.__textKey === k && ['loading', 'ready', 'unavailable'].includes(track.timedTextStatus)) return;
    state.__textKey = k;

    if (textCache.has(k)) {
        track.timedText = textCache.get(k);
        track.timedTextStatus = track.timedText ? 'ready' : 'unavailable';
        await updatePanel?.();
        return;
    }

    track.timedText = null;
    track.timedTextStatus = 'loading';
    await updatePanel?.();

    try {
        const data = await load(track);
        textCache.set(k, data || null);
        if (key(state.current) !== k) return;
        state.current.timedText = data || null;
        state.current.timedTextStatus = data ? 'ready' : 'unavailable';
        console.log(data ? `\u2705 ${data.sourceLabel} pronto per: ${state.current.title}` : `\u2139\uFE0F Nessun testo disponibile per: ${state.current.title}`);
    } catch (err) {
        if (key(state.current) !== k) return;
        state.current.timedText = null;
        state.current.timedTextStatus = 'unavailable';
        textCache.set(k, null);
        console.warn('\u26A0\uFE0F Errore testo/trascrizione:', err?.message || err);
    }
    await updatePanel?.();
}

function start(state, updatePanel, isPaused) {
    if (!state) return;
    state.__updatePanel = updatePanel;
    state.__isPaused = isPaused;
    ensure(state, updatePanel).catch(err => console.warn('\u26A0\uFE0F Errore testo asincrono:', err?.message || err));

    if (state.__ticker) return;
    state.__ticker = setInterval(async () => {
        if (!state.current || !state.panelMessage || state.__updating || state.__isPaused?.()) return;
        state.__updating = true;
        try { await state.__updatePanel?.(); }
        finally { state.__updating = false; }
    }, TICK_MS);
}

function stop(state) {
    if (!state) return;
    if (state.__ticker) clearInterval(state.__ticker);
    state.__ticker = null;
    state.__updating = false;
    state.__updatePanel = null;
    state.__isPaused = null;
}

function pages(text, max = 3800) {
    const value = String(text || '').trim();
    if (!value) return [];
    const out = [];
    let current = '';
    for (const line of value.split(/\r?\n/)) {
        const add = current ? `\n${line}` : line;
        if ((current + add).length <= max) { current += add; continue; }
        if (current.trim()) out.push(current.trim());
        if (line.length <= max) current = line;
        else {
            let rest = line;
            while (rest.length > max) { out.push(rest.slice(0, max)); rest = rest.slice(max); }
            current = rest;
        }
    }
    if (current.trim()) out.push(current.trim());
    return out;
}

function sessionMessage(s, pageIndex = 0) {
    const p = Math.max(0, Math.min(s.pages.length - 1, Number(pageIndex) || 0));
    const embed = new EmbedBuilder().setTitle(`\uD83D\uDCDC ${s.label}`).setDescription(s.pages[p])
        .addFields({ name: '\uD83C\uDFB5 Traccia', value: String(s.title).slice(0, 1024) })
        .setFooter({ text: `Pagina ${p + 1}/${s.pages.length} \u2022 valida 15 minuti` }).setColor('#ff0000');

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`transcript_page:${s.id}:${Math.max(0, p - 1)}`)
            .setLabel('\u25C0 Precedente').setStyle(ButtonStyle.Secondary).setDisabled(p === 0),
        new ButtonBuilder().setCustomId(`transcript_page:${s.id}:${Math.min(s.pages.length - 1, p + 1)}`)
            .setLabel('Successiva \u25B6').setStyle(ButtonStyle.Secondary).setDisabled(p === s.pages.length - 1)
    );
    return { embeds: [embed], components: s.pages.length > 1 ? [row] : [] };
}

async function handleButton(interaction, state) {
    if (!interaction?.isButton?.()) return false;

    if (interaction.customId.startsWith('transcript_page:')) {
        const [, id, page] = interaction.customId.split(':');
        const s = sessions.get(id);
        if (!s || s.expiresAt < Date.now()) {
            sessions.delete(id);
            await interaction.update({ content: '\u231B Sessione scaduta. Premi di nuovo \uD83D\uDCDC Trascrizione.', embeds: [], components: [] });
            return true;
        }
        if (s.userId !== interaction.user.id) {
            await interaction.reply({ content: '\u274C Questa trascrizione appartiene a un altro utente.', flags: MessageFlags.Ephemeral });
            return true;
        }
        await interaction.update(sessionMessage(s, page));
        return true;
    }

    if (interaction.customId !== 'transcript_btn') return false;
    if (!state?.current) {
        await interaction.reply({ content: '\u274C Questo pannello non controlla pi\u00F9 alcun brano.', flags: MessageFlags.Ephemeral });
        return true;
    }
    if (state.current.timedTextStatus === 'loading') {
        await interaction.reply({ content: '\u23F3 Sto ancora recuperando testo/trascrizione. Riprova tra qualche secondo.', flags: MessageFlags.Ephemeral });
        return true;
    }

    const list = pages(state.current.timedText?.fullText);
    if (!list.length) {
        await interaction.reply({ content: '\u274C Trascrizione/testo non disponibile.', flags: MessageFlags.Ephemeral });
        return true;
    }

    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const s = {
        id, userId: interaction.user.id, title: state.current.title || 'Trascrizione',
        label: state.current.timedText?.sourceLabel || 'Trascrizione',
        pages: list, expiresAt: Date.now() + 900000
    };
    sessions.set(id, s);
    const timer = setTimeout(() => sessions.delete(id), 900000);
    timer.unref?.();

    await interaction.reply({ ...sessionMessage(s, 0), flags: MessageFlags.Ephemeral });
    return true;
}

module.exports = { rememberMetadata, mergeMetadata, decorateDescription, start, stop, handleButton };
