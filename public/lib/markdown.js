// Markdown subset → HTML. Escapes everything first, then adds a fixed set of
// tags, so stored text can never smuggle markup or script into the page.
// Supported: paragraphs, line breaks, **bold**, *italic*, `code`, ``` blocks,
// - / 1. lists, > quotes, # headings, [text](https://…), bare URLs, and
// mentions written as @[Name](user:ID).

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function inline(s) {
  // s is already escaped
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/@\[([^\]]{1,120})\]\(user:(\d+)\)/g, (_, name, id) => `<a class="mention" href="#/people/${id}">@${name}</a>`);
  s = s.replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g, (_, text, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`);
  s = s.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g, (_, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  return s;
}

export function md(text) {
  if (!text) return '';
  const lines = esc(String(text)).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${buf.join('\n')}</code></pre>`);
      continue;
    }
    if (/^\s*[-*] /.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*] /.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*] /, ''));
      out.push('<ul>' + items.map(x => `<li>${inline(x)}</li>`).join('') + '</ul>');
      continue;
    }
    if (/^\s*\d+[.)] /.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)] /.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)] /, ''));
      out.push('<ol>' + items.map(x => `<li>${inline(x)}</li>`).join('') + '</ol>');
      continue;
    }
    if (/^&gt; ?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^&gt; ?/.test(lines[i])) buf.push(lines[i++].replace(/^&gt; ?/, ''));
      out.push(`<blockquote>${inline(buf.join('<br>'))}</blockquote>`);
      continue;
    }
    const hm = /^(#{1,3}) (.*)$/.exec(line);
    if (hm) { out.push(`<h${hm[1].length + 1}>${inline(hm[2])}</h${hm[1].length + 1}>`); i++; continue; }
    if (!line.trim()) { i++; continue; }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(```|\s*[-*] |\s*\d+[.)] |&gt; |#{1,3} )/.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join('<br>'))}</p>`);
  }
  return out.join('');
}

// Plain text for previews (mentions → @Name, markup stripped).
export function plain(text, max = 140) {
  if (!text) return '';
  const s = String(text).replace(/@\[([^\]]+)\]\(user:\d+\)/g, '@$1').replace(/[*`#>]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// Search snippets mark matches with \u0002…\u0003; escape, then mark.
export function snippet(s) {
  return esc(String(s || '')).replace(/\u0002/g, '<mark>').replace(/\u0003/g, '</mark>');
}
