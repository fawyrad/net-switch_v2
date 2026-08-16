import { exec, toast } from "kernelsu";
import "./language.js";
import languageNames from "../locales/languages.json";
import "@fortawesome/fontawesome-free/css/all.min.css";

/* ============================================================================
 * Constants & shared state
 * ==========================================================================*/

const template = document.getElementById("app-template").content;
const appsList = document.getElementById("apps-list");

const configDir = "/data/adb/.config/net-switch";
const profilesPath = `${configDir}/profiles.json`;
const defaultConfigPath = `${configDir}/default.json`;
const modulePropPath = "/data/adb/modules/net-switch/module.prop";

const TABS = ["apps", "profiles", "settings"];
const SPLIT_MARKER = "===NS_SPLIT===";

let profiles = {};
let currentProfile = "";
let installedPackages = new Set();
/** @type {Map<string, "user" | "system">} */
let appOrigin = new Map();
let appConfig = {};
let currentDomainPkg = "";
let currentFilter = "user"; // "all" | "user" | "system"
let currentSort = "blocked";

/* ============================================================================
 * Small helpers
 * ==========================================================================*/

function t(key, ...args) {
  return typeof getTranslation === "function" ? getTranslation(key, ...args) : key;
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function showSpinner() {
  document.getElementById("loading-spinner")?.classList.remove("hidden");
}

function hideSpinner() {
  document.getElementById("loading-spinner")?.classList.add("hidden");
}

/**
 * Runs a shell command through the KernelSU/APatch/Magisk exec bridge.
 * Throws (and shows a toast) on non-zero exit so callers can safely
 * assume the command succeeded whenever this resolves.
 */
async function run(cmd) {
  const { errno, stdout, stderr } = await exec(cmd);
  if (errno !== 0) {
    toast(t("stderr_error", stderr));
    const error = new Error(stderr || `Command failed (errno ${errno})`);
    error.handled = true;
    throw error;
  }
  return stdout;
}

function reportError(error) {
  if (!error?.handled) toast(t("operation_error"), "error");
}

function emptyState() {
  return { wifi: false, mobile: false, domains: [] };
}

/* ============================================================================
 * Persisted default config (active profile, future prefs)
 * ==========================================================================*/

async function fetchConfig() {
  const out = await run("netswitch list --json");
  try {
    return out ? JSON.parse(out) : {};
  } catch (e) {
    return {};
  }
}

async function readDefaultConfig() {
  try {
    const out = await run(`cat ${defaultConfigPath} 2>/dev/null || true`);
    if (!out) return {};
    try {
      return JSON.parse(out.toString());
    } catch (e) {
      return {};
    }
  } catch (e) {
    return {};
  }
}

async function writeDefaultConfig(cfg) {
  try {
    await run(`echo ${shQuote(JSON.stringify(cfg))} > ${defaultConfigPath}`);
  } catch (e) {
    /* non-fatal: preferences are best-effort */
  }
}

async function persistDefaultKey(key, value) {
  const cfg = await readDefaultConfig();
  cfg[key] = value;
  await writeDefaultConfig(cfg);
}

async function loadPersistedProfile() {
  const cfg = await readDefaultConfig();
  if (cfg.currentProfile && profiles[cfg.currentProfile]) {
    // Restore marker only. Do NOT re-apply: live wifi.json/mobile.json already
    // persist across reboot via service.sh, and re-applying an empty profile
    // would wipe the live set (the original bug).
    currentProfile = cfg.currentProfile;
    renderProfilesList();
  }
}

/* ============================================================================
 * Applications page: rendering, filtering, sorting
 * ==========================================================================*/

function getAppInitial(pkg) {
  // Reverse-DNS package names are usually "<tld>.<org>.<app...>";
  // the 2nd segment is normally the most recognizable one.
  const segments = pkg.split(".").filter(Boolean);
  const label = segments[1] || segments[0] || pkg;
  const match = label.match(/[a-zA-Z]/);
  return match ? match[0].toUpperCase() : "?";
}

function getVisiblePkgs() {
  return [...appsList.children]
    .filter((node) => node.style.display !== "none")
    .map((node) => node.dataset.pkg);
}

function updateAppsNavBadge() {
  const badge = document.getElementById("nav-badge-apps");
  if (!badge) return;
  const blockedCount = Object.values(appConfig).filter(
    (s) => s.wifi || s.mobile || (s.domains && s.domains.length),
  ).length;
  badge.textContent = blockedCount > 99 ? "99+" : String(blockedCount);
  badge.classList.toggle("hidden", blockedCount === 0);
}

function updateAppsSubtitle(visibleCount) {
  const el = document.getElementById("apps-page-count");
  if (!el) return;
  // Reflect the TOTAL number of blocked apps from the live config (wifi.json/
  // mobile.json/domains), not just the rows currently visible under the active
  // filter. Otherwise a blocked app hidden by the filter (e.g. a system app
  // while "User" is selected) would make this read "0 blocked" and appear to
  // not sync with the JSON.
  const blockedTotal = Object.values(appConfig).filter(
    (s) => s.wifi || s.mobile || (s.domains && s.domains.length),
  ).length;
  const blockedVisible = [...appsList.children].filter(
    (n) => n.style.display !== "none" && n.dataset.blocked === "1",
  ).length;
  const key = visibleCount === 1 ? "apps_page_subtitle_one" : "apps_page_subtitle";
  let text = t(key, visibleCount, blockedTotal);
  const hidden = blockedTotal - blockedVisible;
  if (hidden > 0) text += t("apps_filtered_hint", hidden);
  el.textContent = text;
}

/** Pick the singular ("_one") or plural translation key based on n (English grammar). */
function pluralCount(n, baseKey) {
  return t(n === 1 ? `${baseKey}_one` : baseKey, n);
}

function applyFilters() {
  const query = (document.getElementById("search")?.value || "").trim().toLowerCase();
  let visibleCount = 0;

  [...appsList.children].forEach((node) => {
    const pkg = node.dataset.pkg;
    const origin = appOrigin.get(pkg) || "user";
    const matchesOrigin = currentFilter === "all" || origin === currentFilter;
    const matchesQuery = !query || pkg.toLowerCase().includes(query);
    const visible = matchesOrigin && matchesQuery;
    node.style.display = visible ? "" : "none";
    if (visible) visibleCount++;
  });

  document.getElementById("apps-empty")?.classList.toggle("hidden", visibleCount !== 0);
  updateAppsSubtitle(visibleCount);
  updateAppsNavBadge();
}

function applySort() {
  const nodes = [...appsList.children];
  nodes.sort((a, b) => {
    if (currentSort === "blocked") {
      const diff = Number(b.dataset.blocked) - Number(a.dataset.blocked);
      return diff !== 0 ? diff : a.dataset.pkg.localeCompare(b.dataset.pkg);
    }
    if (currentSort === "name-desc") return b.dataset.pkg.localeCompare(a.dataset.pkg);
    return a.dataset.pkg.localeCompare(b.dataset.pkg);
  });
  nodes.forEach((node) => appsList.appendChild(node));
}

function refreshAppsView() {
  applySort();
  applyFilters();
}

function updateAppRow(el, pkg) {
  const state = appConfig[pkg] || emptyState();
  const wifiToggle = el.querySelector(".ns-toggle-wifi");
  const mobileToggle = el.querySelector(".ns-toggle-mobile");
  const domainCount = el.querySelector(".app-domain-count");
  const domainBtn = el.querySelector(".ns-domain-btn");
  const domainBadge = el.querySelector(".domain-badge");

  if (wifiToggle) wifiToggle.checked = !!state.wifi;
  if (mobileToggle) mobileToggle.checked = !!state.mobile;
  if (domainCount) {
    domainCount.textContent = state.domains.length ? pluralCount(state.domains.length, "domains_count") : "";
  }
  if (domainBtn) domainBtn.classList.toggle("has-domains", state.domains.length > 0);
  if (domainBadge) {
    if (state.domains.length > 0) {
      domainBadge.textContent = state.domains.length > 99 ? "99+" : String(state.domains.length);
      domainBadge.classList.remove("hidden");
    } else {
      domainBadge.classList.add("hidden");
    }
  }

  el.dataset.blocked = state.wifi || state.mobile || state.domains.length ? "1" : "0";
}

function refreshAllRows() {
  [...appsList.children].forEach((node) => updateAppRow(node, node.dataset.pkg));
}

function populateApp(pkg) {
  const frag = document.importNode(template, true);
  const el = frag.firstElementChild;
  if (!el) return;

  el.dataset.pkg = pkg;

  const nameElement = el.querySelector("p.truncate");
  if (nameElement) nameElement.textContent = pkg;

  const iconBtn = el.querySelector(".app-icon");
  if (iconBtn) {
    iconBtn.textContent = getAppInitial(pkg);
    const palette = [
      ["bg-primary-container", "text-on-primary-container"],
      ["bg-secondary-container", "text-on-secondary-container"],
      ["bg-tertiary-container", "text-on-tertiary-container"],
    ];
    let hash = 0;
    for (let i = 0; i < pkg.length; i++) hash = (hash * 31 + pkg.charCodeAt(i)) >>> 0;
    const [bg, fg] = palette[hash % palette.length];
    iconBtn.classList.remove("bg-tertiary-container", "text-on-tertiary-container");
    iconBtn.classList.add(bg, fg);
  }

  updateAppRow(el, pkg);

  const wifiToggle = el.querySelector(".ns-toggle-wifi");
  const mobileToggle = el.querySelector(".ns-toggle-mobile");
  const domainBtn = el.querySelector(".ns-domain-btn");

  const handleToggle = (toggle, blockCmd, unblockCmd, key) => {
    toggle?.addEventListener("change", async () => {
      showSpinner();
      const previous = !toggle.checked;
      try {
        const cmd = toggle.checked ? blockCmd : unblockCmd;
        await run(`netswitch ${cmd} ${shQuote(pkg)}`);
        appConfig[pkg] = appConfig[pkg] || emptyState();
        appConfig[pkg][key] = toggle.checked;
        updateAppRow(el, pkg);
        refreshAppsView();
        await syncActiveProfile();
        toast(t("operation_completed"), "success");
      } catch (error) {
        toggle.checked = previous;
        updateAppRow(el, pkg);
        reportError(error);
      } finally {
        hideSpinner();
      }
    });
  };

  handleToggle(wifiToggle, "block-wifi", "unblock-wifi", "wifi");
  handleToggle(mobileToggle, "block-mobile", "unblock-mobile", "mobile");

  domainBtn?.addEventListener("click", () => openDomainModal(pkg));

  appsList.appendChild(el);
}

async function loadApps() {
  showSpinner();
  try {
    const raw = await run(
      `pm list packages -3 | cut -d: -f2 | sort; echo '${SPLIT_MARKER}'; pm list packages -s | cut -d: -f2 | sort`,
    );
    const [userRaw = "", systemRaw = ""] = (raw || "").split(SPLIT_MARKER);

    appOrigin = new Map();
    userRaw
      .split("\n")
      .filter(Boolean)
      .forEach((pkg) => appOrigin.set(pkg, "user"));
    systemRaw
      .split("\n")
      .filter(Boolean)
      .forEach((pkg) => appOrigin.set(pkg, "system"));

    installedPackages = new Set(appOrigin.keys());
    appConfig = await fetchConfig();

    appsList.innerHTML = "";
    for (const pkg of installedPackages) {
      populateApp(pkg);
    }
    refreshAppsView();
  } catch (error) {
    reportError(error);
  } finally {
    hideSpinner();
  }
}

async function blockAllVisible() {
  const pkgs = getVisiblePkgs();
  if (!pkgs.length) return;

  showSpinner();
  try {
    await run(`netswitch block ${pkgs.map(shQuote).join(" ")}`);
    appConfig = await fetchConfig();
    refreshAllRows();
    refreshAppsView();
    await syncActiveProfile();
    toast(pluralCount(pkgs.length, "bulk_blocked"), "success");
  } catch (error) {
    reportError(error);
  } finally {
    hideSpinner();
  }
}

async function unblockAllVisible() {
  const pkgs = getVisiblePkgs();
  if (!pkgs.length) return;

  showSpinner();
  try {
    await run(`netswitch unblock ${pkgs.map(shQuote).join(" ")}`);
    appConfig = await fetchConfig();
    refreshAllRows();
    refreshAppsView();
    await syncActiveProfile();
    toast(pluralCount(pkgs.length, "bulk_unblocked"), "success");
  } catch (error) {
    reportError(error);
  } finally {
    hideSpinner();
  }
}

/** Fully clears the Wi-Fi/mobile block lists AND custom domain rules for every installed app. */
async function unblockEverything() {
  showSpinner();
  try {
    await run("netswitch set-wifi");
    await run("netswitch set-mobile");
    // Also clear every app's custom domain set so "No Profile" is a truly clean state.
    const domainPkgs = Object.entries(appConfig)
      .filter(([, s]) => s.domains && s.domains.length)
      .map(([p]) => p);
    for (const pkg of domainPkgs) {
      await run(`netswitch domain-set ${shQuote(pkg)}`);
    }
    appConfig = await fetchConfig();
    refreshAllRows();
    refreshAppsView();

    currentProfile = "";
    await persistDefaultKey("currentProfile", "");
    renderProfilesList();

    toast(t("all_apps_connected"), "success");
  } catch (error) {
    reportError(error);
  } finally {
    hideSpinner();
  }
}

function setupSearch() {
  document.getElementById("search")?.addEventListener("input", () => applyFilters());
}

/**
 * Wires up a small anchored dropdown menu (trigger button + floating panel
 * of `.dropdown-item` buttons). Handles open/close, closing on outside
 * click / Escape, and closing sibling dropdowns (including their trigger's
 * aria-expanded state) when one opens.
 */
const registeredDropdowns = [];

function closeOtherDropdowns(except) {
  registeredDropdowns.forEach((d) => {
    if (d !== except) d.close();
  });
}

function setupDropdown(triggerId, panelId, onSelect) {
  const trigger = document.getElementById(triggerId);
  const panel = document.getElementById(panelId);
  if (!trigger || !panel) return;

  const entry = {
    close() {
      panel.classList.add("hidden");
      trigger.setAttribute("aria-expanded", "false");
    },
  };
  const open = () => {
    closeOtherDropdowns(entry);
    panel.classList.remove("hidden");
    trigger.setAttribute("aria-expanded", "true");
  };

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (panel.classList.contains("hidden")) open();
    else entry.close();
  });

  panel.addEventListener("click", (e) => {
    const item = e.target.closest(".dropdown-item");
    if (!item) return;
    onSelect(item);
    entry.close();
  });

  document.addEventListener("click", (e) => {
    if (!panel.classList.contains("hidden") && !panel.contains(e.target) && e.target !== trigger) {
      entry.close();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") entry.close();
  });

  registeredDropdowns.push(entry);
}

const FILTER_SHORT_LABEL_KEYS = { all: "filter_all_short", user: "filter_user_short", system: "filter_system_short" };

function setupFilterDropdown() {
  const label = document.getElementById("filter-btn-label");
  setupDropdown("filter-btn", "filter-dropdown", (item) => {
    currentFilter = item.dataset.filter;
    document
      .querySelectorAll("#filter-dropdown .dropdown-item")
      .forEach((el) => el.setAttribute("aria-pressed", el === item ? "true" : "false"));
    if (label) label.textContent = t(FILTER_SHORT_LABEL_KEYS[currentFilter] || currentFilter);
    applyFilters();
  });
}

function setupSortDropdown() {
  setupDropdown("sort-btn", "sort-dropdown", (item) => {
    currentSort = item.dataset.sort;
    document
      .querySelectorAll("#sort-dropdown .dropdown-item")
      .forEach((el) => el.setAttribute("aria-pressed", el === item ? "true" : "false"));
    applySort();
  });
}

function setupBulkActions() {
  document.getElementById("block-all-btn")?.addEventListener("click", blockAllVisible);
  document.getElementById("unblock-all-btn")?.addEventListener("click", unblockAllVisible);
}

/* ============================================================================
 * Domain (per-app) blocking modal
 * ==========================================================================*/

function renderDomainChips(pkg) {
  const listEl = document.getElementById("domain-list");
  const emptyEl = document.getElementById("domain-empty");
  if (!listEl || !emptyEl) return;

  const domains = (appConfig[pkg] || emptyState()).domains;
  listEl.innerHTML = "";
  emptyEl.classList.toggle("hidden", domains.length > 0);

  domains.forEach((entry) => {
    const chip = document.createElement("span");
    chip.className = "domain-chip";
    const label = document.createElement("span");
    label.textContent = entry;
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.innerHTML = '<i class="fas fa-times" style="font-size:8px"></i>';
    removeBtn.addEventListener("click", () => removeDomain(pkg, entry));
    chip.appendChild(label);
    chip.appendChild(removeBtn);
    listEl.appendChild(chip);
  });
}

async function refreshDomainsFor(pkg) {
  const out = await run(`netswitch domain-list ${shQuote(pkg)}`);
  const domains = out ? out.split("\n").filter(Boolean) : [];
  appConfig[pkg] = { ...(appConfig[pkg] || emptyState()), domains };
  return domains;
}

function refreshAppRowFor(pkg) {
  const row = appsList.querySelector(`[data-pkg="${CSS.escape(pkg)}"]`);
  if (row) updateAppRow(row, pkg);
  refreshAppsView();
}

async function addDomain(pkg, entry) {
  if (!entry) return;
  showSpinner();
  try {
    await run(`netswitch domain-add ${shQuote(pkg)} ${shQuote(entry)}`);
    await refreshDomainsFor(pkg);
    renderDomainChips(pkg);
    refreshAppRowFor(pkg);
    await syncActiveProfile();
    toast(t("domain_added", entry), "success");
  } catch (error) {
    reportError(error);
  } finally {
    hideSpinner();
  }
}

async function removeDomain(pkg, entry) {
  showSpinner();
  try {
    await run(`netswitch domain-remove ${shQuote(pkg)} ${shQuote(entry)}`);
    await refreshDomainsFor(pkg);
    renderDomainChips(pkg);
    refreshAppRowFor(pkg);
    await syncActiveProfile();
    toast(t("domain_removed", entry), "success");
  } catch (error) {
    reportError(error);
  } finally {
    hideSpinner();
  }
}

// Feature 8 — built-in shared blocklists users can pull in without typing.
const DOMAIN_PRESETS = {
  ads: [
    "doubleclick.net",
    "googlesyndication.com",
    "googleadservices.com",
    "adservice.google.com",
    "adnxs.com",
    "pagead2.googlesyndication.com",
    "ads.yahoo.com",
  ],
  social: ["facebook.com", "instagram.com", "tiktok.com", "twitter.com", "x.com", "snapchat.com"],
};

/* Feature 11 — user-defined reusable domain blocklists, persisted alongside profiles. */
const presetsPath = `${configDir}/domain_presets.json`;
let domainPresets = {};

async function loadDomainPresets() {
  try {
    const out = await run(`cat ${presetsPath} 2>/dev/null || echo '{}'`);
    domainPresets = out ? JSON.parse(out) : {};
  } catch (e) {
    domainPresets = {};
  }
}

async function saveDomainPresets() {
  await run(`echo ${shQuote(JSON.stringify(domainPresets))} > ${presetsPath}`);
}

function resolvePresetDomains(value) {
  if (!value) return null;
  if (value.startsWith("user:")) return domainPresets[value.slice(5)] || [];
  return DOMAIN_PRESETS[value] || null;
}

function populatePresetSelect() {
  const sel = document.getElementById("domain-preset-select");
  if (!sel) return;
  sel.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = t("domain_preset_none");
  sel.appendChild(none);

  const builtin = document.createElement("optgroup");
  builtin.label = t("preset_group_builtin");
  Object.keys(DOMAIN_PRESETS).forEach((k) => {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = t(k === "ads" ? "domain_preset_ads" : "domain_preset_social");
    builtin.appendChild(o);
  });
  sel.appendChild(builtin);

  const names = Object.keys(domainPresets);
  if (names.length) {
    const custom = document.createElement("optgroup");
    custom.label = t("preset_group_custom");
    names.forEach((name) => {
      const o = document.createElement("option");
      o.value = `user:${name}`;
      o.textContent = name;
      custom.appendChild(o);
    });
    sel.appendChild(custom);
  }
}

let presetSaveDomains = [];
function openPresetSaveModal() {
  const text = document.getElementById("domain-import-text")?.value || "";
  let domains = [
    ...new Set(text.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)),
  ];
  if (!domains.length) domains = (appConfig[currentDomainPkg]?.domains || []).slice();
  if (!domains.length) {
    toast(t("preset_needs_domains"), "error");
    return;
  }
  presetSaveDomains = domains;
  const input = document.getElementById("preset-name-input");
  if (input) input.value = "";
  const modal = document.getElementById("preset_save_modal");
  if (modal) {
    document.documentElement.classList.add("modal-open");
    modal.showModal();
    input?.focus();
  }
}

async function saveDomainPreset(name) {
  name = (name || "").trim();
  if (!name) {
    toast(t("preset_needs_name"), "error");
    return false;
  }
  domainPresets[name] = [...presetSaveDomains];
  await saveDomainPresets();
  populatePresetSelect();
  toast(t("preset_saved", name), "success");
  return true;
}

async function deleteDomainPreset(name) {
  delete domainPresets[name];
  await saveDomainPresets();
  populatePresetSelect();
  renderPresetManager();
  toast(t("preset_deleted", name), "success");
}

function renderPresetManager() {
  const list = document.getElementById("preset-manager-list");
  const empty = document.getElementById("preset-manager-empty");
  if (!list) return;
  list.innerHTML = "";
  const names = Object.keys(domainPresets);
  if (empty) empty.classList.toggle("hidden", names.length > 0);
  names.forEach((name) => {
    const row = document.createElement("div");
    row.className = "flex items-center gap-2 rounded-2xl bg-surface-container-high p-3";
    row.dataset.preset = name;
    const info = document.createElement("div");
    info.className = "min-w-0 flex-1";
    const title = document.createElement("p");
    title.className = "truncate text-sm font-medium text-on-surface";
    title.textContent = name;
    const sub = document.createElement("p");
    sub.className = "truncate text-xs text-on-surface-variant";
    sub.textContent = pluralCount(domainPresets[name].length, "preset_domains_count");
    info.append(title, sub);
    row.appendChild(info);
    row.appendChild(
      makeActionButton({
        testid: `preset-delete-${name}`,
        ariaKey: "profile_delete",
        iconClass: "fas fa-trash text-xs",
        extraClass: "text-error hover:bg-error-container/30",
        onClick: () => deleteDomainPreset(name),
      }),
    );
    list.appendChild(row);
  });
}

function openPresetManager() {
  renderPresetManager();
  const modal = document.getElementById("preset_manager_modal");
  if (modal) {
    document.documentElement.classList.add("modal-open");
    modal.showModal();
  }
}

function setupPresetModals() {
  const saveModal = document.getElementById("preset_save_modal");
  const nameInput = document.getElementById("preset-name-input");
  const saveConfirm = document.getElementById("preset-save-confirm-btn");
  if (saveModal && nameInput && saveConfirm) {
    const submit = async () => {
      if (await saveDomainPreset(nameInput.value)) {
        saveModal.close();
        document.documentElement.classList.remove("modal-open");
      }
    };
    saveConfirm.addEventListener("click", submit);
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
    saveModal.addEventListener("close", () =>
      document.documentElement.classList.remove("modal-open"),
    );
  }
  document
    .getElementById("preset_manager_modal")
    ?.addEventListener("close", () => document.documentElement.classList.remove("modal-open"));
  document.getElementById("domain-preset-save-btn")?.addEventListener("click", openPresetSaveModal);
  document
    .getElementById("domain-preset-manage-btn")
    ?.addEventListener("click", openPresetManager);
}

async function importDomains(pkg, rawText) {
  const entries = [
    ...new Set(
      String(rawText || "")
        .split(/[\s,;]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (!entries.length) {
    toast(t("no_valid_domains"), "error");
    return;
  }
  showSpinner();
  try {
    await run(`netswitch domain-add ${shQuote(pkg)} ${entries.map(shQuote).join(" ")}`);
    await refreshDomainsFor(pkg);
    renderDomainChips(pkg);
    refreshAppRowFor(pkg);
    await syncActiveProfile();
    toast(pluralCount(entries.length, "domains_imported"), "success");
  } catch (error) {
    reportError(error);
  } finally {
    hideSpinner();
  }
}

function openDomainModal(pkg) {
  currentDomainPkg = pkg;
  const appLabel = document.getElementById("domain-modal-app");
  if (appLabel) appLabel.textContent = pkg;
  const input = document.getElementById("domain-input");
  if (input) input.value = "";
  const importText = document.getElementById("domain-import-text");
  if (importText) importText.value = "";
  const presetSel = document.getElementById("domain-preset-select");
  if (presetSel) presetSel.value = "";
  populatePresetSelect();
  renderDomainChips(pkg);
  document.getElementById("domain_modal")?.showModal();
}

function setupDomainModal() {
  const addBtn = document.getElementById("domain-add-btn");
  const input = document.getElementById("domain-input");
  if (!addBtn || !input) return;

  const submit = async () => {
    const value = input.value.trim();
    if (!value) return;
    await addDomain(currentDomainPkg, value);
    input.value = "";
  };

  addBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });

  const importBtn = document.getElementById("domain-import-btn");
  const importText = document.getElementById("domain-import-text");
  const presetSel = document.getElementById("domain-preset-select");
  presetSel?.addEventListener("change", () => {
    const preset = resolvePresetDomains(presetSel.value);
    if (preset && importText) importText.value = preset.join("\n");
  });
  importBtn?.addEventListener("click", async () => {
    if (!importText) return;
    await importDomains(currentDomainPkg, importText.value);
    importText.value = "";
    if (presetSel) presetSel.value = "";
  });
}

/* ============================================================================
 * Profiles page
 * ==========================================================================*/

function makeActionButton({ testid, ariaKey, iconClass, extraClass, onClick }) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className =
    "flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full hover:bg-surface-container-highest " +
    (extraClass || "text-on-surface-variant");
  btn.setAttribute("aria-label", t(ariaKey));
  btn.setAttribute("data-testid", testid);
  const icon = document.createElement("i");
  icon.className = iconClass;
  btn.appendChild(icon);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

// Unified row markup for both the "No Profile" entry and named profiles: every
// row is a <div.profile-row> with a single tappable apply <button.profile-apply>
// plus (for named profiles) rename / duplicate / delete action buttons.
function createProfileRow({ isNone, name, count, isActive }) {
  const row = document.createElement("div");
  row.className = "profile-row flex w-full items-center gap-2 rounded-2xl bg-surface-container-high p-3";
  if (!isNone) row.dataset.profile = name;

  const applyBtn = document.createElement("button");
  applyBtn.type = "button";
  applyBtn.className = "profile-apply flex min-w-0 flex-1 items-center gap-3 text-left";
  applyBtn.setAttribute(
    "aria-label",
    isNone ? t("profile_none_label") : t("profile_apply_aria", name),
  );
  applyBtn.setAttribute("data-testid", isNone ? "profile-apply-none" : `profile-apply-${name}`);

  const iconWrap = document.createElement("div");
  iconWrap.className = `flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-2xl ${
    isNone ? "bg-surface-container-highest" : isActive ? "bg-primary-container" : "bg-tertiary-container"
  }`;
  const icon = document.createElement("i");
  icon.className = `fas ${isNone ? "fa-ban" : "fa-user-shield"} text-sm ${
    isNone ? "text-on-surface-variant" : isActive ? "text-on-primary-container" : "text-on-tertiary-container"
  }`;
  iconWrap.appendChild(icon);

  const textWrap = document.createElement("div");
  textWrap.className = "min-w-0 flex-1";
  const title = document.createElement("p");
  title.className = "truncate text-sm font-medium text-on-surface";
  title.textContent = isNone ? t("profile_none_label") : name;
  const subtitle = document.createElement("p");
  subtitle.className = "profile-count truncate text-xs text-on-surface-variant";
  subtitle.textContent = isNone ? t("profile_none_desc") : pluralCount(count, "profile_apps_count");
  textWrap.append(title, subtitle);

  applyBtn.append(iconWrap, textWrap);
  applyBtn.addEventListener("click", () => (isNone ? unblockEverything() : loadProfile(name)));

  if (!isNone) {
    const grip = document.createElement("span");
    grip.className =
      "profile-drag-handle flex h-9 w-5 flex-shrink-0 cursor-grab items-center justify-center text-on-surface-variant";
    grip.setAttribute("data-testid", `profile-drag-${name}`);
    grip.setAttribute("aria-label", t("profile_reorder"));
    grip.innerHTML = '<i class="fas fa-grip-vertical text-xs"></i>';
    grip.style.touchAction = "none";
    row.appendChild(grip);
    attachLongPressDrag(grip, row, name);

    row.draggable = true;
    row.addEventListener("dragstart", (e) => {
      dragSourceProfile = name;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", name);
      row.classList.add("opacity-50");
    });
    row.addEventListener("dragend", () => {
      dragSourceProfile = "";
      row.classList.remove("opacity-50");
    });
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      const src = dragSourceProfile || e.dataTransfer.getData("text/plain");
      reorderProfiles(src, name);
    });
  }
  row.appendChild(applyBtn);

  if (isActive) {
    const check = document.createElement("i");
    check.className = "fas fa-circle-check flex-shrink-0 text-sm text-primary";
    row.appendChild(check);
  }

  if (!isNone) {
    row.appendChild(
      makeActionButton({
        testid: `profile-rename-${name}`,
        ariaKey: "profile_rename",
        iconClass: "fas fa-pen text-xs",
        onClick: () => openRenameModal(name),
      }),
    );
    row.appendChild(
      makeActionButton({
        testid: `profile-clone-${name}`,
        ariaKey: "profile_clone",
        iconClass: "fas fa-copy text-xs",
        onClick: () => cloneProfile(name),
      }),
    );
    row.appendChild(
      makeActionButton({
        testid: `profile-share-${name}`,
        ariaKey: "profile_share",
        iconClass: "fas fa-share-nodes text-xs",
        onClick: () => openShareModal(name),
      }),
    );
    row.appendChild(
      makeActionButton({
        testid: `profile-delete-${name}`,
        ariaKey: "profile_delete",
        iconClass: "fas fa-trash text-xs",
        extraClass: "text-error hover:bg-error-container/30",
        onClick: () => deleteProfile(name),
      }),
    );
  }

  return row;
}

function renderProfilesList() {
  const container = document.getElementById("profiles-list");
  if (!container) return;
  container.innerHTML = "";

  container.appendChild(createProfileRow({ isNone: true, isActive: currentProfile === "" }));

  Object.keys(profiles).forEach((name) => {
    const profile = profiles[name];
    const count = countIsolatedApps(profile);
    container.appendChild(
      createProfileRow({ isNone: false, name, count, isActive: name === currentProfile }),
    );
  });

  const badge = document.getElementById("nav-badge-profiles");
  if (badge) {
    const n = Object.keys(profiles).length;
    badge.textContent = n > 99 ? "99+" : String(n);
    badge.classList.toggle("hidden", n === 0);
  }
}

async function loadProfiles() {
  try {
    const profilesData = await run(`cat ${profilesPath} 2>/dev/null || echo '{}'`);
    profiles = profilesData ? JSON.parse(profilesData) : {};
  } catch (error) {
    profiles = {};
  }
  renderProfilesList();
}

async function saveProfiles() {
  await run(`echo ${shQuote(JSON.stringify(profiles))} > ${profilesPath}`);
}

async function loadProfile(profileName) {
  const profile = profiles[profileName];
  if (!profile) {
    toast(t("profile_not_found", profileName), "error");
    return;
  }

  showSpinner();
  try {
    const wifiPkgs = (profile.wifi || []).filter((p) => installedPackages.has(p));
    const mobilePkgs = (profile.mobile || []).filter((p) => installedPackages.has(p));

    await run(`netswitch set-wifi ${wifiPkgs.map(shQuote).join(" ")}`.trim());
    await run(`netswitch set-mobile ${mobilePkgs.map(shQuote).join(" ")}`.trim());

    // Restore each app's custom domain set from the profile snapshot. Apps that
    // currently have domains but are not in the profile get their set cleared,
    // so applying a profile fully restores its state (domain-set replaces the
    // whole per-app list; empty args clears it).
    const targetDomains = profile.domains || {};
    const pkgsToReconcile = new Set([
      ...Object.keys(targetDomains),
      ...Object.entries(appConfig)
        .filter(([, s]) => s.domains && s.domains.length)
        .map(([p]) => p),
    ]);
    for (const pkg of pkgsToReconcile) {
      const entries = (targetDomains[pkg] || []).filter(Boolean);
      await run(`netswitch domain-set ${shQuote(pkg)} ${entries.map(shQuote).join(" ")}`.trim());
    }

    appConfig = await fetchConfig();
    refreshAllRows();
    refreshAppsView();

    currentProfile = profileName;
    await persistDefaultKey("currentProfile", currentProfile);
    renderProfilesList();

    const n = new Set([...wifiPkgs, ...mobilePkgs]).size;
    toast(t(n === 1 ? "profile_activated_one" : "profile_activated", profileName, n), "success");
  } catch (error) {
    reportError(error);
  } finally {
    hideSpinner();
  }
}

function collectCurrentSelection() {
  const wifi = [];
  const mobile = [];
  const domains = {};
  Object.entries(appConfig).forEach(([pkg, state]) => {
    if (state.wifi) wifi.push(pkg);
    if (state.mobile) mobile.push(pkg);
    if (state.domains && state.domains.length) domains[pkg] = [...state.domains];
  });
  return { wifi, mobile, domains };
}

/** Number of UNIQUE apps isolated by a profile (an app blocked on both Wi-Fi
 *  and mobile must count once, not twice). */
function countIsolatedApps(profile) {
  return new Set([...(profile?.wifi || []), ...(profile?.mobile || [])]).size;
}

/**
 * Keep the active profile in sync with the live selection so profiles behave
 * as a live, auto-updating set instead of a one-time snapshot.
 * No-op for the "No Profile" case (currentProfile === "").
 */
async function syncActiveProfile() {
  if (!currentProfile || !profiles[currentProfile]) return;
  profiles[currentProfile] = collectCurrentSelection();
  await saveProfiles();
  renderProfilesList();
}

async function saveCurrentProfile(profileName) {
  showSpinner();
  try {
    profiles[profileName] = collectCurrentSelection();
    await saveProfiles();
    currentProfile = profileName;
    await persistDefaultKey("currentProfile", currentProfile);
    renderProfilesList();

    const total = countIsolatedApps(profiles[profileName]);
    toast(t(total === 1 ? "profile_created_one" : "profile_created", profileName, total), "success");
  } catch (error) {
    reportError(error);
  } finally {
    hideSpinner();
  }
}

async function deleteProfile(profileName) {
  if (!profileName) {
    toast(t("invalid_profile_name"), "error");
    return;
  }

  showSpinner();
  try {
    delete profiles[profileName];
    await saveProfiles();

    if (currentProfile === profileName) {
      currentProfile = "";
      await persistDefaultKey("currentProfile", "");
    }

    renderProfilesList();
    toast(t("profile_deleted", profileName), "success");
  } catch (error) {
    reportError(error);
  } finally {
    hideSpinner();
  }
}

async function renameProfile(oldName, newName) {
  newName = (newName || "").trim();
  if (!newName) {
    toast(t("enter_profile_name"), "error");
    return false;
  }
  if (newName === oldName) return true;
  if (profiles[newName]) {
    toast(t("profile_exists"), "error");
    return false;
  }
  showSpinner();
  try {
    // Preserve insertion order by rebuilding the map with the key renamed.
    const rebuilt = {};
    Object.keys(profiles).forEach((k) => {
      rebuilt[k === oldName ? newName : k] = profiles[k];
    });
    profiles = rebuilt;
    await saveProfiles();
    if (currentProfile === oldName) {
      currentProfile = newName;
      await persistDefaultKey("currentProfile", currentProfile);
    }
    renderProfilesList();
    toast(t("profile_renamed", newName), "success");
    return true;
  } catch (error) {
    reportError(error);
    return false;
  } finally {
    hideSpinner();
  }
}

async function cloneProfile(name) {
  const src = profiles[name];
  if (!src) {
    toast(t("profile_not_found", name), "error");
    return;
  }
  let newName = `${name} copy`;
  let i = 2;
  while (profiles[newName]) newName = `${name} copy ${i++}`;
  showSpinner();
  try {
    profiles[newName] = JSON.parse(JSON.stringify(src));
    await saveProfiles();
    renderProfilesList();
    toast(t("profile_cloned", newName), "success");
  } catch (error) {
    reportError(error);
  } finally {
    hideSpinner();
  }
}

let dragSourceProfile = "";

// Feature 7 — reorder profiles by drag & drop. profiles is an insertion-ordered
// object, so reordering means rebuilding it with the keys in the new order.
async function reorderProfiles(source, targetName) {
  if (!source || source === targetName || !profiles[source]) return;
  const keys = Object.keys(profiles).filter((k) => k !== source);
  const rebuilt = {};
  const idx = targetName && profiles[targetName] ? keys.indexOf(targetName) : keys.length;
  keys.splice(idx < 0 ? keys.length : idx, 0, source);
  keys.forEach((k) => (rebuilt[k] = profiles[k]));
  profiles = rebuilt;
  await saveProfiles();
  renderProfilesList();
  toast(t("profiles_reordered"), "success");
}

// Feature 12 — long-press drag for touch (and mouse) using Pointer Events, so
// reordering works naturally on phones where HTML5 drag-and-drop does not fire.
function attachLongPressDrag(grip, row, name) {
  let pressTimer = null;
  let dragging = false;
  let dropTarget = "";
  const LONG_PRESS_MS = 300;

  const clearHighlights = () =>
    document
      .querySelectorAll(".profile-row.drop-target")
      .forEach((r) => r.classList.remove("drop-target", "ring-2", "ring-primary"));

  const onMove = (e) => {
    if (!dragging) return;
    e.preventDefault();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const target = el && el.closest ? el.closest(".profile-row[data-profile]") : null;
    clearHighlights();
    if (target && target !== row) {
      target.classList.add("drop-target", "ring-2", "ring-primary");
      dropTarget = target.dataset.profile;
    } else {
      dropTarget = "";
    }
  };

  const end = async () => {
    clearTimeout(pressTimer);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    if (dragging) {
      dragging = false;
      row.classList.remove("opacity-60", "scale-[1.02]");
      clearHighlights();
      if (dropTarget) await reorderProfiles(name, dropTarget);
    }
  };

  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    dropTarget = "";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    pressTimer = setTimeout(() => {
      dragging = true;
      row.classList.add("opacity-60", "scale-[1.02]");
      if (navigator.vibrate) navigator.vibrate(15);
    }, LONG_PRESS_MS);
  });
}

// Feature 9 — share/export a profile as a portable code, and import one.
function encodeProfile(name) {
  const src = profiles[name] || {};
  const payload = {
    v: 1,
    name,
    wifi: src.wifi || [],
    mobile: src.mobile || [],
    domains: src.domains || {},
  };
  return "NSPROF1:" + btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
}

function decodeProfile(code) {
  const str = String(code || "").trim();
  if (!str.startsWith("NSPROF1:")) throw new Error("bad prefix");
  const json = decodeURIComponent(escape(atob(str.slice(8))));
  const o = JSON.parse(json);
  if (!o || typeof o.name !== "string") throw new Error("bad payload");
  return o;
}

async function importProfileFromString(code) {
  let o;
  try {
    o = decodeProfile(code);
  } catch (e) {
    toast(t("invalid_profile_code"), "error");
    return false;
  }
  let name = o.name || "Imported";
  let i = 2;
  while (profiles[name]) name = `${o.name} (${i++})`;
  showSpinner();
  try {
    profiles[name] = {
      wifi: Array.isArray(o.wifi) ? o.wifi : [],
      mobile: Array.isArray(o.mobile) ? o.mobile : [],
      domains: o.domains && typeof o.domains === "object" ? o.domains : {},
    };
    await saveProfiles();
    renderProfilesList();
    toast(t("profile_imported", name), "success");
    return true;
  } catch (error) {
    reportError(error);
    return false;
  } finally {
    hideSpinner();
  }
}

function openShareModal(name) {
  const ta = document.getElementById("share-text");
  const modal = document.getElementById("profile_share_modal");
  if (ta) ta.value = encodeProfile(name);
  if (modal) {
    document.documentElement.classList.add("modal-open");
    modal.showModal();
    ta?.select();
  }
}

function setupShareModal() {
  const modal = document.getElementById("profile_share_modal");
  const ta = document.getElementById("share-text");
  const copyBtn = document.getElementById("share-copy-btn");
  if (!modal || !ta || !copyBtn) return;
  copyBtn.addEventListener("click", async () => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(ta.value);
      else {
        ta.select();
        document.execCommand("copy");
      }
      toast(t("copied"), "success");
    } catch (e) {
      ta.select();
    }
  });
  modal.addEventListener("close", () => document.documentElement.classList.remove("modal-open"));
}

function openImportProfileModal() {
  const ta = document.getElementById("import-text");
  const modal = document.getElementById("profile_import_modal");
  if (ta) ta.value = "";
  renderImportPreview("");
  if (modal) {
    document.documentElement.classList.add("modal-open");
    modal.showModal();
    ta?.focus();
  }
}

// Feature 13 — decode the pasted code and show a preview of what it contains
// before the user confirms the import.
function renderImportPreview(code) {
  const box = document.getElementById("import-preview");
  const confirmBtn = document.getElementById("import-confirm-btn");
  if (!box) return;
  const text = String(code || "").trim();
  if (!text) {
    box.classList.add("hidden");
    box.innerHTML = "";
    if (confirmBtn) confirmBtn.disabled = false;
    return;
  }
  let o;
  try {
    o = decodeProfile(text);
  } catch (e) {
    box.classList.remove("hidden");
    box.innerHTML = `<p class="text-xs text-error">${t("invalid_profile_code")}</p>`;
    if (confirmBtn) confirmBtn.disabled = true;
    return;
  }
  const wifi = Array.isArray(o.wifi) ? o.wifi : [];
  const mobile = Array.isArray(o.mobile) ? o.mobile : [];
  const domainsMap = o.domains && typeof o.domains === "object" ? o.domains : {};
  const domainRules = Object.values(domainsMap).reduce(
    (n, arr) => n + (Array.isArray(arr) ? arr.length : 0),
    0,
  );
  const esc = (s) =>
    String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  box.classList.remove("hidden");
  box.innerHTML = `
    <p class="text-sm font-medium text-on-surface" data-testid="import-preview-name">${t("import_preview_name", esc(o.name))}</p>
    <p class="mt-1 text-xs text-on-surface-variant" data-testid="import-preview-wifi">${t("import_preview_wifi", wifi.length)}</p>
    <p class="text-xs text-on-surface-variant" data-testid="import-preview-mobile">${t("import_preview_mobile", mobile.length)}</p>
    <p class="text-xs text-on-surface-variant" data-testid="import-preview-domains">${t("import_preview_domains", domainRules)}</p>`;
  if (confirmBtn) confirmBtn.disabled = false;
}

function setupImportProfileModal() {
  const modal = document.getElementById("profile_import_modal");
  const ta = document.getElementById("import-text");
  const confirmBtn = document.getElementById("import-confirm-btn");
  const openBtn = document.getElementById("import-profile-btn");
  if (openBtn) openBtn.addEventListener("click", openImportProfileModal);
  if (!modal || !ta || !confirmBtn) return;
  ta.addEventListener("input", () => renderImportPreview(ta.value));
  confirmBtn.addEventListener("click", async () => {
    const ok = await importProfileFromString(ta.value);
    if (ok) {
      modal.close();
      document.documentElement.classList.remove("modal-open");
    }
  });
  modal.addEventListener("close", () => document.documentElement.classList.remove("modal-open"));
}

let renameTarget = "";
function openRenameModal(name) {
  renameTarget = name;
  const input = document.getElementById("rename-input");
  const modal = document.getElementById("profile_rename_modal");
  if (input) input.value = name;
  if (modal) {
    document.documentElement.classList.add("modal-open");
    modal.showModal();
    input?.focus();
  }
}

function setupRenameModal() {
  const modal = document.getElementById("profile_rename_modal");
  const input = document.getElementById("rename-input");
  const saveBtn = document.getElementById("rename-save-btn");
  if (!modal || !input || !saveBtn) return;

  const submit = async () => {
    const ok = await renameProfile(renameTarget, input.value);
    if (ok) {
      modal.close();
      document.documentElement.classList.remove("modal-open");
    }
  };
  saveBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
  modal.addEventListener("close", () => {
    document.documentElement.classList.remove("modal-open");
  });
}

function setupProfilesPage() {
  const createProfileBtn = document.getElementById("create-profile");
  const nameInput = document.getElementById("new-profile-name");

  const submit = async () => {
    const name = nameInput?.value.trim();
    if (!name) {
      toast(t("enter_profile_name"), "error");
      return;
    }
    if (profiles[name]) {
      toast(t("profile_exists"), "error");
      return;
    }
    await saveCurrentProfile(name);
    if (nameInput) nameInput.value = "";
  };

  createProfileBtn?.addEventListener("click", submit);
  nameInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
}

/* ============================================================================
 * Settings page
 * ==========================================================================*/

function updateIoTexts() {
  const mode = document.getElementById("io-mode-select")?.value;
  const pathLabel = document.getElementById("io-path-label");
  const pathDesc = document.getElementById("io-desc");
  if (!mode || !pathLabel || !pathDesc) return;

  if (mode === "export") {
    pathLabel.textContent = t("destination_path");
    pathDesc.textContent = t("export_desc");
  } else {
    pathLabel.textContent = t("source_path");
    pathDesc.textContent = t("import_desc");
  }
}

function setupImportExport() {
  const ioActionBtn = document.getElementById("io-action-btn");
  const ioModeSelect = document.getElementById("io-mode-select");
  if (!ioActionBtn || !ioModeSelect) return;

  ioModeSelect.addEventListener("change", updateIoTexts);
  updateIoTexts();

  ioActionBtn.addEventListener("click", async () => {
    const mode = ioModeSelect.value;
    const path = document.getElementById("io-path-input")?.value?.trim();

    if (!path) {
      toast(t("invalid_path"), "error");
      return;
    }

    showSpinner();
    try {
      if (mode === "export") {
        const exportResult = await exec(`cp ${profilesPath} ${shQuote(path)}`);
        if (exportResult.errno !== 0) {
          toast(`${t("export_failed")}: ${exportResult.stderr}`, "error");
          return;
        }
        await run(`chmod 644 ${shQuote(path)} || true`);
        toast(t("export_success"), "success");
      } else {
        await run(`[ -f ${profilesPath} ] && cp ${profilesPath} ${configDir}/old_profiles.json || true`);
        const importResult = await exec(`cp ${shQuote(path)} ${profilesPath}`);
        if (importResult.errno !== 0) {
          toast(`${t("import_failed")}: ${importResult.stderr}`, "error");
          return;
        }
        await run(`chmod 644 ${profilesPath} || true`);
        await loadProfiles();
        toast(t("import_success"), "success");
      }
    } catch (error) {
      if (!error?.handled) {
        const isExport = mode === "export";
        toast(`${t(isExport ? "export_failed" : "import_failed")}: ${error.message}`, "error");
      }
    } finally {
      hideSpinner();
    }
  });
}

function setupResetAll() {
  const resetBtn = document.getElementById("reset-all-btn");
  const modal = document.getElementById("confirm_reset_modal");
  const cancelBtn = document.getElementById("cancel-reset-btn");
  const confirmBtn = document.getElementById("confirm-reset-btn");
  if (!resetBtn || !modal || !cancelBtn || !confirmBtn) return;

  resetBtn.addEventListener("click", () => modal.showModal());
  cancelBtn.addEventListener("click", () => modal.close());

  confirmBtn.addEventListener("click", async () => {
    modal.close();
    showSpinner();
    try {
      await run("netswitch reset");
      appConfig = {};
      refreshAllRows();
      refreshAppsView();

      currentProfile = "";
      await persistDefaultKey("currentProfile", "");
      renderProfilesList();

      toast(t("settings_reset_success"), "success");
    } catch (error) {
      reportError(error);
    } finally {
      hideSpinner();
    }
  });
}

async function loadAboutInfo() {
  const el = document.getElementById("about-version");
  if (!el) return;
  try {
    const out = await run(`cat ${modulePropPath} 2>/dev/null || true`);
    const props = {};
    (out || "").split("\n").forEach((line) => {
      const idx = line.indexOf("=");
      if (idx > 0) props[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    });
    if (props.version) {
      el.textContent = t("about_version_label", props.version, props.versionCode || "");
    }
  } catch (error) {
    /* non-critical: leave placeholder text */
  }
}

function setupLanguageLabelSync() {
  const label = document.getElementById("current-language-label");
  if (!label) return;

  const allLanguages = { en: "English", ...languageNames };

  // Resolve synchronously from storage first so the label is correct even
  // if this runs before language.js dispatches its change event.
  try {
    const saved = localStorage.getItem("selectedLanguage") || "en";
    label.textContent = allLanguages[saved] || saved;
  } catch (e) {
    /* localStorage may be unavailable in some WebView sandboxes */
  }

  window.addEventListener("ns:languagechange", (e) => {
    if (e.detail?.label) label.textContent = e.detail.label;
  });
}

/* ============================================================================
 * Tab navigation
 * ==========================================================================*/

function switchTab(tab) {
  if (!TABS.includes(tab)) tab = "apps";

  TABS.forEach((name) => {
    document.getElementById(`page-${name}`)?.classList.toggle("hidden", name !== tab);
  });

  document.querySelectorAll(".nav-item").forEach((btn) => {
    if (btn.dataset.tab === tab) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  });

  try {
    localStorage.setItem("activeTab", tab);
  } catch (e) {
    /* localStorage may be unavailable in some WebView sandboxes */
  }
}

function setupTabs() {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  let initial = "apps";
  try {
    const saved = localStorage.getItem("activeTab");
    if (saved && TABS.includes(saved)) initial = saved;
  } catch (e) {
    /* ignore */
  }
  switchTab(initial);
}

/* ============================================================================
 * Bootstrap
 * ==========================================================================*/

document.addEventListener("DOMContentLoaded", async () => {
  setupTabs();
  setupSearch();
  setupFilterDropdown();
  setupSortDropdown();
  setupBulkActions();
  setupDomainModal();
  setupProfilesPage();
  setupRenameModal();
  setupShareModal();
  setupImportProfileModal();
  setupPresetModals();
  setupImportExport();
  setupResetAll();
  setupLanguageLabelSync();

  await Promise.all([loadProfiles(), loadApps(), loadDomainPresets()]);
  await loadPersistedProfile();
  await loadAboutInfo();
});
