/*
 * Silver Browser — Alfred Content Script (v10)
 *
 * Fixes over v9:
 * - Stop/interrupt works during conversation without false positives
 * - Scroll/zoom/nav local commands give feedback
 * - Language auto-detect requires strong evidence before switching
 * - Same-hostname link filter only applies on search pages
 * - extractText safe against SVG className objects
 * - go back/forward/refresh local commands
 * - Read-aloud chunks use cancel→speak delay fix
 */
(function() {
  if (document.getElementById('silver-float')) return;

  // ═══════════ STATE ═══════════
  var listening = false;
  var speaking = false;
  var speakCooldown = false;   // blocks mic restart briefly after TTS ends
  var isReading = false;
  var conversationActive = false;
  var processing = false;      // waiting for Claude response
  var lang = 'en';
  var rec = null;
  var recBusy = false;         // prevents double rec.start()
  var sizeLevel = 0;
  var contrastOn = false;
  var clickables = [];
  var history = [];
  var convoTimer = null;
  var hideTimer = null;
  var errorStreak = 0;         // consecutive recognition errors
  var micBtn, statusEl, tagEl, waveEl, readingEl;
  var lastRecActivity = 0;   // timestamp of last recognition event (watchdog)
  var tabIsActive = !document.hidden;

  try { chrome.storage.local.get(['lang', 'alfredOn'], function(r) {
    if (r && r.lang) lang = r.lang;
    if (r && r.alfredOn) setTimeout(function() { if (!listening) startListening(); }, 600);
  }); } catch(e) {}

  document.addEventListener('visibilitychange', function() {
    tabIsActive = !document.hidden;
    if (!tabIsActive && rec) { try { rec.abort(); } catch(e) {} rec = null; recBusy = false; }
    if (tabIsActive && listening && !speaking && !speakCooldown && !rec) {
      setTimeout(beginRec, 400);
    }
  });

  function send(msg, cb) {
    try { chrome.runtime.sendMessage(msg, function(r) {
      if (chrome.runtime.lastError) { if (cb) cb(null); return; }
      if (cb) cb(r);
    }); } catch(e) { if (cb) cb(null); }
  }

  // ═══════════ UI ═══════════
  function injectUI() {
    if (!document.body) return;
    if (!document.getElementById('silver-css')) {
      var s = document.createElement('style'); s.id = 'silver-css';
      s.textContent =
        '#silver-float{position:fixed!important;bottom:24px!important;right:24px!important;z-index:2147483647!important;display:flex!important;flex-direction:column!important;align-items:flex-end!important;gap:8px!important;font-family:-apple-system,Segoe UI,Arial,sans-serif!important}' +
        '#silver-status{background:#1a365d!important;color:#fff!important;border-radius:14px!important;padding:14px 18px!important;max-width:380px!important;font-size:16px!important;line-height:1.5!important;box-shadow:0 6px 28px rgba(0,0,0,.35)!important;display:none!important;word-break:break-word!important;white-space:pre-wrap!important}' +
        '#silver-status.show{display:block!important}' +
        '#silver-wave{display:none!important;gap:3px!important;align-items:center!important;justify-content:center!important;height:36px!important;padding:6px 20px!important;background:#553C9A!important;border-radius:18px!important;box-shadow:0 4px 16px rgba(85,60,154,.4)!important}' +
        '#silver-wave.active{display:flex!important}' +
        '.silver-bar{width:4px!important;border-radius:2px!important;background:#fff!important;transform-origin:center!important;animation:silver-w .7s ease-in-out infinite!important}' +
        '.silver-bar:nth-child(1){height:10px!important;animation-delay:0s!important}' +
        '.silver-bar:nth-child(2){height:16px!important;animation-delay:.08s!important}' +
        '.silver-bar:nth-child(3){height:22px!important;animation-delay:.16s!important}' +
        '.silver-bar:nth-child(4){height:28px!important;animation-delay:.24s!important}' +
        '.silver-bar:nth-child(5){height:22px!important;animation-delay:.32s!important}' +
        '.silver-bar:nth-child(6){height:16px!important;animation-delay:.40s!important}' +
        '.silver-bar:nth-child(7){height:10px!important;animation-delay:.48s!important}' +
        '@keyframes silver-w{0%,100%{transform:scaleY(.3);opacity:.5}50%{transform:scaleY(1);opacity:1}}' +
        '#silver-mic{width:72px!important;height:72px!important;border-radius:50%!important;border:none!important;background:#1a365d!important;color:#fff!important;font-size:34px!important;cursor:pointer!important;box-shadow:0 4px 20px rgba(0,0,0,.35)!important;display:flex!important;align-items:center!important;justify-content:center!important;padding:0!important;margin:0!important;line-height:1!important;transition:background .2s,transform .15s!important}' +
        '#silver-mic:hover{background:#2a4f84!important;transform:scale(1.05)!important}' +
        '#silver-mic.on{background:#553C9A!important}' +
        '#silver-mic.processing{background:#B7791F!important;animation:silver-pulse 1.2s infinite!important}' +
        '@keyframes silver-pulse{0%,100%{opacity:1}50%{opacity:.6}}' +
        '#silver-tag{font-size:13px!important;font-weight:700!important;color:#1a365d!important;background:#fff!important;padding:5px 14px!important;border-radius:8px!important;box-shadow:0 2px 8px rgba(0,0,0,.12)!important;text-align:center!important;max-width:280px!important}' +
        '#silver-reader{position:fixed!important;inset:0!important;z-index:2147483640!important;background:#FFFFF8!important;overflow-y:auto!important}' +
        '#silver-reader-inner{max-width:720px;margin:0 auto;padding:48px 32px;font-family:Georgia,serif;font-size:22px;line-height:2;color:#1a1a1a}' +
        '#silver-reader-banner{background:#E8F0FE;border:2px solid #4285F4;border-radius:14px;padding:18px 24px;margin-bottom:28px;font-family:Arial,sans-serif;font-size:18px;color:#1a365d;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px}' +
        '#silver-reader-banner button{background:#1a365d;color:#fff;border:none;border-radius:10px;padding:14px 24px;font-size:18px;cursor:pointer;font-weight:bold}' +
        '.silver-word{transition:background .1s;border-radius:3px;padding:1px 2px}' +
        '.silver-word-active{background:#FFD700!important;color:#000!important;padding:2px 4px}' +
        '.silver-high-contrast,.silver-high-contrast *{background-color:#000!important;color:#FFF!important;border-color:#555!important}' +
        '.silver-high-contrast a,.silver-high-contrast a *{color:#FFD700!important}';
      (document.head || document.documentElement).appendChild(s);
    }

    var old = document.getElementById('silver-float'); if (old) old.remove();
    var f = document.createElement('div'); f.id = 'silver-float';
    statusEl = document.createElement('div'); statusEl.id = 'silver-status'; f.appendChild(statusEl);
    waveEl = document.createElement('div'); waveEl.id = 'silver-wave';
    for (var b = 0; b < 7; b++) { var d = document.createElement('div'); d.className = 'silver-bar'; waveEl.appendChild(d); }
    f.appendChild(waveEl);
    micBtn = document.createElement('button'); micBtn.id = 'silver-mic'; micBtn.textContent = '\uD83C\uDFA4'; f.appendChild(micBtn);
    tagEl = document.createElement('div'); tagEl.id = 'silver-tag'; tagEl.textContent = 'Alfred'; f.appendChild(tagEl);
    document.body.appendChild(f);
    micBtn.addEventListener('click', handleMicClick);

    // Escape key interrupts Alfred
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && listening && (speaking || speakCooldown || isReading || processing)) {
        e.preventDefault();
        interruptAlfred();
      }
    });
  }

  function showStatus(t, d) {
    if (!statusEl) return;
    statusEl.textContent = t;
    statusEl.classList.add('show');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function() { statusEl.classList.remove('show'); }, d || 6000);
  }

  function setWave(on) { if (waveEl) { if (on) waveEl.classList.add('active'); else waveEl.classList.remove('active'); } }

  function updateTag() {
    if (!tagEl) return;
    if (!listening) { tagEl.textContent = 'Alfred'; return; }
    var langFlag = lang === 'es' ? ' \uD83C\uDDEA\uD83C\uDDF8' : ' \uD83C\uDDFA\uD83C\uDDF8';
    if (processing) tagEl.textContent = (lang === 'es' ? 'Pensando...' : 'Thinking...') + langFlag;
    else if (speaking || speakCooldown) tagEl.textContent = (lang === 'es' ? 'Hablando... (clic = parar)' : 'Speaking... (click = stop)') + langFlag;
    else if (conversationActive) tagEl.textContent = (lang === 'es' ? 'Escuchando...' : 'Listening...') + langFlag;
    else tagEl.textContent = (lang === 'es' ? 'Di "Alfredo"...' : 'Say "Alfred"...') + langFlag;
  }

  function setProcessing(on) {
    processing = on;
    if (micBtn) { if (on) micBtn.classList.add('processing'); else micBtn.classList.remove('processing'); }
    updateTag();
  }

  // ═══════════ ON / OFF / INTERRUPT ═══════════
  function handleMicClick() {
    if (speaking || speakCooldown || isReading) {
      // User clicked mic while Alfred is talking → INTERRUPT, stay listening
      interruptAlfred();
    } else {
      // Normal toggle
      toggleVoice();
    }
  }

  function interruptAlfred() {
    if (elevenAudio) { try { elevenAudio.pause(); } catch(e) {} elevenAudio = null; }
    if (window.speechSynthesis) speechSynthesis.cancel();
    speaking = false; speakCooldown = false; isReading = false;
    setProcessing(false);
    if (readingEl) closeReader();
    showStatus(lang === 'es' ? 'Interrumpido. Escuchando...' : 'Interrupted. Listening...', 2500);
    if (listening) {
      startConvo();
      beginRec();
    }
  }

  function toggleVoice() {
    isReading = false; speaking = false; speakCooldown = false; conversationActive = false;
    setProcessing(false);
    if (elevenAudio) { try { elevenAudio.pause(); } catch(e) {} elevenAudio = null; }
    if (window.speechSynthesis) speechSynthesis.cancel();
    listening ? stopListening() : startListening();
  }

  function startListening() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { showStatus(lang === 'es' ? 'Navegador no soporta voz.' : 'Speech not supported in this browser.', 5000); return; }
    listening = true; history = []; errorStreak = 0;
    try { chrome.storage.local.set({ alfredOn: true }); } catch(e) {}
    if (micBtn) micBtn.classList.add('on');
    send({ type: 'badge', on: true });
    updateTag();
    showStatus(lang === 'es' ? 'Alfred listo. Di "Alfredo" + comando.' : 'Alfred ready. Say "Alfred" + a command.', 3000);
    beginRec();
  }

  function stopListening() {
    listening = false; speaking = false; speakCooldown = false; isReading = false; conversationActive = false;
    clearTimeout(convoTimer);
    setProcessing(false);
    try { chrome.storage.local.set({ alfredOn: false }); } catch(e) {}
    if (rec) { try { rec.abort(); } catch(e) {} rec = null; }
    recBusy = false;
    if (window.speechSynthesis) speechSynthesis.cancel();
    if (micBtn) { micBtn.classList.remove('on'); micBtn.classList.remove('processing'); }
    if (tagEl) tagEl.textContent = 'Alfred';
    setWave(false);
    send({ type: 'badge', on: false });
    showStatus(lang === 'es' ? 'Alfred desactivado.' : 'Alfred off.', 2000);
  }

  // ═══════════ SPEECH RECOGNITION ═══════════
  function beginRec() {
    if (!listening || !tabIsActive || speaking || speakCooldown || recBusy) return;
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;

    // Kill any existing instance
    if (rec) { try { rec.abort(); } catch(e) {} rec = null; }

    recBusy = true;
    rec = new SR();
    rec.lang = lang === 'es' ? 'es-ES' : 'en-US';
    rec.continuous = true;       // STAY OPEN — no gaps between utterances
    rec.interimResults = true;
    rec.maxAlternatives = 5;     // more alternatives = better wake-word matching

    rec.onspeechstart = function() { lastRecActivity = Date.now(); setWave(true); };
    rec.onspeechend = function() { lastRecActivity = Date.now(); setWave(false); };

    rec.onresult = function(e) {
      lastRecActivity = Date.now();
      // Process only the latest result
      var last = e.results[e.results.length - 1];
      var text = last[0].transcript.trim();
      if (!text) return;
      if (last.isFinal) {
        setWave(false);
        errorStreak = 0;
        if (text.length > 1) {
          var allTexts = [];
          for (var a = 0; a < last.length; a++) {
            allTexts.push(last[a].transcript.trim());
          }
          processInput(text, allTexts);
        }
      } else {
        // Show interim results so user knows they're being heard
        if (!isReading && !processing) showStatus('\uD83C\uDF99\uFE0F ' + text, 2500);
      }
    };

    rec.onerror = function(e) {
      lastRecActivity = Date.now();
      rec = null; recBusy = false;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        showStatus(lang === 'es' ? 'Permite acceso al micr\u00f3fono en configuraci\u00f3n del navegador.' : 'Allow microphone access in browser settings.', 10000);
        stopListening();
        return;
      }
      if (e.error === 'audio-capture') {
        showStatus(lang === 'es' ? 'No se encontr\u00f3 micr\u00f3fono.' : 'No microphone found.', 8000);
        stopListening();
        return;
      }
      // no-speech, aborted, network — restart with backoff
      errorStreak++;
      var delay = Math.min(200 * errorStreak, 2000);
      if (listening && !speaking && !speakCooldown) setTimeout(beginRec, delay);
    };

    rec.onend = function() {
      rec = null; recBusy = false;
      // continuous=true shouldn't end on its own, but Chrome kills it sometimes
      // restart FAST — 100ms gap is barely noticeable
      if (listening && !speaking && !speakCooldown && tabIsActive) {
        setTimeout(beginRec, 100);
      }
    };

    try { rec.start(); lastRecActivity = Date.now(); } catch(e) { rec = null; recBusy = false; }
  }

  // ═══════════ TTS — Alfred speaks ═══════════
  var lastSpeakTime = 0; // tracks when speech started (protects from heartbeat cancel)

  // Cache voices once they're loaded
  var cachedVoices = [];
  if (window.speechSynthesis) {
    cachedVoices = speechSynthesis.getVoices();
    speechSynthesis.addEventListener('voiceschanged', function() { cachedVoices = speechSynthesis.getVoices(); });
  }

  function pickVoice(langPrefix) {
    var voices = cachedVoices.length ? cachedVoices : speechSynthesis.getVoices();
    var fallback = null;
    for (var i = 0; i < voices.length; i++) {
      if (voices[i].lang.indexOf(langPrefix) === 0) {
        if (voices[i].localService) return voices[i]; // prefer local (faster, more reliable)
        if (!fallback) fallback = voices[i];
      }
    }
    return fallback;
  }

  function makeUtterance(text, voiceLang) {
    var utt = new SpeechSynthesisUtterance(text);
    utt.lang = voiceLang === 'es' ? 'es-ES' : 'en-US';
    utt.rate = 0.95;
    var voice = pickVoice(voiceLang === 'es' ? 'es' : 'en');
    if (voice) utt.voice = voice;
    return utt;
  }

  var elevenAudio = null; // current ElevenLabs audio element

  function sayOutLoud(text, voiceLang) {
    if (!text) return;
    speaking = true; speakCooldown = true;
    updateTag();

    // Kill mic
    if (rec) { try { rec.abort(); } catch(e) {} rec = null; recBusy = false; }
    if (elevenAudio) { try { elevenAudio.pause(); } catch(e) {} elevenAudio = null; }
    if (window.speechSynthesis) speechSynthesis.cancel();

    var finished = false;

    function done() {
      if (finished) return; finished = true;
      speaking = false;
      if (elevenAudio) { try { elevenAudio.pause(); } catch(e) {} elevenAudio = null; }
      updateTag();
      var coolMs = Math.min(300 + text.length * 5, 1200);
      setTimeout(function() {
        speakCooldown = false;
        if (listening && !speaking && tabIsActive) beginRec();
      }, coolMs);
    }

    // Safety timeout
    var safetyMs = Math.max(6000, text.length * 90);
    setTimeout(done, safetyMs);

    // Try ElevenLabs with 3s timeout, fall back to browser TTS
    var usedEleven = false;
    var elevenTimer = setTimeout(function() {
      // ElevenLabs too slow — skip to browser TTS
      if (!usedEleven && speaking && !finished) browserTTS();
    }, 3000);

    send({ type: 'elevenTTS', text: text }, function(resp) {
      clearTimeout(elevenTimer);
      if (!speaking || finished) return;
      if (resp && resp.audio) {
        usedEleven = true;
        try {
          elevenAudio = new Audio(resp.audio);
          elevenAudio.onended = done;
          elevenAudio.onerror = function() { elevenAudio = null; browserTTS(); };
          lastSpeakTime = Date.now();
          elevenAudio.play().catch(function() { elevenAudio = null; browserTTS(); });
        } catch(e) { browserTTS(); }
      } else {
        browserTTS();
      }
    });

    function browserTTS() {
      if (usedEleven || !speaking || finished) { if (!finished && !usedEleven) done(); return; }
      if (!window.speechSynthesis) { done(); return; }
      usedEleven = true; // prevent double-fire
      speechSynthesis.cancel();
      setTimeout(function() {
        if (!speaking || finished) return;
        var utt = makeUtterance(text, voiceLang);
        utt.onend = done;
        utt.onerror = done;
        lastSpeakTime = Date.now();
        speechSynthesis.speak(utt);
        // One retry if Chrome silently dropped it
        setTimeout(function() {
          if (speaking && !finished && !speechSynthesis.speaking) {
            var utt2 = makeUtterance(text, voiceLang);
            utt2.onend = done; utt2.onerror = done;
            speechSynthesis.speak(utt2);
          }
        }, 300);
      }, 80);
    }
  }

  // ═══════════ WAKE WORD DETECTION ═══════════
  function matchWakeWord(text) {
    var t = text.toLowerCase().replace(/[.,!?]/g, '').trim();
    // Direct matches
    var patterns = [
      /(?:hey\s+)?(?:alfred[oa]?)\b[,.\s!]*(.*)/,
      /(?:hey\s+)?(?:alfredo)\b[,.\s!]*(.*)/,
      // Common STT misrecognitions of "Alfred"
      /(?:hey\s+)?(?:al\s*fred|offered|all\s*fred|el\s*fred|ulfred|halfred)\b[,.\s!]*(.*)/,
    ];
    for (var i = 0; i < patterns.length; i++) {
      var m = t.match(patterns[i]);
      if (m) return m[1] ? m[1].trim() : '';
    }
    return null; // no wake word found
  }

  // ═══════════ PROCESS INPUT ═══════════
  function processInput(transcript, alternatives) {
    var lower = transcript.toLowerCase().trim();

    // During reading: only respond to stop commands
    if (isReading) {
      if (lower.split(/\s+/).length <= 5 && /\b(stop|para|basta|quiet|silence|alfred|alfredo|detente|shut up|callate)\b/.test(lower)) {
        stopReading();
        showStatus(lang === 'es' ? 'Detenido.' : 'Stopped.', 2000);
        startConvo();
      }
      return;
    }

    var command;
    if (conversationActive) {
      // In active conversation, everything is a command (no wake word needed)
      command = transcript.trim();
    } else {
      // Try wake word on primary transcript and all alternatives
      var allTexts = alternatives || [transcript];
      command = null;
      for (var a = 0; a < allTexts.length; a++) {
        var result = matchWakeWord(allTexts[a]);
        if (result !== null) { command = result; break; }
      }
      if (command === null) return; // no wake word detected
      if (!command) {
        showStatus(lang === 'es' ? '\u00bfS\u00ed? \u00bfQu\u00e9 necesitas?' : 'Yes? What do you need?', 2500);
        startConvo();
        return;
      }
    }
    startConvo();

    // Detect language from user speech — only switch if strong evidence
    var hasAccent = /[\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1\u00bf\u00a1]/.test(command);
    var esHits = (command.match(/\b(esta|p[aá]gina|leer|traduce|abre|qu[eé]|hola|necesito|puedes|por favor|busca|d[ií]me|hacer|tiene|puede|donde|cuando|tambi[eé]n|ahora|todo|como)\b/gi) || []).length;
    var enHits = (command.match(/\b(the|this|that|open|click|search|please|what|where|when|how|page|read|find|go|close|make)\b/gi) || []).length;
    // Switch only if clear winner — accents = instant Spanish, otherwise need 2+ hits and lead over other language
    if (hasAccent || (esHits >= 2 && esHits > enHits)) {
      lang = 'es';
    } else if (enHits >= 2 && enHits > esHits) {
      lang = 'en';
    }
    // If tied or weak signal, keep current lang
    try { chrome.storage.local.set({ lang: lang }); } catch(e) {}

    showStatus((lang === 'es' ? 'T\u00fa: "' : 'You: "') + command + '"', 10000);

    // ── Local commands (no API call needed) ──
    var t = command.toLowerCase();

    // LANGUAGE SWITCH — instant, no API
    if (/\b(switch to spanish|speak spanish|speak in spanish|en espa[nñ]ol|habla espa[nñ]ol|cambia a espa[nñ]ol|spanish mode)\b/i.test(t)) {
      lang = 'es';
      try { chrome.storage.local.set({ lang: 'es' }); } catch(e) {}
      // Kill rec so it restarts with new language
      if (rec) { try { rec.abort(); } catch(e) {} rec = null; recBusy = false; }
      showStatus('Idioma: Espa\u00f1ol', 3000);
      sayOutLoud('Cambiado a espa\u00f1ol.', 'es');
      return;
    }
    if (/\b(switch to english|speak english|speak in english|in english|en ingl[eé]s|habla ingl[eé]s|cambia a ingl[eé]s|english mode)\b/i.test(t)) {
      lang = 'en';
      try { chrome.storage.local.set({ lang: 'en' }); } catch(e) {}
      if (rec) { try { rec.abort(); } catch(e) {} rec = null; recBusy = false; }
      showStatus('Language: English', 3000);
      sayOutLoud('Switched to English.', 'en');
      return;
    }

    if (/\b(scroll down|baja|abajo|go down)\b/.test(t)) { window.scrollBy({ top: 500, behavior: 'smooth' }); showStatus(lang === 'es' ? 'Bajando.' : 'Scrolling down.', 1500); return; }
    if (/\b(scroll up|sube|arriba|go up)\b/.test(t)) { window.scrollBy({ top: -500, behavior: 'smooth' }); showStatus(lang === 'es' ? 'Subiendo.' : 'Scrolling up.', 1500); return; }
    if (/\b(go to top|back to top|inicio|principio)\b/.test(t)) { window.scrollTo({ top: 0, behavior: 'smooth' }); showStatus(lang === 'es' ? 'Inicio de p\u00e1gina.' : 'Top of page.', 1500); return; }
    if (/\b(go to bottom|final|fondo)\b/.test(t)) { window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); showStatus(lang === 'es' ? 'Final de p\u00e1gina.' : 'Bottom of page.', 1500); return; }
    if (/\b(bigger|larger|zoom in|m[aá]s grande|aumenta)\b/.test(t)) { sizeLevel++; document.body.style.zoom = String(1 + sizeLevel * .12); showStatus(lang === 'es' ? 'M\u00e1s grande.' : 'Bigger.', 1500); return; }
    if (/\b(smaller|zoom out|m[aá]s peque|reduce)\b/.test(t)) { sizeLevel--; document.body.style.zoom = String(1 + sizeLevel * .12); showStatus(lang === 'es' ? 'M\u00e1s peque\u00f1o.' : 'Smaller.', 1500); return; }
    if (/\b(reset size|normal size|tama[nñ]o normal)\b/.test(t)) { sizeLevel = 0; document.body.style.zoom = '1'; showStatus(lang === 'es' ? 'Tama\u00f1o normal.' : 'Normal size.', 1500); return; }
    if (/\b(contrast|dark mode|contraste|modo oscuro)\b/.test(t)) { contrastOn = !contrastOn; document.body.classList.toggle('silver-high-contrast', contrastOn); showStatus(contrastOn ? (lang === 'es' ? 'Contraste alto activado.' : 'High contrast on.') : (lang === 'es' ? 'Contraste normal.' : 'Normal contrast.'), 1500); return; }
    if (/\b(stop listening|turn off|ap[aá]gate|desactivar)\b/.test(t)) { stopListening(); return; }
    // Unified stop/interrupt: works both in and out of conversation.
    // Only trigger on short utterances (3 words or fewer) to avoid false positives like "don't stop the music".
    if (t.split(/\s+/).length <= 3 && /\b(stop|shut up|quiet|be quiet|c[aá]llate|silencio|para de hablar|stop reading|stop talking)\b/.test(t)) {
      if (isReading) { stopReading(); }
      if (window.speechSynthesis) speechSynthesis.cancel();
      speaking = false; speakCooldown = false;
      interruptAlfred();
      return;
    }
    // Browser navigation: go back / go forward
    if (/\b(go back|back|atr[aá]s|volver|previous page|p[aá]gina anterior)\b/.test(t) && !/\b(go back to top)\b/.test(t)) { window.history.back(); showStatus(lang === 'es' ? 'Volviendo.' : 'Going back.', 2000); return; }
    if (/\b(go forward|forward|adelante|siguiente|next page|p[aá]gina siguiente)\b/.test(t)) { window.history.forward(); showStatus(lang === 'es' ? 'Adelante.' : 'Going forward.', 2000); return; }
    if (/\b(refresh|reload|actualizar|recargar)\b/.test(t)) { showStatus(lang === 'es' ? 'Recargando.' : 'Refreshing.', 1500); window.location.reload(); return; }

    if (/^(read|lee|l[eé]eme|read this|read the page|leer)/i.test(t)) { readPageAloud(); return; }
    if (/\b(close|cerrar)\b/.test(t) && /\b(reader|overlay|vista)\b/.test(t)) { closeReader(); return; }

    // ── Send to Claude ──
    setProcessing(true);
    var page;
    try {
      page = getPageContext();
    } catch(e) {
      // Page context failed — use minimal info so Alfred can still respond
      page = { url: window.location.href, title: document.title || '', text: '', headings: 'none', clickables: 'none' };
    }

    var claudeTimeout = setTimeout(function() {
      setProcessing(false);
      showStatus(lang === 'es' ? 'Sin respuesta. Int\u00e9ntalo de nuevo.' : 'No response. Try again.', 4000);
    }, 15000);

    send({ type: 'getTabs' }, function(tr) {
      try {
        var tabs = (tr && tr.tabs) ? tr.tabs : '';
        var msg = [
          'User said: "' + command + '"',
          '',
          'Current page: ' + page.url,
          'Title: ' + page.title,
          '',
          'Headings:',
          page.headings || 'none',
          '',
          'Page text (excerpt):',
          page.text || 'none',
          '',
          'Page elements (click by index number):',
          page.clickables || 'none',
          tabs ? '\nOpen tabs:\n' + tabs : ''
        ].join('\n');

        history.push({ role: 'user', content: msg });
        if (history.length > 10) history = history.slice(-8);

        send({ type: 'alfred', history: history.slice() }, function(resp) {
          try {
            clearTimeout(claudeTimeout);
            setProcessing(false);

            if (!resp || resp.error) {
              var errMsg = resp ? resp.error : 'connection lost';
              if (errMsg === 'no_key') {
                showStatus(lang === 'es' ? 'Configura tu API key primero.' : 'Set your API key first.', 8000);
              } else {
                showStatus('Error: ' + errMsg, 5000);
              }
              return;
            }

            var r = resp.result;
            if (!r) { showStatus('No response from Alfred.', 3000); return; }

            history.push({ role: 'assistant', content: JSON.stringify(r) });
            if (history.length > 10) history = history.slice(-8);

            if (r.actions && r.actions.length) executeActions(r.actions);
            if (r.speak) {
              var rl = detectLang(r.speak);
              if (rl !== lang) { lang = rl; try { chrome.storage.local.set({ lang: lang }); } catch(e) {} }
              showStatus('Alfred: ' + r.speak);
              sayOutLoud(r.speak, lang);
            }
            startConvo();
          } catch(e) {
            setProcessing(false);
            showStatus('Error: ' + (e.message || 'unknown'), 5000);
          }
        });
      } catch(e) {
        clearTimeout(claudeTimeout);
        setProcessing(false);
        showStatus('Error: ' + (e.message || 'unknown'), 5000);
      }
    });
  }

  function startConvo() {
    conversationActive = true;
    clearTimeout(convoTimer);
    updateTag();
    convoTimer = setTimeout(function() {
      conversationActive = false;
      updateTag();
      showStatus(lang === 'es' ? 'Di "Alfredo" para hablar.' : 'Say "Alfred" to talk.', 3000);
    }, 30000); // 30s conversation window — generous
  }

  // ═══════════ READ ALOUD ═══════════
  function readPageAloud() {
    var text = extractText();
    if (!text || text.trim().length < 20) {
      showStatus(lang === 'es' ? 'No hay texto para leer.' : 'Nothing to read on this page.', 3000);
      return;
    }
    text = text.slice(0, 10000);
    isReading = true;
    speaking = true; speakCooldown = true;
    if (rec) { try { rec.abort(); } catch(e) {} rec = null; recBusy = false; }
    showStatus(lang === 'es' ? 'Leyendo... di "para" para detener.' : 'Reading... say "stop" to interrupt.', 5000);
    showReadingOverlay(text);

    var chunks = text.match(/[^.!?\n]{1,500}[.!?\n]|[^.!?\n]+$/g) || [text];
    var ci = 0, offset = 0;
    var pl = detectLang(text);
    var voices = speechSynthesis.getVoices(), pf = pl === 'es' ? 'es' : 'en', voice = null;
    for (var v = 0; v < voices.length; v++) {
      if (voices[v].lang.indexOf(pf) === 0) { voice = voices[v]; if (voices[v].localService) break; }
    }

    // Briefly enable mic between chunks so user can say "stop"
    function enableMicBriefly() {
      if (!isReading || !listening) return;
      speaking = false; speakCooldown = false;
      beginRec();
      // Mic will be killed again when next chunk starts speaking
    }

    function next() {
      if (ci >= chunks.length || !isReading) {
        isReading = false; speaking = false;
        setTimeout(function() {
          speakCooldown = false;
          if (listening && tabIsActive) beginRec();
        }, 800);
        showStatus(lang === 'es' ? 'Lectura terminada.' : 'Done reading.', 3000);
        return;
      }
      var chunk = chunks[ci].trim();
      if (!chunk) { ci++; offset += 1; next(); return; }

      // Kill mic while speaking this chunk
      if (rec) { try { rec.abort(); } catch(e) {} rec = null; recBusy = false; }
      speaking = true; speakCooldown = true;
      speechSynthesis.cancel();

      // CRITICAL: Chrome drops speak() if called right after cancel(). 60ms delay fixes it.
      setTimeout(function() {
        if (!isReading) return; // interrupted during the delay

        var utt = new SpeechSynthesisUtterance(chunk);
        utt.lang = pl === 'es' ? 'es-ES' : 'en-US';
        utt.rate = 0.88;
        if (voice) utt.voice = voice;
        var myOff = offset;
        utt.onboundary = function(e) { if (e.name === 'word') highlightWord(myOff + e.charIndex); };
        utt.onend = function() {
          offset += chunk.length + 1; ci++;
          if (isReading) {
            // Brief mic window between chunks
            enableMicBriefly();
            setTimeout(next, 400);
          }
        };
        utt.onerror = function() { isReading = false; speaking = false; speakCooldown = false; };
        speechSynthesis.speak(utt);
      }, 60);
    }
    next();
  }

  function stopReading() {
    isReading = false; speaking = false;
    if (window.speechSynthesis) speechSynthesis.cancel();
    if (readingEl) { var a = readingEl.querySelector('.silver-word-active'); if (a) a.classList.remove('silver-word-active'); }
    setTimeout(function() {
      speakCooldown = false;
      if (listening && tabIsActive) beginRec();
    }, 500);
  }

  function showReadingOverlay(text) {
    closeReader();
    readingEl = document.createElement('div'); readingEl.id = 'silver-reader';
    var html = '', re = /(\S+)(\s*)/g, m;
    while ((m = re.exec(text)) !== null) html += '<span class="silver-word" data-p="' + m.index + '">' + esc(m[1]) + '</span>' + m[2].replace(/\n/g, '<br>');
    readingEl.innerHTML = '<div id="silver-reader-inner"><div id="silver-reader-banner"><span>' + (lang === 'es' ? 'Leyendo' : 'Reading') + '</span><button id="silver-reader-close">' + (lang === 'es' ? 'Cerrar' : 'Close') + '</button></div><div>' + html + '</div></div>';
    document.body.appendChild(readingEl);
    document.getElementById('silver-reader-close').addEventListener('click', function() { stopReading(); closeReader(); });
  }

  var lastWordIdx = 0;
  function highlightWord(ci) {
    if (!readingEl) return;
    var spans = readingEl.querySelectorAll('.silver-word');
    for (var i = lastWordIdx; i < spans.length; i++) {
      var p = parseInt(spans[i].getAttribute('data-p'));
      if (ci >= p && ci < p + spans[i].textContent.length + 1) {
        var old = readingEl.querySelector('.silver-word-active');
        if (old) old.classList.remove('silver-word-active');
        spans[i].classList.add('silver-word-active');
        spans[i].scrollIntoView({ behavior: 'smooth', block: 'center' });
        lastWordIdx = i;
        return;
      }
    }
  }

  function closeReader() { var r = document.getElementById('silver-reader'); if (r) r.remove(); readingEl = null; lastWordIdx = 0; }

  // ═══════════ PAGE CONTEXT ═══════════

  // Clean Google/Bing redirect URLs to show actual destination
  function cleanHref(href) {
    if (!href) return '';
    try {
      var u = new URL(href);
      if ((u.hostname.indexOf('google.') !== -1) && u.pathname === '/url' && u.searchParams.has('q')) {
        return u.searchParams.get('q');
      }
      if (u.hostname.indexOf('bing.') !== -1 && u.pathname === '/ck/a' && u.searchParams.has('u')) {
        try { return decodeURIComponent(u.searchParams.get('u').replace(/^a1/, '')); } catch(e) {}
      }
    } catch(e) {}
    return href;
  }

  // Quick nav check — only look at direct parent tags/roles, skip expensive class scanning
  function isNavElement(el) {
    try {
      var node = el;
      for (var depth = 0; node && depth < 5; depth++) {
        var tag = (node.tagName || '').toLowerCase();
        if (tag === 'nav' || tag === 'footer' || tag === 'header') return true;
        if (tag === 'main' || tag === 'article') return false;
        var role = node.getAttribute ? (node.getAttribute('role') || '') : '';
        if (role === 'navigation' || role === 'banner' || role === 'contentinfo') return true;
        if (role === 'main') return false;
        var id = (node.id || '').toLowerCase();
        // Only check ID (fast), skip className (slow on SVG, unreliable on Google)
        if (/^(nav|footer|sidebar|cookie-banner)/.test(id)) return true;
        if (/^(search|rso|main|content|results)/.test(id)) return false;
        node = node.parentElement;
      }
    } catch(e) {}
    return false;
  }

  function getPageContext() {
    clickables = [];
    var cl = [];

    try {
      // On search pages, target result containers directly first
      var isSearchPage = /google\.\w+\/search|bing\.\w+\/search|duckduckgo\.com/.test(window.location.hostname + window.location.pathname);
      var maxTotal = 50;
      var seenHrefs = {};

      function addEl(el) {
        if (clickables.length >= maxTotal) return;
        try {
          var tag = el.tagName.toLowerCase(), txt = '';
          var r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) return;

          if (tag === 'input') txt = '[input:' + (el.type || 'text') + '] ' + (el.placeholder || el.name || el.getAttribute('aria-label') || el.value || '');
          else if (tag === 'select') txt = '[select] ' + (el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex].text : '');
          else if (tag === 'textarea') txt = '[textarea] ' + (el.placeholder || '');
          else {
            var h3 = el.querySelector('h3, h2, h1');
            if (h3) txt = h3.textContent.trim();
            if (!txt) txt = (el.getAttribute('aria-label') || el.innerText || el.textContent || el.title || '').trim();
            txt = txt.replace(/\s+/g, ' ');
          }
          txt = txt.slice(0, 100);
          if (!txt || txt.length < 2) return;

          var rawHref = el.href ? cleanHref(el.href) : '';
          if (rawHref) {
            // Skip same-site links only on search result pages (not on regular sites where internal links are useful)
            try {
              var hu = new URL(rawHref);
              if (isSearchPage && hu.hostname === window.location.hostname) return;
            } catch(e) {}
            var hrefKey = rawHref.split('?')[0].split('#')[0];
            if (seenHrefs[hrefKey]) return;
            seenHrefs[hrefKey] = true;
          } else {
            var txtKey = txt.slice(0, 40);
            if (seenHrefs['txt:' + txtKey]) return;
            seenHrefs['txt:' + txtKey] = true;
          }

          clickables.push(el);
          var displayHref = rawHref ? ' -> ' + rawHref.slice(0, 100) : '';
          cl.push((clickables.length - 1) + '. [' + tag + '] ' + txt + displayHref);
        } catch(e) { /* skip this element */ }
      }

      // PASS 1: If search page, grab result links directly from known containers
      if (isSearchPage) {
        var resultContainers = document.querySelectorAll('#rso a[href], #search a[href], #links a[href], .results a[href], [data-snf] a[href], .react-results--main a[href]');
        for (var r = 0; r < resultContainers.length && clickables.length < 35; r++) {
          addEl(resultContainers[r]);
        }
      }

      // PASS 2: Main content elements (skip nav)
      var selectors = 'a[href], button, [role="button"], input[type="text"], input[type="search"], textarea, select';
      var allEls = document.querySelectorAll(selectors);
      // Cap how many we even look at — Google can have 1000+ matches
      var scanLimit = Math.min(allEls.length, 300);
      for (var i = 0; i < scanLimit && clickables.length < maxTotal - 5; i++) {
        if (!isNavElement(allEls[i])) addEl(allEls[i]);
      }

      // PASS 3: Grab a few UI elements (buttons, inputs) for completeness
      for (var u = 0; u < scanLimit && clickables.length < maxTotal; u++) {
        if (isNavElement(allEls[u])) addEl(allEls[u]);
      }

    } catch(e) {
      // getPageContext crashed — return minimal context so Alfred still works
      clickables = [];
      cl = [];
    }

    var hd = [];
    try {
      var hs = document.querySelectorAll('h1, h2, h3');
      for (var h = 0; h < hs.length && hd.length < 12; h++) {
        var ht = hs[h].textContent.trim().slice(0, 120);
        if (ht) hd.push(hs[h].tagName + ': ' + ht);
      }
    } catch(e) {}

    var pageHint = '';
    try {
      var loc = window.location.hostname + window.location.pathname;
      if (/google\.\w+\/search/.test(loc)) pageHint = '[PAGE TYPE: Google search results. The elements below are search result links. Click them by index to navigate to that site.]\n';
      else if (/bing\.\w+\/search/.test(loc)) pageHint = '[PAGE TYPE: Bing search results. Click elements by index to navigate.]\n';
      else if (/duckduckgo\.com/.test(loc)) pageHint = '[PAGE TYPE: DuckDuckGo results.]\n';
      else if (/youtube\.com/.test(loc)) pageHint = '[PAGE TYPE: YouTube. Click video links to watch.]\n';
    } catch(e) {}

    return {
      url: window.location.href,
      title: document.title || '',
      text: (function() { try { return extractText().slice(0, 5000); } catch(e) { return ''; } })(),
      headings: hd.join('\n') || 'none',
      clickables: pageHint + (cl.join('\n') || 'none')
    };
  }

  // ═══════════ ACTIONS ═══════════
  function executeActions(actions) {
    for (var i = 0; i < actions.length; i++) {
      (function(a, delay) {
        setTimeout(function() { doAction(a); }, delay);
      })(actions[i], i * 600);
    }
  }

  function doAction(a) {
    if (!a || !a.type) return;
    switch (a.type) {
      case 'navigate':
        if (a.url) {
          var navUrl = cleanHref(a.url);
          showStatus(lang === 'es' ? 'Navegando...' : 'Navigating...', 3000);
          window.location.href = navUrl;
        }
        break;
      case 'new_tab':
        send({ type: 'tabAction', action: 'new_tab', url: a.url || 'https://google.com' });
        break;
      case 'close_tab':
        send({ type: 'tabAction', action: 'close_tab' });
        break;
      case 'switch_tab':
        send({ type: 'tabAction', action: 'switch_tab', index: a.index || 0 });
        break;
      case 'search':
        send({ type: 'tabAction', action: 'search', query: a.query || '' });
        break;

      case 'click':
        if (typeof a.index === 'number' && a.index >= 0 && a.index < clickables.length) {
          var el = clickables[a.index];
          // Check element is still in DOM (SPAs can re-render between context gather and click)
          if (!document.body.contains(el)) {
            showStatus(lang === 'es' ? 'Elemento desapareci\u00f3. Intenta de nuevo.' : 'Element gone. Try again.', 3000);
            break;
          }
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setTimeout(function() {
            try {
              // For links: direct navigate (most reliable, bypasses any JS interference)
              if (el.tagName === 'A' && el.href) {
                var realUrl = cleanHref(el.href);
                showStatus(lang === 'es' ? 'Abriendo...' : 'Opening...', 2000);
                if (el.target === '_blank') {
                  send({ type: 'tabAction', action: 'new_tab', url: realUrl });
                } else {
                  window.location.href = realUrl;
                }
                return;
              }
              // For everything else: full event chain that works on ANY framework
              var rect = el.getBoundingClientRect();
              var cx = rect.left + rect.width / 2;
              var cy = rect.top + rect.height / 2;
              var evtOpts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
              try { el.focus(); } catch(e) {}
              // Pointer events (React, modern SPAs)
              el.dispatchEvent(new PointerEvent('pointerdown', evtOpts));
              el.dispatchEvent(new MouseEvent('mousedown', evtOpts));
              el.dispatchEvent(new MouseEvent('mouseup', evtOpts));
              el.dispatchEvent(new PointerEvent('pointerup', evtOpts));
              el.dispatchEvent(new MouseEvent('click', evtOpts));
              // Native click as fallback
              try { el.click(); } catch(e) {}
            } catch(e) {
              // Last resort
              try { el.click(); } catch(e2) {}
            }
          }, 350);
        } else {
          showStatus(lang === 'es' ? 'Elemento no encontrado.' : 'Element not found.', 3000);
        }
        break;

      case 'type':
        if (typeof a.index === 'number' && a.index >= 0 && a.index < clickables.length && a.text) {
          var inp = clickables[a.index];
          inp.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setTimeout(function() {
            try { inp.focus(); inp.click(); } catch(e) {}
            var isContentEditable = inp.isContentEditable || inp.getAttribute('contenteditable') === 'true';
            var tag = inp.tagName.toLowerCase();

            // Get the right native setter (cached outside loop for performance)
            var nativeSetter = null;
            if (tag === 'textarea') {
              nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
            } else if (tag === 'input') {
              nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
            }

            // Clear field first
            if (isContentEditable) {
              inp.textContent = '';
            } else if (nativeSetter && nativeSetter.set) {
              nativeSetter.set.call(inp, '');
              inp.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
              inp.value = '';
              inp.dispatchEvent(new Event('input', { bubbles: true }));
            }

            // Type character by character — works on React, Angular, Vue, plain HTML, everything
            var chars = a.text.split('');
            var ci = 0;
            function typeChar() {
              if (ci >= chars.length) {
                // Done — fire final events and optionally submit
                inp.dispatchEvent(new Event('change', { bubbles: true }));
                var form = inp.closest ? inp.closest('form') : null;
                if (form && /search/i.test((form.action || '') + (form.className || '') + (inp.name || '') + (inp.type || ''))) {
                  setTimeout(function() {
                    var enterOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
                    inp.dispatchEvent(new KeyboardEvent('keydown', enterOpts));
                    inp.dispatchEvent(new KeyboardEvent('keypress', enterOpts));
                    inp.dispatchEvent(new KeyboardEvent('keyup', enterOpts));
                    setTimeout(function() { try { form.submit(); } catch(e) {} }, 200);
                  }, 150);
                }
                return;
              }
              var ch = chars[ci];
              var kOpts = { key: ch, code: 'Key' + ch.toUpperCase(), bubbles: true, cancelable: true };

              // keydown + keypress first
              inp.dispatchEvent(new KeyboardEvent('keydown', kOpts));
              inp.dispatchEvent(new KeyboardEvent('keypress', kOpts));

              if (isContentEditable) {
                // For contentEditable: use execCommand (most reliable)
                try { document.execCommand('insertText', false, ch); } catch(e) { inp.textContent += ch; }
              } else {
                // For regular inputs: native setter + InputEvent with insertText type
                if (nativeSetter && nativeSetter.set) {
                  nativeSetter.set.call(inp, inp.value + ch);
                } else {
                  inp.value += ch;
                }
                // InputEvent with inputType tells frameworks exactly what happened
                try {
                  inp.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
                } catch(e) {
                  inp.dispatchEvent(new Event('input', { bubbles: true }));
                }
              }

              inp.dispatchEvent(new KeyboardEvent('keyup', kOpts));
              ci++;
              setTimeout(typeChar, 20);
            }
            typeChar();
          }, 300);
        }
        break;

      case 'go_back':
        window.history.back();
        break;
      case 'go_forward':
        window.history.forward();
        break;
      case 'scroll':
        window.scrollBy({ top: a.direction === 'up' ? -500 : 500, behavior: 'smooth' });
        break;
      case 'read_aloud':
        readPageAloud();
        break;
      case 'stop_reading':
        stopReading();
        break;
      case 'simplify':
        doAI('simplify');
        break;
      case 'translate':
        doAI('translate', a.to || 'es');
        break;
      case 'text_size':
        sizeLevel += (a.delta || 1);
        document.body.style.zoom = String(Math.max(.5, Math.min(3, 1 + sizeLevel * .12)));
        break;
      case 'contrast':
        contrastOn = !contrastOn;
        document.body.classList.toggle('silver-high-contrast', contrastOn);
        break;
      case 'stop_listening':
        stopListening();
        break;
    }
  }

  // ═══════════ TEXT TOOLS ═══════════
  function extractText() {
    var selectors = ['article', '[role="main"]', 'main', '.article-body', '.post-content', '.entry-content', '.story-body', '.content-body', '#content', '#main-content'];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el && el.innerText && el.innerText.trim().length > 200) return clean(el.innerText);
    }
    var best = null, bl = 0, divs = document.querySelectorAll('div, section');
    for (var d = 0; d < divs.length; d++) {
      var t = divs[d].innerText; if (!t) continue;
      var l = t.trim().length;
      var cn = ''; try { cn = typeof divs[d].className === 'string' ? divs[d].className : String(divs[d].className || ''); } catch(e) {}
      var info = (divs[d].tagName + (divs[d].getAttribute('role') || '') + cn).toLowerCase();
      if (l > bl && l > 300 && !/nav|footer|sidebar|menu|header|banner|cookie|consent|popup|modal/i.test(info)) { best = divs[d]; bl = l; }
    }
    if (best) return clean(best.innerText);
    return clean(document.body.innerText || '');
  }

  function clean(t) { return t.replace(/\t/g, ' ').replace(/ {2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim(); }

  function detectLang(t) {
    var s = t.slice(0, 1500).toLowerCase();
    var esWords = ['el', 'la', 'los', 'las', 'del', 'una', 'es', 'son', 'por', 'para', 'con', 'que', 'pero', 'como', 'esta', 'esto', 'hay'];
    var enWords = ['the', 'is', 'are', 'was', 'were', 'have', 'has', 'that', 'with', 'this', 'from', 'what', 'which', 'you', 'can', 'will'];
    var a = 0, b = 0, w = s.split(/\W+/);
    for (var i = 0; i < w.length; i++) { if (esWords.indexOf(w[i]) !== -1) a++; if (enWords.indexOf(w[i]) !== -1) b++; }
    if (/[\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1]/.test(s)) a += 5;
    return a > b ? 'es' : 'en';
  }

  function doAI(action, to) {
    var txt = extractText().slice(0, 12000);
    if (!txt || txt.length < 20) { showStatus(lang === 'es' ? 'No hay texto.' : 'No text found.', 3000); return; }
    setProcessing(true);
    showStatus(lang === 'es' ? 'Procesando...' : 'Processing...', 10000);
    send({ type: 'claude', action: action, text: txt, from: detectLang(txt), to: to || 'es', lang: detectLang(txt) }, function(r) {
      setProcessing(false);
      if (r && r.result) {
        closeReader();
        var el = document.createElement('div'); el.id = 'silver-reader';
        var p = r.result.split(/\n\n+/), h = '';
        for (var i = 0; i < p.length; i++) {
          if (p[i].trim()) h += '<p style="margin-bottom:1em;line-height:1.85;">' + esc(p[i].trim()) + '</p>';
        }
        el.innerHTML = '<div id="silver-reader-inner"><div id="silver-reader-banner"><span>' + (action === 'translate' ? (lang === 'es' ? 'Traducido' : 'Translated') : (lang === 'es' ? 'Simplificado' : 'Simplified')) + '</span><button id="silver-reader-close">' + (lang === 'es' ? 'Cerrar' : 'Close') + '</button></div>' + h + '</div>';
        document.body.appendChild(el);
        document.getElementById('silver-reader-close').addEventListener('click', closeReader);
        showStatus(lang === 'es' ? 'Listo.' : 'Done.', 3000);
      } else {
        showStatus(lang === 'es' ? 'Error al procesar.' : 'Processing failed.', 4000);
      }
    });
  }

  function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  // ═══════════ MESSAGE HANDLER + HEARTBEAT ═══════════
  chrome.runtime.onMessage.addListener(function(msg) { if (msg.action === 'toggleVoice') toggleVoice(); });

  // HEARTBEAT: recover mic every 2 seconds
  setInterval(function() {
    if (!listening || !tabIsActive) return;

    // If not speaking/cooldown and rec is dead, restart
    if (!speaking && !speakCooldown && !recBusy && !rec) {
      beginRec();
    }

    // WATCHDOG: if rec exists but hasn't fired any events in 8s, it's a zombie — kill & restart
    if (rec && !speaking && !speakCooldown && lastRecActivity && (Date.now() - lastRecActivity > 8000)) {
      try { rec.abort(); } catch(e) {} rec = null; recBusy = false;
      errorStreak = 0;
      beginRec();
    }

    // Unstick Chrome TTS bug — but DON'T cancel if speech just started (race condition)
    if (!isReading && !speaking && !speakCooldown && window.speechSynthesis && speechSynthesis.speaking) {
      // Only cancel if it's been >3s since we last called speak() — otherwise it's probably still ours
      if (Date.now() - lastSpeakTime > 3000) {
        speechSynthesis.cancel();
      }
    }

    updateTag();
  }, 2000);

  // ═══════════ INIT ═══════════
  if (document.body) injectUI();
  else document.addEventListener('DOMContentLoaded', injectUI);
})();
