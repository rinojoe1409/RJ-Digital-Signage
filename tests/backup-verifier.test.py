"""Checks real SQLite/media restore and rejection before a production switch."""
from contextlib import closing
import hashlib
import importlib.util
import io
import json
import pathlib
import sqlite3
import tarfile
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('backup_verifier', ROOT / 'deploy' / 'verify-volume-backup.py')
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


class BackupVerifierTests(unittest.TestCase):
    def setUp(self):
        (ROOT / 'tmp').mkdir(exist_ok=True)
        self.scratch = tempfile.TemporaryDirectory(prefix='backup-verify-test-', dir=ROOT / 'tmp')
        self.root = pathlib.Path(self.scratch.name)
        self.volume = self.root / 'volume'
        (self.volume / 'media').mkdir(parents=True)
        self.media = b'private-test-media-not-user-data'
        (self.volume / 'media' / 'test-video').write_bytes(self.media)
        state = {'schema': 1, 'admin': {'username': 'isolated-fixture'}, 'media': [
            {'id': 'test-video', 'size': len(self.media), 'sha256': hashlib.sha256(self.media).hexdigest()}]}
        with closing(sqlite3.connect(self.volume / 'signage.sqlite')) as db:
            db.execute('CREATE TABLE store (id INTEGER PRIMARY KEY, value TEXT)')
            db.execute('INSERT INTO store VALUES (1, ?)', (json.dumps(state),))
            db.commit()
        self.archive = self.root / 'volume.tar.gz'
        self.pack()

    def tearDown(self):
        self.scratch.cleanup()

    def pack(self):
        with tarfile.open(self.archive, 'w:gz') as archive:
            archive.add(self.volume, arcname='.')

    def test_restores_sqlite_and_media_without_changing_source(self):
        before = verifier.inventory(self.volume)
        verifier.verify(self.archive, self.volume)
        self.assertEqual(verifier.inventory(self.volume), before)
        self.assertEqual(list(self.root.glob('verify-restore-*')), [])

    def test_rejects_source_that_no_longer_matches_backup(self):
        (self.volume / 'media' / 'test-video').write_bytes(b'changed')
        with self.assertRaises(ValueError):
            verifier.verify(self.archive, self.volume)

    def test_independent_copy_can_be_restored_without_source_volume(self):
        verifier.verify(self.archive, None)
        self.assertEqual(list(self.root.glob('verify-restore-*')), [])

    def test_rejects_archive_whose_media_disagrees_with_database(self):
        (self.volume / 'media' / 'test-video').write_bytes(b'changed')
        self.pack()
        with self.assertRaises(ValueError):
            verifier.verify(self.archive, self.volume)

    def test_rejects_traversal_without_writing_outside_scratch(self):
        with tarfile.open(self.archive, 'w:gz') as archive:
            entry = tarfile.TarInfo('../escape-test')
            entry.size = 1
            archive.addfile(entry, io.BytesIO(b'x'))
        with self.assertRaises(ValueError):
            verifier.verify(self.archive, self.volume)
        self.assertFalse((self.root / 'escape-test').exists())


if __name__ == '__main__':
    unittest.main()
