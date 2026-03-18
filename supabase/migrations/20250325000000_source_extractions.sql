-- Per-source Phase A extractions (parallel to sources[] / raw_texts[])
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS source_extractions jsonb DEFAULT NULL;
