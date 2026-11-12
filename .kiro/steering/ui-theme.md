---
inclusion: fileMatch
fileMatchPattern: ["apps/web/**"]
---
# UI theme — "moonlit graveyard"

- **Ground:** night violet-black sky `#0C0A14` → `#07080B`. Text: bone `#ECE7DB`, secondary `#A9A497` (both pass 4.5:1).
- **Accents:** spectral green `#7CE8C0` = recovered/promised/safe. Ember `#FF8A3D` = tax bomb, past the legal limit. Moonlight `#F3EBD3` for the moon and candle glow only.
- **Type:** headings Fraunces 300; graveyard signage and epitaphs IM Fell English; body Inter; figures JetBrains Mono.
- **Data encodings (never decorative only):** tombstone height = amount · moss = days overdue · cracks = > 60 days · rising wisp = promise-to-pay · ember dot = past 45 days.
- **Atmosphere:** drifting fog layers, moon, bare-tree and iron-fence silhouettes, a few bats, candle flicker. Keep it behind the data; never over numbers.
- **Motion:** every animation off under `prefers-reduced-motion`. No WebGL on app screens; three.js only on the landing hero.
- **Accessibility:** real buttons/links, 44px targets, aria-labels on tombstones ("Sharma Traders, ₹4.12L, 71 days overdue").
