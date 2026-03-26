chrome.storage.local.get(['anthropicKey', 'lang'], function(r) {
  if (r.anthropicKey) document.getElementById('key').value = r.anthropicKey;
  if (r.lang === 'es') {
    document.getElementById('lang-es').classList.add('active');
    document.getElementById('lang-en').classList.remove('active');
  }
});

document.getElementById('save').addEventListener('click', function() {
  var key = document.getElementById('key').value.trim();
  if (!key) return;
  chrome.storage.local.set({ anthropicKey: key }, function() {
    var msg = document.getElementById('saved-msg');
    msg.style.display = 'block';
    setTimeout(function() { msg.style.display = 'none'; }, 3000);
  });
});

// Test API key
document.getElementById('test').addEventListener('click', function() {
  var key = document.getElementById('key').value.trim();
  var el = document.getElementById('test-result');
  var btn = document.getElementById('test');

  if (!key) {
    el.className = 'test-result test-fail';
    el.textContent = 'Enter an API key first.';
    return;
  }

  btn.disabled = true;
  el.className = 'test-result test-loading';
  el.textContent = 'Testing connection...';

  chrome.runtime.sendMessage({ type: 'testKey', key: key }, function(resp) {
    btn.disabled = false;
    if (resp && resp.ok) {
      el.className = 'test-result test-ok';
      el.textContent = 'API key works! You\'re all set.';
    } else {
      el.className = 'test-result test-fail';
      var reason = '';
      if (resp && resp.status === 401) reason = 'Invalid key.';
      else if (resp && resp.status === 403) reason = 'Key not authorized.';
      else if (resp && resp.status === 429) reason = 'Rate limited — try again in a moment.';
      else if (resp && resp.error) reason = resp.error;
      else reason = 'Could not connect (status: ' + (resp ? resp.status : 'unknown') + ')';
      el.textContent = 'Failed: ' + reason;
    }
    setTimeout(function() { el.style.display = 'none'; el.className = 'test-result'; }, 8000);
  });
});

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
