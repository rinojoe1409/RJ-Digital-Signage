import { constants, createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const cacheName = /^[a-f0-9]{64}$/i;
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const conflict = () => new Error('Ada berkas yang berbeda di folder konten. Cache lama tetap tersimpan; gunakan folder konten kosong atau pindahkan berkas yang bentrok.');

async function validCopy(filename, expectedHash) {
  const stat = await fs.lstat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink()) throw conflict();
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  if (hash.digest('hex') !== expectedHash) throw conflict();
  return true;
}

/** Copy verified media only. Private configuration and the old cache stay untouched. */
export async function prepareContentDirectory(legacyDirectory, contentDirectory) {
  const legacy = path.resolve(legacyDirectory), content = path.resolve(contentDirectory);
  const result = { copied: 0, reused: 0, skipped: 0 };
  try {
    await fs.mkdir(content, { recursive: true });
    const targetStat = await fs.lstat(content);
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) throw new Error('Folder konten harus berupa folder biasa, bukan tautan.');
    if (samePath(legacy, content)) return result;
    const legacyStat = await fs.lstat(legacy).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!legacyStat) return result;
    if (!legacyStat.isDirectory() || legacyStat.isSymbolicLink()) throw new Error('Folder cache lama tidak valid; isinya tidak dipindahkan.');
    const entries = await fs.readdir(legacy, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !cacheName.test(entry.name)) { result.skipped++; continue; }
      const expectedHash = entry.name.toLowerCase(), destination = path.join(content, expectedHash);
      if (await validCopy(destination, expectedHash)) { result.reused++; continue; }
      const source = path.join(legacy, entry.name), sourceStat = await fs.lstat(source);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size < 1) { result.skipped++; continue; }
      const temporary = path.join(content, `.rj-migrate-${randomUUID()}.part`);
      let handle, created = false;
      try {
        handle = await fs.open(temporary, 'wx', 0o600); created = true;
        const hash = createHash('sha256'); let size = 0;
        await pipeline(createReadStream(source), new Transform({ transform(chunk, encoding, callback) {
          size += chunk.length; hash.update(chunk); callback(null, chunk);
        } }), handle.createWriteStream());
        if (size !== sourceStat.size || hash.digest('hex') !== expectedHash) { result.skipped++; continue; }
        try {
          // A hard link publishes the complete temporary copy without replacing
          // an existing file. The old cache remains an independent file.
          try { await fs.link(temporary, destination); }
          catch (error) {
            if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(error.code)) throw error;
            await fs.copyFile(temporary, destination, constants.COPYFILE_EXCL);
          }
          result.copied++;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          if (await validCopy(destination, expectedHash)) result.reused++;
          else throw conflict();
        }
      } finally {
        await handle?.close().catch(() => {});
        if (created) await fs.rm(temporary, { force: true });
      }
    }
    return result;
  } catch (error) {
    if (['EACCES', 'EPERM', 'ENOSPC', 'ENOTDIR', 'EEXIST', 'EROFS'].includes(error.code)) {
      throw new Error('Folder konten belum dapat digunakan. Periksa lokasi, izin tulis, dan ruang disk. Cache lama tetap tersimpan.', { cause: error });
    }
    throw error;
  }
}
