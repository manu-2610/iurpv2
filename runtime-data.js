const fs = require('fs');
const path = require('path');

const APP_DIR = __dirname;

function resolveDataDir() {
    const railwayMount =
        String(
            process.env.RAILWAY_VOLUME_MOUNT_PATH || ''
        ).trim();

    return railwayMount
        ? path.resolve(railwayMount)
        : APP_DIR;
}

const DATA_DIR =
    resolveDataDir();

const USING_PERSISTENT_VOLUME =
    path.resolve(DATA_DIR) !==
    path.resolve(APP_DIR);

const DATA_FILES = [
    'media-stats.json',
    'media-titles.json',
    'media-library-state.json',
    'media-audit.json',
    'media-title-failures.json'
];

const DATA_DIRECTORIES = [
    'media-backups'
];

let initialized = false;

function ensureDirectory(directory) {
    fs.mkdirSync(
        directory,
        {
            recursive: true
        }
    );
}

function migrateFile(name) {
    if (!USING_PERSISTENT_VOLUME) {
        return;
    }

    const source =
        path.join(
            APP_DIR,
            name
        );

    const destination =
        path.join(
            DATA_DIR,
            name
        );

    if (
        fs.existsSync(destination) ||
        !fs.existsSync(source)
    ) {
        return;
    }

    ensureDirectory(
        path.dirname(
            destination
        )
    );

    fs.copyFileSync(
        source,
        destination
    );

    console.log(
        `[DATA] Migrato ${name} -> ${destination}`
    );
}

function migrateDirectory(name) {
    if (!USING_PERSISTENT_VOLUME) {
        return;
    }

    const source =
        path.join(
            APP_DIR,
            name
        );

    const destination =
        path.join(
            DATA_DIR,
            name
        );

    if (!fs.existsSync(source)) {
        ensureDirectory(
            destination
        );
        return;
    }

    if (!fs.existsSync(destination)) {
        fs.cpSync(
            source,
            destination,
            {
                recursive: true
            }
        );

        console.log(
            `[DATA] Migrata directory ${name} -> ${destination}`
        );

        return;
    }

    // Se il volume esiste gia', aggiungiamo solo eventuali
    // file di backup mancanti senza sovrascrivere quelli persistenti.
    fs.cpSync(
        source,
        destination,
        {
            recursive: true,
            force: false,
            errorOnExist: false
        }
    );
}

function initializePersistentData() {
    if (initialized) {
        return;
    }

    initialized = true;

    ensureDirectory(
        DATA_DIR
    );

    for (const name of DATA_FILES) {
        migrateFile(
            name
        );
    }

    for (const name of DATA_DIRECTORIES) {
        migrateDirectory(
            name
        );
    }

    if (USING_PERSISTENT_VOLUME) {
        console.log(
            `[DATA] Storage persistente attivo: ${DATA_DIR}`
        );
    } else {
        console.log(
            '[DATA] Modalita locale: JSON nella cartella del bot.'
        );
    }
}

function getDataDir() {
    initializePersistentData();
    return DATA_DIR;
}

function getDataPath(name) {
    initializePersistentData();

    return path.join(
        DATA_DIR,
        name
    );
}

initializePersistentData();

module.exports = {
    APP_DIR,
    DATA_DIR,
    USING_PERSISTENT_VOLUME,
    getDataDir,
    getDataPath,
    initializePersistentData
};
