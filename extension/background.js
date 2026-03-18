const BACKEND_BASE = "http://localhost:3000";

chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) return;
  chrome.scripting.executeScript(
    { target: { tabId: tab.id }, func: extractPageContent },
    (results) => {
      if (chrome.runtime.lastError) {
        console.error("Recipe Cloud:", chrome.runtime.lastError.message);
        alert("Recipe Cloud: Could not read this page. Try a different tab.");
        return;
      }
      const payload = results?.[0]?.result;
      if (!payload || !payload.source_url) {
        alert("Recipe Cloud: No content could be extracted from this page.");
        return;
      }
      fetch(`${BACKEND_BASE}/api/extract-from-extension`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
        .then((res) => res.json())
        .then((data) => {
          if (data.recipeId) {
            chrome.tabs.create({ url: `${BACKEND_BASE}/recipe/${data.recipeId}` });
          } else {
            alert(data.error || "Recipe Cloud: Failed to create recipe.");
          }
        })
        .catch((err) => {
          console.error("Recipe Cloud:", err);
          alert("Recipe Cloud: Could not reach the server. Is the app running on localhost:3000?");
        });
    }
  );
});

function extractPageContent() {
  const selectors = "p, li, h1, h2, h3, [itemprop='recipeInstructions'] *, [itemprop='recipeIngredient']";
  const excludeSelectors = "nav, footer, header, [role='navigation'], [role='banner'], [role='contentinfo'], .nav, .footer, .header, script, style, noscript";

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

  const raw_text = parts.join("\n\n").replace(/\s+/g, " ").trim().slice(0, 50000);
  const url = window.location.href;

  let platform = "Website";
  if (/youtube\.com|youtu\.be/i.test(url)) platform = "YouTube";
  else if (/instagram\.com/i.test(url)) platform = "Instagram";
  else if (/facebook\.com|fb\.com|fb\.watch/i.test(url)) platform = "Facebook";
  else if (/tiktok\.com/i.test(url)) platform = "TikTok";
  else if (/xiaohongshu|xhslink/i.test(url)) platform = "Xiaohongshu";

  return { raw_text, source_url: url, platform };
}
