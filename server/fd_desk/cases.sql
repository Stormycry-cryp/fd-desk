CREATE TABLE IF NOT EXISTS case_reviews (
    id TEXT NOT NULL, unit TEXT NOT NULL CHECK(unit IN ('chain','task')),
    line TEXT NOT NULL, enterprise_id TEXT NOT NULL REFERENCES enterprises(id),
    rating TEXT CHECK(rating IN ('good','ok','bad')), tags_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','seen','done')), updated_at TEXT NOT NULL,
    PRIMARY KEY(unit,id)
);
CREATE INDEX IF NOT EXISTS case_reviews_line ON case_reviews(line,enterprise_id);
CREATE TABLE IF NOT EXISTS case_tags (
    id TEXT PRIMARY KEY, group_name TEXT NOT NULL, label TEXT NOT NULL,
    lines_json TEXT NOT NULL, tone TEXT NOT NULL CHECK(tone IN ('bad','good','neutral')),
    position INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS case_pool (
    id TEXT NOT NULL, unit TEXT NOT NULL CHECK(unit IN ('chain','task')), line TEXT NOT NULL,
    enterprise_id TEXT NOT NULL REFERENCES enterprises(id), note TEXT, template_id TEXT, added_at TEXT NOT NULL,
    PRIMARY KEY(unit,id)
);
CREATE INDEX IF NOT EXISTS case_pool_line ON case_pool(line,unit,added_at DESC);
CREATE INDEX IF NOT EXISTS case_pool_template ON case_pool(template_id) WHERE template_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS case_processing (
    id TEXT NOT NULL, unit TEXT NOT NULL CHECK(unit IN ('chain','task')), processed_at TEXT NOT NULL,
    PRIMARY KEY(unit,id)
);
CREATE TABLE IF NOT EXISTS case_sample_history (
    row_key TEXT PRIMARY KEY, batch_id TEXT NOT NULL, sampled_at TEXT NOT NULL
);
