#!/usr/bin/env python3
"""Cloud-SIP fuer den Fallback: Inbound-Trunk + Dispatch-Rule sicherstellen (idempotent).

Ohne diese beiden Objekte nimmt die LiveKit Cloud entweder keinen Anruf an
("404 No trunk found") oder dispatcht keinen Agenten (Anruf klingelt, niemand spricht).

Umgebung (oder .env-Datei via CLOUD_ENV):
  LIVEKIT_URL          wss://<projekt>.livekit.cloud
  LIVEKIT_API_KEY      aus dem Cloud-Projekt
  LIVEKIT_API_SECRET   aus dem Cloud-Projekt
  CLOUD_DIDS           Komma-Liste ALLER Schreibweisen der Nummer, z. B.
                       "+4947...,004947...,4947...,0471..."
  CLOUD_ALLOWED        Komma-Liste erlaubter Quell-IPs, z. B.
                       "<SIP_PROXY_IP>/32,<CARRIER_IP_1>/32"
  CLOUD_AGENT          Agent-Name (muss LIVEKIT_AGENT_NAME des Workers sein)
  CLOUD_ROOM_PREFIX    Raum-Praefix, z. B. "edeka_"

Aufruf:  create_cloud_sip.py list     -> Ist-Zustand
         create_cloud_sip.py apply    -> anlegen/aktualisieren + Kontrolle
"""
import base64, hashlib, hmac, json, os, sys, time, urllib.error, urllib.request


def load_env():
    env = dict(os.environ)
    path = env.get('CLOUD_ENV')
    if path and os.path.exists(path):
        for line in open(path):
            if '=' in line and not line.strip().startswith('#'):
                k, v = line.strip().split('=', 1)
                env.setdefault(k, v)
    return env


ENV = load_env()


def need(name):
    v = ENV.get(name)
    if not v:
        sys.exit('fehlt: %s' % name)
    return v


BASE = need('LIVEKIT_URL').replace('wss://', 'https://').replace('ws://', 'http://').rstrip('/')
KEY, SEC = need('LIVEKIT_API_KEY'), need('LIVEKIT_API_SECRET')
MODE = (sys.argv[1] if len(sys.argv) > 1 else 'list').lower()


def _list(name):
    return [x.strip() for x in ENV.get(name, '').split(',') if x.strip()]


DIDS = _list('CLOUD_DIDS')
ALLOWED = [(a if '/' in a else a + '/32') for a in _list('CLOUD_ALLOWED')]
AGENT = ENV.get('CLOUD_AGENT', 'edeka-agent')
PREFIX = ENV.get('CLOUD_ROOM_PREFIX', 'edeka_')
if MODE == 'apply':
    for n in ('CLOUD_DIDS', 'CLOUD_ALLOWED'):
        if not ENV.get(n):
            sys.exit('fuer "apply" noetig: %s' % n)


def _b64(b):
    return base64.urlsafe_b64encode(b).rstrip(b'=').decode()


def jwt():
    now = int(time.time())
    head = _b64(json.dumps({'alg': 'HS256', 'typ': 'JWT'}, separators=(',', ':')).encode())
    payload = _b64(json.dumps({
        'exp': now + 600, 'iss': KEY, 'nbf': now - 10,
        'video': {'roomAdmin': True, 'roomCreate': True, 'roomList': True},
        'sip': {'admin': True},
    }, separators=(',', ':')).encode())
    sig = hmac.new(SEC.encode(), ('%s.%s' % (head, payload)).encode(), hashlib.sha256).digest()
    return '%s.%s.%s' % (head, payload, _b64(sig))


def rpc(method, body):
    req = urllib.request.Request(
        '%s/twirp/livekit.SIP/%s' % (BASE, method),
        data=json.dumps(body).encode(),
        headers={'Authorization': 'Bearer %s' % jwt(), 'Content-Type': 'application/json'})
    try:
        raw = urllib.request.urlopen(req, timeout=25).read()
        return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        return {'_err': e.code, '_body': e.read().decode()[:300]}


def _get(d, *names):
    for n in names:
        if d.get(n) not in (None, [], ''):
            return d[n]
    return d.get(names[0])


def list_objects(verbose=True):
    tr = rpc('ListSIPInboundTrunk', {})
    ru = rpc('ListSIPDispatchRule', {})
    if verbose:
        print('BASE :', BASE)
        for t in (tr.get('items') or []):
            print('TRUNK', _get(t, 'sipTrunkId', 'sip_trunk_id'),
                  '| numbers:', _get(t, 'numbers') or [],
                  '| allowed:', _get(t, 'allowedAddresses', 'allowed_addresses') or [])
        for x in (ru.get('items') or []):
            rc = _get(x, 'roomConfig', 'room_config') or {}
            print('RULE ', _get(x, 'sipDispatchRuleId', 'sip_dispatch_rule_id'),
                  '| trunks:', _get(x, 'trunkIds', 'trunk_ids') or [],
                  '| rule:', json.dumps(_get(x, 'rule') or {})[:70],
                  '| agents:', rc.get('agents'))
        if tr.get('_err') or ru.get('_err'):
            print('FEHLER:', tr.get('_err') or ru.get('_err'), tr.get('_body') or ru.get('_body'))
    return tr, ru


def apply():
    tr, ru = list_objects(verbose=False)

    # --- Trunk: vorhandenen passenden nehmen, sonst anlegen -------------------
    tid = None
    for t in (tr.get('items') or []):
        nums = _get(t, 'numbers') or []
        if not nums or any(d in nums for d in DIDS):
            tid = _get(t, 'sipTrunkId', 'sip_trunk_id')
            old = [(a if '/' in a else a + '/32')
                   for a in (_get(t, 'allowedAddresses', 'allowed_addresses') or [])]
            body = {'name': _get(t, 'name') or 'agent-inbound',
                    'numbers': DIDS, 'allowedAddresses': sorted(set(old) | set(ALLOWED))}
            print('Trunk aktualisieren:', tid, rpc('UpdateSIPInboundTrunk',
                                                   {'sipTrunkId': tid, 'replace': body}) and 'ok')
            break
    if not tid:
        res = rpc('CreateSIPInboundTrunk', {'trunk': {
            'name': 'agent-inbound', 'numbers': DIDS, 'allowedAddresses': ALLOWED}})
        tid = _get(res, 'sipTrunkId', 'sip_trunk_id')
        print('Trunk angelegt:', tid or res)

    # --- Dispatch-Rule: WICHTIG ist roomConfig.agents ------------------------
    body = {'name': AGENT,
            'rule': {'dispatchRuleIndividual': {'roomPrefix': PREFIX}},
            'trunkIds': [tid],
            'roomConfig': {'agents': [{'agentName': AGENT}]}}
    rid = None
    for x in (ru.get('items') or []):
        if tid in (_get(x, 'trunkIds', 'trunk_ids') or []):
            rid = _get(x, 'sipDispatchRuleId', 'sip_dispatch_rule_id')
            break
    if rid:
        rpc('UpdateSIPDispatchRule', {'sipDispatchRuleId': rid, 'replace': body})
        print('Rule aktualisiert:', rid)
    else:
        res = rpc('CreateSIPDispatchRule', body)
        print('Rule angelegt:', _get(res, 'sipDispatchRuleId', 'sip_dispatch_rule_id') or res)

    print('--- Kontrolle ---')
    list_objects()


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'list'
    if cmd == 'apply':
        apply()
    else:
        list_objects()
