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

Missing metrics remain unavailable. The dashboard does not estimate real-time carbon intensity from an insufficiently detailed generation mix. It publishes the directly calculable low-carbon generation share and the latest reported EEA national inventory for public electricity and heat production as two explicitly different metrics.

The scheduled updater downloads three 15-minute XLSX feeds directly from MAVIR's public RTDW service: chart 20001 for load and production mix, chart 5229 for physical and scheduled cross-border flows, and chart 4444 for grid frequency. The snapshot is published only when source freshness, timestamp alignment, system balance, production mix, cross-border reconciliation, schedule deviation, 15-minute movement, and history completeness all pass validation. The measured cross-border sum gap remains visible in the methodology drawer instead of being silently adjusted.

Hungarian day-ahead prices come only from the official ENTSO-E Transparency Platform A44 feed. Set an `ENTSOE_SECURITY_TOKEN` GitHub Actions secret to enable the price card; when the token is missing or the official feed fails, the value stays unavailable instead of falling back to an intermediary.

Annual emissions are queried from the EEA Discodata `GHG_Inventory` database, sector `1.A.1.a` (public electricity and heat production), aggregate greenhouse gases. The dashboard shows the latest reported year, the previous year, and their reconciled percentage change. These annual inventory values are not presented as real-time carbon intensity.

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

`.github/workflows/deploy-pages.yml` refreshes and validates the energy snapshot, builds the static app, runs the complete test suite, and deploys `dist/client` to GitHub Pages. It runs on every push to `main`, on manual dispatch, and every 5 minutes. An open dashboard checks for a newly published snapshot every minute; the effective freshness is still bounded by the source interval and GitHub Actions scheduling latency.

The scheduled job does not create automated data commits. If the live MAVIR fetch or validation fails, publication stops and the previous successful Pages deployment remains online. The annual EEA inventory may retain the last validated annual value when that source is temporarily unavailable; no replacement value is fabricated.

MAVIR exports are requested sequentially, with explicit spacing and `429 Too Many Requests` backoff. This keeps the five-minute publication trigger from sending a burst of parallel requests to the official RTDW service.

## OpenAI Sites publication

The Sites build exposes `/api/energy`, backed by a D1 snapshot and direct request-driven MAVIR refreshes. A snapshot older than two minutes is refreshed in the background with a database lock so concurrent visitors do not create a burst of source requests. The first request initializes from the bundled validated snapshot and attempts an immediate direct refresh. `/api/health` exposes freshness and validation status without returning the full dataset. GitHub Pages remains a static fallback and continues to use its bundled JSON when the Sites API is unavailable.

## Key files

- `src/data/energy-schema.mjs` — normalization and fail-closed validation
- `scripts/update-energy-data.mjs` — snapshot updater
- `public/data/energy-latest.json` — last verified snapshot
- `src/App.jsx` — dashboard interface and interactions
- `tests/energy-data.test.mjs` — reconciliation and timestamp tests
- `.github/workflows/deploy-pages.yml` — validated refresh and Pages deployment
