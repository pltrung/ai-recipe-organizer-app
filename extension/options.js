const msg = document.getElementById("msg");

async function load() {
  const { apiBase } = await chrome.storage.local.get("apiBase");
  document.getElementById("base").value =
    apiBase || "http://localhost:3000";
}

document.getElementById("save").addEventListener("click", async () => {
  msg.textContent = "";
  msg.className = "";
  let base = document.getElementById("base").value.trim().replace(/\/$/, "");
  if (!base) {
    msg.textContent = "Enter a URL.";
    msg.className = "err";
    return;
  }
  try {
    const u = new URL(base);
    if (!/^https?:$/i.test(u.protocol)) {
      msg.textContent = "Use http:// or https://";
      msg.className = "err";
      return;
    }
    const originPattern = `${u.origin}/*`;
    const granted = await chrome.permissions.request({
      origins: [originPattern],
    });
    if (!granted) {
      msg.textContent =
        "Permission was not granted — the extension cannot call your app without it.";
      msg.className = "err";
      return;
    }
    await chrome.storage.local.set({ apiBase: base });
    msg.textContent = "Saved. You can use Save recipe from this page again.";
    msg.className = "ok";
  } catch (e) {
    msg.textContent = "Invalid URL. Example: http://localhost:3000";
    msg.className = "err";
  }
});

load();
