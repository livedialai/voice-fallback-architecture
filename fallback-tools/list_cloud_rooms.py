#!/usr/bin/env python3
"""Raeume + Teilnehmer der LiveKit-Cloud auflisten — zeigt, WER im Anruf war (SIP-Teilnehmer + Agent).

Damit belegt man einen Fallback-Anruf: Raum '<praefix>_<caller>_<random>' mit Teilnehmern
'sip_<caller>' UND 'agent-<jobID>' => der Cloud-Agent war wirklich dabei.

Umgebung: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET (oder CLOUD_ENV=<datei>)
Aufruf:   list_cloud_rooms.py [anzahl_raeume]
"""
import base64, hashlib, hmac, json, os, sys, time, urllib.error, urllib.request

ENV = dict(os.environ)
if ENV.get('CLOUD_ENV') and os.path.exists(ENV['CLOUD_ENV']):
    for line in open(ENV['CLOUD_ENV']):
        if '=' in line and not line.strip().startswith('#'):
            k, v = line.strip().split('=', 1)
            ENV.setdefault(k, v)

for n in ('LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'):
    if not ENV.get(n):
        sys.exit('fehlt: %s' % n)
BASE = ENV['LIVEKIT_URL'].replace('wss://', 'https://').replace('ws://', 'http://').rstrip('/')
LIMIT = int(sys.argv[1]) if len(sys.argv) > 1 else 5


def _b64(b):
    return base64.urlsafe_b64encode(b).rstrip(b'=').decode()


def jwt():
    now = int(time.time())
    h = _b64(json.dumps({'alg': 'HS256', 'typ': 'JWT'}, separators=(',', ':')).encode())
    p = _b64(json.dumps({'exp': now + 600, 'iss': ENV['LIVEKIT_API_KEY'], 'nbf': now - 10,
                         'video': {'roomAdmin': True, 'roomCreate': True, 'roomList': True,
                                   'roomJoin': True}}, separators=(',', ':')).encode())
    sig = hmac.new(ENV['LIVEKIT_API_SECRET'].encode(), ('%s.%s' % (h, p)).encode(),
                   hashlib.sha256).digest()
    return '%s.%s.%s' % (h, p, _b64(sig))


def rpc(service, method, body):
    req = urllib.request.Request('%s/twirp/livekit.%s/%s' % (BASE, service, method),
                                 data=json.dumps(body).encode(),
                                 headers={'Authorization': 'Bearer %s' % jwt(),
                                          'Content-Type': 'application/json'})
    try:
        raw = urllib.request.urlopen(req, timeout=20).read()
        return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        return {'_err': e.code, '_body': e.read().decode()[:200]}


def ts(v):
    try:
        return time.strftime('%H:%M:%S', time.localtime(int(v) / 1000))
    except Exception:
        return str(v)


rooms = rpc('RoomService', 'ListRooms', {}).get('rooms') or []
for r in sorted(rooms, key=lambda x: -int(x.get('creation_time', 0) or 0))[:LIMIT]:
    name = r.get('name')
    print('RAUM %s  seit %s  n=%s' % (name, ts(r.get('creation_time')), r.get('num_participants')))
    parts = rpc('RoomService', 'ListParticipants', {'room': name}).get('participants') or []
    for p in parts:
        print('     - %-28s kind=%s joined=%s' % (p.get('identity'), p.get('kind'), ts(p.get('joined_at'))))
