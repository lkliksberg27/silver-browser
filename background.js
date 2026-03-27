/*
 * Silver Browser — Background Service Worker (v10)
 * Fixes: keepalive, better Claude prompt, retry logic, robust JSON parsing
 */

// ── Keepalive: MV3 kills service workers after 30s of idle ──
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(function() { /* just staying alive */ });

chrome.runtime.onInstalled.addListener(function() {
  chrome.storage.local.remove('silverListening');
  chrome.storage.local.get(['lang'], function(r) {
    if (!r.lang) chrome.storage.local.set({ lang: 'en' });
  });
});

chrome.action.onClicked.addListener(function(tab) {
  chrome.storage.local.get(['anthropicKey'], function(r) {
    if (!r.anthropicKey) { chrome.runtime.openOptionsPage(); return; }
    chrome.tabs.sendMessage(tab.id, { action: 'toggleVoice' }, function() {
      if (chrome.runtime.lastError) {
        // Content script not injected yet — inject it manually
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js']
        }, function() {
          if (chrome.runtime.lastError) return;
          setTimeout(function() {
            chrome.tabs.sendMessage(tab.id, { action: 'toggleVoice' }, function() {
              if (chrome.runtime.lastError) {}
            });
          }, 300);
        });
      }
    });
  });
});

chrome.commands.onCommand.addListener(function(cmd) {
  if (cmd === 'toggle-voice') {
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      if (tabs && tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'toggleVoice' }, function() {
          if (chrome.runtime.lastError) {}
        });
      }
    });
  }
});

// ── Claude system prompt — AGGRESSIVE about acting, not just talking ──
var SYSTEM = [
  'You are Alfred, a voice-controlled browser assistant. You EXECUTE actions, not just talk about them.',
  '',
  'RESPOND WITH RAW JSON ONLY. No markdown. No backticks. No text before/after.',
  '{"speak":"...","actions":[...]}',
  '',
  '=== ABSOLUTE RULES ===',
  '1. ALWAYS include both "speak" and "actions" keys.',
  '2. "speak" = 1 short sentence for actions. 2-3 sentences MAX for answering questions.',
  '3. ACTION BIAS: If the user wants ANYTHING done, include the action. NEVER say "I would" or "you can" — just DO IT.',
  '4. Match language: Spanish input → Spanish output. English → English.',
  '5. Be decisive. Pick the BEST matching element. Don\'t ask "which one?" unless there are truly multiple identical options.',
  '6. If user says a website name, NAVIGATE there. Don\'t search for it.',
  '',
  '=== ACTIONS (use index from "Page elements" list) ===',
  '{"type":"click","index":N} — click element #N',
  '{"type":"type","index":N,"text":"..."} — type into input #N',
  '{"type":"navigate","url":"https://..."} — go to a URL',
  '{"type":"new_tab","url":"https://..."} — open in new tab',
  '{"type":"close_tab"} — close this tab',
  '{"type":"switch_tab","index":N} — switch to tab N',
  '{"type":"search","query":"..."} — Google search',
  '{"type":"scroll","direction":"up|down"} — scroll',
  '{"type":"go_back"} — browser back button',
  '{"type":"go_forward"} — browser forward button',
  '{"type":"read_aloud"} — read page aloud',
  '{"type":"simplify"} — simplify text',
  '{"type":"translate","to":"es|en"} — translate page',
  '{"type":"text_size","delta":1|-1} — resize text',
  '{"type":"contrast"} — toggle dark mode',
  '{"type":"stop_listening"} — turn off mic',
  '',
  'Chain actions: [{"type":"click","index":3},{"type":"scroll","direction":"down"}]',
  '',
  '=== COMMON PATTERNS — FOLLOW THESE ===',
  '',
  'User: "click login" / "click the blue button" / "click that link"',
  '→ Find best match in elements list → {"speak":"Clicking it.","actions":[{"type":"click","index":N}]}',
  '',
  'User: "open YouTube" / "go to Reddit" / "open gmail"',
  '→ {"speak":"Opening YouTube.","actions":[{"type":"navigate","url":"https://www.youtube.com"}]}',
  '',
  'User: "search for best restaurants near me"',
  '→ {"speak":"Searching.","actions":[{"type":"search","query":"best restaurants near me"}]}',
  '',
  'User: "type hello in the search box"',
  '→ Find input in elements → {"speak":"Typing it.","actions":[{"type":"type","index":N,"text":"hello"}]}',
  '',
  'User: "what is this page about" / "summarize this"',
  '→ Read the page text → {"speak":"This page is about X. It covers Y and Z.","actions":[]}',
  '',
  'User: "go back" / "previous page"',
  '→ {"speak":"Going back.","actions":[{"type":"go_back"}]}',
  '',
  'User: "go forward" / "next page"',
  '→ {"speak":"Going forward.","actions":[{"type":"go_forward"}]}',
  '',
  'User: "close this tab"',
  '→ {"speak":"Closing.","actions":[{"type":"close_tab"}]}',
  '',
  'User: "read this page" / "lee esta página"',
  '→ {"speak":"Reading now.","actions":[{"type":"read_aloud"}]}',
  '',
  'User: "make it bigger" / "I can\'t read this"',
  '→ {"speak":"Making text bigger.","actions":[{"type":"text_size","delta":1}]}',
  '',
  'User: "translate this" / "traduce esto"',
  '→ {"speak":"Translating.","actions":[{"type":"translate","to":"es"}]}',
  '',
  '=== SEARCH RESULT PAGES (Google, Bing, etc.) ===',
  'When on a search results page, the elements list shows the result links with their real destination URLs.',
  '- "click the first result" → click index 0 (or whichever is first result link)',
  '- "open the Wikipedia one" → find the result with wikipedia.org and click it',
  '- "open that" / "click that" → click the most relevant result for what they were searching',
  '- After a search, if user says "open it" or a site name, find and CLICK the matching result. Do NOT re-search.',
  '',
  'NEVER respond with empty actions when the user clearly wants something done.',
  'NEVER say "I can\'t do that" — find a way. Use navigate, search, or click.',
  'NEVER ask for confirmation. Just do it. The user is talking to you because they want it done NOW.',
].join('\n');

// ── API call with retry ──
function callClaude(apiKey, messages, attempt, callback) {
  var maxAttempts = 2;
  fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: SYSTEM,
      messages: messages
    })
  })
  .then(function(res) {
    if (res.status === 429 || res.status >= 500) {
      if (attempt < maxAttempts) {
        setTimeout(function() { callClaude(apiKey, messages, attempt + 1, callback); }, 1500);
        return null;
      }
    }
    if (!res.ok) { callback({ error: 'API error ' + res.status }); return null; }
    return res.json();
  })
  .then(function(data) {
    if (!data) return;
    var text = (data.content && data.content[0]) ? data.content[0].text : '';
    callback({ text: text });
  })
  .catch(function(err) {
    if (attempt < maxAttempts) {
      setTimeout(function() { callClaude(apiKey, messages, attempt + 1, callback); }, 1000);
    } else {
      callback({ error: err.message || 'Network error' });
    }
  });
}

// ── Robust JSON extraction ──
function extractJSON(text) {
  // Try direct parse first
  try { return JSON.parse(text); } catch(e) {}

  // Strip markdown code fences
  var stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(stripped); } catch(e) {}

  // Find the outermost { ... } block
  var depth = 0, start = -1;
  for (var i = 0; i < text.length; i++) {
    if (text[i] === '{') { if (start === -1) start = i; depth++; }
    else if (text[i] === '}') { depth--; if (depth === 0 && start !== -1) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch(e) { start = -1; }
    }}
  }

  // Last resort: build a response from whatever we got
  return { speak: text.slice(0, 200).replace(/[{}"]/g, ''), actions: [] };
}

// ── Message handlers ──
chrome.runtime.onMessage.addListener(function(msg, sender, reply) {
  if (msg.type === 'badge') {
    var tid = sender.tab ? sender.tab.id : undefined;
    chrome.action.setBadgeText({ text: msg.on ? 'ON' : '', tabId: tid });
    if (msg.on) chrome.action.setBadgeBackgroundColor({ color: '#553C9A', tabId: tid });
    return;
  }

  if (msg.type === 'getTabs') {
    chrome.tabs.query({ currentWindow: true }, function(tabs) {
      var list = [];
      for (var i = 0; i < tabs.length && i < 15; i++) {
        list.push(i + '. "' + (tabs[i].title || '').slice(0, 60) + '" ' + (tabs[i].url || '').slice(0, 80));
      }
      reply({ tabs: list.join('\n') });
    });
    return true;
  }

  if (msg.type === 'tabAction') {
    if (msg.action === 'new_tab') {
      chrome.tabs.create({ url: msg.url || 'https://www.google.com' });
    } else if (msg.action === 'close_tab') {
      if (sender.tab) chrome.tabs.remove(sender.tab.id);
    } else if (msg.action === 'switch_tab') {
      chrome.tabs.query({ currentWindow: true }, function(tabs) {
        if (msg.index >= 0 && msg.index < tabs.length) {
          chrome.tabs.update(tabs[msg.index].id, { active: true });
        }
      });
    } else if (msg.action === 'search') {
      chrome.tabs.create({ url: 'https://www.google.com/search?q=' + encodeURIComponent(msg.query) });
    }
    reply({ ok: true });
    return true;
  }

  // ── Alfred conversation (Claude API) ──
  if (msg.type === 'alfred') {
    chrome.storage.local.get(['anthropicKey'], function(r) {
      if (!r.anthropicKey) { reply({ error: 'no_key' }); return; }
      callClaude(r.anthropicKey, msg.history || [], 0, function(resp) {
        if (resp.error) { reply({ error: resp.error }); return; }
        var parsed = extractJSON(resp.text);
        reply({ result: parsed });
      });
    });
    return true;
  }

  // ── Direct Claude for simplify/translate ──
  if (msg.type === 'claude') {
    chrome.storage.local.get(['anthropicKey'], function(r) {
      if (!r.anthropicKey) { reply({ error: 'no_key' }); return; }
      var prompt = msg.action === 'translate'
        ? 'Translate from ' + (msg.from === 'es' ? 'Spanish' : 'English') + ' to ' + (msg.to === 'es' ? 'Spanish' : 'English') + '. Return ONLY the translated text, nothing else.\n\n' + msg.text
        : (msg.lang === 'es' ? 'Simplifica este texto para que sea f\u00e1cil de entender. Solo devuelve el texto simplificado.\n\n' : 'Simplify this text so it\'s easy to understand. Return ONLY the simplified text.\n\n') + msg.text;
      callClaude(r.anthropicKey, [{ role: 'user', content: prompt }], 0, function(resp) {
        if (resp.error) { reply({ error: resp.error }); return; }
        reply({ result: resp.text });
      });
    });
    return true;
  }

  // ── ElevenLabs TTS ──
  if (msg.type === 'elevenTTS') {
    chrome.storage.local.get(['elevenKey', 'elevenVoice'], function(r) {
      if (!r.elevenKey || !r.elevenVoice) { reply({ error: 'no_eleven_key' }); return; }
      fetch('https://api.elevenlabs.io/v1/text-to-speech/' + r.elevenVoice + '?output_format=mp3_22050_32', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': r.elevenKey
        },
        body: JSON.stringify({
          text: msg.text,
          model_id: 'eleven_flash_v2_5',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 }
        })
      })
      .then(function(res) {
        if (!res.ok) {
          // Try fallback model for free tier
          if (res.status === 422 || res.status === 400) {
            return fetch('https://api.elevenlabs.io/v1/text-to-speech/' + r.elevenVoice + '?output_format=mp3_22050_32', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'xi-api-key': r.elevenKey },
              body: JSON.stringify({ text: msg.text, model_id: 'eleven_monolingual_v1', voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
            }).then(function(res2) { return res2.ok ? res2.blob() : null; });
          }
          reply({ error: 'ElevenLabs ' + res.status }); return null;
        }
        return res.blob();
      })
      .then(function(blob) {
        if (!blob) return;
        // Convert blob to base64 in chunks to avoid btoa size limits
        var reader = new FileReader();
        reader.onloadend = function() {
          reply({ audio: reader.result }); // data:audio/mpeg;base64,...
        };
        reader.onerror = function() { reply({ error: 'audio encode failed' }); };
        reader.readAsDataURL(blob);
      })
      .catch(function(err) { reply({ error: err.message }); });
    });
    return true;
  }

  // ── Test ElevenLabs key ──
  if (msg.type === 'testEleven') {
    fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': msg.key }
    })
    .then(function(res) {
      if (!res.ok) { reply({ ok: false, status: res.status }); return null; }
      return res.json();
    })
    .then(function(data) {
      if (!data) return;
      var voices = (data.voices || []).map(function(v) { return { id: v.voice_id, name: v.name }; });
      reply({ ok: true, voices: voices });
    })
    .catch(function(err) { reply({ ok: false, error: err.message }); });
    return true;
  }

  // ── Test Anthropic API key ──
  if (msg.type === 'testKey') {
    fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': msg.key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 20,
        messages: [{ role: 'user', content: 'Say "OK"' }]
      })
    })
    .then(function(res) { reply({ ok: res.ok, status: res.status }); })
    .catch(function(err) { reply({ ok: false, error: err.message }); });
    return true;
  }
});
