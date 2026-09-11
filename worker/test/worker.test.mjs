import assert from 'node:assert/strict';
import test from 'node:test';
import {createSession, handleRequest, publishSnapshot, status, validateSnapshot, verifySession} from '../src/index.js';

const ORIGIN = 'https://larry890122.github.io';
const SECTIONS = {
  Overview: ['JULI', 'Fin', 'Non-Fin', 'AA', 'A', 'BBB'],
  Cyclical: ['US Bank', 'Yankee Bank', 'Insurance', 'M&M', 'Chemical', 'Tech', 'Auto', 'Media', 'Energy', 'Capital Good'],
  'Non-Cyclical': ['Telecom', 'Utility', 'F&B', 'Tobacco', 'Healthcare', 'Retail', 'Transportation'],
};
const METRICS = ['Spread', '10Y', '30Y', '10s30s'];

function snapshot(date = '2026-08-06') {
  return {
    date,
    horizon: '2Y',
    sections: Object.fromEntries(Object.entries(SECTIONS).map(([section, sectors]) => [section,
      Object.fromEntries(METRICS.map(metric => [metric, sectors.map((sector, index) => ({
        sector,
        sources: {min: 'Excel', median: 'Excel', max: 'Excel', current: 'Excel', pct: 'Excel'},
        min: 10 + index,
        median: 20 + index,
        max: 30 + index,
        current: 25 + index,
        pct: 0.5,
      }))])),
    ])),
  };
}

function limiter(success = true) {
  return {limit: async () => ({success})};
}

function env(overrides = {}) {
  return {
    ALLOWED_ORIGINS: ORIGIN,
    UPLOAD_PASSWORD: 'correct horse',
    SESSION_SECRET: 'a-long-random-session-secret-for-tests',
    RV_UPLOAD_ENABLED: 'false',
    LOGIN_RATE_LIMITER: limiter(),
    PUBLISH_RATE_LIMITER: limiter(),
    ...overrides,
  };
}

function request(path, options = {}) {
  return new Request(`https://upload.example${path}`, {
    ...options,
    headers: {origin: ORIGIN, 'content-type': 'application/json', ...(options.headers || {})},
  });
}

test('strict snapshot contains exactly 460 Excel values', () => {
  assert.equal(validateSnapshot(snapshot()), 460);
  const missing = snapshot();
  missing.sections.Overview.Spread[0].current = null;
  assert.throws(() => validateSnapshot(missing), /current 無效/);
  const wrongSource = snapshot();
  wrongSource.sections.Overview.Spread[0].sources.min = '投影片';
  assert.throws(() => validateSnapshot(wrongSource), /只接受 Excel/);
  const wrongOrder = snapshot();
  wrongOrder.sections.Overview.Spread[0].min = 99;
  assert.throws(() => validateSnapshot(wrongOrder), /排序錯誤/);
  const outOfRange = snapshot();
  outOfRange.sections.Overview.Spread[0].pct = 1.1;
  assert.throws(() => validateSnapshot(outOfRange), /percentile 越界/);
});

test('session tokens expire after 15 minutes and reject tampering', async () => {
  const now = Date.UTC(2026, 8, 11);
  const token = await createSession('secret', now);
  assert.equal(await verifySession(token, 'secret', now + 899000), true);
  assert.equal(await verifySession(token, 'secret', now + 901000), false);
  assert.equal(await verifySession(`${token}x`, 'secret', now), false);
});

test('health is public but cross-origin mutation is blocked', async () => {
  const health = await handleRequest(new Request('https://upload.example/health'), env());
  assert.equal(await health.text(), 'RV Upload Service OK');
  const blocked = await handleRequest(new Request('https://upload.example/session', {
    method: 'POST', headers: {origin: 'https://evil.example'}, body: JSON.stringify({password: 'correct horse'}),
  }), env());
  assert.equal(blocked.status, 403);
});

test('password, rate limit, and disabled publishing fail closed', async () => {
  const wrong = await handleRequest(request('/session', {method: 'POST', body: JSON.stringify({password: 'wrong'})}), env());
  assert.equal(wrong.status, 401);
  const limited = await handleRequest(request('/session', {method: 'POST', body: JSON.stringify({password: 'correct horse'})}), env({LOGIN_RATE_LIMITER: limiter(false)}));
  assert.equal(limited.status, 429);
  const login = await handleRequest(request('/session', {method: 'POST', body: JSON.stringify({password: 'correct horse'})}), env());
  const {token} = await login.json();
  const publish = await handleRequest(request('/publish', {method: 'POST', headers: {authorization: `Bearer ${token}`}, body: JSON.stringify({data: snapshot()})}), env());
  assert.equal(publish.status, 503);
});

test('publish endpoint rejects expired sessions and non-data payloads', async () => {
  const expired = await createSession('a-long-random-session-secret-for-tests', Date.now() - 1000000);
  const response = await handleRequest(request('/publish', {method: 'POST', headers: {authorization: `Bearer ${expired}`}, body: '{}'}), env({RV_UPLOAD_ENABLED: 'true'}));
  assert.equal(response.status, 401);
  const token = await createSession('a-long-random-session-secret-for-tests');
  const raw = await handleRequest(request('/publish', {
    method: 'POST', headers: {authorization: `Bearer ${token}`},
    body: JSON.stringify({data: snapshot(), filename: 'secret.xlsx'}),
  }), env({RV_UPLOAD_ENABLED: 'true'}));
  assert.equal(raw.status, 400);
  assert.match((await raw.json()).error, /只接受公開摘要/);
});

async function githubEnv() {
  const pair = await crypto.subtle.generateKey({name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256'}, true, ['sign', 'verify']);
  const privateKey = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(privateKey).toString('base64')}\n-----END PRIVATE KEY-----`;
  return env({
    RV_UPLOAD_ENABLED: 'true', GITHUB_APP_ID: '123', GITHUB_APP_INSTALLATION_ID: '456',
    GITHUB_APP_PRIVATE_KEY: pem, GITHUB_REPOSITORY: 'owner/repo',
  });
}

function apiJson(value, status = 200) {
  return new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json'}});
}

test('duplicate sanitized submission returns its existing PR', async () => {
  const savedFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push([String(url), options.method || 'GET']);
    if (String(url).endsWith('/access_tokens')) return apiJson({token: 'installation'});
    if (String(url).includes('/contents/assets/rv-data.json')) return apiJson({sha: 'file-sha', content: Buffer.from(JSON.stringify(snapshot('2026-08-05'))).toString('base64')});
    if (String(url).endsWith('/git/ref/heads/main')) return apiJson({object: {sha: 'main-sha'}});
    if (String(url).endsWith('/git/refs')) return apiJson({message: 'Reference already exists'}, 422);
    if (String(url).includes('/pulls?state=all')) return apiJson([{number: 73, state: 'open', merged_at: null}]);
    throw new Error(`Unexpected URL ${url}`);
  };
  try {
    assert.deepEqual(await publishSnapshot(await githubEnv(), snapshot()), {id: '73', state: 'open'});
    assert.equal(calls.some(([url]) => url.includes('/pulls?state=all')), true);
  } finally { globalThis.fetch = savedFetch; }
});

test('successful publish writes only sanitized rv-data and labels one PR', async () => {
  const savedFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    calls.push({url: String(url), method, body: options.body});
    if (String(url).endsWith('/access_tokens')) return apiJson({token: 'installation'});
    if (String(url).includes('/contents/assets/rv-data.json') && method === 'GET') return apiJson({sha: 'file-sha', content: Buffer.from(JSON.stringify(snapshot('2026-08-05'))).toString('base64')});
    if (String(url).endsWith('/git/ref/heads/main')) return apiJson({object: {sha: 'main-sha'}});
    if (String(url).endsWith('/git/refs') && method === 'POST') return apiJson({ref: 'created'});
    if (String(url).includes('/contents/assets/rv-data.json') && method === 'PUT') return apiJson({content: {sha: 'new-file'}});
    if (String(url).endsWith('/pulls') && method === 'POST') return apiJson({number: 74});
    if (String(url).endsWith('/issues/74/labels') && method === 'POST') return apiJson([{name: 'automated-rv-data'}]);
    throw new Error(`Unexpected URL ${url}`);
  };
  try {
    assert.deepEqual(await publishSnapshot(await githubEnv(), snapshot()), {id: '74', state: 'pending'});
    const update = calls.find(call => call.url.includes('/contents/assets/rv-data.json') && call.method === 'PUT');
    assert.ok(update);
    assert.deepEqual(Object.keys(JSON.parse(update.body)).sort(), ['branch', 'content', 'message', 'sha']);
    assert.equal(calls.filter(call => call.method === 'PUT').length, 1);
    assert.equal(calls.some(call => call.url.endsWith('/issues/74/labels')), true);
  } finally { globalThis.fetch = savedFetch; }
});

test('GitHub update failure cleans up the automation branch', async () => {
  const savedFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    calls.push([String(url), method]);
    if (String(url).endsWith('/access_tokens')) return apiJson({token: 'installation'});
    if (String(url).includes('/contents/assets/rv-data.json') && method === 'GET') return apiJson({sha: 'file-sha', content: Buffer.from(JSON.stringify(snapshot('2026-08-05'))).toString('base64')});
    if (String(url).endsWith('/git/ref/heads/main')) return apiJson({object: {sha: 'main-sha'}});
    if (String(url).endsWith('/git/refs') && method === 'POST') return apiJson({ref: 'created'});
    if (String(url).includes('/contents/assets/rv-data.json') && method === 'PUT') return apiJson({message: 'boom'}, 500);
    if (String(url).includes('/git/refs/heads/automation/') && method === 'DELETE') return apiJson({});
    throw new Error(`Unexpected URL ${url}`);
  };
  try {
    await assert.rejects(publishSnapshot(await githubEnv(), snapshot()), /boom/);
    assert.equal(calls.some(([url, method]) => url.includes('/git/refs/heads/automation/') && method === 'DELETE'), true);
  } finally { globalThis.fetch = savedFetch; }
});

test('status reports deployed only after the public PASS manifest matches', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/access_tokens')) return apiJson({token: 'installation'});
    if (String(url).endsWith('/pulls/74')) return apiJson({state: 'closed', merged_at: '2026-09-11T00:00:00Z', merge_commit_sha: 'merge-sha', title: 'Update RV data to 2026-08-06'});
    if (String(url).startsWith('https://public.example/manifest.json')) return apiJson({validation_status: 'PASS', content_as_of: '2026-08-06', commit_sha: 'merge-sha'});
    throw new Error(`Unexpected URL ${url}`);
  };
  try {
    const result = await status({...await githubEnv(), PUBLIC_MANIFEST_URL: 'https://public.example/manifest.json'}, '74');
    assert.equal(result.state, 'deployed');
  } finally { globalThis.fetch = savedFetch; }
});
