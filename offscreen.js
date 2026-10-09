// RedInk Offscreen Audio Capture & Deepgram Streaming
// Adheres to ponytail principles: minimal, no external libraries, vanilla JS.

function logToBackground(msg, type = 'info') {
  const logMsg = `[Offscreen] ${msg}`;
  if (type === 'error') {
    console.error(logMsg);
  } else if (type === 'warn') {
    console.warn(logMsg);
  } else {
    console.log(logMsg);
  }
  chrome.runtime.sendMessage({
    action: 'offscreenLog',
    data: { msg, type }
  }).catch(() => {});
}

// Notify background that offscreen page is loaded and ready (ponytail: handshake bypasses offscreen URL query string limitations)
logToBackground('Offscreen script loaded. Reporting ready to background.');
chrome.runtime.sendMessage({ action: 'offscreenReady' }).catch(() => {});

// Listen for initialization parameters from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'initAudioCapture') {
    logToBackground('Received initAudioCapture parameters from background.');
    const { streamId, apiKey } = message.data;
    initialize(streamId, apiKey);
  }
});

async function initialize(streamId, apiKey) {
  try {
    logToBackground(`Initializing tab audio capture for stream: ${streamId}`);

    // 2. Obtain Tab Capture audio stream using streamId
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });

    logToBackground(`getUserMedia successfully captured the stream: ${stream.id}`);

    // 3. Play captured audio back to the user so the tab is not muted
    // ponytail: Simple audio context destination mapping. Ceiling: Tab audio is played back to the default system output. Upgrade path: Let the user select the audio playback device.
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(audioContext.destination);

    logToBackground('AudioContext initialized and loopback connected.');

    // 4. Establish WebSocket connection to Deepgram
    // ponytail: authenticate via Sec-WebSocket-Protocol because custom headers cannot be set in browser WebSockets, and token query param is not supported.
    const wsUrl = 'wss://api.deepgram.com/v1/listen?smart_format=true&diarize=true&interim_results=true';
    logToBackground('Connecting to Deepgram WebSocket...');
    const socket = new WebSocket(wsUrl, ['token', apiKey]);

    // 5. Initialize MediaRecorder
    logToBackground('Initializing MediaRecorder');
    const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

    // Sentence extraction state
    let accumulatedWords = [];
    let currentSpeaker = null;
    let silenceTimer = null;
    let isIntentionalStop = false;

    const finalizeSentence = () => {
      if (accumulatedWords.length === 0) return;

      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }

      const sentenceText = accumulatedWords
        .map(w => w.punctuated_word || w.word)
        .join(' ')
        .trim();

      if (sentenceText) {
        logToBackground(`Sending sentence to background: "${sentenceText}" speaker: ${currentSpeaker}`);
        chrome.runtime.sendMessage({
          action: 'transcription',
          data: {
            text: sentenceText,
            speaker: currentSpeaker
          }
        });
      }

      accumulatedWords = [];
      currentSpeaker = null;
    };

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === 'stopCapture') {
        isIntentionalStop = true;
        finalizeSentence();
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.close();
        }
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
          mediaRecorder.stop();
        }
        sendResponse({ success: true });
        return true;
      }
    });

    // ponytail: Simple silence detection. Ceiling: 2s static timeout. Upgrade path: Adaptive silence thresholds based on audio volume/energy.
    const resetSilenceTimer = () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        if (accumulatedWords.length > 0) {
          logToBackground('Silence timeout reached. Finalizing sentence.');
          finalizeSentence();
        }
      }, 2000);
    };

    socket.onopen = () => {
      logToBackground('Connected to Deepgram WebSocket successfully');
      mediaRecorder.start(250); // Send data chunks every 250ms
      logToBackground('MediaRecorder started capturing chunks');
    };

    socket.onmessage = (event) => {
      const response = JSON.parse(event.data);
      
      // Log transcript if present (interim or final)
      const transcript = response.channel?.alternatives?.[0]?.transcript;
      if (transcript) {
        logToBackground(`Deepgram transcript chunk: "${transcript}" (is_final: ${response.is_final})`);
      }

      const isFinal = response.is_final;
      const speechFinal = response.speech_final;

      if (isFinal) {
        const words = response.channel?.alternatives?.[0]?.words || [];
        if (words.length > 0) {
          for (const wordObj of words) {
            const wordText = wordObj.punctuated_word || wordObj.word;
            const speaker = wordObj.speaker ?? 0;

            // Finalize current segment if speaker changes
            if (accumulatedWords.length > 0 && currentSpeaker !== speaker) {
              finalizeSentence();
            }

            currentSpeaker = speaker;
            accumulatedWords.push(wordObj);

            // ponytail: Simple regex sentence splitting. Ceiling: English punctuation (.?!). Upgrade path: Multilingual NLP sentence segmenter.
            if (/[.?!]/.test(wordText)) {
              finalizeSentence();
            }
          }
          resetSilenceTimer();
        }

        // Finalize if Deepgram signals end of speech
        if (speechFinal && accumulatedWords.length > 0) {
          finalizeSentence();
        }
      }
    };

    socket.onerror = (err) => {
      logToBackground('Deepgram WebSocket error occurred (details are usually sent via close event).', 'error');
    };

    socket.onclose = (event) => {
      logToBackground(`Deepgram WebSocket closed. Code: ${event.code}, Reason: ${event.reason || 'None'}, WasClean: ${event.wasClean}`, 'warn');
      if (mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
      }
      if (!isIntentionalStop) {
        chrome.runtime.sendMessage({
          action: 'captureError',
          error: `Deepgram WebSocket closed: Code ${event.code} (${event.reason || 'No reason provided'})`
        });
      }
    };

    let chunksSent = 0;
    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0 && socket.readyState === WebSocket.OPEN) {
        socket.send(event.data);
        chunksSent++;
        if (chunksSent % 20 === 0) { // Log every 5 seconds (20 * 250ms = 5s)
          logToBackground(`Sent audio chunk batch to Deepgram. Total chunks sent: ${chunksSent}`);
        }
      }
    };

    mediaRecorder.onstop = () => {
      // Release tab capture tracks to stop the browser's recording indicator
      stream.getTracks().forEach(track => track.stop());
      audioContext.close();
    };

  } catch (err) {
    logToBackground(`Failed to initialize offscreen capture: ${err.message}`, 'error');
    chrome.runtime.sendMessage({
      action: 'captureError',
      error: err.message
    });
  }
}
