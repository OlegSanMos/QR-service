import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeFiles, packFiles, peekContainerInfo, unpackContainer, type FileEntry } from '../src/core/container';
import { crc32 } from '../src/core/crc32';
import { Prng } from '../src/core/prng';
import { createZip } from '../src/core/zip';

const enc = new TextEncoder();
const text = enc.encode(Array.from({ length: 300 }, (_, i) => `Запись ${i}: передача файлов через QR, value=${(i * 7919) % 1000}\n`).join(''));
function random(n: number, seed = 1): Uint8Array {
  const rng = new Prng(seed);
  return new Uint8Array(n).map(() => rng.nextU32() & 255);
}

describe('container v2', () => {
  it('round-trips several files (names with folders, empty file) with every method', async () => {
    const files: FileEntry[] = [
      { name: 'docs/заметка.txt', mime: 'text/plain', data: text },
      { name: 'docs/empty.bin', mime: '', data: new Uint8Array(0) },
      { name: 'photo.jpg', mime: 'image/jpeg', data: random(3000) },
    ];
    for (const method of ['store', 'deflate', 'cm'] as const) {
      const packed = await packFiles(files, { method });
      expect(packed.method).toBe(method);
      const info = peekContainerInfo(packed.stream)!;
      expect(info.files.map((f) => [f.name, f.size])).toEqual([['docs/заметка.txt', text.length], ['docs/empty.bin', 0], ['photo.jpg', 3000]]);
      expect(info.files[1].mime).toBe('application/octet-stream');
      const out = await unpackContainer(packed.stream);
      expect(out.method).toBe(method);
      expect(out.files.map((f) => f.name)).toEqual(files.map((f) => f.name));
      out.files.forEach((f, i) => expect(Buffer.from(f.data).equals(Buffer.from(files[i].data))).toBe(true));
    }
  });

  it('auto: context mixing wins on text when the link is the bottleneck', async () => {
    // Tiny inputs on a fast link are not worth CM's fixed cost; a slow link makes every byte count.
    const r = await packFiles([{ name: 'a.txt', mime: 'text/plain', data: text }], { linkBytesPerSecond: 2_000 });
    expect(r.method).toBe('cm');
    const deflate = r.candidates.find((c) => c.method === 'deflate')!;
    expect(r.stream.length).toBeLessThan(deflate.size);
  });

  it('auto: random data is stored, CM is not even tried', async () => {
    const r = await packFiles([{ name: 'r.bin', mime: '', data: random(20_000) }]);
    expect(r.method).toBe('store');
    expect(r.candidates.some((c) => c.method === 'cm')).toBe(false);
  });

  it('auto: abandons context mixing when its time would not pay off', async () => {
    // A fake clock that stands still for deflate and then makes CM absurdly slow
    // (1 s per 64 KB step), with a very fast link: CM can never pay for itself.
    let calls = 0;
    const now = (): number => (++calls <= 2 ? 0 : (calls - 2) * 1000);
    const big = new Uint8Array(text.length * 30);
    for (let i = 0; i < 30; i++) big.set(text, i * text.length);
    const r = await packFiles([{ name: 'big.txt', mime: 'text/plain', data: big }], {
      linkBytesPerSecond: 50_000_000,
      now,
    });
    expect(r.method).toBe('deflate');
    expect(r.candidates.find((c) => c.method === 'cm')?.aborted).toBe(true);
  });

  it('auto: a remembered choice gives the same stream however slow the CPU is now', async () => {
    // First run: CM pays off on a slow link. Second run: CM looks hopeless on this
    // (fake) clock and would lose to deflate, but the remembered choice wins, so a
    // restarted sender produces the same stream and transfer id.
    const big = new Uint8Array(text.length * 30);
    for (let i = 0; i < 30; i++) big.set(text, i * text.length);
    const files = [{ name: 'big.txt', mime: 'text/plain', data: big }];
    const first = await packFiles(files, { linkBytesPerSecond: 2_000, now: () => 0 }); // a fast CPU
    expect(first.method).toBe('cm');
    let calls = 0;
    const slow = (): number => (++calls <= 2 ? 0 : (calls - 2) * 1000);
    const fresh = await packFiles(files, { linkBytesPerSecond: 50_000_000, now: slow });
    expect(fresh.method).toBe('deflate');
    expect(fresh.key).toBe(first.key); // the key names the content, not the method
    calls = 0;
    const again = await packFiles(files, { linkBytesPerSecond: 50_000_000, now: slow, rememberedMethod: (k) => (k === first.key ? first.method : undefined) });
    expect(again.method).toBe('cm');
    expect(Buffer.from(again.stream).equals(Buffer.from(first.stream))).toBe(true);
    // Other content (here: another name) is not affected.
    const other = await packFiles([{ ...files[0], name: 'other.txt' }], { method: 'store' });
    expect(other.key).not.toBe(first.key);
  });

  it('detects corruption', async () => {
    const r = await packFiles([{ name: 'a.txt', mime: 'text/plain', data: text }], { method: 'store' });
    r.stream[r.stream.length - 1] ^= 1;
    await expect(unpackContainer(r.stream)).rejects.toThrow(/CRC/);
  });

  it('peeks the file list from a partial stream only once the header is complete', async () => {
    const files = Array.from({ length: 50 }, (_, i) => ({ name: `folder/file-${i}.txt`, mime: 'text/plain', data: enc.encode(`file ${i}`) }));
    const r = await packFiles(files, { method: 'store' });
    const full = peekContainerInfo(r.stream)!;
    expect(full.files.length).toBe(50);
    expect(peekContainerInfo(r.stream.subarray(0, full.headerLength - 1))).toBeNull();
    expect(peekContainerInfo(r.stream.subarray(0, full.headerLength))?.files.length).toBe(50);
  });

  it('still reads version 1 streams from older senders', async () => {
    const data = enc.encode('старый формат');
    const name = enc.encode('old.txt');
    const mime = enc.encode('text/plain');
    const s = new Uint8Array(13 + name.length + mime.length + data.length);
    const v = new DataView(s.buffer);
    v.setUint8(0, 1);
    v.setUint8(1, 0);
    v.setUint32(2, data.length, true);
    v.setUint32(6, crc32(data), true);
    v.setUint16(10, name.length, true);
    s.set(name, 12);
    s[12 + name.length] = mime.length;
    s.set(mime, 13 + name.length);
    s.set(data, 13 + name.length + mime.length);
    const out = await unpackContainer(s);
    expect(out.files[0].name).toBe('old.txt');
    expect(new TextDecoder().decode(out.files[0].data)).toBe('старый формат');
  });

  it('describes file counts in Russian', () => {
    expect(describeFiles([{ name: 'a.txt' }])).toBe('a.txt');
    expect(describeFiles(Array(2).fill({ name: 'x' }))).toBe('2 файла');
    expect(describeFiles(Array(5).fill({ name: 'x' }))).toBe('5 файлов');
    expect(describeFiles(Array(21).fill({ name: 'x' }))).toBe('21 файл');
    expect(describeFiles(Array(12).fill({ name: 'x' }))).toBe('12 файлов');
  });
});

describe('zip', () => {
  it('produces an archive that standard tools extract', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qr-zip-'));
    const zip = createZip([
      { name: 'docs/заметка.txt', data: text },
      { name: 'empty.bin', data: new Uint8Array(0) },
    ]);
    writeFileSync(join(dir, 'all.zip'), zip);
    const listing = execFileSync('python3', ['-I', '-c', `
import zipfile, sys
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
for i in z.infolist(): print(i.filename, i.file_size)
open(sys.argv[2], 'wb').write(z.read('docs/заметка.txt'))
`, join(dir, 'all.zip'), join(dir, 'out.txt')]).toString();
    expect(listing).toContain(`docs/заметка.txt ${text.length}`);
    expect(listing).toContain('empty.bin 0');
    expect(readFileSync(join(dir, 'out.txt')).equals(Buffer.from(text))).toBe(true);
  });
});
