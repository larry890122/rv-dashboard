const METRICS = ['Spread', '10Y', '30Y', '10s30s'];
const FIELDS = ['min', 'median', 'max', 'current', 'pct'];
const LUAC_COLUMNS = ['id','security_des','issuer','ticker','maturity','rating','maturity_years','oas_bp','yield_pct','industry','flags'];
const LUAC_FLAGS = ['yield_outlier','maturity_outlier','oas_outlier'];
const SECTIONS = {
  Overview: ['JULI', 'Fin', 'Non-Fin', 'AA', 'A', 'BBB'],
  Cyclical: ['US Bank', 'Yankee Bank', 'Insurance', 'M&M', 'Chemical', 'Tech', 'Auto', 'Media', 'Energy', 'Capital Good'],
  'Non-Cyclical': ['Telecom', 'Utility', 'F&B', 'Tobacco', 'Healthcare', 'Retail', 'Transportation'],
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json; charset=utf-8', ...headers},
  });
}

function allowedOrigin(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  const configured = (env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  return configured.includes(origin) ? origin : false;
}

function corsHeaders(origin) {
  return origin ? {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-max-age': '600',
    vary: 'Origin',
  } : {};
}

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function unbase64url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign', 'verify']);
}

export async function createSession(secret, now = Date.now()) {
  const payload = base64url(encoder.encode(JSON.stringify({exp: Math.floor(now / 1000) + 900, nonce: crypto.randomUUID()})));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(payload));
  return `${payload}.${base64url(new Uint8Array(signature))}`;
}

export async function verifySession(token, secret, now = Date.now()) {
  if (!token || !secret) return false;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return false;
  try {
    const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret), unbase64url(signature), encoder.encode(payload));
    if (!valid) return false;
    const parsed = JSON.parse(decoder.decode(unbase64url(payload)));
    return Number.isInteger(parsed.exp) && parsed.exp >= Math.floor(now / 1000);
  } catch {
    return false;
  }
}

function sameKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

export function validateSnapshot(data) {
  if (!sameKeys(data, ['date', 'horizon', 'sections'])) throw new Error('公開資料欄位不正確');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date) || Number.isNaN(Date.parse(`${data.date}T00:00:00Z`))) throw new Error('資料日期不正確');
  if (data.horizon !== '2Y' || !sameKeys(data.sections, Object.keys(SECTIONS))) throw new Error('公開資料結構不正確');
  let count = 0;
  for (const [section, sectors] of Object.entries(SECTIONS)) {
    if (!sameKeys(data.sections[section], METRICS)) throw new Error(`${section} 指標不完整`);
    for (const metric of METRICS) {
      const records = data.sections[section][metric];
      if (!Array.isArray(records) || records.length !== sectors.length) throw new Error(`${section}／${metric} 分類不完整`);
      records.forEach((record, index) => {
        if (!sameKeys(record, ['sector', 'sources', ...FIELDS]) || record.sector !== sectors[index] || !sameKeys(record.sources, FIELDS)) {
          throw new Error(`${section}／${metric} 分類或欄位不正確`);
        }
        for (const field of FIELDS) {
          if (!finite(record[field])) throw new Error(`${section}／${metric}／${record.sector} 的 ${field} 無效`);
          if (field === 'pct' && (record[field] < 0 || record[field] > 1)) throw new Error(`${section}／${metric}／${record.sector} percentile 越界`);
          if (record.sources[field] !== 'Excel') throw new Error('自動更新只接受 Excel 來源');
          count += 1;
        }
        if (!(record.min <= record.median && record.median <= record.max)) throw new Error(`${section}／${metric}／${record.sector} 排序錯誤`);
      });
    }
  }
  if (count !== 460) throw new Error(`資料值應為 460，實際為 ${count}`);
  return count;
}

function luacFlags(years, oas, bondYield) {
  const flags = [];
  if (bondYield <= 0 || bondYield > 50) flags.push('yield_outlier');
  if (years <= 0 || years > 100) flags.push('maturity_outlier');
  if (oas < -250 || oas > 5000) flags.push('oas_outlier');
  return flags;
}

export function validateLuacSnapshot(data) {
  if (!sameKeys(data, ['schema_version', 'date', 'columns', 'records']) || data.schema_version !== 1) throw new Error('LUAC 公開資料欄位不正確');
  if (!validIsoDate(data.date)) throw new Error('LUAC 資料日期不正確');
  if (!Array.isArray(data.columns) || data.columns.length !== LUAC_COLUMNS.length || data.columns.some((value, index) => value !== LUAC_COLUMNS[index])) throw new Error('LUAC 欄位順序不正確');
  if (!Array.isArray(data.records) || data.records.length < 1 || data.records.length > 20000) throw new Error('LUAC 債券筆數不正確');
  const ids = new Set();
  let anomalies = 0;
  for (const [index, row] of data.records.entries()) {
    if (!Array.isArray(row) || row.length !== LUAC_COLUMNS.length) throw new Error(`LUAC 第 ${index + 1} 筆欄位不完整`);
    const [id, security, issuer, ticker, maturity, rating, years, oas, bondYield, industry, flags] = row;
    const text = [[id,64],[security,180],[issuer,300],[ticker,32],[maturity,10],[rating,16],[industry,160]];
    if (text.some(([value, maximum]) => typeof value !== 'string' || !value.trim() || value.length > maximum)) throw new Error(`LUAC 第 ${index + 1} 筆文字欄位無效`);
    if (ids.has(id)) throw new Error(`LUAC ID 重複：${id}`); ids.add(id);
    if (!validIsoDate(maturity) || ![years,oas,bondYield].every(finite)) throw new Error(`LUAC 第 ${index + 1} 筆數值或日期無效`);
    const expected = luacFlags(years,oas,bondYield);
    if (!Array.isArray(flags) || flags.length !== expected.length || flags.some((flag, flagIndex) => flag !== expected[flagIndex] || !LUAC_FLAGS.includes(flag))) throw new Error(`LUAC 第 ${index + 1} 筆異常標記不正確`);
    anomalies += Number(Boolean(flags.length));
  }
  return {count:data.records.length, anomalies};
}

async function digestText(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function pemBytes(pem) {
  const body = pem.replace(/\\n/g, '\n').replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  return Uint8Array.from(atob(body), character => character.charCodeAt(0));
}

async function githubAppJwt(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(encoder.encode(JSON.stringify({alg: 'RS256', typ: 'JWT'})));
  const payload = base64url(encoder.encode(JSON.stringify({iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID})));
  const key = await crypto.subtle.importKey('pkcs8', pemBytes(env.GITHUB_APP_PRIVATE_KEY), {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'}, false, ['sign']);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
}

async function githubFetch(env, path, options = {}, token = null) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token || await githubAppJwt(env)}`,
      'user-agent': 'rv-upload-worker',
      'x-github-api-version': '2022-11-28',
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || `GitHub API ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function installationToken(env) {
  const result = await githubFetch(env, `/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`, {method: 'POST'});
  return result.token;
}

function utf8Base64(value) {
  let binary = '';
  for (const byte of encoder.encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeGithubContent(value) {
  return decoder.decode(Uint8Array.from(atob(value.replace(/\s/g, '')), character => character.charCodeAt(0)));
}

async function addAutomationLabel(env, repo, number, token, label) {
  const add = () => githubFetch(env, `/repos/${repo}/issues/${number}/labels`, {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({labels: [label]}),
  }, token);
  try {
    await add();
  } catch (error) {
    if (error.status !== 404) throw error;
    try {
      await githubFetch(env, `/repos/${repo}/labels`, {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          name: label,
          color: label.startsWith('automated-') ? '1f6feb' : 'bf8700',
          description: label.includes('luac') ? 'Validated LUAC data-only update' : 'Validated RV data-only update',
        }),
      }, token);
    } catch (createError) {
      if (createError.status !== 422) throw createError;
    }
    await add();
  }
}

async function publishData(env, data, definition) {
  const validation = definition.validate(data);
  const repo = env.GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '')) throw new Error('Worker repository 設定不正確');
  const production = env.PUBLISH_MODE === 'production';
  const base = production ? 'main' : (env.PREVIEW_BASE_REF || 'main');
  const token = await installationToken(env);
  const current = await githubFetch(env, `/repos/${repo}/contents/${definition.path}?ref=${encodeURIComponent(base)}`, {}, token);
  const encoded = current.content || (await githubFetch(env, `/repos/${repo}/git/blobs/${current.sha}`, {}, token)).content;
  const currentData = JSON.parse(decodeGithubContent(encoded));
  definition.validate(currentData);
  if (data.date <= currentData.date) throw new Error(`資料日期 ${data.date} 必須晚於正式站 ${currentData.date}`);
  if (definition.checkCurrent) definition.checkCurrent(data, currentData);
  const content = `${JSON.stringify(data, null, definition.compact ? 0 : 2)}\n`;
  const digest = await digestText(JSON.stringify(data));
  const label = production ? definition.productionLabel : definition.previewLabel;
  const branch = `${production ? 'automation' : 'preview'}/${definition.branch}-${data.date}-${digest.slice(0, 12)}`;
  const branchRef = `heads/${branch}`;
  const baseRef = await githubFetch(env, `/repos/${repo}/git/ref/heads/${base}`, {}, token);
  try {
    await githubFetch(env, `/repos/${repo}/git/refs`, {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({ref: `refs/${branchRef}`, sha: baseRef.object.sha}),
    }, token);
  } catch (error) {
    if (error.status !== 422) throw error;
    const existing = await githubFetch(env, `/repos/${repo}/pulls?state=all&head=${encodeURIComponent(repo.split('/')[0] + ':' + branch)}`, {}, token);
    if (existing[0]) return {id: String(existing[0].number), state: existing[0].merged_at ? 'merged' : existing[0].state};
    throw new Error('相同資料 branch 已存在，但找不到對應 PR');
  }
  try {
    await githubFetch(env, `/repos/${repo}/contents/${definition.path}`, {
      method: 'PUT', headers: {'content-type': 'application/json'},
      body: JSON.stringify({message: `Update ${definition.name} data to ${data.date}`, content: utf8Base64(content), sha: current.sha, branch}),
    }, token);
    const pr = await githubFetch(env, `/repos/${repo}/pulls`, {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        title: `${production ? 'Update' : '[PREVIEW] Validate'} ${definition.name} data to ${data.date}`,
        head: branch,
        base,
        body: `${production ? 'Automated' : 'Preview'} sanitized Excel update.\n\n- Mode: ${production ? 'production' : 'preview — never auto-merge'}\n- Data date: ${data.date}\n- ${definition.summary(validation)}\n- SHA-256: \`${digest}\`\n- Validation: PASS`,
      }),
    }, token);
    await addAutomationLabel(env, repo, pr.number, token, label);
    return {id: String(pr.number), state: 'pending'};
  } catch (error) {
    try { await githubFetch(env, `/repos/${repo}/git/refs/${branchRef}`, {method: 'DELETE'}, token); } catch {}
    throw error;
  }
}

export async function publishSnapshot(env, data) {
  return publishData(env, data, {
    name: 'RV', path: 'assets/rv-data.json', branch: 'rv-data', compact: false,
    productionLabel: 'automated-rv-data', previewLabel: 'rv-data-preview',
    validate: value => validateSnapshot(value),
    summary: count => `Values: ${count}/460`,
  });
}

function checkLuacDrift(data, currentData) {
  const ratio = data.records.length / currentData.records.length;
  if (ratio < 0.8 || ratio > 1.2) {
    throw new Error(`LUAC 筆數由 ${currentData.records.length} 變為 ${data.records.length}，超過 ±20%，請改走人工 PR`);
  }
}

export async function publishLuacSnapshot(env, data) {
  return publishData(env, data, {
    name: 'LUAC', path: 'assets/luac-bonds.json', branch: 'luac-data', compact: true,
    productionLabel: 'automated-luac-data', previewLabel: 'luac-data-preview',
    validate: value => validateLuacSnapshot(value), checkCurrent: checkLuacDrift,
    summary: result => `Bonds: ${result.count}; flagged records: ${result.anomalies}`,
  });
}

async function deploymentStatus(env, id, definition) {
  if (!/^\d+$/.test(id)) throw new Error('發布編號不正確');
  const token = await installationToken(env);
  const pr = await githubFetch(env, `/repos/${env.GITHUB_REPOSITORY}/pulls/${id}`, {}, token);
  if (pr.state === 'open') return {state: 'pending', message: '資料 PR 已建立，正在等待 CI 驗證與自動合併。'};
  if (!pr.merged_at) return {state: 'failed', message: '資料 PR 已關閉但未合併；正式站未更新。'};
  const expectedDate = new RegExp(`Update ${definition.name} data to (\\d{4}-\\d{2}-\\d{2})`).exec(pr.title)?.[1];
  try {
    const response = await fetch(`${env.PUBLIC_MANIFEST_URL}?${definition.query}=${encodeURIComponent(id)}&t=${Date.now()}`, {headers: {'cache-control': 'no-cache'}});
    const manifest = await response.json();
    const publicDate = definition.dataset ? manifest.datasets?.[definition.dataset]?.content_as_of : manifest.content_as_of;
    if (response.ok && manifest.validation_status === 'PASS' && publicDate === expectedDate && manifest.commit_sha === pr.merge_commit_sha) {
      return {state: 'deployed', message: `發布完成：${expectedDate}，正式站驗證 PASS。`};
    }
  } catch {}
  return {state: 'deploying', message: 'PR 已合併，GitHub Pages 正在發布與驗證。'};
}

export async function status(env, id) {
  return deploymentStatus(env, id, {name: 'RV', query: 'rv_job'});
}

export async function statusLuac(env, id) {
  return deploymentStatus(env, id, {name: 'LUAC', query: 'luac_job', dataset: 'luac'});
}

async function readJson(request, maximum = 262144) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > maximum) throw Object.assign(new Error('Request 太大'), {status: 413});
  const text = await request.text();
  if (encoder.encode(text).byteLength > maximum) throw Object.assign(new Error('Request 太大'), {status: 413});
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('JSON 格式不正確'), {status: 400}); }
}

function clientKey(request) {
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  const origin = allowedOrigin(request, env);
  if (origin === false) return json({error: '不允許的來源網域'}, 403);
  const cors = corsHeaders(origin);
  if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors});
  if (url.pathname === '/health' && request.method === 'GET') {
    return new Response('RV Upload Service OK', {headers: {'content-type': 'text/plain; charset=utf-8', ...cors}});
  }
  if (url.pathname === '/session' && request.method === 'POST') {
    const rate = await env.LOGIN_RATE_LIMITER.limit({key: clientKey(request)});
    if (!rate.success) return json({error: '登入嘗試過多，請一分鐘後再試'}, 429, cors);
    const body = await readJson(request, 4096);
    if (!sameKeys(body, ['password']) || typeof body.password !== 'string' || body.password !== env.UPLOAD_PASSWORD) {
      return json({error: '密碼錯誤'}, 401, cors);
    }
    return json({token: await createSession(env.SESSION_SECRET), expires_in: 900}, 200, cors);
  }
  const match = /^\/status\/(\d+)$/.exec(url.pathname);
  const luacMatch = /^\/status\/luac\/(\d+)$/.exec(url.pathname);
  const rvPublish = url.pathname === '/publish' && request.method === 'POST';
  const luacPublish = url.pathname === '/publish/luac' && request.method === 'POST';
  if (rvPublish || luacPublish || ((match || luacMatch) && request.method === 'GET')) {
    const bearer = /^Bearer (.+)$/.exec(request.headers.get('authorization') || '')?.[1];
    if (!await verifySession(bearer, env.SESSION_SECRET)) return json({error: '登入已過期，請重新輸入密碼'}, 401, cors);
    if (match) return json(await status(env, match[1]), 200, cors);
    if (luacMatch) return json(await statusLuac(env, luacMatch[1]), 200, cors);
    if ((rvPublish && env.RV_UPLOAD_ENABLED !== 'true') || (luacPublish && env.LUAC_UPLOAD_ENABLED !== 'true')) {
      return json({error: '發布功能尚未啟用'}, 503, cors);
    }
    const rate = await env.PUBLISH_RATE_LIMITER.limit({key: await digestText(bearer)});
    if (!rate.success) return json({error: '發布次數過多，請一分鐘後再試'}, 429, cors);
    const body = await readJson(request, luacPublish ? 4 * 1024 * 1024 : 262144);
    if (!sameKeys(body, ['data'])) return json({error: '只接受公開摘要 data，不接受檔案或來源資訊'}, 400, cors);
    const result = luacPublish ? await publishLuacSnapshot(env, body.data) : await publishSnapshot(env, body.data);
    return json(result, 202, cors);
  }
  return json({error: 'Not found'}, 404, cors);
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      return json({error: error.message || '服務暫時無法處理'}, error.status || 400, corsHeaders(allowedOrigin(request, env)));
    }
  },
};
