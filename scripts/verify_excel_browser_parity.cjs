#!/usr/bin/env node
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {chromium} = require('playwright');

const [baseUrl, pythonJson, spread, tenYear, thirtyYear, tensThirties] = process.argv.slice(2);
if (!tensThirties) {
  console.error('Usage: verify_excel_browser_parity.cjs BASE_URL PYTHON_JSON SPREAD 10Y 30Y 10S30S');
  process.exit(2);
}

const files = {Spread: spread, '10Y': tenYear, '30Y': thirtyYear, '10s30s': tensThirties};
const expected = JSON.parse(readFileSync(pythonJson, 'utf8'));

(async () => {
  const browser = await chromium.launch({headless: true, channel: process.env.RV_BROWSER_CHANNEL || 'chrome'});
  const page = await browser.newPage();
  let publishBody = null;
  try {
    const apiUrl = new URL('__rv_upload_parity', baseUrl).toString().replace(/\/$/, '');
    const comparisonBaseline = structuredClone(expected);
    const prior = new Date(`${expected.date}T00:00:00Z`);
    prior.setUTCDate(prior.getUTCDate() - 1);
    comparisonBaseline.date = prior.toISOString().slice(0, 10);

    await page.route('**/assets/upload-config.json', route => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({enabled: true, api_url: apiUrl}),
    }));
    await page.route('**/assets/rv-data.json', route => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(comparisonBaseline),
    }));
    await page.route('**/__rv_upload_parity/**', route => {
      const request = route.request();
      if (request.url().endsWith('/session')) {
        return route.fulfill({contentType: 'application/json', body: JSON.stringify({token: 'parity-session', expires_in: 900})});
      }
      if (request.url().endsWith('/publish')) {
        publishBody = request.postData();
        return route.fulfill({status: 202, contentType: 'application/json', body: JSON.stringify({id: 'parity', state: 'pending'})});
      }
      if (request.url().endsWith('/status/parity')) {
        return route.fulfill({contentType: 'application/json', body: JSON.stringify({state: 'deployed', message: 'Parity check complete.'})});
      }
      return route.fulfill({status: 404, body: 'not found'});
    });

    await page.goto(new URL('update.html', baseUrl).toString());
    await page.waitForFunction(() => document.querySelector('#service-state')?.textContent.includes('已啟用'));
    for (const [metric, path] of Object.entries(files)) {
      await page.locator(`input[data-metric="${metric}"]`).setInputFiles(path);
    }
    await page.getByRole('button', {name: '在本機驗證'}).click();
    await page.locator('#validation-status.success').waitFor();
    assert.equal(await page.locator('#summary-count').innerText(), '460 / 460');
    await page.locator('#upload-password').fill('parity-only');
    await page.getByRole('button', {name: '開始更新'}).click();
    await page.locator('#publish-status.success').waitFor();

    assert.ok(publishBody, 'browser did not send a sanitized publish request');
    assert.equal(/\.xlsx|source_file|sha256|\/Users\//i.test(publishBody), false, 'request exposed workbook identity');
    const published = JSON.parse(publishBody);
    assert.deepEqual(Object.keys(published), ['data']);
    assert.deepEqual(published.data, expected);
    console.log(`BROWSER_DATE=${published.data.date}`);
    console.log('BROWSER_VALUES=460');
    console.log('BROWSER_PYTHON_MATCH=true');
    console.log('REQUEST_SANITIZED=true');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
