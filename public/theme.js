// Runs before the page paints, so there is no flash of the wrong look.
// Theme: auto (follow the phone) / light / dark.   Look: soft / terminal.
(function () {
  var mq = matchMedia('(prefers-color-scheme: light)');
  var BG = { soft: { light: '#F8F9FD', dark: '#111318' }, terminal: { light: '#F4F1EA', dark: '#0B0D0C' } };
  function get(k, d) { try { return JSON.parse(localStorage.getItem('cm:' + k)) || d; } catch (e) { return d; } }
  // A link can choose the look once: /?look=terminal
  var q = /[?&]look=(soft|terminal)\b/.exec(location.search);
  if (q) { try { localStorage.setItem('cm:look', JSON.stringify(q[1])); } catch (e) {} }
  function pick() { return get('theme', 'auto'); }
  function look() { var l = get('look', 'soft'); return BG[l] ? l : 'soft'; }
  function apply() {
    var t = pick(), r = t === 'auto' ? (mq.matches ? 'light' : 'dark') : t, l = look();
    document.documentElement.dataset.theme = r;
    document.documentElement.dataset.look = l;
    var m = document.querySelector('meta[name=theme-color]'); if (m) m.content = BG[l][r];
  }
  apply();
  mq.addEventListener('change', apply);
  window.cmTheme = { apply: apply, pick: pick, look: look };
})();
