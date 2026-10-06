# TCG Marketplace — data

Nightly build of the data the **TCG Marketplace** app downloads, published to GitHub Pages:

| File | What |
|---|---|
| `index-<lang>.json` | Search index per language (sets, cards, Pokédex numbers) |
| `home.json` + `img/` | Home-screen showcase with baked card thumbnails, plus remote config |
| `embed-*` | Card-art recognition gallery (DINOv2-small int8, 128-d PCA, int8) |
| `twins-ja.json`, `art-twins-ja.json` | Japanese ↔ English art links |

Sources: card data and prices via [TCGdex](https://tcgdex.dev) (MIT); Japanese card list via
[type-null/PTCG-database](https://github.com/type-null/PTCG-database) (MIT). Card images are only used to
compute fingerprints and are never stored or republished here (except the small home-screen thumbnails).
Pokémon and all card artwork © Nintendo / Creatures / GAME FREAK / The Pokémon Company. Unofficial fan project.

The raw art fingerprints live on the `embed-cache` branch (a single, force-pushed commit) and in the
Actions cache, so nightly runs only fingerprint new cards.
