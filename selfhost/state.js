// JSON-file state store, replacing Firestore. Atomic writes, 30-day pruning.
const fs = require('fs');
const ENV = require('./env');

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function load() {
    try {
        return JSON.parse(fs.readFileSync(ENV.STATE_PATH, 'utf8'));
    } catch (e) {
        return { deals: {}, freeDeals: {}, last_run: null, runs: 0 };
    }
}

function save(state) {
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const id of Object.keys(state.deals)) {
        const t = state.deals[id].created ? new Date(state.deals[id].created).getTime() : NaN;
        // Invalid/missing created = KEEP (2026-11-26): deleting it made RFD deals
        // with bad post_time vanish right after save and re-post on every tick.
        // runner.js sanitizes created at insert, so this only guards strays.
        if (!Number.isNaN(t) && t < cutoff) delete state.deals[id];
    }
    for (const id of Object.keys(state.freeDeals)) {
        const t = state.freeDeals[id].date ? new Date(state.freeDeals[id].date).getTime() : NaN;
        if (!Number.isNaN(t) && t < cutoff) delete state.freeDeals[id];
    }
    fs.writeFileSync(ENV.STATE_PATH + '.tmp', JSON.stringify(state));
    fs.renameSync(ENV.STATE_PATH + '.tmp', ENV.STATE_PATH);
}

module.exports = { load, save };
