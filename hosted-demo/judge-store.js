'use strict';
// Database primitives for the hosted judge workflow. This module does not enable
// checkout: the existing payment engine must be adapted to await durable writes.
const crypto = require('node:crypto');
const { Pool } = require('pg');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const random = () => crypto.randomBytes(32).toString('base64url');
const uuid = () => crypto.randomUUID();
const SCHEMA = `
CREATE TABLE IF NOT EXISTS judge_invitations (
 token_hash text PRIMARY KEY, judge_id uuid NOT NULL, expires_at timestamptz NOT NULL,
 redeemed_at timestamptz, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS judge_sessions (
 token_hash text PRIMARY KEY, judge_id uuid NOT NULL, expires_at timestamptz NOT NULL,
 revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE judge_sessions ADD COLUMN IF NOT EXISTS reusable_code_hash text;
CREATE TABLE IF NOT EXISTS judge_login_limits (
 scope_hash text PRIMARY KEY, started_at timestamptz NOT NULL, attempts integer NOT NULL
);
CREATE TABLE IF NOT EXISTS judge_projects (
 id uuid PRIMARY KEY, judge_id uuid NOT NULL, data jsonb NOT NULL,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (id, judge_id)
);
CREATE TABLE IF NOT EXISTS judge_provider_usage (
 scope text NOT NULL, provider text NOT NULL, window_name text NOT NULL,
 started_at timestamptz NOT NULL, request_count integer NOT NULL CHECK(request_count >= 0),
 PRIMARY KEY(scope,provider,window_name)
);
CREATE TABLE IF NOT EXISTS judge_payment_attempts (
 id uuid PRIMARY KEY, judge_id uuid NOT NULL, project_id uuid NOT NULL,
 state text NOT NULL, amount_cents bigint NOT NULL CHECK (amount_cents > 0),
 currency text NOT NULL CHECK (currency = 'USD'), merchant_id text NOT NULL,
 catalog_snapshot jsonb NOT NULL, order_id text UNIQUE, authorization_id text UNIQUE,
 capture_id text UNIQUE, version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (project_id, judge_id) REFERENCES judge_projects (id, judge_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS judge_one_unresolved_attempt
 ON judge_payment_attempts (project_id) WHERE state IN
 ('creating','created','approved','authorizing','authorized','capture_pending','void_pending','unknown');
CREATE TABLE IF NOT EXISTS judge_payment_operations (
 id uuid PRIMARY KEY, attempt_id uuid NOT NULL REFERENCES judge_payment_attempts(id),
 operation text NOT NULL, idempotency_key uuid NOT NULL UNIQUE, state text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (attempt_id, operation)
);
CREATE TABLE IF NOT EXISTS judge_payment_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 attempt_id uuid NOT NULL REFERENCES judge_payment_attempts(id), event_type text NOT NULL,
 provider_status text, created_at timestamptz NOT NULL DEFAULT now()
);
`;
class JudgeStore {
 constructor({pool,connectionString}={}) { this.pool=pool||new Pool({connectionString,max:5,connectionTimeoutMillis:5000}); }
 async initialize(){const client=await this.pool.connect();try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock($1)',[1792146901]);await client.query(SCHEMA);await client.query('COMMIT')}catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}}
 async close(){await this.pool.end()}
 async createInvitation({judgeId=uuid(),expiresAt}){if(!Number.isFinite(Date.parse(expiresAt))||Date.parse(expiresAt)<=Date.now())throw Error('A future invitation expiration is required.');const token=random();await this.pool.query('INSERT INTO judge_invitations(token_hash,judge_id,expires_at) VALUES ($1,$2,$3)',[digest(token),judgeId,expiresAt]);return {token,judgeId}}
 async redeemInvitation(token){if(typeof token!=='string')throw Error('Invalid invitation.');token=token.trim();if(/^[A-HJ-NP-Z2-9]{5}(?:-[A-HJ-NP-Z2-9]{5}){3}$/i.test(token))token=token.toUpperCase();else if(!/^[-_A-Za-z0-9]{43}$/.test(token))throw Error('Invalid invitation.');const tokenHash=digest(token),reusableHash=process.env.STACHA_REUSABLE_JUDGE_CODE_SHA256||'',validHash=/^[a-f0-9]{64}$/.test(reusableHash),isReusable=validHash&&crypto.timingSafeEqual(Buffer.from(tokenHash,'hex'),Buffer.from(reusableHash,'hex'));if(isReusable&&process.env.STACHA_REUSABLE_JUDGE_ENABLED!=='true')return null;const client=await this.pool.connect();try{await client.query('BEGIN');let judgeId;if(isReusable){judgeId=uuid()}else{const found=await client.query(`UPDATE judge_invitations SET redeemed_at=now() WHERE token_hash=$1 AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at>now() RETURNING judge_id`,[tokenHash]);if(!found.rowCount){await client.query('ROLLBACK');return null}judgeId=found.rows[0].judge_id}const session=random();await client.query("INSERT INTO judge_sessions(token_hash,judge_id,expires_at,reusable_code_hash) VALUES($1,$2,'infinity',$3)",[digest(session),judgeId,isReusable?tokenHash:null]);await client.query('COMMIT');return {token:session,judgeId}}catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}}
 async consumeLoginLimit(address){const max=60,seconds=600,key=digest('judge-login:'+String(address||'unknown'));const result=await this.pool.query(`INSERT INTO judge_login_limits(scope_hash,started_at,attempts) VALUES($1,clock_timestamp(),1) ON CONFLICT(scope_hash) DO UPDATE SET started_at=CASE WHEN judge_login_limits.started_at+($2 * interval '1 second')<=clock_timestamp() THEN clock_timestamp() ELSE judge_login_limits.started_at END,attempts=CASE WHEN judge_login_limits.started_at+($2 * interval '1 second')<=clock_timestamp() THEN 1 ELSE judge_login_limits.attempts+1 END WHERE judge_login_limits.started_at+($2 * interval '1 second')<=clock_timestamp() OR judge_login_limits.attempts<$3 RETURNING attempts`,[key,seconds,max]);return result.rowCount>0}
 async authenticate(token){if(typeof token!=='string'||token.length!==43)return null;const hash=digest(token),result=await this.pool.query("SELECT judge_id,reusable_code_hash,expires_at='infinity'::timestamptz AS unlimited FROM judge_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()",[hash]);const row=result.rows[0];if(!row)return null;if(row.reusable_code_hash&&(process.env.STACHA_REUSABLE_JUDGE_ENABLED!=='true'||row.reusable_code_hash!==process.env.STACHA_REUSABLE_JUDGE_CODE_SHA256))return null;if(row.unlimited)return row.judge_id;const upgraded=await this.pool.query("UPDATE judge_sessions SET expires_at='infinity' WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now() RETURNING judge_id",[hash]);return upgraded.rows[0]?.judge_id||null}
 async revokeSession(token){if(typeof token!=='string')return;await this.pool.query('UPDATE judge_sessions SET revoked_at=now() WHERE token_hash=$1',[digest(token)])}
 async createProject(judgeId,data,id=uuid()){await this.pool.query('INSERT INTO judge_projects(id,judge_id,data) VALUES($1,$2,$3)',[id,judgeId,data]);return id}
 async listProjects(judgeId){const result=await this.pool.query("SELECT id,data->>'mode' AS mode,data->'o'->>'name' AS name,updated_at FROM judge_projects WHERE judge_id=$1 ORDER BY updated_at DESC LIMIT 100",[judgeId]);return result.rows}
 async getProjectByCapability(judgeId,tokenHash){const result=await this.pool.query("SELECT id,data,version FROM judge_projects WHERE judge_id=$1 AND data->'capabilities' ? $2 LIMIT 1",[judgeId,tokenHash]);return result.rows[0]||null}
 async getProject(judgeId,id){const result=await this.pool.query('SELECT id,data,version FROM judge_projects WHERE id=$1 AND judge_id=$2',[id,judgeId]);return result.rows[0]||null}
 async updateProject(judgeId,id,version,data){const result=await this.pool.query('UPDATE judge_projects SET data=$4,version=version+1,updated_at=now() WHERE id=$1 AND judge_id=$2 AND version=$3 RETURNING version',[id,judgeId,version,data]);return result.rows[0]?.version||null}
 async createAttempt(judgeId,projectId,{amountCents,currency,merchantId,catalogSnapshot}){if(!Number.isSafeInteger(amountCents)||amountCents<1||currency!=='USD'||typeof merchantId!=='string'||!merchantId||!Array.isArray(catalogSnapshot)||!catalogSnapshot.length)throw Error('Invalid payment terms.');const id=uuid();await this.pool.query(`INSERT INTO judge_payment_attempts(id,judge_id,project_id,state,amount_cents,currency,merchant_id,catalog_snapshot) VALUES($1,$2,$3,'creating',$4,$5,$6,$7)`,[id,judgeId,projectId,amountCents,currency,merchantId,JSON.stringify(catalogSnapshot)]);return id}
 async startOperation(judgeId,attemptId,{operation,expectedState,pendingState}){const allowed={create:['creating','creating'],authorize:['approved','authorizing'],capture:['authorized','capture_pending'],void:['authorized','void_pending']};const pair=allowed[operation];if(!pair||pair[0]!==expectedState||pair[1]!==pendingState)throw Error('Invalid operation transition.');const client=await this.pool.connect();try{await client.query('BEGIN');const a=await client.query('UPDATE judge_payment_attempts SET state=$3,version=version+1,updated_at=now() WHERE id=$1 AND judge_id=$2 AND state=$4 RETURNING id',[attemptId,judgeId,pendingState,expectedState]);if(!a.rowCount){await client.query('ROLLBACK');return null}const id=uuid(),key=uuid();await client.query("INSERT INTO judge_payment_operations(id,attempt_id,operation,idempotency_key,state) VALUES($1,$2,$3,$4,'pending')",[id,attemptId,operation,key]);await client.query('INSERT INTO judge_payment_events(attempt_id,event_type) VALUES($1,$2)',[attemptId,operation+'_requested']);await client.query('COMMIT');return {id,idempotencyKey:key}}catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}}
}
module.exports={JudgeStore,digest};
