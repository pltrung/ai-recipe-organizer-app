# Recipe Cloud – Supabase & Vercel Setup

## 1. Supabase

### 1.1 Create / use your project

- Project ID: `jalfuvnuqrquuhmfouxj`
- **Project URL:** `https://jalfuvnuqrquuhmfouxj.supabase.co`
- **Anon (public) key:** use the key from your Supabase dashboard (Dashboard → Settings → API).

### 1.2 Create the `recipes` table

1. In [Supabase](https://supabase.com/dashboard), open project **jalfuvnuqrquuhmfouxj**.
2. Go to **SQL Editor** → **New query**.
3. Paste the contents of **`supabase/migrations/20240318000000_create_recipes.sql`** (from this repo).
4. Click **Run**.

You should see “Success” and the `recipes` table under **Table Editor**.

---

## 2. Local environment

1. In the project root, create **`.env.local`** (this file is gitignored).

2. Add (replace the anon key with your real one):

```env
# Supabase – use your project URL and anon key from Dashboard → Settings → API
NEXT_PUBLIC_SUPABASE_URL=https://jalfuvnuqrquuhmfouxj.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<paste your anon public key here>

# OpenAI – create at https://platform.openai.com/api-keys
OPENAI_API_KEY=<your OpenAI API key>
```

3. Run the app:

```bash
npm install
npm run dev
```

Open http://localhost:3000 and test creating a recipe.

---

## 3. Vercel (deploy from Git)

### 3.1 Push the repo

Push this repo to GitHub (or GitLab/Bitbucket) if you haven’t already.

### 3.2 Import project in Vercel

1. Go to [vercel.com](https://vercel.com) and sign in (e.g. with GitHub).
2. Click **Add New…** → **Project**.
3. **Import** the `ai-recipe-organizer-app` repo.
4. Leave **Framework Preset** as **Next.js** and **Root Directory** as `.` (or leave default).
5. Do **not** deploy yet – add env vars first.

### 3.3 Add environment variables in Vercel

1. In the import screen (or later: Project → **Settings** → **Environment Variables**), add:

| Name                         | Value                    | Environments   |
|------------------------------|--------------------------|----------------|
| `NEXT_PUBLIC_SUPABASE_URL`   | `https://jalfuvnuqrquuhmfouxj.supabase.co` | Production, Preview, Development |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Your Supabase **anon public** key | Production, Preview, Development |
| `OPENAI_API_KEY`             | Your OpenAI API key      | Production, Preview, Development |

2. **Save** (and add each variable one by one if the UI requires it).

### 3.4 Deploy

1. Click **Deploy** (or trigger a new deployment from the **Deployments** tab).
2. When the build finishes, open the **Visit** link (e.g. `https://your-project.vercel.app`).

Your app will use the same Supabase project and OpenAI key in production.

---

## 4. Checklist

- [ ] Supabase: SQL migration run, `recipes` table exists.
- [ ] Local: `.env.local` has `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `OPENAI_API_KEY`.
- [ ] GitHub: Repo pushed.
- [ ] Vercel: Project imported, same 3 env vars set, deploy successful.

If something fails, check:

- **Build:** Vercel build logs for TypeScript/Next errors.
- **Runtime:** Browser console and Vercel **Functions** logs for API errors.
- **DB:** Supabase **Table Editor** and **Logs** to confirm inserts.
