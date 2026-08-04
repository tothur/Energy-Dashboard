# Energiatérkép

Responsive Hungarian electricity-system dashboard with energy production first, a national flow map second, and energy-only analytical cards below.

## Data integrity

The frontend only renders `public/data/energy-latest.json` after `validateNormalizedEnergyData` accepts it. The update pipeline rejects a snapshot when:

- any required upstream feed reports unhealthy;
- the measurement time is missing or implausible;
- generation categories do not reconcile with total domestic generation;
- border flows do not reconcile with reported net imports;
- generation plus net imports differs excessively from consumption;
- the 24-hour series or seven-country border-flow set is incomplete.

Missing metrics remain unavailable. In particular, the prototype does not estimate carbon intensity from an insufficiently detailed generation mix.

The scheduled updater downloads three 15-minute XLSX feeds directly from MAVIR's public RTDW service: chart 20001 for load and production mix, chart 5229 for physical cross-border flows, and chart 4444 for grid frequency. The snapshot is published only when source freshness, timestamp alignment, system balance, production mix, cross-border reconciliation, and history completeness all pass validation. The measured cross-border sum gap remains visible in the methodology drawer instead of being silently adjusted.

The HUPX day-ahead price remains explicitly unavailable. The dashboard does not republish a market price from an intermediary; that card will only be enabled when an appropriately licensed direct HUPX feed is available.

## Commands

Node.js 22.13 or newer is required; GitHub Actions uses Node.js 24.

```bash
pnpm install --frozen-lockfile
npm run data:update
npm test
npm run dev -- --host 0.0.0.0 --port 4173
npm run build
```

`npm run data:update` needs network access. It writes a new snapshot only after normalization and validation succeed.

## GitHub Pages publication

`.github/workflows/deploy-pages.yml` refreshes and validates the energy snapshot, builds the static app, runs the complete test suite, and deploys `dist/client` to GitHub Pages. It runs on every push to `main`, on manual dispatch, and every 15 minutes.

The scheduled job does not create automated data commits. If the live fetch is temporarily blocked, the workflow validates and publishes the last committed good snapshot; the UI exposes its timestamp and marks it stale. If that fallback snapshot fails validation, publication stops before upload and the previous successful Pages deployment remains online.

## Key files

- `src/data/energy-schema.mjs` — normalization and fail-closed validation
- `scripts/update-energy-data.mjs` — snapshot updater
- `public/data/energy-latest.json` — last verified snapshot
- `src/App.jsx` — dashboard interface and interactions
- `tests/energy-data.test.mjs` — reconciliation and timestamp tests
- `.github/workflows/deploy-pages.yml` — validated refresh and Pages deployment
