-- Base serving count for ingredient scaling in the app
ALTER TABLE recipes
ADD COLUMN IF NOT EXISTS servings_base double precision NOT NULL DEFAULT 1;

COMMENT ON COLUMN recipes.servings_base IS 'Numeric base servings for scaling ingredients in UI';
