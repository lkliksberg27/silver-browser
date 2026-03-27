// ── Load saved settings ──
chrome.storage.local.get(['anthropicKey', 'lang', 'elevenKey', 'elevenVoice'], function(r) {
  if (r.anthropicKey) document.getElementById('key').value = r.anthropicKey;
  if (r.elevenKey) document.getElementById('eleven-key').value = r.elevenKey;
  if (r.lang === 'es') {
    document.getElementById('lang-es').classList.add('active');
    document.getElementById('lang-en').classList.remove('active');
  }
  // If we have an ElevenLabs key, load voices
  if (r.elevenKey) {
    loadElevenVoices(r.elevenKey, r.elevenVoice);
  }
});

// ── Anthropic Key ──
document.getElementById('save').addEventListener('click', function() {
  var key = document.getElementById('key').value.trim();
  if (!key) return;
  chrome.storage.local.set({ anthropicKey: key }, function() {
    flash('saved-msg');
  });
});

document.getElementById('test').addEventListener('click', function() {
  var key = document.getElementById('key').value.trim();
  var el = document.getElementById('test-result');
  if (!key) { showResult(el, 'fail', 'Enter an API key first.'); return; }
  showResult(el, 'loading', 'Testing...');
  document.getElementById('test').disabled = true;
  chrome.runtime.sendMessage({ type: 'testKey', key: key }, function(resp) {
    document.getElementById('test').disabled = false;
    if (resp && resp.ok) showResult(el, 'ok', 'API key works!');
    else showResult(el, 'fail', 'Failed: ' + (resp && resp.status === 401 ? 'Invalid key.' : resp && resp.error || 'Status ' + (resp ? resp.status : '?')));
  });
});

// ── ElevenLabs ──
document.getElementById('eleven-save').addEventListener('click', function() {
  var key = document.getElementById('eleven-key').value.trim();
  var el = document.getElementById('eleven-result');
  if (!key) {
    // Clear ElevenLabs — go back to browser TTS
    chrome.storage.local.remove(['elevenKey', 'elevenVoice']);
    document.getElementById('eleven-voice').innerHTML = '<option value="">Browser default (no ElevenLabs)</option>';
    showResult(el, 'ok', 'Cleared. Using browser voice.');
    return;
  }
  showResult(el, 'loading', 'Connecting to ElevenLabs...');
  document.getElementById('eleven-save').disabled = true;
  chrome.runtime.sendMessage({ type: 'testEleven', key: key }, function(resp) {
    document.getElementById('eleven-save').disabled = false;
    if (resp && resp.ok) {
      chrome.storage.local.set({ elevenKey: key });
      showResult(el, 'ok', 'Connected! ' + resp.voices.length + ' voices loaded.');
      populateVoices(resp.voices);
    } else {
      showResult(el, 'fail', 'Failed: ' + (resp && resp.status === 401 ? 'Invalid key.' : resp && resp.error || 'Error'));
    }
  });
});

document.getElementById('eleven-voice').addEventListener('change', function() {
  var voiceId = this.value;
  chrome.storage.local.set({ elevenVoice: voiceId }, function() {
    flash('eleven-saved');
  });
});

document.getElementById('eleven-test-voice').addEventListener('click', function() {
  var voiceId = document.getElementById('eleven-voice').value;
  if (!voiceId) { alert('Select a voice first.'); return; }
  var btn = document.getElementById('eleven-test-voice');
  btn.disabled = true;
  btn.textContent = 'Playing...';
  chrome.runtime.sendMessage({ type: 'elevenTTS', text: 'Hello, I am Alfred, your browsing assistant.' }, function(resp) {
    btn.disabled = false;
    btn.textContent = 'Preview Voice';
    if (resp && resp.audio) {
      var audio = new Audio(resp.audio);
      audio.play();
    } else {
      var el = document.getElementById('eleven-result');
      showResult(el, 'fail', 'Preview failed: ' + (resp ? resp.error : 'no response'));
    }
  });
});

function loadElevenVoices(key, selectedId) {
  chrome.runtime.sendMessage({ type: 'testEleven', key: key }, function(resp) {
    if (resp && resp.ok) {
      populateVoices(resp.voices, selectedId);
    }
  });
}

function populateVoices(voices, selectedId) {
  var sel = document.getElementById('eleven-voice');
  sel.innerHTML = '<option value="">Browser default (no ElevenLabs)</option>';
  for (var i = 0; i < voices.length; i++) {
    var opt = document.createElement('option');
    opt.value = voices[i].id;
    opt.textContent = voices[i].name;
    if (voices[i].id === selectedId) opt.selected = true;
    sel.appendChild(opt);
  }
  // If we have a saved voice, select it
  if (selectedId && !sel.value) {
    chrome.storage.local.get(['elevenVoice'], function(r) {
      if (r.elevenVoice) sel.value = r.elevenVoice;
    });
  }
}

// ── Language ──
document.getElementById('lang-en').addEventListener('click', function() {
  chrome.storage.local.set({ lang: 'en' });
  document.getElementById('lang-en').classList.add('active');
  document.getElementById('lang-es').classList.remove('active');
});

document.getElementById('lang-es').addEventListener('click', function() {
  chrome.storage.local.set({ lang: 'es' });
  document.getElementById('lang-es').classList.add('active');
  document.getElementById('lang-en').classList.remove('active');
});

// ── Helpers ──
function flash(id) {
  var el = document.getElementById(id);
  el.style.display = 'block';
  setTimeout(function() { el.style.display = 'none'; }, 3000);
}

function showResult(el, type, msg) {
  el.textContent = msg;
  el.className = 'test-result test-' + type;
  if (type !== 'loading') setTimeout(function() { el.className = 'test-result'; }, 8000);
}
