import { exec, toast } from "kernelsu";
import "./language.js";
import "@fortawesome/fontawesome-free/css/all.min.css";

const template = document.getElementById("app-template").content;
const appsList = document.getElementById("apps-list");

const configDir = "/data/adb/.config/net-switch";
const profilesPath = `${configDir}/profiles.json`;
const defaultConfigPath = `${configDir}/default.json`;

let profiles = {};
let currentProfile = "";
let installedPackages = new Set();
let appConfig = {};
let currentDomainPkg = "";

function t(key, ...args) {
  return typeof getTranslation === "function" ? getTranslation(key, ...args) : key;
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function run(cmd) {
  const { errno, stdout, stderr } = await exec(cmd);
  if (errno !== 0) {
    toast(t("stderr_error", stderr));
    return undefined;
  }
  return stdout;
}

function showSpinner() {
  document.getElementById("loading-spinner")?.classList.remove("hidden");
}

function hideSpinner() {
  document.getElementById("loading-spinner")?.classList.add("hidden");
}

async function fetchConfig() {
  const out = await run("netswitch list --json");
  try {
    return out ? JSON.parse(out) : {};
  } catch (e) {
    return {};
  }
}

function emptyState() {
  return { wifi: false, mobile: false, domains: [] };
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
  } catch (e) { }
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
    const profileSelect = document.getElementById("profile-select");
    if (profileSelect) profileSelect.value = cfg.currentProfile;
  }
}

function sortChecked() {
  [...appsList.children]
    .sort((a, b) => Number(b.dataset.blocked) - Number(a.dataset.blocked))
    .forEach((node) => appsList.appendChild(node));
}

function updateAppRow(el, pkg) {
  const state = appConfig[pkg] || emptyState();
  const wifiToggle = el.querySelector(".ns-toggle-wifi");
  const mobileToggle = el.querySelector(".ns-toggle-mobile");
  const domainCount = el.querySelector(".app-domain-count");

  if (wifiToggle) wifiToggle.checked = !!state.wifi;
  if (mobileToggle) mobileToggle.checked = !!state.mobile;
  if (domainCount) {
    domainCount.textContent = state.domains.length
      ? t("domains_count", state.domains.length)
      : "";
  }

  el.dataset.blocked = state.wifi || state.mobile || state.domains.length ? "1" : "0";
}

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

async function addDomain(pkg, entry) {
  if (!entry) return;
  showSpinner();
  try {
    await run(`netswitch domain-add ${shQuote(pkg)} ${shQuote(entry)}`);
    await refreshDomainsFor(pkg);
    renderDomainChips(pkg);
    const row = appsList.querySelector(`[data-pkg="${CSS.escape(pkg)}"]`);
    if (row) updateAppRow(row, pkg);
    toast(t("domain_added", entry), "success");
  } catch (e) {
    toast(t("operation_error"), "error");
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
    const row = appsList.querySelector(`[data-pkg="${CSS.escape(pkg)}"]`);
    if (row) updateAppRow(row, pkg);
    toast(t("domain_removed", entry), "success");
  } catch (e) {
    toast(t("operation_error"), "error");
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

function populateApp(pkg) {
  const frag = document.importNode(template, true);
  const el = frag.firstElementChild;
  if (!el) return;

  el.dataset.pkg = pkg;

  const nameElement = el.querySelector("p.truncate");
  if (nameElement) nameElement.textContent = pkg;

  const iconBtn = el.querySelector(".app-icon");
  if (iconBtn) {
    iconBtn.textContent = pkg.replace(/^[^a-zA-Z]*/, "").charAt(0).toUpperCase() || "?";
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
        sortChecked();
        toast(t("operation_completed"), "success");
      } catch (error) {
        toggle.checked = previous;
        updateAppRow(el, pkg);
        toast(t("operation_error"), "error");
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

async function loadProfiles() {
  try {
    const profilesData = await run(`cat ${profilesPath} 2>/dev/null || echo '{}'`);
    profiles = profilesData ? JSON.parse(profilesData) : {};
    updateProfileSelect();
  } catch (error) {
    profiles = {};
  }
}

async function saveProfiles() {
  await run(`echo ${shQuote(JSON.stringify(profiles))} > ${profilesPath}`);
}

function updateProfileSelect() {
  const profileSelect = document.getElementById("profile-select");
  if (!profileSelect) return;

  profileSelect.innerHTML = "";

  const placeholderOption = document.createElement("option");
  placeholderOption.value = "";
  placeholderOption.textContent = t("select_profile");
  profileSelect.appendChild(placeholderOption);

  Object.keys(profiles).forEach((profileName) => {
    const option = document.createElement("option");
    option.value = profileName;
    const count = (profiles[profileName]?.wifi?.length || 0) + (profiles[profileName]?.mobile?.length || 0);
    option.textContent = `${profileName} (${count})`;
    if (profileName === currentProfile) option.selected = true;
    profileSelect.appendChild(option);
  });
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
    [...appsList.children].forEach((node) => updateAppRow(node, node.dataset.pkg));
    sortChecked();

    currentProfile = profileName;
    await persistDefaultKey("currentProfile", currentProfile);

    toast(t("profile_activated", profileName, wifiPkgs.length + mobilePkgs.length), "success");
  } catch (error) {
    toast(t("operation_error"), "error");
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
  profiles[profileName] = collectCurrentSelection();
  await saveProfiles();
  currentProfile = profileName;
  updateProfileSelect();
  await persistDefaultKey("currentProfile", currentProfile);

  const total = profiles[profileName].wifi.length + profiles[profileName].mobile.length;
  toast(t("profile_created", profileName, total), "success");
}

async function deleteProfile(profileName) {
  if (!profileName) {
    toast(t("invalid_profile_name"), "error");
    return;
  }

  delete profiles[profileName];
  await saveProfiles();

  if (currentProfile === profileName) {
    currentProfile = "";
    await persistDefaultKey("currentProfile", "");
  }

  updateProfileSelect();
  toast(t("profile_deleted", profileName), "success");
}

async function loadApps() {
  showSpinner();
  try {
    const packages = await run("pm list packages | cut -d: -f2 | sort");
    if (!packages) return;

    installedPackages = new Set(packages.split("\n").filter(Boolean));
    appConfig = await fetchConfig();

    appsList.innerHTML = "";
    for (const pkg of installedPackages) {
      populateApp(pkg);
    }
    sortChecked();
  } catch (error) {
    toast(t("operation_error"), "error");
  } finally {
    hideSpinner();
  }
}

async function connectAllApps() {
  showSpinner();
  try {
    await run("netswitch set-wifi");
    await run("netswitch set-mobile");
    appConfig = await fetchConfig();
    [...appsList.children].forEach((node) => updateAppRow(node, node.dataset.pkg));
    sortChecked();

    currentProfile = "";
    await persistDefaultKey("currentProfile", "");
    updateProfileSelect();

    toast(t("all_apps_connected"), "success");
  } catch (error) {
    toast(t("operation_error"), "error");
  } finally {
    hideSpinner();
  }
}

function setupSearch() {
  const searchInput = document.getElementById("search");
  if (!searchInput) return;

  searchInput.addEventListener("input", (e) => {
    const query = e.target.value.toLowerCase();
    [...appsList.children].forEach((node) => {
      const appName = node.querySelector("p.truncate")?.textContent?.toLowerCase();
      const matches = !query || (appName && appName.includes(query));
      node.style.display = matches ? "" : "none";
    });
  });
}

function updateIoTexts() {
  const mode = document.getElementById("io-mode-select")?.value;
  const pathLabel = document.getElementById("io-path-label");
  const pathDesc = document.getElementById("io-desc");
  const actionBtn = document.getElementById("io-action-btn");

  if (!mode || !pathLabel || !pathDesc || !actionBtn) return;

  if (mode === "export") {
    pathLabel.textContent = t("destination_path");
    pathDesc.textContent = t("export_desc");
  } else {
    pathLabel.textContent = t("source_path");
    pathDesc.textContent = t("import_desc");
  }
  actionBtn.textContent = t("run");
}

function setupImportExport() {
  const openIoBtn = document.getElementById("open-io-page");
  const ioBackBtn = document.getElementById("io-back-btn");
  const ioActionBtn = document.getElementById("io-action-btn");
  const ioModeSelect = document.getElementById("io-mode-select");
  const homePage = document.getElementById("home-page");
  const ioPage = document.getElementById("io-page");

  if (!openIoBtn || !ioBackBtn || !ioActionBtn || !ioModeSelect || !homePage || !ioPage) return;

  openIoBtn.addEventListener("click", () => {
    homePage.classList.add("hidden");
    ioPage.classList.remove("hidden");
    updateIoTexts();
  });

  ioBackBtn.addEventListener("click", () => {
    ioPage.classList.add("hidden");
    homePage.classList.remove("hidden");
  });

  ioModeSelect.addEventListener("change", updateIoTexts);

  ioActionBtn.addEventListener("click", async () => {
    const mode = ioModeSelect.value;
    const path = document.getElementById("io-path-input")?.value?.trim();

    if (!path) {
      toast(t("invalid_path"), "error");
      return;
    }

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
      const isExport = mode === "export";
      toast(`${t(isExport ? "export_failed" : "import_failed")}: ${error.message}`, "error");
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadProfiles();
  await loadApps();
  await loadPersistedProfile();
  setupSearch();
  setupImportExport();
  setupDomainModal();

  document.getElementById("connect-all")?.addEventListener("click", connectAllApps);

  const profileSelect = document.getElementById("profile-select");
  const createProfileBtn = document.getElementById("create-profile");
  const deleteProfileBtn = document.getElementById("delete-profile");

  profileSelect?.addEventListener("change", (e) => {
    if (e.target.value) {
      loadProfile(e.target.value);
    } else {
      connectAllApps();
    }
  });

  createProfileBtn?.addEventListener("click", async () => {
    const nameInput = document.getElementById("new-profile-name");
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
  });

  deleteProfileBtn?.addEventListener("click", async (e) => {
    e.preventDefault();
    const selectedProfile = document.getElementById("profile-select").value;
    const profileToDelete = selectedProfile || currentProfile;

    if (!profileToDelete) {
      toast(t("select_profile_to_delete"), "error");
      return;
    }
    await deleteProfile(profileToDelete);
  });
});
