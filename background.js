// background.js — Service Worker
// Handles: OAuth token management, Bigin API calls, record CRUD, dedup

(() => {
  'use strict';

  const ZOHO_ACCOUNTS = 'https://accounts.zoho.com';
  const BIGIN_API = 'https://www.zohoapis.com/bigin/v2';

  // OAuth credentials (embedded - internal sideloaded extension)
  const CLIENT_ID = 'YOUR_ZOHO_CLIENT_ID';
  const CLIENT_SECRET = 'YOUR_ZOHO_CLIENT_SECRET';
  // Derived from the extension ID, which is pinned by the "key" field in manifest.json.
  // Stays identical on every machine/Chrome profile, so it never drifts out of sync
  // with the Authorized Redirect URI registered in the Zoho API Console.
  const REDIRECT_URI = chrome.identity.getRedirectURL();
  const SCOPES = 'ZohoBigin.modules.ALL,ZohoBigin.settings.ALL,ZohoBigin.users.ALL,ZohoBigin.coql.READ,ZohoBigin.org.READ';

  // TeleStar's Bigin organisation. OAuth succeeds for ANY Zoho account, including a
  // personal one, and records would then be written into that person's own Bigin org
  // with no visible error. Every login is checked against this id.
  const TELESTAR_ZGID = 'YOUR_BIGIN_ORG_ZGID';
  const TELESTAR_ORG_NAME = 'TeleStar';

  // Single-purpose lock: this extension only ever writes into TeleStar's outreach pipeline.
  // Pinned by id so renaming the pipeline / sub-pipeline in Bigin never breaks it. To point
  // the tool at a different pipeline later, change these two constants and re-upload.
  const LOCKED_PIPELINE_ID = 'YOUR_PIPELINE_ID';      // "TeleStar Outreach" pipeline/layout (was "LeadGen - Testing")
  const LOCKED_SUBPIPELINE_ID = 'YOUR_SUBPIPELINE_ID';   // "Standard" sub-pipeline (was "LeadGen - Testing Standard")

  // ════════════════════════════════════════
  //  OAUTH LOGIN FLOW
  // ════════════════════════════════════════

  async function loginWithBigin() {
    var authUrl = ZOHO_ACCOUNTS + '/oauth/v2/auth' +
      '?response_type=code' +
      '&client_id=' + CLIENT_ID +
      '&scope=' + encodeURIComponent(SCOPES) +
      '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
      '&access_type=offline' +
      '&prompt=consent';

    // Opens Zoho login popup - SDR logs in with their own account
    var redirectUrl = await chrome.identity.launchWebAuthFlow({
      url: authUrl,
      interactive: true
    });

    // Extract authorization code from redirect URL
    var url = new URL(redirectUrl);
    var code = url.searchParams.get('code');
    if (!code) {
      var error = url.searchParams.get('error') || 'No authorization code received';
      throw new Error(error);
    }

    // Exchange code for access + refresh tokens
    var params = new URLSearchParams({
      code: code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code'
    });

    var resp = await fetch(ZOHO_ACCOUNTS + '/oauth/v2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    var data = await resp.json();
    if (data.error) {
      throw new Error('Token exchange failed: ' + data.error);
    }

    var biginTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in * 1000)
    };

    await chrome.storage.local.set({ biginTokens: biginTokens });

    // Org guard: make sure this token belongs to TeleStar, not someone's personal Bigin.
    // Runs before anything else is stored so a wrong account never gets a working session.
    try {
      var orgResp = await biginRequest('GET', '/org');
      // Raw Zoho returns { org: [...] }; tolerate a { data: { org: [...] } } wrapper too.
      var orgList = (orgResp && orgResp.org) || (orgResp && orgResp.data && orgResp.data.org) || null;
      var org = (orgList && orgList[0]) ? orgList[0] : null;
      if (!org || String(org.zgid) !== TELESTAR_ZGID) {
        var wrongOrg = org ? (org.company_name || org.zgid) : 'unknown';
        await chrome.storage.local.remove(['biginTokens', 'biginSettings', 'tokenData', 'biginConfig']);
        throw new Error(
          'This Zoho account belongs to "' + wrongOrg + '", not the ' + TELESTAR_ORG_NAME +
          ' Bigin org. Sign out of Zoho in this browser and sign in with your ' +
          TELESTAR_ORG_NAME + ' account.'
        );
      }
    } catch (e) {
      // Fail closed. A mismatch throws above and is re-thrown untouched. Anything else
      // (network error, Zoho 5xx, unexpected payload) means the org was never confirmed,
      // and an unconfirmed org is treated exactly like a wrong one - otherwise blocking
      // the /org request would be enough to walk straight past the guard.
      // Cost of this choice: an SDR on a flaky connection has to press Sign In again.
      if (e && e.message && e.message.indexOf('not the ' + TELESTAR_ORG_NAME) !== -1) throw e;
      console.warn('[Bigin] Org check could not complete:', e && e.message);
      await chrome.storage.local.remove(['biginTokens', 'biginSettings', 'tokenData', 'biginConfig']);
      throw new Error(
        'Could not verify that this account belongs to the ' + TELESTAR_ORG_NAME +
        ' Bigin org. Check your connection and sign in again.'
      );
    }

    // Auto-detect and store user info
    var user = await fetchCurrentUser();
    if (user) {
      var stored = await chrome.storage.local.get('biginSettings');
      var settings = stored.biginSettings || {};
      settings.sdrUserId = user.id;
      settings.sdrName = user.name;
      await chrome.storage.local.set({ biginSettings: settings });
    }

    return { success: true, user: user };
  }

  async function logoutBigin() {
    await chrome.storage.local.remove(['biginTokens', 'biginSettings', 'tokenData', 'biginConfig']);
    return { success: true };
  }

  async function getLoginStatus() {
    var { biginTokens } = await chrome.storage.local.get('biginTokens');
    if (biginTokens && biginTokens.refreshToken) {
      try {
        var user = await fetchCurrentUser();
        return { loggedIn: true, user: user };
      } catch (e) {
        return { loggedIn: true, user: null };
      }
    }
    return { loggedIn: false };
  }

  // ════════════════════════════════════════
  //  TOKEN MANAGEMENT
  // ════════════════════════════════════════

  // Deduplicate concurrent refresh calls - only one inflight at a time
  let _refreshPromise = null;

  async function getAccessToken() {
    var { biginTokens } = await chrome.storage.local.get('biginTokens');
    if (!biginTokens || !biginTokens.refreshToken) {
      throw new Error('NOT_LOGGED_IN');
    }
    if (biginTokens.accessToken && biginTokens.expiresAt > Date.now() + 60000) {
      return biginTokens.accessToken;
    }
    if (_refreshPromise) return await _refreshPromise;
    _refreshPromise = refreshAccessToken();
    try { return await _refreshPromise; } finally { _refreshPromise = null; }
  }

  async function refreshAccessToken() {
    var { biginTokens } = await chrome.storage.local.get('biginTokens');
    if (!biginTokens || !biginTokens.refreshToken) {
      throw new Error('NOT_LOGGED_IN');
    }

    var params = new URLSearchParams({
      refresh_token: biginTokens.refreshToken,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token'
    });

    const resp = await fetch(ZOHO_ACCOUNTS + '/oauth/v2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error('Token refresh failed: ' + resp.status + ' - ' + text);
    }

    const data = await resp.json();
    if (data.error) {
      throw new Error('Token error: ' + data.error);
    }

    biginTokens.accessToken = data.access_token;
    biginTokens.expiresAt = Date.now() + (data.expires_in * 1000);

    await chrome.storage.local.set({ biginTokens: biginTokens });
    return biginTokens.accessToken;
  }

  // ════════════════════════════════════════
  //  BIGIN API HELPERS
  // ════════════════════════════════════════

  // Zoho returns HTTP 204 with an EMPTY body when a COQL query matches 0 rows.
  // resp.json() on an empty body throws — that must not be confused with an API error.
  async function parseJsonSafe(resp) {
    var text = await resp.text();
    if (!text) return {};
    try { return JSON.parse(text); }
    catch (e) { throw new Error('Bigin API returned invalid JSON (HTTP ' + resp.status + ')'); }
  }

  // Retry-eligible: 429 (rate limit), 5xx (server error), network failures
  function isRetryable(status) {
    return status === 429 || (status >= 500 && status < 600);
  }

  async function biginRequest(method, path, body, _attempt) {
    _attempt = _attempt || 1;
    var maxAttempts = 3;
    var token = await getAccessToken();
    var opts = {
      method: method,
      headers: {
        'Authorization': 'Zoho-oauthtoken ' + token,
        'Content-Type': 'application/json'
      }
    };
    if (body) opts.body = JSON.stringify(body);

    var resp, data;
    try {
      resp = await fetch(BIGIN_API + path, opts);
    } catch (networkErr) {
      // Network failure (offline, DNS, timeout) - retry with backoff
      if (_attempt < maxAttempts) {
        await new Promise(function(r) { setTimeout(r, 1000 * Math.pow(2, _attempt - 1)); });
        return biginRequest(method, path, body, _attempt + 1);
      }
      throw new Error('Network error: ' + networkErr.message);
    }

    data = await parseJsonSafe(resp);

    // 401 / invalid token - refresh and retry once
    if (resp.status === 401 || (data.code === 'INVALID_TOKEN')) {
      await chrome.storage.local.remove('tokenData');
      var newToken = await getAccessToken();
      opts.headers['Authorization'] = 'Zoho-oauthtoken ' + newToken;
      var retry = await fetch(BIGIN_API + path, opts);
      return await parseJsonSafe(retry);
    }

    // Rate limit or server error - exponential backoff
    if (isRetryable(resp.status) && _attempt < maxAttempts) {
      var delay = 1000 * Math.pow(2, _attempt - 1); // 1s, 2s
      if (resp.status === 429) {
        // Respect Retry-After header if present
        var retryAfter = resp.headers.get('Retry-After');
        if (retryAfter) delay = Math.max(delay, parseInt(retryAfter, 10) * 1000);
      }
      await new Promise(function(r) { setTimeout(r, delay); });
      return biginRequest(method, path, body, _attempt + 1);
    }

    return data;
  }

  async function coqlQuery(query) {
    var res = await biginRequest('POST', '/coql', { select_query: query });
    // Empty body (204) = zero rows matched — normalize to empty data
    if (!res || Object.keys(res).length === 0) return { data: [] };
    // Real API error (invalid query, rate limit, auth) — throw, never swallow
    if (!res.data && res.code) {
      throw new Error('COQL error ' + res.code + (res.message ? ': ' + res.message : ''));
    }
    return res;
  }

  // ════════════════════════════════════════
  //  DEDUP CHECK
  // ════════════════════════════════════════

  // IMPORTANT: no try/catch here. A failed API call must propagate as an error
  // and hard-block the flow — it must NEVER be mistaken for "no duplicate".
  // Scoped to the selected pipeline (team pipeline) so the same lead can exist
  // in different team pipelines for different clients.
  // NOTE: COQL does not support filtering by Pipeline field directly (returns empty
  // even when records exist). We query by Contact_LinkedIn1 only, then filter by
  // pipeline ID in JavaScript.
  async function checkDuplicate(linkedinUrl) {
    var url = linkedinUrl.replace(/\/+$/, '').toLowerCase();
    var safeUrl = url.replace(/'/g, "\\'");
    var variants = [safeUrl, safeUrl + '/'];

    // Dedup is scoped to our one locked pipeline (single-purpose tool). The old code read
    // settings.pipelineId, but the v2.3.1 lock removed the chooser so that value is now
    // empty — which silently turned scoping OFF and made dedup flag the contact if it
    // existed in ANY of the user's team pipelines (e.g. other clients). Pin to
    // LOCKED_PIPELINE_ID so a lead that exists for another client can still be added here.
    var stored = await chrome.storage.local.get('biginSettings');
    var settings = stored.biginSettings || {};
    var pipelineId = LOCKED_PIPELINE_ID;

    for (var i = 0; i < variants.length; i++) {
      var query = "select id, Deal_Name, Stage, Owner, Pipeline, Sub_Pipeline, Created_Time " +
        "from Pipelines where Contact_LinkedIn1 = '" + variants[i] + "'";
      var result = await coqlQuery(query);
      if (result.data && result.data.length > 0) {
        // Filter by pipeline ID in JavaScript (COQL can't filter Pipeline field)
        var matches = result.data;
        if (pipelineId) {
          matches = matches.filter(function(r) {
            var pid = (r.Pipeline && typeof r.Pipeline === 'object') ? r.Pipeline.id : r.Pipeline;
            return String(pid) === String(pipelineId);
          });
        }
        if (matches.length > 0) {
          var existing = matches[0];
          var pip = existing.Pipeline;
          var pipId = (pip && typeof pip === 'object') ? pip.id : pip;
          // Resolve the pipeline name by id (rename-proof), same resolver the create path
          // and the popup hint use. settings.pipeline no longer exists after the v2.3.1
          // single-pipeline lock removed the chooser, so relying on it made the dupe box
          // fall back to the raw pipeline id. For our one locked pipeline, resolve via meta.
          var pipName;
          if (String(pipId) === String(LOCKED_PIPELINE_ID)) {
            var lockedInfo = await getLockedPipelineInfo();
            pipName = lockedInfo.pipeline;
          } else {
            pipName = (pip && typeof pip === 'object' && pip.name) ? pip.name : (pip || 'N/A');
          }
          return {
            isDuplicate: true,
            record: {
              id: existing.id,
              dealName: existing.Deal_Name,
              stage: existing.Stage,
              // Empty when COQL returns no readable owner name (common for bulk/n8n-imported
              // records). The popup hides the Owner row entirely in that case rather than
              // showing a misleading placeholder — Owner is only a reference field here.
              owner: (existing.Owner && (existing.Owner.name || existing.Owner.full_name)) || '',
              pipeline: pipName,
              subPipeline: existing.Sub_Pipeline,
              createdTime: existing.Created_Time
            }
          };
        }
      }
    }

    return { isDuplicate: false };
  }

  // ════════════════════════════════════════
  //  RECORD CREATION
  // ════════════════════════════════════════

  // Batch tag written to every record CREATED in one scrape (Contact + Account +
  // Pipeline) so all three share the exact same value. Format: Tele_DD.MM_Extension.
  // Computed once per call site; existing records are never touched (see upsert logic).
  function todaysListName() {
    var now = new Date();
    var dd = String(now.getDate()).padStart(2, '0');
    var mm = String(now.getMonth() + 1).padStart(2, '0');
    return 'Tele_' + dd + '.' + mm + '_Extension';
  }

  async function upsertAccount(profileData) {
    if (!profileData.company) return null;

    // Prepare field data from LinkedIn
    var newData = { Account_Name: profileData.company };
    // List batch tag - only lands on the POST (new record) path below. Existing
    // accounts return early before newData is used, so they are left untouched.
    newData.List = todaysListName();
    if (profileData.companyLinkedInUrl) newData.Company_LI_Profile_Url = profileData.companyLinkedInUrl;
    if (profileData.companyCountry) {
      var cParts = profileData.companyCountry.split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0; });
      if (cParts.length === 1) {
        newData.Billing_Country = cParts[0];
      } else if (cParts.length === 2) {
        newData.Billing_City = cParts[0];
        newData.Billing_Country = cParts[1];
      } else if (cParts.length >= 3) {
        newData.Billing_City = cParts[0];
        newData.Billing_State = cParts[1];
        newData.Billing_Country = cParts[cParts.length - 1];
      }
    }

    // Step 1: Search for existing account by LinkedIn URL (COQL for reliable matching)
    var existingId = null;
    if (profileData.companyLinkedInUrl) {
      var safeUrl = profileData.companyLinkedInUrl.replace(/'/g, "\\'");
      var q = "select id from Accounts where Company_LI_Profile_Url = '" + safeUrl + "'";
      var search = await coqlQuery(q);
      if (search.data && search.data.length > 0) existingId = search.data[0].id;
    }
    // Fallback: search by company name
    if (!existingId) {
      var safeName = profileData.company.replace(/'/g, "\\'");
      var q2 = "select id from Accounts where Account_Name = '" + safeName + "'";
      var search2 = await coqlQuery(q2);
      if (search2.data && search2.data.length > 0) existingId = search2.data[0].id;
    }

    // Step 2: If found, skip - no update, just return existing ID
    if (existingId) {
      console.log('[Bigin] Account already exists, skipping:', existingId);
      return existingId;
    }

    // Step 3: Not found - create new record
    var result = await biginRequest('POST', '/Accounts', { data: [newData] });
    if (result.data && result.data[0]) {
      if (result.data[0].code === 'DUPLICATE_DATA' && result.data[0].details && result.data[0].details.id) {
        console.log('[Bigin] Account DUPLICATE_DATA - using existing ID:', result.data[0].details.id);
        return result.data[0].details.id;
      }
      if (result.data[0].details && result.data[0].details.id) {
        return result.data[0].details.id;
      }
    }
    return null;
  }

  // Blank = null, undefined, empty/whitespace string, or key absent from the API response.
  // 0 and false are real values, NOT blank.
  function isBlankValue(v) {
    if (v === null || v === undefined) return true;
    if (typeof v === 'string') return v.trim() === '';
    return false;
  }

  // Only these Contact fields may be auto-filled when empty in Bigin.
  // Identity/linkage fields (names, LinkedIn URL, Account_Name, Contact_Source) are
  // deliberately excluded - rewriting those on an existing record is not a "fill".
  var FILLABLE_CONTACT_FIELDS = [
    'Email', 'Mobile', 'Email_1_Validation', 'Title',
    'Mailing_City', 'Mailing_State', 'Mailing_Country', 'Contact_Full_Name'
  ];

  // Fills ONLY the fields that are currently empty in Bigin. Never overwrites an
  // existing value, so anything an SDR edited by hand is safe. Returns the list of
  // field names actually written, or [] when there was nothing to do.
  async function fillBlankContactFields(contactId, newData) {
    var existing = await biginRequest(
      'GET',
      '/Contacts/' + contactId + '?fields=' + encodeURIComponent(FILLABLE_CONTACT_FIELDS.join(','))
    );
    var record = (existing && existing.data && existing.data[0]) ? existing.data[0] : {};

    var patch = {};
    var filled = [];
    FILLABLE_CONTACT_FIELDS.forEach(function(f) {
      if (isBlankValue(newData[f])) return;   // nothing new to write for this field
      if (!isBlankValue(record[f])) return;   // Bigin already has a value - leave it alone
      patch[f] = newData[f];
      filled.push(f);
    });

    // Email Validation describes the address we store. Only write it when the Email
    // itself is part of this same write - otherwise it would label an address the SDR
    // never actually saved here.
    if (patch.Email_1_Validation !== undefined && patch.Email === undefined) {
      delete patch.Email_1_Validation;
      filled = filled.filter(function(f) { return f !== 'Email_1_Validation'; });
    }

    // Nothing blank to fill - skip the write call entirely
    if (filled.length === 0) return [];

    patch.id = contactId;
    var res = await biginRequest('PUT', '/Contacts', { data: [patch] });
    if (res && res.data && res.data[0] && res.data[0].status === 'error') {
      throw new Error(res.data[0].message || 'Contact update failed');
    }

    // Zoho silently ignores field names it does not recognise and still reports success,
    // so re-read the record and report only what actually landed. Without this the popup
    // can claim it saved something Bigin quietly threw away.
    var after = await biginRequest(
      'GET',
      '/Contacts/' + contactId + '?fields=' + encodeURIComponent(FILLABLE_CONTACT_FIELDS.join(','))
    );
    var afterRecord = (after && after.data && after.data[0]) ? after.data[0] : {};
    var confirmed = filled.filter(function(f) { return !isBlankValue(afterRecord[f]); });
    var dropped = filled.filter(function(f) { return confirmed.indexOf(f) === -1; });
    if (dropped.length > 0) {
      console.warn('[Bigin] Sent but not saved by Bigin:', dropped.join(', '));
    }
    return confirmed;
  }

  async function upsertContact(profileData, accountId, ctx) {
    ctx = ctx || {};
    var newData = {
      First_Name: profileData.firstName,
      Last_Name: profileData.lastName,
      Contact_LI_Profile_URL: profileData.profileUrl,
      Contact_Source: 'LinkedIn'
    };
    // List batch tag. Only applied to newly created contacts: List is intentionally
    // NOT in FILLABLE_CONTACT_FIELDS, so the fill-blank path leaves existing contacts
    // untouched (no overwrite, no conflict on records from earlier batches).
    newData.List = todaysListName();
    if (profileData.title) newData.Title = profileData.title;
    if (profileData.city) newData.Mailing_City = profileData.city;
    if (profileData.state) newData.Mailing_State = profileData.state;
    if (profileData.country) newData.Mailing_Country = profileData.country;
    if (profileData.fullName) newData.Contact_Full_Name = profileData.fullName;
    if (profileData.email) newData.Email = profileData.email;
    if (profileData.phone) newData.Mobile = profileData.phone;
    // NOTE: the Bigin field is Email_1_Validation, not Email_Validation. Zoho silently
    // drops unknown field names and still returns success, so a typo here fails invisibly.
    if (profileData.email && profileData.emailValidation) newData.Email_1_Validation = profileData.emailValidation;
    if (accountId) newData.Account_Name = { id: accountId };

    // Step 1: Search for existing contact by LinkedIn URL (COQL)
    var existingId = null;
    if (profileData.profileUrl) {
      var safeUrl = profileData.profileUrl.replace(/'/g, "\\'");
      var q = "select id from Contacts where Contact_LI_Profile_URL = '" + safeUrl + "'";
      var search = await coqlQuery(q);
      if (search.data && search.data.length > 0) existingId = search.data[0].id;
    }

    // Step 2: If found, do NOT create a second contact. Fill in whatever the SDR
    // supplied for fields that are still empty in Bigin, then return the existing ID.
    if (existingId) {
      try {
        ctx.filledFields = await fillBlankContactFields(existingId, newData);
        if (ctx.filledFields.length > 0) {
          console.log('[Bigin] Contact exists, filled blanks:', ctx.filledFields.join(', '));
        } else {
          console.log('[Bigin] Contact exists, nothing blank to fill:', existingId);
        }
      } catch (e) {
        // A failed fill must never block the pipeline record from being created
        console.warn('[Bigin] Fill-blank failed:', e.message);
        ctx.filledFields = [];
        ctx.fillError = e.message;
      }
      return existingId;
    }

    // Step 3: Not found - create new contact
    var result = await biginRequest('POST', '/Contacts', { data: [newData] });
    if (result.data && result.data[0]) {
      if (result.data[0].code === 'DUPLICATE_DATA' && result.data[0].details && result.data[0].details.id) {
        console.log('[Bigin] Contact DUPLICATE_DATA - using existing ID:', result.data[0].details.id);
        return result.data[0].details.id;
      }
      if (result.data[0].details && result.data[0].details.id) {
        return result.data[0].details.id;
      }
    }
    return null;
  }

  // Sub_Pipeline is a Zoho picklist: the create payload must carry the current display
  // NAME, not an id (you cannot write a picklist by id). But names get renamed. We store
  // the picklist id in settings and translate it to whatever the current name is at write
  // time, so renaming the pipeline/sub-pipeline in Bigin never breaks writes. Metadata is
  // cached briefly so batch adds don't each pay for a metadata call.
  var _pipelineMetaCache = { data: null, at: 0 };
  var PIPELINE_META_TTL = 5 * 60 * 1000; // 5 min

  async function getPipelineMetaCached() {
    if (_pipelineMetaCache.data && (Date.now() - _pipelineMetaCache.at) < PIPELINE_META_TTL) {
      return _pipelineMetaCache.data;
    }
    var meta = await fetchPipelineMetadata();
    _pipelineMetaCache = { data: meta, at: Date.now() };
    return meta;
  }

  // id -> current sub-pipeline display name. Returns '' when it can't be resolved so the
  // caller falls back to the stored name. A real Zoho picklist id is a long numeric string;
  // if subPipelineId is anything else (e.g. a name captured from the records-API fallback
  // tier of fetchPipelineMetadata), it IS the name, so use it directly.
  async function resolveSubPipelineName(pipelineId, subPipelineId) {
    if (!subPipelineId) return '';
    if (!/^\d{6,}$/.test(String(subPipelineId))) return String(subPipelineId);
    try {
      var meta = await getPipelineMetaCached();
      for (var i = 0; i < meta.length; i++) {
        if (String(meta[i].id) !== String(pipelineId)) continue;
        var subs = meta[i].subPipelines || [];
        for (var j = 0; j < subs.length; j++) {
          if (String(subs[j].id) === String(subPipelineId)) return subs[j].name;
        }
        // Non-admin (SDR) path: the Settings API (tiers 1-2 of fetchPipelineMetadata) is
        // admin-only, so SDRs fall through to the records-API tier, which keys sub-pipelines
        // by NAME, not numeric id — so the id match above never fires for them. This tool is
        // locked to a single-purpose pipeline that has exactly one sub-pipeline, so resolve
        // it by taking that sole sub-pipeline's current name. Rename-proof (reads the live
        // name) and works without the Settings scope.
        if (subs.length === 1) return subs[0].name;
        break;
      }
    } catch (e) {
      console.warn('[Bigin] Sub-pipeline resolve failed:', e && e.message);
    }
    return '';
  }

  // Current display names for the locked pipeline + sub-pipeline, resolved by id so the
  // popup can show where leads go even after a rename. Display only. Falls back to the
  // known names if metadata can't be fetched.
  async function getLockedPipelineInfo() {
    var info = { pipeline: 'TeleStar Outreach', subPipeline: 'Standard' };
    try {
      var meta = await getPipelineMetaCached();
      for (var i = 0; i < meta.length; i++) {
        if (String(meta[i].id) !== LOCKED_PIPELINE_ID) continue;
        if (meta[i].name) info.pipeline = meta[i].name;
        var subs = meta[i].subPipelines || [];
        var matched = false;
        for (var j = 0; j < subs.length; j++) {
          if (String(subs[j].id) === LOCKED_SUBPIPELINE_ID) { info.subPipeline = subs[j].name; matched = true; break; }
        }
        // SDR / records-API tier keys subs by name, not numeric id — fall back to the sole
        // locked sub-pipeline so the popup shows the correct current name for non-admins too.
        if (!matched && subs.length === 1) info.subPipeline = subs[0].name;
        break;
      }
    } catch (e) { /* keep defaults */ }
    return info;
  }

  async function createPipelineRecord(profileData, settings, contactId, accountId) {
    var dealName = (profileData.fullName || profileData.lastName) + ' - ' + (profileData.company || 'No Company');
    // Pipeline + sub-pipeline are LOCKED (single-purpose tool). Settings are ignored so no
    // SDR can misconfigure and stale settings from older builds don't matter.
    var layoutId = LOCKED_PIPELINE_ID;
    // Rename-proof: resolve the locked sub-pipeline id to its current display name. Fall
    // back to the known default so a resolve miss never blocks the write.
    var subName = await resolveSubPipelineName(LOCKED_PIPELINE_ID, LOCKED_SUBPIPELINE_ID);
    if (!subName) subName = 'Standard';
    var pipelineData = {
      Layout: { id: layoutId },
      Deal_Name: dealName,
      Stage: profileData.stage || 'New Lead',
      Contact_LinkedIn1: profileData.profileUrl,
      Sub_Pipeline: subName,
      Lead_Source: 'LinkedIn'
    };
    // List batch tag - shared with the Contact + Account writes via todaysListName()
    pipelineData.List = todaysListName();
    if (profileData.title) pipelineData.Title = profileData.title;
    if (contactId) pipelineData.Contact_Name = { id: contactId };
    if (accountId) pipelineData.Account_Name = { id: accountId };
    if (settings.sdrUserId) {
      pipelineData.Owner = { id: settings.sdrUserId };
    }
    var result = await biginRequest('POST', '/Pipelines', { data: [pipelineData] });
    console.log('[Bigin] Pipeline POST response:', JSON.stringify(result));
    if (result.data && result.data[0]) {
      if (result.data[0].status === 'success') {
        return { success: true, id: result.data[0].details.id };
      }
      // Duplicate detected - try to find existing record instead of erroring
      var msg = (result.data[0].message || '').toLowerCase();
      if (result.data[0].code === 'DUPLICATE_DATA' || msg.indexOf('duplicate') !== -1) {
        // Try to get ID from error response details
        if (result.data[0].details && result.data[0].details.id) {
          console.log('[Bigin] Pipeline duplicate - using ID from response:', result.data[0].details.id);
          return { success: true, id: result.data[0].details.id, alreadyExisted: true };
        }
        // Fallback: search for existing Pipeline record via COQL
        if (profileData.profileUrl) {
          var safeUrl = profileData.profileUrl.replace(/'/g, "\\'");
          var q = "select id from Pipelines where Contact_LinkedIn1 = '" + safeUrl + "'";
          var search = await coqlQuery(q);
          if (search.data && search.data.length > 0) {
            console.log('[Bigin] Pipeline duplicate - found via COQL:', search.data[0].id);
            return { success: true, id: search.data[0].id, alreadyExisted: true };
          }
          // Also try with trailing slash
          var q2 = "select id from Pipelines where Contact_LinkedIn1 = '" + safeUrl + "/'";
          var search2 = await coqlQuery(q2);
          if (search2.data && search2.data.length > 0) {
            console.log('[Bigin] Pipeline duplicate - found via COQL (trailing slash):', search2.data[0].id);
            return { success: true, id: search2.data[0].id, alreadyExisted: true };
          }
        }
        // Still couldn't find - return as success with note (record exists but we can't locate it)
        console.warn('[Bigin] Pipeline duplicate detected but could not find existing record');
        return { success: true, id: null, alreadyExisted: true };
      }
      return { success: false, error: result.data[0].message || 'Failed to create pipeline record' };
    }
    return { success: false, error: 'No response from Bigin API' };
  }

  async function addToBigin(profileData) {
    var settings = {};
    var stored = await chrome.storage.local.get('biginSettings');
    if (stored.biginSettings) settings = stored.biginSettings;

    var dedup;
    try {
      dedup = await checkDuplicate(profileData.profileUrl);
    } catch (e) {
      // Hard block: if we can't verify, we don't create — avoids silent duplicates
      throw new Error('Dedup check failed (' + e.message + '). Blocked to avoid creating a duplicate — try again.');
    }
    if (dedup.isDuplicate) {
      return { success: false, isDuplicate: true, existing: dedup.record };
    }

    var warnings = [];

    var accountId = null;
    if (profileData.company) {
      try { accountId = await upsertAccount(profileData); }
      catch (e) {
        console.error('Account upsert failed:', e);
        warnings.push('Company not linked: ' + e.message);
      }
    }

    var contactId = null;
    var contactCtx = {};
    try { contactId = await upsertContact(profileData, accountId, contactCtx); }
    catch (e) {
      console.error('Contact upsert failed:', e);
      warnings.push('Contact not created: ' + e.message);
    }
    if (contactCtx.fillError) {
      warnings.push('Could not update existing contact: ' + contactCtx.fillError);
    }

    var pipelineResult = await createPipelineRecord(profileData, settings, contactId, accountId);
    if (!pipelineResult.success) {
      return { success: false, error: pipelineResult.error, accountId: accountId, contactId: contactId };
    }
    return {
      success: true, accountId: accountId, contactId: contactId,
      filledFields: contactCtx.filledFields || [],
      pipelineId: pipelineResult.id,
      dealName: (profileData.fullName || profileData.lastName) + ' - ' + (profileData.company || 'No Company'),
      warnings: warnings.length > 0 ? warnings : null
    };
  }

  // ════════════════════════════════════════
  //  METADATA / USERS
  // ════════════════════════════════════════

  async function fetchBiginUsers() {
    var result = await biginRequest('GET', '/users?type=AllUsers');
    if (result.users) {
      return result.users.map(function(u) {
        return {
          id: u.id,
          name: u.full_name || (u.first_name + ' ' + u.last_name),
          email: u.email,
          role: u.role ? u.role.name : '',
          status: u.status
        };
      }).filter(function(u) { return u.status === 'active'; });
    }
    return [];
  }

  async function fetchCurrentUser() {
    var result = await biginRequest('GET', '/users?type=CurrentUser');
    if (result.users && result.users.length > 0) {
      var u = result.users[0];
      return {
        id: u.id,
        name: u.full_name || (u.first_name + ' ' + u.last_name),
        email: u.email,
        role: u.role ? u.role.name : ''
      };
    }
    return null;
  }

  // Pipeline metadata — 3-tier fallback: layouts -> fields -> records API
  async function fetchPipelineMetadata() {
    // Tier 1: Layouts API (requires ZohoBigin.settings.* scope)
    try {
      console.log('[Bigin] Trying /settings/layouts?module=Pipelines');
      var r1 = await biginRequest('GET', '/settings/layouts?module=Pipelines');
      console.log('[Bigin] layouts keys:', Object.keys(r1));
      if (r1.layouts && r1.layouts.length > 0) {
        console.log('[Bigin] Got', r1.layouts.length, 'layouts');
        return r1.layouts.map(function(layout) {
          var subs = [];
          var stgs = [];
          (layout.sections || []).forEach(function(sec) {
            (sec.fields || []).forEach(function(f) {
              if (f.api_name === 'Sub_Pipeline') {
                subs = (f.pick_list_values || []).map(function(pv) {
                  return { id: pv.id || pv.display_value, name: pv.display_value };
                });
              }
              if (f.api_name === 'Stage') {
                stgs = (f.pick_list_values || []).map(function(pv) {
                  return { id: pv.id || pv.display_value, name: pv.display_value };
                });
              }
            });
          });
          return { id: layout.id, name: layout.name, subPipelines: subs, stages: stgs };
        });
      }
    } catch (e) {
      console.log('[Bigin] layouts failed:', e.message);
    }

    // Tier 2: Fields API (requires ZohoBigin.settings.* scope)
    try {
      console.log('[Bigin] Trying /settings/fields?module=Pipelines');
      var r2 = await biginRequest('GET', '/settings/fields?module=Pipelines');
      console.log('[Bigin] fields keys:', Object.keys(r2));
      var fields = r2.fields || [];
      var pf = fields.find(function(f) { return f.api_name === 'Pipeline'; });
      var sf = fields.find(function(f) { return f.api_name === 'Stage'; });
      if (pf && pf.pick_list_values && pf.pick_list_values.length > 0) {
        console.log('[Bigin] Got', pf.pick_list_values.length, 'pipeline values from fields');
        return pf.pick_list_values.map(function(pv) {
          var subs = [];
          if (pv.maps && pv.maps.length > 0) {
            subs = pv.maps.map(function(m) {
              return { id: m.id || m.display_value, name: m.display_value || m.actual_value };
            });
          }
          var stgs = sf ? (sf.pick_list_values || []).map(function(s) {
            return { id: s.id || s.display_value, name: s.display_value };
          }) : [];
          return { id: pv.id || pv.display_value, name: pv.display_value || pv.actual_value, subPipelines: subs, stages: stgs };
        });
      }
    } catch (e) {
      console.log('[Bigin] fields failed:', e.message);
    }

    // Tier 3: Records API fallback (returns Pipeline as {name, id} object)
    try {
      console.log('[Bigin] Trying Records API fallback');
      var r3 = await biginRequest('GET', '/Pipelines?fields=Pipeline,Sub_Pipeline&per_page=200');
      if (r3.data && r3.data.length > 0) {
        var pm = {};
        r3.data.forEach(function(rec) {
          var p = rec.Pipeline;
          var pName = (p && typeof p === 'object') ? p.name : p;
          var pId = (p && typeof p === 'object') ? p.id : p;
          var s = rec.Sub_Pipeline;
          if (!pName) return;
          if (!pm[pName]) pm[pName] = { id: pId, subs: {} };
          if (s) pm[pName].subs[s] = true;
        });
        console.log('[Bigin] Records API found', Object.keys(pm).length, 'pipelines');
        return Object.keys(pm).sort().map(function(pName) {
          return {
            id: pm[pName].id, name: pName,
            subPipelines: Object.keys(pm[pName].subs).sort().map(function(sp) { return { id: sp, name: sp }; }),
            stages: []
          };
        });
      }
    } catch (e) {
      console.log('[Bigin] Records API failed:', e.message);
    }

    console.log('[Bigin] All pipeline fetch approaches failed');
    return [];
  }

  async function testConnection() {
    try {
      var token = await getAccessToken();
      // Use /users?type=CurrentUser instead of /org (avoids scope issues)
      var resp = await fetch(BIGIN_API + '/users?type=CurrentUser', {
        headers: { 'Authorization': 'Zoho-oauthtoken ' + token }
      });
      var data = await resp.json();
      if (data.users && data.users.length > 0) {
        var u = data.users[0];
        var orgName = u.full_name || 'Bigin CRM';
        return { success: true, org: orgName };
      }
      return { success: false, error: 'Could not verify connection' };
    } catch (e) {
      return { success: false, error: '[testConnection] ' + e.message };
    }
  }

  // ════════════════════════════════════════
  //  MESSAGE HANDLER
  // ════════════════════════════════════════

  chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
    var handler = async function() {
      try {
        switch (msg.action) {
          case 'login':
            return await loginWithBigin();
          case 'logout':
            return await logoutBigin();
          case 'getLoginStatus':
            return await getLoginStatus();
          case 'testConnection':
            return await testConnection();
          case 'checkDuplicate':
            return await checkDuplicate(msg.linkedinUrl);
          case 'addToBigin':
            return await addToBigin(msg.profileData);
          case 'fetchUsers':
            return { success: true, users: await fetchBiginUsers() };
          case 'fetchCurrentUser':
            var user = await fetchCurrentUser();
            return user ? { success: true, user: user } : { success: false, error: 'Could not detect user' };
          case 'fetchPipelines':
            return { success: true, pipelines: await fetchPipelineMetadata() };
          case 'getLockedPipeline':
            return { success: true, info: await getLockedPipelineInfo() };
          default:
            return { success: false, error: 'Unknown action' };
        }
      } catch (e) {
        return { success: false, error: e.message };
      }
    };
    handler().then(sendResponse);
    return true;
  });

  // ════════════════════════════════════════
  //  BADGE NOTIFICATIONS
  // ════════════════════════════════════════

  chrome.runtime.onMessage.addListener(function(msg) {
    if (msg.action === 'setBadge') {
      chrome.action.setBadgeText({ text: msg.text || '' });
      chrome.action.setBadgeBackgroundColor({ color: msg.color || '#4CAF50' });
      if (msg.text) {
        setTimeout(function() { chrome.action.setBadgeText({ text: '' }); }, 3000);
      }
    }
  });

})();
