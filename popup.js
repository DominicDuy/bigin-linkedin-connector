// popup.js — Extension Popup Logic (OAuth Login Flow)

(() => {
  'use strict';

  let currentProfileData = null;
  let isSettingsView = false;

  const $ = id => document.getElementById(id);

  // Escape untrusted values before they go into innerHTML. Scraped LinkedIn text
  // (names, company) and CRM strings are attacker-influenceable; without this a
  // crafted profile name could inject <script>/<img onerror> into the popup — which
  // has chrome.storage access (the Bigin refresh token). Static markup stays as-is.
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const views = { settings: $('viewSettings'), main: $('viewMain') };

  const states = {
    notProfile: $('stateNotProfile'),
    loading: $('stateLoading'),
    checking: $('stateChecking'),
    duplicate: $('stateDuplicate'),
    saving: $('stateSaving'),
    success: $('stateSuccess'),
    error: $('stateError'),
    notConfigured: $('stateNotConfigured')
  };

  const els = {
    profileCard: $('profileCard'),
    pipelineInfo: $('pipelineInfo'),
    btnAdd: $('btnAdd')
  };

  function hideAllStates() {
    Object.values(states).forEach(function(el) { if (el) el.style.display = 'none'; });
    els.profileCard.style.display = 'none';
    els.pipelineInfo.style.display = 'none';
    els.btnAdd.style.display = 'none';
  }

  function showState(key) {
    hideAllStates();
    if (states[key]) states[key].style.display = '';
  }

  // The header toggle button doubles as Settings (from main) and Home (from settings).
  // Swapping the icon + tooltip makes the "how do I get back" obvious to SDRs.
  var ICON_GEAR = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
  var ICON_HOME = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>';

  function setHeaderToggleIcon() {
    var btn = $('btnSettings');
    if (!btn) return;
    btn.innerHTML = isSettingsView ? ICON_HOME : ICON_GEAR;
    btn.title = isSettingsView ? 'Back to home' : 'Settings';
  }

  function showView(view) {
    views.settings.classList.remove('active');
    views.settings.style.display = 'none';
    views.main.classList.remove('active');
    views.main.style.display = 'none';
    if (view === 'settings') {
      views.settings.style.display = 'block';
      views.settings.classList.add('active');
      isSettingsView = true;
    } else {
      views.main.style.display = 'block';
      views.main.classList.add('active');
      isSettingsView = false;
    }
    setHeaderToggleIcon();
  }

  function sendBg(msg) {
    return new Promise(function(resolve) {
      chrome.runtime.sendMessage(msg, function(resp) {
        resolve(resp || { success: false, error: 'No response' });
      });
    });
  }

  // ── Settings (Login/Logout) ──
  async function initSettings() {
    var status = await sendBg({ action: 'getLoginStatus' });
    if (status.loggedIn) {
      $('settingsLogin').style.display = 'none';
      $('settingsLoggedIn').style.display = 'block';
      if (status.user) {
        $('autoUserName').textContent = status.user.name || '-';
        $('autoUserEmail').textContent = status.user.email || status.user.role || '';
      }
      // Show the real, current pipeline name (resolved by id) so the hint always matches
      // Bigin - including exact casing - even after a rename.
      sendBg({ action: 'getLockedPipeline' }).then(function(resp) {
        var el = $('pipelineHintName');
        if (el && resp && resp.success && resp.info) el.textContent = resp.info.pipeline;
      });
    } else {
      $('settingsLogin').style.display = 'block';
      $('settingsLoggedIn').style.display = 'none';
    }
  }

  async function handleLogin() {
    var btn = $('btnLogin');
    var errEl = $('loginError');
    errEl.style.display = 'none';
    btn.disabled = true;
    btn.textContent = 'Connecting...';

    var result = await sendBg({ action: 'login' });

    btn.disabled = false;
    btn.textContent = 'Sign in with Bigin';

    if (result.success) {
      await initSettings();
    } else {
      errEl.textContent = result.error || 'Login failed';
      errEl.style.display = 'block';
    }
  }

  async function handleLogout() {
    await sendBg({ action: 'logout' });
    await initSettings();
  }

  // Pipeline + sub-pipeline are LOCKED in background.js (single-purpose tool), so there is
  // no pipeline chooser here anymore. Settings is just account + Sign Out.

  // ── Main flow ──
  async function initMain() {
    // Check login status first
    var status = await sendBg({ action: 'getLoginStatus' });
    if (!status.loggedIn) {
      showState('notConfigured');
      return;
    }

    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    var tab = tabs[0];
    if (!tab || !tab.url || tab.url.indexOf('linkedin.com/in/') === -1) {
      showState('notProfile');
      return;
    }

    showState('loading');

    try {
      var response = await chrome.tabs.sendMessage(tab.id, { action: 'scrapeProfile' });
      if (response && response.success) {
        currentProfileData = response.data;
        await checkAndShowProfile(currentProfileData);
      } else {
        await injectAndRetry(tab.id);
      }
    } catch (e) {
      await injectAndRetry(tab.id);
    }
  }

  async function injectAndRetry(tabId) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['content.js'] });
      await new Promise(function(r) { setTimeout(r, 1000); });
      var retry = await chrome.tabs.sendMessage(tabId, { action: 'scrapeProfile' });
      if (retry && retry.success) {
        currentProfileData = retry.data;
        await checkAndShowProfile(currentProfileData);
      } else {
        showProfileCard({});
      }
    } catch (e) {
      showProfileCard({});
    }
  }

  async function checkAndShowProfile(data) {
    showProfileCard(data);
    states.checking.style.display = '';
    els.btnAdd.style.display = 'none';

    var dedup = await sendBg({ action: 'checkDuplicate', linkedinUrl: data.profileUrl });
    states.checking.style.display = 'none';

    // Dedup API failed -> hard block
    if (!dedup || dedup.error) {
      states.error.style.display = '';
      $('errorDetail').textContent = 'Duplicate check failed: ' + ((dedup && dedup.error) || 'no response') +
        ' - Add blocked to avoid duplicates. Close and reopen the popup to retry.';
      els.btnAdd.style.display = 'none';
      return;
    }

    if (dedup.isDuplicate) {
      var r = dedup.record || dedup.existing;
      states.duplicate.style.display = '';
      $('dupDetail').innerHTML =
        '<div><strong>Pipeline:</strong> ' + escapeHtml(r.pipeline || 'N/A') + ' > ' + escapeHtml(r.subPipeline || 'N/A') + '</div>' +
        '<div><strong>Stage:</strong> ' + escapeHtml(r.stage || 'N/A') + '</div>' +
        (r.owner ? '<div><strong>Owner:</strong> ' + escapeHtml(r.owner) + '</div>' : '') +
        '<div><strong>Date:</strong> ' + escapeHtml(r.createdTime ? new Date(r.createdTime).toLocaleDateString('en-US') : 'N/A') + '</div>';
      els.btnAdd.style.display = 'none';
    } else {
      showPipelineInfo();
      els.btnAdd.style.display = '';
    }
  }

  function showProfileCard(data) {
    hideAllStates();
    els.profileCard.style.display = '';
    var fullName = data.fullName || ((data.firstName || '') + ' ' + (data.lastName || '')).trim() || '?';
    $('profileName').textContent = fullName;
    $('profileHeadline').textContent = data.headline || '';
    $('fieldCompany').value = data.company || '';
    $('fieldTitle').value = data.title || '';
    // Cross-check: if scraped location contains company name, it's a scraper error - clear it
    var loc = data.location || '';
    var co = data.company || '';
    if (loc && co && loc.toLowerCase().indexOf(co.toLowerCase()) !== -1) {
      loc = '';
    }
    $('fieldLocation').value = loc;
    // Pre-fill Co. Country from work location in Experience (full location)
    $('fieldCompanyCountry').value = data.workLocation || '';
    // Email + Phone (optional, SDR fills from ContactOut/Seamless/etc.)
    $('fieldEmail').value = '';
    $('fieldPhone').value = '';
    $('fieldEmailValidation').value = 'Not Checked';
    $('rowEmailValidation').style.display = 'none';
    // Show/hide Email Validation dropdown based on Email field
    $('fieldEmail').addEventListener('input', function() {
      $('rowEmailValidation').style.display = this.value.trim() ? '' : 'none';
    });
    // Decode LinkedIn URL for display (Vietnamese chars show as %E1%BB...)
    var linkedinUrl = data.profileUrl || '';
    try {
      var decoded = decodeURIComponent(linkedinUrl).replace('https://www.', '');
      $('fieldLinkedIn').textContent = decoded || '-';
    } catch (e) {
      $('fieldLinkedIn').textContent = linkedinUrl.replace('https://www.', '') || '-';
    }
    $('fieldLinkedIn').title = linkedinUrl;
    $('profileAvatar').textContent = fullName.charAt(0).toUpperCase();

    ['fieldCompany', 'fieldTitle'].forEach(function(id) {
      var input = $(id);
      input.classList.toggle('required-empty', !input.value);
      input.addEventListener('input', function() {
        input.classList.toggle('required-empty', !input.value);
        validateAddButton();
      });
    });
    validateAddButton();
  }

  function showPipelineInfo() {
    els.pipelineInfo.style.display = '';
    $('infoPipeline').textContent = 'Loading...';
    chrome.storage.local.get('biginSettings', function(data) {
      var s = data.biginSettings || {};
      $('infoOwner').textContent = s.sdrName || '(Auto-detect)';
    });
    // Pipeline is locked; resolve its current display name by id so it stays correct after a rename.
    sendBg({ action: 'getLockedPipeline' }).then(function(resp) {
      $('infoPipeline').textContent = (resp && resp.success && resp.info)
        ? resp.info.pipeline + ' > ' + resp.info.subPipeline
        : 'TeleStar Outreach > Standard';
    });
  }

  function validateAddButton() {
    var company = $('fieldCompany').value.trim();
    var title = $('fieldTitle').value.trim();
    var lastName = currentProfileData ? currentProfileData.lastName : null;
    els.btnAdd.disabled = !lastName || !company || !title;
  }

  // ── Add to Bigin ──
  async function handleAdd() {
    if (currentProfileData) {
      currentProfileData.company = $('fieldCompany').value.trim();
      currentProfileData.title = $('fieldTitle').value.trim();
      currentProfileData.stage = $('selectStage').value;
      currentProfileData.location = $('fieldLocation').value.trim();
      currentProfileData.companyCountry = $('fieldCompanyCountry').value.trim();
      currentProfileData.email = $('fieldEmail').value.trim();
      currentProfileData.phone = $('fieldPhone').value.trim();
      currentProfileData.emailValidation = currentProfileData.email ? $('fieldEmailValidation').value : '';
      // Re-parse location into city/state/country from edited value
      var locParts = currentProfileData.location.split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0; });
      if (locParts.length === 1) {
        currentProfileData.country = locParts[0];
        currentProfileData.city = '';
        currentProfileData.state = '';
      } else if (locParts.length === 2) {
        currentProfileData.city = locParts[0];
        currentProfileData.country = locParts[1];
        currentProfileData.state = '';
      } else if (locParts.length >= 3) {
        currentProfileData.city = locParts[0];
        currentProfileData.state = locParts[1];
        currentProfileData.country = locParts[locParts.length - 1];
      } else {
        currentProfileData.city = '';
        currentProfileData.state = '';
        currentProfileData.country = '';
      }
    }
    if (!currentProfileData || !currentProfileData.lastName) return;

    els.btnAdd.style.display = 'none';
    els.pipelineInfo.style.display = 'none';
    states.saving.style.display = '';
    setStepState('stepAccount', 'active');

    var result = await sendBg({ action: 'addToBigin', profileData: currentProfileData });

    if (result.isDuplicate) {
      states.saving.style.display = 'none';
      states.duplicate.style.display = '';
      var r = result.existing;
      $('dupDetail').innerHTML =
        '<div><strong>Pipeline:</strong> ' + escapeHtml(r.pipeline || 'N/A') + '</div>' +
        '<div><strong>Stage:</strong> ' + escapeHtml(r.stage || 'N/A') + '</div>' +
        (r.owner ? '<div><strong>Owner:</strong> ' + escapeHtml(r.owner) + '</div>' : '');
      chrome.runtime.sendMessage({ action: 'setBadge', text: '!', color: '#dc2626' });
      return;
    }

    if (result.success) {
      setStepState('stepAccount', 'done');
      setStepState('stepContact', 'done');
      setStepState('stepPipeline', 'done');
      setTimeout(function() {
        states.saving.style.display = 'none';
        states.success.style.display = '';
        var html = escapeHtml(result.dealName || 'Record created');
        if (result.pipelineId) {
          var biginUrl = 'https://bigin.zoho.com/bigin/telestar/Home#/deals/' + encodeURIComponent(result.pipelineId) + '?section=timeline';
          html += '<br><a href="' + escapeHtml(biginUrl) + '" target="_blank" class="bigin-link">View in Bigin →</a>';
        }
        if (result.filledFields && result.filledFields.length > 0) {
          var FIELD_LABELS = { Email_1_Validation: 'Email Validation', Contact_Full_Name: 'Full Name' };
          html += '<div style="margin-top:8px;font-size:11px;opacity:.75">' +
            'Contact already existed. Filled empty fields: ' +
            result.filledFields.map(function(f) {
              return escapeHtml(FIELD_LABELS[f] || f.replace(/_/g, ' '));
            }).join(', ') + '</div>';
        }
        if (result.warnings) {
          html += '<div class="warn-list">' + result.warnings.map(function(w) {
            return '<div class="warn-item">⚠ ' + escapeHtml(w) + '</div>';
          }).join('') + '</div>';
        }
        $('successDetail').innerHTML = html;
        chrome.runtime.sendMessage({ action: 'setBadge', text: '✓', color: '#059669' });
      }, 400);
    } else {
      setStepState('stepPipeline', 'error');
      setTimeout(function() {
        states.saving.style.display = 'none';
        states.error.style.display = '';
        $('errorDetail').textContent = result.error || 'Unknown error';
        chrome.runtime.sendMessage({ action: 'setBadge', text: '✗', color: '#dc2626' });
      }, 400);
    }
  }

  function setStepState(stepId, state) {
    var el = $(stepId);
    if (!el) return;
    el.className = 'progress-step ' + state;
  }

  // ── Events ──
  $('btnSettings').addEventListener('click', function() {
    if (isSettingsView) {
      showView('main');
      initMain();
    } else {
      showView('settings');
      initSettings();
    }
  });

  $('btnRefresh').addEventListener('click', function() { if (!isSettingsView) initMain(); });
  $('btnLogin').addEventListener('click', handleLogin);
  $('btnLogout').addEventListener('click', handleLogout);
  $('btnAdd').addEventListener('click', handleAdd);
  $('btnGoSettings').addEventListener('click', function() { showView('settings'); initSettings(); });
  $('btnRetry').addEventListener('click', initMain);

  // ── Init ──
  var vEl = $('footerVersion');
  if (vEl) vEl.textContent = 'v' + chrome.runtime.getManifest().version;
  showView('main');
  initMain();
})();
