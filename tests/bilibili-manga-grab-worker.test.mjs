import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../bilibili-manga-grab.user.js', import.meta.url), 'utf8');

function getWorkerSource() {
  const match = source.match(/function makeZipWorkerSource\(\) \{\n([\s\S]*?)\n  \}\n\n  function makeZipWorkerPayload/);
  assert.ok(match, 'makeZipWorkerSource function body should be extractable');
  return new Function(match[1])();
}

test('zip packaging has a worker path with main-thread fallback', () => {
  assert.match(source, /function makeZipWorkerSource\(\)/);
  assert.match(source, /async function createZipBlobInWorker\(/);
  assert.match(source, /async function createZipBlobInMainThread\(/);
  assert.match(source, /new Worker\(workerUrl\)/);
  assert.match(source, /worker\.terminate\(\)/);
  assert.match(source, /fallback to main-thread ZIP packing/);
});

test('worker reports progress and returns a transferable zip buffer', () => {
  assert.match(source, /type: 'progress'/);
  assert.match(source, /type: 'done'/);
  assert.match(source, /zipArrayBuffer/);
  assert.match(source, /const result = \{\s*type: 'done'/);
  assert.match(source, /self\.postMessage\(result, \[zipArrayBuffer\]\)/);
});

test('download button uses worker-created zip blobs', () => {
  assert.match(source, /const zipResult = await createZipBlobInWorker\(/);
  assert.match(source, /let zipBlob = zipResult\.blob/);
  assert.match(source, /const zipMB = zipResult\.zipMB/);
});

test('zip saving always uses browser download path', () => {
  assert.doesNotMatch(source, /showSaveFilePicker/);
  assert.match(source, /a\.download = filename/);
  assert.match(source, /return 'blob-url'/);
  assert.doesNotMatch(source, /return 'file-picker'/);
});

test('blob URLs use a clean iframe URL implementation', () => {
  assert.match(source, /let cleanURL = URL;/);
  assert.match(source, /let rawCreateObjectURL = URL\.createObjectURL;/);
  assert.match(source, /let rawRevokeObjectURL = URL\.revokeObjectURL;/);
  assert.match(source, /cleanURL = ifr\.contentWindow\.URL;/);
  assert.match(source, /rawCreateObjectURL = cleanURL\.createObjectURL;/);
  assert.match(source, /rawRevokeObjectURL = cleanURL\.revokeObjectURL;/);
  assert.match(source, /const createObjectURL = \(blob\) => rawCreateObjectURL\.call\(cleanURL, blob\);/);
  assert.match(source, /const revokeObjectURL = \(url\) => rawRevokeObjectURL\.call\(cleanURL, url\);/);
  assert.doesNotMatch(source, /URL\.createObjectURL\(workerBlob\)/);
  assert.doesNotMatch(source, /URL\.createObjectURL\(zipBlob\)/);
});

test('canvas capture uses clean toBlob and binary payloads instead of base64', () => {
  assert.match(source, /let rawToBlob = HTMLCanvasElement\.prototype\.toBlob;/);
  assert.match(source, /rawToBlob = ifr\.contentWindow\.HTMLCanvasElement\.prototype\.toBlob;/);
  assert.match(source, /rawToBlob\.call\(c, resolve, 'image\/png'\)/);
  assert.match(source, /const sigOfBytes = \(buffer\) =>/);
  assert.match(source, /captures\.push\(\{ bytes: first\.bytes, sig: first\.sig \}\)/);
  assert.match(source, /captures\.push\(\{ bytes: next\.bytes, sig: next\.sig \}\)/);
  assert.doesNotMatch(source, /captures\.push\(\{ b64:/);
});

test('zip blobs are cached in IndexedDB before download', () => {
  assert.match(source, /const ZIP_CACHE_DB_NAME =/);
  assert.match(source, /indexedDB\.open\(ZIP_CACHE_DB_NAME, 1\)/);
  assert.match(source, /db\.createObjectStore\(ZIP_CACHE_STORE, \{ keyPath: 'key' \}\)/);
  assert.match(source, /async function cacheZipBlob\(/);
  assert.match(source, /async function getCachedZipBlob\(/);
  assert.match(source, /async function deleteCachedZipBlob\(/);
  assert.match(source, /await cacheZipBlob\(\{/);
  assert.match(source, /zipBlob = null;/);
  assert.match(source, /await getCachedZipBlob\(zipEntry\.key\)/);
});

test('worker payload transfers binary ArrayBuffers', () => {
  assert.match(source, /transferables\.push\(c\.bytes\)/);
  assert.match(source, /worker\.postMessage\(\{ chapters: payload\.chapters \}, payload\.transferables\)/);
  assert.doesNotMatch(source, /return \{ b64: c\.b64 \}/);
});

test('worker source returned by makeZipWorkerSource is valid JavaScript', () => {
  const workerSource = getWorkerSource();
  assert.equal(workerSource.includes('Bilibili Manga Grabber'), false);
  assert.doesNotThrow(() => new vm.Script(workerSource));
});

test('worker source creates a readable store zip payload', () => {
  const messages = [];
  const context = {
    TextEncoder,
    Uint8Array,
    Uint32Array,
    ArrayBuffer,
    DataView,
    String,
    Error,
    self: {
      postMessage: (message) => messages.push(message),
    },
  };
  vm.runInNewContext(getWorkerSource(), context);

  const hello = Uint8Array.from(Buffer.from('hello')).buffer;
  const world = Uint8Array.from(Buffer.from('world')).buffer;
  context.self.onmessage({
    data: {
      chapters: [{
        folderName: '001_第1话',
        captures: [{ bytes: hello }, { bytes: world }],
      }],
    },
  });

  const done = messages.find((message) => message.type === 'done');
  assert.ok(done, 'worker should post a done message');
  const zip = Buffer.from(done.zipArrayBuffer);
  const files = [];
  let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const method = zip.readUInt16LE(offset + 8);
    const compressedSize = zip.readUInt32LE(offset + 18);
    const fileNameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + fileNameLength + extraLength;
    const name = zip.subarray(nameStart, nameStart + fileNameLength).toString('utf8');
    const data = zip.subarray(dataStart, dataStart + compressedSize).toString('utf8');
    files.push({ name, data, method });
    offset = dataStart + compressedSize;
  }

  assert.deepEqual(files, [
    { name: '001_第1话/page_001.png', data: 'hello', method: 0 },
    { name: '001_第1话/page_002.png', data: 'world', method: 0 },
  ]);
  assert.equal(zip.readUInt32LE(offset), 0x02014b50, 'central directory should follow local files');
});
