#!/usr/bin/python3
"""Typed media-stack operations for a restricted SSH forced command. Standard library only.

Reads one small JSON request on stdin, runs exactly one allowlisted operation against
local Sonarr, Radarr, Prowlarr and Seerr APIs (loopback or this host's tailnet address), and prints one bounded JSON result.
It accepts no shell text, URL, header, path or command from the caller. Private
configuration (service URLs and API-key file locations) is root-owned and fixed.

Usage: media-stack-collector.py <config.json>
"""
import ipaddress
import json
import os
import re
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

CONFIG_LIMIT = 64 * 1024
TAILNET = ipaddress.ip_network('100.64.0.0/10')
REQUEST_LIMIT = 2 * 1024
RESPONSE_LIMIT = 4 * 1024 * 1024
OUTPUT_LIMIT = 96 * 1024
TIMEOUT = 10
SERVICES = ('sonarr', 'radarr', 'prowlarr', 'seerr')
API_PREFIX = {'sonarr': '/api/v3', 'radarr': '/api/v3', 'prowlarr': '/api/v1', 'seerr': '/api/v1'}
REQUEST_FILTERS = ('all', 'pending', 'approved', 'processing', 'available', 'unavailable', 'failed')
MEDIA_TYPES = ('movie', 'tv')
REQUEST_STATUS = {1: 'pending', 2: 'approved', 3: 'declined', 4: 'failed', 5: 'completed'}


class OperationError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def read_file(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as f:
        info = os.fstat(f.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise ValueError('Unsafe or oversized file')
        return f.read()


def load_config(path):
    value = json.loads(read_file(path, CONFIG_LIMIT))
    if not isinstance(value, dict) or value.get('version') != 1 or not isinstance(value.get('services'), dict):
        raise ValueError('Invalid configuration')
    services = {}
    for name, item in value['services'].items():
        if name not in SERVICES or not isinstance(item, dict):
            raise ValueError('Unknown service in configuration')
        parsed = urllib.parse.urlsplit(item.get('url', ''))
        if parsed.scheme != 'http' or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/'):
            raise ValueError('Service URL must be a plain http origin')
        address = ipaddress.ip_address(parsed.hostname)
        if not (address.is_loopback or address in TAILNET):
            raise ValueError('Service URL must be loopback or a tailnet address of this host')
        key = item.get('apiKey')
        if not isinstance(key, dict) or not isinstance(key.get('file'), str) or not os.path.isabs(key['file']):
            raise ValueError('Invalid API key source')
        if ('xml' in key) == ('json' in key):
            raise ValueError('API key source needs exactly one of xml or json')
        services[name] = {'origin': '%s://%s' % (parsed.scheme, parsed.netloc), 'apiKey': key}
    return services


def api_key(service):
    source = service['apiKey']
    raw = read_file(source['file'], CONFIG_LIMIT)
    if 'xml' in source:
        node = ET.fromstring(raw).find(source['xml'])
        value = node.text if node is not None else None
    else:
        value = json.loads(raw)
        for part in source['json'].split('.'):
            value = value.get(part) if isinstance(value, dict) else None
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9+/=_-]{16,128}', value):
        raise OperationError('KEY_UNAVAILABLE', 'A service API key is unavailable')
    return value


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)


def call(services, name, path, query=None, body=None):
    service = services.get(name)
    if service is None:
        raise OperationError('SERVICE_NOT_CONFIGURED', '%s is not configured' % name)
    url = service['origin'] + API_PREFIX[name] + path
    if query:
        # Seerr's OpenAPI validator rejects raw reserved characters, including
        # '+' for spaces. Encode URI components (%20), not HTML form values.
        url += '?' + urllib.parse.urlencode(query, quote_via=urllib.parse.quote)
    data = None if body is None else json.dumps(body, separators=(',', ':')).encode()
    request = urllib.request.Request(url, data=data, method='GET' if body is None else 'POST')
    request.add_header('X-Api-Key', api_key(service))
    request.add_header('Accept', 'application/json')
    if data is not None:
        request.add_header('Content-Type', 'application/json')
    try:
        with OPENER.open(request, timeout=TIMEOUT) as response:
            raw = response.read(RESPONSE_LIMIT + 1)
    except urllib.error.HTTPError as error:
        if error.code == 409:
            raise OperationError('ALREADY_EXISTS', 'That item already exists or is already requested')
        raise OperationError('SERVICE_ERROR', '%s returned HTTP %d' % (name, error.code))
    except (urllib.error.URLError, OSError, TimeoutError):
        raise OperationError('SERVICE_UNAVAILABLE', '%s is not reachable' % name)
    if len(raw) > RESPONSE_LIMIT:
        raise OperationError('SERVICE_ERROR', '%s response is too large' % name)
    try:
        return json.loads(raw)
    except ValueError:
        raise OperationError('SERVICE_ERROR', '%s returned invalid JSON' % name)


def text(value, limit=300):
    if not isinstance(value, str):
        return None
    clean = ''.join(ch if ch.isprintable() else ' ' for ch in value).strip()
    return clean[:limit]


def number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def items(value):
    return value if isinstance(value, list) else []


def records(value):
    return value.get('records') if isinstance(value, dict) and isinstance(value.get('records'), list) else []


def configured(services):
    return [name for name in SERVICES if name in services]


def op_health(services, _args):
    result = {}
    for name in configured(services):
        try:
            if name == 'seerr':
                status = call(services, name, '/status')
                result[name] = {'reachable': True, 'version': text(status.get('version'), 40), 'issues': []}
            else:
                issues = [{'source': text(i.get('source'), 80), 'type': text(i.get('type'), 20), 'message': text(i.get('message'))}
                          for i in items(call(services, name, '/health'))[:20] if isinstance(i, dict)]
                result[name] = {'reachable': True, 'issues': issues}
        except OperationError as error:
            result[name] = {'reachable': False, 'error': error.message}
    return {'services': result}


def queue_item(item):
    return {'title': text(item.get('title'), 200), 'status': text(item.get('status'), 40),
            'state': text(item.get('trackedDownloadState'), 40), 'health': text(item.get('trackedDownloadStatus'), 20),
            'sizeBytes': number(item.get('size')), 'bytesLeft': number(item.get('sizeleft')),
            'timeLeft': text(item.get('timeleft'), 20), 'error': text(item.get('errorMessage')),
            'protocol': text(item.get('protocol'), 20)}


def op_queue(services, _args):
    result = {}
    for name in ('sonarr', 'radarr'):
        if name in services:
            page = call(services, name, '/queue', {'page': 1, 'pageSize': 50, 'includeUnknownSeriesItems': 'true',
                                                   'includeUnknownMovieItems': 'true'})
            result[name] = {'total': number(page.get('totalRecords')) if isinstance(page, dict) else None,
                            'items': [queue_item(i) for i in records(page)[:50] if isinstance(i, dict)]}
    return result


def op_upcoming(services, args):
    from datetime import datetime, timedelta, timezone
    start = datetime.now(timezone.utc)
    window = {'start': start.strftime('%Y-%m-%dT%H:%M:%SZ'), 'end': (start + timedelta(days=args['days'])).strftime('%Y-%m-%dT%H:%M:%SZ')}
    result = {}
    if 'sonarr' in services:
        result['sonarr'] = [{'series': text((i.get('series') or {}).get('title'), 200), 'title': text(i.get('title'), 200),
                             'season': number(i.get('seasonNumber')), 'episode': number(i.get('episodeNumber')),
                             'airDateUtc': text(i.get('airDateUtc'), 30), 'hasFile': i.get('hasFile') is True}
                            for i in items(call(services, 'sonarr', '/calendar', {**window, 'includeSeries': 'true'}))[:100]
                            if isinstance(i, dict)]
    if 'radarr' in services:
        result['radarr'] = [{'title': text(i.get('title'), 200), 'year': number(i.get('year')),
                             'digitalRelease': text(i.get('digitalRelease'), 30), 'physicalRelease': text(i.get('physicalRelease'), 30),
                             'inCinemas': text(i.get('inCinemas'), 30), 'hasFile': i.get('hasFile') is True}
                            for i in items(call(services, 'radarr', '/calendar', window))[:100] if isinstance(i, dict)]
    return result


def op_library_search(services, args):
    needle = args['query'].casefold()
    result = {}
    if args['kind'] in ('any', 'series') and 'sonarr' in services:
        result['series'] = [{'id': number(i.get('id')), 'title': text(i.get('title'), 200), 'year': number(i.get('year')),
                             'monitored': i.get('monitored') is True,
                             'episodesOnDisk': number((i.get('statistics') or {}).get('episodeFileCount')),
                             'episodes': number((i.get('statistics') or {}).get('episodeCount')),
                             'status': text(i.get('status'), 20)}
                            for i in items(call(services, 'sonarr', '/series')) if isinstance(i, dict)
                            and needle in (text(i.get('title'), 200) or '').casefold()][:20]
    if args['kind'] in ('any', 'movie') and 'radarr' in services:
        result['movies'] = [{'id': number(i.get('id')), 'title': text(i.get('title'), 200), 'year': number(i.get('year')),
                             'monitored': i.get('monitored') is True, 'hasFile': i.get('hasFile') is True,
                             'status': text(i.get('status'), 20)}
                            for i in items(call(services, 'radarr', '/movie')) if isinstance(i, dict)
                            and needle in (text(i.get('title'), 200) or '').casefold()][:20]
    return result


def op_request_search(services, args):
    found = call(services, 'seerr', '/search', {'query': args['query'], 'page': 1})
    out = []
    for item in records_of(found)[:10]:
        kind = item.get('mediaType')
        if kind not in MEDIA_TYPES:
            continue
        date = text(item.get('releaseDate') or item.get('firstAirDate'), 10) or ''
        out.append({'mediaType': kind, 'mediaId': number(item.get('id')),
                    'title': text(item.get('title') or item.get('name'), 200), 'year': date[:4] or None,
                    'overview': text(item.get('overview'), 240),
                    'availability': {1: 'unknown', 2: 'pending', 3: 'processing', 4: 'partial', 5: 'available'}.get(
                        number((item.get('mediaInfo') or {}).get('status')), 'not requested')})
    return {'results': out}


def records_of(value):
    return value.get('results') if isinstance(value, dict) and isinstance(value.get('results'), list) else []


def op_request_list(services, args):
    page = call(services, 'seerr', '/request', {'take': args['take'], 'skip': 0, 'filter': args['filter'], 'sort': 'added'})
    out = []
    for item in records_of(page)[:args['take']]:
        if not isinstance(item, dict):
            continue
        media = item.get('media') or {}
        out.append({'requestId': number(item.get('id')), 'mediaType': text(item.get('type'), 10),
                    'mediaId': number(media.get('tmdbId')), 'requestStatus': REQUEST_STATUS.get(number(item.get('status')), 'unknown'),
                    'availability': {1: 'unknown', 2: 'pending', 3: 'processing', 4: 'partial', 5: 'available'}.get(number(media.get('status')), 'unknown'),
                    'createdAt': text(item.get('createdAt'), 30)})
    return {'requests': out}


def op_request_create(services, args):
    body = {'mediaType': args['mediaType'], 'mediaId': args['mediaId']}
    if args['mediaType'] == 'tv':
        body['seasons'] = args['seasons']
    created = call(services, 'seerr', '/request', body=body)
    return {'requestId': number(created.get('id')) if isinstance(created, dict) else None,
            'requestStatus': REQUEST_STATUS.get(number((created or {}).get('status')), 'unknown')}


def strict(args, fields):
    if set(args) - set(fields):
        raise OperationError('INPUT_INVALID', 'Unexpected field')
    return args


def int_in(value, low, high):
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise OperationError('INPUT_INVALID', 'Number out of range')
    return value


def query_text(value):
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= 120 or any(not c.isprintable() for c in value):
        raise OperationError('INPUT_INVALID', 'Invalid query')
    return value.strip()


def validate(op, args):
    if op in ('health', 'queue'):
        strict(args, [])
        return {}
    if op == 'upcoming':
        return {'days': int_in(strict(args, ['days']).get('days', 7), 1, 14)}
    if op == 'library_search':
        strict(args, ['query', 'kind'])
        kind = args.get('kind', 'any')
        if kind not in ('any', 'movie', 'series'):
            raise OperationError('INPUT_INVALID', 'Invalid kind')
        return {'query': query_text(args.get('query')), 'kind': kind}
    if op == 'request_search':
        return {'query': query_text(strict(args, ['query']).get('query'))}
    if op == 'request_list':
        strict(args, ['filter', 'take'])
        selected = args.get('filter', 'pending')
        if selected not in REQUEST_FILTERS:
            raise OperationError('INPUT_INVALID', 'Invalid filter')
        return {'filter': selected, 'take': int_in(args.get('take', 10), 1, 20)}
    if op == 'request_create':
        strict(args, ['mediaType', 'mediaId', 'seasons'])
        kind = args.get('mediaType')
        if kind not in MEDIA_TYPES:
            raise OperationError('INPUT_INVALID', 'Invalid media type')
        out = {'mediaType': kind, 'mediaId': int_in(args.get('mediaId'), 1, 2 ** 31 - 1)}
        seasons = args.get('seasons')
        if kind == 'movie':
            if seasons is not None:
                raise OperationError('INPUT_INVALID', 'Seasons apply only to TV')
        elif seasons == 'all':
            out['seasons'] = 'all'
        elif isinstance(seasons, list) and 1 <= len(seasons) <= 50:
            out['seasons'] = sorted(set(int_in(s, 0, 500) for s in seasons))
        else:
            raise OperationError('INPUT_INVALID', 'TV requests need seasons: "all" or a list')
        return out
    raise OperationError('OPERATION_UNKNOWN', 'Unknown operation')


OPERATIONS = {'health': op_health, 'queue': op_queue, 'upcoming': op_upcoming, 'library_search': op_library_search,
              'request_search': op_request_search, 'request_list': op_request_list, 'request_create': op_request_create}


def run(config_path, raw_request):
    try:
        request = json.loads(raw_request)
        if not isinstance(request, dict) or set(request) - {'op', 'args'} or not isinstance(request.get('op'), str):
            raise ValueError
        args = request.get('args', {})
        if not isinstance(args, dict):
            raise ValueError
    except ValueError:
        return {'ok': False, 'error': {'code': 'INPUT_INVALID', 'message': 'Request must be {"op":string,"args":object}'}}
    try:
        clean = validate(request['op'], args)
        services = load_config(config_path)
        return {'ok': True, 'result': OPERATIONS[request['op']](services, clean)}
    except OperationError as error:
        return {'ok': False, 'error': {'code': error.code, 'message': error.message}}
    except Exception:
        return {'ok': False, 'error': {'code': 'COLLECTOR_FAILED', 'message': 'The media collector failed'}}


def main():
    if len(sys.argv) != 2:
        print('usage: media-stack-collector.py <config.json>', file=sys.stderr)
        return 2
    raw = sys.stdin.buffer.read(REQUEST_LIMIT + 1)
    outcome = run(sys.argv[1], raw.decode('utf-8', 'replace') if len(raw) <= REQUEST_LIMIT else '')
    data = json.dumps(outcome, separators=(',', ':'), allow_nan=False)
    if len(data) > OUTPUT_LIMIT:
        data = json.dumps({'ok': False, 'error': {'code': 'OUTPUT_TOO_LARGE', 'message': 'Result exceeds the output bound'}})
    sys.stdout.write(data + '\n')
    return 0 if outcome.get('ok') else 1


if __name__ == '__main__':
    sys.exit(main())
