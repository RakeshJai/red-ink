// RedInk Content Script (Milestone 4 Implementation)
// Injects the newspaper-themed sidebar via Shadow DOM and listens for verdicts from background.js.
// Adheres to ponytail principles: clean, vanilla JS, minimal DOM footprint.

(function () {
  // Prevent duplicate injections
  if (document.getElementById('redink-sidebar-container')) {
    return;
  }

  function init() {
    console.log('[RedInk Content Script] Injected and initializing sidebar DOM.');

    // ponytail: clear stale verdicts on page load so refresh = clean slate
    chrome.storage.local.set({ session_verdicts: [], session_logs: [] });

    // Scrape video upload date from YouTube page and store for LLM context
    const dateEl = document.querySelector('#info-strings yt-formatted-string') ||
                   document.querySelector('span.style-scope.yt-formatted-string[style-target="bold"]') ||
                   document.querySelector('#info-strings span');
    const videoDate = dateEl?.textContent?.trim() || '';
    if (videoDate) {
      chrome.storage.local.set({ video_date: videoDate });
    }

    const container = document.createElement('div');
    container.id = 'redink-sidebar-container';
    document.body.appendChild(container);

    const shadow = container.attachShadow({ mode: 'open' });

    // 1. Fetch and inject styles dynamically
    const styleTag = document.createElement('style');
    shadow.appendChild(styleTag);

    fetch(chrome.runtime.getURL('content.css'))
      .then(response => {
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        return response.text();
      })
      .then(cssText => {
        styleTag.textContent = cssText;
      })
      .catch(err => {
        console.error('[RedInk] Failed to load content.css:', err);
      });

    // 2. Create the DOM structure
    const wrapper = document.createElement('div');
    wrapper.className = 'redink-wrapper collapsed';

    const foldedCorner = document.createElement('button');
    foldedCorner.className = 'redink-folded-corner';
    foldedCorner.setAttribute('aria-label', 'Toggle RedInk Sidebar');
    foldedCorner.addEventListener('click', () => {
      if (wrapper.classList.contains('collapsed')) {
        wrapper.classList.remove('collapsed');
        wrapper.classList.add('expanded');
      } else {
        wrapper.classList.remove('expanded');
        wrapper.classList.add('collapsed');
      }
    });

    const sidebar = document.createElement('div');
    sidebar.className = 'redink-sidebar';

    const masthead = document.createElement('div');
    masthead.className = 'redink-masthead';

    const title = document.createElement('h1');
    title.textContent = 'THE RED INK';

    const subtitle = document.createElement('div');
    subtitle.className = 'redink-subtitle';
    subtitle.textContent = 'Real-Time Fact-Checking';

    masthead.appendChild(title);
    masthead.appendChild(subtitle);

    const claimsList = document.createElement('div');
    claimsList.className = 'redink-claims-list';

    sidebar.appendChild(masthead);
    sidebar.appendChild(claimsList);

    wrapper.appendChild(foldedCorner);
    wrapper.appendChild(sidebar);
    shadow.appendChild(wrapper);

    function renderClaimCard(data) {
      if (!data) return;
      const claimText = (data.claim && typeof data.claim === 'string') ? data.claim.trim() : '';
      const explanationText = (data.explanation && typeof data.explanation === 'string') ? data.explanation.trim() : '';

      // Create the card element
      const card = document.createElement('div');
      card.className = 'redink-card';

      // News-style bold headline from the claim text
      const headline = document.createElement('h3');
      headline.className = 'redink-claim';
      headline.textContent = `“${claimText}”`;

      // Italic speaker byline
      const byline = document.createElement('div');
      byline.className = 'redink-byline';
      byline.textContent = `By ${data.speaker || 'Unknown Speaker'}`;

      // Body explanation (the first-letter drop-cap is styled natively via CSS)
      const explanation = document.createElement('p');
      explanation.className = 'redink-explanation';
      explanation.textContent = explanationText;

      // Rotated verdict stamp overlay
      const stamp = document.createElement('div');
      const verdictStr = (data.verdict || 'UNVERIFIED').toUpperCase();
      const verdictClass = verdictStr.toLowerCase().replace(/\s+/g, '-');
      stamp.className = `redink-stamp ${verdictClass}`;
      stamp.textContent = verdictStr;

      card.appendChild(headline);
      card.appendChild(byline);
      card.appendChild(explanation);
      card.appendChild(stamp);

      // Prepend so the latest claims appear at the top
      claimsList.prepend(card);
    }

    // 3. Load initial session verdicts from storage (ponytail: state persistence across page refreshes)
    chrome.storage.local.get(['session_verdicts', 'session_logs'], (res) => {
      const verdicts = res.session_verdicts || [];
      verdicts.forEach(renderClaimCard);

      const logs = res.session_logs || [];
      for (const logItem of logs) {
        if (logItem.type === 'error') {
          console.error(logItem.msg);
        } else if (logItem.type === 'warn') {
          console.warn(logItem.msg);
        } else {
          console.log(logItem.msg);
        }
      }
    });

    // 4. Listen for storage updates (ponytail: storage event acts as the messaging bus to bypass MV3 tabCapture messaging boundaries)
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local') {
        if (changes.session_verdicts) {
          const newVerdicts = changes.session_verdicts.newValue || [];
          const oldVerdicts = changes.session_verdicts.oldValue || [];
          const added = newVerdicts.slice(oldVerdicts.length);
          added.forEach(renderClaimCard);
        }
        if (changes.session_logs) {
          const newLogs = changes.session_logs.newValue || [];
          const oldLogs = changes.session_logs.oldValue || [];
          const added = newLogs.slice(oldLogs.length);
          for (const logItem of added) {
            if (logItem.type === 'error') {
              console.error(logItem.msg);
            } else if (logItem.type === 'warn') {
              console.warn(logItem.msg);
            } else {
              console.log(logItem.msg);
            }
          }
        }
      }
    });
  }

  // Handle document loading states
  if (document.body) {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
