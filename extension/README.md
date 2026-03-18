# Recipe Cloud Chrome Extension

Save recipes from any tab: click the extension icon → content is extracted → sent to Recipe Cloud → recipe page opens.

## How to test on your system

### 1. Run the Recipe Cloud app

```bash
cd /path/to/ai-recipe-organizer-app
npm run dev
```

Leave it running at **http://localhost:3000**. Ensure Supabase and OpenAI are configured (`.env.local`).

### 2. Load the extension in Chrome

1. Open Chrome and go to **chrome://extensions**
2. Turn on **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the **`extension`** folder inside this repo (the folder that contains `manifest.json` and `background.js`)
5. The "Recipe Cloud" extension should appear with a puzzle-piece icon

### 3. Pin the extension (optional)

Click the puzzle icon in the Chrome toolbar → pin "Recipe Cloud" so the icon is always visible.

### 4. How the extension works

1. Click the **Recipe Cloud** icon in the toolbar → a **small popup** opens (this is the UI).
2. Click **“Save recipe from this page”** in the popup.
3. Status messages appear in the popup (“Reading…”, “Saving…”), then a **new tab** opens with your recipe.

*(Earlier versions had no popup and used `alert()` in the background worker—which Chrome does not show, so it looked like nothing happened.)*

### 5. Test the flow

1. Open a tab with a recipe:
   - A **blog** (e.g. [Hungry Huy – Bún Bò Huế](https://www.hungryhuy.com/bun-bo-hue-recipe/))
   - A **YouTube** cooking video page
   - **Instagram** or **TikTok** recipe post (web)
2. Click the **Recipe Cloud** icon → in the popup, click **Save recipe from this page**
3. A **new tab** should open with your saved recipe (or a draft you can edit)

### If something goes wrong

- **"Could not read this page"** – Some pages (e.g. chrome://) can’t be scripted. Use a normal recipe webpage.
- **"Could not reach the server"** – Make sure the Next.js app is running on `http://localhost:3000`.
- **Recipe is empty or wrong** – Use "Edit" on the recipe page to fix it. The extension always saves something so you never lose the link.

### Production (e.g. Vercel)

To point the extension at your deployed app:

1. In `popup.js`, set `BACKEND_BASE` to your app URL (e.g. `https://your-app.vercel.app`).
2. In `manifest.json`, ensure that URL is in `host_permissions` (e.g. `https://your-app.vercel.app/*`).
3. Reload the extension in chrome://extensions.
