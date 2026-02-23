// ==UserScript==
// @name         SNA4 Takt Time Study Timer
// @namespace    http://tampermonkey.net/
// @version      11.0
// @description  Floating time study timer with associate management, SharePoint sync, and daily history
// @match        https://ramdos.org/*
// @match        https://fclm-portal.amazon.com/*
// @grant        GM_xmlhttpRequest
// @connect      amazon.sharepoint.com
// @updateURL    https://raw.githubusercontent.com/Srinivas524/sna4-takt-timer/main/sna4-takt-timer.user.js
// @downloadURL  https://raw.githubusercontent.com/Srinivas524/sna4-takt-timer/main/sna4-takt-timer.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════
  // SHAREPOINT API
  // ═══════════════════════════════════════════════════════
  const SP_SITE    = 'https://amazon.sharepoint.com/sites/TackAnalysis';
  const SP_LIST_ID = '6d9d4699-61ad-417b-aada-47f937d71754';
  const SP_API     = `${SP_SITE}/_api/web/lists(guid'${SP_LIST_ID}')`;

  const CURRENT_VERSION = '11.0';
  const INSTALL_URL = 'https://raw.githubusercontent.com/Srinivas524/sna4-takt-timer/main/sna4-takt-timer.user.js';

  function getDigest() {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: `${SP_SITE}/_api/contextinfo`,
        headers: { 'Accept': 'application/json;odata=verbose', 'Content-Type': 'application/json;odata=verbose' },
        onload: (res) => {
          try { resolve(JSON.parse(res.responseText).d.GetContextWebInformation.FormDigestValue); }
          catch (e) { reject(e); }
        },
        onerror: (err) => reject(err)
      });
    });
  }

  function spGet() {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: `${SP_API}/items?$select=Id,Title,DataValue`,
        headers: { 'Accept': 'application/json;odata=verbose' },
        onload: (res) => {
          try { resolve(JSON.parse(res.responseText).d.results); }
          catch (e) { reject(e); }
        },
        onerror: (err) => reject(err)
      });
    });
  }

  function spPost(digest, title, value) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: `${SP_API}/items`,
        headers: {
          'Accept': 'application/json;odata=verbose',
          'Content-Type': 'application/json;odata=verbose',
          'X-RequestDigest': digest
        },
        data: JSON.stringify({
          '__metadata': { 'type': 'SP.Data.TaktTimerDataListItem' },
          'Title': title,
          'DataValue': value
        }),
        onload: (res) => { try { resolve(JSON.parse(res.responseText)); } catch (e) { reject(e); } },
        onerror: (err) => reject(err)
      });
    });
  }

  function spPatch(digest, itemId, value) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: `${SP_API}/items(${itemId})`,
        headers: {
          'Accept': 'application/json;odata=verbose',
          'Content-Type': 'application/json;odata=verbose',
          'X-RequestDigest': digest,
          'X-HTTP-Method': 'MERGE',
          'If-Match': '*'
        },
        data: JSON.stringify({
          '__metadata': { 'type': 'SP.Data.TaktTimerDataListItem' },
          'DataValue': value
        }),
        onload: (res) => resolve(res),
        onerror: (err) => reject(err)
      });
    });
  }

  function checkForUpdate() {
    spGet().then((items) => {
      const versionRow = items.find(i => i.Title === 'latestVersion');
      if (!versionRow || !versionRow.DataValue) return;
      const latest = versionRow.DataValue.toString().trim();
      if (latest === CURRENT_VERSION.toString().trim()) { localStorage.removeItem('sna4_dismissed_version'); return; }
      const dismissed = localStorage.getItem('sna4_dismissed_version');
      if (dismissed === latest) return;
      showUpdateBanner(latest);
    }).catch(() => {});
  }

  function showUpdateBanner(latestVersion) {
    if (document.getElementById('takt-update-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'takt-update-banner';
    banner.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:9999999;background:linear-gradient(135deg,#f59e0b,#d97706);color:white;font-family:'Inter',sans-serif;display:flex;align-items:center;justify-content:center;gap:12px;padding:10px 24px;font-size:13px;font-weight:700;box-shadow:0 4px 20px rgba(245,158,11,0.4);cursor:pointer;`;
    banner.innerHTML = `<span>🚀 New version available (v${latestVersion}) — click here to update</span><span style="background:rgba(255,255,255,0.25);padding:3px 12px;border-radius:6px;font-size:11px;">Click to Install</span><span id="takt-banner-close" style="margin-left:8px;opacity:0.7;font-size:16px;cursor:pointer;">✕</span>`;
    document.body.appendChild(banner);
    banner.onclick = (e) => {
      if (e.target.id === 'takt-banner-close') { localStorage.setItem('sna4_dismissed_version', latestVersion); banner.remove(); return; }
      window.open(INSTALL_URL, '_blank');
    };
  }

  // ═══════════════════════════════════════════════════════
  // DATE HELPERS
  // ═══════════════════════════════════════════════════════
  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  function formatDateDisplay(key) {
    if (!key) return '';
    const [y, m, d] = key.split('-');
    const date = new Date(parseInt(y), parseInt(m)-1, parseInt(d));
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }

  // ═══════════════════════════════════════════════════════
  // PROCESS PATH CONFIGURATION
  // ═══════════════════════════════════════════════════════
  function buildPickTasks(read, locate, move, drive) {
    const tasks = [
      { name: "Read the scanner", target: read },
      { name: "Time to locate item in bin", target: locate },
      { name: "Move item from bin to cage", target: move },
      { name: "Drive time from bin to bin", target: drive }
    ];
    return { tasks, totalTarget: read + locate + move + drive };
  }

  function buildPackTasks(t1,t2,t3,t4,t5,t6,t7,t8,t9) {
    const allTasks = [
      { name: "Scan cage", target: t1 },
      { name: "Scan item / move item to station", target: t2 },
      { name: "Read screen", target: t3 },
      { name: "Build box / tape if applicable", target: t4 },
      { name: "Place item into box", target: t5 },
      { name: "P-Slip / labels", target: t6 },
      { name: "Dunnage", target: t7 },
      { name: "Scan / add SPOO", target: t8 },
      { name: "Push item onto conveyor", target: t9 }
    ];
    const tasks = allTasks.filter(t => t.target > 0);
    return { tasks, totalTarget: tasks.reduce((a,t) => a+t.target, 0) };
  }

  function buildStowTasks(locate, openNet, grab, stow, confirm, drive) {
    const tasks = [
      { name: "Time to locate bin", target: locate },
      { name: "Open cage netting", target: openNet },
      { name: "Grab item from cage", target: grab },
      { name: "Stow unit into bin", target: stow },
      { name: "Confirm stow on scanner", target: confirm },
      { name: "Drive time from bin to bin", target: drive }
    ];
    return { tasks, totalTarget: locate + openNet + grab + stow + confirm + drive };
  }

  function buildDockTasks() {
    const tasks = [
      { name: "Scan item on conveyor", target: 6 },
      { name: "Finding the accurate Gocart", target: 12 },
      { name: "Placing item in Gocart", target: 6 }
    ];
    return { tasks, totalTarget: 24, dockNote: '⚠ Includes possible waterspider @ 100 UPH' };
  }

  const NUM_OBS = 5;

  const PROCESS_PATHS = {
    "Pick": {
      "Singles":    buildPickTasks(10, 10, 12, 120),
      "VNA 1":      buildPickTasks(10, 8,  8,  60),
      "VNA 2":      buildPickTasks(10, 8,  12, 120),
      "Noncon/Bod": buildPickTasks(10, 8,  15, 180),
      "Multi":      buildPickTasks(10, 8,  8,  180)
    },
    "Pack": {
      "Singles/VNA": buildPackTasks(3,5,9,20,9,9,12,5,3),
      "Multies":     buildPackTasks(3,5,3,27,9,5,14,3,5),
      "BOD/Noncon":  buildPackTasks(6,4,8,0,0,5,0,5,5)
    },
    "Dock": { "_default": buildDockTasks() },
    "Stow": { "_default": buildStowTasks(60,3,5,5,2,120) }
  };

  function hasSubPaths(process) {
    const subs = Object.keys(PROCESS_PATHS[process]);
    return !(subs.length === 1 && subs[0] === '_default');
  }

  // ═══════════════════════════════════════════════════════
  // DATA & STATE
  // ═══════════════════════════════════════════════════════
  const STORAGE_KEY = 'sna4_takt_time_study_v11';
  const firstProcess = Object.keys(PROCESS_PATHS)[0];
  const firstSub = Object.keys(PROCESS_PATHS[firstProcess])[0];

  // Associate structure:
  // {
  //   id, name, login, role, coachingNotes,
  //   history: {
  //     "2026-02-23": {
  //       "Pick__Singles": { 1: {startTime, endTime, tasks[], total}, ... }
  //     }
  //   }
  // }

  let appData = { auditorName: '', auditorLogin: '', associates: [] };

  let state = {
    isOpen: false,
    view: 'summary',           // 'summary' | 'table' | 'history'
    selectedProcess: firstProcess,
    selectedSubProcess: firstSub,
    selectedObs: null,
    isRunning: false,
    currentTaskIndex: -1,
    lastClickTime: null,
    elapsedInterval: null,
    isDragging: false,
    dragOffset: { x: 0, y: 0 },
    currentAssociateIndex: -1,
    showAssociateSearch: false,
    associateSearchQuery: '',
    showAddForm: false,
    syncStatus: 'idle',
    lastSynced: null,
    coachingExpanded: false,
    historySelectedDate: null   // for history view
  };

  // ═══════════════════════════════════════════════════════
  // DAILY ARCHIVE — runs on load
  // ═══════════════════════════════════════════════════════
  function archivePastDays() {
    const today = todayKey();
    // For each associate, ensure their today slot exists and old "current" data
    // (stored under legacy key observationStore) gets migrated to history
    appData.associates.forEach(assoc => {
      // Migrate legacy observationStore → history
      if (assoc.observationStore && Object.keys(assoc.observationStore).length > 0) {
        if (!assoc.history) assoc.history = {};
        // Find what date to put it under — use today if we can't tell
        const migrateDate = assoc.lastSessionDate || today;
        if (!assoc.history[migrateDate]) assoc.history[migrateDate] = {};
        Object.entries(assoc.observationStore).forEach(([key, obsSet]) => {
          // Only migrate if there's actual data
          const hasData = Object.values(obsSet).some(o => o.total !== null || o.tasks.length > 0);
          if (hasData) assoc.history[migrateDate][key] = obsSet;
        });
        delete assoc.observationStore;
      }

      if (!assoc.history) assoc.history = {};
      // Ensure today's slot exists for all process/sub combos
      if (!assoc.history[today]) assoc.history[today] = {};
    });
  }

  // ═══════════════════════════════════════════════════════
  // PERSISTENCE
  // ═══════════════════════════════════════════════════════
  function saveAuditorLocally() {
    try { localStorage.setItem('sna4_auditor', JSON.stringify({ auditorName: appData.auditorName, auditorLogin: appData.auditorLogin })); }
    catch (e) { console.warn('Auditor local save failed:', e); }
  }

  function loadAuditorLocally() {
    try {
      const raw = localStorage.getItem('sna4_auditor');
      if (raw) { const p = JSON.parse(raw); appData.auditorName = p.auditorName || ''; appData.auditorLogin = p.auditorLogin || ''; }
    } catch (e) { console.warn('Auditor local load failed:', e); }
  }

  function saveData() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(appData)); }
    catch (e) { console.warn('Local save failed:', e); }
    syncToSheets();
  }

  function loadData() {
    loadAuditorLocally();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.associates) appData.associates = parsed.associates;
        if (appData.associates.length > 0) state.currentAssociateIndex = 0;
      }
    } catch (e) { console.warn('Local load failed:', e); }

    archivePastDays();
    syncFromSheets();
  }

  function syncToSheets() {
    state.syncStatus = 'syncing';
    updateSyncBadge();
    const value = JSON.stringify({ associates: appData.associates });
    getDigest()
      .then(digest => spGet().then(items => ({ digest, items })))
      .then(({ digest, items }) => {
        const existing = items.find(i => i.Title === 'appData');
        return existing ? spPatch(digest, existing.Id, value) : spPost(digest, 'appData', value);
      })
      .then(() => { state.syncStatus = 'synced'; state.lastSynced = new Date().toLocaleTimeString(); updateSyncBadge(); })
      .catch((err) => { console.warn('SharePoint sync failed:', err); state.syncStatus = 'error'; updateSyncBadge(); });
  }

  function syncFromSheets() {
    state.syncStatus = 'syncing';
    updateSyncBadge();
    spGet()
      .then((items) => {
        const appDataRow = items.find(i => i.Title === 'appData');
        if (appDataRow && appDataRow.DataValue) {
          const parsed = JSON.parse(appDataRow.DataValue);
          if (parsed && parsed.associates && parsed.associates.length > 0) {
            appData.associates = parsed.associates;
            archivePastDays();
            localStorage.setItem(STORAGE_KEY, JSON.stringify(appData));
            if (appData.associates.length > 0 && state.currentAssociateIndex < 0) state.currentAssociateIndex = 0;
          }
        }
        state.syncStatus = 'synced';
        state.lastSynced = new Date().toLocaleTimeString();
        updateSyncBadge();
        if (state.isOpen) renderPanel();
      })
      .catch((err) => { console.warn('SharePoint fetch failed:', err); state.syncStatus = 'error'; updateSyncBadge(); });
  }

  function updateSyncBadge() {
    const badge = document.getElementById('takt-sync-badge');
    if (!badge) return;
    if (state.syncStatus === 'syncing') { badge.textContent = '⟳ Syncing...'; badge.style.background = '#fde68a'; badge.style.color = '#92400e'; }
    else if (state.syncStatus === 'synced') { badge.textContent = `✓ Synced ${state.lastSynced||''}`; badge.style.background = '#dcfce7'; badge.style.color = '#16a34a'; }
    else if (state.syncStatus === 'error') { badge.textContent = '⚠ Offline — local only'; badge.style.background = '#fee2e2'; badge.style.color = '#dc2626'; }
  }

  // ═══════════════════════════════════════════════════════
  // ASSOCIATE & OBSERVATION HELPERS
  // ═══════════════════════════════════════════════════════
  function getCurrentAssociate() {
    if (state.currentAssociateIndex >= 0 && state.currentAssociateIndex < appData.associates.length)
      return appData.associates[state.currentAssociateIndex];
    return null;
  }

  function storeKey() { return `${state.selectedProcess}__${state.selectedSubProcess}`; }

  function getTodayObs(assoc) {
    const today = todayKey();
    if (!assoc.history) assoc.history = {};
    if (!assoc.history[today]) assoc.history[today] = {};
    const key = storeKey();
    if (!assoc.history[today][key]) {
      assoc.history[today][key] = {};
      for (let i = 1; i <= NUM_OBS; i++)
        assoc.history[today][key][i] = { startTime: null, endTime: null, tasks: [], total: null };
    }
    return assoc.history[today][key];
  }

  function ensureObservations() {
    const assoc = getCurrentAssociate();
    if (!assoc) return null;
    return getTodayObs(assoc);
  }

  function getObs() { return ensureObservations(); }
  function getConfig() { return PROCESS_PATHS[state.selectedProcess][state.selectedSubProcess]; }

  function getDisplaySubProcess() {
    if (!hasSubPaths(state.selectedProcess)) return null;
    return state.selectedSubProcess;
  }

  function addAssociate(name, login) {
    const duplicate = appData.associates.find(a => a.login.toLowerCase() === login.trim().toLowerCase());
    if (duplicate) { showToast(`⚠ Login "${login.trim()}" already exists as ${duplicate.name}`); return false; }
    if (name.trim().toLowerCase() === appData.auditorName.toLowerCase() && appData.auditorName)
      showToast(`⚠ Warning: Associate name matches auditor name!`);
    const assoc = {
      id: Date.now(),
      name: name.trim(),
      login: login.trim(),
      role: 'associate',
      coachingNotes: '',
      history: {}
    };
    // Initialize today
    assoc.history[todayKey()] = {};
    appData.associates.push(assoc);
    state.currentAssociateIndex = appData.associates.length - 1;
    state.selectedObs = null;
    state.showAddForm = false;
    state.showAssociateSearch = false;
    saveData();
    return true;
  }

  function navigateAssociate(direction) {
    if (state.isRunning) return;
    const len = appData.associates.length;
    if (len === 0) return;
    state.currentAssociateIndex = (state.currentAssociateIndex + direction + len) % len;
    state.selectedObs = null;
    state.view = 'summary';
    renderPanel();
  }

  // ═══════════════════════════════════════════════════════
  // HISTORY / ANALYTICS HELPERS
  // ═══════════════════════════════════════════════════════
  function getAssociateDates(assoc) {
    if (!assoc || !assoc.history) return [];
    return Object.keys(assoc.history).sort((a, b) => b.localeCompare(a)); // newest first
  }

  function computeDayAverages(assoc, dateKey) {
    const dayData = assoc.history[dateKey];
    if (!dayData) return {};
    const result = {};

    Object.entries(dayData).forEach(([key, obsSet]) => {
      const [process, sub] = key.split('__');
      const config = PROCESS_PATHS[process] && PROCESS_PATHS[process][sub];
      if (!config) return;

      const completedObs = Object.values(obsSet).filter(o => o.total !== null);
      if (completedObs.length === 0) return;

      // Task averages
      const taskAvgs = config.tasks.map((task, idx) => {
        const vals = completedObs.map(o => o.tasks[idx]).filter(v => v !== undefined);
        return vals.length > 0 ? Math.round(vals.reduce((a,b) => a+b, 0) / vals.length) : null;
      });

      // Total average
      const totalAvg = Math.round(completedObs.reduce((a,o) => a+o.total, 0) / completedObs.length);
      const target = config.totalTarget;

      result[key] = {
        process,
        sub: sub === '_default' ? process : sub,
        obsCount: completedObs.length,
        taskAverages: taskAvgs,
        totalAvg,
        target,
        vsTarget: target > 0 ? totalAvg - target : null
      };
    });

    return result;
  }

  function computeOverallAverages(assoc) {
    if (!assoc || !assoc.history) return {};
    const allKeyData = {}; // key → [totals]

    Object.entries(assoc.history).forEach(([date, dayData]) => {
      Object.entries(dayData).forEach(([key, obsSet]) => {
        if (!allKeyData[key]) allKeyData[key] = { totals: [], taskTotals: {}, dates: [] };
        const completedObs = Object.values(obsSet).filter(o => o.total !== null);
        completedObs.forEach(o => {
          allKeyData[key].totals.push(o.total);
          allKeyData[key].dates.push(date);
          o.tasks.forEach((t, idx) => {
            if (!allKeyData[key].taskTotals[idx]) allKeyData[key].taskTotals[idx] = [];
            allKeyData[key].taskTotals[idx].push(t);
          });
        });
      });
    });

    const result = {};
    Object.entries(allKeyData).forEach(([key, data]) => {
      const [process, sub] = key.split('__');
      const config = PROCESS_PATHS[process] && PROCESS_PATHS[process][sub];
      if (!config || data.totals.length === 0) return;

      const taskAvgs = config.tasks.map((_, idx) => {
        const vals = data.taskTotals[idx] || [];
        return vals.length > 0 ? Math.round(vals.reduce((a,b) => a+b, 0) / vals.length) : null;
      });

      const totalAvg = Math.round(data.totals.reduce((a,b) => a+b, 0) / data.totals.length);
      result[key] = {
        process,
        sub: sub === '_default' ? process : sub,
        totalObsCount: data.totals.length,
        daysObserved: [...new Set(data.dates)].length,
        taskAverages: taskAvgs,
        totalAvg,
        target: config.totalTarget,
        vsTarget: config.totalTarget > 0 ? totalAvg - config.totalTarget : null
      };
    });

    return result;
  }

  // ═══════════════════════════════════════════════════════
  // STYLES
  // ═══════════════════════════════════════════════════════
  const styles = document.createElement('style');
  styles.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');

    #takt-fab {
      position:fixed;bottom:30px;right:30px;width:60px;height:60px;border-radius:16px;
      background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%);
      box-shadow:0 4px 20px rgba(99,102,241,0.4);cursor:pointer;z-index:999999;
      display:flex;align-items:center;justify-content:center;
      transition:all 0.3s cubic-bezier(0.4,0,0.2,1);border:none;outline:none;
    }
    #takt-fab:hover{transform:scale(1.08) translateY(-2px);box-shadow:0 8px 30px rgba(99,102,241,0.5);}
    #takt-fab.active{background:linear-gradient(135deg,#ef4444 0%,#dc2626 100%);box-shadow:0 4px 20px rgba(239,68,68,0.4);animation:fab-pulse 2s infinite;}
    @keyframes fab-pulse{0%,100%{box-shadow:0 4px 20px rgba(239,68,68,0.4),0 0 0 0 rgba(239,68,68,0.3);}50%{box-shadow:0 4px 20px rgba(239,68,68,0.4),0 0 0 12px rgba(239,68,68,0);}}
    #takt-fab svg{width:28px;height:28px;fill:white;}
    #takt-badge{position:absolute;top:-6px;right:-6px;background:#22c55e;color:white;font-size:11px;font-weight:800;width:22px;height:22px;border-radius:50%;display:none;align-items:center;justify-content:center;font-family:'Inter',sans-serif;border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.15);}

    #takt-panel{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) scale(0);width:min(1350px,96vw);height:94vh;background:#ffffff;border-radius:20px;box-shadow:0 25px 80px rgba(0,0,0,0.15),0 0 0 1px rgba(0,0,0,0.05);z-index:999998;font-family:'Inter',sans-serif;overflow:hidden;display:flex;flex-direction:column;transition:all 0.35s cubic-bezier(0.4,0,0.2,1);opacity:0;}
    #takt-panel.open{transform:translate(-50%,-50%) scale(1);opacity:1;}

    #takt-backdrop{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(15,23,42,0.2);backdrop-filter:blur(4px);z-index:999997;opacity:0;transition:opacity 0.3s;pointer-events:none;}
    #takt-backdrop.open{opacity:1;pointer-events:all;}

    .takt-header{background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 50%,#a78bfa 100%);padding:14px 24px;display:flex;align-items:center;justify-content:space-between;cursor:move;user-select:none;flex-shrink:0;}
    .takt-header-left{display:flex;align-items:center;gap:12px;}
    .takt-header-icon{width:38px;height:38px;background:rgba(255,255,255,0.2);border-radius:10px;display:flex;align-items:center;justify-content:center;}
    .takt-header-icon svg{width:20px;height:20px;fill:white;}
    .takt-header-title{color:white;font-size:16px;font-weight:800;letter-spacing:-0.3px;}
    .takt-header-subtitle{color:rgba(255,255,255,0.75);font-size:11px;font-weight:500;margin-top:1px;}
    .takt-header-actions{display:flex;gap:8px;align-items:center;}
    .takt-header-btn{width:32px;height:32px;border-radius:8px;background:rgba(255,255,255,0.15);border:none;color:white;font-size:15px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.2s;}
    .takt-header-btn:hover{background:rgba(255,255,255,0.3);}

    .takt-sync-bar{display:flex;align-items:center;justify-content:space-between;padding:5px 24px;background:#f8fafc;border-bottom:1px solid #e2e8f0;flex-shrink:0;}
    #takt-sync-badge{padding:3px 10px;border-radius:6px;font-size:11px;font-weight:700;font-family:'Inter',sans-serif;transition:all 0.3s;}
    .takt-sync-refresh{padding:3px 10px;border-radius:6px;border:1.5px solid #e2e8f0;background:white;color:#6366f1;font-size:11px;font-weight:700;cursor:pointer;font-family:'Inter',sans-serif;transition:all 0.2s;}
    .takt-sync-refresh:hover{background:#eef2ff;border-color:#6366f1;}

    .takt-auditor-bar{display:flex;align-items:center;gap:16px;padding:8px 24px;background:#fefce8;border-bottom:2px solid #fde68a;flex-shrink:0;flex-wrap:wrap;}
    .takt-auditor-group{display:flex;align-items:center;gap:6px;}
    .takt-auditor-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:#a16207;}
    .takt-auditor-input{padding:5px 10px;border-radius:6px;border:1.5px solid #fde68a;background:white;color:#1e293b;font-size:12px;font-weight:600;font-family:'Inter',sans-serif;outline:none;width:160px;transition:all 0.2s;}
    .takt-auditor-input:focus{border-color:#f59e0b;box-shadow:0 0 0 3px rgba(245,158,11,0.15);}
    .takt-auditor-input::placeholder{color:#d4a574;}

    .takt-associate-bar{display:flex;align-items:center;gap:10px;padding:10px 24px;background:linear-gradient(135deg,#ecfdf5,#f0fdf4);border-bottom:2px solid #86efac;flex-shrink:0;position:relative;}
    .takt-assoc-nav-btn{width:36px;height:36px;border-radius:10px;border:2px solid #86efac;background:white;color:#16a34a;font-size:16px;font-weight:800;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.2s;font-family:'Inter',sans-serif;flex-shrink:0;}
    .takt-assoc-nav-btn:hover{background:#16a34a;color:white;border-color:#16a34a;}
    .takt-assoc-nav-btn:disabled{opacity:0.3;cursor:not-allowed;}
    .takt-assoc-nav-btn:disabled:hover{background:white;color:#16a34a;}
    .takt-assoc-card{flex:1;display:flex;align-items:center;gap:12px;padding:6px 16px;background:white;border-radius:12px;border:2px solid #86efac;min-width:0;transition:all 0.3s ease;}
    .takt-assoc-avatar{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#22c55e,#16a34a);color:white;font-size:15px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
    .takt-assoc-info{min-width:0;flex:1;}
    .takt-assoc-name{font-size:14px;font-weight:800;color:#1e293b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .takt-assoc-login{font-size:11px;font-weight:500;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .takt-assoc-counter{padding:3px 10px;border-radius:20px;background:#dcfce7;color:#16a34a;font-size:11px;font-weight:700;white-space:nowrap;flex-shrink:0;}
    .takt-assoc-empty-card{flex:1;display:flex;align-items:center;justify-content:center;padding:12px 16px;background:white;border-radius:12px;border:2px dashed #86efac;color:#64748b;font-size:13px;font-weight:600;}
    .takt-assoc-actions{display:flex;gap:6px;flex-shrink:0;}
    .takt-assoc-action-btn{padding:7px 14px;border-radius:8px;border:2px solid #86efac;background:white;color:#16a34a;font-size:11px;font-weight:700;cursor:pointer;transition:all 0.2s;display:flex;align-items:center;gap:5px;font-family:'Inter',sans-serif;white-space:nowrap;}
    .takt-assoc-action-btn:hover{background:#16a34a;color:white;border-color:#16a34a;}
    .takt-assoc-action-btn.primary{background:linear-gradient(135deg,#22c55e,#16a34a);color:white;border-color:#16a34a;}
    .takt-assoc-action-btn.primary:hover{box-shadow:0 4px 15px rgba(34,197,94,0.4);}
    .takt-assoc-action-btn.hist-btn{border-color:#c7d2fe;color:#6366f1;}
    .takt-assoc-action-btn.hist-btn:hover{background:#6366f1;color:white;border-color:#6366f1;}

    .takt-search-overlay{position:absolute;top:100%;left:24px;right:24px;background:white;border-radius:14px;border:2px solid #e2e8f0;box-shadow:0 20px 60px rgba(0,0,0,0.12);z-index:20;max-height:300px;overflow:hidden;display:flex;flex-direction:column;animation:search-slide-in 0.2s ease;}
    @keyframes search-slide-in{from{opacity:0;transform:translateY(-8px);}to{opacity:1;transform:translateY(0);}}
    .takt-search-input-wrap{padding:12px;border-bottom:1px solid #f1f5f9;display:flex;align-items:center;gap:8px;}
    .takt-search-input-wrap svg{width:18px;height:18px;fill:#94a3b8;flex-shrink:0;}
    .takt-search-input{flex:1;border:none;outline:none;font-size:14px;font-weight:500;font-family:'Inter',sans-serif;color:#1e293b;background:transparent;}
    .takt-search-input::placeholder{color:#cbd5e1;}
    .takt-search-results{overflow-y:auto;max-height:220px;padding:6px;}
    .takt-search-result{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;cursor:pointer;transition:background 0.15s;}
    .takt-search-result:hover{background:#f0fdf4;}
    .takt-search-result-avatar{width:32px;height:32px;border-radius:8px;background:linear-gradient(135deg,#22c55e,#16a34a);color:white;font-size:13px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
    .takt-search-result-info{flex:1;min-width:0;}
    .takt-search-result-name{font-size:13px;font-weight:700;color:#1e293b;}
    .takt-search-result-login{font-size:11px;color:#64748b;}
    .takt-search-result.active{background:#ecfdf5;border:1px solid #86efac;}
    .takt-search-no-results{padding:16px;text-align:center;color:#94a3b8;font-size:13px;font-weight:500;}
    .takt-search-add-new{display:flex;align-items:center;gap:8px;padding:10px 12px;border-top:1px solid #f1f5f9;cursor:pointer;transition:background 0.15s;color:#6366f1;font-size:12px;font-weight:700;}
    .takt-search-add-new:hover{background:#eef2ff;}

    .takt-add-overlay{position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(255,255,255,0.9);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;z-index:15;border-radius:20px;}
    .takt-add-form{background:white;border-radius:18px;padding:28px;width:380px;box-shadow:0 20px 60px rgba(0,0,0,0.12);border:2px solid #86efac;animation:form-pop-in 0.25s ease;}
    @keyframes form-pop-in{from{opacity:0;transform:scale(0.9);}to{opacity:1;transform:scale(1);}}
    .takt-add-form-title{font-size:18px;font-weight:800;color:#1e293b;margin-bottom:4px;display:flex;align-items:center;gap:8px;}
    .takt-add-form-sub{font-size:12px;color:#64748b;margin-bottom:20px;}
    .takt-add-field{margin-bottom:14px;}
    .takt-add-field label{display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:#475569;margin-bottom:5px;}
    .takt-add-field input{width:100%;padding:10px 14px;border-radius:10px;border:2px solid #e2e8f0;font-size:14px;font-weight:600;font-family:'Inter',sans-serif;color:#1e293b;outline:none;transition:all 0.2s;box-sizing:border-box;}
    .takt-add-field input:focus{border-color:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,0.15);}
    .takt-add-field input::placeholder{color:#cbd5e1;}
    .takt-add-warn{font-size:11px;color:#d97706;font-weight:600;margin-top:4px;display:none;}
    .takt-add-btns{display:flex;gap:8px;margin-top:20px;}
    .takt-add-btns button{flex:1;padding:11px;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;border:none;transition:all 0.2s;font-family:'Inter',sans-serif;}
    .takt-add-cancel{background:#f1f5f9;color:#64748b;}
    .takt-add-cancel:hover{background:#e2e8f0;}
    .takt-add-submit{background:linear-gradient(135deg,#22c55e,#16a34a);color:white;}
    .takt-add-submit:hover{box-shadow:0 4px 15px rgba(34,197,94,0.4);}
    .takt-add-submit:disabled{opacity:0.5;cursor:not-allowed;box-shadow:none;}

    .takt-process-bar{display:flex;align-items:center;gap:16px;padding:10px 24px;background:#eef2ff;border-bottom:2px solid #c7d2fe;flex-shrink:0;flex-wrap:wrap;}
    .takt-process-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:#6366f1;}
    .takt-process-select{padding:7px 32px 7px 12px;border-radius:8px;border:2px solid #c7d2fe;background:white;color:#1e293b;font-size:13px;font-weight:700;font-family:'Inter',sans-serif;cursor:pointer;outline:none;transition:all 0.2s;appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='%236366f1'%3E%3Cpath d='M7 10l5 5 5-5z'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;}
    .takt-process-select:hover{border-color:#6366f1;}
    .takt-process-select:focus{border-color:#6366f1;box-shadow:0 0 0 3px rgba(99,102,241,0.15);}
    .takt-process-select:disabled{opacity:0.5;cursor:not-allowed;}
    .takt-process-arrow{color:#a5b4fc;font-size:18px;font-weight:300;}
    .takt-dock-note{padding:4px 12px;border-radius:6px;background:rgba(245,158,11,0.12);color:#b45309;font-size:11px;font-weight:700;border:1px solid #fde68a;white-space:nowrap;margin-left:auto;}

    .takt-control-bar{display:flex;align-items:center;gap:10px;padding:10px 24px;background:#f8fafc;border-bottom:1px solid #e2e8f0;flex-shrink:0;}
    .takt-obs-pills{display:flex;gap:5px;}
    .takt-obs-pill{padding:7px 16px;border-radius:8px;border:2px solid #e2e8f0;background:white;color:#64748b;font-size:12px;font-weight:600;cursor:pointer;transition:all 0.2s;position:relative;font-family:'Inter',sans-serif;}
    .takt-obs-pill:hover{border-color:#6366f1;color:#6366f1;background:#eef2ff;}
    .takt-obs-pill.selected{border-color:#6366f1;background:#6366f1;color:white;box-shadow:0 2px 10px rgba(99,102,241,0.3);}
    .takt-obs-pill.completed{border-color:#22c55e;color:#22c55e;background:#f0fdf4;}
    .takt-obs-pill.completed::after{content:'✓';position:absolute;top:-6px;right:-6px;background:#22c55e;color:white;width:16px;height:16px;border-radius:50%;font-size:9px;display:flex;align-items:center;justify-content:center;border:2px solid white;}
    .takt-control-sep{width:1px;height:32px;background:#e2e8f0;}
    .takt-btn-action{padding:8px 20px;border-radius:8px;border:none;font-size:12px;font-weight:700;cursor:pointer;transition:all 0.2s;display:flex;align-items:center;gap:6px;letter-spacing:0.3px;font-family:'Inter',sans-serif;white-space:nowrap;}
    .takt-btn-action.start-btn{background:linear-gradient(135deg,#22c55e,#16a34a);color:white;box-shadow:0 2px 10px rgba(34,197,94,0.25);}
    .takt-btn-action.start-btn:hover{box-shadow:0 4px 20px rgba(34,197,94,0.4);transform:translateY(-1px);}
    .takt-btn-action.recording-btn{background:linear-gradient(135deg,#ef4444,#dc2626);color:white;box-shadow:0 2px 10px rgba(239,68,68,0.25);animation:rec-btn-pulse 2s infinite;}
    @keyframes rec-btn-pulse{0%,100%{box-shadow:0 2px 10px rgba(239,68,68,0.25);}50%{box-shadow:0 4px 25px rgba(239,68,68,0.5);}}
    .takt-btn-action:disabled{background:#e2e8f0;color:#94a3b8;cursor:not-allowed;box-shadow:none;transform:none;animation:none;}
    .takt-btn-action.clear-btn{background:white;color:#64748b;border:2px solid #e2e8f0;}
    .takt-btn-action.clear-btn:hover{border-color:#f59e0b;color:#f59e0b;background:#fffbeb;}

    .takt-timer-bar{display:flex;align-items:center;justify-content:center;padding:10px 24px;gap:16px;background:white;border-bottom:1px solid #e2e8f0;flex-shrink:0;}
    .takt-timer-bar.hidden{display:none;}
    .takt-live-timer{font-size:30px;font-weight:800;font-family:'JetBrains Mono','SF Mono','Courier New',monospace;letter-spacing:1px;color:#0f172a;}
    .takt-live-timer.recording{color:#ef4444;animation:timer-color-pulse 1.5s infinite alternate;}
    @keyframes timer-color-pulse{from{color:#ef4444;}to{color:#f87171;}}
    .takt-timer-task-label{font-size:13px;font-weight:600;color:#475569;padding:5px 14px;background:#f1f5f9;border-radius:8px;}
    .takt-timer-task-label .task-name{color:#6366f1;font-weight:700;}
    .takt-rec-dot{width:10px;height:10px;border-radius:50%;background:#ef4444;animation:rec-dot-blink 1s infinite;}
    @keyframes rec-dot-blink{0%,100%{opacity:1;}50%{opacity:0.2;}}

    .takt-table-wrap{flex:1;overflow-y:auto;min-height:0;}
    .takt-table-wrap::-webkit-scrollbar{width:6px;}
    .takt-table-wrap::-webkit-scrollbar-track{background:#f8fafc;}
    .takt-table-wrap::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:3px;}
    .takt-table{width:100%;border-collapse:collapse;font-size:12px;}
    .takt-table thead{position:sticky;top:0;z-index:2;}
    .takt-table thead th{background:#f1f5f9;color:#475569;font-weight:700;font-size:10px;text-transform:uppercase;letter-spacing:1px;padding:8px 14px;text-align:center;border-bottom:2px solid #e2e8f0;white-space:nowrap;}
    .takt-table thead th:first-child{text-align:left;padding-left:24px;min-width:260px;}
    .takt-table thead th.obs-header{min-width:100px;position:relative;}
    .takt-table thead th.obs-header.active{background:#eef2ff;color:#6366f1;}
    .takt-table thead th.obs-header.active::after{content:'';position:absolute;bottom:-2px;left:0;right:0;height:3px;background:#6366f1;}
    .takt-table tbody tr{transition:background 0.15s;}
    .takt-table tbody tr:hover{background:#f8fafc;}
    .takt-table tbody tr.current-task-row{background:#eef2ff;}
    .takt-table tbody tr.current-task-row td:first-child{border-left:4px solid #6366f1;padding-left:20px;}
    .takt-table tbody td{padding:7px 14px;text-align:center;border-bottom:1px solid #f1f5f9;color:#334155;font-weight:500;}
    .takt-table tbody td:first-child{text-align:left;padding-left:24px;color:#1e293b;font-weight:500;}
    .takt-table tbody td.target-col{color:#94a3b8;font-size:11px;font-weight:600;background:#fafbfc;}
    .takt-table tbody td.target-col.no-target{color:#d97706;font-style:italic;}
    .takt-table tbody td.obs-cell{font-family:'JetBrains Mono','SF Mono','Courier New',monospace;font-weight:700;font-size:13px;min-width:80px;}
    .takt-table tbody td.obs-cell.good{color:#16a34a;background:#f0fdf4;}
    .takt-table tbody td.obs-cell.over{color:#dc2626;background:#fef2f2;}
    .takt-table tbody td.obs-cell.no-target-recorded{color:#1e293b;background:#fefce8;}
    .takt-table tbody td.obs-cell.active-col{background:#eef2ff;}
    .takt-table tbody td.obs-cell.current-cell{background:#6366f1;color:white;position:relative;box-shadow:inset 0 0 0 2px #4f46e5;}
    .takt-table tbody td.obs-cell.current-cell::after{content:' ⏱';font-size:11px;}
    .takt-table tbody td.obs-cell.empty{color:#d1d5db;}
    .takt-table tbody td.obs-cell.empty-active{color:#c7d2fe;background:#eef2ff;}
    .takt-table tbody tr.row-start-time,.takt-table tbody tr.row-end-time{background:#fafbfc;}
    .takt-table tbody tr.row-start-time td,.takt-table tbody tr.row-end-time td{font-weight:600;color:#6366f1;border-bottom:1px solid #e2e8f0;padding:6px 14px;}
    .takt-table tbody tr.row-start-time td:first-child,.takt-table tbody tr.row-end-time td:first-child{color:#475569;font-weight:700;}
    .takt-table tbody tr.row-total{background:linear-gradient(135deg,#f8fafc,#f1f5f9);border-top:2px solid #e2e8f0;}
    .takt-table tbody tr.row-total td{font-weight:800;font-size:13px;padding:10px 14px;color:#1e293b;}
    .takt-table tbody tr.row-total td.obs-cell.good{color:#16a34a;background:#dcfce7;}
    .takt-table tbody tr.row-total td.obs-cell.over{color:#dc2626;background:#fee2e2;}
    .takt-table tbody tr.row-total td.obs-cell.no-target-recorded{color:#1e293b;background:#fef9c3;}

    .takt-coaching-section{padding:10px 24px;background:#fffbeb;border-top:2px solid #fde68a;flex-shrink:0;}
    .takt-coaching-header{display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none;}
    .takt-coaching-title{font-size:12px;font-weight:800;color:#a16207;text-transform:uppercase;letter-spacing:0.8px;display:flex;align-items:center;gap:6px;}
    .takt-coaching-toggle{font-size:11px;font-weight:600;color:#d97706;transition:transform 0.2s;}
    .takt-coaching-body{overflow:hidden;transition:max-height 0.3s ease;}
    .takt-coaching-body.collapsed{max-height:0;}
    .takt-coaching-body.expanded{max-height:200px;}
    .takt-coaching-textarea{width:100%;height:80px;margin-top:8px;padding:10px 14px;border-radius:10px;border:2px solid #fde68a;background:white;font-size:13px;font-weight:500;font-family:'Inter',sans-serif;color:#1e293b;outline:none;resize:vertical;transition:border-color 0.2s;box-sizing:border-box;}
    .takt-coaching-textarea:focus{border-color:#f59e0b;box-shadow:0 0 0 3px rgba(245,158,11,0.15);}
    .takt-coaching-textarea::placeholder{color:#d4a574;}

    .takt-progress-section{padding:8px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;display:flex;align-items:center;gap:14px;flex-shrink:0;}
    .takt-progress-section.hidden{display:none;}
    .takt-progress-bar-bg{flex:1;height:6px;background:#e2e8f0;border-radius:3px;overflow:hidden;}
    .takt-progress-bar-fill{height:100%;background:linear-gradient(90deg,#6366f1,#8b5cf6);border-radius:3px;transition:width 0.5s cubic-bezier(0.4,0,0.2,1);}
    .takt-progress-text{font-size:11px;font-weight:700;color:#6366f1;white-space:nowrap;}

    .takt-footer{padding:10px 24px;border-top:1px solid #e2e8f0;display:flex;align-items:center;justify-content:space-between;background:#fafbfc;flex-shrink:0;}
    .takt-footer-left{display:flex;gap:6px;}
    .takt-footer-btn{padding:6px 14px;border-radius:7px;border:1.5px solid #e2e8f0;background:white;color:#64748b;font-size:11px;font-weight:600;cursor:pointer;transition:all 0.2s;display:flex;align-items:center;gap:5px;font-family:'Inter',sans-serif;}
    .takt-footer-btn:hover{border-color:#6366f1;color:#6366f1;background:#eef2ff;}
    .takt-footer-btn.danger:hover{border-color:#ef4444;color:#ef4444;background:#fef2f2;}
    .takt-footer-status{font-size:11px;color:#94a3b8;font-weight:500;}

    .takt-confirm-overlay{position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(255,255,255,0.85);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;z-index:10;border-radius:20px;}
    .takt-confirm-box{background:white;border-radius:18px;padding:28px;width:320px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.1);border:1px solid #e2e8f0;}
    .takt-confirm-icon{width:52px;height:52px;border-radius:50%;background:#fef2f2;display:flex;align-items:center;justify-content:center;margin:0 auto 14px;font-size:22px;}
    .takt-confirm-title{font-size:16px;font-weight:800;color:#1e293b;margin-bottom:6px;}
    .takt-confirm-msg{font-size:13px;color:#64748b;margin-bottom:20px;line-height:1.5;}
    .takt-confirm-btns{display:flex;gap:8px;}
    .takt-confirm-btns button{flex:1;padding:10px;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;border:none;transition:all 0.2s;font-family:'Inter',sans-serif;}
    .takt-confirm-cancel{background:#f1f5f9;color:#64748b;}
    .takt-confirm-cancel:hover{background:#e2e8f0;}
    .takt-confirm-ok{background:linear-gradient(135deg,#ef4444,#dc2626);color:white;}
    .takt-confirm-ok:hover{box-shadow:0 4px 15px rgba(239,68,68,0.3);}

    .takt-toast{position:fixed;bottom:100px;left:50%;transform:translateX(-50%) translateY(20px);background:#1e293b;color:white;padding:10px 22px;border-radius:10px;font-family:'Inter',sans-serif;font-size:12px;font-weight:600;z-index:9999999;opacity:0;transition:all 0.3s;box-shadow:0 8px 30px rgba(0,0,0,0.2);}
    .takt-toast.show{opacity:1;transform:translateX(-50%) translateY(0);}

    .takt-empty-state{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#94a3b8;gap:12px;padding:40px;}
    .takt-empty-state-icon{font-size:48px;opacity:0.5;}
    .takt-empty-state-title{font-size:18px;font-weight:800;color:#64748b;}
    .takt-empty-state-msg{font-size:13px;color:#94a3b8;text-align:center;max-width:300px;line-height:1.6;}
    .takt-empty-state-btn{margin-top:8px;padding:12px 28px;border-radius:12px;border:none;background:linear-gradient(135deg,#22c55e,#16a34a);color:white;font-size:14px;font-weight:700;cursor:pointer;transition:all 0.2s;font-family:'Inter',sans-serif;display:flex;align-items:center;gap:8px;}
    .takt-empty-state-btn:hover{box-shadow:0 8px 25px rgba(34,197,94,0.4);transform:translateY(-2px);}

    .takt-summary-wrap{flex:1;overflow-y:auto;padding:16px 24px;min-height:0;}
    .takt-summary-wrap::-webkit-scrollbar{width:6px;}
    .takt-summary-wrap::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:3px;}
    .takt-summary-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;margin-bottom:10px;}
    .takt-summary-table{width:100%;border-collapse:collapse;}
    .takt-summary-parent-row td{padding:10px 16px 4px;font-size:13px;font-weight:800;color:#1e293b;border-bottom:2px solid #e2e8f0;}
    .takt-summary-parent-name{font-size:14px;font-weight:800;color:#0f172a;width:200px;}
    .takt-summary-row{cursor:pointer;transition:all 0.15s;border-bottom:1px solid #f8fafc;}
    .takt-summary-row:hover{background:#eef2ff;}
    .takt-summary-row.done{background:#f0fdf4;}
    .takt-summary-row.done:hover{background:#dcfce7;}
    .takt-summary-row td{padding:9px 16px;}
    .takt-summary-sub-cell{display:flex;align-items:center;gap:8px;width:200px;}
    .takt-summary-sub-arrow{color:#cbd5e1;font-size:14px;font-weight:700;}
    .takt-summary-sub-label{font-size:13px;font-weight:600;color:#475569;}
    .takt-summary-row:hover .takt-summary-sub-label{color:#6366f1;}
    .takt-summary-row:hover .takt-summary-sub-arrow{color:#6366f1;}
    .takt-summary-progress-wrap{display:flex;align-items:center;gap:10px;}
    .takt-summary-bar-bg{flex:1;height:6px;background:#e2e8f0;border-radius:3px;overflow:hidden;}
    .takt-summary-bar-fill{height:100%;border-radius:3px;transition:width 0.4s ease;}
    .takt-summary-bar-fill.complete{background:linear-gradient(90deg,#22c55e,#16a34a);}
    .takt-summary-bar-fill.partial{background:linear-gradient(90deg,#6366f1,#8b5cf6);}
    .takt-summary-bar-fill.empty{width:0!important;}
    .takt-summary-status{font-size:12px;font-weight:700;white-space:nowrap;min-width:50px;text-align:right;}
    .takt-summary-status.complete{color:#16a34a;}
    .takt-summary-status.partial{color:#6366f1;}
    .takt-summary-status.empty{color:#cbd5e1;}
    .takt-summary-go{color:#cbd5e1;font-size:14px;font-weight:700;margin-left:4px;}
    .takt-summary-row:hover .takt-summary-go{color:#6366f1;}
    .takt-summary-spacer td{padding:6px;}
    .takt-back-btn{display:flex;align-items:center;gap:6px;padding:6px 14px;border-radius:8px;border:2px solid #c7d2fe;background:white;color:#6366f1;font-size:12px;font-weight:700;cursor:pointer;transition:all 0.2s;font-family:'Inter',sans-serif;}
    .takt-back-btn:hover{background:#eef2ff;}

    .takt-assoc-delete-btn{width:28px;height:28px;border-radius:6px;border:1.5px solid #fca5a5;background:white;color:#ef4444;font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.2s;flex-shrink:0;}
    .takt-assoc-delete-btn:hover{background:#ef4444;color:white;border-color:#ef4444;}

    /* ── HISTORY VIEW ── */
    .takt-history-wrap{flex:1;overflow-y:auto;padding:0;min-height:0;}
    .takt-history-wrap::-webkit-scrollbar{width:6px;}
    .takt-history-wrap::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:3px;}
    .takt-history-header{padding:12px 24px;background:#f8fafc;border-bottom:2px solid #e2e8f0;display:flex;align-items:center;gap:12px;flex-shrink:0;}
    .takt-history-title{font-size:14px;font-weight:800;color:#1e293b;}
    .takt-history-subtitle{font-size:11px;color:#64748b;font-weight:500;}
    .takt-date-tabs{display:flex;gap:6px;flex-wrap:wrap;padding:10px 24px;background:#f1f5f9;border-bottom:1px solid #e2e8f0;flex-shrink:0;}
    .takt-date-tab{padding:5px 14px;border-radius:20px;border:2px solid #e2e8f0;background:white;color:#64748b;font-size:11px;font-weight:700;cursor:pointer;transition:all 0.2s;font-family:'Inter',sans-serif;white-space:nowrap;}
    .takt-date-tab:hover{border-color:#6366f1;color:#6366f1;background:#eef2ff;}
    .takt-date-tab.selected{border-color:#6366f1;background:#6366f1;color:white;}
    .takt-date-tab.today{border-color:#22c55e;}
    .takt-date-tab.today.selected{background:#22c55e;border-color:#22c55e;}
    .takt-history-content{padding:16px 24px;}
    .takt-history-section{margin-bottom:20px;}
    .takt-history-section-header{display:flex;align-items:center;gap:10px;margin-bottom:8px;padding-bottom:6px;border-bottom:2px solid #e2e8f0;}
    .takt-history-process-badge{padding:3px 10px;border-radius:6px;background:#6366f1;color:white;font-size:11px;font-weight:800;}
    .takt-history-sub-badge{padding:3px 10px;border-radius:6px;background:#eef2ff;color:#6366f1;font-size:11px;font-weight:700;}
    .takt-history-obs-count{margin-left:auto;font-size:11px;color:#94a3b8;font-weight:600;}
    .takt-hist-table{width:100%;border-collapse:collapse;font-size:12px;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;}
    .takt-hist-table thead th{background:#f8fafc;color:#475569;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;padding:7px 12px;text-align:center;border-bottom:1px solid #e2e8f0;}
    .takt-hist-table thead th:first-child{text-align:left;}
    .takt-hist-table tbody td{padding:7px 12px;text-align:center;border-bottom:1px solid #f8fafc;font-weight:600;font-size:12px;}
    .takt-hist-table tbody td:first-child{text-align:left;color:#1e293b;font-weight:600;}
    .takt-hist-table tbody tr:last-child td{border-bottom:none;}
    .takt-hist-table tbody tr.avg-row{background:linear-gradient(135deg,#eef2ff,#f5f3ff);}
    .takt-hist-table tbody tr.avg-row td{font-weight:800;font-size:13px;color:#6366f1;}
    .takt-hist-good{color:#16a34a;font-weight:800;}
    .takt-hist-over{color:#dc2626;font-weight:800;}
    .takt-hist-neutral{color:#1e293b;}
    .takt-hist-na{color:#cbd5e1;}

    .takt-overall-section{margin:0 24px 20px;padding:16px;background:linear-gradient(135deg,#eef2ff,#f5f3ff);border-radius:14px;border:2px solid #c7d2fe;}
    .takt-overall-title{font-size:13px;font-weight:800;color:#6366f1;margin-bottom:12px;display:flex;align-items:center;gap:8px;}
    .takt-overall-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;}
    .takt-overall-card{background:white;border-radius:10px;padding:12px 16px;border:1.5px solid #c7d2fe;}
    .takt-overall-card-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:#94a3b8;margin-bottom:4px;}
    .takt-overall-card-process{font-size:12px;font-weight:800;color:#1e293b;margin-bottom:2px;}
    .takt-overall-card-stats{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
    .takt-overall-avg{font-size:20px;font-weight:800;color:#6366f1;}
    .takt-overall-target{font-size:11px;color:#94a3b8;font-weight:600;}
    .takt-overall-vs{font-size:11px;font-weight:800;padding:2px 8px;border-radius:5px;}
    .takt-overall-vs.good{background:#dcfce7;color:#16a34a;}
    .takt-overall-vs.over{background:#fee2e2;color:#dc2626;}
    .takt-overall-meta{font-size:10px;color:#94a3b8;margin-top:4px;}

    .takt-no-history{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px;color:#94a3b8;gap:8px;}
    .takt-no-history-icon{font-size:36px;opacity:0.4;}
    .takt-no-history-text{font-size:13px;font-weight:600;}
  `;
  document.head.appendChild(styles);

  // ═══════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════
  function formatTime(date) {
    const h = date.getHours().toString().padStart(2,'0');
    const m = date.getMinutes().toString().padStart(2,'0');
    const s = date.getSeconds().toString().padStart(2,'0');
    const cs = Math.floor(date.getMilliseconds()/100);
    return `${h}:${m}:${s}.${cs}`;
  }

  function formatElapsed(ms) {
    const totalSec = Math.floor(ms/1000);
    const min = Math.floor(totalSec/60).toString().padStart(2,'0');
    const sec = (totalSec%60).toString().padStart(2,'0');
    const cs = Math.floor((ms%1000)/10).toString().padStart(2,'0');
    return `${min}:${sec}.${cs}`;
  }

  function getInitials(name) {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0]+parts[1][0]).toUpperCase();
    return parts[0].substring(0,2).toUpperCase();
  }

  function showToast(msg) {
    const t = document.createElement('div');
    t.className = 'takt-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2500);
  }

  function getCompletedCountToday(assoc) {
    if (!assoc) return 0;
    const today = todayKey();
    const dayData = assoc.history && assoc.history[today];
    if (!dayData) return 0;
    const key = storeKey();
    const obs = dayData[key];
    if (!obs) return 0;
    let c = 0;
    for (let i = 1; i <= NUM_OBS; i++) { if (obs[i] && obs[i].total !== null) c++; }
    return c;
  }

  function getTotalHistoricalObs(assoc) {
    if (!assoc || !assoc.history) return 0;
    let total = 0;
    Object.values(assoc.history).forEach(day => {
      Object.values(day).forEach(obsSet => {
        for (let i = 1; i <= NUM_OBS; i++) { if (obsSet[i] && obsSet[i].total !== null) total++; }
      });
    });
    return total;
  }

  function hasTargets(config) { return config.totalTarget > 0; }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ═══════════════════════════════════════════════════════
  // BUILD UI SHELLS
  // ═══════════════════════════════════════════════════════
  const backdrop = document.createElement('div');
  backdrop.id = 'takt-backdrop';
  document.body.appendChild(backdrop);

  const fab = document.createElement('div');
  fab.id = 'takt-fab';
  fab.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.5-13H11v6l5.2 3.2.8-1.3-4.5-2.7V7z"/></svg><div id="takt-badge">0</div>`;
  document.body.appendChild(fab);

  const panel = document.createElement('div');
  panel.id = 'takt-panel';
  document.body.appendChild(panel);

  // ═══════════════════════════════════════════════════════
  // SHARED HTML BUILDERS
  // ═══════════════════════════════════════════════════════
  function buildHeaderHTML(subtitle) {
    return `
      <div class="takt-header" id="takt-drag-handle">
        <div class="takt-header-left">
          <div class="takt-header-icon"><svg viewBox="0 0 24 24"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.5-13H11v6l5.2 3.2.8-1.3-4.5-2.7V7z"/></svg></div>
          <div>
            <div class="takt-header-title">Takt Time Study</div>
            <div class="takt-header-subtitle">SNA4 — ${subtitle}</div>
          </div>
        </div>
        <div class="takt-header-actions">
          <button class="takt-header-btn" id="takt-minimize" title="Minimize">─</button>
          <button class="takt-header-btn" id="takt-close" title="Close">✕</button>
        </div>
      </div>`;
  }

  function buildSyncBarHTML() {
    return `<div class="takt-sync-bar"><span id="takt-sync-badge" style="padding:3px 10px;border-radius:6px;font-size:11px;font-weight:700;font-family:'Inter',sans-serif;">⟳ Connecting...</span><button class="takt-sync-refresh" id="takt-sync-now">↺ Sync Now</button></div>`;
  }

  function buildAuditorBarHTML() {
    return `
      <div class="takt-auditor-bar">
        <div class="takt-auditor-group"><span class="takt-auditor-label">Auditor</span><input class="takt-auditor-input" id="takt-auditor-name" placeholder="Your Name" value="${escapeHtml(appData.auditorName)}" /></div>
        <div class="takt-auditor-group"><span class="takt-auditor-label">Login</span><input class="takt-auditor-input" id="takt-auditor-login" placeholder="Login ID" value="${escapeHtml(appData.auditorLogin)}" /></div>
        <div class="takt-auditor-group" style="margin-left:auto;"><span class="takt-auditor-label">Date</span><span style="font-size:12px;font-weight:700;color:#92400e;">${new Date().toLocaleDateString()}</span></div>
      </div>`;
  }

  function buildAssocBarHTML(assoc, isRunning) {
    let assocCardHTML = '';
    if (assoc) {
      const completed = getCompletedCountToday(assoc);
      const totalHist = getTotalHistoricalObs(assoc);
      assocCardHTML = `
        <div class="takt-assoc-card">
          <div class="takt-assoc-avatar">${getInitials(assoc.name)}</div>
          <div class="takt-assoc-info">
            <div class="takt-assoc-name">${escapeHtml(assoc.name)}</div>
            <div class="takt-assoc-login">${escapeHtml(assoc.login)}${assoc.lastObservedBy ? ` · <span style="color:#f59e0b;font-weight:700;">Last by: ${escapeHtml(assoc.lastObservedBy)}</span>` : ''}</div>
          </div>
          <div class="takt-assoc-counter" title="Today's obs">${completed}/${NUM_OBS} Today</div>
          <div class="takt-assoc-counter" style="background:#eef2ff;color:#6366f1;" title="Total historical obs">${totalHist} Total</div>
          <button class="takt-assoc-delete-btn" id="takt-delete-assoc" title="Remove associate">✕</button>
        </div>`;
    } else {
      assocCardHTML = `<div class="takt-assoc-empty-card">👤 No associate selected — search or add one</div>`;
    }
    const navDisabled = isRunning || appData.associates.length <= 1;
    return `
      <div class="takt-associate-bar" id="takt-associate-bar">
        <button class="takt-assoc-nav-btn" id="takt-nav-prev" ${navDisabled?'disabled':''}>‹</button>
        ${assocCardHTML}
        <button class="takt-assoc-nav-btn" id="takt-nav-next" ${navDisabled?'disabled':''}>›</button>
        <div class="takt-assoc-actions">
          <button class="takt-assoc-action-btn hist-btn" id="takt-view-history" ${!assoc||isRunning?'disabled style="opacity:0.4;pointer-events:none;"':''}>📊 History</button>
          <button class="takt-assoc-action-btn" id="takt-search-assoc" ${isRunning?'disabled style="opacity:0.4;pointer-events:none;"':''}>🔍 Search</button>
          <button class="takt-assoc-action-btn primary" id="takt-add-assoc" ${isRunning?'disabled style="opacity:0.4;pointer-events:none;"':''}>＋ Add New</button>
        </div>
      </div>`;
  }

  // ═══════════════════════════════════════════════════════
  // RENDER — HISTORY VIEW
  // ═══════════════════════════════════════════════════════
  function renderHistory() {
    const assoc = getCurrentAssociate();
    if (!assoc) { state.view = 'summary'; renderPanel(); return; }

    const dates = getAssociateDates(assoc);
    const today = todayKey();

    // Default to most recent date that has data
    if (!state.historySelectedDate || !assoc.history[state.historySelectedDate]) {
      const datesWithData = dates.filter(d => {
        const dayData = assoc.history[d];
        return dayData && Object.values(dayData).some(obs => Object.values(obs).some(o => o.total !== null));
      });
      state.historySelectedDate = datesWithData[0] || today;
    }

    const headerHTML = buildHeaderHTML(`${assoc.name} · History`);
    const syncBarHTML = buildSyncBarHTML();
    const auditorBarHTML = buildAuditorBarHTML();
    const assocBarHTML = buildAssocBarHTML(assoc, false);

    // Date tabs — only show dates with any completed obs
    const datesWithData = dates.filter(d => {
      const dayData = assoc.history[d];
      return dayData && Object.values(dayData).some(obs => Object.values(obs).some(o => o.total !== null));
    });

    let dateTabsHTML = '';
    if (datesWithData.length === 0) {
      dateTabsHTML = `<div class="takt-date-tabs"><span style="font-size:12px;color:#94a3b8;font-weight:600;">No completed observations yet</span></div>`;
    } else {
      dateTabsHTML = `<div class="takt-date-tabs">` +
        datesWithData.map(d => {
          const isToday = d === today;
          const isSel = d === state.historySelectedDate;
          return `<button class="takt-date-tab ${isSel?'selected':''} ${isToday?'today':''}" data-date="${d}">${isToday?'📅 Today':formatDateDisplay(d)}</button>`;
        }).join('') +
        `</div>`;
    }

    // Day averages content
    let dayContentHTML = '';
    if (state.historySelectedDate && assoc.history[state.historySelectedDate]) {
      const dayAvgs = computeDayAverages(assoc, state.historySelectedDate);
      const entries = Object.entries(dayAvgs);
      if (entries.length === 0) {
        dayContentHTML = `<div class="takt-no-history"><div class="takt-no-history-icon">📋</div><div class="takt-no-history-text">No completed observations on this date</div></div>`;
      } else {
        dayContentHTML = `<div class="takt-history-content">`;
        entries.forEach(([key, data]) => {
          const config = PROCESS_PATHS[data.process] && PROCESS_PATHS[data.process][key.split('__')[1]];
          if (!config) return;
          const showTargets = hasTargets(config);

          let taskRowsHTML = config.tasks.map((task, idx) => {
            const avg = data.taskAverages[idx];
            const cls = avg === null ? 'takt-hist-na' : (task.target > 0 ? (avg <= task.target ? 'takt-hist-good' : 'takt-hist-over') : 'takt-hist-neutral');
            return `<tr>
              <td><span style="color:#94a3b8;font-size:10px;margin-right:6px;">${String(idx+1).padStart(2,'0')}</span>${task.name}</td>
              <td>${task.target > 0 ? task.target+'s' : '<span class="takt-hist-na">N/A</span>'}</td>
              <td class="${cls}">${avg !== null ? avg+'s' : '—'}</td>
              <td>${avg !== null && task.target > 0 ? `<span class="${avg <= task.target ? 'takt-hist-good':'takt-hist-over'}">${avg <= task.target ? '-'+(task.target-avg) : '+'+(avg-task.target)}s</span>` : '<span class="takt-hist-na">—</span>'}</td>
            </tr>`;
          }).join('');

          const totalCls = showTargets ? (data.totalAvg <= data.target ? 'takt-hist-good' : 'takt-hist-over') : 'takt-hist-neutral';
          const vsText = showTargets ? `<span class="${data.vsTarget <= 0 ? 'takt-hist-good':'takt-hist-over'}">${data.vsTarget <= 0 ? '-'+Math.abs(data.vsTarget) : '+'+data.vsTarget}s vs target</span>` : '<span class="takt-hist-na">No target</span>';

          dayContentHTML += `
            <div class="takt-history-section">
              <div class="takt-history-section-header">
                <span class="takt-history-process-badge">${data.process}</span>
                <span class="takt-history-sub-badge">${data.sub}</span>
                <span class="takt-history-obs-count">${data.obsCount} observation${data.obsCount!==1?'s':''} completed</span>
              </div>
              <table class="takt-hist-table">
                <thead><tr><th style="text-align:left;">Task</th><th>Target</th><th>Avg Time</th><th>vs Target</th></tr></thead>
                <tbody>
                  ${taskRowsHTML}
                  <tr class="avg-row">
                    <td>📊 Total Average</td>
                    <td>${showTargets ? data.target+'s' : '<span class="takt-hist-na">N/A</span>'}</td>
                    <td class="${totalCls}">${data.totalAvg}s</td>
                    <td>${vsText}</td>
                  </tr>
                </tbody>
              </table>
            </div>`;
        });
        dayContentHTML += `</div>`;
      }
    } else {
      dayContentHTML = `<div class="takt-no-history"><div class="takt-no-history-icon">📅</div><div class="takt-no-history-text">Select a date to view observations</div></div>`;
    }

    // Overall averages across ALL time
    const overallAvgs = computeOverallAverages(assoc);
    const overallEntries = Object.entries(overallAvgs);
    let overallHTML = '';
    if (overallEntries.length > 0) {
      const cards = overallEntries.map(([key, data]) => {
        const showTarget = data.target > 0;
        const cls = showTarget ? (data.vsTarget <= 0 ? 'good' : 'over') : '';
        const vsLabel = showTarget ? `<span class="takt-overall-vs ${cls}">${data.vsTarget <= 0 ? '-'+Math.abs(data.vsTarget) : '+'+data.vsTarget}s</span>` : '';
        return `
          <div class="takt-overall-card">
            <div class="takt-overall-card-label">${data.process}</div>
            <div class="takt-overall-card-process">${data.sub}</div>
            <div class="takt-overall-card-stats">
              <span class="takt-overall-avg">${data.totalAvg}s</span>
              ${showTarget ? `<span class="takt-overall-target">/ ${data.target}s target</span>` : ''}
              ${vsLabel}
            </div>
            <div class="takt-overall-meta">${data.totalObsCount} obs · ${data.daysObserved} day${data.daysObserved!==1?'s':''}</div>
          </div>`;
      }).join('');
      overallHTML = `
        <div class="takt-overall-section">
          <div class="takt-overall-title">📈 All-Time Averages — ${assoc.name}</div>
          <div class="takt-overall-grid">${cards}</div>
        </div>`;
    }

    const footerHTML = `
      <div class="takt-footer">
        <div class="takt-footer-left">
          <button class="takt-footer-btn" id="takt-export-csv">📥 Export All History CSV</button>
          <button class="takt-footer-btn" id="takt-copy-data">📋 Copy Summary</button>
          <button class="takt-footer-btn danger" id="takt-clear-all">🗑 Clear All</button>
        </div>
        <div class="takt-footer-status">${getTotalHistoricalObs(assoc)} total obs · ${getAssociateDates(assoc).length} days on record</div>
      </div>`;

    panel.innerHTML = headerHTML + syncBarHTML + auditorBarHTML + assocBarHTML +
      `<div class="takt-history-wrap">` + dateTabsHTML + overallHTML + dayContentHTML + `</div>` +
      footerHTML;

    // Wire date tabs
    panel.querySelectorAll('.takt-date-tab').forEach(btn => {
      btn.onclick = () => { state.historySelectedDate = btn.dataset.date; renderHistory(); };
    });

    wireBaseEvents();
    wireHistoryEvents();
    updateSyncBadge();
  }

  function wireHistoryEvents() {
    const viewHistBtn = document.getElementById('takt-view-history');
    if (viewHistBtn) viewHistBtn.onclick = () => { state.view = 'history'; renderHistory(); };
  }

  // ═══════════════════════════════════════════════════════
  // RENDER — SUMMARY VIEW
  // ═══════════════════════════════════════════════════════
  function renderSummary(headerHTML, syncBarHTML, auditorBarHTML, assocBarHTML, footerHTML) {
    const assoc = getCurrentAssociate();
    const today = todayKey();

    let rowsHTML = '';
    Object.keys(PROCESS_PATHS).forEach(process => {
      const subs = PROCESS_PATHS[process];
      const subKeys = Object.keys(subs);
      const isDefault = subKeys.length === 1 && subKeys[0] === '_default';

      let totalCompleted = 0, totalPossible = 0;
      subKeys.forEach(sub => {
        const key = `${process}__${sub}`;
        totalPossible += NUM_OBS;
        const obsSet = assoc.history[today] && assoc.history[today][key];
        if (obsSet) {
          for (let i = 1; i <= NUM_OBS; i++) { if (obsSet[i] && obsSet[i].total !== null) totalCompleted++; }
        }
      });

      const parentPct = totalPossible > 0 ? (totalCompleted/totalPossible)*100 : 0;
      const parentDone = totalCompleted === totalPossible && totalPossible > 0;
      const parentEmpty = totalCompleted === 0;
      const parentFillClass = parentDone ? 'complete' : parentEmpty ? 'empty' : 'partial';
      const parentStatusClass = parentDone ? 'complete' : parentEmpty ? 'empty' : 'partial';
      const parentStatus = parentDone ? '✅ Done' : `${totalCompleted}/${totalPossible}`;

      rowsHTML += `<tr class="takt-summary-parent-row"><td class="takt-summary-parent-name">${process}</td><td><div class="takt-summary-progress-wrap"><div class="takt-summary-bar-bg"><div class="takt-summary-bar-fill ${parentFillClass}" style="width:${parentPct}%"></div></div><div class="takt-summary-status ${parentStatusClass}">${parentStatus}</div></div></td></tr>`;

      subKeys.forEach(sub => {
        const key = `${process}__${sub}`;
        const obsSet = assoc.history[today] && assoc.history[today][key];
        let completed = 0;
        if (obsSet) { for (let i = 1; i <= NUM_OBS; i++) { if (obsSet[i] && obsSet[i].total !== null) completed++; } }

        const pct = (completed/NUM_OBS)*100;
        const isDone = completed === NUM_OBS;
        const isEmpty = completed === 0;
        const fillClass = isDone ? 'complete' : isEmpty ? 'empty' : 'partial';
        const statusClass = isDone ? 'complete' : isEmpty ? 'empty' : 'partial';
        const statusText = isDone ? '✅' : isEmpty ? '0/5' : `${completed}/5 🔄`;
        const subLabel = isDefault ? process : sub;

        rowsHTML += `<tr class="takt-summary-row ${isDone?'done':''}" data-process="${escapeHtml(process)}" data-sub="${escapeHtml(sub)}"><td class="takt-summary-sub-cell"><span class="takt-summary-sub-arrow">›</span><span class="takt-summary-sub-label">${escapeHtml(subLabel)}</span></td><td><div class="takt-summary-progress-wrap"><div class="takt-summary-bar-bg"><div class="takt-summary-bar-fill ${fillClass}" style="width:${pct}%"></div></div><div class="takt-summary-status ${statusClass}">${statusText}</div><span class="takt-summary-go">›</span></div></td></tr>`;
      });
      rowsHTML += `<tr class="takt-summary-spacer"><td colspan="2"></td></tr>`;
    });

    panel.innerHTML = headerHTML + syncBarHTML + auditorBarHTML + assocBarHTML + `
      <div class="takt-summary-wrap">
        <div class="takt-summary-title">📅 Today — ${formatDateDisplay(today)} · Tap a process to begin or continue timing</div>
        <table class="takt-summary-table"><tbody>${rowsHTML}</tbody></table>
      </div>` + footerHTML;

    panel.querySelectorAll('.takt-summary-row').forEach(row => {
      row.onclick = () => {
        state.selectedProcess = row.dataset.process;
        state.selectedSubProcess = row.dataset.sub;
        state.selectedObs = null;
        state.view = 'table';
        ensureObservations();
        renderPanel();
      };
    });

    wireBaseEvents();
    wireHistoryEvents();
    updateSyncBadge();
  }

  // ═══════════════════════════════════════════════════════
  // RENDER — MAIN
  // ═══════════════════════════════════════════════════════
  function renderPanel() {
    if (state.view === 'history') { renderHistory(); return; }

    const assoc = getCurrentAssociate();
    const hasAssociate = assoc !== null;
    const config = getConfig();
    const TASKS = config.tasks;
    const TOTAL_TARGET = config.totalTarget;
    const showTargets = hasTargets(config);
    const observations = hasAssociate ? ensureObservations() : null;
    const obs = hasAssociate && state.selectedObs ? observations[state.selectedObs] : null;
    const tasksDone = obs ? obs.tasks.length : 0;
    const totalTasks = TASKS.length;
    const progress = (tasksDone/totalTasks)*100;
    const isComplete = obs && obs.total !== null;

    let subtitlePath = state.selectedProcess;
    const displaySub = getDisplaySubProcess();
    if (displaySub) subtitlePath += ' › ' + displaySub;
    if (hasAssociate) subtitlePath += ' › ' + assoc.name;

    const headerHTML = buildHeaderHTML(subtitlePath);
    const syncBarHTML = buildSyncBarHTML();
    const auditorBarHTML = buildAuditorBarHTML();
    const assocBarHTML = buildAssocBarHTML(assoc, state.isRunning);

    if (!hasAssociate) {
      panel.innerHTML = headerHTML + syncBarHTML + auditorBarHTML + assocBarHTML + `
        <div class="takt-empty-state">
          <div class="takt-empty-state-icon">👤</div>
          <div class="takt-empty-state-title">No Associate Selected</div>
          <div class="takt-empty-state-msg">Add an associate to begin the time study. All daily observations are automatically saved to their history.</div>
          <button class="takt-empty-state-btn" id="takt-empty-add">＋ Add Associate</button>
        </div>
        <div class="takt-footer"><div class="takt-footer-left"><button class="takt-footer-btn" id="takt-export-csv" disabled style="opacity:0.4;">📥 Export CSV</button><button class="takt-footer-btn" id="takt-copy-data" disabled style="opacity:0.4;">📋 Copy</button><button class="takt-footer-btn danger" id="takt-clear-all" ${appData.associates.length===0?'disabled style="opacity:0.4;"':''}>🗑 Clear All</button></div><div class="takt-footer-status">${appData.associates.length} associate(s) saved</div></div>`;
      wireBaseEvents();
      wireHistoryEvents();
      updateSyncBadge();
      return;
    }

    const footerHTML = `<div class="takt-footer"><div class="takt-footer-left"><button class="takt-footer-btn" id="takt-export-csv">📥 Export History CSV</button><button class="takt-footer-btn" id="takt-copy-data">📋 Copy</button><button class="takt-footer-btn danger" id="takt-clear-all">🗑 Clear All</button></div><div class="takt-footer-status">Associate ${state.currentAssociateIndex+1} of ${appData.associates.length}</div></div>`;

    if (state.view !== 'table') {
      renderSummary(headerHTML, syncBarHTML, auditorBarHTML, assocBarHTML, footerHTML);
      return;
    }

    const dockNote = config.dockNote ? `<span class="takt-dock-note">${escapeHtml(config.dockNote)}</span>` : '';
    const processBarHTML = `
      <div class="takt-process-bar">
        <button class="takt-back-btn" id="takt-back-to-summary">‹ Back</button>
        <span class="takt-process-arrow">›</span>
        <span style="font-size:13px;font-weight:800;color:#1e293b;">${state.selectedProcess}</span>
        ${hasSubPaths(state.selectedProcess) ? `<span class="takt-process-arrow">›</span><span style="font-size:13px;font-weight:700;color:#6366f1;">${state.selectedSubProcess}</span>` : ''}
        ${dockNote}
      </div>`;

    let pillsHTML = '';
    for (let i = 1; i <= NUM_OBS; i++) {
      const isSel = state.selectedObs === i;
      const isDone = observations[i].total !== null;
      let cls = isSel ? 'selected' : isDone ? 'completed' : '';
      let dis = state.isRunning && !isSel ? 'disabled style="opacity:0.4;pointer-events:none;"' : '';
      pillsHTML += `<button class="takt-obs-pill ${cls}" data-obs="${i}" ${dis}>Obs ${i}</button>`;
    }

    let btnClass = 'start-btn', btnText = '▶ START';
    let btnDisabled = !state.selectedObs || isComplete;
    if (state.isRunning && state.currentTaskIndex === -1) { btnClass = 'recording-btn'; btnText = '⏱ CLICK — Record Start Time'; btnDisabled = false; }
    else if (state.isRunning) { btnClass = 'recording-btn'; btnText = `⏱ CLICK — Record Task ${state.currentTaskIndex+1}/${totalTasks}`; btnDisabled = false; }

    const controlBarHTML = `
      <div class="takt-control-bar">
        <div class="takt-obs-pills">${pillsHTML}</div>
        <div class="takt-control-sep"></div>
        <button class="takt-btn-action ${btnClass}" id="takt-start-btn" ${btnDisabled?'disabled':''}>${btnText}</button>
        <button class="takt-btn-action clear-btn" id="takt-clear-btn" ${!state.selectedObs?'disabled style="opacity:0.4;"':''}>🔄 Clear</button>
      </div>`;

    let timerBarHTML = state.isRunning ? `
      <div class="takt-timer-bar">
        <div class="takt-rec-dot"></div>
        <div class="takt-live-timer recording" id="takt-timer-main">${formatElapsed(Date.now()-(state.lastClickTime||Date.now()))}</div>
        <div class="takt-timer-task-label">${state.currentTaskIndex >= 0 ? `Recording: <span class="task-name">${TASKS[state.currentTaskIndex].name}</span>` : 'Click button to record <span class="task-name">Start Time</span>'}</div>
      </div>` : `<div class="takt-timer-bar hidden"></div>`;

    let tableRowsHTML = '';
    tableRowsHTML += `<tr class="row-start-time"><td style="padding-left:24px;">⏰ Start Time</td><td class="target-col">—</td>`;
    for (let i = 1; i <= NUM_OBS; i++) {
      const o = observations[i]; const isA = state.selectedObs === i;
      tableRowsHTML += `<td class="obs-cell ${isA?'active-col':''}" style="font-size:11px;color:${o.startTime?'#6366f1':'#d1d5db'}">${o.startTime||'—'}</td>`;
    }
    tableRowsHTML += `</tr>`;

    TASKS.forEach((task, idx) => {
      const isCurrentTask = state.isRunning && state.currentTaskIndex === idx;
      tableRowsHTML += `<tr class="${isCurrentTask?'current-task-row':''}"><td style="padding-left:${isCurrentTask?'20px':'24px'};"><span style="color:#94a3b8;font-size:10px;font-weight:700;margin-right:6px;">${String(idx+1).padStart(2,'0')}</span>${task.name}</td><td class="target-col ${task.target>0?'':'no-target'}">${task.target>0?task.target+'s':'N/A'}</td>`;
      for (let i = 1; i <= NUM_OBS; i++) {
        const o = observations[i]; const isA = state.selectedObs === i; const val = o.tasks[idx];
        if (isCurrentTask && isA) { tableRowsHTML += `<td class="obs-cell current-cell" id="takt-live-cell">0s</td>`; }
        else if (val !== undefined) {
          const cellClass = task.target > 0 ? (val > task.target ? 'over' : 'good') : 'no-target-recorded';
          tableRowsHTML += `<td class="obs-cell ${cellClass}">${val}s</td>`;
        } else { tableRowsHTML += `<td class="obs-cell ${isA?'empty-active':'empty'}">—</td>`; }
      }
      tableRowsHTML += `</tr>`;
    });

    tableRowsHTML += `<tr class="row-end-time"><td style="padding-left:24px;">⏰ End Time</td><td class="target-col">—</td>`;
    for (let i = 1; i <= NUM_OBS; i++) {
      const o = observations[i]; const isA = state.selectedObs === i;
      tableRowsHTML += `<td class="obs-cell ${isA?'active-col':''}" style="font-size:11px;color:${o.endTime?'#6366f1':'#d1d5db'}">${o.endTime||'—'}</td>`;
    }
    tableRowsHTML += `</tr>`;

    tableRowsHTML += `<tr class="row-total"><td style="padding-left:24px;">📊 Total</td><td class="target-col" style="font-weight:800;color:#1e293b;">${showTargets?TOTAL_TARGET+'s':'N/A'}</td>`;
    for (let i = 1; i <= NUM_OBS; i++) {
      const o = observations[i];
      if (o.total !== null) {
        const cls = showTargets ? (o.total <= TOTAL_TARGET ? 'good' : 'over') : 'no-target-recorded';
        tableRowsHTML += `<td class="obs-cell ${cls}">${o.total}s</td>`;
      } else { tableRowsHTML += `<td class="obs-cell empty">—</td>`; }
    }
    tableRowsHTML += `</tr>`;

    let obsHeadersHTML = '';
    for (let i = 1; i <= NUM_OBS; i++) obsHeadersHTML += `<th class="obs-header ${state.selectedObs===i?'active':''}">Obs ${i}</th>`;

    const tableHTML = `<div class="takt-table-wrap"><table class="takt-table"><thead><tr><th>Task</th><th>Target</th>${obsHeadersHTML}</tr></thead><tbody>${tableRowsHTML}</tbody></table></div>`;

    const coachingCollapsed = !state.coachingExpanded;
    const coachingHTML = `
      <div class="takt-coaching-section">
        <div class="takt-coaching-header" id="takt-coaching-toggle">
          <div class="takt-coaching-title">📝 Coaching Provided</div>
          <div class="takt-coaching-toggle">${coachingCollapsed?'▼ Expand':'▲ Collapse'}</div>
        </div>
        <div class="takt-coaching-body ${coachingCollapsed?'collapsed':'expanded'}">
          <textarea class="takt-coaching-textarea" id="takt-coaching-notes" placeholder="Enter coaching notes for ${escapeHtml(assoc.name)}...">${escapeHtml(assoc.coachingNotes)}</textarea>
        </div>
      </div>`;

    const progressHTML = `<div class="takt-progress-section ${!state.selectedObs||(!state.isRunning&&!isComplete&&tasksDone===0)?'hidden':''}"><div class="takt-progress-bar-bg"><div class="takt-progress-bar-fill" style="width:${progress}%"></div></div><div class="takt-progress-text">${tasksDone}/${totalTasks} Tasks (${Math.round(progress)}%)</div></div>`;

    let statusText = 'Select an observation to begin';
    if (state.isRunning) statusText = `Recording Obs ${state.selectedObs} — Task ${(obs?obs.tasks.length:0)+(state.currentTaskIndex>=0?1:0)} of ${totalTasks}`;
    else if (isComplete) statusText = `✅ Obs ${state.selectedObs} complete — ${obs.total}s`;
    else if (state.selectedObs && tasksDone > 0) statusText = `Obs ${state.selectedObs} — ${tasksDone}/${totalTasks} tasks`;
    else if (state.selectedObs) statusText = `Obs ${state.selectedObs} selected — Ready`;

    const tableFooterHTML = `<div class="takt-footer"><div class="takt-footer-left"><button class="takt-footer-btn" id="takt-export-csv">📥 Export History CSV</button><button class="takt-footer-btn" id="takt-copy-data">📋 Copy</button><button class="takt-footer-btn danger" id="takt-clear-all">🗑 Clear All</button></div><div class="takt-footer-status">${statusText} · Associate ${state.currentAssociateIndex+1} of ${appData.associates.length}</div></div>`;

    panel.innerHTML = headerHTML + syncBarHTML + auditorBarHTML + assocBarHTML + processBarHTML + controlBarHTML + timerBarHTML + tableHTML + coachingHTML + progressHTML + tableFooterHTML;

    wireBaseEvents();
    wireAssociateEvents();
    wireHistoryEvents();
    updateSyncBadge();
  }

  // ═══════════════════════════════════════════════════════
  // WIRE EVENTS
  // ═══════════════════════════════════════════════════════
  function wireBaseEvents() {
    const closeBtn = document.getElementById('takt-close');
    const minBtn = document.getElementById('takt-minimize');
    if (closeBtn) closeBtn.onclick = togglePanel;
    if (minBtn) minBtn.onclick = togglePanel;

    const audNameInput = document.getElementById('takt-auditor-name');
    const audLoginInput = document.getElementById('takt-auditor-login');
    if (audNameInput) audNameInput.oninput = (e) => { appData.auditorName = e.target.value; saveAuditorLocally(); };
    if (audLoginInput) audLoginInput.oninput = (e) => { appData.auditorLogin = e.target.value; saveAuditorLocally(); };

    const searchBtn = document.getElementById('takt-search-assoc');
    const addBtn = document.getElementById('takt-add-assoc');
    const emptyAddBtn = document.getElementById('takt-empty-add');
    const syncNowBtn = document.getElementById('takt-sync-now');
    if (searchBtn) searchBtn.onclick = () => showSearchOverlay();
    if (addBtn) addBtn.onclick = () => showAddForm();
    if (emptyAddBtn) emptyAddBtn.onclick = () => showAddForm();
    if (syncNowBtn) syncNowBtn.onclick = () => { showToast('↺ Syncing with SharePoint...'); syncFromSheets(); };

    const prevBtn = document.getElementById('takt-nav-prev');
    const nextBtn = document.getElementById('takt-nav-next');
    if (prevBtn) prevBtn.onclick = () => navigateAssociate(-1);
    if (nextBtn) nextBtn.onclick = () => navigateAssociate(1);

    const deleteBtn = document.getElementById('takt-delete-assoc');
    if (deleteBtn) deleteBtn.onclick = handleDeleteAssociate;

    const exportBtn = document.getElementById('takt-export-csv');
    const copyBtn = document.getElementById('takt-copy-data');
    const clearAllBtn = document.getElementById('takt-clear-all');
    if (exportBtn) exportBtn.onclick = exportCSV;
    if (copyBtn) copyBtn.onclick = copyData;
    if (clearAllBtn) clearAllBtn.onclick = handleClearAll;

    initDrag();
  }

  function wireAssociateEvents() {
    const backBtn = document.getElementById('takt-back-to-summary');
    if (backBtn) backBtn.onclick = () => { if (state.isRunning) return; state.view = 'summary'; state.selectedObs = null; renderPanel(); };

    panel.querySelectorAll('.takt-obs-pill').forEach(btn => {
      btn.onclick = () => {
        if (state.isRunning && state.selectedObs !== parseInt(btn.dataset.obs)) return;
        state.selectedObs = parseInt(btn.dataset.obs);
        renderPanel();
      };
    });

    const startBtn = document.getElementById('takt-start-btn');
    const clearBtn = document.getElementById('takt-clear-btn');
    if (startBtn) startBtn.onclick = handleStartStop;
    if (clearBtn) clearBtn.onclick = handleClear;

    const coachToggle = document.getElementById('takt-coaching-toggle');
    const coachNotes = document.getElementById('takt-coaching-notes');
    if (coachToggle) coachToggle.onclick = () => { state.coachingExpanded = !state.coachingExpanded; renderPanel(); };
    if (coachNotes) coachNotes.oninput = (e) => { const assoc = getCurrentAssociate(); if (assoc) { assoc.coachingNotes = e.target.value; saveData(); } };
  }

  // ═══════════════════════════════════════════════════════
  // SEARCH OVERLAY
  // ═══════════════════════════════════════════════════════
  function showSearchOverlay() {
    const existing = document.getElementById('takt-search-overlay');
    if (existing) { existing.remove(); return; }
    const bar = document.getElementById('takt-associate-bar');
    if (!bar) return;

    const overlay = document.createElement('div');
    overlay.className = 'takt-search-overlay';
    overlay.id = 'takt-search-overlay';

    function buildResults(query) {
      const q = query.toLowerCase().trim();
      const filtered = appData.associates.filter(a => a.name.toLowerCase().includes(q) || a.login.toLowerCase().includes(q));
      if (filtered.length === 0) return `<div class="takt-search-no-results">No associates found matching "${escapeHtml(query)}"</div>`;
      return filtered.map(a => {
        const realIdx = appData.associates.indexOf(a);
        const isActive = realIdx === state.currentAssociateIndex;
        const totalObs = getTotalHistoricalObs(a);
        return `<div class="takt-search-result ${isActive?'active':''}" data-index="${realIdx}">
          <div class="takt-search-result-avatar">${getInitials(a.name)}</div>
          <div class="takt-search-result-info">
            <div class="takt-search-result-name">${escapeHtml(a.name)}</div>
            <div class="takt-search-result-login">${escapeHtml(a.login)} · ${totalObs} total obs</div>
          </div>
        </div>`;
      }).join('');
    }

    overlay.innerHTML = `
      <div class="takt-search-input-wrap">
        <svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
        <input class="takt-search-input" id="takt-search-input" placeholder="Search by name or login..." autofocus />
      </div>
      <div class="takt-search-results" id="takt-search-results">${buildResults('')}</div>
      <div class="takt-search-add-new" id="takt-search-add-new">＋ Add new associate</div>`;

    bar.appendChild(overlay);
    const input = document.getElementById('takt-search-input');
    const resultsContainer = document.getElementById('takt-search-results');
    input.focus();
    input.oninput = () => { resultsContainer.innerHTML = buildResults(input.value); wireSearchResults(); };

    function wireSearchResults() {
      resultsContainer.querySelectorAll('.takt-search-result').forEach(el => {
        el.onclick = () => {
          state.currentAssociateIndex = parseInt(el.dataset.index);
          state.selectedObs = null;
          state.view = 'summary';
          overlay.remove();
          renderPanel();
          showToast(`👤 Switched to ${appData.associates[parseInt(el.dataset.index)].name}`);
        };
      });
    }
    wireSearchResults();
    document.getElementById('takt-search-add-new').onclick = () => { overlay.remove(); showAddForm(input.value); };
    setTimeout(() => {
      const closeHandler = (e) => {
        if (!overlay.contains(e.target) && e.target.id !== 'takt-search-assoc') { overlay.remove(); document.removeEventListener('click', closeHandler); }
      };
      document.addEventListener('click', closeHandler);
    }, 100);
  }

  // ═══════════════════════════════════════════════════════
  // ADD FORM
  // ═══════════════════════════════════════════════════════
  function showAddForm(prefillName) {
    const existing = document.querySelector('.takt-add-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'takt-add-overlay';
    overlay.innerHTML = `
      <div class="takt-add-form">
        <div class="takt-add-form-title">👤 Add New Associate</div>
        <div class="takt-add-form-sub">Enter the associate's details to start their time study.</div>
        <div class="takt-add-field"><label>Associate Name</label><input id="takt-add-name" placeholder="e.g. Jane Doe" value="${escapeHtml(prefillName||'')}" /><div class="takt-add-warn" id="takt-name-warn">⚠ Name matches current auditor name</div></div>
        <div class="takt-add-field"><label>Associate Login</label><input id="takt-add-login" placeholder="e.g. jdoe" /><div class="takt-add-warn" id="takt-login-warn">⚠ Login already exists</div></div>
        <div class="takt-add-btns"><button class="takt-add-cancel" id="takt-add-cancel">Cancel</button><button class="takt-add-submit" id="takt-add-submit" disabled>Add Associate</button></div>
      </div>`;
    panel.appendChild(overlay);

    const nameInput = document.getElementById('takt-add-name');
    const loginInput = document.getElementById('takt-add-login');
    const submitBtn = document.getElementById('takt-add-submit');
    const nameWarn = document.getElementById('takt-name-warn');
    const loginWarn = document.getElementById('takt-login-warn');
    nameInput.focus();

    function validateForm() {
      const nameVal = nameInput.value.trim();
      const loginVal = loginInput.value.trim();
      nameWarn.style.display = (nameVal && appData.auditorName && nameVal.toLowerCase() === appData.auditorName.toLowerCase()) ? 'block' : 'none';
      const dupLogin = appData.associates.find(a => a.login.toLowerCase() === loginVal.toLowerCase());
      loginWarn.style.display = (loginVal && dupLogin) ? 'block' : 'none';
      submitBtn.disabled = !(nameVal.length > 0 && loginVal.length > 0 && !dupLogin);
    }

    nameInput.oninput = validateForm;
    loginInput.oninput = validateForm;
    validateForm();
    document.getElementById('takt-add-cancel').onclick = () => overlay.remove();
    submitBtn.onclick = () => {
      const result = addAssociate(nameInput.value, loginInput.value);
      if (result !== false) { overlay.remove(); renderPanel(); showToast(`👤 Added ${nameInput.value.trim()}`); }
    };
    loginInput.onkeydown = (e) => { if (e.key === 'Enter' && !submitBtn.disabled) submitBtn.click(); };
    nameInput.onkeydown = (e) => { if (e.key === 'Enter') loginInput.focus(); };
  }

  // ═══════════════════════════════════════════════════════
  // DELETE
  // ═══════════════════════════════════════════════════════
  function handleDeleteAssociate() {
    const assoc = getCurrentAssociate();
    if (!assoc || state.isRunning) return;
    showConfirm(`Remove ${assoc.name}?`, `ALL historical observations for this associate will be permanently deleted.`, () => {
      appData.associates.splice(state.currentAssociateIndex, 1);
      state.currentAssociateIndex = appData.associates.length === 0 ? -1 : Math.min(state.currentAssociateIndex, appData.associates.length-1);
      state.selectedObs = null;
      saveData(); renderPanel();
      showToast(`🗑 ${assoc.name} removed`);
    });
  }

  // ═══════════════════════════════════════════════════════
  // DRAG
  // ═══════════════════════════════════════════════════════
  function initDrag() {
    const handle = document.getElementById('takt-drag-handle');
    if (!handle) return;
    handle.onmousedown = (e) => {
      if (e.target.closest('.takt-header-btn')) return;
      state.isDragging = true;
      const rect = panel.getBoundingClientRect();
      state.dragOffset.x = e.clientX - rect.left;
      state.dragOffset.y = e.clientY - rect.top;
      panel.style.transition = 'none';
    };
    document.onmousemove = (e) => {
      if (!state.isDragging) return;
      panel.style.left = (e.clientX - state.dragOffset.x) + 'px';
      panel.style.top = (e.clientY - state.dragOffset.y) + 'px';
      panel.style.transform = 'scale(1)';
    };
    document.onmouseup = () => {
      if (state.isDragging) { state.isDragging = false; panel.style.transition = 'all 0.35s cubic-bezier(0.4,0,0.2,1)'; }
    };
  }

  // ═══════════════════════════════════════════════════════
  // START / RECORD
  // ═══════════════════════════════════════════════════════
  function handleStartStop() {
    if (!state.selectedObs || !getCurrentAssociate()) return;
    const config = getConfig();
    const TASKS = config.tasks;
    const TOTAL_TARGET = config.totalTarget;
    const showTargets = hasTargets(config);
    const observations = getObs();
    const obs = observations[state.selectedObs];

    if (!state.isRunning && obs.total === null) {
      state.isRunning = true; state.currentTaskIndex = -1; state.lastClickTime = Date.now();
      fab.classList.add('active'); startElapsedTimer(); renderPanel(); return;
    }

    if (state.isRunning && state.currentTaskIndex === -1) {
      obs.startTime = formatTime(new Date()); state.currentTaskIndex = 0; state.lastClickTime = Date.now();
      saveData(); renderPanel(); return;
    }

    if (state.isRunning && state.currentTaskIndex >= 0) {
      const now = Date.now();
      const elapsed = Math.round((now - state.lastClickTime) / 1000);
      obs.tasks.push(elapsed);
      state.lastClickTime = now;

      if (obs.tasks.length >= TASKS.length) {
        obs.endTime = formatTime(new Date());
        obs.total = obs.tasks.reduce((a,b) => a+b, 0);
        const currentAssoc = getCurrentAssociate();
        if (currentAssoc && appData.auditorLogin) currentAssoc.lastObservedBy = appData.auditorLogin;
        state.isRunning = false; state.currentTaskIndex = -1;
        fab.classList.remove('active'); stopElapsedTimer();
        updateBadge(); saveData();
        const diff = obs.total - TOTAL_TARGET;
        if (showTargets) showToast(diff <= 0 ? `✅ Obs ${state.selectedObs} complete! ${Math.abs(diff)}s under target` : `⚠️ Obs ${state.selectedObs} complete! ${diff}s over target`);
        else showToast(`✅ Obs ${state.selectedObs} complete! ${obs.total}s total`);
      } else {
        state.currentTaskIndex = obs.tasks.length;
        saveData();
      }
      renderPanel();
    }
  }

  // ═══════════════════════════════════════════════════════
  // LIVE TIMER
  // ═══════════════════════════════════════════════════════
  function startElapsedTimer() {
    stopElapsedTimer();
    state.elapsedInterval = setInterval(() => {
      const timerEl = document.getElementById('takt-timer-main');
      const cellEl = document.getElementById('takt-live-cell');
      if (state.lastClickTime) {
        const elapsed = Date.now() - state.lastClickTime;
        if (timerEl) timerEl.textContent = formatElapsed(elapsed);
        if (cellEl) cellEl.textContent = Math.round(elapsed/1000) + 's';
      }
    }, 50);
  }

  function stopElapsedTimer() {
    if (state.elapsedInterval) { clearInterval(state.elapsedInterval); state.elapsedInterval = null; }
  }

  // ═══════════════════════════════════════════════════════
  // CLEAR
  // ═══════════════════════════════════════════════════════
  function handleClear() {
    if (!state.selectedObs || !getCurrentAssociate()) return;
    showConfirm(`Clear Observation ${state.selectedObs}?`, 'All recorded times for this observation will be deleted.', () => {
      if (state.isRunning) { state.isRunning = false; state.currentTaskIndex = -1; fab.classList.remove('active'); stopElapsedTimer(); }
      getObs()[state.selectedObs] = { startTime: null, endTime: null, tasks: [], total: null };
      updateBadge(); saveData(); renderPanel();
      showToast(`🔄 Observation ${state.selectedObs} cleared`);
    });
  }

  function handleClearAll() {
    if (appData.associates.length === 0) return;
    showConfirm('Clear ALL Data?', 'All associates, ALL historical observations, and coaching notes will be permanently deleted.', () => {
      state.isRunning = false; state.currentTaskIndex = -1;
      fab.classList.remove('active'); stopElapsedTimer();
      appData.associates = []; appData.auditorName = ''; appData.auditorLogin = '';
      state.currentAssociateIndex = -1; state.selectedObs = null;
      updateBadge(); saveData(); renderPanel();
      showToast('🗑 All data cleared');
    });
  }

  function showConfirm(title, msg, onConfirm) {
    const overlay = document.createElement('div');
    overlay.className = 'takt-confirm-overlay';
    overlay.innerHTML = `<div class="takt-confirm-box"><div class="takt-confirm-icon">⚠️</div><div class="takt-confirm-title">${title}</div><div class="takt-confirm-msg">${msg}</div><div class="takt-confirm-btns"><button class="takt-confirm-cancel" id="takt-cfm-no">Cancel</button><button class="takt-confirm-ok" id="takt-cfm-yes">Confirm</button></div></div>`;
    panel.appendChild(overlay);
    document.getElementById('takt-cfm-no').onclick = () => overlay.remove();
    document.getElementById('takt-cfm-yes').onclick = () => { overlay.remove(); onConfirm(); };
  }

  // ═══════════════════════════════════════════════════════
  // EXPORT — Full Historical CSV
  // ═══════════════════════════════════════════════════════
  function exportCSV() {
    const assoc = getCurrentAssociate();
    if (!assoc) return;

    const today = todayKey();
    let csv = `SNA4 Takt Time Study — Historical Export\n`;
    csv += `Auditor,${appData.auditorName},Login,${appData.auditorLogin}\n`;
    csv += `Associate,${assoc.name},Login,${assoc.login}\n`;
    csv += `Export Date,${new Date().toLocaleDateString()}\n\n`;

    // ── Section 1: All-Time Averages ──
    const overallAvgs = computeOverallAverages(assoc);
    csv += `ALL-TIME AVERAGES\n`;
    csv += `Process,Sub-Process,Task,Target,Average Time,vs Target,Obs Count,Days Observed\n`;

    Object.entries(overallAvgs).forEach(([key, data]) => {
      const [process, sub] = key.split('__');
      const config = PROCESS_PATHS[process] && PROCESS_PATHS[process][sub];
      if (!config) return;
      config.tasks.forEach((task, idx) => {
        const avg = data.taskAverages[idx];
        const vs = avg !== null && task.target > 0 ? avg - task.target : '';
        csv += `"${data.process}","${data.sub}","${task.name}",${task.target > 0 ? task.target : 'N/A'},${avg !== null ? avg : ''},${vs !== '' ? vs : 'N/A'},${data.totalObsCount},${data.daysObserved}\n`;
      });
      const vs = data.vsTarget !== null ? data.vsTarget : 'N/A';
      const tgt = data.target > 0 ? data.target : 'N/A';
      csv += `"${data.process}","${data.sub}","📊 TOTAL",${tgt},${data.totalAvg},${vs},${data.totalObsCount},${data.daysObserved}\n`;
    });
    csv += `\n`;

    // ── Section 2: Daily Averages by Date ──
    csv += `DAILY AVERAGES BY DATE\n`;
    csv += `Date,Process,Sub-Process,Task,Target,Average Time,vs Target,Obs Count\n`;

    const dates = getAssociateDates(assoc).reverse(); // chronological order
    dates.forEach(dateKey => {
      const dayAvgs = computeDayAverages(assoc, dateKey);
      Object.entries(dayAvgs).forEach(([key, data]) => {
        const [process, sub] = key.split('__');
        const config = PROCESS_PATHS[process] && PROCESS_PATHS[process][sub];
        if (!config) return;
        const dateLabel = formatDateDisplay(dateKey) + (dateKey === today ? ' (Today)' : '');
        config.tasks.forEach((task, idx) => {
          const avg = data.taskAverages[idx];
          const vs = avg !== null && task.target > 0 ? avg - task.target : '';
          csv += `"${dateLabel}","${data.process}","${data.sub}","${task.name}",${task.target > 0 ? task.target : 'N/A'},${avg !== null ? avg : ''},${vs !== '' ? vs : 'N/A'},${data.obsCount}\n`;
        });
        const vs = data.vsTarget !== null ? data.vsTarget : 'N/A';
        const tgt = data.target > 0 ? data.target : 'N/A';
        csv += `"${dateLabel}","${data.process}","${data.sub}","📊 TOTAL",${tgt},${data.totalAvg},${vs},${data.obsCount}\n`;
      });
    });
    csv += `\n`;

    // ── Section 3: Raw observation data ──
    csv += `RAW OBSERVATION DATA\n`;
    dates.forEach(dateKey => {
      const dayData = assoc.history[dateKey];
      if (!dayData) return;
      const dateLabel = formatDateDisplay(dateKey) + (dateKey === today ? ' (Today)' : '');

      Object.entries(dayData).forEach(([key, obsSet]) => {
        const [process, sub] = key.split('__');
        const config = PROCESS_PATHS[process] && PROCESS_PATHS[process][sub];
        if (!config) return;
        const completedObs = Object.values(obsSet).filter(o => o.total !== null);
        if (completedObs.length === 0) return;

        csv += `\n"${dateLabel}","${data ? data.process : process}","${sub === '_default' ? process : sub}"\n`;
        csv += `Task,Target`;
        for (let i = 1; i <= NUM_OBS; i++) csv += `,Obs ${i}`;
        csv += `,Average\n`;

        csv += `Start Time,—`;
        for (let i = 1; i <= NUM_OBS; i++) csv += `,${obsSet[i] ? obsSet[i].startTime || '' : ''}`;
        csv += `,\n`;

        config.tasks.forEach((task, idx) => {
          const vals = [];
          for (let i = 1; i <= NUM_OBS; i++) {
            const v = obsSet[i] && obsSet[i].tasks[idx] !== undefined ? obsSet[i].tasks[idx] : '';
            vals.push(v);
          }
          const numericVals = vals.filter(v => v !== '');
          const avg = numericVals.length > 0 ? Math.round(numericVals.reduce((a,b) => a+b, 0) / numericVals.length) : '';
          csv += `"${task.name}",${task.target > 0 ? task.target : 'N/A'},${vals.join(',')},${avg}\n`;
        });

        csv += `End Time,—`;
        for (let i = 1; i <= NUM_OBS; i++) csv += `,${obsSet[i] ? obsSet[i].endTime || '' : ''}`;
        csv += `,\n`;

        csv += `Total,${config.totalTarget > 0 ? config.totalTarget : 'N/A'}`;
        const totals = [];
        for (let i = 1; i <= NUM_OBS; i++) {
          const t = obsSet[i] && obsSet[i].total !== null ? obsSet[i].total : '';
          totals.push(t);
          csv += `,${t}`;
        }
        const numericTotals = totals.filter(t => t !== '');
        const avgTotal = numericTotals.length > 0 ? Math.round(numericTotals.reduce((a,b) => a+b, 0) / numericTotals.length) : '';
        csv += `,${avgTotal}\n`;
      });
    });

    if (assoc.coachingNotes) csv += `\nCoaching Notes\n"${assoc.coachingNotes.replace(/"/g,'""')}"\n`;

    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `TaktHistory_${assoc.name.replace(/\s+/g,'_')}_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    showToast('📥 Full history CSV downloaded');
  }

  function copyData() {
    const assoc = getCurrentAssociate();
    if (!assoc) return;
    const overallAvgs = computeOverallAverages(assoc);
    const today = todayKey();

    let text = `TAKT TIME STUDY — SNA4\nAuditor: ${appData.auditorName} (${appData.auditorLogin})\nAssociate: ${assoc.name} (${assoc.login})\nDate: ${new Date().toLocaleString()}\n\n`;

    text += `── ALL-TIME AVERAGES ──\n`;
    Object.entries(overallAvgs).forEach(([key, data]) => {
      text += `${data.process} › ${data.sub}: ${data.totalAvg}s avg`;
      if (data.target > 0) text += ` (target: ${data.target}s, ${data.vsTarget <= 0 ? '✅ '+Math.abs(data.vsTarget)+'s under' : '⚠️ '+data.vsTarget+'s over'})`;
      text += ` · ${data.totalObsCount} obs, ${data.daysObserved} days\n`;
    });

    text += `\n── TODAY (${formatDateDisplay(today)}) ──\n`;
    const dayAvgs = computeDayAverages(assoc, today);
    if (Object.keys(dayAvgs).length === 0) text += `No completed observations today\n`;
    else Object.entries(dayAvgs).forEach(([key, data]) => {
      text += `${data.process} › ${data.sub}: ${data.totalAvg}s avg (${data.obsCount} obs)`;
      if (data.vsTarget !== null) text += ` ${data.vsTarget <= 0 ? '✅':'⚠️'} ${data.vsTarget <= 0 ? Math.abs(data.vsTarget)+'s under':'data.vsTarget+'s over'} target`;
      text += '\n';
    });

    if (assoc.coachingNotes) text += `\n── Coaching Notes ──\n${assoc.coachingNotes}\n`;

    navigator.clipboard.writeText(text);
    showToast('📋 Summary copied to clipboard');
  }

  // ═══════════════════════════════════════════════════════
  // BADGE
  // ═══════════════════════════════════════════════════════
  function updateBadge() {
    let totalCompleted = 0;
    appData.associates.forEach(assoc => {
      if (!assoc.history) return;
      Object.values(assoc.history).forEach(dayData => {
        Object.values(dayData).forEach(obsSet => {
          for (let i = 1; i <= NUM_OBS; i++) { if (obsSet[i] && obsSet[i].total !== null) totalCompleted++; }
        });
      });
    });
    const badge = document.getElementById('takt-badge');
    if (totalCompleted > 0) { badge.style.display = 'flex'; badge.textContent = totalCompleted; }
    else badge.style.display = 'none';
  }

  // ═══════════════════════════════════════════════════════
  // TOGGLE
  // ═══════════════════════════════════════════════════════
  function togglePanel() {
    state.isOpen = !state.isOpen;
    if (state.isOpen) {
      renderPanel();
      panel.classList.add('open');
      backdrop.classList.add('open');
      panel.style.left = '50%';
      panel.style.top = '50%';
      panel.style.transform = 'translate(-50%, -50%) scale(1)';
    } else {
      panel.classList.remove('open');
      backdrop.classList.remove('open');
    }
  }

  fab.onclick = togglePanel;
  backdrop.onclick = (e) => { if (e.target === backdrop && !state.isRunning) togglePanel(); };

  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.key === 't') { e.preventDefault(); togglePanel(); }
    if (e.code === 'Space' && state.isOpen && state.isRunning) {
      const tag = document.activeElement.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') { e.preventDefault(); handleStartStop(); }
    }
    if (e.key === 'Escape' && state.isOpen) {
      const searchOverlay = document.getElementById('takt-search-overlay');
      const addOverlay = document.querySelector('.takt-add-overlay');
      if (searchOverlay) { searchOverlay.remove(); return; }
      if (addOverlay) { addOverlay.remove(); return; }
      if (!state.isRunning) togglePanel();
    }
    if (state.isOpen && !state.isRunning && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); navigateAssociate(-1); }
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); navigateAssociate(1); }
    }
  });

  // ═══════════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════════
  loadData();
  updateBadge();
  checkForUpdate();

  setInterval(() => { if (state.isOpen && !state.isRunning) syncFromSheets(); }, 60000);

  console.log('✅ SNA4 Takt Time Study Timer v11.0 loaded — Daily history tracking enabled! Alt+T to open.');
})();
