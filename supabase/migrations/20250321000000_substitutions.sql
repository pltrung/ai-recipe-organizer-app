-- Chef merge: suggested ingredient alternatives
ALTER TABLE recipes
ADD COLUMN IF NOT EXISTS substitutions jsonb NOT NULL DEFAULT '[]';

COMMENT ON COLUMN recipes.substitutions IS 'Suggested alternatives from chef merge (e.g. fish sauce → soy sauce)';
