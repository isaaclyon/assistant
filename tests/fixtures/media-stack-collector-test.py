"""Behavior tests for scripts/media-stack-collector.py against a fake loopback media stack."""
import http.server
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import threading

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCRIPT = os.path.join(ROOT, 'scripts', 'media-stack-collector.py')
KEY = 'abcdef0123456789abcdef0123456789'
SEEN = []
ROUTES = {
    ('GET', '/api/v3/health'): [{'source': 'IndexerStatusCheck', 'type': 'warning', 'message': 'Indexers unavailable'}],
    ('GET', '/api/v3/queue'): {'totalRecords': 1, 'records': [{'title': 'Show.S01E01', 'status': 'downloading', 'size': 100, 'sizeleft': 40,
                                                              'timeleft': '00:10:00', 'trackedDownloadState': 'downloading', 'secret': 'x'}]},
    ('GET', '/api/v3/calendar'): [],
    ('GET', '/api/v3/series'): [{'id': 1, 'title': 'The Bear', 'year': 2022, 'monitored': True, 'statistics': {'episodeFileCount': 8, 'episodeCount': 10}},
                                {'id': 2, 'title': 'Other', 'year': 2020}],
    ('GET', '/api/v3/movie'): [],
    ('GET', '/api/v1/status'): {'version': '3.0.0'},
    ('GET', '/api/v1/search'): {'results': [{'mediaType': 'movie', 'id': 603, 'title': 'The Matrix', 'releaseDate': '1999-03-31', 'overview': 'x' * 500},
                                            {'mediaType': 'person', 'id': 1, 'name': 'Someone'}]},
    ('GET', '/api/v1/request'): {'results': [{'id': 7, 'type': 'movie', 'status': 1, 'media': {'tmdbId': 603, 'status': 2}, 'createdAt': '2026-01-01T00:00:00Z'}]},
    ('POST', '/api/v1/request'): {'id': 8, 'status': 2},
}
STATUS_OVERRIDE = {}


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def respond(self, method):
        path = self.path.split('?')[0]
        body = self.rfile.read(int(self.headers.get('Content-Length') or 0))
        SEEN.append((method, self.path, self.headers.get('X-Api-Key'), body))
        if STATUS_OVERRIDE.get(path):
            self.send_response(STATUS_OVERRIDE[path])
            self.end_headers()
            return
        route = ROUTES.get((method, path))
        self.send_response(200 if route is not None else 404)
        self.end_headers()
        if route is not None:
            self.wfile.write(json.dumps(route).encode())

    do_GET = lambda self: self.respond('GET')
    do_POST = lambda self: self.respond('POST')


server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
origin = 'http://127.0.0.1:%d' % server.server_address[1]

with tempfile.TemporaryDirectory() as tmp:
    xml = os.path.join(tmp, 'config.xml')
    open(xml, 'w').write('<Config><ApiKey>%s</ApiKey></Config>' % KEY)
    js = os.path.join(tmp, 'settings.json')
    open(js, 'w').write(json.dumps({'main': {'apiKey': 'c2VlcnJrZXk9PQ=='}}))
    cfg = os.path.join(tmp, 'media.json')

    def write_config(services):
        open(cfg, 'w').write(json.dumps({'version': 1, 'services': services}))

    write_config({'sonarr': {'url': origin, 'apiKey': {'file': xml, 'xml': 'ApiKey'}},
                  'radarr': {'url': origin, 'apiKey': {'file': xml, 'xml': 'ApiKey'}},
                  'seerr': {'url': origin, 'apiKey': {'file': js, 'json': 'main.apiKey'}}})

    def run(request, raw=None):
        p = subprocess.run([sys.executable, '-I', '-B', SCRIPT, cfg], input=(raw if raw is not None else json.dumps(request)).encode(),
                           capture_output=True, timeout=30)
        return json.loads(p.stdout)

    def ok(request):
        out = run(request)
        assert out['ok'], out
        return out['result']

    def fails(request, code, raw=None):
        out = run(request, raw)
        assert not out['ok'] and out['error']['code'] == code, out

    # Health: configured services only, and structured issues.
    health = ok({'op': 'health'})['services']
    assert set(health) == {'sonarr', 'radarr', 'seerr'}
    assert health['sonarr']['issues'][0]['message'] == 'Indexers unavailable' and health['seerr']['version'] == '3.0.0'

    # Queue: only known fields survive, and each service key is sent as a header.
    queue = ok({'op': 'queue'})
    item = queue['sonarr']['items'][0]
    assert item['title'] == 'Show.S01E01' and item['bytesLeft'] == 40 and 'secret' not in item
    assert any(path.startswith('/api/v3/queue') and key == KEY for _, path, key, _ in SEEN)
    assert any(path.startswith('/api/v1/status') and key == 'c2VlcnJrZXk9PQ==' for _, path, key, _ in SEEN)

    # Library search matches case-insensitively and skips services not asked for.
    library = ok({'op': 'library_search', 'args': {'query': 'bear', 'kind': 'series'}})
    assert [s['title'] for s in library['series']] == ['The Bear'] and 'movies' not in library

    # Seerr search drops people, bounds text and maps availability.
    found = ok({'op': 'request_search', 'args': {'query': 'matrix'}})['results']
    assert len(found) == 1 and found[0]['mediaId'] == 603 and found[0]['year'] == '1999' and len(found[0]['overview']) == 240
    listed = ok({'op': 'request_list', 'args': {'filter': 'pending'}})['requests'][0]
    assert listed['requestStatus'] == 'pending' and listed['availability'] == 'pending'

    # Request creation sends exactly the typed body.
    SEEN.clear()
    assert ok({'op': 'request_create', 'args': {'mediaType': 'tv', 'mediaId': 5, 'seasons': [2, 1, 2]}})['requestId'] == 8
    method, path, _, body = SEEN[-1]
    assert (method, path) == ('POST', '/api/v1/request') and json.loads(body) == {'mediaType': 'tv', 'mediaId': 5, 'seasons': [1, 2]}
    assert ok({'op': 'request_create', 'args': {'mediaType': 'movie', 'mediaId': 603}})['requestStatus'] == 'approved'

    # Duplicate requests are reported rather than retried.
    STATUS_OVERRIDE['/api/v1/request'] = 409
    fails({'op': 'request_create', 'args': {'mediaType': 'movie', 'mediaId': 603}}, 'ALREADY_EXISTS')
    STATUS_OVERRIDE.clear()

    # Invalid or unlisted input never reaches a service.
    SEEN.clear()
    fails({'op': 'shell'}, 'OPERATION_UNKNOWN')
    fails({'op': 'queue', 'args': {'url': 'http://evil'}}, 'INPUT_INVALID')
    fails({'op': 'request_create', 'args': {'mediaType': 'tv', 'mediaId': 5}}, 'INPUT_INVALID')
    fails({'op': 'request_create', 'args': {'mediaType': 'movie', 'mediaId': 5, 'seasons': 'all'}}, 'INPUT_INVALID')
    fails({'op': 'request_create', 'args': {'mediaType': 'movie', 'mediaId': True}}, 'INPUT_INVALID')
    fails({'op': 'library_search', 'args': {'query': ''}}, 'INPUT_INVALID')
    fails({'op': 'upcoming', 'args': {'days': 99}}, 'INPUT_INVALID')
    fails(None, 'INPUT_INVALID', raw='not json')
    fails(None, 'INPUT_INVALID', raw=json.dumps({'op': 'queue', 'extra': 1}))
    fails(None, 'INPUT_INVALID', raw='{"op":"queue","args":' + ' ' * 3000 + '{}}')
    assert SEEN == []

    # Unreachable service reports unavailable without leaking details.
    write_config({'sonarr': {'url': 'http://127.0.0.1:9', 'apiKey': {'file': xml, 'xml': 'ApiKey'}}})
    fails({'op': 'queue'}, 'SERVICE_UNAVAILABLE')
    assert ok({'op': 'health'})['services']['sonarr']['reachable'] is False

    # A service bound to this host's tailnet address is accepted by the loader.
    write_config({'sonarr': {'url': 'http://100.79.123.105:8989', 'apiKey': {'file': xml, 'xml': 'ApiKey'}}})
    spec = importlib.util.spec_from_file_location('collector', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.load_config(cfg)['sonarr']['origin'] == 'http://100.79.123.105:8989'

    # Configuration must be loopback http and a known service.
    for services in ({'sonarr': {'url': 'http://100.128.0.1', 'apiKey': {'file': xml, 'xml': 'ApiKey'}}},
                     {'sonarr': {'url': 'http://10.0.0.5', 'apiKey': {'file': xml, 'xml': 'ApiKey'}}},
                     {'sonarr': {'url': 'http://127.0.0.1/x', 'apiKey': {'file': xml, 'xml': 'ApiKey'}}},
                     {'plex': {'url': origin, 'apiKey': {'file': xml, 'xml': 'ApiKey'}}},
                     {'sonarr': {'url': origin, 'apiKey': {'file': 'relative.xml', 'xml': 'ApiKey'}}}):
        write_config(services)
        fails({'op': 'health'}, 'COLLECTOR_FAILED')

server.shutdown()
print('ok')
