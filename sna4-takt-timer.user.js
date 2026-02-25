// ==UserScript==
// @name         SNA4 Takt Time Study Timer
// @namespace    http://tampermonkey.net/
// @version      11.4
// @description  Floating time study timer with SharePoint database — editable targets + blocking updates
// @match        https://ramdos.org/*
// @match        https://fclm-portal.amazon.com/*
// @grant        GM_xmlhttpRequest
// @connect      amazon.sharepoint.com
// @connect      raw.githubusercontent.com
// @updateURL    https://raw.githubusercontent.com/Srinivas524/sna4-takt-timer/main/sna4-takt-timer.user.js
// @downloadURL  https://raw.githubusercontent.com/Srinivas524/sna4-takt-timer/main/sna4-takt-timer.user.js
// ==/UserScript==

(function () {
  'use strict';

  var SP_SITE = 'https://amazon.sharepoint.com/sites/TackAnalysis';
  var SP_LISTS = {
    associates: { guid: '9641b5b6-860a-40ad-898a-52224e6a68a3', type: null },
    observations: { guid: 'fc8a85eb-97e7-48e0-b02a-be81e072a1d1', type: null },
    dailySummaries: { guid: '3ccf4961-ff7f-4cad-b677-f68be5d8fbbe', type: null },
    processAvgs: { guid: '5768158e-ac61-49fe-823f-3306a3767d67', type: null }
  };
  var SP_READY = false;
  var CURRENT_VERSION = '11.4';
  var CONFIG_ROW_KEY = '__CONFIG__TARGETS';

  // ── VERSION CHECK (UPDATED — triggers when remote !== local) ──
  var GITHUB_RAW_URL = 'https://raw.githubusercontent.com/Srinivas524/sna4-takt-timer/main/sna4-takt-timer.user.js';

  function parseVersionFromScript(text) {
    var match = text.match(/@version\s+([\d.]+)/);
    return match ? match[1] : null;
  }

  function checkForUpdate() {
    GM_xmlhttpRequest({
      method: 'GET',
      url: GITHUB_RAW_URL + '?_=' + Date.now(),
      headers: { 'Cache-Control': 'no-cache' },
      onload: function (res) {
        if (res.status !== 200) return;
        var remoteVersion = parseVersionFromScript(res.responseText);
        if (remoteVersion && remoteVersion !== CURRENT_VERSION) {
          showUpdateModal(remoteVersion);
        }
      },
      onerror: function () {}
    });
  }

  // ── BLOCKING UPDATE MODAL (REWRITTEN — full-screen, no escape) ──
  var updateEscBlocker = null;

  function showUpdateModal(remoteVersion) {
    var skipped = null;
    try { skipped = localStorage.getItem('sna4_skipped_version'); } catch (e) {}
    if (skipped === remoteVersion) return;
    if (document.getElementById('takt-update-modal')) return;

    updateEscBlocker = function (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }
    };
    document.addEventListener('keydown', updateEscBlocker, true);

    var overlay = document.createElement('div');
    overlay.id = 'takt-update-modal';
    overlay.className = 'takt-update-fullscreen';
    overlay.innerHTML =
      '<div class="takt-update-box">' +
        '<div class="takt-update-icon">🚀</div>' +
        '<div class="takt-update-title">Update Available</div>' +
        '<div class="takt-update-versions">' +
          '<span class="takt-update-ver-old">v' + CURRENT_VERSION + '</span>' +
          '<span class="takt-update-ver-arrow">→</span>' +
          '<span class="takt-update-ver-new">v' + remoteVersion + '</span>' +
        '</div>' +
        '<div class="takt-update-msg">A new version of the Takt Time Study Timer is available. ' +
          'Click <strong>Update Now</strong> to install it — Tampermonkey will confirm before making any changes.</div>' +
        '<div class="takt-update-steps">' +
          '<div class="takt-update-step"><span class="takt-update-step-num">1</span>Click Update Now below</div>' +
          '<div class="takt-update-step"><span class="takt-update-step-num">2</span>Tampermonkey opens — click "Update"</div>' +
          '<div class="takt-update-step"><span class="takt-update-step-num">3</span>Done — reload this page</div>' +
        '</div>' +
        '<div class="takt-update-safe">' +
          '<span class="takt-update-safe-icon">🔒</span> ' +
          '<strong>Your data is safe.</strong> All observations, summaries, and associate records are stored in SharePoint ' +
          'and will not be affected by this update.' +
        '</div>' +
        '<div class="takt-update-btns">' +
          '<button class="takt-update-skip" id="takt-update-later">Later</button>' +
          '<button class="takt-update-go" id="takt-update-go">🚀 Update Now</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);

    document.getElementById('takt-update-go').onclick = function () {
      window.open(GITHUB_RAW_URL, '_blank');
      removeUpdateModal();
    };
    document.getElementById('takt-update-later').onclick = function () {
      try { localStorage.setItem('sna4_skipped_version', remoteVersion); } catch (e) {}
      removeUpdateModal();
    };
  }

  function removeUpdateModal() {
    var modal = document.getElementById('takt-update-modal');
    if (modal) modal.remove();
    if (updateEscBlocker) {
      document.removeEventListener('keydown', updateEscBlocker, true);
      updateEscBlocker = null;
    }
  }

  // ── AUTO-SYNC ──────────────────────────────────────────
  var autoSyncInterval = null;
  var AUTO_SYNC_MS = 30000;

  function startAutoSync() {
    stopAutoSync();
    autoSyncInterval = setInterval(function () {
      if (!state.isOpen || state.isRunning || state.loading) return;
      var assoc = getCurrentAssociate();
      if (!assoc) return;
      if (state.view === 'table') {
        Promise.all([
          loadObservationsForDay(assoc.login, state.currentDate, state.selectedProcess, state.selectedSubProcess),
          loadDailySummary(assoc.login, state.currentDate, state.selectedProcess, state.selectedSubProcess),
          loadProcessAverage(state.selectedProcess, state.selectedSubProcess, state.currentDate)
        ]).then(function (results) {
          var newSets = results[0];
          var newSummary = results[1];
          var newAvg = results[2];
          if (JSON.stringify(newSets) !== JSON.stringify(state.sets) ||
              JSON.stringify(newSummary) !== JSON.stringify(state.dailySummary) ||
              JSON.stringify(newAvg) !== JSON.stringify(state.processAvg)) {
            state.sets = newSets;
            state.dailySummary = newSummary;
            state.processAvg = newAvg;
            renderPanel();
            showSyncPulse();
          }
        }).catch(function () {});
      } else {
        loadAssociateSummariesForDate(assoc.login, state.currentDate).then(function (summaries) {
          if (JSON.stringify(summaries) !== JSON.stringify(state.daySummaries)) {
            state.daySummaries = summaries;
            renderPanel();
            showSyncPulse();
          }
        }).catch(function () {});
      }
    }, AUTO_SYNC_MS);
  }

  function stopAutoSync() {
    if (autoSyncInterval) { clearInterval(autoSyncInterval); autoSyncInterval = null; }
  }

  function showSyncPulse() {
    var el = document.getElementById('takt-sync-dot');
    if (!el) return;
    el.classList.add('pulse');
    setTimeout(function () { el.classList.remove('pulse'); }, 1000);
  }

  // ── SHAREPOINT INIT ────────────────────────────────────
  function spUrl(listKey) {
    return SP_SITE + "/_api/web/lists(guid'" + SP_LISTS[listKey].guid + "')";
  }

  function initSharePoint() {
    var keys = Object.keys(SP_LISTS);
    var promises = [];
    for (var i = 0; i < keys.length; i++) {
      (function (key) {
        var p = new Promise(function (resolve, reject) {
          GM_xmlhttpRequest({
            method: 'GET',
            url: spUrl(key) + '?$select=ListItemEntityTypeFullName',
            headers: { 'Accept': 'application/json;odata=verbose' },
            onload: function (res) {
              try { var data = JSON.parse(res.responseText); SP_LISTS[key].type = data.d.ListItemEntityTypeFullName; resolve(); }
              catch (e) { reject(e); }
            },
            onerror: function (err) { reject(err); }
          });
        });
        promises.push(p);
      })(keys[i]);
    }
    return Promise.all(promises).then(function () {
      SP_READY = true;
      return true;
    }).catch(function (err) {
      SP_READY = false;
      return false;
    });
  }

  // ── DATE HELPERS ───────────────────────────────────────
  function getTodayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function dateForSP(dateStr) { return dateStr + 'T00:00:00Z'; }
  function dateFromSP(spDate) { if (!spDate) return null; return spDate.substring(0, 10); }
  function isToday(dateStr) { return dateStr === getTodayStr(); }
  function addDays(dateStr, n) {
    var d = new Date(dateStr + 'T12:00:00Z');
    d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function formatDateDisplay(dateStr) {
    var d = new Date(dateStr + 'T12:00:00Z');
    var months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  }
  function formatDateShort(dateStr) {
    var d = new Date(dateStr + 'T12:00:00Z');
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return months[d.getMonth()] + ' ' + d.getDate();
  }
  function getDayLabel(dateStr) {
    if (isToday(dateStr)) return 'Today';
    if (dateStr === addDays(getTodayStr(), -1)) return 'Yesterday';
    return formatDateShort(dateStr);
  }

  // ── COMPOSITE KEY BUILDERS ─────────────────────────────
  function buildObsKey(login, date, process, sub, setNum, obsNum) {
    return login + '__' + date + '__' + process + '__' + sub + '__S' + setNum + '__' + obsNum;
  }
  function buildSummaryKey(login, date, process, sub) {
    return login + '__' + date + '__' + process + '__' + sub;
  }
  function buildProcessAvgKey(process, sub, date) {
    return process + '__' + sub + '__' + date;
  }

  // ── SHAREPOINT CRUD PRIMITIVES ─────────────────────────
  function getDigest() {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: 'POST', url: SP_SITE + '/_api/contextinfo',
        headers: { 'Accept': 'application/json;odata=verbose', 'Content-Type': 'application/json;odata=verbose' },
        onload: function (res) {
          try { var data = JSON.parse(res.responseText); resolve(data.d.GetContextWebInformation.FormDigestValue); }
          catch (e) { reject(e); }
        },
        onerror: function (err) { reject(err); }
      });
    });
  }
  function spGet(listKey, filter, select, top) {
    return new Promise(function (resolve, reject) {
      var url = spUrl(listKey) + '/items?';
      var params = [];
      if (select) params.push('$select=' + select);
      if (filter) params.push('$filter=' + encodeURIComponent(filter));
      params.push('$top=' + (top || 5000));
      url += params.join('&');
      GM_xmlhttpRequest({
        method: 'GET', url: url,
        headers: { 'Accept': 'application/json;odata=verbose' },
        onload: function (res) {
          try {
            var data = JSON.parse(res.responseText);
            if (data.error) { reject(new Error(data.error.message.value)); return; }
            resolve(data.d.results || []);
          } catch (e) { reject(e); }
        },
        onerror: function (err) { reject(err); }
      });
    });
  }
  function spGetByTitle(listKey, title, select) {
    var filter = "Title eq '" + title.replace(/'/g, "''") + "'";
    return spGet(listKey, filter, select || 'Id,Title', 1).then(function (items) {
      return items.length > 0 ? items[0] : null;
    });
  }
  function spPost(listKey, data) {
    return getDigest().then(function (digest) {
      return new Promise(function (resolve, reject) {
        data['__metadata'] = { 'type': SP_LISTS[listKey].type };
        GM_xmlhttpRequest({
          method: 'POST', url: spUrl(listKey) + '/items',
          headers: { 'Accept': 'application/json;odata=verbose', 'Content-Type': 'application/json;odata=verbose', 'X-RequestDigest': digest },
          data: JSON.stringify(data),
          onload: function (res) {
            try { var r = JSON.parse(res.responseText); if (r.error) { reject(new Error(r.error.message.value)); return; } resolve(r.d); }
            catch (e) { reject(e); }
          },
          onerror: function (err) { reject(err); }
        });
      });
    });
  }
  function spPatch(listKey, itemId, data) {
    return getDigest().then(function (digest) {
      return new Promise(function (resolve, reject) {
        data['__metadata'] = { 'type': SP_LISTS[listKey].type };
        GM_xmlhttpRequest({
          method: 'POST', url: spUrl(listKey) + '/items(' + itemId + ')',
          headers: { 'Accept': 'application/json;odata=verbose', 'Content-Type': 'application/json;odata=verbose', 'X-RequestDigest': digest, 'X-HTTP-Method': 'MERGE', 'If-Match': '*' },
          data: JSON.stringify(data),
          onload: function (res) {
            if (res.status === 204 || res.status === 200) { resolve(true); }
            else { try { var r = JSON.parse(res.responseText); if (r.error) reject(new Error(r.error.message.value)); else resolve(true); } catch (e) { resolve(true); } }
          },
          onerror: function (err) { reject(err); }
        });
      });
    });
  }
  function spDeleteItem(listKey, itemId) {
    return getDigest().then(function (digest) {
      return new Promise(function (resolve, reject) {
        GM_xmlhttpRequest({
          method: 'POST', url: spUrl(listKey) + '/items(' + itemId + ')',
          headers: { 'Accept': 'application/json;odata=verbose', 'X-RequestDigest': digest, 'X-HTTP-Method': 'DELETE', 'If-Match': '*' },
          onload: function () { resolve(true); },
          onerror: function (err) { reject(err); }
        });
      });
    });
  }
  function spUpsert(listKey, titleKey, data) {
    return spGetByTitle(listKey, titleKey).then(function (existing) {
      if (existing) {
        return spPatch(listKey, existing.Id, data).then(function () { return { action: 'updated', id: existing.Id }; });
      } else {
        data.Title = titleKey;
        return spPost(listKey, data).then(function (result) { return { action: 'created', id: result.Id }; });
      }
    });
  }
  // ── ASSOCIATES CRUD (unchanged) ────────────────────────
  function loadAllAssociates() {
    return spGet('associates', 'IsActive eq 1', 'Id,Title,AssociateName,CoachingNotes,IsActive,CreatedDate').then(function (items) {
      return items.map(function (item) {
        return { spId: item.Id, login: item.Title, name: item.AssociateName || '', coachingNotes: item.CoachingNotes || '', isActive: item.IsActive !== false, createdDate: dateFromSP(item.CreatedDate) || getTodayStr() };
      });
    });
  }
  function spSaveAssociate(login, name, coachingNotes) {
    return spUpsert('associates', login, { 'AssociateName': name, 'CoachingNotes': coachingNotes || '', 'IsActive': true, 'CreatedDate': dateForSP(getTodayStr()) });
  }
  function spUpdateCoachingNotes(login, notes) {
    return spGetByTitle('associates', login).then(function (existing) {
      if (existing) return spPatch('associates', existing.Id, { 'CoachingNotes': notes });
      return null;
    });
  }
  function spDeactivateAssociate(login) {
    return spGetByTitle('associates', login).then(function (existing) {
      if (existing) return spPatch('associates', existing.Id, { 'IsActive': false });
      return null;
    });
  }

  // ── OBSERVATIONS CRUD (unchanged) ──────────────────────
  function spSaveObservationDirect(obsData) {
    var key = buildObsKey(obsData.login, obsData.date, obsData.process, obsData.sub, obsData.setNum, obsData.obsNum);
    var data = {
      'AssociateLogin': obsData.login, 'ObsDate': dateForSP(obsData.date),
      'ProcessPath': obsData.process, 'SubProcess': obsData.sub || '',
      'SetNumber': obsData.setNum, 'ObsNumber': obsData.obsNum,
      'StartTime': obsData.startTime || '', 'EndTime': obsData.endTime || '',
      'TaskTimesJSON': JSON.stringify(obsData.taskTimes || []),
      'TotalTime': obsData.totalTime || null, 'TargetTotal': obsData.targetTotal || null,
      'AuditorLogin': obsData.auditorLogin || '', 'AuditorName': obsData.auditorName || ''
    };
    return spUpsert('observations', key, data).then(function (result) {
      dataCache.clear();
      return recalcDailySummary(obsData.login, obsData.date, obsData.process, obsData.sub).then(function () { return result; });
    });
  }

  function spSaveObservation(obsData) {
    var attempt = 0;
    function tryIt() {
      attempt++;
      return spSaveObservationDirect(obsData).catch(function (err) {
        if (attempt < 3) {
          return new Promise(function (res, rej) {
            setTimeout(function () { tryIt().then(res).catch(rej); }, attempt * 2000);
          });
        }
        if (!navigator.onLine) { enqueueOffline(obsData); }
        else { showToast('[WARN] Save failed after 3 attempts - check SharePoint'); }
        throw err;
      });
    }
    return tryIt();
  }

  function loadObservationsForDay(login, date, process, sub) {
    var filter = "AssociateLogin eq '" + login.replace(/'/g, "''") + "'" +
      " and ObsDate eq datetime'" + dateForSP(date) + "'" +
      " and ProcessPath eq '" + process.replace(/'/g, "''") + "'" +
      " and SubProcess eq '" + (sub || '').replace(/'/g, "''") + "'";
    var select = 'Id,Title,SetNumber,ObsNumber,StartTime,EndTime,TaskTimesJSON,TotalTime,TargetTotal,AuditorLogin,AuditorName';
    return spGet('observations', filter, select).then(function (items) {
      var sets = {};
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var setNum = item.SetNumber || 1;
        var obsNum = item.ObsNumber || 1;
        if (!sets[setNum]) {
          sets[setNum] = { setNumber: setNum, observations: {}, isComplete: false, auditorLogin: '', auditorName: '' };
        }
        var taskTimes = [];
        try { taskTimes = JSON.parse(item.TaskTimesJSON || '[]'); } catch (e) { taskTimes = []; }
        sets[setNum].observations[obsNum] = {
          spId: item.Id, obsNumber: obsNum,
          startTime: item.StartTime || null, endTime: item.EndTime || null,
          taskTimes: taskTimes, totalTime: item.TotalTime || null,
          targetTotal: item.TargetTotal || null,
          auditorLogin: item.AuditorLogin || '', auditorName: item.AuditorName || ''
        };
        if (item.AuditorLogin) {
          sets[setNum].auditorLogin = item.AuditorLogin;
          sets[setNum].auditorName = item.AuditorName || '';
        }
      }
      var setNums = Object.keys(sets);
      for (var s = 0; s < setNums.length; s++) {
        var set = sets[setNums[s]];
        var done = 0;
        for (var o = 1; o <= 5; o++) {
          if (set.observations[o] && set.observations[o].totalTime !== null) done++;
        }
        set.isComplete = done >= 5;
      }
      return sets;
    });
  }

  function getNextSetNumber(login, date, process, sub) {
    return loadObservationsForDay(login, date, process, sub).then(function (sets) {
      var keys = Object.keys(sets);
      if (keys.length === 0) return 1;
      var max = 0;
      for (var i = 0; i < keys.length; i++) { var n = parseInt(keys[i]); if (n > max) max = n; }
      return max + 1;
    });
  }

  function spClearObservation(login, date, process, sub, setNum, obsNum) {
    var key = buildObsKey(login, date, process, sub, setNum, obsNum);
    return spGetByTitle('observations', key).then(function (existing) {
      if (existing) {
        return spPatch('observations', existing.Id, { 'StartTime': '', 'EndTime': '', 'TaskTimesJSON': '[]', 'TotalTime': null }).then(function () {
          dataCache.clear();
          return recalcDailySummary(login, date, process, sub);
        });
      }
      return null;
    });
  }

  function loadObservationsForRange(login, process, sub, startDate, endDate) {
    var filter = "AssociateLogin eq '" + login.replace(/'/g, "''") + "'" +
      " and ProcessPath eq '" + process.replace(/'/g, "''") + "'" +
      " and SubProcess eq '" + (sub || '').replace(/'/g, "''") + "'" +
      " and ObsDate ge datetime'" + dateForSP(startDate) + "'" +
      " and ObsDate le datetime'" + dateForSP(endDate) + "'";
    return spGet('observations', filter, 'Id,Title,ObsDate,SetNumber,ObsNumber,TaskTimesJSON,TotalTime,TargetTotal');
  }

  // ── PROCESS CONFIGURATION (unchanged defaults) ─────────
  function buildPickTasks(read, locate, move, drive) {
    return { tasks: [{ name: "Read the scanner", target: read }, { name: "Time to locate item in bin", target: locate }, { name: "Move item from bin to cage", target: move }, { name: "Drive time from bin to bin", target: drive }], totalTarget: read + locate + move + drive };
  }
  function buildPackTasks(t1, t2, t3, t4, t5, t6, t7, t8, t9) {
    var allTasks = [{ name: "Scan cage", target: t1 }, { name: "Scan item / move item to station", target: t2 }, { name: "Read screen", target: t3 }, { name: "Build box / tape if applicable", target: t4 }, { name: "Place item into box", target: t5 }, { name: "P-Slip / labels", target: t6 }, { name: "Dunnage", target: t7 }, { name: "Scan / add SPOO", target: t8 }, { name: "Push item onto conveyor", target: t9 }];
    var tasks = allTasks.filter(function (t) { return t.target > 0; });
    var totalTarget = 0; tasks.forEach(function (t) { totalTarget += t.target; });
    return { tasks: tasks, totalTarget: totalTarget };
  }
  function buildStowTasks(locate, openNet, grab, stow, confirm, drive) {
    return { tasks: [{ name: "Time to locate bin", target: locate }, { name: "Open cage netting", target: openNet }, { name: "Grab item from cage", target: grab }, { name: "Stow unit into bin", target: stow }, { name: "Confirm stow on scanner", target: confirm }, { name: "Drive time from bin to bin", target: drive }], totalTarget: locate + openNet + grab + stow + confirm + drive };
  }
  function buildDockTasks() {
    return { tasks: [{ name: "Scan item on conveyor", target: 6 }, { name: "Finding the accurate Gocart", target: 12 }, { name: "Placing item in Gocart", target: 6 }], totalTarget: 24, dockNote: '⚠ Includes possible waterspider @ 100 UPH' };
  }
  var NUM_OBS = 5;
  var PROCESS_PATHS = {
    "Pick": { "Singles": buildPickTasks(10, 10, 12, 120), "VNA 1": buildPickTasks(10, 8, 8, 60), "VNA 2": buildPickTasks(10, 8, 12, 120), "Noncon/Bod": buildPickTasks(10, 8, 15, 180), "Multi": buildPickTasks(10, 8, 8, 180) },
    "Pack": { "Singles/VNA": buildPackTasks(3, 5, 9, 20, 9, 9, 12, 5, 3), "Multies": buildPackTasks(3, 5, 3, 27, 9, 5, 14, 3, 5), "BOD/Noncon": buildPackTasks(6, 4, 8, 0, 0, 5, 0, 5, 5) },
    "Dock": { "_default": buildDockTasks() },
    "Stow": { "_default": buildStowTasks(60, 3, 5, 5, 2, 120) }
  };
  function hasSubPaths(process) { var subs = Object.keys(PROCESS_PATHS[process]); return !(subs.length === 1 && subs[0] === '_default'); }
  function getConfig(process, sub) { return PROCESS_PATHS[process][sub] || PROCESS_PATHS[process]['_default']; }

  // ══════════════════════════════════════════════════════════
  // ── NEW: CUSTOM TARGETS SYSTEM ─────────────────────────
  // ══════════════════════════════════════════════════════════

  // In-memory store: { "Pick__Singles": [10,15,12,120], "Pack__Multies": [3,5,...] }
  var customTargets = {};

  function customTargetKey(process, sub) {
    return process + '__' + (sub || '_default');
  }

  function hasCustomTargets(process, sub) {
    var key = customTargetKey(process, sub);
    return customTargets.hasOwnProperty(key);
  }

  function hasAnyCustomTargets() {
    return Object.keys(customTargets).length > 0;
  }

  // Returns effective config: base config merged with custom targets if any
  function getEffectiveConfig(process, sub) {
    var base = getConfig(process, sub);
    var key = customTargetKey(process, sub);
    var custom = customTargets[key];
    if (!custom) return base;

    // Deep clone base and override targets
    var effective = {
      tasks: [],
      totalTarget: 0,
      dockNote: base.dockNote || null
    };
    for (var i = 0; i < base.tasks.length; i++) {
      var newTarget = (custom[i] !== undefined && custom[i] !== null) ? custom[i] : base.tasks[i].target;
      effective.tasks.push({ name: base.tasks[i].name, target: newTarget });
      effective.totalTarget += newTarget;
    }
    return effective;
  }

  // Get default targets as array for comparison
  function getDefaultTargetsArray(process, sub) {
    var base = getConfig(process, sub);
    return base.tasks.map(function (t) { return t.target; });
  }

  // Check if a specific task target differs from default
  function isTaskCustomized(process, sub, taskIndex) {
    var key = customTargetKey(process, sub);
    var custom = customTargets[key];
    if (!custom) return false;
    var base = getConfig(process, sub);
    return custom[taskIndex] !== undefined && custom[taskIndex] !== base.tasks[taskIndex].target;
  }

  // ── CUSTOM TARGETS — localStorage cache ────────────────
  function saveCustomTargetsLocally() {
    try { localStorage.setItem('sna4_custom_targets', JSON.stringify(customTargets)); } catch (e) {}
  }
  function loadCustomTargetsLocally() {
    try {
      var raw = localStorage.getItem('sna4_custom_targets');
      if (raw) customTargets = JSON.parse(raw) || {};
    } catch (e) { customTargets = {}; }
  }

  // ── CUSTOM TARGETS — SharePoint persistence ────────────
  // Stored as single config row in processAvgs list:
  //   Title: "__CONFIG__TARGETS"
  //   TaskAvgsJSON: '{"Pick__Singles":[10,10,12,120],...}'

  function loadCustomTargetsFromSP() {
    return spGetByTitle('processAvgs', CONFIG_ROW_KEY, 'Id,Title,TaskAvgsJSON').then(function (item) {
      if (item && item.TaskAvgsJSON) {
        try {
          customTargets = JSON.parse(item.TaskAvgsJSON) || {};
        } catch (e) { customTargets = {}; }
      } else {
        customTargets = {};
      }
      saveCustomTargetsLocally();
      return customTargets;
    }).catch(function () {
      // Fallback to localStorage if SP fails
      loadCustomTargetsLocally();
      return customTargets;
    });
  }

  function saveCustomTargetsToSP() {
    var data = {
      'ProcessPath': '__CONFIG__',
      'SubProcess': '__TARGETS__',
      'AvgDate': dateForSP(getTodayStr()),
      'TaskAvgsJSON': JSON.stringify(customTargets),
      'AssociateCount': 0,
      'TotalObsCount': 0,
      'OverallAvgTotal': 0,
      'TargetTotal': 0,
      'PctWithinTarget': 0
    };
    saveCustomTargetsLocally();
    return spUpsert('processAvgs', CONFIG_ROW_KEY, data);
  }

  // ── CUSTOM TARGETS — Apply + Recalculate Chain ─────────
  // This is the big one: when targets change, recalc all affected summaries + process avgs

  function applyCustomTargets(process, sub, newTaskTargets) {
    var key = customTargetKey(process, sub);
    var defaults = getDefaultTargetsArray(process, sub);
    var isDefault = true;
    for (var i = 0; i < newTaskTargets.length; i++) {
      if (newTaskTargets[i] !== defaults[i]) { isDefault = false; break; }
    }

    // If all values match defaults, remove the custom entry
    if (isDefault) {
      delete customTargets[key];
    } else {
      customTargets[key] = newTaskTargets;
    }

    var newTotalTarget = 0;
    for (var t = 0; t < newTaskTargets.length; t++) newTotalTarget += newTaskTargets[t];

    var recalcStats = { summaries: 0, processAvgs: 0 };

    // Step 1: Save config to SharePoint
    return saveCustomTargetsToSP().then(function () {
      // Step 2: Get ALL dailySummaries for this process/sub
      var filter = "ProcessPath eq '" + process.replace(/'/g, "''") + "'" +
        " and SubProcess eq '" + (sub || '').replace(/'/g, "''") + "'";
      return spGet('dailySummaries', filter, 'Id,Title,AssociateLogin,SummaryDate,TotalObs,AvgTotal');
    }).then(function (summaries) {
      if (summaries.length === 0) return [];

      // Step 3: For each summary, we need to recount within-target observations
      // Batch: get all observations for this process/sub
      var obsFilter = "ProcessPath eq '" + process.replace(/'/g, "''") + "'" +
        " and SubProcess eq '" + (sub || '').replace(/'/g, "''") + "'" +
        " and TotalTime ne null";
      return spGet('observations', obsFilter, 'Id,AssociateLogin,ObsDate,TotalTime').then(function (allObs) {
        // Group observations by summary key (login + date)
        var obsMap = {};
        for (var i = 0; i < allObs.length; i++) {
          var o = allObs[i];
          var dateStr = dateFromSP(o.ObsDate);
          var mapKey = o.AssociateLogin + '__' + dateStr;
          if (!obsMap[mapKey]) obsMap[mapKey] = [];
          obsMap[mapKey].push(o.TotalTime);
        }

        // Step 4: Patch each summary with new target + recalculated WithinTargetPct
        var patches = [];
        for (var s = 0; s < summaries.length; s++) {
          var summary = summaries[s];
          var sumDateStr = dateFromSP(summary.SummaryDate);
          var sumKey = summary.AssociateLogin + '__' + sumDateStr;
          var totals = obsMap[sumKey] || [];

          var withinCount = 0;
          if (newTotalTarget > 0 && totals.length > 0) {
            for (var w = 0; w < totals.length; w++) {
              if (totals[w] <= newTotalTarget) withinCount++;
            }
          }
          var withinPct = (newTotalTarget > 0 && totals.length > 0)
            ? Math.round((withinCount / totals.length) * 1000) / 10
            : null;

          patches.push(spPatch('dailySummaries', summary.Id, {
            'TargetTotal': newTotalTarget,
            'WithinTargetPct': withinPct
          }));
          recalcStats.summaries++;
        }
        return Promise.all(patches);
      });
    }).then(function () {
      // Step 5: Recalc all affected processAvgs for this process/sub
      var pavgFilter = "ProcessPath eq '" + process.replace(/'/g, "''") + "'" +
        " and SubProcess eq '" + (sub || '').replace(/'/g, "''") + "'" +
        " and Title ne '" + CONFIG_ROW_KEY + "'";
      return spGet('processAvgs', pavgFilter, 'Id,Title,AvgDate');
    }).then(function (pavgs) {
      // For each processAvg row, recompute from updated dailySummaries
      var recomputePromises = [];
      var processedDates = {};
      for (var p = 0; p < pavgs.length; p++) {
        var dateStr = dateFromSP(pavgs[p].AvgDate);
        if (dateStr && !processedDates[dateStr]) {
          processedDates[dateStr] = true;
          recomputePromises.push(recomputeProcessAvgForDate(process, sub, dateStr, newTotalTarget));
          recalcStats.processAvgs++;
        }
      }
      return Promise.all(recomputePromises);
    }).then(function () {
      dataCache.clear();
      return recalcStats;
    });
  }

  // Helper: recompute a single processAvg row for a given date with new target
  function recomputeProcessAvgForDate(process, sub, date, newTotalTarget) {
    var filter = "ProcessPath eq '" + process.replace(/'/g, "''") + "'" +
      " and SubProcess eq '" + (sub || '').replace(/'/g, "''") + "'" +
      " and SummaryDate eq datetime'" + dateForSP(date) + "'";
    return spGet('dailySummaries', filter, 'AssociateLogin,TotalObs,AvgTotal,TaskAvgsJSON,TargetTotal,WithinTargetPct').then(function (items) {
      if (items.length === 0) return;
      var count = items.length, obsCount = 0, avgSum = 0, wSum = 0, wCount = 0, allTA = [];
      for (var i = 0; i < items.length; i++) {
        obsCount += (items[i].TotalObs || 0);
        avgSum += (items[i].AvgTotal || 0);
        if (items[i].WithinTargetPct != null) { wSum += items[i].WithinTargetPct; wCount++; }
        var ta = []; try { ta = JSON.parse(items[i].TaskAvgsJSON || '[]'); } catch (e) {} allTA.push(ta);
      }
      var overallAvg = Math.round((avgSum / count) * 100) / 100;
      var combinedTA = [];
      if (allTA.length > 0) {
        var mt = 0;
        for (var a = 0; a < allTA.length; a++) { if (allTA[a].length > mt) mt = allTA[a].length; }
        for (var ti = 0; ti < mt; ti++) {
          var ts = 0, tc = 0;
          for (var ai = 0; ai < allTA.length; ai++) { if (allTA[ai][ti] !== undefined) { ts += allTA[ai][ti]; tc++; } }
          combinedTA.push(tc > 0 ? Math.round((ts / tc) * 100) / 100 : 0);
        }
      }
      var pctW = wCount > 0 ? Math.round((wSum / wCount) * 10) / 10 : null;
      var avgKey = buildProcessAvgKey(process, sub, date);
      return spUpsert('processAvgs', avgKey, {
        'ProcessPath': process, 'SubProcess': sub || '', 'AvgDate': dateForSP(date),
        'AssociateCount': count, 'TotalObsCount': obsCount, 'OverallAvgTotal': overallAvg,
        'TaskAvgsJSON': JSON.stringify(combinedTA), 'TargetTotal': newTotalTarget, 'PctWithinTarget': pctW
      });
    });
  }

  // Reset custom targets for a process/sub back to defaults
  function resetCustomTargets(process, sub) {
    var key = customTargetKey(process, sub);
    if (!customTargets[key]) return Promise.resolve({ summaries: 0, processAvgs: 0 });

    // Get defaults and apply them through the same recalc chain
    var defaults = getDefaultTargetsArray(process, sub);
    return applyCustomTargets(process, sub, defaults);
  }

  // ── DAILY SUMMARY (UPDATED — uses getEffectiveConfig) ──
  function recalcDailySummary(login, date, process, sub) {
    return loadObservationsForDay(login, date, process, sub).then(function (sets) {
      var allTotals = [], allTaskArrays = [], setNumbers = Object.keys(sets), totalSets = setNumbers.length, auditors = {};
      for (var s = 0; s < setNumbers.length; s++) {
        var set = sets[setNumbers[s]];
        for (var o = 1; o <= 5; o++) {
          var obs = set.observations[o];
          if (obs && obs.totalTime !== null) {
            allTotals.push(obs.totalTime);
            if (obs.taskTimes && obs.taskTimes.length > 0) allTaskArrays.push(obs.taskTimes);
          }
        }
        if (set.auditorLogin) auditors[set.auditorLogin] = true;
      }
      var totalObs = allTotals.length;
      var summaryKey = buildSummaryKey(login, date, process, sub);
      if (totalObs === 0) {
        return spGetByTitle('dailySummaries', summaryKey).then(function (existing) {
          if (existing) return spDeleteItem('dailySummaries', existing.Id);
          return null;
        });
      }
      var sum = 0, minVal = Infinity, maxVal = -Infinity;
      for (var t = 0; t < allTotals.length; t++) { sum += allTotals[t]; if (allTotals[t] < minVal) minVal = allTotals[t]; if (allTotals[t] > maxVal) maxVal = allTotals[t]; }
      var avgTotal = Math.round((sum / totalObs) * 100) / 100;
      var taskAvgs = [];
      if (allTaskArrays.length > 0) {
        var maxTasks = 0;
        for (var a = 0; a < allTaskArrays.length; a++) { if (allTaskArrays[a].length > maxTasks) maxTasks = allTaskArrays[a].length; }
        for (var ti = 0; ti < maxTasks; ti++) {
          var tSum = 0, tCount = 0;
          for (var ai = 0; ai < allTaskArrays.length; ai++) { if (allTaskArrays[ai][ti] !== undefined) { tSum += allTaskArrays[ai][ti]; tCount++; } }
          taskAvgs.push(tCount > 0 ? Math.round((tSum / tCount) * 100) / 100 : 0);
        }
      }
      // ★ CHANGED: use getEffectiveConfig instead of raw PROCESS_PATHS
      var effectiveConfig = getEffectiveConfig(process, sub);
      var targetTotal = effectiveConfig.totalTarget;

      var withinCount = 0;
      if (targetTotal > 0) { for (var w = 0; w < allTotals.length; w++) { if (allTotals[w] <= targetTotal) withinCount++; } }
      var withinPct = targetTotal > 0 ? Math.round((withinCount / totalObs) * 1000) / 10 : null;
      return spUpsert('dailySummaries', summaryKey, {
        'AssociateLogin': login, 'SummaryDate': dateForSP(date), 'ProcessPath': process, 'SubProcess': sub || '',
        'TotalSets': totalSets, 'TotalObs': totalObs, 'AvgTotal': avgTotal, 'MinTotal': minVal, 'MaxTotal': maxVal,
        'TaskAvgsJSON': JSON.stringify(taskAvgs), 'TargetTotal': targetTotal, 'WithinTargetPct': withinPct,
        'AuditorsJSON': JSON.stringify(Object.keys(auditors))
      });
    });
  }

  function loadDailySummary(login, date, process, sub) {
    var key = buildSummaryKey(login, date, process, sub);
    return spGetByTitle('dailySummaries', key, 'Id,Title,TotalSets,TotalObs,AvgTotal,MinTotal,MaxTotal,TaskAvgsJSON,TargetTotal,WithinTargetPct,AuditorsJSON').then(function (item) {
      if (!item) return null;
      var taskAvgs = []; try { taskAvgs = JSON.parse(item.TaskAvgsJSON || '[]'); } catch (e) {}
      var auditors = []; try { auditors = JSON.parse(item.AuditorsJSON || '[]'); } catch (e) {}
      return { spId: item.Id, totalSets: item.TotalSets || 0, totalObs: item.TotalObs || 0, avgTotal: item.AvgTotal || 0, minTotal: item.MinTotal || 0, maxTotal: item.MaxTotal || 0, taskAvgs: taskAvgs, targetTotal: item.TargetTotal || 0, withinTargetPct: item.WithinTargetPct, auditors: auditors };
    });
  }

  function loadAssociateSummariesForDate(login, date) {
    var filter = "AssociateLogin eq '" + login.replace(/'/g, "''") + "' and SummaryDate eq datetime'" + dateForSP(date) + "'";
    return spGet('dailySummaries', filter, 'Id,Title,ProcessPath,SubProcess,TotalSets,TotalObs,AvgTotal,TargetTotal,WithinTargetPct').then(function (items) {
      var summaries = {};
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var key = item.ProcessPath + '__' + (item.SubProcess || '_default');
        summaries[key] = { process: item.ProcessPath, sub: item.SubProcess || '_default', totalSets: item.TotalSets || 0, totalObs: item.TotalObs || 0, avgTotal: item.AvgTotal || 0, targetTotal: item.TargetTotal || 0, withinTargetPct: item.WithinTargetPct };
      }
      return summaries;
    });
  }

  // ── PROCESS AVERAGES (UPDATED — uses getEffectiveConfig) ──
  function computeProcessAverage(process, sub, date) {
    var filter = "ProcessPath eq '" + process.replace(/'/g, "''") + "' and SubProcess eq '" + (sub || '').replace(/'/g, "''") + "' and SummaryDate eq datetime'" + dateForSP(date) + "'";
    return spGet('dailySummaries', filter, 'AssociateLogin,TotalObs,AvgTotal,TaskAvgsJSON,TargetTotal,WithinTargetPct').then(function (items) {
      if (items.length === 0) return null;
      var count = items.length, obsCount = 0, avgSum = 0, wSum = 0, wCount = 0, allTA = [];
      for (var i = 0; i < items.length; i++) {
        obsCount += (items[i].TotalObs || 0); avgSum += (items[i].AvgTotal || 0);
        if (items[i].WithinTargetPct != null) { wSum += items[i].WithinTargetPct; wCount++; }
        var ta = []; try { ta = JSON.parse(items[i].TaskAvgsJSON || '[]'); } catch (e) {} allTA.push(ta);
      }
      var overallAvg = Math.round((avgSum / count) * 100) / 100;
      var combinedTA = [];
      if (allTA.length > 0) {
        var mt = 0; for (var a = 0; a < allTA.length; a++) { if (allTA[a].length > mt) mt = allTA[a].length; }
        for (var ti = 0; ti < mt; ti++) {
          var ts = 0, tc = 0;
          for (var ai = 0; ai < allTA.length; ai++) { if (allTA[ai][ti] !== undefined) { ts += allTA[ai][ti]; tc++; } }
          combinedTA.push(tc > 0 ? Math.round((ts / tc) * 100) / 100 : 0);
        }
      }
      var pctW = wCount > 0 ? Math.round((wSum / wCount) * 10) / 10 : null;

      // ★ CHANGED: use getEffectiveConfig for target
      var effectiveConfig = getEffectiveConfig(process, sub);
      var target = effectiveConfig.totalTarget;

      var avgKey = buildProcessAvgKey(process, sub, date);
      return spUpsert('processAvgs', avgKey, {
        'ProcessPath': process, 'SubProcess': sub || '', 'AvgDate': dateForSP(date),
        'AssociateCount': count, 'TotalObsCount': obsCount, 'OverallAvgTotal': overallAvg,
        'TaskAvgsJSON': JSON.stringify(combinedTA), 'TargetTotal': target, 'PctWithinTarget': pctW
      }).then(function () {
        return { associateCount: count, totalObsCount: obsCount, overallAvgTotal: overallAvg, taskAvgs: combinedTA, targetTotal: target, pctWithinTarget: pctW };
      });
    });
  }

  function loadProcessAverage(process, sub, date) {
    var key = buildProcessAvgKey(process, sub, date);
    return spGetByTitle('processAvgs', key, 'Id,Title,AssociateCount,TotalObsCount,OverallAvgTotal,TaskAvgsJSON,TargetTotal,PctWithinTarget').then(function (item) {
      if (item) {
        var ta = []; try { ta = JSON.parse(item.TaskAvgsJSON || '[]'); } catch (e) {}
        return { associateCount: item.AssociateCount || 0, totalObsCount: item.TotalObsCount || 0, overallAvgTotal: item.OverallAvgTotal || 0, taskAvgs: ta, targetTotal: item.TargetTotal || 0, pctWithinTarget: item.PctWithinTarget };
      }
      return computeProcessAverage(process, sub, date);
    });
  }

  // ── HISTORICAL AVG (UPDATED — uses getEffectiveConfig) ──
  function computeHistoricalAvg(login, process, sub, daysBack) {
    var endDate = getTodayStr();
    var startDate = daysBack ? addDays(endDate, -daysBack) : '2020-01-01';
    return loadObservationsForRange(login, process, sub, startDate, endDate).then(function (items) {
      if (items.length === 0) return null;
      var totals = [], allTT = [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].TotalTime != null) {
          totals.push(items[i].TotalTime);
          var tt = []; try { tt = JSON.parse(items[i].TaskTimesJSON || '[]'); } catch (e) {} if (tt.length > 0) allTT.push(tt);
        }
      }
      if (totals.length === 0) return null;
      var sum = 0, minV = Infinity, maxV = -Infinity;
      for (var t = 0; t < totals.length; t++) { sum += totals[t]; if (totals[t] < minV) minV = totals[t]; if (totals[t] > maxV) maxV = totals[t]; }
      var avg = Math.round((sum / totals.length) * 100) / 100;
      var taskAvgs = [];
      if (allTT.length > 0) {
        var mt = 0; for (var a = 0; a < allTT.length; a++) { if (allTT[a].length > mt) mt = allTT[a].length; }
        for (var ti = 0; ti < mt; ti++) {
          var ts = 0, tc = 0;
          for (var ai = 0; ai < allTT.length; ai++) { if (allTT[ai][ti] !== undefined) { ts += allTT[ai][ti]; tc++; } }
          taskAvgs.push(tc > 0 ? Math.round((ts / tc) * 100) / 100 : 0);
        }
      }
      // ★ CHANGED: use getEffectiveConfig for target
      var effectiveConfig = getEffectiveConfig(process, sub);
      var tgt = effectiveConfig.totalTarget;

      var wc = 0; if (tgt > 0) { for (var w = 0; w < totals.length; w++) { if (totals[w] <= tgt) wc++; } }
      var trend = null, now = new Date(getTodayStr() + 'T12:00:00Z'), rec = [], old = [];
      for (var ri = 0; ri < items.length; ri++) {
        if (items[ri].TotalTime == null) continue;
        var od = dateFromSP(items[ri].ObsDate); if (!od) continue;
        var da = Math.floor((now - new Date(od + 'T12:00:00Z')) / 86400000);
        if (da <= 7) rec.push(items[ri].TotalTime); else if (da <= 14) old.push(items[ri].TotalTime);
      }
      if (rec.length > 0 && old.length > 0) {
        var rA = 0; for (var ra = 0; ra < rec.length; ra++) rA += rec[ra]; rA /= rec.length;
        var oA = 0; for (var oa = 0; oa < old.length; oa++) oA += old[oa]; oA /= old.length;
        trend = Math.round((rA - oA) * 100) / 100;
      }
      var uDays = {}; for (var di = 0; di < items.length; di++) { if (items[di].TotalTime != null) { var dd = dateFromSP(items[di].ObsDate); if (dd) uDays[dd] = true; } }
      return {
        totalObservations: totals.length, totalDays: Object.keys(uDays).length,
        avgTotal: avg, minTotal: minV, maxTotal: maxV, taskAvgs: taskAvgs,
        targetTotal: tgt, withinTargetPct: tgt > 0 ? Math.round((wc / totals.length) * 1000) / 10 : null,
        trend: trend, periodDays: daysBack || Object.keys(uDays).length
      };
    });
  }

  // ── DATA CACHE (unchanged) ─────────────────────────────
  var dataCache = {
    _store: {}, _ttl: 30000,
    get: function (k) { var e = this._store[k]; if (e && (Date.now() - e.time) < this._ttl) return e.data; return null; },
    set: function (k, d) { this._store[k] = { data: d, time: Date.now() }; },
    clear: function () { this._store = {}; }
  };
  // ── APP STATE (unchanged) ──────────────────────────────
  var state = {
    isOpen: false, view: 'summary', currentDate: getTodayStr(),
    selectedProcess: 'Pick', selectedSubProcess: 'Singles', selectedObs: null,
    currentSet: 1, isRunning: false, currentTaskIndex: -1, lastClickTime: null,
    elapsedInterval: null, isDragging: false, dragOffset: { x: 0, y: 0 },
    currentAssociateIndex: -1, coachingExpanded: false, loading: false, syncStatus: 'idle',
    associates: [], sets: {}, daySummaries: {}, processAvg: null, historicalAvg: null, dailySummary: null
  };
  var auditorInfo = { name: '', login: '' };

  // ── UI PREFERENCES (unchanged) ─────────────────────────
  var uiPrefs = { darkMode: false, compactMode: false };
  function loadUiPrefs() {
    try { var raw = localStorage.getItem('sna4_ui_prefs'); if (raw) { var p = JSON.parse(raw); uiPrefs.darkMode = !!p.darkMode; uiPrefs.compactMode = !!p.compactMode; } } catch (e) {}
  }
  function saveUiPrefs() { try { localStorage.setItem('sna4_ui_prefs', JSON.stringify(uiPrefs)); } catch (e) {} }
  function applyDarkMode() {
    if (uiPrefs.darkMode) { panel.classList.add('dark'); document.body.classList.add('takt-dark-body'); }
    else { panel.classList.remove('dark'); document.body.classList.remove('takt-dark-body'); }
  }
  function applyCompactMode() {
    if (uiPrefs.compactMode) panel.classList.add('compact');
    else panel.classList.remove('compact');
  }
  function toggleDarkMode() { uiPrefs.darkMode = !uiPrefs.darkMode; saveUiPrefs(); applyDarkMode(); renderPanel(); }
  function toggleCompactMode() { uiPrefs.compactMode = !uiPrefs.compactMode; saveUiPrefs(); applyCompactMode(); renderPanel(); }

  // ── OFFLINE QUEUE (unchanged) ──────────────────────────
  var offlineQueue = [];
  var offlineRetryTimer = null;
  function loadOfflineQueue() {
    try { var raw = localStorage.getItem('sna4_offline_queue'); if (raw) offlineQueue = JSON.parse(raw) || []; } catch(e) { offlineQueue = []; }
  }
  function saveOfflineQueue() { try { localStorage.setItem('sna4_offline_queue', JSON.stringify(offlineQueue)); } catch(e) {} }
  function enqueueOffline(obsData) {
    offlineQueue.push({ obsData: obsData, ts: Date.now(), attempts: 0 });
    saveOfflineQueue();
    showToast('[OFFLINE] Saved locally - will sync when reconnected');
    scheduleOfflineRetry();
  }
  function scheduleOfflineRetry() {
    if (offlineRetryTimer) return;
    offlineRetryTimer = setInterval(flushOfflineQueue, 15000);
  }
  function flushOfflineQueue() {
    if (offlineQueue.length === 0) { clearInterval(offlineRetryTimer); offlineRetryTimer = null; return; }
    if (!navigator.onLine) return;
    var item = offlineQueue[0];
    item.attempts++;
    spSaveObservationDirect(item.obsData).then(function () {
      offlineQueue.shift(); saveOfflineQueue();
      if (offlineQueue.length === 0) { clearInterval(offlineRetryTimer); offlineRetryTimer = null; showToast('Offline data synced to SharePoint'); }
      else flushOfflineQueue();
    }).catch(function () {
      if (item.attempts > 10) { offlineQueue.shift(); saveOfflineQueue(); showToast('[WARN] Observation failed to sync after 10 attempts'); }
    });
  }

  // ── HELPERS (unchanged) ────────────────────────────────
  function getCurrentAssociate() {
    if (state.currentAssociateIndex >= 0 && state.currentAssociateIndex < state.associates.length) return state.associates[state.currentAssociateIndex];
    return null;
  }
  function formatTime(date) {
    return date.getHours().toString().padStart(2, '0') + ':' + date.getMinutes().toString().padStart(2, '0') + ':' + date.getSeconds().toString().padStart(2, '0') + '.' + Math.floor(date.getMilliseconds() / 100);
  }
  function formatElapsed(ms) {
    var totalSec = Math.floor(ms / 1000);
    return Math.floor(totalSec / 60).toString().padStart(2, '0') + ':' + (totalSec % 60).toString().padStart(2, '0') + '.' + Math.floor((ms % 1000) / 10).toString().padStart(2, '0');
  }
  function getInitials(name) {
    if (!name) return '?';
    var parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return parts[0].substring(0, 2).toUpperCase();
  }
  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function showToast(msg) {
    var t = document.createElement('div');
    t.className = 'takt-toast'; t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('show'); });
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 300); }, 2500);
  }
  function saveAuditorLocally() { try { localStorage.setItem('sna4_auditor', JSON.stringify(auditorInfo)); } catch (e) {} }
  function loadAuditorLocally() {
    try { var raw = localStorage.getItem('sna4_auditor'); if (raw) { var p = JSON.parse(raw); auditorInfo.name = p.auditorName || p.name || ''; auditorInfo.login = p.auditorLogin || p.login || ''; } } catch (e) {}
  }
  function isReadOnly() { return !isToday(state.currentDate); }
  function isSetLocked(setData) { if (!setData) return false; return setData.isComplete === true; }
  function canEditCurrentSet() { if (isReadOnly()) return false; var setData = state.sets[state.currentSet]; if (!setData) return true; return !setData.isComplete; }

  // ── STYLES (UPDATED — includes all new styles) ─────────
  var styles = document.createElement('style');
  styles.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');

    /* ── FAB ── */
    #takt-fab {
      position: fixed; bottom: 30px; right: 30px; width: 60px; height: 60px;
      border-radius: 16px; background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
      box-shadow: 0 4px 20px rgba(99,102,241,0.4); cursor: pointer; z-index: 999999;
      display: flex; align-items: center; justify-content: center;
      transition: all 0.3s cubic-bezier(0.4,0,0.2,1); border: none; outline: none;
    }
    #takt-fab:hover { transform: scale(1.08) translateY(-2px); box-shadow: 0 8px 30px rgba(99,102,241,0.5); }
    #takt-fab.active { background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); box-shadow: 0 4px 20px rgba(239,68,68,0.4); animation: fab-pulse 2s infinite; }
    @keyframes fab-pulse { 0%,100% { box-shadow: 0 4px 20px rgba(239,68,68,0.4), 0 0 0 0 rgba(239,68,68,0.3); } 50% { box-shadow: 0 4px 20px rgba(239,68,68,0.4), 0 0 0 12px rgba(239,68,68,0); } }
    #takt-fab svg { width: 28px; height: 28px; fill: white; }
    #takt-badge { position: absolute; top: -6px; right: -6px; background: #22c55e; color: white; font-size: 11px; font-weight: 800; width: 22px; height: 22px; border-radius: 50%; display: none; align-items: center; justify-content: center; font-family: 'Inter', sans-serif; border: 2px solid white; }

    /* ── PANEL ── */
    #takt-panel {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%) scale(0);
      width: min(1350px, 96vw); height: 94vh;
      background: #ffffff; border-radius: 20px;
      box-shadow: 0 25px 80px rgba(0,0,0,0.15), 0 0 0 1px rgba(0,0,0,0.05);
      z-index: 999998; font-family: 'Inter', sans-serif;
      overflow: hidden; display: flex; flex-direction: column;
      transition: all 0.35s cubic-bezier(0.4,0,0.2,1); opacity: 0;
    }
    #takt-panel.open { transform: translate(-50%, -50%) scale(1); opacity: 1; }
    #takt-backdrop { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(15,23,42,0.2); backdrop-filter: blur(4px); z-index: 999997; opacity: 0; transition: opacity 0.3s; pointer-events: none; }
    #takt-backdrop.open { opacity: 1; pointer-events: all; }

    /* ── HEADER ── */
    .takt-header { background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #a78bfa 100%); padding: 14px 24px; display: flex; align-items: center; justify-content: space-between; cursor: move; user-select: none; flex-shrink: 0; }
    .takt-header-left { display: flex; align-items: center; gap: 12px; }
    .takt-header-icon { width: 38px; height: 38px; background: rgba(255,255,255,0.2); border-radius: 10px; display: flex; align-items: center; justify-content: center; }
    .takt-header-icon svg { width: 20px; height: 20px; fill: white; }
    .takt-header-title { color: white; font-size: 16px; font-weight: 800; letter-spacing: -0.3px; }
    .takt-header-subtitle { color: rgba(255,255,255,0.75); font-size: 11px; font-weight: 500; margin-top: 1px; }
    .takt-header-actions { display: flex; gap: 8px; align-items: center; }
    .takt-header-btn { width: 32px; height: 32px; border-radius: 8px; background: rgba(255,255,255,0.15); border: none; color: white; font-size: 15px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background 0.2s; }
    .takt-header-btn:hover { background: rgba(255,255,255,0.3); }

    /* ── SYNC DOT ── */
    #takt-sync-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: rgba(255,255,255,0.4); transition: background 0.3s;
      flex-shrink: 0; align-self: center; margin-right: 4px;
    }
    #takt-sync-dot.pulse { background: #22c55e; box-shadow: 0 0 0 4px rgba(34,197,94,0.3); animation: sync-flash 0.8s ease; }
    @keyframes sync-flash { 0%,100% { transform: scale(1); } 50% { transform: scale(1.6); } }

    /* ── LOADING ── */
    .takt-loading-bar { height: 3px; background: #e2e8f0; overflow: hidden; flex-shrink: 0; }
    .takt-loading-bar.active { background: linear-gradient(90deg, #6366f1, #8b5cf6, #6366f1); background-size: 200% 100%; animation: loading-slide 1.5s infinite; }
    @keyframes loading-slide { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

    /* ── DAY NAV ── */
    .takt-day-nav { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 8px 24px; background: linear-gradient(135deg, #f0f9ff, #e0f2fe); border-bottom: 2px solid #7dd3fc; flex-shrink: 0; }
    .takt-day-btn { width: 34px; height: 34px; border-radius: 8px; border: 2px solid #7dd3fc; background: white; color: #0284c7; font-size: 16px; font-weight: 800; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.2s; font-family: 'Inter', sans-serif; }
    .takt-day-btn:hover { background: #0284c7; color: white; border-color: #0284c7; }
    .takt-day-btn:disabled { opacity: 0.3; cursor: not-allowed; }
    .takt-day-btn:disabled:hover { background: white; color: #0284c7; }
    .takt-day-label { font-size: 14px; font-weight: 800; color: #0c4a6e; min-width: 200px; text-align: center; }
    .takt-day-label .day-name { color: #0284c7; }
    .takt-day-today-btn { padding: 5px 14px; border-radius: 8px; border: 2px solid #7dd3fc; background: white; color: #0284c7; font-size: 11px; font-weight: 700; cursor: pointer; transition: all 0.2s; font-family: 'Inter', sans-serif; }
    .takt-day-today-btn:hover { background: #0284c7; color: white; }
    .takt-day-today-btn.is-today { background: #0284c7; color: white; cursor: default; }
    .takt-day-readonly-badge { padding: 4px 12px; border-radius: 6px; background: #fef3c7; color: #92400e; font-size: 11px; font-weight: 700; border: 1px solid #fde68a; }

    /* ── AUDITOR BAR ── */
    .takt-auditor-bar { display: flex; align-items: center; gap: 16px; padding: 8px 24px; background: #fefce8; border-bottom: 2px solid #fde68a; flex-shrink: 0; flex-wrap: wrap; }
    .takt-auditor-group { display: flex; align-items: center; gap: 6px; }
    .takt-auditor-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; color: #a16207; }
    .takt-auditor-input { padding: 5px 10px; border-radius: 6px; border: 1.5px solid #fde68a; background: white; color: #1e293b; font-size: 12px; font-weight: 600; font-family: 'Inter', sans-serif; outline: none; width: 160px; transition: all 0.2s; }
    .takt-auditor-input:focus { border-color: #f59e0b; box-shadow: 0 0 0 3px rgba(245,158,11,0.15); }

    /* ── ASSOCIATE BAR ── */
    .takt-associate-bar { display: flex; align-items: center; gap: 10px; padding: 10px 24px; background: linear-gradient(135deg, #ecfdf5, #f0fdf4); border-bottom: 2px solid #86efac; flex-shrink: 0; position: relative; }
    .takt-assoc-nav-btn { width: 36px; height: 36px; border-radius: 10px; border: 2px solid #86efac; background: white; color: #16a34a; font-size: 16px; font-weight: 800; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.2s; font-family: 'Inter', sans-serif; flex-shrink: 0; }
    .takt-assoc-nav-btn:hover { background: #16a34a; color: white; border-color: #16a34a; }
    .takt-assoc-nav-btn:disabled { opacity: 0.3; cursor: not-allowed; }
    .takt-assoc-nav-btn:disabled:hover { background: white; color: #16a34a; }
    .takt-assoc-card { flex: 1; display: flex; align-items: center; gap: 12px; padding: 6px 16px; background: white; border-radius: 12px; border: 2px solid #86efac; min-width: 0; transition: all 0.3s; }
    .takt-assoc-avatar { width: 36px; height: 36px; border-radius: 10px; background: linear-gradient(135deg, #22c55e, #16a34a); color: white; font-size: 15px; font-weight: 800; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .takt-assoc-info { min-width: 0; flex: 1; }
    .takt-assoc-name { font-size: 14px; font-weight: 800; color: #1e293b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .takt-assoc-login { font-size: 11px; font-weight: 500; color: #64748b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .takt-assoc-stats { font-size: 10px; color: #16a34a; font-weight: 600; margin-top: 1px; }
    .takt-assoc-total-avg {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      padding: 6px 12px; border-radius: 10px; border: 2px solid #86efac;
      background: #f0fdf4; min-width: 72px; flex-shrink: 0; text-align: center;
    }
    .takt-assoc-total-avg.over { border-color: #fca5a5; background: #fef2f2; }
    .takt-assoc-total-avg-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; color: #64748b; }
    .takt-assoc-total-avg-value { font-size: 16px; font-weight: 800; color: #16a34a; line-height: 1.1; font-family: 'JetBrains Mono','SF Mono',monospace; }
    .takt-assoc-total-avg-value.over { color: #dc2626; }
    .takt-assoc-total-avg-target { font-size: 9px; color: #94a3b8; font-weight: 600; }
    .takt-assoc-counter { padding: 3px 10px; border-radius: 20px; background: #dcfce7; color: #16a34a; font-size: 11px; font-weight: 700; white-space: nowrap; flex-shrink: 0; }
    .takt-assoc-empty-card { flex: 1; display: flex; align-items: center; justify-content: center; padding: 12px 16px; background: white; border-radius: 12px; border: 2px dashed #86efac; color: #64748b; font-size: 13px; font-weight: 600; }
    .takt-assoc-actions { display: flex; gap: 6px; flex-shrink: 0; }
    .takt-assoc-action-btn { padding: 7px 14px; border-radius: 8px; border: 2px solid #86efac; background: white; color: #16a34a; font-size: 11px; font-weight: 700; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; gap: 5px; font-family: 'Inter', sans-serif; white-space: nowrap; }
    .takt-assoc-action-btn:hover { background: #16a34a; color: white; border-color: #16a34a; }
    .takt-assoc-action-btn.primary { background: linear-gradient(135deg, #22c55e, #16a34a); color: white; border-color: #16a34a; }
    .takt-assoc-action-btn.primary:hover { box-shadow: 0 4px 15px rgba(34,197,94,0.4); }
    .takt-assoc-delete-btn { width: 28px; height: 28px; border-radius: 6px; border: 1.5px solid #fca5a5; background: white; color: #ef4444; font-size: 13px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.2s; flex-shrink: 0; }
    .takt-assoc-delete-btn:hover { background: #ef4444; color: white; border-color: #ef4444; }

    /* ── SET BAR ── */
    .takt-set-bar { display: flex; align-items: center; gap: 10px; padding: 8px 24px; background: #fdf4ff; border-bottom: 2px solid #e879f9; flex-shrink: 0; flex-wrap: wrap; }
    .takt-set-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; color: #a21caf; }
    .takt-set-pills { display: flex; gap: 5px; flex-wrap: wrap; }
    .takt-set-pill {
      display: flex; flex-direction: column; align-items: center;
      padding: 5px 12px; border-radius: 8px; border: 2px solid #e879f9;
      background: white; color: #a21caf; font-size: 12px; font-weight: 600;
      cursor: pointer; transition: all 0.2s; font-family: 'Inter', sans-serif; position: relative; min-width: 64px;
    }
    .takt-set-pill:hover { border-color: #a21caf; background: #fdf4ff; }
    .takt-set-pill.selected { border-color: #a21caf; background: #a21caf; color: white; box-shadow: 0 2px 10px rgba(162,28,175,0.3); }
    .takt-set-pill.locked { border-color: #86efac; color: #16a34a; background: #f0fdf4; }
    .takt-set-pill.locked::after { content: '🔒'; position: absolute; top: -8px; right: -8px; font-size: 10px; }
    .takt-set-pill.selected.locked { background: #16a34a; color: white; border-color: #16a34a; }
    .takt-set-pill-title { font-size: 12px; font-weight: 700; line-height: 1; }
    .takt-set-pill-auditor { font-size: 9px; font-weight: 500; opacity: 0.75; margin-top: 2px; white-space: nowrap; overflow: hidden; max-width: 80px; text-overflow: ellipsis; }
    .takt-set-pill.selected .takt-set-pill-auditor { opacity: 0.85; }
    .takt-set-add-btn { padding: 6px 14px; border-radius: 8px; border: 2px dashed #e879f9; background: white; color: #a21caf; font-size: 12px; font-weight: 700; cursor: pointer; transition: all 0.2s; font-family: 'Inter', sans-serif; }
    .takt-set-add-btn:hover { background: #fdf4ff; border-style: solid; }
    .takt-set-add-btn:disabled { opacity: 0.3; cursor: not-allowed; }

    /* ── PROCESS BAR ── */
    .takt-process-bar { display: flex; align-items: center; gap: 16px; padding: 10px 24px; background: #eef2ff; border-bottom: 2px solid #c7d2fe; flex-shrink: 0; flex-wrap: wrap; }
    .takt-back-btn { display: flex; align-items: center; gap: 6px; padding: 6px 14px; border-radius: 8px; border: 2px solid #c7d2fe; background: white; color: #6366f1; font-size: 12px; font-weight: 700; cursor: pointer; transition: all 0.2s; font-family: 'Inter', sans-serif; }
    .takt-back-btn:hover { background: #eef2ff; }
    .takt-process-arrow { color: #a5b4fc; font-size: 18px; font-weight: 300; }
    .takt-dock-note { padding: 4px 12px; border-radius: 6px; background: rgba(245,158,11,0.12); color: #b45309; font-size: 11px; font-weight: 700; border: 1px solid #fde68a; white-space: nowrap; margin-left: auto; }

    /* ★ NEW: Reset Targets Button in process bar */
    .takt-reset-targets-btn {
      display: flex; align-items: center; gap: 5px;
      padding: 5px 12px; border-radius: 8px;
      border: 2px solid #c4b5fd; background: #f5f3ff;
      color: #7c3aed; font-size: 11px; font-weight: 700;
      cursor: pointer; transition: all 0.2s; font-family: 'Inter', sans-serif;
      white-space: nowrap; animation: reset-btn-glow 2s ease-in-out infinite;
    }
    .takt-reset-targets-btn:hover { background: #7c3aed; color: white; border-color: #7c3aed; }
    @keyframes reset-btn-glow {
      0%,100% { box-shadow: 0 0 0 0 rgba(124,58,237,0); }
      50% { box-shadow: 0 0 0 4px rgba(124,58,237,0.15); }
    }

    /* ── CONTROL BAR ── */
    .takt-control-bar { display: flex; align-items: center; gap: 10px; padding: 10px 24px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; flex-shrink: 0; flex-wrap: wrap; }
    .takt-obs-pills { display: flex; gap: 5px; }
    .takt-obs-pill { padding: 7px 16px; border-radius: 8px; border: 2px solid #e2e8f0; background: white; color: #64748b; font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.2s; position: relative; font-family: 'Inter', sans-serif; }
    .takt-obs-pill:hover { border-color: #6366f1; color: #6366f1; background: #eef2ff; }
    .takt-obs-pill.selected { border-color: #6366f1; background: #6366f1; color: white; box-shadow: 0 2px 10px rgba(99,102,241,0.3); }
    .takt-obs-pill.completed { border-color: #22c55e; color: #22c55e; background: #f0fdf4; }
    .takt-obs-pill.completed::after { content: '✓'; position: absolute; top: -6px; right: -6px; background: #22c55e; color: white; width: 16px; height: 16px; border-radius: 50%; font-size: 9px; display: flex; align-items: center; justify-content: center; border: 2px solid white; }
    .takt-control-sep { width: 1px; height: 32px; background: #e2e8f0; }
    .takt-btn-action { padding: 8px 20px; border-radius: 8px; border: none; font-size: 12px; font-weight: 700; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; gap: 6px; letter-spacing: 0.3px; font-family: 'Inter', sans-serif; white-space: nowrap; }
    .takt-btn-action.start-btn { background: linear-gradient(135deg, #22c55e, #16a34a); color: white; box-shadow: 0 2px 10px rgba(34,197,94,0.25); }
    .takt-btn-action.start-btn:hover { box-shadow: 0 4px 20px rgba(34,197,94,0.4); transform: translateY(-1px); }
    .takt-btn-action.recording-btn { background: linear-gradient(135deg, #ef4444, #dc2626); color: white; animation: rec-pulse 2s infinite; }
    @keyframes rec-pulse { 0%,100% { box-shadow: 0 2px 10px rgba(239,68,68,0.25); } 50% { box-shadow: 0 4px 25px rgba(239,68,68,0.5); } }
    .takt-btn-action:disabled { background: #e2e8f0; color: #94a3b8; cursor: not-allowed; box-shadow: none; transform: none; animation: none; }
    .takt-btn-action.clear-btn { background: white; color: #64748b; border: 2px solid #e2e8f0; }
    .takt-btn-action.clear-btn:hover { border-color: #f59e0b; color: #f59e0b; background: #fffbeb; }

    /* ── TIMER BAR ── */
    .takt-timer-bar { display: flex; align-items: center; justify-content: center; padding: 10px 24px; gap: 16px; background: white; border-bottom: 1px solid #e2e8f0; flex-shrink: 0; }
    .takt-timer-bar.hidden { display: none; }
    .takt-live-timer { font-size: 30px; font-weight: 800; font-family: 'JetBrains Mono','SF Mono',monospace; letter-spacing: 1px; color: #0f172a; }
    .takt-live-timer.recording { color: #ef4444; animation: timer-pulse 1.5s infinite alternate; }
    @keyframes timer-pulse { from { color: #ef4444; } to { color: #f87171; } }
    .takt-timer-task-label { font-size: 13px; font-weight: 600; color: #475569; padding: 5px 14px; background: #f1f5f9; border-radius: 8px; }
    .takt-timer-task-label .task-name { color: #6366f1; font-weight: 700; }
    .takt-rec-dot { width: 10px; height: 10px; border-radius: 50%; background: #ef4444; animation: rec-blink 1s infinite; }
    @keyframes rec-blink { 0%,100% { opacity: 1; } 50% { opacity: 0.2; } }

    /* ── TABLE ── */
    .takt-table-wrap { flex: 1; overflow-y: auto; min-height: 0; }
    .takt-table-wrap::-webkit-scrollbar { width: 6px; }
    .takt-table-wrap::-webkit-scrollbar-track { background: #f8fafc; }
    .takt-table-wrap::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
    .takt-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .takt-table thead { position: sticky; top: 0; z-index: 2; }
    .takt-table thead th { background: #f1f5f9; color: #475569; font-weight: 700; font-size: 10px; text-transform: uppercase; letter-spacing: 1px; padding: 8px 14px; text-align: center; border-bottom: 2px solid #e2e8f0; white-space: nowrap; }
    .takt-table thead th:first-child { text-align: left; padding-left: 24px; min-width: 280px; }
    .takt-table thead th.obs-header { min-width: 100px; position: relative; }
    .takt-table thead th.obs-header.active { background: #eef2ff; color: #6366f1; }
    .takt-table thead th.obs-header.active::after { content: ''; position: absolute; bottom: -2px; left: 0; right: 0; height: 3px; background: #6366f1; }
    .takt-table thead th.avg-header { min-width: 80px; background: #fefce8; color: #92400e; }
    .takt-table thead th.pavg-header { min-width: 80px; background: #f0fdf4; color: #166534; }
    .takt-table tbody tr { transition: background 0.15s; }
    .takt-table tbody tr:hover { background: #f8fafc; }
    .takt-table tbody tr.current-task-row { background: #eef2ff; }
    .takt-table tbody tr.current-task-row td:first-child { border-left: 4px solid #6366f1; padding-left: 20px; }
    .takt-table tbody td { padding: 7px 14px; text-align: center; border-bottom: 1px solid #f1f5f9; color: #334155; font-weight: 500; }
    .takt-table tbody td:first-child { text-align: left; padding-left: 24px; color: #1e293b; font-weight: 500; }
    .takt-table tbody td.target-col { color: #94a3b8; font-size: 11px; font-weight: 600; background: #fafbfc; }
    .takt-table tbody td.obs-cell { font-family: 'JetBrains Mono',monospace; font-weight: 700; font-size: 13px; min-width: 80px; }
    .takt-table tbody td.obs-cell.good { color: #16a34a; background: #f0fdf4; }
    .takt-table tbody td.obs-cell.over { color: #dc2626; background: #fef2f2; }
    .takt-table tbody td.obs-cell.no-target { color: #1e293b; background: #fefce8; }
    .takt-table tbody td.obs-cell.active-col { background: #eef2ff; }
    .takt-table tbody td.obs-cell.current-cell { background: #6366f1; color: white; box-shadow: inset 0 0 0 2px #4f46e5; }
    .takt-table tbody td.obs-cell.current-cell::after { content: ' ⏱'; font-size: 11px; }
    .takt-table tbody td.obs-cell.empty { color: #d1d5db; }
    .takt-table tbody td.obs-cell.empty-active { color: #c7d2fe; background: #eef2ff; }
    .takt-table tbody td.avg-cell { background: #fffbeb; font-weight: 700; font-size: 12px; font-family: 'JetBrains Mono',monospace; color: #92400e; }
    .takt-table tbody td.avg-cell.good { color: #16a34a; background: #fefce8; }
    .takt-table tbody td.avg-cell.over { color: #dc2626; background: #fef2f2; }
    .takt-table tbody td.pavg-cell { background: #f0fdf4; font-weight: 700; font-size: 12px; font-family: 'JetBrains Mono',monospace; color: #166534; }
    .takt-table tbody tr.row-start-time td, .takt-table tbody tr.row-end-time td { font-weight: 600; color: #6366f1; border-bottom: 1px solid #e2e8f0; padding: 6px 14px; }
    .takt-table tbody tr.row-start-time td:first-child, .takt-table tbody tr.row-end-time td:first-child { color: #475569; font-weight: 700; }
    .takt-table tbody tr.row-total { background: linear-gradient(135deg, #f8fafc, #f1f5f9); border-top: 2px solid #e2e8f0; }
    .takt-table tbody tr.row-total td { font-weight: 800; font-size: 13px; padding: 10px 14px; color: #1e293b; }
    .takt-table tbody tr.row-total td.obs-cell.good { color: #16a34a; background: #dcfce7; }
    .takt-table tbody tr.row-total td.obs-cell.over { color: #dc2626; background: #fee2e2; }

    /* ── TASK NAME CELL ── */
    .takt-task-cell { display: flex; align-items: center; gap: 8px; }
    .takt-task-name { flex: 1; }
    .takt-task-avg-chip {
      display: inline-flex; align-items: center; gap: 3px;
      padding: 2px 7px; border-radius: 20px; font-size: 10px; font-weight: 700;
      font-family: 'JetBrains Mono','SF Mono',monospace;
      border: 1.5px solid; white-space: nowrap; flex-shrink: 0;
    }
    .takt-task-avg-chip.good { background: #dcfce7; color: #16a34a; border-color: #86efac; }
    .takt-task-avg-chip.over { background: #fee2e2; color: #dc2626; border-color: #fca5a5; }
    .takt-task-avg-chip.neutral { background: #f1f5f9; color: #475569; border-color: #cbd5e1; }

    /* ★ NEW: EDITABLE TARGET INPUT */
    .takt-target-input {
      width: 52px; padding: 3px 4px; border-radius: 6px;
      border: 1.5px solid #e2e8f0; background: white;
      color: #64748b; font-size: 11px; font-weight: 700;
      font-family: 'JetBrains Mono','SF Mono',monospace;
      text-align: center; outline: none; transition: all 0.2s;
      cursor: pointer;
    }
    .takt-target-input:hover { border-color: #a78bfa; }
    .takt-target-input:focus { border-color: #7c3aed; box-shadow: 0 0 0 3px rgba(124,58,237,0.15); color: #7c3aed; }
    .takt-target-input:disabled { cursor: default; opacity: 0.6; background: #f8fafc; }
    .takt-target-input:disabled:hover { border-color: #e2e8f0; }

    /* ★ NEW: Customized target — purple highlight */
    .takt-target-input.customized {
      border-color: #a78bfa; color: #7c3aed; background: #f5f3ff;
      font-weight: 800;
    }
    .takt-target-input.customized:not(:focus) {
      animation: custom-target-shimmer 3s ease-in-out infinite;
    }
    @keyframes custom-target-shimmer {
      0%,100% { box-shadow: 0 0 0 0 rgba(124,58,237,0); }
      50% { box-shadow: 0 0 0 3px rgba(124,58,237,0.1); }
    }

    /* ★ NEW: Total row target — "was Xs" note */
    .takt-target-was {
      display: block; font-size: 9px; font-weight: 600;
      color: #a78bfa; margin-top: 2px; font-style: italic;
    }

    /* ★ NEW: Custom badge in summary view */
    .takt-custom-badge {
      display: inline-flex; align-items: center; gap: 3px;
      padding: 1px 6px; border-radius: 4px;
      background: #f5f3ff; color: #7c3aed;
      font-size: 9px; font-weight: 700;
      border: 1px solid #c4b5fd;
      margin-left: 6px; white-space: nowrap;
    }

    /* ★ NEW: Recalc status strip */
    .takt-recalc-strip {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 24px; background: #f5f3ff;
      border-bottom: 2px solid #c4b5fd;
      font-size: 12px; font-weight: 600; color: #7c3aed;
      flex-shrink: 0; animation: recalc-strip-in 0.3s ease;
    }
    @keyframes recalc-strip-in { from { opacity: 0; max-height: 0; padding: 0 24px; } to { opacity: 1; max-height: 50px; } }
    .takt-recalc-strip.success { background: #f0fdf4; border-color: #86efac; color: #16a34a; }
    .takt-recalc-strip .takt-recalc-spinner {
      width: 14px; height: 14px; border: 2px solid #c4b5fd;
      border-top-color: #7c3aed; border-radius: 50%;
      animation: recalc-spin 0.8s linear infinite;
    }
    @keyframes recalc-spin { to { transform: rotate(360deg); } }

    /* ★ NEW: Target change confirmation modal */
    .takt-target-confirm-overlay {
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(255,255,255,0.88); backdrop-filter: blur(8px);
      display: flex; align-items: center; justify-content: center;
      z-index: 12; border-radius: 20px;
      animation: target-confirm-in 0.25s ease;
    }
    @keyframes target-confirm-in { from { opacity: 0; } to { opacity: 1; } }
    .takt-target-confirm-box {
      background: white; border-radius: 18px; padding: 28px; width: 420px;
      text-align: left; box-shadow: 0 20px 60px rgba(0,0,0,0.12);
      border: 2px solid #c4b5fd; animation: form-pop 0.25s ease;
    }
    .takt-target-confirm-title {
      font-size: 17px; font-weight: 800; color: #1e293b; margin-bottom: 6px;
      display: flex; align-items: center; gap: 8px;
    }
    .takt-target-confirm-path {
      font-size: 12px; font-weight: 600; color: #7c3aed; margin-bottom: 14px;
      padding: 4px 10px; background: #f5f3ff; border-radius: 6px; display: inline-block;
    }
    .takt-target-confirm-change {
      display: flex; align-items: center; gap: 8px; padding: 8px 12px;
      background: #f8fafc; border-radius: 8px; margin-bottom: 10px;
      font-size: 13px; font-weight: 600; color: #334155;
    }
    .takt-target-confirm-change .old-val {
      color: #94a3b8; text-decoration: line-through; font-family: 'JetBrains Mono',monospace; font-weight: 700;
    }
    .takt-target-confirm-change .new-val {
      color: #7c3aed; font-family: 'JetBrains Mono',monospace; font-weight: 800;
    }
    .takt-target-confirm-change .change-arrow { color: #a78bfa; font-weight: 800; }
    .takt-target-confirm-warn {
      padding: 10px 14px; border-radius: 10px;
      background: #fffbeb; border: 1.5px solid #fde68a;
      margin: 14px 0; font-size: 12px; color: #92400e; line-height: 1.6;
    }
    .takt-target-confirm-warn-title {
      font-weight: 800; font-size: 12px; color: #b45309; margin-bottom: 4px;
      display: flex; align-items: center; gap: 5px;
    }
    .takt-target-confirm-warn ul {
      margin: 4px 0 0 16px; padding: 0; list-style: disc;
    }
    .takt-target-confirm-warn li { margin-bottom: 2px; }
    .takt-target-confirm-btns { display: flex; gap: 8px; margin-top: 18px; }
    .takt-target-confirm-btns button {
      flex: 1; padding: 11px; border-radius: 10px; font-size: 13px; font-weight: 700;
      cursor: pointer; border: none; transition: all 0.2s; font-family: 'Inter', sans-serif;
    }
    .takt-target-confirm-cancel { background: #f1f5f9; color: #64748b; }
    .takt-target-confirm-cancel:hover { background: #e2e8f0; }
    .takt-target-confirm-apply {
      background: linear-gradient(135deg, #7c3aed, #6d28d9); color: white;
    }
    .takt-target-confirm-apply:hover { box-shadow: 0 4px 15px rgba(124,58,237,0.4); }

    /* ── COACHING ── */
    .takt-coaching-section { padding: 10px 24px; background: #fffbeb; border-top: 2px solid #fde68a; flex-shrink: 0; }
    .takt-coaching-header { display: flex; align-items: center; justify-content: space-between; cursor: pointer; user-select: none; }
    .takt-coaching-title { font-size: 12px; font-weight: 800; color: #a16207; text-transform: uppercase; letter-spacing: 0.8px; display: flex; align-items: center; gap: 6px; }
    .takt-coaching-toggle { font-size: 11px; font-weight: 600; color: #d97706; }
    .takt-coaching-body { overflow: hidden; transition: max-height 0.3s ease; }
    .takt-coaching-body.collapsed { max-height: 0; }
    .takt-coaching-body.expanded { max-height: 200px; }
    .takt-coaching-textarea { width: 100%; height: 80px; margin-top: 8px; padding: 10px 14px; border-radius: 10px; border: 2px solid #fde68a; background: white; font-size: 13px; font-weight: 500; font-family: 'Inter', sans-serif; color: #1e293b; outline: none; resize: vertical; transition: border-color 0.2s; box-sizing: border-box; }
    .takt-coaching-textarea:focus { border-color: #f59e0b; box-shadow: 0 0 0 3px rgba(245,158,11,0.15); }
    .takt-coaching-textarea:disabled { background: #f9fafb; color: #9ca3af; }

    /* ── PROGRESS ── */
    .takt-progress-section { padding: 8px 24px; background: #f8fafc; border-top: 1px solid #e2e8f0; display: flex; align-items: center; gap: 14px; flex-shrink: 0; }
    .takt-progress-section.hidden { display: none; }
    .takt-progress-bar-bg { flex: 1; height: 6px; background: #e2e8f0; border-radius: 3px; overflow: hidden; }
    .takt-progress-bar-fill { height: 100%; background: linear-gradient(90deg, #6366f1, #8b5cf6); border-radius: 3px; transition: width 0.5s; }
    .takt-progress-text { font-size: 11px; font-weight: 700; color: #6366f1; white-space: nowrap; }

    /* ── FOOTER ── */
    .takt-footer { padding: 10px 24px; border-top: 1px solid #e2e8f0; display: flex; align-items: center; justify-content: space-between; background: #fafbfc; flex-shrink: 0; }
    .takt-footer-left { display: flex; gap: 6px; }
    .takt-footer-btn { padding: 6px 14px; border-radius: 7px; border: 1.5px solid #e2e8f0; background: white; color: #64748b; font-size: 11px; font-weight: 600; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; gap: 5px; font-family: 'Inter', sans-serif; }
    .takt-footer-btn:hover { border-color: #6366f1; color: #6366f1; background: #eef2ff; }
    .takt-footer-btn.danger:hover { border-color: #ef4444; color: #ef4444; background: #fef2f2; }
    .takt-footer-status { font-size: 11px; color: #94a3b8; font-weight: 500; }

    /* ── CONFIRM OVERLAY ── */
    .takt-confirm-overlay { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(255,255,255,0.85); backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; z-index: 10; border-radius: 20px; }
    .takt-confirm-box { background: white; border-radius: 18px; padding: 28px; width: 320px; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,0.1); border: 1px solid #e2e8f0; }
    .takt-confirm-icon { width: 52px; height: 52px; border-radius: 50%; background: #fef2f2; display: flex; align-items: center; justify-content: center; margin: 0 auto 14px; font-size: 22px; }
    .takt-confirm-title { font-size: 16px; font-weight: 800; color: #1e293b; margin-bottom: 6px; }
    .takt-confirm-msg { font-size: 13px; color: #64748b; margin-bottom: 20px; line-height: 1.5; }
    .takt-confirm-btns { display: flex; gap: 8px; }
    .takt-confirm-btns button { flex: 1; padding: 10px; border-radius: 10px; font-size: 13px; font-weight: 700; cursor: pointer; border: none; transition: all 0.2s; font-family: 'Inter', sans-serif; }
    .takt-confirm-cancel { background: #f1f5f9; color: #64748b; }
    .takt-confirm-cancel:hover { background: #e2e8f0; }
    .takt-confirm-ok { background: linear-gradient(135deg, #ef4444, #dc2626); color: white; }
    .takt-confirm-ok:hover { box-shadow: 0 4px 15px rgba(239,68,68,0.3); }

    /* ── TOAST ── */
    .takt-toast { position: fixed; bottom: 100px; left: 50%; transform: translateX(-50%) translateY(20px); background: #1e293b; color: white; padding: 10px 22px; border-radius: 10px; font-family: 'Inter', sans-serif; font-size: 12px; font-weight: 600; z-index: 9999999; opacity: 0; transition: all 0.3s; box-shadow: 0 8px 30px rgba(0,0,0,0.2); }
    .takt-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

    /* ── EMPTY STATE ── */
    .takt-empty-state { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #94a3b8; gap: 12px; padding: 40px; }
    .takt-empty-state-icon { font-size: 48px; opacity: 0.5; }
    .takt-empty-state-title { font-size: 18px; font-weight: 800; color: #64748b; }
    .takt-empty-state-msg { font-size: 13px; color: #94a3b8; text-align: center; max-width: 300px; line-height: 1.6; }
    .takt-empty-state-btn { margin-top: 8px; padding: 12px 28px; border-radius: 12px; border: none; background: linear-gradient(135deg, #22c55e, #16a34a); color: white; font-size: 14px; font-weight: 700; cursor: pointer; transition: all 0.2s; font-family: 'Inter', sans-serif; }
    .takt-empty-state-btn:hover { box-shadow: 0 8px 25px rgba(34,197,94,0.4); transform: translateY(-2px); }

    /* ── SUMMARY VIEW ── */
    .takt-summary-wrap { flex: 1; overflow-y: auto; padding: 16px 24px; min-height: 0; }
    .takt-summary-wrap::-webkit-scrollbar { width: 6px; }
    .takt-summary-wrap::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
    .takt-summary-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #94a3b8; margin-bottom: 10px; }
    .takt-summary-table { width: 100%; border-collapse: collapse; }
    .takt-summary-parent-row td { padding: 10px 16px 4px; font-size: 14px; font-weight: 800; color: #0f172a; border-bottom: 2px solid #e2e8f0; }
    .takt-summary-row { cursor: pointer; transition: all 0.15s; border-bottom: 1px solid #f8fafc; }
    .takt-summary-row:hover { background: #eef2ff; }
    .takt-summary-row.done { background: #f0fdf4; }
    .takt-summary-row.done:hover { background: #dcfce7; }
    .takt-summary-row td { padding: 9px 16px; }
    .takt-summary-sub-cell { display: flex; align-items: center; gap: 8px; width: 200px; }
    .takt-summary-sub-arrow { color: #cbd5e1; font-size: 14px; font-weight: 700; }
    .takt-summary-sub-label { font-size: 13px; font-weight: 600; color: #475569; }
    .takt-summary-row:hover .takt-summary-sub-label { color: #6366f1; }
    .takt-summary-row:hover .takt-summary-sub-arrow { color: #6366f1; }
    .takt-summary-progress-wrap { display: flex; align-items: center; gap: 10px; }
    .takt-summary-bar-bg { flex: 1; height: 6px; background: #e2e8f0; border-radius: 3px; overflow: hidden; }
    .takt-summary-bar-fill { height: 100%; border-radius: 3px; transition: width 0.4s ease; }
    .takt-summary-bar-fill.complete { background: linear-gradient(90deg, #22c55e, #16a34a); }
    .takt-summary-bar-fill.partial { background: linear-gradient(90deg, #6366f1, #8b5cf6); }
    .takt-summary-bar-fill.empty { width: 0 !important; }
    .takt-summary-status { font-size: 12px; font-weight: 700; white-space: nowrap; min-width: 50px; text-align: right; }
    .takt-summary-status.complete { color: #16a34a; }
    .takt-summary-status.partial { color: #6366f1; }
    .takt-summary-status.empty { color: #cbd5e1; }
    .takt-summary-avg { font-size: 11px; font-weight: 600; color: #64748b; white-space: nowrap; }
    .takt-summary-avg.good { color: #16a34a; }
    .takt-summary-avg.over { color: #dc2626; }
    .takt-summary-go { color: #cbd5e1; font-size: 14px; font-weight: 700; margin-left: 4px; }
    .takt-summary-row:hover .takt-summary-go { color: #6366f1; }
    .takt-summary-spacer td { padding: 6px; }

    /* ── SEARCH OVERLAY ── */
    .takt-search-overlay { position: absolute; top: 100%; left: 24px; right: 24px; background: white; border-radius: 14px; border: 2px solid #e2e8f0; box-shadow: 0 20px 60px rgba(0,0,0,0.12); z-index: 20; max-height: 300px; overflow: hidden; display: flex; flex-direction: column; animation: search-in 0.2s ease; }
    @keyframes search-in { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
    .takt-search-input-wrap { padding: 12px; border-bottom: 1px solid #f1f5f9; display: flex; align-items: center; gap: 8px; }
    .takt-search-input-wrap svg { width: 18px; height: 18px; fill: #94a3b8; flex-shrink: 0; }
    .takt-search-input { flex: 1; border: none; outline: none; font-size: 14px; font-weight: 500; font-family: 'Inter', sans-serif; color: #1e293b; background: transparent; }
    .takt-search-results { overflow-y: auto; max-height: 220px; padding: 6px; }
    .takt-search-result { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px; cursor: pointer; transition: background 0.15s; }
    .takt-search-result:hover { background: #f0fdf4; }
    .takt-search-result-avatar { width: 32px; height: 32px; border-radius: 8px; background: linear-gradient(135deg, #22c55e, #16a34a); color: white; font-size: 13px; font-weight: 800; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .takt-search-result-info { flex: 1; min-width: 0; }
    .takt-search-result-name { font-size: 13px; font-weight: 700; color: #1e293b; }
    .takt-search-result-login { font-size: 11px; color: #64748b; }
    .takt-search-result.active { background: #ecfdf5; border: 1px solid #86efac; }
    .takt-search-no-results { padding: 16px; text-align: center; color: #94a3b8; font-size: 13px; }
    .takt-search-add-new { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-top: 1px solid #f1f5f9; cursor: pointer; transition: background 0.15s; color: #6366f1; font-size: 12px; font-weight: 700; }
    .takt-search-add-new:hover { background: #eef2ff; }

    /* ── ADD FORM ── */
    .takt-add-overlay { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(255,255,255,0.9); backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; z-index: 15; border-radius: 20px; }
    .takt-add-form { background: white; border-radius: 18px; padding: 28px; width: 380px; box-shadow: 0 20px 60px rgba(0,0,0,0.12); border: 2px solid #86efac; animation: form-pop 0.25s ease; }
    @keyframes form-pop { from { opacity: 0; transform: scale(0.9); } to { opacity: 1; transform: scale(1); } }
    .takt-add-form-title { font-size: 18px; font-weight: 800; color: #1e293b; margin-bottom: 4px; display: flex; align-items: center; gap: 8px; }
    .takt-add-form-sub { font-size: 12px; color: #64748b; margin-bottom: 20px; }
    .takt-add-field { margin-bottom: 14px; }
    .takt-add-field label { display: block; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; color: #475569; margin-bottom: 5px; }
    .takt-add-field input { width: 100%; padding: 10px 14px; border-radius: 10px; border: 2px solid #e2e8f0; font-size: 14px; font-weight: 600; font-family: 'Inter', sans-serif; color: #1e293b; outline: none; transition: all 0.2s; box-sizing: border-box; }
    .takt-add-field input:focus { border-color: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,0.15); }
    .takt-add-warn { font-size: 11px; color: #d97706; font-weight: 600; margin-top: 4px; display: none; }
    .takt-add-btns { display: flex; gap: 8px; margin-top: 20px; }
    .takt-add-btns button { flex: 1; padding: 11px; border-radius: 10px; font-size: 13px; font-weight: 700; cursor: pointer; border: none; transition: all 0.2s; font-family: 'Inter', sans-serif; }
    .takt-add-cancel { background: #f1f5f9; color: #64748b; }
    .takt-add-cancel:hover { background: #e2e8f0; }
    .takt-add-submit { background: linear-gradient(135deg, #22c55e, #16a34a); color: white; }
    .takt-add-submit:hover { box-shadow: 0 4px 15px rgba(34,197,94,0.4); }
    .takt-add-submit:disabled { opacity: 0.5; cursor: not-allowed; }

    /* ── FASTEST / SLOWEST HIGHLIGHT ── */
    .obs-fastest { box-shadow: inset 0 0 0 3px #f59e0b !important; position: relative; }
    .obs-fastest::before { content: ''; position: absolute; inset: 0; background: rgba(245,158,11,0.08); pointer-events: none; }
    .obs-slowest { box-shadow: inset 0 0 0 3px #94a3b8 !important; position: relative; }
    .obs-slowest::before { content: ''; position: absolute; inset: 0; background: rgba(148,163,184,0.08); pointer-events: none; }

    /* ── COMPACT MODE ── */
    #takt-panel.compact .takt-auditor-bar { padding: 4px 16px; }
    #takt-panel.compact .takt-auditor-input { padding: 3px 8px; font-size: 11px; }
    #takt-panel.compact .takt-associate-bar { padding: 6px 16px; }
    #takt-panel.compact .takt-assoc-card { padding: 4px 10px; }
    #takt-panel.compact .takt-assoc-avatar { width: 28px; height: 28px; font-size: 12px; }
    #takt-panel.compact .takt-assoc-name { font-size: 12px; }
    #takt-panel.compact .takt-day-nav { padding: 5px 16px; }
    #takt-panel.compact .takt-set-bar { padding: 5px 16px; }
    #takt-panel.compact .takt-process-bar { padding: 6px 16px; }
    #takt-panel.compact .takt-control-bar { padding: 6px 16px; }
    #takt-panel.compact .takt-coaching-section { padding: 6px 16px; }
    #takt-panel.compact .takt-footer { padding: 6px 16px; }
    #takt-panel.compact .takt-table thead th { padding: 5px 10px; font-size: 9px; }
    #takt-panel.compact .takt-table tbody td { padding: 4px 10px; font-size: 11px; }
    #takt-panel.compact .takt-header { padding: 10px 16px; }
    #takt-panel.compact .takt-assoc-total-avg { padding: 4px 8px; min-width: 60px; }
    #takt-panel.compact .takt-assoc-total-avg-value { font-size: 13px; }
    #takt-panel.compact .takt-target-input { width: 44px; padding: 2px 3px; font-size: 10px; }

    /* ── DARK MODE ── */
    #takt-panel.dark { background: #0f172a; color: #e2e8f0; box-shadow: 0 25px 80px rgba(0,0,0,0.5), 0 0 0 1px rgba(99,102,241,0.2); }
    #takt-panel.dark .takt-day-nav { background: linear-gradient(135deg,#1e293b,#172035); border-color: #334155; }
    #takt-panel.dark .takt-day-label { color: #cbd5e1; }
    #takt-panel.dark .takt-day-btn { background: #1e293b; border-color: #334155; color: #7dd3fc; }
    #takt-panel.dark .takt-day-btn:hover { background: #0284c7; border-color: #0284c7; }
    #takt-panel.dark .takt-day-today-btn { background: #1e293b; border-color: #334155; color: #7dd3fc; }
    #takt-panel.dark .takt-day-today-btn.is-today { background: #0284c7; color: white; }
    #takt-panel.dark .takt-auditor-bar { background: #1e293b; border-color: #334155; }
    #takt-panel.dark .takt-auditor-label { color: #94a3b8; }
    #takt-panel.dark .takt-auditor-input { background: #0f172a; border-color: #334155; color: #e2e8f0; }
    #takt-panel.dark .takt-auditor-input:focus { border-color: #6366f1; }
    #takt-panel.dark .takt-associate-bar { background: linear-gradient(135deg,#0f2318,#0d1f14); border-color: #166534; }
    #takt-panel.dark .takt-assoc-card { background: #1e293b; border-color: #166534; }
    #takt-panel.dark .takt-assoc-name { color: #f1f5f9; }
    #takt-panel.dark .takt-assoc-login { color: #94a3b8; }
    #takt-panel.dark .takt-assoc-empty-card { background: #1e293b; border-color: #334155; color: #64748b; }
    #takt-panel.dark .takt-assoc-nav-btn { background: #1e293b; border-color: #166534; color: #4ade80; }
    #takt-panel.dark .takt-assoc-action-btn { background: #1e293b; border-color: #166534; color: #4ade80; }
    #takt-panel.dark .takt-assoc-action-btn:hover { background: #166534; color: white; }
    #takt-panel.dark .takt-assoc-action-btn.primary { background: linear-gradient(135deg,#16a34a,#15803d); }
    #takt-panel.dark .takt-assoc-total-avg { background: #0f2318; border-color: #166534; }
    #takt-panel.dark .takt-assoc-total-avg.over { background: #2d1010; border-color: #7f1d1d; }
    #takt-panel.dark .takt-assoc-delete-btn { background: #1e293b; border-color: #7f1d1d; color: #f87171; }
    #takt-panel.dark .takt-set-bar { background: #1a0d1f; border-color: #6b21a8; }
    #takt-panel.dark .takt-set-label { color: #c084fc; }
    #takt-panel.dark .takt-set-pill { background: #1e293b; border-color: #6b21a8; color: #c084fc; }
    #takt-panel.dark .takt-set-pill.selected { background: #6b21a8; color: white; }
    #takt-panel.dark .takt-set-pill.locked { background: #0f2318; border-color: #166534; color: #4ade80; }
    #takt-panel.dark .takt-set-add-btn { background: #1e293b; border-color: #6b21a8; color: #c084fc; }
    #takt-panel.dark .takt-process-bar { background: #1a1f3a; border-color: #334155; }
    #takt-panel.dark .takt-back-btn { background: #1e293b; border-color: #334155; color: #818cf8; }
    #takt-panel.dark .takt-control-bar { background: #0f172a; border-color: #1e293b; }
    #takt-panel.dark .takt-obs-pill { background: #1e293b; border-color: #334155; color: #94a3b8; }
    #takt-panel.dark .takt-obs-pill:hover { background: #1e2a4a; border-color: #6366f1; color: #818cf8; }
    #takt-panel.dark .takt-obs-pill.selected { background: #6366f1; border-color: #6366f1; color: white; }
    #takt-panel.dark .takt-obs-pill.completed { background: #0f2318; border-color: #166534; color: #4ade80; }
    #takt-panel.dark .takt-timer-bar { background: #0f172a; border-color: #1e293b; }
    #takt-panel.dark .takt-timer-task-label { background: #1e293b; color: #94a3b8; }
    #takt-panel.dark .takt-table-wrap { background: #0f172a; }
    #takt-panel.dark .takt-table thead th { background: #1e293b; color: #64748b; border-color: #334155; }
    #takt-panel.dark .takt-table thead th.obs-header.active { background: #1e2a4a; color: #818cf8; }
    #takt-panel.dark .takt-table thead th.avg-header { background: #241f0a; color: #d97706; }
    #takt-panel.dark .takt-table thead th.pavg-header { background: #0a1f10; color: #4ade80; }
    #takt-panel.dark .takt-table tbody tr:hover { background: #1a2234; }
    #takt-panel.dark .takt-table tbody tr.current-task-row { background: #1e2a4a; }
    #takt-panel.dark .takt-table tbody td { color: #cbd5e1; border-color: #1e293b; }
    #takt-panel.dark .takt-table tbody td:first-child { color: #e2e8f0; }
    #takt-panel.dark .takt-table tbody td.target-col { background: #161d2d; color: #475569; }
    #takt-panel.dark .takt-table tbody td.obs-cell.good { color: #4ade80; background: #0a2010; }
    #takt-panel.dark .takt-table tbody td.obs-cell.over { color: #f87171; background: #2d1010; }
    #takt-panel.dark .takt-table tbody td.obs-cell.no-target { color: #f1f5f9; background: #1e2218; }
    #takt-panel.dark .takt-table tbody td.obs-cell.empty { color: #334155; }
    #takt-panel.dark .takt-table tbody td.obs-cell.active-col { background: #1e2a4a; }
    #takt-panel.dark .takt-table tbody td.avg-cell { background: #1e1a08; color: #d97706; }
    #takt-panel.dark .takt-table tbody td.avg-cell.good { color: #4ade80; background: #0a200d; }
    #takt-panel.dark .takt-table tbody td.avg-cell.over { color: #f87171; background: #2d1010; }
    #takt-panel.dark .takt-table tbody td.pavg-cell { background: #0a1f10; color: #4ade80; }
    #takt-panel.dark .takt-table tbody tr.row-total { background: #161d2d; }
    #takt-panel.dark .takt-table tbody tr.row-total td { color: #f1f5f9; }
    #takt-panel.dark .takt-table tbody tr.row-total td.obs-cell.good { color: #4ade80; background: #0a2010; }
    #takt-panel.dark .takt-table tbody tr.row-total td.obs-cell.over { color: #f87171; background: #2d1010; }
    #takt-panel.dark .takt-coaching-section { background: #1e1a08; border-color: #44360a; }
    #takt-panel.dark .takt-coaching-title { color: #d97706; }
    #takt-panel.dark .takt-coaching-textarea { background: #0f172a; border-color: #44360a; color: #e2e8f0; }
    #takt-panel.dark .takt-progress-section { background: #0f172a; border-color: #1e293b; }
    #takt-panel.dark .takt-footer { background: #0a0f1e; border-color: #1e293b; }
    #takt-panel.dark .takt-footer-btn { background: #1e293b; border-color: #334155; color: #94a3b8; }
    #takt-panel.dark .takt-footer-btn:hover { border-color: #6366f1; color: #818cf8; background: #1e2a4a; }
    #takt-panel.dark .takt-footer-status { color: #475569; }
    #takt-panel.dark .takt-loading-bar { background: #1e293b; }
    #takt-panel.dark .takt-summary-wrap { background: #0f172a; }
    #takt-panel.dark .takt-summary-title { color: #475569; }
    #takt-panel.dark .takt-summary-parent-row td { color: #f1f5f9; border-color: #1e293b; }
    #takt-panel.dark .takt-summary-row:hover { background: #1e2a4a; }
    #takt-panel.dark .takt-summary-row.done { background: #0a1f10; }
    #takt-panel.dark .takt-summary-row.done:hover { background: #0d2a15; }
    #takt-panel.dark .takt-summary-sub-label { color: #94a3b8; }
    #takt-panel.dark .takt-summary-bar-bg { background: #1e293b; }
    #takt-panel.dark .takt-summary-avg { color: #64748b; }
    #takt-panel.dark .takt-summary-avg.good { color: #4ade80; }
    #takt-panel.dark .takt-summary-avg.over { color: #f87171; }
    #takt-panel.dark .takt-task-avg-chip.neutral { background: #1e293b; color: #64748b; border-color: #334155; }
    #takt-panel.dark .takt-task-avg-chip.good { background: #0a2010; color: #4ade80; border-color: #166534; }
    #takt-panel.dark .takt-task-avg-chip.over { background: #2d1010; color: #f87171; border-color: #7f1d1d; }
    .takt-mode-btn { font-size: 10px !important; font-weight: 800 !important; letter-spacing: 0.5px; min-width: 30px; }

    /* ★ NEW: Dark mode for editable targets */
    #takt-panel.dark .takt-target-input {
      background: #1e293b; border-color: #334155; color: #94a3b8;
    }
    #takt-panel.dark .takt-target-input:hover { border-color: #7c3aed; }
    #takt-panel.dark .takt-target-input:focus { border-color: #7c3aed; color: #c4b5fd; background: #1a1530; }
    #takt-panel.dark .takt-target-input.customized {
      border-color: #7c3aed; color: #c4b5fd; background: #1a1530;
    }
    #takt-panel.dark .takt-target-was { color: #7c3aed; }
    #takt-panel.dark .takt-custom-badge { background: #1a1530; color: #c4b5fd; border-color: #6d28d9; }
    #takt-panel.dark .takt-reset-targets-btn { background: #1a1530; border-color: #6d28d9; color: #c4b5fd; }
    #takt-panel.dark .takt-reset-targets-btn:hover { background: #6d28d9; color: white; }
    #takt-panel.dark .takt-recalc-strip { background: #1a1530; border-color: #6d28d9; color: #c4b5fd; }
    #takt-panel.dark .takt-recalc-strip.success { background: #0a1f10; border-color: #166534; color: #4ade80; }
    #takt-panel.dark .takt-target-confirm-overlay { background: rgba(15,23,42,0.88); }
    #takt-panel.dark .takt-target-confirm-box { background: #1e293b; border-color: #6d28d9; }
    #takt-panel.dark .takt-target-confirm-title { color: #f1f5f9; }
    #takt-panel.dark .takt-target-confirm-path { background: #1a1530; color: #c4b5fd; }
    #takt-panel.dark .takt-target-confirm-change { background: #0f172a; color: #cbd5e1; }
    #takt-panel.dark .takt-target-confirm-warn { background: #1e1a08; border-color: #44360a; color: #fbbf24; }
    #takt-panel.dark .takt-target-confirm-cancel { background: #0f172a; color: #94a3b8; }
    #takt-panel.dark .takt-target-confirm-cancel:hover { background: #1e293b; }

    /* ★ NEW: FULL-SCREEN BLOCKING UPDATE MODAL */
    .takt-update-fullscreen {
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(15,23,42,0.7); backdrop-filter: blur(8px);
      display: flex; align-items: center; justify-content: center;
      z-index: 99999999;
      animation: update-fade-in 0.3s ease;
    }
    @keyframes update-fade-in { from { opacity: 0; } to { opacity: 1; } }
    .takt-update-box {
      background: white; border-radius: 22px; padding: 36px 32px 28px;
      width: 420px; text-align: center;
      box-shadow: 0 30px 80px rgba(0,0,0,0.25), 0 0 0 1px rgba(99,102,241,0.15);
      border: 2px solid #e0e7ff;
      animation: update-pop 0.35s cubic-bezier(0.34,1.56,0.64,1);
    }
    @keyframes update-pop { from { opacity: 0; transform: scale(0.85) translateY(20px); } to { opacity: 1; transform: scale(1) translateY(0); } }
    .takt-update-icon { font-size: 44px; margin-bottom: 12px; animation: rocket-bob 1.5s ease-in-out infinite; }
    @keyframes rocket-bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
    .takt-update-title { font-size: 22px; font-weight: 800; color: #1e293b; margin-bottom: 14px; letter-spacing: -0.5px; }
    .takt-update-versions {
      display: inline-flex; align-items: center; gap: 10px;
      background: #f1f5f9; border-radius: 12px; padding: 8px 18px;
      margin-bottom: 18px;
    }
    .takt-update-ver-old { font-size: 15px; font-weight: 700; color: #94a3b8; font-family: 'JetBrains Mono','SF Mono',monospace; text-decoration: line-through; }
    .takt-update-ver-arrow { font-size: 18px; color: #6366f1; font-weight: 800; }
    .takt-update-ver-new { font-size: 18px; font-weight: 800; color: #6366f1; font-family: 'JetBrains Mono','SF Mono',monospace; }
    .takt-update-msg { font-size: 13px; color: #64748b; line-height: 1.6; margin-bottom: 16px; }
    .takt-update-steps { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; text-align: left; }
    .takt-update-step { display: flex; align-items: center; gap: 10px; font-size: 13px; font-weight: 600; color: #334155; }
    .takt-update-step-num { width: 22px; height: 22px; border-radius: 50%; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; font-size: 11px; font-weight: 800; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }

    /* ★ NEW: Data safety message in update modal */
    .takt-update-safe {
      padding: 10px 14px; border-radius: 10px;
      background: #f0fdf4; border: 1.5px solid #86efac;
      font-size: 12px; color: #166534; line-height: 1.5;
      margin-bottom: 20px; text-align: left;
    }
    .takt-update-safe-icon { font-size: 14px; }

    .takt-update-btns { display: flex; gap: 10px; }
    .takt-update-skip { flex: 1; padding: 11px; border-radius: 10px; border: 2px solid #e2e8f0; background: white; color: #64748b; font-size: 13px; font-weight: 700; cursor: pointer; transition: all 0.2s; font-family: 'Inter',sans-serif; }
    .takt-update-skip:hover { background: #f1f5f9; border-color: #cbd5e1; }
    .takt-update-go { flex: 2; padding: 11px; border-radius: 10px; border: none; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; font-size: 14px; font-weight: 800; cursor: pointer; transition: all 0.2s; font-family: 'Inter',sans-serif; letter-spacing: 0.2px; }
    .takt-update-go:hover { box-shadow: 0 6px 20px rgba(99,102,241,0.45); transform: translateY(-1px); }
  `;
  document.head.appendChild(styles);

  // ── BUILD UI SHELLS (unchanged) ────────────────────────
  var backdrop = document.createElement('div');
  backdrop.id = 'takt-backdrop';
  document.body.appendChild(backdrop);

  var fab = document.createElement('div');
  fab.id = 'takt-fab';
  fab.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.5-13H11v6l5.2 3.2.8-1.3-4.5-2.7V7z"/></svg><div id="takt-badge">0</div>';
  document.body.appendChild(fab);

  var panel = document.createElement('div');
  panel.id = 'takt-panel';
  document.body.appendChild(panel);

  // ── RENDER — MAIN ──────────────────────────────────────
  function renderPanel() {
    var assoc = getCurrentAssociate();
    var readOnly = isReadOnly();
    var today = isToday(state.currentDate);

    var subtitlePath = state.selectedProcess;
    if (hasSubPaths(state.selectedProcess)) subtitlePath += ' > ' + state.selectedSubProcess;
    if (assoc) subtitlePath += ' > ' + assoc.name;

    var headerHTML = '<div class="takt-header" id="takt-drag-handle">'
      + '<div class="takt-header-left">'
      + '<div class="takt-header-icon"><svg viewBox="0 0 24 24"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.5-13H11v6l5.2 3.2.8-1.3-4.5-2.7V7z"/></svg></div>'
      + '<div><div class="takt-header-title">Takt Time Study v' + CURRENT_VERSION + '</div>'
      + '<div class="takt-header-subtitle">SNA4 — ' + escapeHtml(subtitlePath) + '</div></div></div>'
      + '<div class="takt-header-actions">'
      + '<div id="takt-sync-dot" title="Auto-sync active (30s)"></div>'
      + '<button class="takt-header-btn takt-mode-btn" id="takt-toggle-compact" title="Toggle compact mode">' + (uiPrefs.compactMode ? '[+]' : '[-]') + '</button>'
      + '<button class="takt-header-btn takt-mode-btn" id="takt-toggle-dark" title="Toggle dark mode">' + (uiPrefs.darkMode ? 'LT' : 'DK') + '</button>'
      + '<button class="takt-header-btn" id="takt-minimize" title="Minimize">─</button>'
      + '<button class="takt-header-btn" id="takt-close" title="Close">✕</button></div></div>';

    var loadingHTML = '<div class="takt-loading-bar' + (state.loading ? ' active' : '') + '" id="takt-loading"></div>';

    var dayLabel = getDayLabel(state.currentDate);
    var futureDisabled = today ? ' disabled' : '';
    var dayNavHTML = '<div class="takt-day-nav">'
      + '<button class="takt-day-btn" id="takt-day-prev">‹</button>'
      + '<div class="takt-day-label"><span class="day-name">' + dayLabel + '</span> — ' + formatDateDisplay(state.currentDate) + '</div>'
      + '<button class="takt-day-btn" id="takt-day-next"' + futureDisabled + '>›</button>'
      + '<button class="takt-day-today-btn' + (today ? ' is-today' : '') + '" id="takt-day-today">' + (today ? '📅 Today' : '↩ Today') + '</button>'
      + (readOnly ? '<span class="takt-day-readonly-badge">🔒 Read-Only</span>' : '')
      + '</div>';

    var auditorDisabled = readOnly ? ' disabled' : '';
    var auditorBarHTML = '<div class="takt-auditor-bar">'
      + '<div class="takt-auditor-group"><span class="takt-auditor-label">Auditor</span>'
      + '<input class="takt-auditor-input" id="takt-auditor-name" placeholder="Your Name" value="' + escapeHtml(auditorInfo.name) + '"' + auditorDisabled + ' /></div>'
      + '<div class="takt-auditor-group"><span class="takt-auditor-label">Login</span>'
      + '<input class="takt-auditor-input" id="takt-auditor-login" placeholder="Login ID" value="' + escapeHtml(auditorInfo.login) + '"' + auditorDisabled + ' /></div>'
      + '<div class="takt-auditor-group" style="margin-left:auto;"><span class="takt-auditor-label">Date</span>'
      + '<span style="font-size:12px;font-weight:700;color:#92400e;">' + formatDateDisplay(state.currentDate) + '</span></div></div>';

    // Associate card with total avg chip
    var assocCardHTML;
    if (assoc) {
      var histAvg = state.historicalAvg;
      var statsLine = '';
      if (histAvg) {
        if (histAvg.trend !== null) {
          statsLine = histAvg.trend < 0 ? '▼ ' + Math.abs(histAvg.trend) + 's improving' : histAvg.trend > 0 ? '▲ ' + histAvg.trend + 's slower' : '→ steady';
        }
        statsLine += ' (' + histAvg.totalObservations + ' obs / ' + histAvg.totalDays + ' days)';
      }
      var avgChipHTML = '';
      if (histAvg && histAvg.avgTotal) {
        var isOver = histAvg.targetTotal > 0 && histAvg.avgTotal > histAvg.targetTotal;
        avgChipHTML = '<div class="takt-assoc-total-avg' + (isOver ? ' over' : '') + '">'
          + '<span class="takt-assoc-total-avg-label">All-Time Avg</span>'
          + '<span class="takt-assoc-total-avg-value' + (isOver ? ' over' : '') + '">' + histAvg.avgTotal + 's</span>'
          + (histAvg.targetTotal > 0 ? '<span class="takt-assoc-total-avg-target">/ ' + histAvg.targetTotal + 's target</span>' : '')
          + '</div>';
      }
      assocCardHTML = '<div class="takt-assoc-card">'
        + '<div class="takt-assoc-avatar">' + getInitials(assoc.name) + '</div>'
        + '<div class="takt-assoc-info">'
        + '<div class="takt-assoc-name">' + escapeHtml(assoc.name) + '</div>'
        + '<div class="takt-assoc-login">' + escapeHtml(assoc.login) + '</div>'
        + (statsLine ? '<div class="takt-assoc-stats">' + escapeHtml(statsLine) + '</div>' : '')
        + '</div>'
        + avgChipHTML
        + '<button class="takt-assoc-delete-btn" id="takt-delete-assoc" title="Remove associate"' + (state.isRunning ? ' disabled' : '') + '>✕</button></div>';
    } else {
      assocCardHTML = '<div class="takt-assoc-empty-card">👤 No associate selected — search or add one</div>';
    }

    var navDisabled = state.isRunning || state.associates.length <= 1;
    var assocBarHTML = '<div class="takt-associate-bar" id="takt-associate-bar">'
      + '<button class="takt-assoc-nav-btn" id="takt-nav-prev"' + (navDisabled ? ' disabled' : '') + '>‹</button>'
      + assocCardHTML
      + '<button class="takt-assoc-nav-btn" id="takt-nav-next"' + (navDisabled ? ' disabled' : '') + '>›</button>'
      + '<div class="takt-assoc-actions">'
      + '<button class="takt-assoc-action-btn" id="takt-search-assoc"' + (state.isRunning ? ' disabled style="opacity:0.4"' : '') + '>🔍 Search</button>'
      + '<button class="takt-assoc-action-btn primary" id="takt-add-assoc"' + (state.isRunning ? ' disabled style="opacity:0.4"' : '') + '>＋ Add New</button>'
      + '</div></div>';

    var footerHTML = '<div class="takt-footer"><div class="takt-footer-left">'
      + '<button class="takt-footer-btn" id="takt-export-csv"' + (!assoc ? ' disabled style="opacity:0.4"' : '') + '>📥 Export CSV</button>'
      + '<button class="takt-footer-btn" id="takt-copy-data"' + (!assoc ? ' disabled style="opacity:0.4"' : '') + '>📋 Copy</button>'
      + '<button class="takt-footer-btn danger" id="takt-clear-all"' + (state.associates.length === 0 ? ' disabled style="opacity:0.4"' : '') + '>🗑 Clear All</button>'
      + '</div><div class="takt-footer-status">' + state.associates.length + ' associate(s) | ' + getDayLabel(state.currentDate) + ' | 🔄 auto-sync 30s</div></div>';

    if (!assoc) {
      panel.innerHTML = headerHTML + loadingHTML + dayNavHTML + auditorBarHTML + assocBarHTML
        + '<div class="takt-empty-state"><div class="takt-empty-state-icon">👤</div>'
        + '<div class="takt-empty-state-title">No Associate Selected</div>'
        + '<div class="takt-empty-state-msg">Add an associate to begin the time study.</div>'
        + '<button class="takt-empty-state-btn" id="takt-empty-add">＋ Add Associate</button></div>' + footerHTML;
      wireBaseEvents(); return;
    }

    if (state.view === 'summary') {
      renderSummaryView(headerHTML, loadingHTML, dayNavHTML, auditorBarHTML, assocBarHTML, footerHTML);
    } else {
      renderTableView(headerHTML, loadingHTML, dayNavHTML, auditorBarHTML, assocBarHTML, footerHTML);
    }
  }

  // ── RENDER — SUMMARY VIEW (★ UPDATED with custom badges) ──
  function renderSummaryView(headerHTML, loadingHTML, dayNavHTML, auditorBarHTML, assocBarHTML, footerHTML) {
    var summaries = state.daySummaries || {};
    var rowsHTML = '';
    Object.keys(PROCESS_PATHS).forEach(function (process) {
      var subs = PROCESS_PATHS[process], subKeys = Object.keys(subs);
      rowsHTML += '<tr class="takt-summary-parent-row"><td colspan="3">' + escapeHtml(process) + '</td></tr>';
      subKeys.forEach(function (sub) {
        var key = process + '__' + sub;
        var summary = summaries[key];
        var totalObs = summary ? summary.totalObs : 0, avgTotal = summary ? summary.avgTotal : 0, targetTotal = summary ? summary.targetTotal : 0;
        var isDefault = sub === '_default', subLabel = isDefault ? process : sub;

        // ★ NEW: Check for custom targets and show badge
        var customBadge = '';
        if (hasCustomTargets(process, sub)) {
          customBadge = '<span class="takt-custom-badge">✎ custom</span>';
        }

        // ★ CHANGED: Use effective config for target comparison
        var effectiveConfig = getEffectiveConfig(process, sub);
        var effectiveTarget = effectiveConfig.totalTarget;

        var pct = totalObs > 0 ? Math.min((totalObs / 5) * 100, 100) : 0;
        var isDone = totalObs >= 5, isEmpty = totalObs === 0;
        var fillClass = isDone ? 'complete' : isEmpty ? 'empty' : 'partial';
        var statusClass = isDone ? 'complete' : isEmpty ? 'empty' : 'partial';
        var statusText = isDone ? '✅' : isEmpty ? '—' : totalObs + ' obs';
        var avgText = '', avgClass = '';
        if (totalObs > 0) {
          avgText = avgTotal + 's';
          if (effectiveTarget > 0) {
            avgClass = avgTotal <= effectiveTarget ? ' good' : ' over';
            avgText += ' / ' + effectiveTarget + 's';
          }
        }
        rowsHTML += '<tr class="takt-summary-row' + (isDone ? ' done' : '') + '" data-process="' + escapeHtml(process) + '" data-sub="' + escapeHtml(sub) + '">'
          + '<td><div class="takt-summary-sub-cell"><span class="takt-summary-sub-arrow">›</span><span class="takt-summary-sub-label">' + escapeHtml(subLabel) + customBadge + '</span></div></td>'
          + '<td><div class="takt-summary-progress-wrap">'
          + '<div class="takt-summary-bar-bg"><div class="takt-summary-bar-fill ' + fillClass + '" style="width:' + pct + '%"></div></div>'
          + '<div class="takt-summary-status ' + statusClass + '">' + statusText + '</div>'
          + (avgText ? '<div class="takt-summary-avg' + avgClass + '">' + avgText + '</div>' : '')
          + '<span class="takt-summary-go">›</span></div></td></tr>';
      });
      rowsHTML += '<tr class="takt-summary-spacer"><td colspan="3"></td></tr>';
    });
    var summaryHTML = '<div class="takt-summary-wrap">'
      + '<div class="takt-summary-title">Tap a process to begin or continue timing — ' + getDayLabel(state.currentDate) + '</div>'
      + '<table class="takt-summary-table"><tbody>' + rowsHTML + '</tbody></table></div>';
    panel.innerHTML = headerHTML + loadingHTML + dayNavHTML + auditorBarHTML + assocBarHTML + summaryHTML + footerHTML;
    panel.querySelectorAll('.takt-summary-row').forEach(function (row) {
      row.onclick = function () {
        state.selectedProcess = row.dataset.process; state.selectedSubProcess = row.dataset.sub;
        state.selectedObs = null; state.currentSet = 1; state.view = 'table'; loadTableData();
      };
    });
    wireBaseEvents();
  }

  // ── RENDER — TABLE VIEW (★ MAJOR UPDATE — editable targets) ──
  function renderTableView(headerHTML, loadingHTML, dayNavHTML, auditorBarHTML, assocBarHTML, footerHTML) {
    var assoc = getCurrentAssociate();
    var readOnly = isReadOnly();

    // ★ CHANGED: use getEffectiveConfig everywhere
    var config = getEffectiveConfig(state.selectedProcess, state.selectedSubProcess);
    var defaultConfig = getConfig(state.selectedProcess, state.selectedSubProcess);
    var TASKS = config.tasks, TOTAL_TARGET = config.totalTarget, showTargets = TOTAL_TARGET > 0;
    var DEFAULT_TOTAL = defaultConfig.totalTarget;
    var isCustom = hasCustomTargets(state.selectedProcess, state.selectedSubProcess);

    var sets = state.sets || {};
    var setKeys = Object.keys(sets).sort(function (a, b) { return parseInt(a) - parseInt(b); });
    var currentSetData = sets[state.currentSet];
    var observations = currentSetData ? currentSetData.observations : {};
    var setLocked = isSetLocked(currentSetData), canEdit = canEditCurrentSet();
    var obs = state.selectedObs ? (observations[state.selectedObs] || null) : null;
    var tasksDone = obs ? obs.taskTimes.length : 0, totalTasks = TASKS.length;
    var progress = (tasksDone / totalTasks) * 100, isComplete = obs && obs.totalTime !== null;

    // ★ Target inputs disabled during recording or read-only
    var targetDisabled = state.isRunning || readOnly;

    // Process bar — ★ NEW: includes reset button when customized
    var dockNote = config.dockNote ? '<span class="takt-dock-note">' + escapeHtml(config.dockNote) + '</span>' : '';
    var resetBtnHTML = '';
    if (isCustom && !state.isRunning && !readOnly) {
      resetBtnHTML = '<button class="takt-reset-targets-btn" id="takt-reset-targets">↺ Reset Targets</button>';
    }
    var processBarHTML = '<div class="takt-process-bar">'
      + '<button class="takt-back-btn" id="takt-back-to-summary"' + (state.isRunning ? ' disabled style="opacity:0.4"' : '') + '>‹ Back</button>'
      + '<span class="takt-process-arrow">›</span>'
      + '<span style="font-size:13px;font-weight:800;color:#1e293b;">' + escapeHtml(state.selectedProcess) + '</span>';
    if (hasSubPaths(state.selectedProcess)) {
      processBarHTML += '<span class="takt-process-arrow">›</span><span style="font-size:13px;font-weight:700;color:#6366f1;">' + escapeHtml(state.selectedSubProcess) + '</span>';
    }
    if (isCustom) {
      processBarHTML += '<span class="takt-custom-badge" style="margin-left:8px;">✎ custom targets</span>';
    }
    processBarHTML += '<span style="flex:1;"></span>' + resetBtnHTML + dockNote + '</div>';

    // Set bar
    var setBarHTML = '<div class="takt-set-bar"><span class="takt-set-label">Set</span><div class="takt-set-pills">';
    if (setKeys.length === 0) {
      var currentAuditor = auditorInfo.name || auditorInfo.login || '';
      setBarHTML += '<button class="takt-set-pill selected">'
        + '<span class="takt-set-pill-title">Set 1</span>'
        + (currentAuditor ? '<span class="takt-set-pill-auditor">' + escapeHtml(currentAuditor) + '</span>' : '<span class="takt-set-pill-auditor">—</span>')
        + '</button>';
    } else {
      for (var si = 0; si < setKeys.length; si++) {
        var sn = parseInt(setKeys[si]);
        var sData = sets[sn];
        var setIsSel = state.currentSet === sn;
        var sLocked = sData && sData.isComplete;
        var sCls = (setIsSel ? ' selected' : '') + (sLocked ? ' locked' : '');
        var sDis = state.isRunning && !setIsSel ? ' disabled style="opacity:0.4;pointer-events:none;"' : '';
        var setPillAuditor = sData.auditorName || sData.auditorLogin || '—';
        setBarHTML += '<button class="takt-set-pill' + sCls + '" data-set="' + sn + '"' + sDis + '>'
          + '<span class="takt-set-pill-title">Set ' + sn + '</span>'
          + '<span class="takt-set-pill-auditor">' + escapeHtml(setPillAuditor) + '</span>'
          + '</button>';
      }
    }
    setBarHTML += '</div>';
    var canAddSet = !readOnly && !state.isRunning;
    var allSetsComplete = true;
    for (var ci = 0; ci < setKeys.length; ci++) { if (!sets[setKeys[ci]].isComplete) { allSetsComplete = false; break; } }
    var showAddSet = canAddSet && (setKeys.length === 0 || allSetsComplete);
    if (showAddSet && setKeys.length > 0) setBarHTML += '<button class="takt-set-add-btn" id="takt-add-set">＋ Add New Set</button>';
    setBarHTML += '</div>';

    // Obs pills
    var pillsHTML = '';
    for (var pi = 1; pi <= NUM_OBS; pi++) {
      var obsIsSel = state.selectedObs === pi, obsData = observations[pi], obsDone = obsData && obsData.totalTime !== null;
      var obsCls = obsIsSel ? 'selected' : obsDone ? 'completed' : '';
      var obsDis = (state.isRunning && !obsIsSel) ? ' disabled style="opacity:0.4;pointer-events:none;"' : '';
      pillsHTML += '<button class="takt-obs-pill ' + obsCls + '" data-obs="' + pi + '"' + obsDis + '>Obs ' + pi + '</button>';
    }

    var btnClass = 'start-btn', btnText = '▶ START', btnDisabled = !state.selectedObs || isComplete || !canEdit;
    if (state.isRunning && state.currentTaskIndex === -1) { btnClass = 'recording-btn'; btnText = '⏱ CLICK — Record Start Time'; btnDisabled = false; }
    else if (state.isRunning) { btnClass = 'recording-btn'; btnText = '⏱ CLICK — Record Task ' + (state.currentTaskIndex + 1) + '/' + totalTasks; btnDisabled = false; }
    if (readOnly || setLocked) btnDisabled = true;

    var controlBarHTML = '<div class="takt-control-bar">'
      + '<div class="takt-obs-pills">' + pillsHTML + '</div>'
      + '<div class="takt-control-sep"></div>'
      + '<button class="takt-btn-action ' + btnClass + '" id="takt-start-btn"' + (btnDisabled ? ' disabled' : '') + '>' + btnText + '</button>'
      + '<button class="takt-btn-action clear-btn" id="takt-clear-btn"' + (!state.selectedObs || !canEdit || readOnly || setLocked ? ' disabled style="opacity:0.4"' : '') + '>🔄 Clear</button>'
      + '</div>';

    var timerBarHTML;
    if (state.isRunning) {
      var timerLabel = state.currentTaskIndex >= 0
        ? 'Recording: <span class="task-name">' + escapeHtml(TASKS[state.currentTaskIndex].name) + '</span>'
        : 'Click button to record <span class="task-name">Start Time</span>';
      timerBarHTML = '<div class="takt-timer-bar">'
        + '<div class="takt-rec-dot"></div>'
        + '<div class="takt-live-timer recording" id="takt-timer-main">' + formatElapsed(Date.now() - (state.lastClickTime || Date.now())) + '</div>'
        + '<div class="takt-timer-task-label">' + timerLabel + '</div></div>';
    } else {
      timerBarHTML = '<div class="takt-timer-bar hidden"></div>';
    }

    // Table headers
    var obsHeadersHTML = '';
    for (var h = 1; h <= NUM_OBS; h++) {
      obsHeadersHTML += '<th class="obs-header' + (state.selectedObs === h ? ' active' : '') + '">Obs ' + h + '</th>';
    }

    var dailySummary = state.dailySummary, processAvg = state.processAvg;
    var hasDaily = dailySummary && dailySummary.totalObs > 0;
    var hasProcess = processAvg && processAvg.totalObsCount > 0;
    var hasHistAvg = state.historicalAvg && state.historicalAvg.taskAvgs && state.historicalAvg.taskAvgs.length > 0;

    var extraHeaders = '';
    if (hasDaily) extraHeaders += '<th class="avg-header">👤 Avg</th>';
    if (hasProcess) extraHeaders += '<th class="pavg-header">🏭 Avg</th>';

    var tableRowsHTML = '';

    // Start time row
    tableRowsHTML += '<tr class="row-start-time"><td style="padding-left:24px;">⏰ Start Time</td><td class="target-col">—</td>';
    for (var st = 1; st <= NUM_OBS; st++) {
      var stObs = observations[st], stVal = stObs ? stObs.startTime : null, stActive = state.selectedObs === st;
      tableRowsHTML += '<td class="obs-cell' + (stActive ? ' active-col' : '') + '" style="font-size:11px;color:' + (stVal ? '#6366f1' : '#d1d5db') + '">' + (stVal || '—') + '</td>';
    }
    if (hasDaily) tableRowsHTML += '<td class="avg-cell">—</td>';
    if (hasProcess) tableRowsHTML += '<td class="pavg-cell">—</td>';
    tableRowsHTML += '</tr>';

    // Task rows — ★ CHANGED: target column is now editable input
    TASKS.forEach(function (task, idx) {
      var isCurrentTask = state.isRunning && state.currentTaskIndex === idx;
      var defaultTask = defaultConfig.tasks[idx];
      var isThisTaskCustom = isTaskCustomized(state.selectedProcess, state.selectedSubProcess, idx);

      tableRowsHTML += '<tr class="' + (isCurrentTask ? 'current-task-row' : '') + '">';

      // Task name cell with historical avg chip
      var chipHTML = '';
      if (hasHistAvg && state.historicalAvg.taskAvgs[idx] !== undefined) {
        var hAvg = state.historicalAvg.taskAvgs[idx];
        var chipCls = task.target > 0 ? (hAvg <= task.target ? 'good' : 'over') : 'neutral';
        chipHTML = '<span class="takt-task-avg-chip ' + chipCls + '" title="All-time avg for this task">⌀ ' + hAvg + 's</span>';
      }
      tableRowsHTML += '<td style="padding-left:' + (isCurrentTask ? '20px' : '24px') + ';">'
        + '<div class="takt-task-cell">'
        + '<span class="takt-task-name"><span style="color:#94a3b8;font-size:10px;font-weight:700;margin-right:6px;">' + String(idx + 1).padStart(2, '0') + '</span>' + escapeHtml(task.name) + '</span>'
        + chipHTML
        + '</div></td>';

      // ★ NEW: Editable target input instead of static text
      var inputCls = 'takt-target-input' + (isThisTaskCustom ? ' customized' : '');
      var inputVal = task.target > 0 ? task.target : 0;
      tableRowsHTML += '<td class="target-col">'
        + '<input type="number" class="' + inputCls + '" data-task-idx="' + idx + '" '
        + 'value="' + inputVal + '" min="0" max="9999" step="1" '
        + 'title="' + (isThisTaskCustom ? 'Custom: was ' + defaultTask.target + 's' : 'Default: ' + defaultTask.target + 's') + '"'
        + (targetDisabled ? ' disabled' : '')
        + ' />'
        + '</td>';

      // Obs cells — ★ CHANGED: color coding uses effective target
      for (var oi = 1; oi <= NUM_OBS; oi++) {
        var oData = observations[oi], isA = state.selectedObs === oi, val = oData ? oData.taskTimes[idx] : undefined;
        if (isCurrentTask && isA) {
          tableRowsHTML += '<td class="obs-cell current-cell" id="takt-live-cell">0s</td>';
        } else if (val !== undefined) {
          var cellClass = task.target > 0 ? (val > task.target ? 'over' : 'good') : 'no-target';
          tableRowsHTML += '<td class="obs-cell ' + cellClass + '">' + val + 's</td>';
        } else {
          tableRowsHTML += '<td class="obs-cell ' + (isA ? 'empty-active' : 'empty') + '">—</td>';
        }
      }

      if (hasDaily && dailySummary.taskAvgs[idx] !== undefined) {
        var dAvg = dailySummary.taskAvgs[idx], dCls = task.target > 0 ? (dAvg <= task.target ? 'good' : 'over') : '';
        tableRowsHTML += '<td class="avg-cell ' + dCls + '">' + dAvg + 's</td>';
      } else if (hasDaily) { tableRowsHTML += '<td class="avg-cell">—</td>'; }

      if (hasProcess && processAvg.taskAvgs[idx] !== undefined) {
        tableRowsHTML += '<td class="pavg-cell">' + processAvg.taskAvgs[idx] + 's</td>';
      } else if (hasProcess) { tableRowsHTML += '<td class="pavg-cell">—</td>'; }

      tableRowsHTML += '</tr>';
    });

    // End time row
    tableRowsHTML += '<tr class="row-end-time"><td style="padding-left:24px;">⏰ End Time</td><td class="target-col">—</td>';
    for (var et = 1; et <= NUM_OBS; et++) {
      var etObs = observations[et], etVal = etObs ? etObs.endTime : null, etActive = state.selectedObs === et;
      tableRowsHTML += '<td class="obs-cell' + (etActive ? ' active-col' : '') + '" style="font-size:11px;color:' + (etVal ? '#6366f1' : '#d1d5db') + '">' + (etVal || '—') + '</td>';
    }
    if (hasDaily) tableRowsHTML += '<td class="avg-cell">—</td>';
    if (hasProcess) tableRowsHTML += '<td class="pavg-cell">—</td>';
    tableRowsHTML += '</tr>';

    // Total row — ★ CHANGED: shows "was Xs" when custom
    var completedTotals = [];
    for (var fx = 1; fx <= NUM_OBS; fx++) { if (observations[fx] && observations[fx].totalTime !== null) completedTotals.push({ obs: fx, time: observations[fx].totalTime }); }
    var fastestObs = -1, slowestObs = -1;
    if (completedTotals.length >= 2) {
      completedTotals.sort(function(a,b){return a.time-b.time;});
      fastestObs = completedTotals[0].obs;
      slowestObs = completedTotals[completedTotals.length-1].obs;
    }

    var totalTargetDisplay = showTargets ? TOTAL_TARGET + 's' : 'N/A';
    var totalWasNote = '';
    if (isCustom && DEFAULT_TOTAL !== TOTAL_TARGET) {
      totalWasNote = '<span class="takt-target-was">was ' + DEFAULT_TOTAL + 's</span>';
    }

    tableRowsHTML += '<tr class="row-total"><td style="padding-left:24px;">📊 Total</td>'
      + '<td class="target-col" style="font-weight:800;color:#1e293b;">'
      + totalTargetDisplay + totalWasNote + '</td>';
    for (var tt = 1; tt <= NUM_OBS; tt++) {
      var ttObs = observations[tt];
      if (ttObs && ttObs.totalTime !== null) {
        var ttCls = showTargets ? (ttObs.totalTime <= TOTAL_TARGET ? 'good' : 'over') : 'no-target';
        var hlCls = tt === fastestObs ? ' obs-fastest' : tt === slowestObs ? ' obs-slowest' : '';
        var hlIcon = tt === fastestObs ? ' 🥇' : tt === slowestObs ? ' 🐢' : '';
        tableRowsHTML += '<td class="obs-cell ' + ttCls + hlCls + '">' + ttObs.totalTime + 's' + hlIcon + '</td>';
      } else { tableRowsHTML += '<td class="obs-cell empty">—</td>'; }
    }
    if (hasDaily) {
      var dTotCls = showTargets ? (dailySummary.avgTotal <= TOTAL_TARGET ? 'good' : 'over') : '';
      tableRowsHTML += '<td class="avg-cell ' + dTotCls + '">' + dailySummary.avgTotal + 's</td>';
    }
    if (hasProcess) tableRowsHTML += '<td class="pavg-cell">' + processAvg.overallAvgTotal + 's</td>';
    tableRowsHTML += '</tr>';

    var tableHTML = '<div class="takt-table-wrap"><table class="takt-table">'
      + '<thead><tr><th>Task</th><th>Target</th>' + obsHeadersHTML + extraHeaders + '</tr></thead>'
      + '<tbody>' + tableRowsHTML + '</tbody></table></div>';

    var coachingCollapsed = !state.coachingExpanded, coachingDisabled = readOnly ? ' disabled' : '';
    var coachingHTML = '<div class="takt-coaching-section">'
      + '<div class="takt-coaching-header" id="takt-coaching-toggle">'
      + '<div class="takt-coaching-title">📝 Coaching Provided</div>'
      + '<div class="takt-coaching-toggle">' + (coachingCollapsed ? '▼ Expand' : '▲ Collapse') + '</div></div>'
      + '<div class="takt-coaching-body ' + (coachingCollapsed ? 'collapsed' : 'expanded') + '">'
      + '<textarea class="takt-coaching-textarea" id="takt-coaching-notes" placeholder="Enter coaching notes..."'
      + coachingDisabled + '>' + escapeHtml(assoc.coachingNotes) + '</textarea></div></div>';

    var showProgress = state.selectedObs && (state.isRunning || isComplete || tasksDone > 0);
    var progressHTML = '<div class="takt-progress-section' + (!showProgress ? ' hidden' : '') + '">'
      + '<div class="takt-progress-bar-bg"><div class="takt-progress-bar-fill" style="width:' + progress + '%"></div></div>'
      + '<div class="takt-progress-text">' + tasksDone + '/' + totalTasks + ' Tasks (' + Math.round(progress) + '%)</div></div>';

    panel.innerHTML = headerHTML + loadingHTML + dayNavHTML + auditorBarHTML + assocBarHTML
      + processBarHTML + setBarHTML + controlBarHTML + timerBarHTML + tableHTML
      + coachingHTML + progressHTML + footerHTML;

    wireBaseEvents();
    wireTableEvents();
  }

  // ── WIRE EVENTS — BASE (unchanged) ─────────────────────
  function wireBaseEvents() {
    var closeBtn = document.getElementById('takt-close'), minBtn = document.getElementById('takt-minimize');
    if (closeBtn) closeBtn.onclick = togglePanel;
    if (minBtn) minBtn.onclick = togglePanel;
    var darkBtn = document.getElementById('takt-toggle-dark'), compactBtn = document.getElementById('takt-toggle-compact');
    if (darkBtn) darkBtn.onclick = toggleDarkMode;
    if (compactBtn) compactBtn.onclick = toggleCompactMode;
    var audName = document.getElementById('takt-auditor-name'), audLogin = document.getElementById('takt-auditor-login');
    if (audName) audName.oninput = function (e) { auditorInfo.name = e.target.value; saveAuditorLocally(); };
    if (audLogin) audLogin.oninput = function (e) { auditorInfo.login = e.target.value; saveAuditorLocally(); };
    var dayPrev = document.getElementById('takt-day-prev'), dayNext = document.getElementById('takt-day-next'), dayToday = document.getElementById('takt-day-today');
    if (dayPrev) dayPrev.onclick = function () { if (state.isRunning) return; state.currentDate = addDays(state.currentDate, -1); state.selectedObs = null; state.currentSet = 1; state.view = 'summary'; reloadCurrentView(); };
    if (dayNext) dayNext.onclick = function () { if (state.isRunning || isToday(state.currentDate)) return; state.currentDate = addDays(state.currentDate, 1); state.selectedObs = null; state.currentSet = 1; state.view = 'summary'; reloadCurrentView(); };
    if (dayToday) dayToday.onclick = function () { if (state.isRunning || isToday(state.currentDate)) return; state.currentDate = getTodayStr(); state.selectedObs = null; state.currentSet = 1; state.view = 'summary'; reloadCurrentView(); };
    var prevBtn = document.getElementById('takt-nav-prev'), nextBtn = document.getElementById('takt-nav-next');
    if (prevBtn) prevBtn.onclick = function () { navigateAssociate(-1); };
    if (nextBtn) nextBtn.onclick = function () { navigateAssociate(1); };
    var searchBtn = document.getElementById('takt-search-assoc'), addBtn = document.getElementById('takt-add-assoc'), emptyAddBtn = document.getElementById('takt-empty-add'), deleteBtn = document.getElementById('takt-delete-assoc');
    if (searchBtn) searchBtn.onclick = function () { showSearchOverlay(); };
    if (addBtn) addBtn.onclick = function () { showAddForm(''); };
    if (emptyAddBtn) emptyAddBtn.onclick = function () { showAddForm(''); };
    if (deleteBtn) deleteBtn.onclick = function () { handleDeleteAssociate(); };
    var exportBtn = document.getElementById('takt-export-csv'), copyBtn = document.getElementById('takt-copy-data'), clearAllBtn = document.getElementById('takt-clear-all');
    if (exportBtn) exportBtn.onclick = exportCSV;
    if (copyBtn) copyBtn.onclick = copyData;
    if (clearAllBtn) clearAllBtn.onclick = handleClearAll;
    initDrag();
  }

  // ── WIRE EVENTS — TABLE (★ UPDATED — target inputs + reset) ──
  function wireTableEvents() {
    var backBtn = document.getElementById('takt-back-to-summary');
    if (backBtn) backBtn.onclick = function () { if (state.isRunning) return; state.view = 'summary'; state.selectedObs = null; reloadCurrentView(); };
    panel.querySelectorAll('.takt-set-pill').forEach(function (btn) {
      btn.onclick = function () { if (state.isRunning) return; state.currentSet = parseInt(btn.dataset.set); state.selectedObs = null; renderPanel(); };
    });
    var addSetBtn = document.getElementById('takt-add-set');
    if (addSetBtn) addSetBtn.onclick = function () {
      if (state.isRunning) return;
      var assoc = getCurrentAssociate(); if (!assoc) return;
      getNextSetNumber(assoc.login, state.currentDate, state.selectedProcess, state.selectedSubProcess).then(function (nextSet) {
        state.currentSet = nextSet; state.selectedObs = null;
        state.sets[nextSet] = { setNumber: nextSet, observations: {}, isComplete: false, auditorLogin: auditorInfo.login || '', auditorName: auditorInfo.name || '' };
        renderPanel(); showToast('＋ Set ' + nextSet + ' created');
      });
    };
    panel.querySelectorAll('.takt-obs-pill').forEach(function (btn) {
      btn.onclick = function () { if (state.isRunning && state.selectedObs !== parseInt(btn.dataset.obs)) return; state.selectedObs = parseInt(btn.dataset.obs); renderPanel(); };
    });
    var startBtn = document.getElementById('takt-start-btn'); if (startBtn) startBtn.onclick = handleStartStop;
    var clearBtn = document.getElementById('takt-clear-btn'); if (clearBtn) clearBtn.onclick = handleClear;
    var coachToggle = document.getElementById('takt-coaching-toggle'), coachNotes = document.getElementById('takt-coaching-notes');
    if (coachToggle) coachToggle.onclick = function () { state.coachingExpanded = !state.coachingExpanded; renderPanel(); };
    if (coachNotes) {
      var coachTimer = null;
      coachNotes.oninput = function (e) {
        var assoc = getCurrentAssociate();
        if (assoc) { assoc.coachingNotes = e.target.value; clearTimeout(coachTimer); coachTimer = setTimeout(function () { spUpdateCoachingNotes(assoc.login, e.target.value).catch(function () {}); }, 1500); }
      };
    }

    // ★ NEW: Wire editable target inputs
    panel.querySelectorAll('.takt-target-input').forEach(function (input) {
      var taskIdx = parseInt(input.dataset.taskIdx);

      // On blur or Enter, check if value changed and trigger confirmation
      function handleTargetChange() {
        var newVal = parseInt(input.value);
        if (isNaN(newVal) || newVal < 0) {
          // Revert to current effective value
          var currentConfig = getEffectiveConfig(state.selectedProcess, state.selectedSubProcess);
          input.value = currentConfig.tasks[taskIdx].target;
          return;
        }
        var currentConfig = getEffectiveConfig(state.selectedProcess, state.selectedSubProcess);
        var currentTarget = currentConfig.tasks[taskIdx].target;
        if (newVal === currentTarget) return; // No change

        // Build the new targets array
        var newTargets = currentConfig.tasks.map(function (t) { return t.target; });
        newTargets[taskIdx] = newVal;

        showTargetConfirmation(state.selectedProcess, state.selectedSubProcess, taskIdx, currentTarget, newVal, newTargets);
      }

      input.addEventListener('blur', handleTargetChange);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') {
          // Revert on escape
          var currentConfig = getEffectiveConfig(state.selectedProcess, state.selectedSubProcess);
          input.value = currentConfig.tasks[taskIdx].target;
          input.blur();
          e.stopPropagation();
        }
      });
    });

    // ★ NEW: Wire reset targets button
    var resetBtn = document.getElementById('takt-reset-targets');
    if (resetBtn) {
      resetBtn.onclick = function () {
        if (state.isRunning) return;
        var defaults = getDefaultTargetsArray(state.selectedProcess, state.selectedSubProcess);
        var defaultTotal = defaults.reduce(function (a, b) { return a + b; }, 0);
        showConfirm(
          'Reset to Default Targets?',
          'This will restore all task targets for ' + state.selectedProcess +
          (hasSubPaths(state.selectedProcess) ? ' > ' + state.selectedSubProcess : '') +
          ' back to defaults (total: ' + defaultTotal + 's) and recalculate all affected summaries.',
          function () {
            showRecalcStrip('Resetting targets to defaults...');
            resetCustomTargets(state.selectedProcess, state.selectedSubProcess).then(function (stats) {
              updateRecalcStrip('✅ Reset complete — recalculated ' + stats.summaries + ' summaries + ' + stats.processAvgs + ' process averages');
              setTimeout(function () { removeRecalcStrip(); loadTableData(); }, 2500);
            }).catch(function (err) {
              updateRecalcStrip('⚠ Reset failed: ' + err.message);
              setTimeout(removeRecalcStrip, 4000);
            });
          }
        );
      };
    }
  }

  // ── TARGET CHANGE CONFIRMATION DIALOG (★ NEW) ──────────
  function showTargetConfirmation(process, sub, taskIdx, oldVal, newVal, newTargetsArray) {
    var existing = document.querySelector('.takt-target-confirm-overlay');
    if (existing) existing.remove();

    var config = getEffectiveConfig(process, sub);
    var taskName = config.tasks[taskIdx].name;
    var oldTotal = config.totalTarget;
    var newTotal = newTargetsArray.reduce(function (a, b) { return a + b; }, 0);
    var pathLabel = process + (hasSubPaths(process) ? ' > ' + sub : '');

    var overlay = document.createElement('div');
    overlay.className = 'takt-target-confirm-overlay';
    overlay.innerHTML =
      '<div class="takt-target-confirm-box">' +
        '<div class="takt-target-confirm-title">⚠️ Modify Shared Targets?</div>' +
        '<div class="takt-target-confirm-path">' + escapeHtml(pathLabel) + '</div>' +
        '<div class="takt-target-confirm-change">' +
          '<span style="flex:1;">' + escapeHtml(taskName) + '</span>' +
          '<span class="old-val">' + oldVal + 's</span>' +
          '<span class="change-arrow">→</span>' +
          '<span class="new-val">' + newVal + 's</span>' +
        '</div>' +
        '<div class="takt-target-confirm-change">' +
          '<span style="flex:1;">Total Target</span>' +
          '<span class="old-val">' + oldTotal + 's</span>' +
          '<span class="change-arrow">→</span>' +
          '<span class="new-val">' + newTotal + 's</span>' +
        '</div>' +
        '<div class="takt-target-confirm-warn">' +
          '<div class="takt-target-confirm-warn-title">⚠ This affects ALL auditors globally:</div>' +
          '<ul>' +
            '<li>Color coding (green/red) recalculates for all observations</li>' +
            '<li>Daily summaries update — WithinTargetPct changes</li>' +
            '<li>Process averages recalculate</li>' +
            '<li>Completion toasts will use new targets</li>' +
            '<li>CSV export and clipboard copy reflect new values</li>' +
          '</ul>' +
        '</div>' +
        '<div class="takt-target-confirm-btns">' +
          '<button class="takt-target-confirm-cancel" id="takt-tc-cancel">Cancel</button>' +
          '<button class="takt-target-confirm-apply" id="takt-tc-apply">Apply Globally</button>' +
        '</div>' +
      '</div>';

    panel.appendChild(overlay);

    document.getElementById('takt-tc-cancel').onclick = function () {
      overlay.remove();
      // Revert the input to old value
      renderPanel();
    };

    document.getElementById('takt-tc-apply').onclick = function () {
      overlay.remove();
      showRecalcStrip('Applying new targets and recalculating...');

      applyCustomTargets(process, sub, newTargetsArray).then(function (stats) {
        updateRecalcStrip('✅ Done — recalculated ' + stats.summaries + ' summaries + ' + stats.processAvgs + ' process averages');
        setTimeout(function () {
          removeRecalcStrip();
          loadTableData();
        }, 3000);
      }).catch(function (err) {
        updateRecalcStrip('⚠ Error: ' + err.message);
        setTimeout(function () { removeRecalcStrip(); renderPanel(); }, 4000);
      });
    };
  }

  // ── RECALC STATUS STRIP (★ NEW) ────────────────────────
  function showRecalcStrip(msg) {
    removeRecalcStrip();
    var strip = document.createElement('div');
    strip.className = 'takt-recalc-strip';
    strip.id = 'takt-recalc-strip';
    strip.innerHTML = '<div class="takt-recalc-spinner"></div><span>' + escapeHtml(msg) + '</span>';
    // Insert after process bar
    var processBar = panel.querySelector('.takt-process-bar');
    if (processBar && processBar.nextSibling) {
      processBar.parentNode.insertBefore(strip, processBar.nextSibling);
    } else {
      panel.appendChild(strip);
    }
  }

  function updateRecalcStrip(msg) {
    var strip = document.getElementById('takt-recalc-strip');
    if (strip) {
      strip.classList.add('success');
      strip.innerHTML = '<span>' + escapeHtml(msg) + '</span>';
    }
  }

  function removeRecalcStrip() {
    var strip = document.getElementById('takt-recalc-strip');
    if (strip) strip.remove();
  }

  // ── TIMER LOGIC (★ UPDATED — uses getEffectiveConfig) ──
  function handleStartStop() {
    var assoc = getCurrentAssociate();
    if (!assoc || !state.selectedObs || !canEditCurrentSet()) return;

    // ★ CHANGED: use getEffectiveConfig
    var config = getEffectiveConfig(state.selectedProcess, state.selectedSubProcess);
    var TASKS = config.tasks, TOTAL_TARGET = config.totalTarget, showTargets = TOTAL_TARGET > 0;

    var currentSetData = state.sets[state.currentSet];
    var observations = currentSetData ? currentSetData.observations : {};
    var obs = observations[state.selectedObs];

    if (!obs) {
      obs = { obsNumber: state.selectedObs, startTime: null, endTime: null, taskTimes: [], totalTime: null, targetTotal: null, auditorLogin: '', auditorName: '' };
      if (!currentSetData) {
        state.sets[state.currentSet] = { setNumber: state.currentSet, observations: {}, isComplete: false, auditorLogin: auditorInfo.login || '', auditorName: auditorInfo.name || '' };
        currentSetData = state.sets[state.currentSet];
      }
      currentSetData.observations[state.selectedObs] = obs;
    }

    if (!state.isRunning && obs.totalTime === null) {
      state.isRunning = true; state.currentTaskIndex = -1; state.lastClickTime = Date.now();
      state.currentDate = getTodayStr(); fab.classList.add('active'); startElapsedTimer(); renderPanel(); return;
    }
    if (state.isRunning && state.currentTaskIndex === -1) {
      obs.startTime = formatTime(new Date()); state.currentTaskIndex = 0; state.lastClickTime = Date.now(); renderPanel(); return;
    }
    if (state.isRunning && state.currentTaskIndex >= 0) {
      var now = Date.now(), elapsed = Math.round((now - state.lastClickTime) / 1000);
      obs.taskTimes.push(elapsed); state.lastClickTime = now;
      if (obs.taskTimes.length >= TASKS.length) {
        obs.endTime = formatTime(new Date());
        obs.totalTime = obs.taskTimes.reduce(function (a, b) { return a + b; }, 0);
        obs.targetTotal = TOTAL_TARGET; obs.auditorLogin = auditorInfo.login; obs.auditorName = auditorInfo.name;
        state.isRunning = false; state.currentTaskIndex = -1; fab.classList.remove('active'); stopElapsedTimer();

        if (currentSetData) {
          currentSetData.auditorLogin = auditorInfo.login || currentSetData.auditorLogin;
          currentSetData.auditorName = auditorInfo.name || currentSetData.auditorName;
        }

        var doneCount = 0;
        for (var oi = 1; oi <= NUM_OBS; oi++) { var o = currentSetData.observations[oi]; if (o && o.totalTime !== null) doneCount++; }
        if (doneCount >= 5) currentSetData.isComplete = true;

        renderPanel();
        spSaveObservation({
          login: assoc.login, date: state.currentDate,
          process: state.selectedProcess, sub: state.selectedSubProcess,
          setNum: state.currentSet, obsNum: state.selectedObs,
          startTime: obs.startTime, endTime: obs.endTime, taskTimes: obs.taskTimes,
          totalTime: obs.totalTime, targetTotal: TOTAL_TARGET,
          auditorLogin: auditorInfo.login, auditorName: auditorInfo.name
        }).then(function () {
          return Promise.all([
            loadDailySummary(assoc.login, state.currentDate, state.selectedProcess, state.selectedSubProcess),
            loadProcessAverage(state.selectedProcess, state.selectedSubProcess, state.currentDate)
          ]);
        }).then(function (results) {
          state.dailySummary = results[0]; state.processAvg = results[1];
          if (!state.isRunning) renderPanel();
        }).catch(function (err) { console.warn('Background sync:', err); });

        // ★ CHANGED: toast uses effective target
        var diff = obs.totalTime - TOTAL_TARGET;
        if (showTargets) showToast(diff <= 0 ? '✅ Obs ' + state.selectedObs + ' complete! ' + Math.abs(diff) + 's under target' : '⚠️ Obs ' + state.selectedObs + ' complete! ' + diff + 's over target');
        else showToast('✅ Obs ' + state.selectedObs + ' complete! ' + obs.totalTime + 's total');
        if (currentSetData.isComplete) showToast('🔒 Set ' + state.currentSet + ' complete and locked!');
      } else {
        state.currentTaskIndex = obs.taskTimes.length; renderPanel();
      }
    }
  }

  function startElapsedTimer() {
    stopElapsedTimer();
    state.elapsedInterval = setInterval(function () {
      var timerEl = document.getElementById('takt-timer-main'), cellEl = document.getElementById('takt-live-cell');
      if (state.lastClickTime) { var elapsed = Date.now() - state.lastClickTime; if (timerEl) timerEl.textContent = formatElapsed(elapsed); if (cellEl) cellEl.textContent = Math.round(elapsed / 1000) + 's'; }
    }, 50);
  }
  function stopElapsedTimer() { if (state.elapsedInterval) { clearInterval(state.elapsedInterval); state.elapsedInterval = null; } }

  // ── CLEAR HANDLERS (unchanged) ─────────────────────────
  function handleClear() {
    var assoc = getCurrentAssociate(); if (!assoc || !state.selectedObs || !canEditCurrentSet()) return;
    showConfirm('Clear Observation ' + state.selectedObs + '?', 'All recorded times for this observation will be deleted.', function () {
      if (state.isRunning) { state.isRunning = false; state.currentTaskIndex = -1; fab.classList.remove('active'); stopElapsedTimer(); }
      var currentSetData = state.sets[state.currentSet];
      if (currentSetData && currentSetData.observations[state.selectedObs]) {
        currentSetData.observations[state.selectedObs] = { obsNumber: state.selectedObs, startTime: null, endTime: null, taskTimes: [], totalTime: null, targetTotal: null, auditorLogin: '', auditorName: '' };
        currentSetData.isComplete = false;
      }
      renderPanel();
      spClearObservation(assoc.login, state.currentDate, state.selectedProcess, state.selectedSubProcess, state.currentSet, state.selectedObs).then(function () {
        showToast('🔄 Observation ' + state.selectedObs + ' cleared');
        return loadDailySummary(assoc.login, state.currentDate, state.selectedProcess, state.selectedSubProcess);
      }).then(function (summary) { state.dailySummary = summary; renderPanel(); }).catch(function (err) { console.warn('Clear failed:', err); });
    });
  }
  function handleClearAll() {
    if (state.associates.length === 0) return;
    showConfirm('Clear ALL Data?', 'This will deactivate all associates. Observation history is preserved in SharePoint.', function () {
      state.isRunning = false; state.currentTaskIndex = -1; fab.classList.remove('active'); stopElapsedTimer();
      Promise.all(state.associates.map(function (a) { return spDeactivateAssociate(a.login); })).then(function () {
        state.associates = []; state.currentAssociateIndex = -1; state.selectedObs = null; state.view = 'summary';
        renderPanel(); showToast('🗑 All associates deactivated');
      });
    });
  }
  function handleDeleteAssociate() {
    var assoc = getCurrentAssociate(); if (!assoc || state.isRunning) return;
    showConfirm('Remove ' + assoc.name + '?', 'Associate will be deactivated. Historical data is preserved.', function () {
      spDeactivateAssociate(assoc.login).then(function () {
        state.associates.splice(state.currentAssociateIndex, 1);
        state.currentAssociateIndex = state.associates.length === 0 ? -1 : Math.min(state.currentAssociateIndex, state.associates.length - 1);
        state.selectedObs = null; state.view = 'summary'; reloadCurrentView(); showToast('🗑 ' + assoc.name + ' removed');
      });
    });
  }
  function showConfirm(title, msg, onConfirm) {
    var overlay = document.createElement('div');
    overlay.className = 'takt-confirm-overlay';
    overlay.innerHTML = '<div class="takt-confirm-box"><div class="takt-confirm-icon">⚠️</div>'
      + '<div class="takt-confirm-title">' + title + '</div><div class="takt-confirm-msg">' + msg + '</div>'
      + '<div class="takt-confirm-btns"><button class="takt-confirm-cancel" id="takt-cfm-no">Cancel</button>'
      + '<button class="takt-confirm-ok" id="takt-cfm-yes">Confirm</button></div></div>';
    panel.appendChild(overlay);
    document.getElementById('takt-cfm-no').onclick = function () { overlay.remove(); };
    document.getElementById('takt-cfm-yes').onclick = function () { overlay.remove(); onConfirm(); };
  }

  // ── ASSOCIATE MANAGEMENT (unchanged) ───────────────────
  function navigateAssociate(direction) {
    if (state.isRunning) return;
    var len = state.associates.length; if (len === 0) return;
    state.currentAssociateIndex = (state.currentAssociateIndex + direction + len) % len;
    state.selectedObs = null; state.currentSet = 1; state.view = 'summary'; reloadCurrentView();
  }
  function showSearchOverlay() {
    var existing = document.getElementById('takt-search-overlay');
    if (existing) { existing.remove(); return; }
    var bar = document.getElementById('takt-associate-bar'); if (!bar) return;
    var overlay = document.createElement('div');
    overlay.className = 'takt-search-overlay'; overlay.id = 'takt-search-overlay';
    function buildResults(query) {
      var q = query.toLowerCase().trim();
      var filtered = state.associates.filter(function (a) { return a.name.toLowerCase().indexOf(q) > -1 || a.login.toLowerCase().indexOf(q) > -1; });
      if (filtered.length === 0) return '<div class="takt-search-no-results">No associates found</div>';
      return filtered.map(function (a) {
        var realIdx = state.associates.indexOf(a), isActive = realIdx === state.currentAssociateIndex;
        return '<div class="takt-search-result' + (isActive ? ' active' : '') + '" data-index="' + realIdx + '">'
          + '<div class="takt-search-result-avatar">' + getInitials(a.name) + '</div>'
          + '<div class="takt-search-result-info"><div class="takt-search-result-name">' + escapeHtml(a.name) + '</div>'
          + '<div class="takt-search-result-login">' + escapeHtml(a.login) + '</div></div></div>';
      }).join('');
    }
    overlay.innerHTML = '<div class="takt-search-input-wrap">'
      + '<svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>'
      + '<input class="takt-search-input" id="takt-search-input" placeholder="Search by name or login..." autofocus /></div>'
      + '<div class="takt-search-results" id="takt-search-results">' + buildResults('') + '</div>'
      + '<div class="takt-search-add-new" id="takt-search-add-new">＋ Add new associate</div>';
    bar.appendChild(overlay);
    var input = document.getElementById('takt-search-input'), resultsContainer = document.getElementById('takt-search-results');
    input.focus(); input.oninput = function () { resultsContainer.innerHTML = buildResults(input.value); wireSearchResults(); };
    function wireSearchResults() {
      resultsContainer.querySelectorAll('.takt-search-result').forEach(function (el) {
        el.onclick = function () {
          state.currentAssociateIndex = parseInt(el.dataset.index); state.selectedObs = null; state.currentSet = 1; state.view = 'summary';
          overlay.remove(); reloadCurrentView(); showToast('👤 Switched to ' + state.associates[parseInt(el.dataset.index)].name);
        };
      });
    }
    wireSearchResults();
    document.getElementById('takt-search-add-new').onclick = function () { overlay.remove(); showAddForm(input.value); };
    setTimeout(function () {
      var closeHandler = function (e) { if (!overlay.contains(e.target) && e.target.id !== 'takt-search-assoc') { overlay.remove(); document.removeEventListener('click', closeHandler); } };
      document.addEventListener('click', closeHandler);
    }, 100);
  }
  function showAddForm(prefillName) {
    var existing = document.querySelector('.takt-add-overlay'); if (existing) existing.remove();
    var overlay = document.createElement('div');
    overlay.className = 'takt-add-overlay';
    overlay.innerHTML = '<div class="takt-add-form">'
      + '<div class="takt-add-form-title">👤 Add New Associate</div>'
      + '<div class="takt-add-form-sub">Enter the associate details to start their time study.</div>'
      + '<div class="takt-add-field"><label>Associate Name</label><input id="takt-add-name" placeholder="e.g. Jane Doe" value="' + escapeHtml(prefillName || '') + '" />'
      + '<div class="takt-add-warn" id="takt-name-warn">⚠ Name matches auditor</div></div>'
      + '<div class="takt-add-field"><label>Associate Login</label><input id="takt-add-login" placeholder="e.g. jdoe" />'
      + '<div class="takt-add-warn" id="takt-login-warn">⚠ Login already exists</div></div>'
      + '<div class="takt-add-btns"><button class="takt-add-cancel" id="takt-add-cancel">Cancel</button>'
      + '<button class="takt-add-submit" id="takt-add-submit" disabled>Add Associate</button></div></div>';
    panel.appendChild(overlay);
    var nameInput = document.getElementById('takt-add-name'), loginInput = document.getElementById('takt-add-login');
    var submitBtn = document.getElementById('takt-add-submit'), nameWarn = document.getElementById('takt-name-warn'), loginWarn = document.getElementById('takt-login-warn');
    nameInput.focus();
    function validate() {
      var n = nameInput.value.trim(), l = loginInput.value.trim();
      nameWarn.style.display = (n && auditorInfo.name && n.toLowerCase() === auditorInfo.name.toLowerCase()) ? 'block' : 'none';
      var dup = state.associates.find(function (a) { return a.login.toLowerCase() === l.toLowerCase(); });
      loginWarn.style.display = (l && dup) ? 'block' : 'none';
      submitBtn.disabled = !(n.length > 0 && l.length > 0 && !dup);
    }
    nameInput.oninput = validate; loginInput.oninput = validate; validate();
    document.getElementById('takt-add-cancel').onclick = function () { overlay.remove(); };
    submitBtn.onclick = function () {
      var name = nameInput.value.trim(), login = loginInput.value.trim();
      submitBtn.disabled = true; submitBtn.textContent = 'Saving...';
      spSaveAssociate(login, name, '').then(function () {
        var newAssoc = { spId: null, login: login, name: name, coachingNotes: '', isActive: true, createdDate: getTodayStr() };
        state.associates.push(newAssoc); state.currentAssociateIndex = state.associates.length - 1;
        state.selectedObs = null; state.currentSet = 1; state.view = 'summary';
        overlay.remove(); reloadCurrentView(); showToast('👤 Added ' + name);
      }).catch(function (err) { submitBtn.disabled = false; submitBtn.textContent = 'Add Associate'; showToast('⚠ Failed to save: ' + err.message); });
    };
    nameInput.onkeydown = function (e) { if (e.key === 'Enter') loginInput.focus(); };
    loginInput.onkeydown = function (e) { if (e.key === 'Enter' && !submitBtn.disabled) submitBtn.click(); };
  }

  // ── DRAG (unchanged) ───────────────────────────────────
  function initDrag() {
    var handle = document.getElementById('takt-drag-handle'); if (!handle) return;
    handle.onmousedown = function (e) {
      if (e.target.closest('.takt-header-btn')) return;
      state.isDragging = true; var rect = panel.getBoundingClientRect();
      state.dragOffset.x = e.clientX - rect.left; state.dragOffset.y = e.clientY - rect.top;
      panel.style.transition = 'none';
    };
    document.onmousemove = function (e) { if (!state.isDragging) return; panel.style.left = (e.clientX - state.dragOffset.x) + 'px'; panel.style.top = (e.clientY - state.dragOffset.y) + 'px'; panel.style.transform = 'scale(1)'; };
    document.onmouseup = function () { if (state.isDragging) { state.isDragging = false; panel.style.transition = 'all 0.35s cubic-bezier(0.4,0,0.2,1)'; } };
  }

  // ── EXPORT CSV (★ UPDATED — uses getEffectiveConfig, includes both custom & default) ──
  function exportCSV() {
    var assoc = getCurrentAssociate(); if (!assoc) return;
    // ★ CHANGED: use getEffectiveConfig
    var config = getEffectiveConfig(state.selectedProcess, state.selectedSubProcess);
    var defaultConfig = getConfig(state.selectedProcess, state.selectedSubProcess);
    var TASKS = config.tasks;
    var isCustom = hasCustomTargets(state.selectedProcess, state.selectedSubProcess);
    var observations = state.sets[state.currentSet] ? state.sets[state.currentSet].observations : {};
    var showSub = hasSubPaths(state.selectedProcess);
    var csv = 'Auditor,' + auditorInfo.name + '\nLogin,' + auditorInfo.login + '\nAssociate,' + assoc.name + '\nAssoc Login,' + assoc.login + '\nProcess,' + state.selectedProcess + '\n';
    if (showSub) csv += 'Sub-Process,' + state.selectedSubProcess + '\n';
    csv += 'Date,' + state.currentDate + '\nSet,' + state.currentSet + '\n';
    if (isCustom) csv += 'Note,Custom targets in use (defaults shown in parentheses)\n';
    csv += '\nTask,Target';
    // ★ NEW: add Default Target column when custom
    if (isCustom) csv += ',Default Target';
    for (var i = 1; i <= NUM_OBS; i++) csv += ',Obs ' + i;
    csv += '\nStart Time,—';
    if (isCustom) csv += ',—';
    for (var s = 1; s <= NUM_OBS; s++) { var so = observations[s]; csv += ',' + (so && so.startTime ? so.startTime : ''); }
    csv += '\n';
    TASKS.forEach(function (task, idx) {
      csv += '"' + task.name + '",' + (task.target > 0 ? task.target : 'N/A');
      if (isCustom) {
        var defTarget = defaultConfig.tasks[idx] ? defaultConfig.tasks[idx].target : 'N/A';
        csv += ',' + defTarget;
      }
      for (var o = 1; o <= NUM_OBS; o++) { var od = observations[o]; var v = od ? od.taskTimes[idx] : undefined; csv += ',' + (v !== undefined ? v : ''); }
      csv += '\n';
    });
    csv += 'End Time,—';
    if (isCustom) csv += ',—';
    for (var e = 1; e <= NUM_OBS; e++) { var eo = observations[e]; csv += ',' + (eo && eo.endTime ? eo.endTime : ''); }
    csv += '\nTotal,' + (config.totalTarget || 'N/A');
    if (isCustom) csv += ',' + (defaultConfig.totalTarget || 'N/A');
    for (var t = 1; t <= NUM_OBS; t++) { var to = observations[t]; csv += ',' + (to && to.totalTime !== null ? to.totalTime : ''); }
    csv += '\n';
    var blob = new Blob([csv], { type: 'text/csv' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'TaktStudy_' + assoc.name.replace(/\s+/g, '_') + '_' + state.selectedProcess + '_' + state.currentDate + '_S' + state.currentSet + '.csv';
    a.click(); showToast('📥 CSV downloaded');
  }

  // ── COPY DATA (★ UPDATED — uses getEffectiveConfig, notes customizations) ──
  function copyData() {
    var assoc = getCurrentAssociate(); if (!assoc) return;
    // ★ CHANGED: use getEffectiveConfig
    var config = getEffectiveConfig(state.selectedProcess, state.selectedSubProcess);
    var defaultConfig = getConfig(state.selectedProcess, state.selectedSubProcess);
    var TASKS = config.tasks;
    var isCustom = hasCustomTargets(state.selectedProcess, state.selectedSubProcess);
    var observations = state.sets[state.currentSet] ? state.sets[state.currentSet].observations : {};
    var text = 'TAKT TIME STUDY — SNA4\nAuditor: ' + auditorInfo.name + ' (' + auditorInfo.login + ')\nAssociate: ' + assoc.name + ' (' + assoc.login + ')\nProcess: ' + state.selectedProcess;
    if (hasSubPaths(state.selectedProcess)) text += ' > ' + state.selectedSubProcess;
    text += '\nDate: ' + state.currentDate + ' | Set: ' + state.currentSet;
    // ★ NEW: note custom targets
    if (isCustom) {
      text += '\n⚠ Custom targets in use (total: ' + config.totalTarget + 's, default was: ' + defaultConfig.totalTarget + 's)';
    }
    text += '\n\n';
    for (var i = 1; i <= NUM_OBS; i++) {
      var o = observations[i]; if (!o || o.taskTimes.length === 0) continue;
      text += '── Obs ' + i + ' ──\nStart: ' + (o.startTime || 'N/A') + '\n';
      TASKS.forEach(function (t, idx) {
        var v = o.taskTimes[idx];
        if (v !== undefined) {
          var icon = t.target > 0 ? (v <= t.target ? '✅' : '⚠️') : '⏱';
          text += '  ' + icon + ' ' + t.name + ': ' + v + 's';
          // ★ NEW: show target info including custom note
          if (t.target > 0) {
            text += ' (target: ' + t.target + 's';
            if (isCustom && isTaskCustomized(state.selectedProcess, state.selectedSubProcess, idx)) {
              text += ', default: ' + defaultConfig.tasks[idx].target + 's';
            }
            text += ')';
          }
          text += '\n';
        }
      });
      text += 'End: ' + (o.endTime || 'N/A') + '\nTotal: ' + o.totalTime + 's';
      if (config.totalTarget > 0) {
        var diff = o.totalTime - config.totalTarget;
        text += ' (' + (diff <= 0 ? Math.abs(diff) + 's under' : diff + 's over') + ' target)';
      }
      text += '\n\n';
    }
    navigator.clipboard.writeText(text); showToast('📋 Copied to clipboard');
  }
  // ── DATA LOADING (unchanged) ───────────────────────────
  function reloadCurrentView() {
    state.loading = true; renderPanel();
    var assoc = getCurrentAssociate();
    if (!assoc) { state.loading = false; renderPanel(); return; }
    var promises = [loadAssociateSummariesForDate(assoc.login, state.currentDate)];
    if (state.selectedProcess && state.selectedSubProcess) {
      promises.push(computeHistoricalAvg(assoc.login, state.selectedProcess, state.selectedSubProcess, null));
    } else { promises.push(Promise.resolve(null)); }
    Promise.all(promises).then(function (results) {
      state.daySummaries = results[0]; state.historicalAvg = results[1]; state.loading = false;
      if (state.view === 'table') loadTableData(); else renderPanel();
    }).catch(function (err) { console.warn('Reload failed:', err); state.loading = false; renderPanel(); });
  }
  function loadTableData() {
    var assoc = getCurrentAssociate(); if (!assoc) { renderPanel(); return; }
    state.loading = true; renderPanel();
    Promise.all([
      loadObservationsForDay(assoc.login, state.currentDate, state.selectedProcess, state.selectedSubProcess),
      loadDailySummary(assoc.login, state.currentDate, state.selectedProcess, state.selectedSubProcess),
      loadProcessAverage(state.selectedProcess, state.selectedSubProcess, state.currentDate),
      computeHistoricalAvg(assoc.login, state.selectedProcess, state.selectedSubProcess, null)
    ]).then(function (results) {
      state.sets = results[0]; state.dailySummary = results[1]; state.processAvg = results[2]; state.historicalAvg = results[3];
      var setKeys = Object.keys(state.sets).sort(function (a, b) { return parseInt(a) - parseInt(b); });
      if (setKeys.length > 0) { if (!state.sets[state.currentSet]) state.currentSet = parseInt(setKeys[setKeys.length - 1]); } else { state.currentSet = 1; }
      state.loading = false; renderPanel();
    }).catch(function (err) { console.warn('Table load failed:', err); state.loading = false; renderPanel(); });
  }

  // ── TOGGLE PANEL (★ UPDATED — loads custom targets on open) ──
  function togglePanel() {
    state.isOpen = !state.isOpen;
    if (state.isOpen) {
      panel.classList.add('open'); backdrop.classList.add('open');
      panel.style.left = '50%'; panel.style.top = '50%';
      panel.style.transform = 'translate(-50%, -50%) scale(1)';
      applyDarkMode(); applyCompactMode();

      // ★ NEW: Load custom targets from SP before rendering
      loadCustomTargetsFromSP().then(function () {
        reloadCurrentView();
      }).catch(function () {
        // Fallback: use localStorage cache and continue
        loadCustomTargetsLocally();
        reloadCurrentView();
      });

      startAutoSync();
      checkForUpdate();
    } else {
      panel.classList.remove('open'); backdrop.classList.remove('open');
      stopAutoSync();
    }
  }

  fab.onclick = togglePanel;
  backdrop.onclick = function (e) { if (e.target === backdrop && !state.isRunning) togglePanel(); };

  // ── KEYBOARD SHORTCUTS (★ UPDATED — respects update modal escape block) ──
  document.addEventListener('keydown', function (e) {
    // Alt+T to toggle panel
    if (e.altKey && e.key === 't') { e.preventDefault(); togglePanel(); }

    // Space to record during observation
    if (e.code === 'Space' && state.isOpen && state.isRunning) {
      var tag = document.activeElement.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        e.preventDefault(); handleStartStop();
      }
    }

    // Escape handling — ★ CHANGED: skip if update modal is blocking
    if (e.key === 'Escape' && state.isOpen) {
      // If update modal is open, the updateEscBlocker handles it (blocks escape)
      // So this handler only runs when update modal is NOT present
      if (document.getElementById('takt-update-modal')) return;

      // Close overlays in order of priority
      var targetConfirm = document.querySelector('.takt-target-confirm-overlay');
      if (targetConfirm) { targetConfirm.remove(); renderPanel(); return; }

      var searchOv = document.getElementById('takt-search-overlay');
      var addOv = document.querySelector('.takt-add-overlay');
      if (searchOv) { searchOv.remove(); return; }
      if (addOv) { addOv.remove(); return; }

      if (!state.isRunning) togglePanel();
    }

    // Alt+Arrow to navigate associates
    if (state.isOpen && !state.isRunning && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); navigateAssociate(-1); }
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); navigateAssociate(1); }
    }
  });

  // ── INIT (★ UPDATED — loads custom targets from SP on startup) ──
  loadAuditorLocally();
  loadUiPrefs();
  loadOfflineQueue();
  loadCustomTargetsLocally(); // ★ NEW: load cached targets immediately for fast startup

  initSharePoint().then(function (ready) {
    if (ready) {
      console.log('✅ SNA4 Takt Timer v' + CURRENT_VERSION + ' — SharePoint connected');
      // ★ NEW: Load custom targets from SP alongside associates
      return Promise.all([
        loadAllAssociates(),
        loadCustomTargetsFromSP()
      ]);
    } else {
      console.warn('⚠ SharePoint offline — using cached data');
      return Promise.all([
        Promise.resolve([]),
        Promise.resolve(customTargets) // use localStorage cache
      ]);
    }
  }).then(function (results) {
    var associates = results[0] || [];
    state.associates = associates;
    if (state.associates.length > 0) state.currentAssociateIndex = 0;
    console.log('✅ Loaded ' + state.associates.length + ' associates');
    console.log('✅ Custom targets: ' + Object.keys(customTargets).length + ' process overrides loaded');
  }).catch(function (err) { console.warn('Init error:', err); });

  console.log('✅ SNA4 Takt Time Study Timer v' + CURRENT_VERSION + ' loading... Alt+T to open.');
})();
