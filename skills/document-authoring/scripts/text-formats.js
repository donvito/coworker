async function run(input) {
  const { format, content, title = 'Document', rows } = input.options;
  const escape = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  let text, mimeType;
  if (format === 'json') { text = JSON.stringify(typeof content === 'string' ? JSON.parse(content) : content, null, 2) + '\n'; mimeType = 'application/json'; }
  else if (format === 'tsv') {
    if (!Array.isArray(rows) || !rows.every(Array.isArray)) throw new Error('TSV requires rows: an array of arrays');
    text = rows.map(row => row.map(value => { const s = String(value ?? ''); return /[\t\r\n"]/.test(s) ? '"' + s.replaceAll('"','""') + '"' : s; }).join('\t')).join('\n') + '\n'; mimeType = 'text/tab-separated-values';
  } else if (format === 'html') {
    if (typeof content !== 'string') throw new Error('HTML requires text content');
    text = '<!doctype html><html><head><meta charset="utf-8"><title>' + escape(title) + '</title></head><body><h1>' + escape(title) + '</h1>' + content.split(/\n\s*\n/).map(p => '<p>' + escape(p).replaceAll('\n','<br>') + '</p>').join('\n') + '</body></html>'; mimeType = 'text/html';
  } else throw new Error('Choose html, json, or tsv');
  const bytes = new TextEncoder().encode(text); let binary = '';
  for (let i=0;i<bytes.length;i+=8192) binary += String.fromCharCode(...bytes.subarray(i,i+8192));
  return { files: [{ name: 'document.' + format, mimeType, data: btoa(binary) }] };
}
