// Discord REST posting. Key lesson (verified 2026-11-25): the User-Agent MUST be
// a DiscordBot-style UA — a browser UA gets 403 code 40333 on guild endpoints,
// while no/empty UA gets Cloudflare 403 code 1010. Correct: 'DiscordBot (url, 1.0)'.
const ENV = require('./env');
const fs = require('fs');
const UA = 'DiscordBot (https://github.com/SethCroot/dealsFeedCanada, 1.0)';

// Personal relevance filter (selfhost/filters.json) — matching deals @mention Seth.
function loadFilters() {
    try {
        const f = JSON.parse(fs.readFileSync(__dirname + '/filters.json', 'utf8'));
        if (!f.enabled) return null;
        const entries = [];
        for (const [category, words] of Object.entries(f.keywords || {})) {
            for (const w of words) entries.push([w.toLowerCase(), category]);
        }
        return entries;
    } catch (e) { return null; }
}

function matchPersonal(deal) {
    const filters = loadFilters();
    if (!filters) return [];
    const t = (deal.title || '').toLowerCase();
    const hits = [];
    for (const [word, category] of filters) {
        if (t.includes(word) && !hits.includes(category)) hits.push(category);
    }
    return hits;
}

// Price-error / discount-cliff detection — our addition on top of upstream.
// Title patterns: explicit error mentions, or "(reg. $X)" cliff markers.
const PRICE_ERROR_RE = /price\s?err(o)?r|pricing\s?err(o)?r|\bglitch(ed)?\b|scan\s?error|misprice/i;
const CLIFF_RE = /\(\s*(?:reg|was|list)\.?\s*\$\d+(?:\.\d+)?\s*\)|(?:\d{1,3})%\s*off\s*(?:reg|orig|list)/i;

function priceErrorMatch(deal) {
    const t = deal.title || '';
    return PRICE_ERROR_RE.test(t) || CLIFF_RE.test(t);
}

async function postMessage(payload) {
    const res = await fetch(`https://discord.com/api/v10/channels/${ENV.DEALS_CHANNEL_ID}/messages`, {
        method: 'POST',
        headers: {
            'Authorization': `Bot ${ENV.DISCORD_BOT_TOKEN}`,
            'User-Agent': UA,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Discord POST ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json()).id;
}

function dealEmbed(deal) {
    const isErr = priceErrorMatch(deal);
    const embed = {
        title: (deal.title || 'deal').slice(0, 256),
        url: deal.url || deal.link || undefined,
        color: isErr ? 0xff4444 : (deal.is_hot ? 0xffa500 : 0x5865f2),
        fields: [],
    };
    if (deal.score != null) embed.fields.push({ name: 'score', value: String(deal.score), inline: true });
    if (deal.dealer) embed.fields.push({ name: 'dealer', value: String(deal.dealer).slice(0, 60), inline: true });
    if (deal.num_comments != null) embed.fields.push({ name: 'comments', value: String(deal.num_comments), inline: true });
    if (deal.tag) embed.fields.push({ name: 'tag', value: String(deal.tag).slice(0, 60), inline: true });
    if (deal.expiry) embed.description = `**Expires:** ${deal.expiry}`;
    embed.footer = { text: isErr ? '⚠ price-error pattern' : (deal.source || 'deal') };
    if (deal.created) embed.timestamp = new Date(deal.created).toISOString();
    return embed;
}

async function postDeal(deal) {
    const payload = { embeds: [dealEmbed(deal)] };
    if (priceErrorMatch(deal)) {
        payload.content = `<@${ENV.SETH_USER_ID}> 🚨 possible price error / deep cliff — check fast, may get cancelled`;
    } else {
        const cats = matchPersonal(deal);
        if (cats.length > 0) {
            payload.content = `<@${ENV.SETH_USER_ID}> 🎯 matches your filter: ${cats.join(', ')}`;
        }
    }
    return postMessage(payload);
}

async function postFreeDeal(fd) {
    const embed = {
        title: `FREE — ${(fd.title || 'freebie').slice(0, 250)}`,
        url: fd.link || undefined,
        color: 0x2ecc71,
        footer: { text: `free · ${fd.source || 'freebie'}` },
    };
    if (fd.expiry_date) {
        const d = new Date(fd.expiry_date);
        embed.description = `Free until **${d.toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' })}** ${d.toLocaleTimeString('en-CA', { timeZone: 'America/Vancouver', hour: '2-digit', minute: '2-digit' })}`;
    }
    return postMessage({ embeds: [embed] });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { postDeal, postFreeDeal, postMessage, priceErrorMatch, sleep };
