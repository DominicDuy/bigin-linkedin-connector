# Bigin LinkedIn Connector

**A Chrome extension that lets SDRs add LinkedIn contacts to Zoho Bigin CRM in one click.**

Built for TeleStar's Lead Generation team. Sideloaded internally (not published on the Chrome Web Store).

---

## The Problem

Our SDRs were spending 5-10 minutes per lead copying information from LinkedIn into Bigin CRM by hand: open the profile, read the name, job title, and company, switch to Bigin, create a Contact, create an Account, create a Pipeline record, link them together. Multiply that by 40-60 leads a day across the team, and we were burning hours on data entry instead of outreach.

The manual process also introduced errors. Typos in names, mismatched company associations, duplicate records from different team members adding the same person, and leads landing in the wrong pipeline because someone picked the wrong dropdown. These weren't occasional mistakes; they were systemic friction that came from asking people to do repetitive copy-paste work dozens of times a day.

## The Solution

A Chrome extension that sits on top of LinkedIn and does the entire flow in one click:

1. **Scrape** the profile page for name, headline, job title, company, company LinkedIn URL, and location
2. **Check for duplicates** against the team's pipeline in Bigin (scoped, so the same lead in another client's pipeline doesn't block it)
3. **Create or link** the Account, Contact, and Pipeline records in Bigin, wiring them together automatically
4. **Fill blanks** on existing contacts: if the person already exists but their email or title field is empty, the extension writes only those empty fields without touching anything an SDR edited by hand

The SDR signs in once with their Zoho account. After that, they visit a LinkedIn profile, click the extension icon, optionally add an email/phone, and hit "Add to Bigin." The whole interaction takes under 10 seconds.

## Architecture

**Manifest V3 Chrome Extension** with three main components:

```
manifest.json          Extension config, permissions, content script registration
background.js (952L)   Service worker: OAuth, Bigin API, record CRUD, dedup
content.js (1157L)     LinkedIn DOM scraper, injected on linkedin.com/in/* pages
popup.html + popup.js  UI the SDR sees when they click the extension icon
popup.css              Styling for the popup
privacy/index.html     Privacy policy page (bilingual EN/VI)
```

### OAuth and Org Guard

The extension uses Zoho's OAuth 2.0 flow via `chrome.identity.launchWebAuthFlow`. Since OAuth succeeds for *any* Zoho account, including personal ones, every login is checked against TeleStar's organization ID (ZGID) immediately after token exchange. If the ZGID doesn't match, the token is wiped and the SDR gets a clear error message. The guard fails closed: if the `/org` API call itself fails (network error, Zoho 5xx), the token is still wiped rather than letting an unverified account through.

```
Login -> Token Exchange -> /org check -> ZGID match? 
  Yes -> Store token, fetch user info, proceed
  No  -> Wipe token, show "wrong org" error
  API error -> Wipe token, show "could not verify" error
```

### LinkedIn DOM Scraping (content.js)

LinkedIn is a React SPA that changes its DOM structure without notice. The scraper uses a multi-strategy approach with 5 fallback paths for experience data:

| Strategy | Method | When it works |
|----------|--------|---------------|
| A | `data-field="experience_company_logo"` anchor + DOM siblings | Most reliable; uses LinkedIn's analytics attributes |
| B | Find "Present" date span, walk `previousElementSibling` | Works when date elements are consistently structured |
| C | List-item traversal with simple/grouped format detection | Handles both single-role and multi-role-at-one-company layouts |
| D | Flat text collection with heuristic classification | Fallback when DOM structure is heavily obfuscated |
| E | `innerText`-based parsing | Last resort; most resilient to DOM changes |

Each strategy feeds results through a shared cleanup pipeline:

- **`cleanCompany()`** is the single choke point for all company names. It strips employment type suffixes ("Full-time", "Toàn thời gian"), removes trailing dots, and returns `''` rather than a bad guess.
- **`isValidCompany()`** rejects garbage: strings with 4+ consecutive digits, comma-grouped numbers, or multi-line text.
- **`finalizeCompany()`** enforces precedence: structural DOM result > text parsing > headline fallback. If the best company source is the top card (most reliable), it wins.
- **Bilingual support**: `isEmploymentType()` and `isLocationType()` handle both English and Vietnamese because several team members browse LinkedIn in Vietnamese.

The scraper also handles LinkedIn's lazy loading. `ensureExperienceLoaded()` scrolls the page to trigger intersection observers that load the Experience section, which LinkedIn defers until visible.

Auto-scrape fires on page load and on SPA navigation (detected via `MutationObserver` + URL polling), so the data is ready before the SDR opens the popup.

### Dedup Logic

Duplicate checking runs *before* any record creation and is scoped to the locked pipeline ID. This scoping matters: TeleStar runs multiple client pipelines in the same Bigin org. A lead that exists in Client A's pipeline should still be addable to Client B's pipeline.

The dedup query uses COQL (Zoho's query language) to search by LinkedIn URL, then filters by pipeline ID in JavaScript. COQL doesn't support filtering on the Pipeline field directly (it returns empty results even when records exist), so the two-step approach is necessary.

Both URL variants are checked: with and without a trailing slash. LinkedIn normalizes URLs inconsistently, and a missed trailing slash was causing false negatives in early versions.

If the dedup API call itself fails, the entire flow is hard-blocked. A failed check never falls through to "no duplicate found," which would silently create duplicates.

### Fill-Blank Pattern

When a contact already exists in Bigin, the extension doesn't overwrite anything. Instead, it reads the current record, compares each fillable field, and writes only the ones that are currently empty. This is important because SDRs frequently edit contact details by hand after initial creation, and those manual edits should never be clobbered.

The fill is confirmed by re-reading the record after the write. Zoho silently ignores field names it doesn't recognize and still returns a success response, so without the re-read, the popup could claim it saved something that Bigin quietly threw away.

### Pipeline Metadata Fallback

Zoho Bigin's `Sub_Pipeline` field is a picklist that requires the current *display name* for writes (not an ID). But pipeline names get renamed by admins. The extension resolves the locked sub-pipeline ID to whatever its current name is at write time through a 3-tier metadata fallback:

1. **Layouts API** (`/settings/layouts?module=Pipelines`) - richest data, but requires admin-level settings scope
2. **Fields API** (`/settings/fields?module=Pipelines`) - similar data, same scope restriction
3. **Records API** (`/Pipelines?fields=Pipeline,Sub_Pipeline`) - works for all users including SDRs, keys by name instead of numeric ID

Metadata is cached for 5 minutes so batch adds don't each pay for a metadata call.

### XSS Prevention

Scraped LinkedIn text (names, company names) and CRM strings are attacker-influenceable. A crafted profile name like `<img onerror="...">` could inject script into the popup, which has `chrome.storage` access (including the Bigin refresh token). All untrusted values are escaped through `escapeHtml()` before they touch `innerHTML`.

## Key Design Decisions

**Single-purpose lock.** The extension writes to exactly one pipeline, pinned by ID. Earlier versions had a pipeline chooser in settings, which led to SDRs accidentally adding leads to the wrong pipeline. Removing the choice eliminated the error class entirely. If the tool needs to target a different pipeline later, two constants are changed and the extension is re-uploaded.

**Fail-closed on every guard.** The org check, the dedup check, and the sub-pipeline resolution all fail closed. An unverified org wipes the token. A failed dedup blocks the write. An unresolvable sub-pipeline falls back to a known default rather than writing nothing. The cost is that an SDR on a flaky connection sometimes has to retry. The benefit is that bad data never enters the CRM silently.

**Fill, don't overwrite.** The fill-blank pattern respects manual edits. Identity fields (names, LinkedIn URL, source) are excluded from the fillable set entirely, so the extension never rewrites who a contact *is*, only fills in what's missing.

**Batch tagging.** Every record created in a single scrape (Contact, Account, Pipeline) gets the same `List` tag: `Tele_DD.MM_Extension`. This makes it easy to audit which records came from the extension and when.

## Tech Stack

- **Chrome Extension** (Manifest V3, service worker)
- **Zoho Bigin API** (OAuth 2.0, COQL queries, record CRUD)
- **LinkedIn DOM scraping** (multi-strategy, bilingual, lazy-load aware)
- **Vanilla JS** throughout (no build step, no dependencies, sideloaded)

## Results

- **Lead entry time**: from 5-10 minutes per lead down to under 10 seconds
- **Data consistency**: eliminated the manual-entry typos, wrong-pipeline mistakes, and orphaned records that were common before
- **Duplicate prevention**: pipeline-scoped dedup catches duplicates that the team's previous process missed entirely
- **Adoption**: used daily by the Lead Generation team for LinkedIn prospecting into Bigin

## Repository Structure

```
.
├── manifest.json            Chrome extension manifest (V3)
├── background.js            Service worker (OAuth, API, CRUD, dedup)
├── content.js               LinkedIn profile scraper
├── popup.html               Extension popup markup
├── popup.js                 Popup logic and state management
├── popup.css                Popup styles
├── icons/                   Extension icons (16/48/128px)
└── privacy/
    └── index.html           Privacy policy (EN + VI)
```

## Setup (Internal)

1. Clone the repo
2. Fill in the placeholder credentials in `background.js` (`CLIENT_ID`, `CLIENT_SECRET`, `TELESTAR_ZGID`, pipeline IDs)
3. Go to `chrome://extensions`, enable Developer Mode, click "Load unpacked", select the repo folder
4. Navigate to any LinkedIn profile and click the extension icon

> **Note**: This is an internal tool. The OAuth client ID, org ZGID, and pipeline IDs have been replaced with placeholders for this public repository. The extension requires valid Zoho Bigin API credentials and organization access to function.

## Privacy

The extension reads only publicly displayed LinkedIn profile data on pages the user deliberately opens. Data is sent only to Zoho Bigin. No analytics, no tracking, no third-party sharing. Full policy: [privacy/index.html](privacy/index.html)

## Author

**Duy Phung** - Lead Generation Leader at TeleStar  
Built as an internal tool to streamline the team's LinkedIn-to-CRM workflow.
