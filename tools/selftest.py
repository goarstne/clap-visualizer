#!/usr/bin/env python3
"""One isolated stdlib integration test; does not depend on the parallel web build."""
import base64
import hashlib
import http.client
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import struct
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]


class WS:
    def __init__(self, port):
        self.sock = socket.create_connection(('127.0.0.1', port), timeout=2)
        self.buffer = b''
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f'GET /ws HTTP/1.1\r\nHost: localhost\r\n'
                           f'Upgrade: WebSocket\r\nConnection: keep-alive, Upgrade\r\n'
                           f'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {key}\r\n\r\n').encode())
        while b'\r\n\r\n' not in self.buffer:
            self.buffer += self.sock.recv(8192)
        header, self.buffer = self.buffer.split(b'\r\n\r\n', 1)
        expected = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest())
        assert header.startswith(b'HTTP/1.1 101 '), header
        assert b'Sec-WebSocket-Accept: ' + expected in header, header

    def read(self, size):
        while len(self.buffer) < size:
            part = self.sock.recv(8192)
            assert part, 'unexpected WebSocket EOF'
            self.buffer += part
        data, self.buffer = self.buffer[:size], self.buffer[size:]
        return data

    def recv(self):
        first, second = self.read(2)
        assert first & 128 and not first & 112 and not second & 128
        size = second & 127
        if size == 126:
            size = struct.unpack('!H', self.read(2))[0]
        elif size == 127:
            size = struct.unpack('!Q', self.read(8))[0]
        return first & 15, self.read(size)

    def send(self, payload, opcode=1, final=True, masked=True):
        if isinstance(payload, str):
            payload = payload.encode()
        size = len(payload)
        header = bytes([(128 if final else 0) | opcode])
        maskbit = 128 if masked else 0
        if size < 126:
            header += bytes([size | maskbit])
        elif size <= 65535:
            header += bytes([126 | maskbit]) + struct.pack('!H', size)
        else:
            header += bytes([127 | maskbit]) + struct.pack('!Q', size)
        if masked:
            mask = os.urandom(4)
            header += mask
            payload = bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))
        self.sock.sendall(header + payload)

    def until(self, predicate):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            op, payload = self.recv()
            if predicate(op, payload):
                return payload
        raise AssertionError('expected frame missing')

    def close(self):
        self.sock.close()


def request_http(port, path, method='GET'):
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
    connection.request(method, path)
    response = connection.getresponse()
    result = response.status, response.getheader('Content-Type'), response.read()
    connection.close()
    return result


def start(env, library):
    process = subprocess.Popen([str(ROOT / 'tools/fakehost'), '0', str(library)], env=env,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    for _ in range(100):
        if process.poll() is not None:
            raise AssertionError(process.communicate())
        try:
            with socket.create_connection(('127.0.0.1', int(env['VSTVIS_PORT'])), timeout=.05):
                return process
        except OSError:
            time.sleep(.02)
    process.terminate()
    raise AssertionError('server did not start')


def stop(process):
    if process.poll() is None:
        process.send_signal(signal.SIGINT)
    stdout, stderr = process.communicate(timeout=5)
    assert process.returncode == 0, (stdout, stderr)
    print(stdout.strip())
    return stderr


def main():
    processes, clients = [], []
    with tempfile.TemporaryDirectory(prefix='vstvis-test-') as tmp:
        tmp = Path(tmp)
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
        web = tmp / 'clapvisualizer.web'
        web.mkdir()
        (web / 'index.html').write_text('<!doctype html><title>selftest</title>')
        (web / 'remote.html').write_text('<!doctype html><title>remote</title>')
        (web / 'app.js').write_text('/* selftest */')
        (web / 'photo.jpg').write_bytes(b'\xff\xd8\xff')
        (web / 'large.wasm').write_bytes(b'x' * 400000)
        (web / 'outside').symlink_to('/etc/passwd')
        library = tmp / 'clapvisualizer.clap'
        shutil.copy2(ROOT / 'build/clapvisualizer.clap', library)
        env = os.environ.copy()
        env.pop('VSTVIS_WEB_DIR', None)  # Exercise dladdr-relative default.
        env.update(VSTVIS_PORT=str(port), VSTVIS_STATE_FILE=str(tmp / 'state.json'))
        try:
            process = start(env, library)
            processes.append(process)
            assert request_http(port, '/')[0] == 200
            assert request_http(port, '/remote.html')[0] == 200
            assert request_http(port, '/app.js')[1].startswith('text/javascript')
            assert request_http(port, '/photo.jpg')[1] == 'image/jpeg'
            status, content_type, body = request_http(port, '/large.wasm')
            assert status == 200 and content_type == 'application/wasm' and len(body) == 400000
            for path in ['/../etc/passwd', '/%2e%2e/etc/passwd', '/outside', '/%00', '/missing']:
                assert request_http(port, path)[0] in (403, 404), path
            assert request_http(port, '/', 'POST')[0] == 405
            with socket.create_connection(('127.0.0.1', port), timeout=2) as oversized:
                oversized.sendall(b'GET / HTTP/1.1\r\nHost: localhost\r\nX: ' + b'x' * 65536 + b'\r\n\r\n')
                with oversized.makefile('rb') as response:
                    assert response.readline().startswith(b'HTTP/1.1 431 ')
            print('HTTP: default web directory, 200, MIME, streamed file, traversal/symlink rejection, GET-only OK')

            display, remote = WS(port), WS(port)
            clients += [display, remote]
            display.send('hello display')
            remote.send('hello remote')
            payload = remote.until(lambda op, p: op == 1 and json.loads(p).get('type') == 'transport')
            transport = json.loads(payload)
            assert transport['bpm'] == 120 and transport['playing'] is True
            assert transport['beat'] >= 0 and transport['sampleRate'] == 48000
            assert transport['tsNum'] == transport['tsDen'] == 4
            assert 0 <= transport['rms'] <= 1 and 0 <= transport['peak'] <= 1
            audio = display.until(lambda op, p: op == 2)
            assert len(audio) == 16 + 2 * 1024
            kind, flags, n, bpm, beat = struct.unpack('<BBHfd', audio[:16])
            assert (kind, flags & 1, n, bpm) == (1, 1, 1024, 120)
            assert beat >= 0 and len(set(audio[16:])) > 4
            for _ in range(3):
                op, payload = remote.recv()
                assert op == 1, 'remote received audio'
            print('WebSocket: SHA1/Base64 handshake, transport 120 BPM, 2064-byte little-endian audio, remote filtering OK')

            state = '{"type":"state","preset":"test","blend":2.0}'
            remote.send(state)
            assert display.until(lambda op, p: op == 1 and p == state.encode()) == state.encode()
            new = WS(port)
            clients.append(new)
            assert new.recv() == (1, state.encode()), 'new client did not receive state first'
            action = '{"type":"next"}'
            remote.send(action)
            display.until(lambda op, p: op == 1 and p == action.encode())
            newer = WS(port)
            clients.append(newer)
            assert newer.recv() == (1, state.encode()), 'action replaced stored state'
            # RFC 6455 uses a 64-bit length field for exactly 64 KiB.
            big_state = '{"type":"state","preset":"' + 'x' * (65536 - len('{"type":"state","preset":""}')) + '"}'
            assert len(big_state) == 65536
            remote.send(big_state)
            display.until(lambda op, p: op == 1 and p == big_state.encode())
            remote.send(state)
            display.until(lambda op, p: op == 1 and p == state.encode())
            # The sender must only receive transport, never its own relay.
            for _ in range(3):
                op, payload = remote.recv()
                assert op == 1 and json.loads(payload)['type'] == 'transport'
            print('State: relay without echo, 64 KiB boundary, reconnect delivery, actions not stored OK')

            remote.send(b'ping-check', 9)
            remote.until(lambda op, p: op == 10 and p == b'ping-check')
            remote.send(b'ignored binary', 2)
            remote.send(b'pong', 10)
            for payload, final, masked, code in [(b'fragment', False, True, 1002),
                                                  (b'unmasked', True, False, 1002),
                                                  (b'x' * 65537, True, True, 1009),
                                                  (b'\xff', True, True, 1007)]:
                bad = WS(port)
                clients.append(bad)
                bad.recv()  # Stored state.
                bad.send(payload, final=final, masked=masked)
                close = bad.until(lambda op, p: op == 8)
                assert struct.unpack('!H', close[:2])[0] == code
                bad.close()
            remote.send(struct.pack('!H', 1000), 8)
            assert remote.until(lambda op, p: op == 8) == struct.pack('!H', 1000)
            print('WebSocket: binary/Pong accepted, Ping/Pong, Close, masking/fragment/UTF-8/frame-limit checks OK')

            # A second instance must pass audio even when its bind fails.
            second_env = env.copy()
            second_env.pop('VSTVIS_STATE_FILE')
            second = subprocess.Popen([str(ROOT / 'tools/fakehost'), '.1', str(library)],
                                      env=second_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            processes.append(second)
            second_out, second_err = second.communicate(timeout=5)
            assert second.returncode == 0 and 'bind/listen' in second_err, (second_out, second_err)
            print('Second instance: bind failure leaves passthrough running OK')
            stop(process)
            assert (tmp / 'state.json').read_text() == state
            for client in clients:
                client.close()
            clients.clear()
            env['VSTVIS_WEB_DIR'] = str(web)
            process = start(env, library)
            processes.append(process)
            assert request_http(port, '/')[0] == 200
            restored = WS(port)
            clients.append(restored)
            assert restored.recv() == (1, state.encode())
            stop(process)
            print('CLAP state: saved opaque string, restored into new instance and delivered to new client OK')
        finally:
            for client in clients:
                client.close()
            for process in processes:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.communicate(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.communicate()
    print('make test: PASS')


if __name__ == '__main__':
    main()
