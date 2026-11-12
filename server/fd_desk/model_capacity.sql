CREATE TABLE IF NOT EXISTS model_capacity_limits (
    id INTEGER PRIMARY KEY CHECK (id=1),
    total_limit INTEGER NOT NULL CHECK (total_limit=5),
    reserved_slots INTEGER NOT NULL CHECK (reserved_slots=1)
);
INSERT OR IGNORE INTO model_capacity_limits VALUES (1,5,1);
CREATE TABLE IF NOT EXISTS model_capacity_requests (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    pid INTEGER NOT NULL,
    process_start TEXT NOT NULL,
    category TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued','running'))
);
CREATE INDEX IF NOT EXISTS model_capacity_state ON model_capacity_requests(state,sequence);
CREATE VIEW IF NOT EXISTS model_capacity_next AS
SELECT id FROM model_capacity_requests
WHERE state='queued' AND (
    category='ask' OR (
        SELECT COUNT(*) FROM model_capacity_requests
        WHERE state='running' AND category<>'ask'
    )<3
)
ORDER BY sequence LIMIT 1;
