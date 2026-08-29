const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const STATE_PATH = path.join(ROOT, 'media-library-state.json');
const AUDIT_PATH = path.join(ROOT, 'media-audit.json');
const STATS_PATH = path.join(ROOT, 'media-stats.json');
const TITLES_PATH = path.join(ROOT, 'media-titles.json');
const BACKUP_DIR = path.join(ROOT, 'media-backups');

const PROTECTED_CATEGORY_IDS = new Set(['popular', 'all']);

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function defaultState() {
    return {
        version: 1,
        customVideos: [],
        videoOverrides: {},
        hiddenVideoIds: [],
        customCategories: {},
        categoryOverrides: {},
        hiddenCategoryIds: [],
        categoryOrder: []
    };
}

function ensureJsonFile(filePath, fallback) {
    if (!fs.existsSync(filePath)) {
        atomicWriteJson(filePath, fallback);
    }
}

function readJson(filePath, fallback) {
    ensureJsonFile(filePath, fallback);
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return parsed ?? clone(fallback);
    } catch (err) {
        console.warn(`[LIBRARY] File JSON non leggibile (${path.basename(filePath)}):`, err.message);
        return clone(fallback);
    }
}

function atomicWriteJson(filePath, value) {
    const directory = path.dirname(filePath);
    fs.mkdirSync(directory, { recursive: true });
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, filePath);
}

function normalizeState(raw) {
    const base = defaultState();
    const state = raw && typeof raw === 'object' ? raw : {};
    return {
        version: 1,
        customVideos: Array.isArray(state.customVideos) ? state.customVideos.filter(Boolean) : base.customVideos,
        videoOverrides: state.videoOverrides && typeof state.videoOverrides === 'object' ? state.videoOverrides : {},
        hiddenVideoIds: Array.isArray(state.hiddenVideoIds) ? [...new Set(state.hiddenVideoIds.map(String))] : [],
        customCategories: state.customCategories && typeof state.customCategories === 'object' ? state.customCategories : {},
        categoryOverrides: state.categoryOverrides && typeof state.categoryOverrides === 'object' ? state.categoryOverrides : {},
        hiddenCategoryIds: Array.isArray(state.hiddenCategoryIds) ? [...new Set(state.hiddenCategoryIds.map(String))] : [],
        categoryOrder: Array.isArray(state.categoryOrder) ? [...new Set(state.categoryOrder.map(String).filter(Boolean))] : []
    };
}

function loadState() {
    return normalizeState(readJson(STATE_PATH, defaultState()));
}

function saveState(state) {
    atomicWriteJson(STATE_PATH, normalizeState(state));
}

function loadAudit() {
    const value = readJson(AUDIT_PATH, []);
    return Array.isArray(value) ? value : [];
}

function appendAudit(entry) {
    const audit = loadAudit();
    audit.unshift({
        at: new Date().toISOString(),
        ...entry
    });
    atomicWriteJson(AUDIT_PATH, audit.slice(0, 500));
}

function sanitizeBackupReason(value) {
    return String(value || 'change')
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'change';
}

function makeBackup(reason = 'change') {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const prefix = `${stamp}_${sanitizeBackupReason(reason)}`;
    const paths = [STATE_PATH, STATS_PATH, TITLES_PATH, AUDIT_PATH];

    for (const filePath of paths) {
        if (!fs.existsSync(filePath)) continue;
        const destination = path.join(BACKUP_DIR, `${prefix}_${path.basename(filePath)}`);
        fs.copyFileSync(filePath, destination);
    }
}

function actorInfo(actor) {
    if (!actor) return { actorId: null, actorTag: 'unknown' };
    const actorId = actor.id || actor.user?.id || null;
    const actorTag = actor.tag || actor.username || actor.user?.tag || actor.user?.username || String(actorId || 'unknown');
    return { actorId, actorTag };
}

function mutation(reason, actor, action, details, mutator) {
    makeBackup(reason);
    const state = loadState();
    const result = mutator(state);
    saveState(state);
    appendAudit({ action, ...actorInfo(actor), details: details || {} });
    return result;
}

function slugify(value) {
    const slug = String(value || '')
        .toLocaleLowerCase('it')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
    return slug || 'video';
}

function uniqueId(baseValue, usedIds) {
    const base = slugify(baseValue);
    let candidate = base;
    let index = 2;
    while (usedIds.has(candidate)) {
        candidate = `${base}-${index++}`;
    }
    return candidate;
}

function extractYoutubeVideoId(rawUrl) {
    try {
        const url = new URL(String(rawUrl || '').trim());
        const host = url.hostname.replace(/^www\./, '').toLowerCase();
        if (host === 'youtu.be') {
            return url.pathname.split('/').filter(Boolean)[0] || null;
        }
        if (host.endsWith('youtube.com')) {
            if (url.pathname === '/watch') return url.searchParams.get('v');
            const parts = url.pathname.split('/').filter(Boolean);
            if (['shorts', 'embed', 'live'].includes(parts[0])) return parts[1] || null;
        }
    } catch {}
    return null;
}

function normalizeUrl(rawUrl) {
    const videoId = extractYoutubeVideoId(rawUrl);
    if (videoId) return `youtube:${videoId}`;
    try {
        const url = new URL(String(rawUrl || '').trim());
        url.hash = '';
        return url.toString();
    } catch {
        return String(rawUrl || '').trim();
    }
}

function getEffectiveCategories(baseMeta) {
    const state = loadState();
    const unordered = {};

    for (const [id, meta] of Object.entries(baseMeta || {})) {
        if (state.hiddenCategoryIds.includes(id) && !PROTECTED_CATEGORY_IDS.has(id)) continue;
        unordered[id] = {
            ...clone(meta),
            ...(state.categoryOverrides[id] || {})
        };
    }

    for (const [id, meta] of Object.entries(state.customCategories)) {
        if (state.hiddenCategoryIds.includes(id)) continue;
        unordered[id] = clone(meta);
    }

    for (const protectedId of PROTECTED_CATEGORY_IDS) {
        if (baseMeta?.[protectedId]) {
            unordered[protectedId] = {
                ...clone(baseMeta[protectedId]),
                ...(state.categoryOverrides[protectedId] || {})
            };
        }
    }

    // L'ordine personalizzato e persistente. Gli ID non ancora presenti
    // nell'ordine (ad esempio dopo un aggiornamento del catalogo) vengono
    // aggiunti in coda mantenendo il loro ordine naturale.
    const naturalOrder = Object.keys(unordered);
    const orderedIds = [
        ...state.categoryOrder.filter(id => Object.prototype.hasOwnProperty.call(unordered, id)),
        ...naturalOrder.filter(id => !state.categoryOrder.includes(id))
    ];

    const result = {};
    for (const id of orderedIds) {
        result[id] = unordered[id];
    }

    return result;
}

function mergeVideo(item, override) {
    const merged = {
        ...clone(item),
        ...(override || {})
    };
    merged.aliases = Array.isArray(merged.aliases) ? [...new Set(merged.aliases.map(String).filter(Boolean))] : [];
    merged.categories = Array.isArray(merged.categories) ? [...new Set(merged.categories.map(String).filter(Boolean))] : [];
    merged.start = Number.isFinite(Number(merged.start)) && Number(merged.start) >= 0 ? Number(merged.start) : 0;
    return merged;
}

function getEffectiveCatalog(baseCatalog) {
    const state = loadState();
    const hidden = new Set(state.hiddenVideoIds);
    const result = [];
    const used = new Set();

    for (const baseItem of baseCatalog || []) {
        if (!baseItem?.id || hidden.has(baseItem.id) || used.has(baseItem.id)) continue;
        result.push(mergeVideo(baseItem, state.videoOverrides[baseItem.id]));
        used.add(baseItem.id);
    }

    for (const customItem of state.customVideos) {
        if (!customItem?.id || hidden.has(customItem.id) || used.has(customItem.id)) continue;
        result.push(mergeVideo(customItem, state.videoOverrides[customItem.id]));
        used.add(customItem.id);
    }

    return result;
}

function getAllVideoRecords(baseCatalog) {
    const state = loadState();
    const hidden = new Set(state.hiddenVideoIds);
    const records = [];
    const customIds = new Set(state.customVideos.map(item => item?.id).filter(Boolean));

    for (const item of [...(baseCatalog || []), ...state.customVideos]) {
        if (!item?.id) continue;
        const source = customIds.has(item.id) ? 'custom' : 'storico';
        records.push({
            ...mergeVideo(item, state.videoOverrides[item.id]),
            hidden: hidden.has(item.id),
            source
        });
    }

    const seen = new Set();
    return records.filter(record => {
        if (seen.has(record.id)) return false;
        seen.add(record.id);
        return true;
    });
}

function getVideoRecord(id, baseCatalog, { includeHidden = false } = {}) {
    const record = getAllVideoRecords(baseCatalog).find(item => item.id === id) || null;
    if (!record || (!includeHidden && record.hidden)) return null;
    return record;
}

function getHiddenVideos(baseCatalog) {
    return getAllVideoRecords(baseCatalog).filter(item => item.hidden);
}

function findDuplicateUrl(url, baseCatalog, ignoreId = null) {
    const normalized = normalizeUrl(url);
    return getAllVideoRecords(baseCatalog).find(item => item.id !== ignoreId && normalizeUrl(item.url) === normalized) || null;
}

function findAliasOwner(alias, baseCatalog, ignoreId = null) {
    const target = String(alias || '').trim().toLowerCase();
    if (!target) return null;
    return getAllVideoRecords(baseCatalog).find(item =>
        item.id !== ignoreId &&
        (item.aliases || []).some(value => String(value).toLowerCase() === target)
    ) || null;
}

function addVideo(item, baseCatalog, actor) {
    const used = new Set(getAllVideoRecords(baseCatalog).map(video => video.id));
    const id = item.id && !used.has(item.id) ? item.id : uniqueId(item.id || item.title || 'video', used);
    const finalItem = mergeVideo({ ...item, id, custom: true }, null);

    return mutation('add-video', actor, 'ADD_VIDEO', { id, title: finalItem.title }, state => {
        state.customVideos.push(finalItem);
        state.hiddenVideoIds = state.hiddenVideoIds.filter(value => value !== id);
        return clone(finalItem);
    });
}

function updateVideo(id, patch, baseCatalog, actor) {
    const current = getVideoRecord(id, baseCatalog, { includeHidden: true });
    if (!current) throw new Error('Video non trovato.');

    return mutation('update-video', actor, 'UPDATE_VIDEO', { id, patch }, state => {
        const customIndex = state.customVideos.findIndex(item => item.id === id);
        if (customIndex >= 0) {
            state.customVideos[customIndex] = mergeVideo(state.customVideos[customIndex], patch);
        } else {
            state.videoOverrides[id] = {
                ...(state.videoOverrides[id] || {}),
                ...clone(patch)
            };
        }
        return true;
    });
}

function hideVideo(id, baseCatalog, actor) {
    const current = getVideoRecord(id, baseCatalog, { includeHidden: false });
    if (!current) throw new Error('Video non trovato o gia rimosso.');
    return mutation('remove-video', actor, 'REMOVE_VIDEO', { id, title: current.title }, state => {
        if (!state.hiddenVideoIds.includes(id)) state.hiddenVideoIds.push(id);
        return true;
    });
}

function restoreVideo(id, baseCatalog, actor) {
    const current = getVideoRecord(id, baseCatalog, { includeHidden: true });
    if (!current) throw new Error('Video non trovato.');
    return mutation('restore-video', actor, 'RESTORE_VIDEO', { id, title: current.title }, state => {
        state.hiddenVideoIds = state.hiddenVideoIds.filter(value => value !== id);
        return true;
    });
}

function createCategory({ label, emoji = '📁' }, baseCategories, actor) {
    const currentCategories = getEffectiveCategories(baseCategories);
    if (Object.keys(currentCategories).length >= 25) {
        throw new Error('Limite Discord raggiunto: il menu puo contenere al massimo 25 categorie.');
    }

    const stateSnapshot = loadState();
    const used = new Set([
        ...Object.keys(baseCategories || {}),
        ...Object.keys(stateSnapshot.customCategories || {})
    ]);
    const id = uniqueId(label, used);
    const meta = { label: String(label).trim().slice(0, 80), emoji: String(emoji || '📁').trim().slice(0, 32) || '📁' };

    if (!meta.label) throw new Error('Nome categoria non valido.');
    const currentOrder = Object.keys(currentCategories);

    return mutation('add-category', actor, 'ADD_CATEGORY', { id, ...meta }, state => {
        state.customCategories[id] = meta;
        state.hiddenCategoryIds = state.hiddenCategoryIds.filter(value => value !== id);
        state.categoryOrder = [...currentOrder.filter(value => value !== id), id];
        return { id, ...clone(meta) };
    });
}

function updateCategory(id, patch, baseCategories, actor) {
    if (PROTECTED_CATEGORY_IDS.has(id)) throw new Error('Questa categoria e protetta.');
    const current = getEffectiveCategories(baseCategories)[id];
    if (!current) throw new Error('Categoria non trovata.');
    const cleanPatch = {};
    if (patch.label !== undefined) {
        cleanPatch.label = String(patch.label).trim().slice(0, 80);
        if (!cleanPatch.label) throw new Error('Nome categoria non valido.');
    }
    if (patch.emoji !== undefined) cleanPatch.emoji = String(patch.emoji || '📁').trim().slice(0, 32) || '📁';

    return mutation('update-category', actor, 'UPDATE_CATEGORY', { id, patch: cleanPatch }, state => {
        if (state.customCategories[id]) {
            state.customCategories[id] = { ...state.customCategories[id], ...cleanPatch };
        } else {
            state.categoryOverrides[id] = { ...(state.categoryOverrides[id] || {}), ...cleanPatch };
        }
        return true;
    });
}

function moveCategoryPosition(id, direction, steps, baseCategories, actor) {
    const categories = getEffectiveCategories(baseCategories);
    if (!categories[id]) throw new Error('Categoria non trovata.');

    const normalizedDirection = direction === 'down' ? 'down' : direction === 'up' ? 'up' : null;
    if (!normalizedDirection) throw new Error('Direzione categoria non valida.');

    const amount = Math.max(1, Math.min(24, Math.floor(Number(steps) || 1)));
    const currentOrder = Object.keys(categories);
    const fromIndex = currentOrder.indexOf(id);
    if (fromIndex < 0) throw new Error('Categoria non trovata nell ordine.');

    const requestedIndex = normalizedDirection === 'up'
        ? fromIndex - amount
        : fromIndex + amount;

    const toIndex = Math.max(0, Math.min(currentOrder.length - 1, requestedIndex));
    const actualSteps = Math.abs(toIndex - fromIndex);

    if (toIndex === fromIndex) {
        return {
            changed: false,
            id,
            direction: normalizedDirection,
            requestedSteps: amount,
            actualSteps: 0,
            fromIndex,
            toIndex,
            total: currentOrder.length
        };
    }

    const nextOrder = [...currentOrder];
    const [moved] = nextOrder.splice(fromIndex, 1);
    nextOrder.splice(toIndex, 0, moved);

    return mutation(
        'move-category-position',
        actor,
        'MOVE_CATEGORY_POSITION',
        {
            id,
            direction: normalizedDirection,
            requestedSteps: amount,
            actualSteps,
            fromPosition: fromIndex + 1,
            toPosition: toIndex + 1
        },
        state => {
            state.categoryOrder = nextOrder;
            return {
                changed: true,
                id,
                direction: normalizedDirection,
                requestedSteps: amount,
                actualSteps,
                fromIndex,
                toIndex,
                total: nextOrder.length
            };
        }
    );
}

function moveVideoCategory(id, fromCategory, toCategory, baseCatalog, baseCategories, actor) {
    const categories = getEffectiveCategories(baseCategories);
    if (!categories[toCategory] || PROTECTED_CATEGORY_IDS.has(toCategory)) throw new Error('Categoria di destinazione non valida.');
    const video = getVideoRecord(id, baseCatalog);
    if (!video) throw new Error('Video non trovato.');
    const currentCategories = [...video.categories];
    let origin = fromCategory || null;

    if (!origin) {
        if (currentCategories.length !== 1) {
            const error = new Error('Il video appartiene a piu categorie: specifica anche la categoria di origine.');
            error.code = 'NEED_ORIGIN';
            error.categories = currentCategories;
            throw error;
        }
        origin = currentCategories[0];
    }
    if (!currentCategories.includes(origin)) throw new Error('Il video non appartiene alla categoria di origine indicata.');

    const next = currentCategories.filter(value => value !== origin);
    if (!next.includes(toCategory)) next.push(toCategory);

    return mutation('move-video', actor, 'MOVE_VIDEO', { id, from: origin, to: toCategory }, state => {
        const customIndex = state.customVideos.findIndex(item => item.id === id);
        if (customIndex >= 0) {
            state.customVideos[customIndex] = mergeVideo(state.customVideos[customIndex], { categories: next });
        } else {
            state.videoOverrides[id] = {
                ...(state.videoOverrides[id] || {}),
                categories: next
            };
        }
        return next;
    });
}

function removeCategory(id, destination, baseCatalog, baseCategories, actor) {
    if (PROTECTED_CATEGORY_IDS.has(id)) throw new Error('Questa categoria e protetta e non puo essere rimossa.');
    const categories = getEffectiveCategories(baseCategories);
    if (!categories[id]) throw new Error('Categoria non trovata.');
    if (destination) {
        if (destination === id || !categories[destination] || PROTECTED_CATEGORY_IDS.has(destination)) {
            throw new Error('Categoria di destinazione non valida.');
        }
    }

    const affected = getEffectiveCatalog(baseCatalog).filter(video => video.categories.includes(id));
    if (affected.length && !destination) {
        const error = new Error(`La categoria contiene ${affected.length} video: specifica una destinazione.`);
        error.code = 'CATEGORY_NOT_EMPTY';
        error.count = affected.length;
        throw error;
    }

    return mutation('remove-category', actor, 'REMOVE_CATEGORY', { id, destination: destination || null, affected: affected.length }, state => {
        for (const video of affected) {
            const nextCategories = video.categories.filter(value => value !== id);
            if (destination && !nextCategories.includes(destination)) nextCategories.push(destination);

            const customIndex = state.customVideos.findIndex(item => item.id === video.id);
            if (customIndex >= 0) {
                state.customVideos[customIndex] = mergeVideo(state.customVideos[customIndex], { categories: nextCategories });
            } else {
                state.videoOverrides[video.id] = {
                    ...(state.videoOverrides[video.id] || {}),
                    categories: nextCategories
                };
            }
        }

        if (state.customCategories[id]) delete state.customCategories[id];
        else if (!state.hiddenCategoryIds.includes(id)) state.hiddenCategoryIds.push(id);
        delete state.categoryOverrides[id];
        state.categoryOrder = (state.categoryOrder.length ? state.categoryOrder : Object.keys(categories))
            .filter(value => value !== id);
        return affected.length;
    });
}

function loadStats() {
    const stats = readJson(STATS_PATH, {});
    return stats && typeof stats === 'object' && !Array.isArray(stats) ? stats : {};
}

function resetVideoClicks(id, actor) {
    makeBackup('reset-video-clicks');
    const stats = loadStats();
    const previous = Number(stats[id] || 0);
    stats[id] = 0;
    atomicWriteJson(STATS_PATH, stats);
    appendAudit({ action: 'RESET_VIDEO_CLICKS', ...actorInfo(actor), details: { id, previous } });
    return previous;
}

function resetAllClicks(actor) {
    makeBackup('reset-all-clicks');
    const previous = loadStats();
    atomicWriteJson(STATS_PATH, {});
    appendAudit({ action: 'RESET_ALL_CLICKS', ...actorInfo(actor), details: { videos: Object.keys(previous).length } });
    return previous;
}

function setTitleCache(id, title) {
    const cache = readJson(TITLES_PATH, {});
    if (title) cache[id] = String(title).trim();
    else delete cache[id];
    atomicWriteJson(TITLES_PATH, cache);
}

function getRecentAudit(limit = 15) {
    return loadAudit().slice(0, Math.max(1, Math.min(50, Number(limit) || 15)));
}

function ensureDataFiles() {
    ensureJsonFile(STATE_PATH, defaultState());
    ensureJsonFile(AUDIT_PATH, []);
    ensureJsonFile(STATS_PATH, {});
    ensureJsonFile(TITLES_PATH, {});
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

module.exports = {
    STATE_PATH,
    AUDIT_PATH,
    BACKUP_DIR,
    PROTECTED_CATEGORY_IDS,
    ensureDataFiles,
    slugify,
    uniqueId,
    extractYoutubeVideoId,
    normalizeUrl,
    getEffectiveCategories,
    getEffectiveCatalog,
    getAllVideoRecords,
    getVideoRecord,
    getHiddenVideos,
    findDuplicateUrl,
    findAliasOwner,
    addVideo,
    updateVideo,
    hideVideo,
    restoreVideo,
    createCategory,
    updateCategory,
    moveCategoryPosition,
    moveVideoCategory,
    removeCategory,
    loadStats,
    resetVideoClicks,
    resetAllClicks,
    setTitleCache,
    getRecentAudit
};
