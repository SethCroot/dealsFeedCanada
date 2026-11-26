// Self-hosted runner — replaces Firebase Cloud Function scheduling.
// Modes:
//   node runner.js --baseline   prime state from all feeds, post nothing but an online summary
//   node runner.js --once --all run every feed once (manual/testing)
//   node runner.js --once       run staggered feeds for the current minute
//   node runner.js              loop mode: 60s ticks, upstream cadence (RFD %5, reddit %6, epic %30)
const ENV = require('./env');
const state = require('./state');
const poster = require('./poster');
const redditCdp = require('./reddit_cdp');

process.env.RFD_API_URL = ENV.RFD_API_URL;

const redflagdeals = require('../functions/scheduled/parseThemDeals/feeds/redflagdeals.js');

const REDDIT_SUBS = ['bapcsalescanada', 'videogamedealscanada', 'gamedeals'];

const BASELINE = process.argv.includes('--baseline');
const ONCE = process.argv.includes('--once') || BASELINE;
const FORCE_ALL = process.argv.includes('--all') || BASELINE;

// Free-games feed OFF (Seth, 2026-11-25: "I don't need games — we have our own way
// of getting games"). Epic parser + free-game posting kept in code for upstream
// parity; flip to true to re-enable.
const FREE_GAMES = false;

// ---------------- Epic free games (ported from parseFreeDeals/feeds/epic.js) ----------------
async function parseEpicFree(freeDeals) {
    let count = 0;
    try {
        const res = await fetch(ENV.EPIC_SEARCH_URL, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        for (const game of json.data.Catalog.searchStore.elements) {
            const free = game.price?.totalPrice?.discountPrice === 0
                && game.promotions?.promotionalOffers?.length > 0;
            if (!free) continue;
            let id;
            if (game.offerMappings?.length > 0) id = game.offerMappings[0].pageSlug;
            else if (game.catalogNs?.mappings?.length > 0) id = game.catalogNs.mappings[0].pageSlug;
            else id = game.productSlug;
            freeDeals.push({
                id: 'Epic-' + id,
                source: 'Epic',
                date: new Date().toISOString(),
                title: game.title,
                type: game.offerType,
                link: `https://store.epicgames.com/en-US/p/${id}`,
                expiry_date: game.promotions?.promotionalOffers?.[0]?.promotionalOffers?.[0]?.endDate,
            });
            count++;
        }
    } catch (e) {
        console.error('[epic] parse failed:', e.message);
    }
    return count;
}

// ---------------- main tick ----------------
async function tick() {
    const s = state.load();
    const minute = new Date().getMinutes();
    const doRfd = FORCE_ALL || minute % 5 === 0;
    const redditSlot = FORCE_ALL ? 'all'
        : minute % 6 === 1 ? 'bapcsalescanada'
        : minute % 6 === 3 ? 'videogamedealscanada'
        : minute % 6 === 5 ? 'gamedeals' : null;
    const doEpic = FREE_GAMES && (FORCE_ALL || minute % 30 === 0);

    const parsed = [];
    if (doRfd) parsed.push(...(await redflagdeals.parse()));
    if (redditSlot) {
        const subs = redditSlot === 'all' ? REDDIT_SUBS : [redditSlot];
        for (const sub of subs) {
            parsed.push(...(await redditCdp.harvestSubreddit(sub)));
            await poster.sleep(2000); // tabs are heavier than HTTP; pace them
        }
    }

    // classify
    const newDeals = [];
    const newlyHot = [];
    for (const deal of parsed) {
        // RFD post_time can produce an Invalid Date; an invalid/missing created
        // made the 30-day prune delete the entry right after save, so the deal
        // came back "new" every tick and re-pinged forever (Eneba Game Pass,
        // 2026-11-26: posted 5x in 25 min). Sanitize at insert.
        if (!deal.created || Number.isNaN(new Date(deal.created).getTime())) {
            deal.created = new Date().toISOString();
        }
        const existing = s.deals[deal.id];
        if (!existing) {
            newDeals.push(deal);
            s.deals[deal.id] = { ...deal, discord_message_id: 'pending' };
        } else {
            if (deal.is_hot && !existing.is_hot) {
                newlyHot.push({ ...deal, is_hot: true });
                Object.assign(s.deals[deal.id], deal);
            } else {
                Object.assign(s.deals[deal.id], deal); // silent score/expiry refresh
            }
        }
    }

    // Seth's rule (2026-11-25): #deals is signal-only. A deal posts ONLY if it is a
    // price-error or matches the personal filter; everything else is recorded in
    // state (dedupe intact) but never posted.
    // Title-level dedupe (2026-11-26): the SAME deal can carry different feed IDs —
    // RFD re-lists, RFD + Reddit cross-posts, or a pruned state record (bad created
    // date loop). Normalize the title and never ping the same title twice in 7 days.
    s.posted_titles = s.posted_titles || {};
    const nowMs = Date.now();
    for (const k of Object.keys(s.posted_titles)) {
        if (nowMs - s.posted_titles[k] > 7 * 24 * 3600 * 1000) delete s.posted_titles[k];
    }
    function titleKey(t) {
        return String(t || '')
            .toLowerCase()
            .replace(/\[[^\]]*\]/g, ' ')      // drop [Retailer] prefixes
            .replace(/[^a-z0-9]+/g, ' ')
            .trim()
            .replace(/\s+/g, ' ');
    }
    function posts(deal) {
        if (s.posted_titles[titleKey(deal.title)]) return false; // already pinged this title
        if (poster.overBudget(deal.title)) return false; // over Seth's pay-price ceiling — tracked, never pinged
        return poster.priceErrorMatch(deal) || poster.matchPersonal(deal).length > 0;
    }
    function markPosted(deal) {
        s.posted_titles[titleKey(deal.title)] = Date.now();
    }
    for (const deal of newDeals) {
        if (!posts(deal) && s.deals[deal.id]) s.deals[deal.id].discord_message_id = 'skipped';
    }

    // free games
    const freeParsed = [];
    if (doEpic) await parseEpicFree(freeParsed);
    const newFree = [];
    for (const fd of freeParsed) {
        if (!s.freeDeals[fd.id]) {
            newFree.push(fd);
            s.freeDeals[fd.id] = { ...fd, discord_message_id: 'pending' };
        }
    }

    let posted = 0, errors = 0, skipped = 0;
    if (!BASELINE) {
        for (const deal of newDeals) {
            if (!posts(deal)) { skipped++; continue; }
            try {
                const msgId = await poster.postDeal(deal);
                s.deals[deal.id].discord_message_id = msgId;
                markPosted(deal);
                posted++;
                await poster.sleep(400);
            } catch (e) {
                errors++;
                console.error(`[post] ${deal.id}: ${e.message}`);
            }
        }
        for (const deal of newlyHot) {
            // Seth (2026-11-25): "you keep pinging the same thing." A score
            // increase is NOT new signal — a filter-matched deal already pinged
            // when it was new, and signal-only means we don't re-post it when
            // it crosses the hot threshold. Re-post ONLY if the original post
            // never landed (still 'pending' after a Discord error).
            const prior = s.deals[deal.id] ? s.deals[deal.id].discord_message_id : null;
            const neverLanded = prior === 'pending' || prior == null;
            if (!neverLanded || !posts(deal)) { skipped++; continue; }
            try {
                const msgId = await poster.postDeal({ ...deal, is_hot: true });
                if (s.deals[deal.id]) s.deals[deal.id].discord_message_id = msgId;
                markPosted(deal);
                posted++;
                await poster.sleep(400);
            } catch (e) {
                errors++;
                console.error(`[post-hot] ${deal.id}: ${e.message}`);
            }
        }
        for (const fd of newFree) {
            try {
                const msgId = await poster.postFreeDeal(fd);
                s.freeDeals[fd.id].discord_message_id = msgId;
                posted++;
                await poster.sleep(400);
            } catch (e) {
                errors++;
                console.error(`[post-free] ${fd.id}: ${e.message}`);
            }
        }
    } else {
        // baseline: everything currently in the feeds is marked seen
        for (const deal of newDeals) s.deals[deal.id].discord_message_id = 'baseline';
        for (const fd of newFree) s.freeDeals[fd.id].discord_message_id = 'baseline';
    }

    s.runs = (s.runs || 0) + 1;
    s.last_run = new Date().toISOString();
    state.save(s);

    const summary = `[tick ${new Date().toISOString()}] parsed=${parsed.length} new=${newDeals.length} hot=${newlyHot.length} free_new=${newFree.length} posted=${posted} skipped=${skipped} errors=${errors} state_deals=${Object.keys(s.deals).length}`;
    console.log(summary);

    if (BASELINE) {
        await poster.postMessage({
            content: `✅ **deals bot online** (self-hosted, AG2). Baseline primed: ${Object.keys(s.deals).length} deals + ${Object.keys(s.freeDeals).length} freebies marked seen. New deals post here as they appear. Price-error patterns ping you directly.`,
        });
    }
    return { newDeals: newDeals.length, posted, errors };
}

async function main() {
    if (ONCE) {
        await tick();
        return;
    }
    console.log('[runner] loop mode — 60s ticks');
    // eslint-disable-next-line no-constant-condition
    while (true) {
        try { await tick(); } catch (e) { console.error('[tick] fatal:', e); }
        await poster.sleep(60000);
    }
}

main().catch((e) => { console.error('runner failed:', e); process.exit(1); });
