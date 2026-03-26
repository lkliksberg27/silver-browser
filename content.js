/*
 * Silver Browser — Alfred Content Script (v9)
 *
 * Fixes over v8:
 * - Speech recognition: proper state machine, no double-start, backoff on errors
 * - Echo prevention: 800ms cooldown after TTS before mic restarts
 * - Wake word: lenient matching (handles STT misrecognitions)
 * - Actions: multi-method click, proper event dispatch
 * - TTS: forced cleanup for Chrome hanging bug
 * - Better visual feedback during processing
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

  function sayOutLoud(text, voiceLang) {
    if (!window.speechSynthesis || !text) return;
    speaking = true; speakCooldown = true;
    updateTag();

    // Kill mic so Alfred doesn't hear himself
    if (rec) { try { rec.abort(); } catch(e) {} rec = null; recBusy = false; }
    speechSynthesis.cancel();

    // CRITICAL: Chrome drops speak() if called right after cancel().
    // 60ms delay fixes the silent-utterance bug.
    setTimeout(function() {
      if (!speaking) return; // interrupted during the delay

      var utt = new SpeechSynthesisUtterance(text);
      utt.lang = voiceLang === 'es' ? 'es-ES' : 'en-US';
      utt.rate = 0.95;
      var voices = speechSynthesis.getVoices();
      var prefix = voiceLang === 'es' ? 'es' : 'en';
      for (var i = 0; i < voices.length; i++) {
        if (voices[i].lang.indexOf(prefix) === 0 && voices[i].localService) { utt.voice = voices[i]; break; }
        if (voices[i].lang.indexOf(prefix) === 0 && !utt.voice) utt.voice = voices[i];
      }

      var finished = false;
      function done() {
        if (finished) return; finished = true;
        speaking = false;
        updateTag();
        // COOLDOWN scales with text length: short replies = fast recovery, long = more echo to clear
        var coolMs = Math.min(300 + text.length * 5, 1200);
        setTimeout(function() {
          speakCooldown = false;
          if (listening && !speaking && tabIsActive) beginRec();
        }, coolMs);
      }
      utt.onend = done;
      utt.onerror = done;

      // Chrome TTS hang safety: force done after generous timeout
      var safetyMs = Math.max(5000, text.length * 90);
      setTimeout(done, safetyMs);

      lastSpeakTime = Date.now();
      speechSynthesis.speak(utt);
    }, 60);
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

    // Detect language from user speech
    if (/[\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1\u00bf\u00a1]/.test(command) || /\b(esta|p[aá]gina|leer|traduce|abre|qu[eé]|hola|necesito|puedes|por favor|busca|d[ií]me)\b/i.test(command)) {
      lang = 'es';
    } else { lang = 'en'; }
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

    if (/\b(scroll down|baja|abajo|go down)\b/.test(t)) { window.scrollBy({ top: 500, behavior: 'smooth' }); return; }
    if (/\b(scroll up|sube|arriba|go up)\b/.test(t)) { window.scrollBy({ top: -500, behavior: 'smooth' }); return; }
    if (/\b(go to top|back to top|inicio|principio)\b/.test(t)) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    if (/\b(go to bottom|final|fondo)\b/.test(t)) { window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); return; }
    if (/\b(bigger|larger|zoom in|m[aá]s grande|aumenta)\b/.test(t)) { sizeLevel++; document.body.style.zoom = String(1 + sizeLevel * .12); return; }
    if (/\b(smaller|zoom out|m[aá]s peque|reduce)\b/.test(t)) { sizeLevel--; document.body.style.zoom = String(1 + sizeLevel * .12); return; }
    if (/\b(reset size|normal size|tama[nñ]o normal)\b/.test(t)) { sizeLevel = 0; document.body.style.zoom = '1'; return; }
    if (/\b(contrast|dark mode|contraste|modo oscuro)\b/.test(t)) { contrastOn = !contrastOn; document.body.classList.toggle('silver-high-contrast', contrastOn); return; }
    if (/\b(stop listening|turn off|ap[aá]gate|desactivar)\b/.test(t)) { stopListening(); return; }
    if (/\b(stop|shut up|quiet|be quiet|c[aá]llate|silencio|para de hablar)\b/.test(t) && !conversationActive) { interruptAlfred(); return; }
    if (/\b(stop reading|stop talking|c[aá]llate|silencio|shut up)\b/.test(t)) { stopReading(); if (window.speechSynthesis) speechSynthesis.cancel(); speaking = false; speakCooldown = false; return; }
    if (/^(read|lee|l[eé]eme|read this|read the page|leer)/i.test(t)) { readPageAloud(); return; }
    if (/\b(close|cerrar)\b/.test(t) && /\b(reader|overlay|vista)\b/.test(t)) { closeReader(); return; }

    // ── Send to Claude ──
    setProcessing(true);
    var page = getPageContext();
    var claudeTimeout = setTimeout(function() {
      setProcessing(false);
      showStatus(lang === 'es' ? 'Sin respuesta. Int\u00e9ntalo de nuevo.' : 'No response. Try again.', 4000);
    }, 15000);

    send({ type: 'getTabs' }, function(tr) {
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
        clearTimeout(claudeTimeout);
        setProcessing(false);

        if (!resp || resp.error) {
          var errMsg = resp ? resp.error : 'connection lost';
          if (errMsg === 'no_key') {
            showStatus(lang === 'es' ? 'Configura tu API key primero.' : 'Set your API key first (click extension icon > options).', 8000);
          } else {
            showStatus('Error: ' + errMsg, 5000);
          }
          return;
        }

        var r = resp.result;
        if (!r) return;

        history.push({ role: 'assistant', content: JSON.stringify(r) });
        if (history.length > 10) history = history.slice(-8);

        if (r.actions && r.actions.length) executeActions(r.actions);
        if (r.speak) {
          var rl = detectLang(r.speak);
          if (rl !== lang) { lang = rl; try { chrome.storage.local.set({ lang: lang }); } catch(e) {} }
          showStatus('Alfred: ' + r.speak);
          sayOutLoud(r.speak, lang);
        }
        // Reset conversation timer so user has 30s to reply after Alfred speaks
        startConvo();
      });
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
      // Google redirect: /url?q=REAL_URL
      if ((u.hostname.indexOf('google.') !== -1) && u.pathname === '/url' && u.searchParams.has('q')) {
        return u.searchParams.get('q');
      }
      // Bing redirect
      if (u.hostname.indexOf('bing.') !== -1 && u.pathname === '/ck/a' && u.searchParams.has('u')) {
        try { return decodeURIComponent(u.searchParams.get('u').replace(/^a1/, '')); } catch(e) {}
      }
    } catch(e) {}
    return href;
  }

  // Check if an element is inside navigation/chrome (not main content)
  function isNavElement(el) {
    var node = el;
    for (var depth = 0; node && depth < 8; depth++) {
      var tag = (node.tagName || '').toLowerCase();
      var role = node.getAttribute ? (node.getAttribute('role') || '') : '';
      var cls = (node.className || '').toString().toLowerCase();
      var id = (node.id || '').toLowerCase();
      if (tag === 'nav' || role === 'navigation' || role === 'banner' || role === 'contentinfo' ||
          /\b(nav|header|footer|sidebar|menu|toolbar|cookie|consent|popup|modal|overlay)\b/.test(cls + ' ' + id)) {
        return true;
      }
      if (tag === 'main' || tag === 'article' || role === 'main') return false; // inside main = good
      node = node.parentElement;
    }
    return false;
  }

  function getPageContext() {
    clickables = [];
    var cl = [];
    var selectors = 'a[href], button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], input, select, textarea, [onclick], [tabindex]:not([tabindex="-1"]), [class*="btn"], summary, details > summary, label[for]';
    var allEls = document.querySelectorAll(selectors);

    // Separate into main-content elements (priority) and UI/nav elements
    var mainEls = [], uiEls = [];
    for (var i = 0; i < allEls.length; i++) {
      if (isNavElement(allEls[i])) uiEls.push(allEls[i]);
      else mainEls.push(allEls[i]);
    }

    // Process main content first (up to 45 slots), then UI elements (remaining slots)
    var maxMain = 45, maxTotal = 60;
    var seenHrefs = {}; // dedup by actual destination, not text

    function addElement(el) {
      if (clickables.length >= maxTotal) return;
      var tag = el.tagName.toLowerCase(), txt = '';

      // Skip hidden/invisible
      try {
        var r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return;
        var style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;
      } catch(e) { return; }

      if (tag === 'input') txt = '[input:' + (el.type || 'text') + '] ' + (el.placeholder || el.name || el.getAttribute('aria-label') || el.value || '');
      else if (tag === 'select') txt = '[select] ' + (el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex].text : '');
      else if (tag === 'textarea') txt = '[textarea] ' + (el.placeholder || '');
      else {
        // For links, prefer the closest heading or direct text over deep textContent
        var directTxt = '';
        var h3 = el.querySelector('h3, h2, h1');
        if (h3) directTxt = h3.textContent.trim();
        if (!directTxt) {
          // Get shallow text (not deeply nested nav menus)
          directTxt = (el.getAttribute('aria-label') || el.textContent || el.value || el.title || '').trim();
        }
        txt = directTxt.replace(/\s+/g, ' ');
      }
      txt = txt.slice(0, 100);
      if (!txt || txt.length < 2) return;

      // Smart dedup: for links, dedup by cleaned href; for others, by text
      var rawHref = el.href ? cleanHref(el.href) : '';
      if (rawHref) {
        // Skip internal Google/Bing navigation links
        try {
          var hu = new URL(rawHref);
          if (hu.hostname === window.location.hostname && /^\/(search|webhp|#|$)/.test(hu.pathname)) return;
        } catch(e) {}
        // Dedup by destination URL
        var hrefKey = rawHref.split('?')[0].split('#')[0]; // base URL without params
        if (seenHrefs[hrefKey]) return;
        seenHrefs[hrefKey] = true;
      } else {
        // Dedup non-link elements by exact text
        var txtKey = txt.slice(0, 40);
        if (seenHrefs['txt:' + txtKey]) return;
        seenHrefs['txt:' + txtKey] = true;
      }

      clickables.push(el);
      var displayHref = rawHref ? ' -> ' + rawHref.slice(0, 100) : '';
      cl.push((clickables.length - 1) + '. [' + tag + '] ' + txt + displayHref);
    }

    // Pass 1: main content elements (search results, article links, etc.)
    for (var m = 0; m < mainEls.length && clickables.length < maxMain; m++) {
      addElement(mainEls[m]);
    }
    // Pass 2: UI elements (nav, buttons, etc.) fill remaining slots
    for (var u = 0; u < uiEls.length && clickables.length < maxTotal; u++) {
      addElement(uiEls[u]);
    }

    var hd = [], hs = document.querySelectorAll('h1, h2, h3');
    for (var h = 0; h < hs.length && hd.length < 12; h++) {
      var ht = hs[h].textContent.trim().slice(0, 120);
      if (ht) hd.push(hs[h].tagName + ': ' + ht);
    }

    // Detect page type to help Claude
    var pageHint = '';
    var loc = window.location.hostname + window.location.pathname;
    if (/google\.\w+\/search/.test(loc)) pageHint = '[PAGE TYPE: Google search results. Elements above are the search result links — click them to navigate.]\n';
    else if (/bing\.\w+\/search/.test(loc)) pageHint = '[PAGE TYPE: Bing search results. Elements above are the result links.]\n';
    else if (/duckduckgo\.com/.test(loc)) pageHint = '[PAGE TYPE: DuckDuckGo search results.]\n';
    else if (/youtube\.com/.test(loc)) pageHint = '[PAGE TYPE: YouTube. Elements include video links — click to watch.]\n';

    return {
      url: window.location.href,
      title: document.title,
      text: extractText().slice(0, 5000),
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
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setTimeout(function() {
            // For links: get the REAL destination (bypass Google/Bing redirects)
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
            // For non-links: try multiple click methods
            try { el.focus(); } catch(e) {}
            try { el.click(); } catch(e) {}
            try {
              el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            } catch(e) {}
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
            try { inp.focus(); } catch(e) {}
            // Clear existing value
            inp.value = '';
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            // Type new value
            inp.value = a.text;
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            // If it's a search input, optionally submit
            var form = inp.closest('form');
            if (form && /search/i.test((form.action || '') + (form.className || '') + (inp.name || '') + (inp.type || ''))) {
              setTimeout(function() { form.submit(); }, 300);
            }
          }, 300);
        }
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
      var info = (divs[d].tagName + (divs[d].getAttribute('role') || '') + (divs[d].className || '')).toLowerCase();
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
  // Preload voices — Chrome loads them async, first getVoices() call returns empty
  if (window.speechSynthesis) {
    speechSynthesis.getVoices();
    speechSynthesis.addEventListener('voiceschanged', function() { speechSynthesis.getVoices(); });
  }

  if (document.body) injectUI();
  else document.addEventListener('DOMContentLoaded', injectUI);
})();
