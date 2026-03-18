# Recipe Cloud

Save recipes from any platform (YouTube, TikTok, Instagram, blogs) by pasting links. AI extracts and merges them into one clean recipe.

## Tech stack

- **Next.js 14** (App Router), **TypeScript**, **TailwindCSS**
- **Supabase** (Auth + DB)
- **OpenAI API**
- **Vercel**

## Setup

**Full Supabase + Vercel steps:** see **[SETUP.md](./SETUP.md)**.

**Quick local:**

1. `npm install`
2. Copy `.env.local.example` to `.env.local` and set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `OPENAI_API_KEY`
3. Run the SQL in `supabase/migrations/20240318000000_create_recipes.sql` in Supabase → SQL Editor
4. `npm run dev` → [http://localhost:3000](http://localhost:3000)

## App structure

- **Landing** `/` – intro + Create Recipe / Dashboard
- **Create** `/create` – paste one or more links → AI extract + merge → save → redirect to recipe
- **Dashboard** `/dashboard` – grid of saved recipes
- **Recipe** `/recipe/[id]` – full recipe view with sources

## API

- `POST /api/recipes/create` – body: `{ urls: string[] }` or `{ urls, fallback: { title, ingredients[], steps[] } }` → returns `{ id }`
- `POST /api/extract` – body: `{ url }` → single-recipe extraction
- `POST /api/merge` – body: `{ recipes: ExtractedRecipe[] }` → merged recipe

## Future-ready

Code is structured so you can add:

- Mobile share / Chrome extension ingestion
- Recipe merge suggestions
- Grocery list generation
