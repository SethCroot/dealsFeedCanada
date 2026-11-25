// Reddit via CDP-HTML harvest in the browserbox Chrome (Seth's explicit sign-off 2026-11-25).
// Why: Reddit killed all RSS on 2026-11-13 and locked new OAuth app creation; the real
// Chrome passes Reddit's js_challenge automatically, so we harvest the HTML listing.
// Discipline: only create/close OUR OWN tabs, never touch existing ones (Seth's downloads).
const CDP_HTTP = 'http://localhost:9222';

const HOT_RULES = {
    bapcsalescanada: 20,
    videogamedealscanada: 20,
    gamedeals: 100,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpOpen(url) {
    const res = await fetch(`${CDP_HTTP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    if (!res.ok) throw new Error(`cdp open failed: ${res.status}`);
    const tab = await res.json();
    return tab;
}

async function cdpClose(tabId) {
    try {
        await fetch(`${CDP_HTTP}/json/close/${tabId}`);
    } catch { /* closing is best-effort */ }
}

async function cdpEval(wsUrl, expression, timeoutMs = 10000) {
    // Node 22 global WebSocket
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const fail = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('cdp eval timeout')); }, timeoutMs);
        ws.onerror = (e) => { clearTimeout(fail); console.error('[cdp-eval] ws error:', (e && (e.message || e.type)) || e); reject(new Error('cdp ws error')); };
        ws.onopen = () => {
            ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
        };
        ws.onmessage = (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id === 1) {
                clearTimeout(fail);
                try { ws.close(); } catch {}
                if (msg.result && msg.result.exceptionDetails) {
                    console.error('[cdp-eval] page exception:', JSON.stringify(msg.result.exceptionDetails).slice(0, 200));
                }
                resolve(msg.result?.result?.value);
            }
        };
    });
}

const HARVEST_EXPR = `(() => {
    const posts = Array.from(document.querySelectorAll('shreddit-post'));
    return JSON.stringify(posts.map(p => ({
        id: (p.getAttribute('id') || '').replace('t3_', ''),
        title: (p.getAttribute('post-title') || (p.querySelector('a[slot="title"]') || {}).textContent || '').trim(),
        score: parseInt(p.getAttribute('score') || '0', 10) || 0,
        num_comments: parseInt(p.getAttribute('comment-count') || '0', 10) || 0,
        permalink: p.getAttribute('permalink') || null,
    })).filter(d => d.id && d.title).slice(0, 30));
})()`;

/**
 * Harvest a subreddit's /new listing as deals.
 * @param {string} subredditName
 * @return {Promise<Array>} deals in upstream shape ({id, source, title, score, num_comments, is_hot, tag, created})
 */
async function harvestSubreddit(subredditName) {
    const url = `https://www.reddit.com/r/${subredditName}/new/`;
    let tab;
    try {
        tab = await cdpOpen(url);
        const wsUrl = tab.webSocketDebuggerUrl;
        if (!wsUrl) throw new Error('no ws url for tab');

        // Poll until shreddit-post elements render (js_challenge + SPA progressive load)
        let raw = null;
        for (let i = 0; i < 10; i++) {
            await sleep(2000);
            raw = await cdpEval(wsUrl, HARVEST_EXPR, 8000).catch(() => null);
            if (raw) {
                let count = 0;
                try { count = JSON.parse(raw).length; } catch {}
                // SPA renders progressively (3 -> 27 posts); wait for a full page
                if (count >= 10) break;
                if (i >= 3 && count > 0) break; // stale-tab fallback: accept partial after ~8s
            }
        }
        const parsed = raw ? JSON.parse(raw) : [];
        const threshold = HOT_RULES[subredditName];
        return parsed.map((p) => ({
            id: p.id,
            source: subredditName,
            title: p.title,
            score: p.score,
            num_comments: p.num_comments,
            url: p.permalink ? `https://www.reddit.com${p.permalink}` : undefined,
            is_hot: threshold ? p.score >= threshold : false,
            tag: null,
            created: new Date().toISOString(),
        }));
    } catch (e) {
        console.error(`[reddit-cdp] ${subredditName} harvest failed: ${e.message}`);
        return [];
    } finally {
        if (tab) await cdpClose(tab.id);
    }
}

module.exports = { harvestSubreddit };
