#!/usr/bin/env python3
"""Testanruf per SIP (UDP) — beweist, dass ein Ziel einen Anruf annimmt.

Nutzen:
  * gegen die LiveKit Cloud  -> SIP_TARGET=<edge-ip>:5060  SIP_HOST=<cloud-sip-host>
  * gegen den eigenen Proxy  -> SIP_TARGET=<proxy-ip>:5070 SIP_HOST=<proxy-ip>
    (Proxy muss die Test-IP in der Allow-List haben!)

Umgebung / Argumente:
  SIP_TARGET    Ziel-IP:Port,            Default 127.0.0.1:5060
  SIP_HOST      Host im R-URI (Domain),  Default = SIP_TARGET-IP
  DID           angerufene Nummer,       Default per Argument/ENV
  CALLER        eigene Nummer (From),    Default 015112345678
  LOCAL_IP      eigene Absender-IP,      Default = automatisch
  LOCAL_PORT    eigener SIP-Port,        Default 5079
  WAIT          Sekunden warten,         Default 40
  WORKER_LOG_CMD  optionaler Shell-Befehl, dessen Ausgabe gezeigt wird
                  (z. B. 'docker logs --since 2m <worker> | grep -a "Guten Tag"')

Exit 0, wenn 200 OK empfangen wurde.
"""
import os, random, re, socket, subprocess, sys, time

TARGET = os.environ.get('SIP_TARGET', '127.0.0.1:5060')
TIP, TPORT = TARGET.rsplit(':', 1)
TPORT = int(TPORT)
HOST = os.environ.get('SIP_HOST', TIP)
DID = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get('DID', '0049000000000'))
CALLER = os.environ.get('CALLER', '015112345678')
LOCAL_IP = os.environ.get('LOCAL_IP') or socket.gethostbyname(socket.gethostname())
MYPORT = int(os.environ.get('LOCAL_PORT', '5079'))
WAIT = int(os.environ.get('WAIT', '40'))

cid = int(time.time())
callid = 'test%d@%s' % (cid, LOCAL_IP)
fromtag = str(random.randint(10 ** 8, 10 ** 9))
uri = 'sip:%s@%s:5060' % (DID, HOST)
me = 'sip:test@%s:%d' % (LOCAL_IP, MYPORT)

sdp = ('v=0\r\no=- 1 1 IN IP4 %s\r\ns=test\r\nc=IN IP4 %s\r\n'
       't=0 0\r\nm=audio 40004 RTP/AVP 0 8 101\r\n'
       'a=rtpmap:0 PCMU/8000\r\na=rtpmap:8 PCMA/8000\r\n'
       'a=rtpmap:101 telephone-event/8000\r\na=fmtp:101 0-16\r\na=sendrecv\r\n'
       % (LOCAL_IP, LOCAL_IP))


def msg(method, cseq, extra='', body='', totag=None):
    to = '<sip:%s@%s>' % (DID, HOST) + (';tag=%s' % totag if totag else '')
    head = ('%s %s SIP/2.0\r\n'
            'Via: SIP/2.0/UDP %s:%d;branch=z9hG4bK%d\r\n'
            'Max-Forwards: 70\r\n'
            'To: %s\r\n'
            'From: <sip:%s@%s>;tag=%s\r\n'
            'Call-ID: %s\r\nCSeq: %d %s\r\n'
            % (method, uri, LOCAL_IP, MYPORT, random.randint(10 ** 8, 10 ** 9),
               to, CALLER, LOCAL_IP, fromtag, callid, cseq, method))
    if method == 'INVITE':
        head += 'Contact: <%s>\r\nContent-Type: application/sdp\r\n' % me
        body = sdp
    head += extra
    return head + 'Content-Length: %d\r\n\r\n%s' % (len(body), body)


s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind((os.environ.get('BIND_IP', '0.0.0.0'), MYPORT))
s.settimeout(5)
s.sendto(msg('INVITE', 1).encode(), (TIP, TPORT))
print('INVITE -> %s:%d   (R-URI-Host=%s, DID=%s, Anrufer=%s)' % (TIP, TPORT, HOST, DID, CALLER))

codes, totag, ok, t0 = [], None, False, time.time()
while time.time() - t0 < WAIT:
    try:
        data, _addr = s.recvfrom(8192)
    except socket.timeout:
        continue
    text = data.decode('utf-8', 'replace')
    first = text.split('\r\n')[0]
    if not first.startswith('SIP/2.0'):
        continue
    codes.append(first.split(' ')[1])
    print('  <-', first.strip())
    if first.startswith('SIP/2.0 200'):
        ok = True
        m = re.search(r'^To:.*?tag=([^;\r]+)', text, re.M | re.I)
        totag = m.group(1) if m else ''
        s.sendto(msg('ACK', 1, totag=totag).encode(), (TIP, TPORT))
        print('  -> ACK gesendet — Anruf ANGENOMMEN')
        break
    if first.startswith('SIP/2.0 4') or first.startswith('SIP/2.0 5'):
        break

if totag:
    s.sendto(msg('BYE', 2, totag=totag).encode(), (TIP, TPORT))
    print('  -> BYE gesendet')
s.close()

print('Antwortcodes:', ' -> '.join(codes) if codes else '(keine Antwort)')
if os.environ.get('WORKER_LOG_CMD'):
    print('--- Worker-Log ---')
    print(subprocess.run(['bash', '-c', os.environ['WORKER_LOG_CMD']],
                         capture_output=True, text=True).stdout.strip() or '(leer)')
print('ERGEBNIS:', 'ANGENOMMEN (200 OK)' if ok else 'NICHT angenommen')
sys.exit(0 if ok else 1)
