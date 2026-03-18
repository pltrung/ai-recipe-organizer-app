-- Pending merge proposal: extension user reviews before applying body changes
ALTER TABLE recipes
  ADD COLUMN IF NOT EXISTS pending_merge jsonb DEFAULT NULL;

COMMENT ON COLUMN recipes.pending_merge IS 'Extension merge preview: proposed update + sources to append on apply/keep';
