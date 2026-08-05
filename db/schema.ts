export const energySnapshotSchema = `
  CREATE TABLE IF NOT EXISTS energy_snapshot (
    key TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    measured_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    refresh_started_at TEXT
  )
`;
