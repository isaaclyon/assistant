#!/usr/bin/python3
"""Read-only Linux telemetry and stateful incident evaluation. Standard library only.
Private task configuration supplies all host identities, paths, thresholds and units.
No Telegram credentials, scheduler authority, remediation, or remote shell input.
"""
import copy
import fcntl
import ipaddress
import json
import math
import os
import re
import resource
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid

LIMIT = 256 * 1024
ID = re.compile(r'^[a-z][a-z0-9-]{0,47}$')


class CollectionError(Exception):
    pass


def read_json(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd) as f:
        info = os.fstat(f.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > LIMIT:
            raise ValueError('Unsafe or oversized JSON file')
        return json.load(f)


def atomic_json(path, value, mode=0o600):
    data = json.dumps(value, separators=(',', ':'), allow_nan=False).encode() + b'\n'
    if len(data) > LIMIT:
        raise ValueError('State exceeds size bound')
    parent = os.path.dirname(path)
    temp = os.path.join(parent, '.' + uuid.uuid4().hex + '.tmp')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, 'wb') as f:
            os.fchmod(f.fileno(), mode)
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, path)
        directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def number(v, low=0, high=10**18):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and low <= v <= high


def require(condition):
    if not condition:
        raise ValueError('Invalid monitoring configuration or telemetry')


def absolute(value):
    require(isinstance(value, str) and value.startswith('/') and os.path.normpath(value) == value and not any(ord(x) < 32 for x in value))
    return value


def validate_config(c, action):
    require(isinstance(c, dict) and c.get('version') == 1 and isinstance(c.get('sourceId'), str) and ID.fullmatch(c['sourceId']))
    require(isinstance(c.get('mounts'), dict) and 1 <= len(c['mounts']) <= 4)
    require(isinstance(c.get('containers'), dict) and 1 <= len(c['containers']) <= 20)
    require(all(isinstance(k, str) and ID.fullmatch(k) for k in [*c['mounts'], *c['containers']]))
    if action == 'collect':
        for m in c['mounts'].values():
            absolute(m['path'])
            require(m.get('source') is None or (isinstance(m['source'], str) and 0 < len(m['source']) <= 200))
        require(all(isinstance(n, str) and re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,120}', n) for n in c['containers'].values()))
        require(isinstance(c.get('backupUnit'), str) and re.fullmatch(r'[a-zA-Z0-9_.@-]{1,100}\.service', c['backupUnit']))
    else:
        require(number(c.get('intervalSeconds'), 60, 3600))
        for m in c['mounts'].values():
            require(number(m.get('warnPercent'), 1, 100) and number(m.get('criticalPercent'), m['warnPercent'], 100))
            require(number(m.get('warnFreeBytes', 0)) and number(m.get('criticalFreeBytes', 0), 0, m.get('warnFreeBytes', 0)))
        require(all(isinstance(v.get('criticalDown'), bool) for v in c['containers'].values()))
        r, cpu, b = c['ram'], c['cpu'], c['backup']
        require(number(r.get('warnBytes'), 1) and number(r.get('criticalBytes'), 1, r['warnBytes']))
        require(all(number(r.get(k), 1, 86400) for k in ['warnSeconds', 'criticalSeconds']))
        require(number(cpu.get('warnPercent'), 1, 100) and number(cpu.get('criticalPercent'), cpu['warnPercent'], 100))
        require(number(cpu.get('contentionPercent'), 1, 100) and number(cpu.get('forSeconds'), 1, 86400))
        require(number(b.get('warnSeconds'), 1) and number(b.get('criticalSeconds'), b['warnSeconds']))
        ipaddress.ip_address(c['ssh']['host'])
        require(re.fullmatch(r'[a-z_][a-z0-9_-]{0,30}', c['ssh']['user']))
        for path in [c['ssh']['key'], c['ssh']['knownHosts'], c['statePath'], c['reportPath'], c['maintenancePath']]:
            absolute(path)
        require(len({c['statePath'], c['reportPath'], c['maintenancePath']}) == 3)
    return c


def run_bounded(argv, timeout=8, limit=65536):
    # Regular-file output plus RLIMIT_FSIZE bounds even a hostile remote process.
    with tempfile.TemporaryFile() as output:
        def limits():
            resource.setrlimit(resource.RLIMIT_FSIZE, (limit, limit))
        p = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.DEVNULL,
                             env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C', 'LC_ALL': 'C'},
                             start_new_session=True, preexec_fn=limits)
        try:
            code = p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGKILL)
            p.wait()
            raise CollectionError('collection deadline exceeded') from None
        output.seek(0)
        data = output.read(limit + 1)
        if code != 0 or len(data) >= limit:
            raise CollectionError('collection command failed')
        return data.decode('utf8')


def collect(c):
    counters = [int(v) for v in open('/proc/stat').readline().split()[1:9]]
    mem = {k: int(v.split()[0]) * 1024 for k, v in (line.split(':', 1) for line in open('/proc/meminfo'))}
    pressure = dict(x.split('=') for x in open('/proc/pressure/cpu').readline().split()[1:])
    mounts = {}
    for key, m in c['mounts'].items():
        mounted = os.path.ismount(m['path'])
        if mounted and m.get('source'):
            expected = m['source']
            column = 'UUID' if expected.startswith('UUID=') else 'SOURCE'
            source = run_bounded(['/usr/bin/findmnt', '--noheadings', '--raw', '--mountpoint', m['path'], '--output', column], timeout=3).strip()
            mounted = source == (expected[5:] if column == 'UUID' else expected)
        if mounted:
            fs = os.statvfs(m['path'])
            used, available = fs.f_blocks - fs.f_bfree, fs.f_bavail
            require(used + available > 0)
            mounts[key] = {'mounted': True, 'readOnly': bool(fs.f_flag & os.ST_RDONLY),
                           'usedPercent': 100 * used / (used + available), 'freeBytes': available * fs.f_frsize}
        else:
            mounts[key] = {'mounted': False, 'readOnly': None, 'usedPercent': None, 'freeBytes': None}
    names = set(run_bounded(['/usr/bin/docker', 'ps', '-a', '--format', '{{.Names}}']).splitlines())
    selected = [name for name in c['containers'].values() if name in names]
    containers = {}
    if selected:
        fmt = '{"name":{{json .Name}},"running":{{json .State.Running}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}"none"{{end}}}'
        lines = run_bounded(['/usr/bin/docker', 'inspect', '--type', 'container', '--format', fmt, *selected]).splitlines()
        records = {v['name'].lstrip('/'): v for v in map(json.loads, lines)}
        require(set(records) == set(selected))
    else:
        records = {}
    for key, name in c['containers'].items():
        entry = records.get(name, {'running': False, 'health': 'missing'})
        containers[key] = {'running': entry['running'], 'health': entry['health']}
    # systemd's UNIT_STARTED message is emitted on successful oneshot completion,
    # not merely its activation request. No journal message bodies are read/output.
    raw = run_bounded(['/usr/bin/journalctl', '--no-pager', '-u', c['backupUnit'],
                       'MESSAGE_ID=39f53479d3a045ac8e11786248231fbf', '-n', '1', '-o', 'json',
                       '--output-fields=__REALTIME_TIMESTAMP,MESSAGE_ID,UNIT'])
    entry = json.loads(raw) if raw.strip() else None
    backup = int(entry['__REALTIME_TIMESTAMP']) / 1_000_000 if entry and entry.get('UNIT') == c['backupUnit'] else None
    return {'version': 1, 'sourceId': c['sourceId'], 'at': time.time(),
            'bootId': open('/proc/sys/kernel/random/boot_id').read().strip(),
            'cpuTotal': sum(counters), 'cpuIdle': counters[3] + counters[4], 'cpuPressure': float(pressure['avg60']),
            'availableBytes': mem['MemAvailable'], 'mounts': mounts, 'containers': containers, 'backupSuccessAt': backup}


def validate_sample(s, c, now):
    require(isinstance(s, dict) and s.get('version') == 1 and s.get('sourceId') == c['sourceId'])
    require(number(s.get('at')) and abs(now - s['at']) <= 90)
    require(isinstance(s.get('bootId'), str) and re.fullmatch(r'[A-Za-z0-9-]{1,64}', s['bootId']))
    require(number(s.get('cpuTotal'), 1) and number(s.get('cpuIdle'), 0, s['cpuTotal']))
    require(number(s.get('cpuPressure'), 0, 100) and number(s.get('availableBytes')))
    require(s.get('backupSuccessAt') is None or number(s['backupSuccessAt'], 0, now + 90))
    require(isinstance(s.get('mounts'), dict) and set(s['mounts']) == set(c['mounts']))
    require(isinstance(s.get('containers'), dict) and set(s['containers']) == set(c['containers']))
    for m in s['mounts'].values():
        require(isinstance(m.get('mounted'), bool))
        if m['mounted']:
            require(isinstance(m.get('readOnly'), bool) and number(m.get('usedPercent'), 0, 100) and number(m.get('freeBytes')))
        else:
            require(all(m.get(k) is None for k in ['readOnly', 'usedPercent', 'freeBytes']))
    for item in s['containers'].values():
        require(isinstance(item.get('running'), bool) and item.get('health') in ['healthy', 'unhealthy', 'starting', 'none', 'missing'])
    # Do not retain unknown remote fields (even if syntactically valid JSON).
    clean = {k: s[k] for k in ['version', 'sourceId', 'at', 'bootId', 'cpuTotal', 'cpuIdle', 'cpuPressure', 'availableBytes', 'backupSuccessAt']}
    clean['mounts'] = {k: {field: value[field] for field in ['mounted', 'readOnly', 'usedPercent', 'freeBytes']} for k, value in s['mounts'].items()}
    clean['containers'] = {k: {field: value[field] for field in ['running', 'health']} for k, value in s['containers'].items()}
    return clean


def evaluate(sample, previous, c, now, maintenance_until=0):
    p = copy.deepcopy(previous) if previous else {'version': 1, 'sourceId': c['sourceId'], 'epoch': uuid.uuid4().hex, 'sequence': 0, 'events': [], 'incidents': {}, 'advertised': {}, 'timers': {}, 'sample': None}
    require(p['version'] == 1 and p['sourceId'] == c['sourceId'])
    before = p['incidents']
    old = p['sample']
    contiguous = bool(old and 0 < now - p['checkedAt'] <= c['intervalSeconds'] * 1.5 and old['bootId'] == (sample or {}).get('bootId') and p.get('collectionOk'))
    timers = p['timers'] if contiguous else {}
    def sustained(key, matches, seconds=0, count=1, covered=0):
        if not matches:
            timers.pop(key, None)
            return False
        t = timers.setdefault(key, {'since': now - covered, 'count': 0})
        t['count'] += 1
        return now - t['since'] >= seconds and t['count'] >= count
    incidents = {}
    def add(key, severity, detail):
        incidents[key] = {'severity': severity, 'detail': detail[:180]}
    def active(key):
        return key in before
    def critical(key):
        return before.get(key, {}).get('severity') == 'critical'
    cpu = None
    if sample is None:
        incidents = copy.deepcopy(before)
        add('monitor', 'warning', 'Health collection unavailable; previous problems remain unverified.')
        timers = {}
    else:
        for key, m in sample['mounts'].items():
            if not m['mounted'] or m['readOnly']:
                add('mount-' + key, 'critical', 'Expected mount absent, wrong source, or read-only.')
            if not m['mounted']:
                if active('disk-' + key):
                    incidents['disk-' + key] = before['disk-' + key]
                continue
            rule = c['mounts'][key]
            for severity, pct, free in [('critical', rule['criticalPercent'], rule.get('criticalFreeBytes', 0)), ('warning', rule['warnPercent'], rule.get('warnFreeBytes', 0))]:
                if m['usedPercent'] >= pct or m['freeBytes'] < free:
                    add('disk-' + key, severity, f"{m['usedPercent']:.1f}% used; {m['freeBytes']/1024**3:.1f} GiB free.")
                    break
        for key, item in sample['containers'].items():
            bad = not item['running'] or item['health'] in ['unhealthy', 'starting', 'missing']
            qualifies = sustained('container-' + key, bad, count=2)
            if not item['running'] and c['containers'][key]['criticalDown']:
                add('container-' + key, 'critical', 'Required container not running.')
            elif bad and (qualifies or active('container-' + key)):
                add('container-' + key, 'warning', 'Container stopped, missing, or not healthy.')
        r = c['ram']
        warn, crit = sample['availableBytes'] < r['warnBytes'], sample['availableBytes'] < r['criticalBytes']
        w = sustained('ram-warn', warn, r['warnSeconds']); k = sustained('ram-critical', crit, r['criticalSeconds'])
        if crit and (k or critical('ram')):
            add('ram', 'critical', f"{sample['availableBytes']/1024**3:.2f} GiB available.")
        elif warn and (w or active('ram')):
            add('ram', 'warning', f"{sample['availableBytes']/1024**3:.2f} GiB available.")
        if contiguous:
            total, idle = sample['cpuTotal'] - old['cpuTotal'], sample['cpuIdle'] - old['cpuIdle']
            if total > 0 and 0 <= idle <= total:
                cpu = 100 * (total - idle) / total
        if cpu is not None:
            rule = c['cpu'];warn = cpu > rule['warnPercent'];crit = cpu > rule['criticalPercent']
            covered = now - p['checkedAt']
            w = sustained('cpu-warn', warn, rule['forSeconds'], covered=covered)
            k = sustained('cpu-critical', crit, rule['forSeconds'], covered=covered)
            contention = sample['cpuPressure'] >= rule['contentionPercent']
            if crit and contention and (k or critical('cpu')):
                add('cpu', 'critical', f"CPU {cpu:.1f}%; CPU wait pressure {sample['cpuPressure']:.1f}%.")
            elif warn and (w or active('cpu')):
                add('cpu', 'warning', f"CPU {cpu:.1f}% over the latest sample interval.")
        elif active('cpu'):
            incidents['cpu'] = before['cpu']
        if sample['backupSuccessAt'] is None:
            add('backup', 'warning', 'No retained evidence of successful backup completion.')
        else:
            age = max(0, now - sample['backupSuccessAt'])
            if age >= c['backup']['criticalSeconds']:
                add('backup', 'critical', f'Last successful backup {age/3600:.1f} hours ago.')
            elif age >= c['backup']['warnSeconds']:
                add('backup', 'warning', f'Last successful backup {age/3600:.1f} hours ago.')
        p['sample'] = sample
    if maintenance_until <= now:
        levels = {k: v['severity'] for k, v in incidents.items()}
        changes = [{'id': k, 'from': p['advertised'].get(k, 'healthy'), 'to': levels.get(k, 'healthy')}
                   for k in sorted(set(levels) | set(p['advertised'])) if levels.get(k) != p['advertised'].get(k)]
        if changes:
            p['sequence'] += 1
            p['events'].append({'sequence': p['sequence'], 'at': now, 'changes': changes})
        p['advertised'] = levels
    p.update(checkedAt=now, collectionOk=sample is not None, cpuPercent=cpu, maintenanceUntil=maintenance_until,
             incidents=incidents, timers=timers, events=p['events'][-12:])
    return p


def report(p, c):
    s = p['sample']
    result = {k: p[k] for k in ['version', 'sourceId', 'epoch', 'sequence', 'checkedAt', 'collectionOk', 'cpuPercent', 'maintenanceUntil', 'incidents', 'events']}
    result['staleAfterSeconds'] = c['intervalSeconds'] * 2
    result['lastSuccessfulAt'] = s['at'] if s else None
    result['metrics'] = {k: s[k] for k in ['availableBytes', 'cpuPressure', 'mounts', 'containers', 'backupSuccessAt']} if s else None
    while len(json.dumps(result)) > 32000 and result['events']:
        result['events'] = result['events'][1:]
    return result


def ssh_command(c):
    s = c['ssh']
    return ['/usr/bin/ssh', '-F', '/dev/null', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
            '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
            '-o', 'ConnectTimeout=8', '-o', 'ConnectionAttempts=1', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2',
            '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'HostKeyAlgorithms=ssh-ed25519', '-o', 'UpdateHostKeys=no',
            '-o', 'UserKnownHostsFile=' + s['knownHosts'], '-i', s['key'], s['user'] + '@' + s['host']]


def poll(c):
    # Keep locks and evaluator state private; only the sanitized report is group-readable.
    lock = os.open(c['statePath'] + '.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            previous = read_json(c['statePath'])
        except FileNotFoundError:
            previous = None
        maintenance = 0
        try:
            m = read_json(c['maintenancePath'])
            require(m.get('version') == 1 and number(m.get('until')))
            maintenance = m['until']
        except FileNotFoundError:
            pass
        now = time.time()
        require(maintenance <= now + 86400)
        try:
            sample = validate_sample(json.loads(run_bounded(ssh_command(c), timeout=38)), c, time.time())
        except (CollectionError, ValueError, KeyError, TypeError):
            sample = None
        updated = evaluate(sample, previous, c, time.time(), maintenance)
        # State precedes the disposable report: interrupted report writes regenerate
        # the same sequence/history on the next sample, without losing transitions.
        atomic_json(c['statePath'], updated)
        atomic_json(c['reportPath'], report(updated, c), 0o640)
        print(json.dumps({'ok': True, 'collectionOk': updated['collectionOk'], 'sequence': updated['sequence']}))
    finally:
        os.close(lock)


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ['collect', 'poll', 'validate-collect', 'validate-poll']:
        raise ValueError('Usage: linux-host-monitor.py collect|poll|validate-collect|validate-poll <private-config>')
    action = sys.argv[1]
    config = validate_config(read_json(sys.argv[2]), action.removeprefix('validate-'))
    if action.startswith('validate-'):
        print('{"ok":true}')
    elif action == 'collect':
        print(json.dumps(collect(config), allow_nan=False))
    else:
        poll(config)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Provider/command output and configuration never become diagnostics.
        print('Health monitor failed: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
