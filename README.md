# Energiatérkép

Responsive Hungarian electricity-system dashboard inspired by the information density of [holadelej.hu](https://holadelej.hu/), with energy production first, a national flow map second, and energy-only analytical cards below.

## Data integrity

The frontend only renders `public/data/energy-latest.json` after `validateNormalizedEnergyData` accepts it. The update pipeline rejects a snapshot when:

- any required upstream feed reports unhealthy;
- the measurement time is missing or implausible;
- generation categories do not reconcile with total domestic generation;
- border flows do not reconcile with reported net imports;
- generation plus net imports differs excessively from consumption;
- the 24-hour series or seven-country border-flow set is incomplete.

Missing metrics remain unavailable. In particular, the prototype does not estimate carbon intensity from an insufficiently detailed generation mix.

The current prototype adapter reads the public `holadelej.hu/api/data` payload, whose system values are attributed to MAVIR and whose market-price field is attributed to Energy-Charts / SMARD. The dashboard exposes that intermediary in its methodology drawer. A production deployment should replace the adapter with direct MAVIR ingestion and an appropriately licensed market-data feed; the normalized schema and validation gates can remain unchanged.

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

The scheduled job does not create automated data commits. A failed refresh or validation stops the workflow before upload, leaving the last successful Pages deployment online.

## Key files

- `src/data/energy-schema.mjs` — normalization and fail-closed validation
- `scripts/update-energy-data.mjs` — snapshot updater
- `public/data/energy-latest.json` — last verified snapshot
- `src/App.jsx` — dashboard interface and interactions
- `tests/energy-data.test.mjs` — reconciliation and timestamp tests
- `.github/workflows/deploy-pages.yml` — validated refresh and Pages deployment
