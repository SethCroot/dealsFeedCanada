// Central config for the self-hosted deals runner.
// Token lives in the Hermes .env — never in this repo, never in chat.
const fs = require('fs');

function loadHermesEnv() {
    const env = {};
    try {
        for (const line of fs.readFileSync('/var/home/seth/.hermes/.env', 'utf8').split('\n')) {
            const t = line.trim();
            if (t && !t.startsWith('#') && t.includes('=')) {
                const i = t.indexOf('=');
                env[t.slice(0, i)] = t.slice(i + 1);
            }
        }
    } catch (e) { /* caller will fail loudly on missing token */ }
    return env;
}

const hermesEnv = loadHermesEnv();

module.exports = {
    DISCORD_BOT_TOKEN: hermesEnv.DISCORD_BOT_TOKEN,
    GUILD_ID: '1478645646264242362',
    DEALS_CHANNEL_ID: '1575254354343100496',
    SETH_USER_ID: '392951648781205515',

    // Feed endpoints (upstream read these from Firebase config; documented here instead)
    RFD_API_URL: 'https://forums.redflagdeals.com/api/topics?forum_id=9&per_page=30&sort=recent',
    SUBREDDIT_RSS_URL: 'https://www.reddit.com/r/%s/new/.rss',
    EPIC_SEARCH_URL: 'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-CA&country=CA',

    STATE_PATH: __dirname + '/state.json',
};
