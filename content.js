// content.js — LinkedIn Profile Scraper
// Runs on linkedin.com/in/* pages
// Updated 2026-07-11: Complete rewrite of Experience scraper.
// Uses DOM-level navigation (element siblings, data-field attributes)
// instead of flat text array. Handles both simple and grouped formats.
// Research sources: situmorang-com/LinkedIn-Scraper, harikabv/Medium article,
// joshuatz/linkedin-to-jsonresume patterns.

(function() {
  'use strict';

  if (window.__biginExtensionInjected) return;
  window.__biginExtensionInjected = true;

  function normalizeLinkedInUrl(url) {
    try {
      var u = new URL(url);
      var path = u.pathname.replace(/\/+$/, '').toLowerCase();
      return 'https://www.linkedin.com' + path;
    } catch (e) { return url; }
  }

  function extractCompanySlug(href) {
    if (!href) return null;
    var m = href.match(/\/company\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  var SECTION_HEADERS = [
    'about', 'experience', 'education', 'activity', 'analytics',
    'skills', 'interests', 'recommendations', 'courses', 'projects',
    'licenses & certifications', 'volunteer experience', 'publications',
    'honors & awards', 'languages', 'organizations', 'featured',
    'suggested for you', 'people also viewed', 'people you may know',
    'profile language', 'public profile & url', 'ad options',
    "don't want to see this", 'explore premium profiles'
  ];

  function isSectionHeader(text) {
    var lower = text.toLowerCase().trim();
    if (/^\d+\s+notification/.test(lower)) return true;
    if (/^\d[\d,]*\s+follower/.test(lower)) return true;
    for (var i = 0; i < SECTION_HEADERS.length; i++) {
      if (lower === SECTION_HEADERS[i]) return true;
    }
    return false;
  }

  function getProfileCardSection() {
    var main = document.querySelector('main');
    return main ? main.querySelector('section') : null;
  }

  // ── SECTION FINDER — multi-strategy ──
  // Strategy 1: h2 > span containing header text (works with LinkedIn's span-inside-h2 pattern)
  // Strategy 2: h2 with exact textContent match
  // Strategy 3: element with matching id attribute
  function findSectionByH2(headerText) {
    var main = document.querySelector('main');
    if (!main) return null;

    // Strategy 1: h2 > span pattern (most reliable for current LinkedIn)
    var spans = main.querySelectorAll('h2 > span');
    for (var i = 0; i < spans.length; i++) {
      if (spans[i].textContent.trim().toLowerCase().indexOf(headerText.toLowerCase()) !== -1) {
        var section = spans[i].closest('section');
        if (section) return section;
        // Walk up manually if closest doesn't find section
        var el = spans[i];
        for (var j = 0; j < 8; j++) {
          el = el.parentElement;
          if (!el) break;
          if (el.tagName === 'SECTION') return el;
        }
      }
    }

    // Strategy 2: h2 exact text match
    var h2s = main.querySelectorAll('h2');
    for (var i = 0; i < h2s.length; i++) {
      if (h2s[i].textContent.trim().toLowerCase() === headerText.toLowerCase()) {
        var el = h2s[i];
        for (var j = 0; j < 6; j++) {
          el = el.parentElement;
          if (!el) break;
          if (el.tagName === 'SECTION') return el;
        }
        return h2s[i].parentElement ? h2s[i].parentElement.parentElement : null;
      }
    }

    // Strategy 3: id-based lookup
    var byId = document.querySelector('#' + headerText.toLowerCase());
    if (byId) {
      var section = byId.closest('section');
      if (section) return section;
    }

    return null;
  }

  // ── HELPER: get visible text from an element, preferring aria-hidden spans ──
  function getVisibleText(el) {
    if (!el) return '';
    var span = el.querySelector('span[aria-hidden="true"]');
    if (span) return span.textContent.trim();
    // Fallback: clone, remove visually-hidden, get text
    var clone = el.cloneNode(true);
    var hidden = clone.querySelectorAll('.visually-hidden');
    for (var i = 0; i < hidden.length; i++) hidden[i].remove();
    return clone.textContent.trim().replace(/\s+/g, ' ');
  }

  // ── HELPER: check if text looks like a date range ──
  function isDateRange(text) {
    if (!text) return false;
    return /\d{4}/.test(text) && (/[-–]/.test(text) || /present/i.test(text));
  }

  // ── HELPER: check if text looks like a duration ──
  function isDuration(text) {
    if (!text) return false;
    return /^\d+\s*(yr|mo|year|month|tháng|năm)/i.test(text.trim());
  }

  // ── HELPER: check if text is an employment type tag ──
  // English + Vietnamese, because LinkedIn renders these in the viewer's UI language and
  // several people on the team browse LinkedIn in Vietnamese.
  function isEmploymentType(text) {
    if (!text) return false;
    var t = text.trim();
    if (/^(Full-time|Part-time|Contract|Freelance|Self-employed|Internship|Seasonal|Apprenticeship)$/i.test(t)) return true;
    return /^(Toàn thời gian|Bán thời gian|Hợp đồng|Tự do|Tự làm chủ|Thực tập|Thời vụ|Học nghề)$/i.test(t);
  }

  // ── HELPER: check if text is a location type ──
  function isLocationType(text) {
    if (!text) return false;
    var t = text.trim();
    if (/^(Remote|On-site|Onsite|Hybrid)$/i.test(t)) return true;
    return /^(Từ xa|Tại chỗ|Tại văn phòng|Kết hợp)$/i.test(t);
  }

  // ── HELPER: check if text is metadata (not a title or company) ──
  function isMetadata(text) {
    if (!text) return true;
    var t = text.trim();
    if (t.length < 2) return true;
    if (isDateRange(t)) return true;
    if (isDuration(t)) return true;
    if (isEmploymentType(t)) return true;
    if (isLocationType(t)) return true;
    if (/^(See all|Show all|See more|\d+ recommendation)/i.test(t)) return true;
    return false;
  }

  // NAME
  function scrapeName() {
    var main = document.querySelector('main');
    if (main) {
      var h2s = main.querySelectorAll('h2');
      for (var i = 0; i < h2s.length; i++) {
        var text = h2s[i].textContent.trim().replace(/\s+/g, ' ');
        if (text.length > 1 && !isSectionHeader(text)) {
          var parts = text.split(' ');
          return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') || '' };
        }
      }
    }
    var title = document.title || '';
    var m = title.match(/^(.+?)\s*[|–—]\s*LinkedIn/);
    if (m) {
      var parts = m[1].trim().split(' ');
      return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') || '' };
    }
    var h1 = document.querySelector('h1.text-heading-xlarge')
          || document.querySelector('h1[class*="text-heading"]')
          || document.querySelector('.pv-top-card h1')
          || document.querySelector('h1');
    if (h1) {
      var full = h1.textContent.trim().replace(/\s+/g, ' ');
      var parts = full.split(' ');
      return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') || '' };
    }
    return { firstName: '', lastName: '' };
  }

  // HEADLINE
  function scrapeHeadline() {
    var section = getProfileCardSection();
    if (section) {
      var ps = section.querySelectorAll('p');
      for (var i = 0; i < ps.length; i++) {
        var text = ps[i].textContent.trim().replace(/\s+/g, ' ');
        if (text.length < 8) continue;
        if (/^[·•]\s*\d/.test(text)) continue;
        if (/^https?:\/\//.test(text)) continue;
        if (/^contact info$/i.test(text)) continue;
        if (/^\d[\d,]*\s+follower/i.test(text)) continue;
        if (/^\d[\d,]*\s+connection/i.test(text)) continue;
        if (/^verify\s/i.test(text)) continue;
        if (/^open to\s/i.test(text)) continue;
        if (/^show\s/i.test(text)) continue;
        if (/^showcase\s/i.test(text)) continue;
        if (/^add\s/i.test(text)) continue;
        if (/^followed by\s/i.test(text)) continue;
        if (/^profile enhanced/i.test(text)) continue;
        if (/^promoted/i.test(text)) continue;
        if (/^people also/i.test(text)) continue;
        if (/^mutual connection/i.test(text)) continue;
        return text;
      }
    }
    var el = document.querySelector('.text-body-medium.break-words')
          || document.querySelector('.pv-top-card .text-body-medium');
    return el ? el.textContent.trim().replace(/\s+/g, ' ') : '';
  }

  function parseHeadline(headline) {
    if (!headline) return { title: '', company: '' };
    var patterns = [
      /^(.+?)\s+(?:at|@|tại)\s+(.+)$/i,
      /^(.+?)\s*\|\s*(.+)$/,
      /^(.+?)\s+[-–—]+\s+(.+)$/
    ];
    for (var i = 0; i < patterns.length; i++) {
      var m = headline.match(patterns[i]);
      if (m) return { title: m[1].trim(), company: m[2].trim() };
    }
    return { title: headline, company: '' };
  }

  // LOCATION
  function scrapeLocation() {
    // Strategy 1: "Contact info" link anchor (most reliable)
    // Location <p> is always in the same parent <div> as the "Contact info" link.
    // Structure: <div> → <p>Location</p> <p>·</p> <p><a href="...overlay/contact-info/">Contact info</a></p>
    var contactLink = document.querySelector('a[href*="overlay/contact-info"]');
    if (contactLink) {
      var wrapper = contactLink.closest('div');
      if (wrapper) {
        var ps = wrapper.querySelectorAll(':scope > p');
        for (var i = 0; i < ps.length; i++) {
          var text = ps[i].textContent.trim().replace(/\s+/g, ' ');
          if (!text || text.length < 2 || text.length > 80) continue;
          if (text === '·' || text === '•') continue;
          if (/contact\s*info/i.test(text)) continue;
          return text;
        }
      }
    }

    // Strategy 2: LinkedIn's legacy CSS selector
    var el = document.querySelector('.text-body-small.inline.t-black--light.break-words')
          || document.querySelector('.pv-top-card--list .text-body-small');
    if (el) {
      var directText = el.textContent.trim().replace(/\s+/g, ' ');
      if (directText.length >= 2 && directText.length < 80) return directText;
    }

    return '';
  }

  // ══════════════════════════════════════════════════════════
  // EXPERIENCE SCRAPER — Multi-strategy DOM navigation
  // ══════════════════════════════════════════════════════════

  function scrapeCurrentExperience() {
    var result = { title: '', company: '', companyUrl: '' };

    // ── 1. FIND EXPERIENCE SECTION ──
    var section = findSectionByH2('Experience');
    if (!section) {
      var expEl = document.querySelector('#experience')
                || document.querySelector('section[id="experience"]');
      if (expEl) section = expEl.closest('section') || expEl;
    }
    if (!section) return result;

    // ── 2. COMPANY URL ──
    var companyLink = section.querySelector('a[href*="/company/"]');
    if (companyLink) {
      var slug = extractCompanySlug(companyLink.href);
      if (slug) result.companyUrl = 'https://www.linkedin.com/company/' + slug + '/';
    }

    // ── 3. STRATEGY A: data-field="experience_company_logo" + DOM siblings ──
    // This is the most stable selector — it's a data attribute used for analytics.
    var gotA = strategyDataField(section, result);
    if (gotA) return finalizeCompany(result, companyLink);

    // ── 4. STRATEGY B: "Present" span + previousElementSibling navigation ──
    // Find the date span containing "Present", then walk siblings for title/company.
    var gotB = strategyPresentSibling(section, result);
    if (gotB) return finalizeCompany(result, companyLink);

    // ── 5. STRATEGY C: List-item based — find entries, detect simple vs grouped ──
    // Walk list items, use text classification to identify title/company/date.
    var gotC = strategyListItems(section, result);
    if (gotC) return finalizeCompany(result, companyLink);

    // ── 6. STRATEGY E: innerText-based (most resilient to DOM changes) ──
    var gotE = strategyInnerText(section, result);
    if (gotE) return finalizeCompany(result, companyLink);

    // ── 7. STRATEGY D: Flat text collection with improved heuristics ──
    var gotD = strategyFlatText(section, result);
    if (gotD) return finalizeCompany(result, companyLink);

    return finalizeCompany(result, companyLink);
  }

  // ── STRATEGY A: data-field anchor ──
  function strategyDataField(section, result) {
    var anchors = section.querySelectorAll('a[data-field="experience_company_logo"]');
    if (anchors.length === 0) return false;

    // The first anchor = most recent experience entry
    var anchor = anchors[0];

    // Company name: span[aria-hidden="true"] inside the anchor
    var companySpan = anchor.querySelector('span[aria-hidden="true"]');
    var companyName = companySpan ? companySpan.textContent.trim() : '';

    // Job title: navigate to anchor's closest div → nextElementSibling → span[aria-hidden="true"]
    var parentDiv = anchor.closest('div');
    var siblingDiv = parentDiv ? parentDiv.nextElementSibling : null;

    var jobTitle = '';
    if (siblingDiv) {
      var titleSpan = siblingDiv.querySelector('span[aria-hidden="true"]');
      jobTitle = titleSpan ? titleSpan.textContent.trim() : '';
    }

    // Validate: if jobTitle looks like metadata, this might be a grouped entry
    // In grouped format, the "title" from sibling is actually a duration like "5 yrs 2 mos"
    if (isMetadata(jobTitle)) {
      // GROUPED FORMAT: companyName is correct, but we need the actual title
      // Look for sub-entries containing "Present"
      var subTitle = findCurrentTitleInGrouped(section, anchor);
      if (subTitle) {
        result.company = cleanCompany(companyName);
        result.title = subTitle;
        return true;
      }
      // If we found company but no title from sub-entries, still set company
      if (companyName) {
        result.company = cleanCompany(companyName);
        // Try to get title from next strategy
        return false;
      }
      return false;
    }

    // SIMPLE FORMAT: title is what we got, company needs extraction
    // In simple format, the sibling div's span has the job title
    // And company might be in a different text element within the entry
    if (jobTitle && companyName) {
      // Check: sometimes company anchor text IS the company, and sibling has the title
      // But sometimes it's reversed depending on LinkedIn's layout
      // Use heuristic: if jobTitle contains " · " it's likely "Company · Type"
      if (/[\xb7•‧⋅]/.test(jobTitle) && !isDateRange(jobTitle)) {
        // jobTitle is actually "Company · Full-time" format
        result.company = cleanCompany(jobTitle.split(/[\xb7•‧⋅]/)[0].trim());
        // The real title might be one more sibling back — try previousElementSibling
        if (parentDiv && parentDiv.previousElementSibling) {
          var prevSpan = parentDiv.previousElementSibling.querySelector('span[aria-hidden="true"]');
          if (prevSpan) {
            var prevText = prevSpan.textContent.trim();
            if (!isMetadata(prevText)) {
              result.title = prevText;
              return true;
            }
          }
        }
        // Still no title — company is set, return false to try other strategies for title
        return false;
      }

      result.title = jobTitle;
      result.company = cleanCompany(companyName);
      return true;
    }

    if (companyName && !jobTitle) {
      result.company = cleanCompany(companyName);
      return false; // Got company, need title from another strategy
    }

    return false;
  }

  // ── Find current title within a grouped experience entry ──
  function findCurrentTitleInGrouped(section, companyAnchor) {
    // In grouped format, there are sub-entries under the company header.
    // Each sub-entry has: title, date range, employment type, location
    // We need the one whose date contains "Present"

    // Navigate up from the company anchor to find the parent container
    var container = companyAnchor.closest('li') || companyAnchor.closest('[class*="pvs-entity"]');
    if (!container) {
      // Try walking up from anchor to find a div that contains sub-entries
      var el = companyAnchor;
      for (var i = 0; i < 10; i++) {
        el = el.parentElement;
        if (!el || el === section) break;
        // Check if this element contains nested list items
        var nestedLis = el.querySelectorAll('li');
        if (nestedLis.length > 1) { container = el; break; }
      }
    }
    if (!container) container = section;

    // Find all spans in the container
    var spans = container.querySelectorAll('span[aria-hidden="true"]');
    var presentIdx = -1;
    var texts = [];

    for (var i = 0; i < spans.length; i++) {
      var t = spans[i].textContent.trim();
      if (t && t.length > 1) {
        texts.push({ text: t, el: spans[i] });
      }
    }

    // Find the first date range containing "Present"
    for (var i = 0; i < texts.length; i++) {
      if (/present/i.test(texts[i].text) && /\d{4}/.test(texts[i].text)) {
        presentIdx = i;
        break;
      }
    }

    if (presentIdx < 1) return null;

    // The title should be right before the date range
    // Walk backwards from presentIdx, skipping metadata
    for (var i = presentIdx - 1; i >= 0; i--) {
      var t = texts[i].text;
      if (!isMetadata(t) && t.search(/[\xb7•‧⋅]/) === -1) {
        return t;
      }
      // If we hit "· Full-time" style text, the title is before it
      if (/[\xb7•‧⋅]/.test(t)) {
        // This is "Company · Type" — skip it, title is before
        continue;
      }
    }

    return null;
  }

  // ── STRATEGY B: "Present" span + sibling elements ──
  function strategyPresentSibling(section, result) {
    // Find span elements whose text contains "Present" AND a year
    var allSpans = section.querySelectorAll('span');
    var presentSpan = null;

    for (var i = 0; i < allSpans.length; i++) {
      var txt = allSpans[i].textContent.trim();
      if (/present/i.test(txt) && /\d{4}/.test(txt)) {
        // This is a date range like "Jan 2020 - Present · 4 yrs 6 mos"
        presentSpan = allSpans[i];
        break;
      }
    }
    if (!presentSpan) return false;

    // Navigate to the parent element that wraps this date range
    var dateParent = presentSpan.parentElement;
    if (!dateParent) return false;

    // Walk up to find an element with siblings that contain title/company info
    // The pattern varies, but usually:
    // - previousElementSibling of the date container has company info
    // - 2 siblings back has the title
    // This matches the situmorang-com fallback route

    var prev1 = dateParent.previousElementSibling;
    var prev2 = prev1 ? prev1.previousElementSibling : null;

    if (prev1) {
      var text1 = getVisibleText(prev1);

      if (prev2) {
        var text2 = getVisibleText(prev2);

        // text2 = title, text1 = "company · employment type"
        if (!isMetadata(text2) && !isMetadata(text1)) {
          // Check which one has the · separator (that's the company line)
          if (/[\xb7•‧⋅]/.test(text1)) {
            result.title = text2;
            result.company = cleanCompany(text1.split(/[\xb7•‧⋅]/)[0].trim());
            return true;
          }
          // If text2 has ·, roles might be swapped
          if (/[\xb7•‧⋅]/.test(text2)) {
            result.title = text1;
            result.company = cleanCompany(text2.split(/[\xb7•‧⋅]/)[0].trim());
            return true;
          }
          // Neither has · — this might be grouped format
          // text2 is likely the title, text1 could be location or something else
          result.title = text2;
          return false; // No company found yet
        }

        if (!isMetadata(text2)) {
          result.title = text2;
          if (/[\xb7•‧⋅]/.test(text1)) {
            result.company = cleanCompany(text1.split(/[\xb7•‧⋅]/)[0].trim());
          }
          return !!(result.title);
        }
      }

      // Only prev1 available
      if (!isMetadata(text1)) {
        if (/[\xb7•‧⋅]/.test(text1)) {
          result.company = cleanCompany(text1.split(/[\xb7•‧⋅]/)[0].trim());
        } else {
          result.title = text1;
        }
        return !!(result.title || result.company);
      }
    }

    // Alternative: walk up from presentSpan to a list item, then extract text
    var listItem = presentSpan.closest('li');
    if (listItem) {
      return extractFromListItem(listItem, result);
    }

    return false;
  }

  // ── STRATEGY C: List-item based traversal ──
  function strategyListItems(section, result) {
    // Find all top-level list items in the experience section
    var uls = section.querySelectorAll('ul');
    var topUl = null;

    // Get the first UL that's a direct/near descendant of the section
    for (var i = 0; i < uls.length; i++) {
      var parent = uls[i].parentElement;
      var depth = 0;
      while (parent && parent !== section && depth < 5) {
        parent = parent.parentElement;
        depth++;
      }
      if (parent === section) { topUl = uls[i]; break; }
    }

    if (!topUl) return false;

    var items = topUl.querySelectorAll(':scope > li');
    if (items.length === 0) return false;

    // Check first item — is it simple or grouped?
    var firstItem = items[0];

    // Grouped detection: item has nested list items
    var nestedLis = firstItem.querySelectorAll('li');
    var isGrouped = nestedLis.length > 0;

    if (isGrouped) {
      // GROUPED: The top-level text is the company name + duration
      // Sub-items contain individual roles
      var texts = getTextsFromElement(firstItem);

      // First non-metadata text is likely the company name
      for (var i = 0; i < texts.length; i++) {
        if (!isMetadata(texts[i]) && texts[i].search(/[\xb7•‧⋅]/) === -1) {
          result.company = cleanCompany(texts[i]);
          break;
        }
      }

      // Find the sub-entry with "Present" in its date
      for (var n = 0; n < nestedLis.length; n++) {
        var subTexts = getTextsFromElement(nestedLis[n]);
        var hasPresentDate = false;
        for (var s = 0; s < subTexts.length; s++) {
          if (/present/i.test(subTexts[s]) && /\d{4}/.test(subTexts[s])) {
            hasPresentDate = true;
            break;
          }
        }
        if (hasPresentDate) {
          // First non-metadata text in this sub-entry is the job title
          for (var s = 0; s < subTexts.length; s++) {
            if (!isMetadata(subTexts[s]) && subTexts[s] !== result.company) {
              // Skip employment type with ·
              if (/[\xb7•‧⋅]/.test(subTexts[s])) continue;
              result.title = subTexts[s];
              break;
            }
          }
          break;
        }
      }
      return !!(result.title || result.company);
    }

    // SIMPLE: first item has title, company, date directly
    return extractFromListItem(firstItem, result);
  }

  // ── Extract title/company from a single list item ──
  function extractFromListItem(li, result) {
    var texts = getTextsFromElement(li);
    if (texts.length < 2) return false;

    // Classification: find date range (contains year + dash/Present)
    var dateIdx = -1;
    for (var i = 0; i < texts.length; i++) {
      if (isDateRange(texts[i])) { dateIdx = i; break; }
    }

    // Find "company · type" line (contains middot)
    var companyLineIdx = -1;
    for (var i = 0; i < texts.length; i++) {
      if (/[\xb7•‧⋅]/.test(texts[i]) && !isDateRange(texts[i])) {
        companyLineIdx = i;
        break;
      }
    }

    // Title is the first non-metadata text that isn't the company line
    for (var i = 0; i < texts.length; i++) {
      if (i === companyLineIdx) continue;
      if (i === dateIdx) continue;
      if (isMetadata(texts[i])) continue;
      if (!result.title) { result.title = texts[i]; break; }
    }

    // Company from the middot line
    if (companyLineIdx >= 0) {
      result.company = cleanCompany(texts[companyLineIdx].split(/[\xb7•‧⋅]/)[0].trim());
    }

    // If no company found from middot line, look for company link text
    if (!result.company) {
      var compLink = li.querySelector('a[href*="/company/"]');
      if (compLink) {
        var linkText = getVisibleText(compLink);
        if (linkText && !isMetadata(linkText)) {
          result.company = cleanCompany(linkText);
        }
      }
    }

    return !!(result.title || result.company);
  }

  // ── STRATEGY E: innerText-based (most resilient to DOM changes) ──
  // Uses section.innerText which returns only visible text and preserves line breaks.
  // Not dependent on aria-hidden attributes or specific span structures.
  function strategyInnerText(section, result) {
    var raw = section.innerText || '';
    var lines = raw.split('\n')
                   .map(function(s) { return s.trim(); })
                   .filter(function(s) { return s.length > 1 && s.toLowerCase() !== 'experience'; });

    if (lines.length < 3) return false;

    // Find first line with "Present" + year (= current role date)
    var presentIdx = -1;
    for (var i = 0; i < lines.length; i++) {
      if (/present/i.test(lines[i]) && /\d{4}/.test(lines[i])) {
        presentIdx = i;
        break;
      }
    }
    if (presentIdx < 1) return false;

    // Walk backwards from date line, collecting non-metadata lines
    var candidates = [];
    for (var i = presentIdx - 1; i >= 0 && candidates.length < 3; i--) {
      if (!isMetadata(lines[i])) {
        candidates.push(lines[i]);
      }
    }
    if (candidates.length === 0) return false;

    // Broad separator: middot, bullet, dot operator, etc.
    var sepRe = /[\xb7•‧⋅]/;

    if (candidates.length >= 2 && sepRe.test(candidates[0])) {
      // candidates[0] = "Company · Type", candidates[1] = title
      result.company = cleanCompanyBroad(candidates[0], sepRe);
      result.title = candidates[1];
    } else if (candidates.length >= 2 && sepRe.test(candidates[1])) {
      result.title = candidates[0];
      result.company = cleanCompanyBroad(candidates[1], sepRe);
    } else if (candidates.length >= 2) {
      // No separator — first candidate is title, second might be plain company name
      result.title = candidates[0];
      if (candidates[1].length < 60) {
        result.company = candidates[1];
      }
    } else {
      result.title = candidates[0];
    }

    return !!(result.title || result.company);
  }

  function cleanCompanyBroad(text, sepRe) {
    return text.split(sepRe)[0].trim();
  }

  // ── STRATEGY D: Flat text with improved heuristics (last resort) ──
  function strategyFlatText(section, result) {
    var spans = section.querySelectorAll('span[aria-hidden="true"]');
    var texts = [];
    for (var i = 0; i < spans.length; i++) {
      var t = spans[i].textContent.trim();
      if (t && t.length > 1 && t.toLowerCase() !== 'experience') texts.push(t);
    }
    if (texts.length < 3) return false;

    // Find first date range containing "Present"
    var presentIdx = -1;
    for (var i = 0; i < texts.length; i++) {
      if (/present/i.test(texts[i]) && /\d{4}/.test(texts[i])) {
        presentIdx = i;
        break;
      }
    }
    if (presentIdx < 1) return false;

    // Walk backwards from presentIdx to find title and company
    var candidates = [];
    for (var i = presentIdx - 1; i >= 0 && candidates.length < 4; i--) {
      if (!isMetadata(texts[i])) {
        candidates.push(texts[i]);
      }
    }

    if (candidates.length === 0) return false;

    // Check if first candidate has middot (company · type)
    if (candidates.length >= 2 && /[\xb7•‧⋅]/.test(candidates[0])) {
      // candidates[0] = "Company · Full-time", candidates[1] = title
      result.company = cleanCompany(candidates[0].split(/[\xb7•‧⋅]/)[0].trim());
      result.title = candidates[1];
    } else if (candidates.length >= 2 && /[\xb7•‧⋅]/.test(candidates[1])) {
      // candidates[0] = title, candidates[1] = "Company · Full-time"
      result.title = candidates[0];
      result.company = cleanCompany(candidates[1].split(/[\xb7•‧⋅]/)[0].trim());
    } else {
      // No middot found — likely grouped format where title is just before date
      result.title = candidates[0];
      if (candidates.length >= 2) {
        result.company = cleanCompany(candidates[candidates.length - 1]);
      }
    }

    return !!(result.title || result.company);
  }

  // ── Get all visible text spans from an element ──
  function getTextsFromElement(el) {
    var spans = el.querySelectorAll('span[aria-hidden="true"]');
    var texts = [];
    for (var i = 0; i < spans.length; i++) {
      var t = spans[i].textContent.trim();
      if (t && t.length > 1) texts.push(t);
    }
    return texts;
  }

  // ── Clean company name ──
  // Single choke point for every company name any strategy produces.
  // Returns '' rather than a bad guess: an empty Company field forces the SDR to type it
  // in the popup (the Add button stays disabled), whereas a wrong one silently creates a
  // junk Company record in Bigin that nobody notices.
  function cleanCompany(company) {
    if (!company) return '';
    var c = String(company).replace(/\s+/g, ' ').trim();

    // "ITD World Vietnam · Full-time" -> "ITD World Vietnam"
    c = c.split(/[\xb7•‧⋅]/)[0].trim();

    // LinkedIn appends " logo" to logo alt text
    c = c.replace(/\s+logo$/i, '').trim();

    // Trim separators left dangling by the split
    c = c.replace(/^[\s|,\-–—]+/, '').replace(/[\s|,\-–—]+$/, '').trim();

    if (c.length < 2) return '';

    // A company name is never an employment type, a work-mode tag, a date range or a
    // duration. On LinkedIn's GROUPED experience format the line "Full-time · 16 yrs 8 mos"
    // sits exactly where the simple format puts the company name, so without this guard
    // that string becomes the company. This is what produced the "Full-Time" junk record.
    if (isEmploymentType(c) || isLocationType(c) || isDateRange(c) || isDuration(c)) return '';
    if (isMetadata(c)) return '';
    if (isSectionHeader(c)) return '';
    if (/^\d+$/.test(c)) return '';
    if (/^(company|organization|logo)$/i.test(c)) return '';

    return c;
  }

  // Structural read of the company name from the Experience logo anchor.
  // LinkedIn renders each entry's logo inside <a href="/company/{slug}/"> and puts the
  // company name in the anchor's aria-label, the img alt/title, or a visually-hidden span.
  // Reading an attribute is immune to the simple-vs-grouped layout difference that breaks
  // line-based text parsing, so this is tried before any text heuristic.
  function companyFromLogoAnchor(anchor) {
    if (!anchor) return '';
    var candidates = [];
    var aria = anchor.getAttribute('aria-label');
    if (aria) candidates.push(aria);
    var img = anchor.querySelector('img');
    if (img) {
      if (img.getAttribute('alt')) candidates.push(img.getAttribute('alt'));
      if (img.getAttribute('title')) candidates.push(img.getAttribute('title'));
    }
    var hidden = anchor.querySelector('span[aria-hidden="true"], .visually-hidden');
    if (hidden) candidates.push(hidden.textContent);

    for (var i = 0; i < candidates.length; i++) {
      var cleaned = cleanCompany(candidates[i]);
      if (cleaned) return cleaned;
    }
    return '';
  }

  // Last resort: the headline usually reads "Title at Company". Cut at the first pipe so
  // "NVCS | Taxes - Law - M&A - IP" stores as "NVCS" rather than the whole sentence.
  function companyFromHeadlineFallback() {
    var parsed = parseHeadline(scrapeHeadline());
    if (!parsed || !parsed.company) return '';
    return cleanCompany(parsed.company.split('|')[0]);
  }

  // Company precedence: structural DOM > text parsing > headline. Applied on every exit
  // path of scrapeCurrentExperience so no strategy can bypass validation.
  function finalizeCompany(result, companyLink) {
    var fromAnchor = companyFromLogoAnchor(companyLink);
    var fromStrategy = cleanCompany(result.company);
    result.company = fromAnchor || fromStrategy || companyFromHeadlineFallback() || '';
    return result;
  }

  // ── SCROLL TO LOAD EXPERIENCE ──
  // LinkedIn lazy-loads sections below the fold. If Experience isn't in the DOM,
  // scroll down in steps to trigger the intersection observer, then scroll back.
  function ensureExperienceLoaded(callback) {
    var section = findSectionByH2('Experience');
    if (section) { callback(); return; }

    var expById = document.querySelector('#experience')
                || document.querySelector('section[id="experience"]');
    if (expById) { callback(); return; }

    var originalScroll = window.scrollY;
    var attempts = 0;
    var maxAttempts = 6;
    var scrollStep = 800;

    function tryScroll() {
      attempts++;
      // Scroll to position — use both methods for reliability
      var target = scrollStep * attempts;
      window.scrollTo(0, target);
      // Also try scrolling the document element directly
      document.documentElement.scrollTop = target;
      document.body.scrollTop = target;

      setTimeout(function() {
        var found = findSectionByH2('Experience')
                 || document.querySelector('#experience')
                 || document.querySelector('section[id="experience"]');
        if (found || attempts >= maxAttempts) {
          window.scrollTo(0, originalScroll);
          document.documentElement.scrollTop = originalScroll;
          setTimeout(callback, 500);
        } else {
          tryScroll();
        }
      }, 700);
    }

    tryScroll();
  }

  // ── COMPANY NAME FROM TOP CARD ──
  // Profile card shows current company with a link (e.g., "Planisware" with /company/ href).
  // This is the MOST RELIABLE company source — always visible, not lazy-loaded.
  function scrapeCompanyNameFromTopCard() {
    var section = getProfileCardSection();
    // Try profile card section first, then full document
    var searchAreas = section ? [section, document] : [document];

    // Strategy 1: /company/ link
    for (var a = 0; a < searchAreas.length; a++) {
      var link = searchAreas[a].querySelector('a[href*="/company/"]');
      if (link) {
        var text = getVisibleText(link);
        if (text && text.length > 1 && !isMetadata(text)) return text;
        var directText = link.textContent.trim().replace(/\s+/g, ' ');
        if (directText && directText.length > 1 && directText.length < 100) return directText;
      }
    }

    // Strategy 2: img alt text in profile card (LinkedIn renders company logos with alt text)
    // The intro card shows company/education items as: [logo img] + text
    // Skip profile photo, school logos, and generic images
    if (section) {
      var imgs = section.querySelectorAll('img');
      for (var i = 0; i < imgs.length; i++) {
        var alt = (imgs[i].alt || '').trim();
        if (!alt || alt.length < 2 || alt.length > 80) continue;
        // Skip profile photos
        if (/photo|profile|avatar|headshot/i.test(alt)) continue;
        // Skip decorative/generic images
        if (/banner|background|cover|badge|icon|open.to/i.test(alt)) continue;

        // Check if this img is inside a school link — skip education items
        var parentLink = imgs[i].closest('a');
        if (parentLink && /\/school\//.test(parentLink.href || '')) continue;

        // Clean prefixes/suffixes: "View company: X", "X logo", etc.
        var name = alt
          .replace(/^view\s+company[:\s]+/i, '')
          .replace(/\s*logo\s*$/i, '')
          .trim();
        if (name.length >= 2 && !isMetadata(name)) return name;
      }
    }

    // Strategy 3: buttons or links in profile card with company-like text
    // LinkedIn sometimes renders company items as buttons, not links
    if (section) {
      var btns = section.querySelectorAll('button[aria-label]');
      for (var i = 0; i < btns.length; i++) {
        var label = btns[i].getAttribute('aria-label') || '';
        // Look for "Current company: NIHONCASI" pattern
        var compMatch = label.match(/current\s+company[:\s]+(.+)/i);
        if (compMatch) return compMatch[1].trim();
      }
    }

    return '';
  }

  // ── COMPANY URL FROM TOP CARD ──
  function scrapeCompanyUrlFromTopCard() {
    var section = getProfileCardSection();
    var searchAreas = section ? [section, document] : [document];
    for (var a = 0; a < searchAreas.length; a++) {
      var link = searchAreas[a].querySelector('a[href*="/company/"]');
      if (link) {
        var slug = extractCompanySlug(link.href);
        if (slug) return 'https://www.linkedin.com/company/' + slug + '/';
      }
    }
    return '';
  }

  // ABOUT
  function scrapeAbout() {
    var section = findSectionByH2('About');
    if (!section) {
      var aboutEl = document.querySelector('#about');
      if (aboutEl) section = aboutEl.closest('section') || aboutEl;
    }
    if (!section) return '';
    var spans = section.querySelectorAll('span[aria-hidden="true"]');
    for (var i = 0; i < spans.length; i++) {
      var t = spans[i].textContent.trim();
      if (t.length > 30 && t.toLowerCase() !== 'about') return t.substring(0, 500);
    }
    var fullText = section.textContent.trim();
    var cleaned = fullText.replace(/^About\s*/i, '').replace(/\s*\.{3}\s*see more\s*$/i, '').trim();
    if (cleaned.length > 30) return cleaned.substring(0, 500);
    return '';
  }

  // WORK LOCATION (from current Experience entry)
  // Structure: <p>Date - Present · duration</p> <p>Location</p> are siblings
  function scrapeWorkLocation() {
    var section = findSectionByH2('Experience');
    if (!section) {
      var expEl = document.querySelector('#experience')
                || document.querySelector('section[id="experience"]');
      if (expEl) section = expEl.closest('section') || expEl;
    }
    if (!section) return '';

    var ps = section.querySelectorAll('p');
    for (var i = 0; i < ps.length; i++) {
      var text = ps[i].textContent.trim();
      // Find date range containing "Present" (= current job)
      if (/present/i.test(text) && /\d{4}/.test(text)) {
        // Next sibling <p> is the work location
        var next = ps[i].nextElementSibling;
        if (next && next.tagName === 'P') {
          var locText = next.textContent.trim().replace(/\s+/g, ' ');
          if (locText.length < 2 || locText.length > 100) continue;
          // Skip if it's another date, skills, or metadata
          if (/\d{4}/.test(locText)) continue;
          if (/skill/i.test(locText)) continue;
          if (/^(See|Show)\s/i.test(locText)) continue;
          // Strip location type suffix: "Ho Chi Minh City, Vietnam · On-site"
          locText = locText.split(/\s*[\xb7•‧⋅·]\s*/)[0].trim();
          if (locText.length >= 2) return locText;
        }
      }
    }
    return '';
  }

  // MAIN SCRAPE
  // ── GUARD: reject obviously-garbage company strings ──
  // When the Experience section is only half lazy-loaded, some strategies return a
  // truthy-but-wrong value (e.g. "GoogleSoftware Development42,318,599" — concatenated
  // sidebar/analytics text). A wrong-but-non-empty value would otherwise win the
  // precedence chain over the reliable, always-visible top-card source, so filter it
  // out first. Kept deliberately loose so real names with a digit or two survive
  // (3M, 7-Eleven, 23andMe, E*TRADE): only long digit runs / money-style numbers /
  // paragraph-length or multi-line blobs are rejected.
  function isValidCompany(str) {
    if (!str) return false;
    var s = String(str).trim();
    if (s.length < 2 || s.length > 100) return false;   // too short, or paragraph-length junk
    if (/[\r\n]/.test(s)) return false;                 // multi-line = a scraped block, not a name
    if (/\d{4,}/.test(s)) return false;                 // 4+ digit run = counts/IDs, never a name
    if (/\d{1,3}(,\d{3})+/.test(s)) return false;       // comma-grouped thousands e.g. 42,318,599
    if (/^(full-time|part-time|contract|internship|freelance|self-employed)$/i.test(s)) return false;
    return true;
  }

  function scrapeProfile() {
    var nameData = scrapeName();
    var headline = scrapeHeadline();
    var parsed = parseHeadline(headline);
    var loc = scrapeLocation();
    var exp = scrapeCurrentExperience();
    var companyUrlTopCard = scrapeCompanyUrlFromTopCard();
    var companyNameTopCard = scrapeCompanyNameFromTopCard();
    var title = exp.title || parsed.title;
    // Company precedence WITH garbage-guard: prefer the current-role company from a fully
    // loaded Experience section, but if that value is missing OR fails validation, fall
    // back to the always-visible top-card company, then the headline parse. Filtering at
    // each tier means a half-loaded DOM yields a blank (SDR fills it) instead of garbage.
    var validExp = isValidCompany(exp.company) ? exp.company : '';
    var validTop = isValidCompany(companyNameTopCard) ? companyNameTopCard : '';
    var validHl  = isValidCompany(parsed.company) ? parsed.company : '';
    var company = validExp || validTop || validHl || '';
    // If company came from the headline parser (not structured Experience/top-card),
    // truncate at the first pipe so "NVCS | Taxes - Law - M&A" stores as "NVCS".
    if (!validExp && !validTop && company && company.indexOf('|') > -1) {
      company = company.split('|')[0].trim();
    }
    var companyLinkedInUrl = exp.companyUrl || companyUrlTopCard;
    var workLoc = scrapeWorkLocation();
    var locationParts = loc.split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0; });
    var country = '';
    var city = '';
    var state = '';
    if (locationParts.length === 1) {
      // Single-word location like "India", "Vietnam", "Singapore" - treat as country
      country = locationParts[0];
    } else if (locationParts.length === 2) {
      // "Ho Chi Minh City, Vietnam" - city + country
      city = locationParts[0];
      country = locationParts[1];
    } else if (locationParts.length >= 3) {
      // "District 1, Ho Chi Minh City, Vietnam" - city + state + country
      city = locationParts[0];
      state = locationParts[1];
      country = locationParts[locationParts.length - 1];
    }

    // Clean "Title at Company" pattern from title
    if (title && /\s+(?:at|@)\s+/i.test(title)) {
      var m = title.match(/^(.+?)\s+(?:at|@)\s+(.+)$/i);
      if (m) {
        title = m[1].trim();
        if (!company && isValidCompany(m[2].trim())) company = m[2].trim();
      }
    }

    return {
      profileUrl: normalizeLinkedInUrl(window.location.href),
      firstName: nameData.firstName,
      lastName: nameData.lastName,
      fullName: (nameData.firstName + ' ' + nameData.lastName).trim(),
      headline: headline,
      title: title,
      company: company,
      companyLinkedInUrl: companyLinkedInUrl,
      location: loc,
      city: city,
      state: state,
      country: country,
      workLocation: workLoc,
      about: scrapeAbout(),
      scrapedAt: new Date().toISOString()
    };
  }

  // MESSAGE LISTENER
  chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
    if (msg.action === 'scrapeProfile') {
      try {
        // Ensure Experience section is loaded before scraping
        ensureExperienceLoaded(function() {
          try {
            var data = scrapeProfile();
            sendResponse({ success: true, data: data });
          } catch (err) {
            sendResponse({ success: false, error: err.message });
          }
        });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true; // async response
    }
  });

  // AUTO-SCRAPE
  function autoScrape() {
    try {
      var data = scrapeProfile();
      chrome.storage.local.set({ lastScrapedProfile: data });
    } catch (e) { /* silent */ }
  }

  var scrapeTimer = null;
  var observer = new MutationObserver(function() {
    clearTimeout(scrapeTimer);
    scrapeTimer = setTimeout(autoScrape, 1500);
  });

  setTimeout(function() {
    autoScrape();
    observer.observe(document.body, { childList: true, subtree: true });
  }, 2000);

  var lastUrl = location.href;
  setInterval(function() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (/\/in\//.test(lastUrl)) {
        setTimeout(autoScrape, 2000);
      }
    }
  }, 1000);

})();
