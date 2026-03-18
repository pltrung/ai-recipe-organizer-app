ALTER TABLE recipes
ADD COLUMN IF NOT EXISTS mistakes jsonb NOT NULL DEFAULT '[]';

ALTER TABLE recipes
ADD COLUMN IF NOT EXISTS techniques jsonb NOT NULL DEFAULT '[]';

COMMENT ON COLUMN recipes.mistakes IS 'Common mistakes / warnings from synthesis';
COMMENT ON COLUMN recipes.techniques IS 'Highlighted techniques from synthesis';
