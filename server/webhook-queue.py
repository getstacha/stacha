#!/usr/bin/env python3
"""Small SQLite-backed webhook queue. Input/output is JSON over stdin/stdout."""
import json, sqlite3, sys, os, time, stat
os.umask(0o077)
op, db = sys.argv[1:3]
payload=json.load(sys.stdin)
parent=os.path.dirname(os.path.abspath(db))
os.makedirs(parent,mode=0o700,exist_ok=True)
if os.path.islink(parent): raise ValueError('Unsafe database directory')
flags=os.O_RDWR|os.O_CREAT|getattr(os,'O_NOFOLLOW',0)
fd=os.open(db,flags,0o600)
try:
 st=os.fstat(fd)
 if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1: raise ValueError('Unsafe database file')
 os.fchmod(fd,0o600)
finally: os.close(fd)
conn=sqlite3.connect(db,timeout=10)
conn.execute('PRAGMA journal_mode=WAL')
conn.execute('PRAGMA synchronous=FULL')
conn.execute('CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, body TEXT NOT NULL, headers TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, received_at TEXT NOT NULL, last_attempt_at TEXT, delivered_at TEXT)')
conn.execute('CREATE TABLE IF NOT EXISTS financial_events (event_key TEXT PRIMARY KEY, kind TEXT NOT NULL, project_id TEXT NOT NULL, order_id TEXT NOT NULL, reference TEXT NOT NULL, amount_cents INTEGER NOT NULL, currency TEXT NOT NULL, verified_at TEXT NOT NULL)')
conn.execute("CREATE TRIGGER IF NOT EXISTS financial_events_no_update BEFORE UPDATE ON financial_events BEGIN SELECT RAISE(ABORT, 'append-only'); END")
conn.execute("CREATE TRIGGER IF NOT EXISTS financial_events_no_delete BEFORE DELETE ON financial_events BEGIN SELECT RAISE(ABORT, 'append-only'); END")
now=int(time.time()*1000)
with conn:
 if op=='ledger':
  c=conn.execute('INSERT OR IGNORE INTO financial_events (event_key,kind,project_id,order_id,reference,amount_cents,currency,verified_at) VALUES (?,?,?,?,?,?,?,?)',(payload['key'],payload['kind'],payload['projectId'],payload['orderId'],payload['reference'],payload['amountCents'],payload['currency'],payload['verifiedAt']))
  if c.rowcount==0:
   old=conn.execute('SELECT kind,project_id,order_id,reference,amount_cents,currency FROM financial_events WHERE event_key=?',(payload['key'],)).fetchone()
   if old!=(payload['kind'],payload['projectId'],payload['orderId'],payload['reference'],payload['amountCents'],payload['currency']): raise ValueError('Financial event conflict')
  out={'ok':True}
 elif op=='enqueue':
  c=conn.execute('INSERT OR IGNORE INTO events (id,body,headers,status,next_at,received_at) VALUES (?,?,?,?,?,?)',(payload['id'],payload['body'],json.dumps(payload['headers']), 'pending',now,payload['receivedAt']))
  out={'inserted':c.rowcount==1}
 elif op=='next':
  row=conn.execute("SELECT id,body,headers,attempts FROM events WHERE status='pending' AND next_at<=? ORDER BY received_at LIMIT 1",(now,)).fetchone()
  out=None if not row else {'id':row[0],'body':row[1],'headers':json.loads(row[2]),'attempts':row[3]}
 elif op=='result':
  if payload['delivered']:
   conn.execute("UPDATE events SET status='delivered',attempts=attempts+1,last_attempt_at=?,delivered_at=? WHERE id=?",(payload['time'],payload['time'],payload['id']))
  else:
   conn.execute("UPDATE events SET attempts=attempts+1,last_attempt_at=?,next_at=? WHERE id=?",(payload['time'],now+min(3600000,5000*2**min(payload['attempts'],9)),payload['id']))
  out={'ok':True}
 else: raise ValueError('Unknown operation')
print(json.dumps(out))
