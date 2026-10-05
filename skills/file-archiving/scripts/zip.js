/** Generic skill script ABI: run({inputs, options}, {JSZip}) -> {files}. Inputs are brokered, base64 file contents. */
async function run(input, api) {
  if (!Array.isArray(input.inputs) || input.inputs.length === 0) throw new Error('Select at least one file or folder');
  const zip = new api.JSZip();
  const names = new Set();
  for (const file of input.inputs) {
    if (!file.name || file.name.startsWith('/') || file.name.split('/').some(p => p === '..')) throw new Error('Unsafe archive entry');
    if (names.has(file.name)) throw new Error(`Duplicate archive entry: ${file.name}`);
    names.add(file.name);
    if (file.directory) zip.folder(file.name);
    else zip.file(file.name, file.data, { base64: true, date: new Date('2000-01-01T00:00:00Z') });
  }
  return { files: [{ name: 'archive.zip', mimeType: 'application/zip', data: await zip.generateAsync({ type: 'base64', compression: 'DEFLATE' }) }] };
}
