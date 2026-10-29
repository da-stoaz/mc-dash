"""Descriptor-relative server file operations (Linux and macOS).

Node does not expose openat/renameat. Python's standard-library dir_fd operations
keep every lookup anchored to an already-open directory instead of re-resolving
Minecraft-controlled parent paths. Invoked only by serverFiles.ts via JSON stdin.
"""
import errno
import json
import os
import secrets
import stat
import sys

DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
FILE = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK


def check_file(info):
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError('Unsafe server file (link or special file)')


def ownership(fd, info, owner, directory=False):
    if owner is not None and (info.st_uid != owner['uid'] or info.st_gid != owner['gid']):
        os.fchown(fd, owner['uid'], owner['gid'])
    mode = (info.st_mode & 0o777) | (0o700 if directory else 0o600)
    if stat.S_IMODE(info.st_mode) != mode:
        os.fchmod(fd, mode)


def open_directory(parent, name):
    return os.open(name, DIR, dir_fd=parent)


def walk(fd, owner, repair, root=True):
    if repair:
        ownership(fd, os.fstat(fd), owner, True)
    for name in os.listdir(fd):
        if root and name == 'snapshots':
            continue
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            child = open_directory(fd, name)
            try:
                walk(child, owner, repair, False)
            finally:
                os.close(child)
        else:
            check_file(info)
            child = os.open(name, FILE, dir_fd=fd)
            try:
                info = os.fstat(child)
                check_file(info)
                if repair:
                    ownership(child, info, owner)
            finally:
                os.close(child)


def atomic_write(parent, name, content, owner):
    try:
        info = os.stat(name, dir_fd=parent, follow_symlinks=False)
        check_file(info)
        mode = (info.st_mode & 0o777) | 0o600
    except FileNotFoundError:
        mode = 0o644
    temp = '.mc-dash-write-' + secrets.token_hex(16)
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    try:
        data = content.encode('utf-8')
        offset = 0
        while offset < len(data):
            written = os.write(fd, data[offset:])
            if not written:
                raise OSError('Short write')
            offset += written
        ownership(fd, os.fstat(fd), owner)
        os.fchmod(fd, mode)
        os.fsync(fd)
        # Neither endpoint follows a final symlink, even if Minecraft swapped it
        # after the stat above. Both parents are the pinned directory descriptor.
        os.rename(temp, name, src_dir_fd=parent, dst_dir_fd=parent)
    finally:
        os.close(fd)
        try:
            os.unlink(temp, dir_fd=parent)
        except FileNotFoundError:
            pass


def run(request):
    parts = request['parts']
    if len(parts) < 2 or parts[0] != 'servers' or any(p in ('', '.', '..') or '/' in p for p in parts):
        raise ValueError('File is outside a managed server directory')
    owner = request['owner']
    fd = os.open(request['root'], DIR)
    try:
        directories = parts[:-1] if request['operation'] == 'write' else parts
        for name in directories:
            try:
                child = open_directory(fd, name)
            except FileNotFoundError:
                if request['operation'] != 'write':
                    return
                raise
            os.close(fd)
            fd = child
        if request['operation'] == 'write':
            atomic_write(fd, parts[-1], request['content'], owner)
        elif request['operation'] in ('repair', 'validate'):
            walk(fd, owner, False)
            if request['operation'] == 'repair':
                walk(fd, owner, True)
        else:
            raise ValueError('Unknown server file operation')
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        run(json.load(sys.stdin))
    except Exception as error:
        message = str(error)
        if isinstance(error, OSError) and error.errno in (errno.ELOOP, errno.ENOTDIR):
            message = 'Unsafe server file (symlink or non-directory): ' + message
        print(message, file=sys.stderr)
        sys.exit(1)
