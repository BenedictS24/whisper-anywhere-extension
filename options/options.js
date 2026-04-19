const apiKeyInput  = document.getElementById("apiKey");
const siteList     = document.getElementById("siteList");
const newSiteInput = document.getElementById("newSiteInput");
const addSiteBtn   = document.getElementById("addSiteBtn");
const saveBtn      = document.getElementById("saveBtn");
const saveStatus   = document.getElementById("saveStatus");

let sites = [];

function normalizeHost(raw) {
  return raw.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
}

function renderSites() {
  siteList.innerHTML = "";
  if (sites.length === 0) {
    siteList.innerHTML = `<li class="empty-hint" style="background:none;padding:4px 0">No sites added yet.</li>`;
    return;
  }
  sites.forEach((site, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${site}</span><button title="Remove" data-i="${i}">×</button>`;
    siteList.appendChild(li);
  });
}

function addSite() {
  const val = normalizeHost(newSiteInput.value);
  if (!val) return;
  if (!sites.includes(val)) {
    sites.push(val);
    renderSites();
  }
  newSiteInput.value = "";
  newSiteInput.focus();
}

siteList.addEventListener("click", e => {
  if (e.target.dataset.i !== undefined) {
    sites.splice(Number(e.target.dataset.i), 1);
    renderSites();
  }
});

addSiteBtn.addEventListener("click", addSite);
newSiteInput.addEventListener("keydown", e => { if (e.key === "Enter") addSite(); });

saveBtn.addEventListener("click", async () => {
  await browser.storage.local.set({ openai_key: apiKeyInput.value.trim(), whitelist: sites });
  saveStatus.textContent = "✓ Settings saved!";
  saveStatus.className = "";
  setTimeout(() => saveStatus.textContent = "", 3000);
});

// Load on open
browser.storage.local.get(["openai_key", "whitelist"]).then(({ openai_key, whitelist = [] }) => {
  if (openai_key) apiKeyInput.value = openai_key;
  sites = whitelist.map(normalizeHost).filter(Boolean);
  renderSites();
});
