// RedInk Background Service Worker (Milestone 3 implementation)
// Handles offscreen document lifecycle, receiving transcripts, calling the Featherless LLM,
// deduplicating claims, and broadcasting verdicts to the active/target tab.
// Adheres to ponytail principles: minimal, zero dependencies, vanilla JS.

const SYSTEM_PROMPT = `Fast fact-checker. Given transcript + Video Date, extract claims and judge AS OF that date.
BE DECISIVE. Pick CONFIRMED/MOSTLY TRUE/FALSE/MISLEADING. Only use UNVERIFIED for truly obscure stats.
Skip opinions and greetings. 1-sentence explanations.
JSON only: {"findings":[{"claim":"","speaker":"","verdict":"","explanation":""}]}
Empty array if nothing checkable.`;

// ponytail: Simple in-memory deduplication cache.
// Ceiling: 100 entries. Upgrade path: persistent IndexedDB cache or Chrome storage if session persistence is needed.
const MAX_CACHE_SIZE = 100;
const sentenceCache = [];
const claimCache = [];

let targetTabId = null;
let pendingStreamId = null;

// ponytail: Buffer sentences so the LLM gets full ideas, not fragments.
const transcriptBuffer = [];
let bufferFlushTimer = null;
const BUFFER_SIZE = 2;     // sentences before flush (fast for demo)
const BUFFER_TIMEOUT = 3000; // ms of silence before flush

async function logToTab(msg, type = 'info') {
  const logMsg = `[Background] ${msg}`;
  if (type === 'error') {
    console.error(logMsg);
  } else if (type === 'warn') {
    console.warn(logMsg);
  } else {
    console.log(logMsg);
  }
  
  // ponytail: append to session_logs in storage so content.js picks it up via storage.onChanged
  try {
    const res = await chrome.storage.local.get(['session_logs']);
    const logs = res.session_logs || [];
    logs.push({ msg: logMsg, type });
    // Cap at 200 entries to avoid storage bloat
    if (logs.length > 200) logs.splice(0, logs.length - 200);
    await chrome.storage.local.set({ session_logs: logs });
  } catch (err) {
    // Suppress storage errors
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  logToTab(`Received message: ${message.action}`);
  if (message.action === 'startSession') {
    handleStartSession(message.streamId, message.tabId, sendResponse);
    return true; // Keep message channel open for async response
  } else if (message.action === 'stopSession') {
    handleStopSession(sendResponse);
    return true; // Keep message channel open for async response
  } else if (message.action === 'transcription') {
    logToTab(`Received transcription segment from offscreen: ${JSON.stringify(message.data)}`);
    handleTranscription(message.data);
  } else if (message.action === 'captureError') {
    logToTab(`Capture error in offscreen document: ${message.error}`, 'error');
    handleStopSession(() => {});
  } else if (message.action === 'offscreenLog') {
    logToTab(`[Offscreen] ${message.data.msg}`, message.data.type);
  } else if (message.action === 'offscreenReady') {
    logToTab('Offscreen document ready. Sending init parameters.');
    handleOffscreenReady();
  }
});

async function handleOffscreenReady() {
  const storage = await chrome.storage.local.get(['deepgram_key']);
  const apiKey = storage.deepgram_key || '';
  if (!apiKey) {
    logToTab('Enter your Deepgram API key in the extension popup.', 'error');
    return;
  }
  
  if (pendingStreamId) {
    logToTab(`Sending initAudioCapture to offscreen with stream: ${pendingStreamId}`);
    chrome.runtime.sendMessage({
      action: 'initAudioCapture',
      data: {
        streamId: pendingStreamId,
        apiKey: apiKey
      }
    }).catch(err => {
      logToTab(`Error sending initAudioCapture: ${err.message}`, 'error');
    });
  } else {
    logToTab('No pendingStreamId found during offscreenReady handshake', 'warn');
  }
}

async function handleStartSession(streamId, tabId, sendResponse) {
  logToTab(`handleStartSession called for tab: ${tabId} with stream: ${streamId}`);
  if (!streamId || !tabId) {
    logToTab('startSession failed: missing parameters', 'error');
    sendResponse({ success: false, error: 'Missing streamId or tabId' });
    return;
  }
  try {
    targetTabId = tabId;
    pendingStreamId = streamId;
    
    if (await hasOffscreenDocument()) {
      logToTab('Closing existing offscreen document');
      await chrome.offscreen.closeDocument();
    }
    
    logToTab('Creating offscreen document (no query parameters)');
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Capturing tab audio for live transcription'
    });

    logToTab('Offscreen document creation initiated');
    sendResponse({ success: true });
  } catch (err) {
    logToTab(`Failed to start offscreen session: ${err.message}`, 'error');
    sendResponse({ success: false, error: err.message });
  }
}

async function handleStopSession(sendResponse) {
  try {
    targetTabId = null;
    if (await hasOffscreenDocument()) {
      try {
        await chrome.runtime.sendMessage({ action: 'stopCapture' });
      } catch (err) {
        console.warn('Error sending stopCapture to offscreen document:', err);
      }
      await chrome.offscreen.closeDocument();
    }
    await chrome.storage.local.set({ session_active: false });
    sendResponse({ success: true });
  } catch (err) {
    console.error('Failed to stop offscreen session:', err);
    sendResponse({ success: false, error: err.message });
  }
}

async function hasOffscreenDocument() {
  if ('getContexts' in chrome.runtime) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    return contexts.length > 0;
  }
  // Fallback for context matching
  const clientsList = await clients.matchAll({ type: 'window' });
  return clientsList.some(client => client.url.includes('offscreen.html'));
}

function isDuplicateSentence(text) {
  const clean = text.trim().toLowerCase();
  if (sentenceCache.includes(clean)) return true;
  sentenceCache.push(clean);
  if (sentenceCache.length > MAX_CACHE_SIZE) {
    sentenceCache.shift();
  }
  return false;
}

// targetContent to be replaced in the future / or checked during claim deduplication:
function isDuplicateClaim(claim) {
  if (!claim) return true;
  const clean = claim.trim().toLowerCase();
  if (claimCache.includes(clean)) return true;
  claimCache.push(clean);
  if (claimCache.length > MAX_CACHE_SIZE) {
    claimCache.shift();
  }
  return false;
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function handleTranscription(data) {
  const text = data.text || '';
  if (!text || !text.trim()) return;
  const speaker = data.speaker;

  // 1. Deduplication Cache Check (Sentence Level)
  if (isDuplicateSentence(text)) {
    return;
  }

  const speakerLabel = speaker !== null && speaker !== undefined ? `Speaker ${speaker}` : 'Speaker';
  transcriptBuffer.push({ text, speaker: speakerLabel });
  logToTab(`Buffered sentence (${transcriptBuffer.length}/${BUFFER_SIZE}): "${text}"`);

  // Reset the flush timer on each new sentence
  if (bufferFlushTimer) clearTimeout(bufferFlushTimer);
  bufferFlushTimer = setTimeout(() => {
    if (transcriptBuffer.length > 0) {
      logToTab('Buffer flush timer triggered.');
      flushTranscriptBuffer();
    }
  }, BUFFER_TIMEOUT);

  // Flush when buffer is full
  if (transcriptBuffer.length >= BUFFER_SIZE) {
    flushTranscriptBuffer();
  }
}

async function flushTranscriptBuffer() {
  if (transcriptBuffer.length === 0) return;
  if (bufferFlushTimer) { clearTimeout(bufferFlushTimer); bufferFlushTimer = null; }

  // Drain the buffer
  const batch = transcriptBuffer.splice(0);
  const combinedText = batch.map(s => `[${s.speaker}]: ${s.text}`).join('\n');
  const fallbackSpeaker = batch[0].speaker;

  logToTab(`Flushing ${batch.length} sentences to LLM.`);

  // Retrieve credentials, model, and video date
  const storage = await chrome.storage.local.get(['featherless_key', 'model_name', 'video_date']);
  const featherlessKey = storage.featherless_key || '';
  if (!featherlessKey) {
    logToTab('Enter your Featherless API key in the extension popup.', 'error');
    return;
  }
  const model = storage.model_name || 'Qwen/Qwen2.5-3B-Instruct';
  const videoDate = storage.video_date || 'Unknown';

  const userContent = `Video Date: ${videoDate}\n\nTranscript:\n${combinedText}`;

  try {
    logToTab(`Calling Featherless API. Model: ${model}`);
    const response = await fetch('https://api.featherless.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${featherlessKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
        max_tokens: 300
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content;
    logToTab(`Featherless API raw response content: ${content}`);
    if (!content) return;

    // ponytail: Simple regex-based cleanup for LLM markdown wrappers.
    let cleanContent = content.trim();
    if (cleanContent.startsWith('```')) {
      cleanContent = cleanContent.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const jsonMatch = cleanContent.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      cleanContent = jsonMatch[0];
    }

    const parsed = JSON.parse(cleanContent.trim());
    const findings = parsed.findings;

    if (!Array.isArray(findings)) {
      logToTab(`LLM output findings is not an array: ${JSON.stringify(findings)}`, 'warn');
      return;
    }

    // Save claims in local storage
    const storageVerdicts = await chrome.storage.local.get(['session_verdicts']);
    const verdictsList = storageVerdicts.session_verdicts || [];

    for (const finding of findings) {
      // ponytail: skip fragments — real claims are at least 5 words
      if (!finding.claim || finding.claim.split(/\s+/).length < 5) continue;
      if (isDuplicateClaim(finding.claim)) continue;
      if (!finding.speaker) finding.speaker = fallbackSpeaker;
      verdictsList.push(finding);
      logToTab(`Saving verdict: ${JSON.stringify(finding)}`);
    }
    await chrome.storage.local.set({ session_verdicts: verdictsList });
  } catch (error) {
    logToTab(`Error during fact-checking request: ${error.message}`, 'error');
  }
}
