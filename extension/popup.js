const DEFAULT_BASES = ["http://127.0.0.1:3000", "http://localhost:3000"];
const STORAGE_ID = "activeRecipeId";
const STORAGE_TITLE = "activeRecipeTitle";
const STORAGE_COUNT = "activeSourceCount";

function setStatus(msg, type) {
  const el = document.getElementById("status");
  if (!el) return;
  el.textContent = msg || "";
  el.className = msg ? "show " + (type || "info") : "";
}

function showView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  const id =
    name === "success"
      ? "view-success"
      : name === "diff"
        ? "view-diff"
        : "view-main";
  document.getElementById(id).classList.add("active");
}

function fillDiffModal(d) {
  const sum = document.getElementById("diff-summary");
  sum.textContent = (d && d.summary) || "Recipe improved with your new source.";
  let list = Array.isArray(d.key_improvements) ? d.key_improvements : [];
  if (!list.length) {
    list = []
      .concat(d.new_insights || [])
      .concat((d.ingredient_changes || []).map((x) => "Ingredients: " + x))
      .concat((d.step_changes || []).map((x) => "Steps: " + x));
  }
  const ul = document.getElementById("diff-key-improvements");
  const wrap = document.getElementById("diff-key-wrap");
  ul.innerHTML = "";
  if (!list.length) {
    wrap.style.display = "none";
    return;
  }
  wrap.style.display = "block";
  list.forEach((t) => {
    const li = document.createElement("li");
    li.textContent = String(t);
    ul.appendChild(li);
  });
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

async function getBackendBase() {
  const { apiBase } = await chrome.storage.local.get("apiBase");
  if (apiBase && String(apiBase).trim()) {
    return String(apiBase).trim().replace(/\/$/, "");
  }
  return null;
}

async function fetchWithFallback(path, options) {
  const custom = await getBackendBase();
  const bases = custom ? [custom] : DEFAULT_BASES;
  let lastErr = null;
  for (const base of bases) {
    try {
      const res = await fetch(`${base}${path}`, options);
      return { res, base };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Failed to fetch");
}

let lastBase = null;
let lastRecipeId = null;
let recentRecipes = [];
let activeId = null;
let activeTitle = "";

document.getElementById("open-options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
document.getElementById("open-options-2").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

(async function initHint() {
  const b = await getBackendBase();
  const el = document.getElementById("backend-hint");
  if (el)
    el.textContent = b
      ? `API: ${b}`
      : "API: 127.0.0.1:3000 — set your deployed URL in settings.";
})();

function renderChoices() {
  const loading = document.getElementById("choices-loading");
  const box = document.getElementById("choices");
  loading.style.display = "none";
  box.style.display = "block";
  box.innerHTML = "";

  if (activeId) {
    const lab = document.createElement("label");
    lab.className = "choice";
    lab.innerHTML = `<input type="radio" name="target" value="active" checked />
      <span><strong>Current recipe:</strong> ${escapeHtml(activeTitle || "Recipe")}</span>`;
    box.appendChild(lab);
  }

  const sub = document.createElement("p");
  sub.className = "section-title";
  sub.textContent = activeId ? "Or pick another recipe" : "Recent recipes";
  box.appendChild(sub);

  let firstRecentId = null;
  recentRecipes.forEach((r) => {
    if (r.id === activeId) return;
    if (!firstRecentId) firstRecentId = r.id;
    const lab = document.createElement("label");
    lab.className = "choice";
    const sc = r.source_count != null ? r.source_count : 0;
    lab.innerHTML = `<input type="radio" name="target" value="id:${r.id}" />
      <span>${escapeHtml(r.title || "Untitled")} <span style="color:#a3a3a3;font-size:11px">(${sc} sources)</span></span>`;
    box.appendChild(lab);
  });

  const newLab = document.createElement("label");
  newLab.className = "choice";
  newLab.innerHTML = `<input type="radio" name="target" value="new" />
    <span><strong>Create new recipe</strong></span>`;
  box.appendChild(newLab);

  if (activeId) {
    const a = box.querySelector('input[value="active"]');
    if (a) a.checked = true;
  } else if (firstRecentId) {
    const r = box.querySelector(`input[value="id:${firstRecentId}"]`);
    if (r) r.checked = true;
  } else {
    const n = box.querySelector('input[value="new"]');
    if (n) n.checked = true;
  }
}

async function loadRecipesAndRender() {
  const storage = await chrome.storage.local.get([
    STORAGE_ID,
    STORAGE_TITLE,
    STORAGE_COUNT,
  ]);
  activeId = storage[STORAGE_ID] || null;
  activeTitle = storage[STORAGE_TITLE] || "";

  try {
    const out = await fetchWithFallback("/api/recipes?limit=5", {
      method: "GET",
    });
    const data = await out.res.json().catch(() => ({}));
    recentRecipes = Array.isArray(data.recipes) ? data.recipes : [];
  } catch {
    recentRecipes = [];
  }

  renderChoices();
}

function getSelectedTarget() {
  const el = document.querySelector('#choices input[name="target"]:checked');
  if (!el) return { mode: "new" };
  const v = el.value;
  if (v === "active" && activeId) return { mode: "merge", recipeId: activeId };
  if (v === "new") return { mode: "new" };
  if (v.startsWith("id:")) return { mode: "merge", recipeId: v.slice(3) };
  return { mode: "new" };
}

function extractPageContent() {
  const selectors = 'p, span, li, h1, h2, h3, div[role="article"]';
  const exclude =
    "nav, footer, header, [role='navigation'], script, style, noscript";
  const excludeRoots = document.querySelectorAll(exclude);
  const insideExcluded = (el) => {
    for (const root of excludeRoots) {
      if (root.contains(el)) return true;
    }
    return false;
  };
  const isVisible = (el) => {
    if (!el?.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return (
      rect.height > 0 &&
      rect.width > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      style.opacity !== "0"
    );
  };
  const MIN_CHUNK = 40;
  const MAX_CHUNK = 500;
  const nodes = document.querySelectorAll(selectors);
  const parts = [];
  const seen = new Set();
  for (const el of nodes) {
    if (insideExcluded(el) || !isVisible(el)) continue;
    let text = (el.innerText || el.textContent || "")
      .trim()
      .replace(/\s+/g, " ");
    if (text.length < MIN_CHUNK) continue;
    if (text.length > MAX_CHUNK) text = text.slice(0, MAX_CHUNK).trim();
    if (text.length < MIN_CHUNK || seen.has(text)) continue;
    seen.add(text);
    parts.push(text);
  }
  let raw_text = parts.join("\n\n").slice(0, 5000);
  if (raw_text.length < MIN_CHUNK && parts.length === 0) {
    const loose = [];
    for (const el of nodes) {
      if (insideExcluded(el) || !isVisible(el)) continue;
      const t = (el.innerText || "").trim().replace(/\s+/g, " ");
      if (t.length >= 25 && t.length <= 800) loose.push(t.slice(0, 500));
    }
    raw_text = [...new Set(loose)].join("\n\n").slice(0, 5000);
  }
  if (!raw_text.trim()) {
    raw_text = (document.body.innerText || "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 5000);
  }
  const url = window.location.href;
  let platform = "website";
  if (/youtube\.com|youtu\.be/i.test(url)) platform = "youtube";
  else if (/instagram\.com/i.test(url)) platform = "instagram";
  else if (/facebook\.com|fb\.com|fb\.watch/i.test(url)) platform = "facebook";
  else if (/tiktok\.com/i.test(url)) platform = "tiktok";
  else if (/xiaohongshu|xhslink/i.test(url)) platform = "xiaohongshu";
  return { raw_text, source_url: url, platform };
}

async function postToBackend(payload) {
  const out = await fetchWithFallback("/api/extract-from-extension", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  lastBase = out.base;
  const data = await out.res.json().catch(() => ({}));
  return { res: out.res, data };
}

document.getElementById("btn-submit").addEventListener("click", async () => {
  const btn = document.getElementById("btn-submit");
  const target = getSelectedTarget();
  btn.disabled = true;
  setStatus("Reading this page…", "info");

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id) {
      setStatus("No active tab.", "err");
      btn.disabled = false;
      return;
    }
    if (
      !tab.url ||
      tab.url.startsWith("chrome://") ||
      tab.url.startsWith("edge://") ||
      tab.url.startsWith("about:")
    ) {
      setStatus("Open a normal web page first.", "err");
      btn.disabled = false;
      return;
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPageContent,
    });
    const payload = results?.[0]?.result;
    if (!payload?.source_url) {
      setStatus("Couldn’t read this page.", "err");
      btn.disabled = false;
      return;
    }

    const body = {
      raw_text: payload.raw_text,
      source_url: payload.source_url,
      platform: payload.platform,
    };
    if (target.mode === "merge" && target.recipeId) {
      body.recipeId = target.recipeId;
    } else {
      const name = document.getElementById("recipe-name").value.trim();
      if (name) body.recipe_name = name;
    }

    setStatus("Saving…", "info");
    let data;
    let res;
    try {
      const out = await postToBackend(body);
      res = out.res;
      data = out.data;
    } catch {
      setStatus("Can’t reach the app. Check API URL in settings.", "err");
      btn.disabled = false;
      return;
    }

    if (!res.ok || !data.recipeId) {
      setStatus(data.error || "Server error.", "err");
      btn.disabled = false;
      return;
    }

    lastRecipeId = data.recipeId;
    const title = data.title || "Recipe";
    const sourceCount = data.sourceCount || 1;

    await chrome.storage.local.set({
      [STORAGE_ID]: data.recipeId,
      [STORAGE_TITLE]: title,
      [STORAGE_COUNT]: sourceCount,
    });
    activeId = data.recipeId;
    activeTitle = title;

    document.getElementById("success-title").textContent = "Added to " + title;
    document.getElementById("success-sub").textContent =
      target.mode === "merge"
        ? "Recipe updated with new source."
        : "New recipe created from this page.";
    if (target.mode === "merge" && data.last_diff) {
      fillDiffModal(data.last_diff);
      showView("diff");
    } else {
      showView("success");
    }
    setStatus("", "info");
    document.getElementById("status").className = "";
  } catch (e) {
    console.error(e);
    setStatus("Something went wrong.", "err");
  }
  btn.disabled = false;
});

document.getElementById("btn-view-recipe").addEventListener("click", async () => {
  const s = await chrome.storage.local.get(STORAGE_ID);
  const id = lastRecipeId || s[STORAGE_ID];
  const base = lastBase || (await getBackendBase()) || DEFAULT_BASES[0];
  if (id) {
    const bust = Date.now();
    await chrome.tabs.create({ url: `${base}/recipe/${id}?updated=${bust}` });
  }
  window.close();
});

document.getElementById("btn-add-another").addEventListener("click", async () => {
  showView("main");
  document.getElementById("recipe-name").value = "";
  await loadRecipesAndRender();
});

document.getElementById("btn-diff-continue").addEventListener("click", () => {
  showView("success");
});

loadRecipesAndRender();
