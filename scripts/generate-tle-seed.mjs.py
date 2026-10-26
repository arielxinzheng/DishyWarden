#!/usr/bin/env python3
"""
Generate the bundled TLE seed from real CelesTrak data.

Keeps the top-N shells by population (covers the bulk of the constellation),
and writes a gzipped JSON the app loads at startup. Seed is a fallback for
offline operation, not a precision source.
"""
import json, glob, gzip, collections, math, os, datetime

SRC = sorted(glob.glob('/Users/lixinzheng/ClaudeCode/Patent/202607/Experiment/data/real/raw/tle/tle_starlink_*.json'))[-1]
OUT_DIR = '/Users/lixinzheng/Documents/work/星链/SLMonitor/src/renderer/assets'
OUT = os.path.join(OUT_DIR, 'tle-seed.json.gz')
TOP_N = 3

recs = json.load(open(SRC))['records']
fetched_at = json.load(open(SRC)).get('fetch_timestamp')

def parse(l2):
    try:
        incl = float(l2[8:16])
        no_kozai = float(l2[52:63])
        n = no_kozai * 2 * math.pi / 86400.0
        a = (398600.4418 / n ** 2) ** (1 / 3)
        return incl, 1440.0 / no_kozai, a - 6371.0
    except Exception:
        return None

rows = [(parse(r['line2']), r) for r in recs]
rows = [(p, r) for p, r in rows if p]

shells = collections.defaultdict(list)
for p, r in rows:
    shells[(round(p[0]), round(p[1] * 2) / 2)].append((p, r))

big = sorted([(k, v) for k, v in shells.items() if len(v) >= 100], key=lambda kv: -len(kv[1]))
sel_shells = big[:TOP_N]
selected = [r for _, v in sel_shells for _, r in v]

payload = {
    'fetchedAt': int(datetime.datetime.fromisoformat(fetched_at).timestamp() * 1000),
    'source': 'CelesTrak GP=starlink (bundled seed, top-%d shells)' % TOP_N,
    'shells': [
        {'inclination': k[0], 'periodMin': k[1], 'count': len(v)}
        for k, v in sel_shells
    ],
    'data': [
        {'name': 'STARLINK-%s' % r['satellite_id'], 'line1': r['line1'], 'line2': r['line2']}
        for r in selected
    ],
}

os.makedirs(OUT_DIR, exist_ok=True)
raw = json.dumps(payload, separators=(',', ':')).encode()
with gzip.open(OUT, 'wb', compresslevel=9) as f:
    f.write(raw)

print(f'source        : {SRC}')
print(f'fetched_at    : {fetched_at}')
print(f'shells kept   : {TOP_N}')
for k, v in sel_shells:
    alt = sum(x[0][2] for x in v) / len(v)
    print(f'   incl={k[0]}°  period={k[1]}m  alt={alt:.0f}km  n={len(v)}')
print(f'satellites    : {len(selected)} / {len(recs)}')
print(f'uncompressed  : {len(raw)/1024/1024:.2f} MB')
print(f'gzipped       : {os.path.getsize(OUT)/1024/1024:.2f} MB')
print(f'written       : {OUT}')

# verify round-trip
with gzip.open(OUT, 'rb') as f:
    back = json.loads(f.read())
assert len(back['data']) == len(selected)
assert all(d['line1'].startswith('1 ') and d['line2'].startswith('2 ') for d in back['data'][:50])
print('round-trip    : OK, line1/line2 pairing verified')