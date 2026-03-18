const DEFAULT_BASES = ["http://127.0.0.1:3000", "http://localhost:3000"];

function setStatus(msg, type) {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.className = "show " + (type || "info");
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

function openOptions(e) {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
}

document.getElementById("open-options").addEventListener("click", openOptions);

(async function initHint() {
  const b = await getBackendBase();
  document.getElementById("backend-hint").textContent = b
    ? `API: ${b}`
    : "API: 127.0.0.1:3000 (then localhost). Use settings for Vercel.";
})();

function extractPageContent() {
  const selectors =
    "p, li, h1, h2, h3, [itemprop='recipeInstructions'] *, [itemprop='recipeIngredient']";
  const excludeSelectors =
    "nav, footer, header, [role='navigation'], [role='banner'], [role='contentinfo'], .nav, .footer, .header, script, style, noscript";

  const excludeRoots = document.querySelectorAll(excludeSelectors);
  const isInsideExcluded = (el) => {
    for (const root of excludeRoots) {
      if (root.contains(el)) return true;
    }
    return false;
  };

  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
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

  const nodes = document.querySelectorAll(selectors);
  const parts = [];
  const seen = new Set();
  for (const el of nodes) {
    if (isInsideExcluded(el)) continue;
    if (!isVisible(el)) continue;
    const text = (el.innerText || el.textContent || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    parts.push(text);
  }

  const raw_text = parts
    .join("\n\n")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 50000);
  const url = window.location.href;

  let platform = "Website";
  if (/youtube\.com|youtu\.be/i.test(url)) platform = "YouTube";
  else if (/instagram\.com/i.test(url)) platform = "Instagram";
  else if (/facebook\.com|fb\.com|fb\.watch/i.test(url)) platform = "Facebook";
  else if (/tiktok\.com/i.test(url)) platform = "TikTok";
  else if (/xiaohongshu|xhslink/i.test(url)) platform = "Xiaohongshu";

  return { raw_text, source_url: url, platform };
}

document.getElementById("save").addEventListener("click", async () => {
  const btn = document.getElementById("save");
  btn.disabled = true;
  setStatus("Reading this page…", "info");

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id) {
      setStatus("No active tab found.", "err");
      btn.disabled = false;
      return;
    }

    if (
      !tab.url ||
      tab.url.startsWith("chrome://") ||
      tab.url.startsWith("edge://") ||
      tab.url.startsWith("about:")
    ) {
      setStatus(
        "Open a normal website (recipe blog, YouTube, etc.). This page can’t be read.",
        "err"
      );
      btn.disabled = false;
      return;
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPageContent,
    });

    const payload = results?.[0]?.result;
    if (!payload || !payload.source_url) {
      setStatus("Couldn’t extract text from this page. Try another page.", "err");
      btn.disabled = false;
      return;
    }

    setStatus("Saving to Recipe Cloud…", "info");

    let usedBase;
    let res;
    try {
      const out = await fetchWithFallback("/api/extract-from-extension", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      res = out.res;
      usedBase = out.base;
    } catch (fetchErr) {
      setStatus(
        "Can’t reach Recipe Cloud. Start the app: npm run dev (port 3000). Or open Extension settings and set your Vercel URL, then Save.",
        "err"
      );
      btn.disabled = false;
      return;
    }

    const data = await res.json().catch(() => ({}));
    if (data.recipeId) {
      setStatus("Opening your recipe…", "ok");
      await chrome.tabs.create({
        url: `${usedBase}/recipe/${data.recipeId}`,
      });
      window.close();
      return;
    }

    setStatus(
      data.error ||
        "Server returned an error. Check the app is running and env vars are set.",
      "err"
    );
  } catch (e) {
    console.error(e);
    setStatus("Something went wrong. Try Extension settings → set API URL.", "err");
  }
  btn.disabled = false;
});
