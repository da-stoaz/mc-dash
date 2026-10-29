import errno
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('worker', Path(__file__).with_name('serverFileWorker.py'))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class SecureFiles(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.pack = self.root / 'servers' / 'test' / 'pack'
        self.pack.mkdir(parents=True)
        self.outside = self.root / 'outside'
        self.outside.mkdir()
        (self.pack / 'server.properties').write_text('original')
        (self.outside / 'server.properties').write_text('outside')
        self.request = dict(root=str(self.root), parts=['servers', 'test', 'pack', 'server.properties'],
                            operation='write', owner=None, content='updated')

    def tearDown(self):
        self.temp.cleanup()

    def test_parent_swapped_before_open_is_rejected(self):
        original = os.open
        def intercepted(name, *args, **kwargs):
            if name == 'pack':
                self.pack.rename(self.pack.with_name('saved'))
                self.pack.symlink_to(self.outside, target_is_directory=True)
            return original(name, *args, **kwargs)
        with patch.object(worker.os, 'open', side_effect=intercepted):
            with self.assertRaises(OSError):
                worker.run(self.request)
        self.assertEqual((self.outside / 'server.properties').read_text(), 'outside')
        self.assertEqual((self.pack.with_name('saved') / 'server.properties').read_text(), 'original')

    def test_parent_swapped_after_open_cannot_redirect_write(self):
        original = os.open
        def intercepted(name, *args, **kwargs):
            fd = original(name, *args, **kwargs)
            if name == 'pack':
                self.pack.rename(self.pack.with_name('saved'))
                self.pack.symlink_to(self.outside, target_is_directory=True)
            return fd
        with patch.object(worker.os, 'open', side_effect=intercepted):
            worker.run(self.request)
        self.assertEqual((self.outside / 'server.properties').read_text(), 'outside')
        self.assertEqual((self.pack.with_name('saved') / 'server.properties').read_text(), 'updated')

    def test_ownership_walk_rejects_parent_swap(self):
        original = os.open
        def intercepted(name, *args, **kwargs):
            if name == 'pack':
                self.pack.rename(self.pack.with_name('saved'))
                self.pack.symlink_to(self.outside, target_is_directory=True)
            return original(name, *args, **kwargs)
        request = dict(self.request, operation='repair', parts=['servers', 'test'])
        before = (self.outside / 'server.properties').stat()
        with patch.object(worker.os, 'open', side_effect=intercepted):
            with self.assertRaises(OSError):
                worker.run(request)
        after = (self.outside / 'server.properties').stat()
        self.assertEqual((before.st_uid, before.st_gid, before.st_mode), (after.st_uid, after.st_gid, after.st_mode))

    def test_full_disk_does_not_truncate_original(self):
        with patch.object(worker.os, 'write', side_effect=OSError(errno.ENOSPC, 'disk full')):
            with self.assertRaises(OSError):
                worker.run(self.request)
        self.assertEqual((self.pack / 'server.properties').read_text(), 'original')
        self.assertEqual(os.listdir(self.pack), ['server.properties'])

    def test_rename_failure_preserves_original_and_cleans_temp(self):
        with patch.object(worker.os, 'rename', side_effect=OSError(errno.EIO, 'rename failed')):
            with self.assertRaises(OSError):
                worker.run(self.request)
        self.assertEqual((self.pack / 'server.properties').read_text(), 'original')
        self.assertEqual(os.listdir(self.pack), ['server.properties'])

    def test_final_symlink_swap_does_not_modify_target(self):
        original = os.rename
        def intercepted(source, destination, **kwargs):
            (self.pack / 'server.properties').unlink()
            (self.pack / 'server.properties').symlink_to(self.outside / 'server.properties')
            return original(source, destination, **kwargs)
        with patch.object(worker.os, 'rename', side_effect=intercepted):
            worker.run(self.request)
        self.assertEqual((self.outside / 'server.properties').read_text(), 'outside')
        self.assertEqual((self.pack / 'server.properties').read_text(), 'updated')
        self.assertFalse((self.pack / 'server.properties').is_symlink())


if __name__ == '__main__':
    unittest.main()
