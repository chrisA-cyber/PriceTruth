'use strict';

(function () {
  var list = document.getElementById('site-list');
  var status = document.getElementById('status');
  var adapters = window.PTAdapters.ADAPTERS.filter(function (a) { return !a.demo; });

  function readSettings(done) {
    chrome.storage.local.get({ disabledAdapters: [] }, function (result) {
      done(Array.isArray(result.disabledAdapters) ? result.disabledAdapters : []);
    });
  }

  function save(disabled) {
    chrome.storage.local.set({ disabledAdapters: disabled }, function () {
      status.textContent = 'Saved';
      window.setTimeout(function () { status.textContent = ''; }, 1500);
    });
  }

  readSettings(function (disabled) {
    adapters.forEach(function (adapter) {
      var label = document.createElement('label');
      label.className = 'site';
      var input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = disabled.indexOf(adapter.id) === -1;
      input.dataset.adapter = adapter.id;
      var copy = document.createElement('span');
      copy.innerHTML = '<strong></strong><small></small>';
      copy.querySelector('strong').textContent = adapter.site;
      copy.querySelector('small').textContent = adapter.vertical + ' price context · ' + adapter.domains.join(', ');
      label.appendChild(input);
      label.appendChild(copy);
      list.appendChild(label);
    });
    list.addEventListener('change', function () {
      var next = Array.prototype.filter.call(list.querySelectorAll('input'), function (input) { return !input.checked; })
        .map(function (input) { return input.dataset.adapter; });
      save(next);
    });
  });
})();
