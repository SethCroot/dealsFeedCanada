const rfd = require('./feeds/redflagdeals.js');
(async () => {
  const deals = await rfd.parse();
  console.log(`\n=== ${deals.length} deals parsed from RFD Hot Deals ===`);
  for (const d of deals.slice(0, 5)) {
    console.log(`[${d.dealer_name || '—'}] ${d.title}`);
    console.log(`    score=${d.score} replies=${d.num_comments} hot=${d.is_hot} id=${d.id} ${d.tag ? 'tag:' + d.tag : ''}`);
  }
})().catch(e => { console.error('DRIVER FAIL:', e.message); process.exit(1); });
