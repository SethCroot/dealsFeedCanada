// Self-hosted runner — replaces Firebase Cloud Function scheduling.
// Modes:
//   node runner.js --baseline   prime state from all feeds, post nothing but an online summary
//   node runner.js --once --all run every feed once (manual/testing)
//   node runner.js --once       run staggered feeds for the current minute
//   node runner.js              loop mode: 60s ticks, upstream cadence (RFD %5, reddit %6, epic %30)
const ENV = require('./env');
const state = require('./state');
const poster = require('./poster');

process.env.RFD_API_URL = ENV.RFD_API_URL;
process.env.SUBREDDIT_RSS_URL = ENV.SUBREDDIT_RSS_URL;

const redflagdeals = require('../functions/scheduled/parseThemDeals/feeds/redflagdeals.js');
const reddit = require('../functions/scheduled/parseThemDeals/feeds/reddit.js');

const BASELINE = process.argv.includes('--baseline');
const ONCE = process.argv.includes('--once') || BASELINE;
const FORCE_ALL = process.argv.includes('--all') || BASELINE;

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
        : minute % 6 === 1 ? reddit.IDs.BAPCSALESCANADA
        : minute % 6 === 3 ? reddit.IDs.VIDEOGAMEDEALSCANADA
        : minute % 6 === 5 ? reddit.IDs.GAMEDEALS : null;
    const doEpic = FORCE_ALL || minute % 30 === 0;

    const parsed = [];
    if (doRfd) parsed.push(...(await redflagdeals.parse()));
    if (redditSlot) {
        const subs = redditSlot === 'all'
            ? [reddit.IDs.BAPCSALESCANADA, reddit.IDs.VIDEOGAMEDEALSCANADA, reddit.IDs.GAMEDEALS]
            : [redditSlot];
        for (const sub of subs) {
            parsed.push(...(await reddit.parseSubredditRss(sub)));
            await poster.sleep(2000); // reddit rate-limits aggressively
        }
    }

    // classify
    const newDeals = [];
    const newlyHot = [];
    for (const deal of parsed) {
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

    let posted = 0, errors = 0;
    if (!BASELINE) {
        for (const deal of newDeals) {
            try {
                const msgId = await poster.postDeal(deal);
                s.deals[deal.id].discord_message_id = msgId;
                posted++;
                await poster.sleep(400);
            } catch (e) {
                errors++;
                console.error(`[post] ${deal.id}: ${e.message}`);
            }
        }
        for (const deal of newlyHot) {
            try {
                const msgId = await poster.postDeal({ ...deal, is_hot: true });
                if (s.deals[deal.id]) s.deals[deal.id].discord_message_id = msgId;
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

    const summary = `[tick ${new Date().toISOString()}] parsed=${parsed.length} new=${newDeals.length} hot=${newlyHot.length} free_new=${newFree.length} posted=${posted} errors=${errors} state_deals=${Object.keys(s.deals).length}`;
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
