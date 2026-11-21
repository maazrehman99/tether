// Small, safe Markdown renderer for Claude replies (everything is escaped first).
(function () {
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Light colouring for code blocks: comments, strings, numbers, keywords. Each piece is escaped.
  const KW = new Set('if else elif for while do return function def class const let var import from export default async await try except catch finally throw raise new this self in of is not and or None null undefined true false True False with as yield break continue switch case pass lambda interface type extends implements public private static void int str bool echo then fi done esac local'.split(' '));
  const HASH = /^(py|python|sh|bash|zsh|shell|console|yaml|yml|toml|rb|ruby|r|conf|ini|dockerfile|makefile|nix|perl)$/i;
  function highlight(code, lang) {
    if (/^diff$/i.test(lang)) return code.split('\n').map((l) => {
      const c = l.startsWith('+') ? 'tk-add' : l.startsWith('-') ? 'tk-del' : l.startsWith('@@') ? 'tk-com' : '';
      return c ? `<span class="${c}">${esc(l)}</span>` : esc(l);
    }).join('\n');
    if (/^(md|markdown|text|txt|plain|code)?$/i.test(lang) && !/[{};=()]/.test(code)) return esc(code);
    const com = HASH.test(lang) ? '#[^\\n]*' : '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/';
    const re = new RegExp(`(${com}|<!--[\\s\\S]*?-->)|("(?:\\\\.|[^"\\\\\\n])*"|'(?:\\\\.|[^'\\\\\\n])*'|\`(?:\\\\.|[^\`\\\\])*\`)|\\b(\\d+(?:\\.\\d+)?)\\b|([A-Za-z_$][\\w$]*)(?=\\s*\\()|([A-Za-z_$][\\w$]*)`, 'g');
    let out = '', last = 0, m;
    while ((m = re.exec(code))) {
      out += esc(code.slice(last, m.index)); last = re.lastIndex;
      const [t, c1, c2, c3, c4, c5] = m;
      if (c1) out += `<span class="tk-com">${esc(t)}</span>`;
      else if (c2) out += `<span class="tk-str">${esc(t)}</span>`;
      else if (c3) out += `<span class="tk-num">${t}</span>`;
      else if (c4) out += KW.has(c4) ? `<span class="tk-kw">${c4}</span>` : `<span class="tk-fn">${c4}</span>`;
      else out += KW.has(c5) ? `<span class="tk-kw">${c5}</span>` : esc(t);
    }
    return out + esc(code.slice(last));
  }

  function inline(s) {
    // Code spans and finished links are parked as numbered placeholders, so later passes can't reach
    // inside them (an autolink inside an href used to break the quote and add attributes).
    const codes = [], links = [];
    s = String(s).replace(/[\u0000\u0001]/g, '');
    s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    s = esc(s);
    const park = (html) => { links.push(html); return '\u0001' + (links.length - 1) + '\u0001'; };
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)"'<>]+)\)/g, (_, t, u) => park(`<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`));
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)"']+[^\s<).,;:!?'"])/g, (_, p, u) => p + park(`<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`));
    s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_\n]+?)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_\w])_([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');
    s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => links[+i] ?? '');
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i] ?? '')}</code>`);
    return s;
  }

  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

  function render(src, streaming) {
    const lines = src.replace(/\r/g, '').split('\n');
    let out = '';
    let i = 0;
    let para = [];
    const flushPara = () => { if (para.length) { out += '<p>' + para.map(inline).join('<br>') + '</p>'; para = []; } };

    while (i < lines.length) {
      const line = lines[i];

      const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)/);
      if (fence) {
        flushPara();
        const mark = fence[1];
        const lang = fence[2] || '';
        const body = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(mark)) body.push(lines[i++]);
        i++;
        out += `<div class="code"><div class="code-head"><span>${esc(lang || 'code')}</span><button data-copy>Copy</button></div><pre><code>${highlight(body.join('\n'), lang)}</code></pre></div>`;
        continue;
      }

      if (/^\s*$/.test(line)) { flushPara(); i++; continue; }

      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { flushPara(); const n = Math.min(h[1].length, 3); out += `<h${n}>${inline(h[2])}</h${n}>`; i++; continue; }

      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); out += '<hr>'; i++; continue; }

      if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        flushPara();
        const head = cells(line);
        i += 2;
        let t = '<div class="table"><table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          t += '<tr>' + cells(lines[i]).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>';
          i++;
        }
        out += t + '</tbody></table></div>';
        continue;
      }

      if (/^\s*>/.test(line)) {
        flushPara();
        const q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
        out += '<blockquote>' + render(q.join('\n')) + '</blockquote>';
        continue;
      }

      const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (li) {
        flushPara();
        const ordered = /\d/.test(li[2]);
        const tag = ordered ? 'ol' : 'ul';
        const start = ordered ? parseInt(li[2], 10) : 1;
        let html = `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>`;
        const baseIndent = li[1].length;
        while (i < lines.length) {
          const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
          if (!m) {
            // continuation line of the previous item
            if (/^\s{2,}\S/.test(lines[i]) && !/^\s*$/.test(lines[i])) { { const add = ' ' + inline(lines[i].trim()) + '</li>'; html = html.replace(/<\/li>$/, () => add); } i++; continue; }
            break;
          }
          if (m[1].length > baseIndent + 1) {
            // nested list: collect and render recursively
            const sub = [];
            while (i < lines.length) {
              const n = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+/);
              if (n && n[1].length <= baseIndent + 1) break;
              if (!n && !/^\s{2,}\S/.test(lines[i])) break;
              sub.push(lines[i].slice(Math.min(baseIndent + 2, lines[i].search(/\S|$/))));
              i++;
            }
            const inner = render(sub.join('\n')) + '</li>';
            html = html.replace(/<\/li>$/, () => inner);
            continue;
          }
          let text = m[3];
          const task = text.match(/^\[([ xX])\]\s+(.*)$/);
          if (task) text = (task[1] === ' ' ? '☐ ' : '☑ ') + task[2];
          html += `<li>${inline(text)}</li>`;
          i++;
        }
        out += html + `</${tag}>`;
        continue;
      }

      para.push(line);
      i++;
    }
    flushPara();
    return out;
  }

  // Never let one bad message stop the app from starting: fall back to plain text.
  window.renderMarkdown = (src, streaming) => { try { return render(String(src ?? ''), streaming); } catch (e) { return '<p>' + esc(String(src ?? '')).replace(/\n/g, '<br>') + '</p>'; } };
  window.escapeHtml = esc;
})();
