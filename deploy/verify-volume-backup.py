#!/usr/bin/env python3
"""Restore a private volume archive into scratch space and verify it read-only.

Never prints store contents, credentials, filenames, or media contents.
"""
import hashlib
from contextlib import closing
import json
import pathlib
import re
import sqlite3
import sys
import tarfile
import tempfile


def digest(filename):
    with filename.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def inventory(root):
    result = {}
    for filename in root.rglob('*'):
        if filename.is_symlink():
            raise ValueError('Volume/backup tidak boleh berisi symlink.')
        if filename.is_file():
            result[filename.relative_to(root).as_posix()] = (filename.stat().st_size, digest(filename))
        elif not filename.is_dir():
            raise ValueError('Jenis berkas volume tidak didukung.')
    return result


def verify(archive, source):
    with tempfile.TemporaryDirectory(prefix='verify-restore-', dir=archive.parent) as directory:
        restored = pathlib.Path(directory)
        with tarfile.open(archive, 'r:gz') as package:
            seen = set()
            for member in package.getmembers():
                item = pathlib.PurePosixPath(member.name)
                normalized = item.as_posix()
                if item.is_absolute() or '..' in item.parts or normalized in seen:
                    raise ValueError('Path arsip tidak valid.')
                if not (member.isfile() or member.isdir()):
                    raise ValueError('Jenis entri arsip tidak didukung.')
                seen.add(normalized)
            package.extractall(restored, filter='data')
        files = inventory(restored)
        if source is not None and files != inventory(source):
            raise ValueError('Isi backup berbeda dari volume yang dihentikan.')
        database = restored / 'signage.sqlite'
        if not database.is_file():
            raise ValueError('Database tidak tersedia dalam backup.')
        # This is the scratch copy only. SQLite may replay its copied WAL here.
        with closing(sqlite3.connect(database)) as db:
            if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                raise ValueError('Integritas database backup gagal.')
            row = db.execute('SELECT value FROM store WHERE id=1').fetchone()
            if not row:
                raise ValueError('State database backup tidak tersedia.')
            state = json.loads(row[0])
        if state.get('schema') != 1 or not state.get('admin'):
            raise ValueError('Schema/admin backup tidak sesuai dengan CMS operasional.')
        media = state.get('media', [])
        for item in media:
            media_id = item.get('id', '')
            if not re.fullmatch(r'[a-zA-Z0-9_-]{1,90}', media_id):
                raise ValueError('ID media tidak valid.')
            saved = files.get('media/' + media_id)
            if saved != (item['size'], item['sha256']):
                raise ValueError('Media backup tidak cocok dengan database.')
        print(f'BACKUP_RESTORE=PASS SQLITE_INTEGRITY=PASS FILES={len(files)} MEDIA={len(media)}')


if __name__ == '__main__':
    if len(sys.argv) not in (2, 3):
        raise SystemExit('Usage: verify-volume-backup.py ARCHIVE [STOPPED_VOLUME_PATH]')
    try:
        verify(pathlib.Path(sys.argv[1]).resolve(), pathlib.Path(sys.argv[2]).resolve() if len(sys.argv) == 3 else None)
    except Exception as error:
        # Do not expose raw exceptions that can contain sensitive file paths/data.
        raise SystemExit('BACKUP_VERIFY=FAIL (' + type(error).__name__ + ')') from None
