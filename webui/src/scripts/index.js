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
    await loadProfile(cfg.currentProfile);
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
  const blockedVisible = [...appsList.children].filter(
    (n) => n.style.display !== "none" && n.dataset.blocked === "1",
  ).length;
  el.textContent = t("apps_page_subtitle", visibleCount, blockedVisible);
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
    domainCount.textContent = state.domains.length ? t("domains_count", state.domains.length) : "";
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
    toast(t("bulk_blocked", pkgs.length), "success");
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
    toast(t("bulk_unblocked", pkgs.length), "success");
  } catch (error) {
    reportError(error);
  } finally {
    hideSpinner();
  }
}

/** Fully clears the Wi-Fi/mobile block lists for every installed app (keeps custom domains). */
async function unblockEverything() {
  showSpinner();
  try {
    await run("netswitch set-wifi");
    await run("netswitch set-mobile");
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
    toast(t("domain_removed", entry), "success");
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
}

/* ============================================================================
 * Profiles page
 * ==========================================================================*/

function createProfileRow({ isNone, name, count, isActive }) {
  const row = document.createElement(isNone ? "button" : "div");
  row.className =
    "profile-row flex w-full items-center gap-3 rounded-2xl bg-surface-container-high p-3" +
    (isNone ? " text-left" : "");
  if (isNone) row.type = "button";

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
  subtitle.className = "truncate text-xs text-on-surface-variant";
  subtitle.textContent = isNone ? t("profile_none_desc") : t("profile_apps_count", count);
  textWrap.append(title, subtitle);

  if (isNone) {
    row.append(iconWrap, textWrap);
    if (isActive) {
      const check = document.createElement("i");
      check.className = "fas fa-circle-check text-sm text-primary";
      row.appendChild(check);
    }
    row.addEventListener("click", () => unblockEverything());
    return row;
  }

  const applyBtn = document.createElement("button");
  applyBtn.type = "button";
  applyBtn.className = "flex min-w-0 flex-1 items-center gap-3 text-left";
  applyBtn.append(iconWrap, textWrap);
  applyBtn.addEventListener("click", () => loadProfile(name));
  row.appendChild(applyBtn);

  if (isActive) {
    const check = document.createElement("i");
    check.className = "fas fa-circle-check mr-1 text-sm text-primary";
    row.appendChild(check);
  }

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className =
    "flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-error hover:bg-error-container/30";
  deleteBtn.setAttribute("aria-label", "Delete profile");
  const trashIcon = document.createElement("i");
  trashIcon.className = "fas fa-trash text-xs";
  deleteBtn.appendChild(trashIcon);
  deleteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    deleteProfile(name);
  });
  row.appendChild(deleteBtn);

  return row;
}

function renderProfilesList() {
  const container = document.getElementById("profiles-list");
  if (!container) return;
  container.innerHTML = "";

  container.appendChild(createProfileRow({ isNone: true, isActive: currentProfile === "" }));

  Object.keys(profiles).forEach((name) => {
    const profile = profiles[name];
    const count = (profile?.wifi?.length || 0) + (profile?.mobile?.length || 0);
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

    appConfig = await fetchConfig();
    refreshAllRows();
    refreshAppsView();

    currentProfile = profileName;
    await persistDefaultKey("currentProfile", currentProfile);
    renderProfilesList();

    toast(t("profile_activated", profileName, wifiPkgs.length + mobilePkgs.length), "success");
  } catch (error) {
    reportError(error);
  } finally {
    hideSpinner();
  }
}

function collectCurrentSelection() {
  const wifi = [];
  const mobile = [];
  Object.entries(appConfig).forEach(([pkg, state]) => {
    if (state.wifi) wifi.push(pkg);
    if (state.mobile) mobile.push(pkg);
  });
  return { wifi, mobile };
}

async function saveCurrentProfile(profileName) {
  showSpinner();
  try {
    profiles[profileName] = collectCurrentSelection();
    await saveProfiles();
    currentProfile = profileName;
    await persistDefaultKey("currentProfile", currentProfile);
    renderProfilesList();

    const total = profiles[profileName].wifi.length + profiles[profileName].mobile.length;
    toast(t("profile_created", profileName, total), "success");
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
  setupImportExport();
  setupResetAll();
  setupLanguageLabelSync();

  await Promise.all([loadProfiles(), loadApps()]);
  await loadPersistedProfile();
  await loadAboutInfo();
});
