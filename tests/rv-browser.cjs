const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {mkdtempSync,readFileSync,rmSync,writeFileSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');

async function run(browser, base, width = 1440) {
  const context = await browser.newContext({viewport:{width,height:1000},hasTouch:width<650});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error') errors.push(m.text());});
  page.on('response',r=>{if(r.status()>=400) errors.push(`${r.status()} ${r.url()}`);});
  await page.goto(base);
  await page.waitForSelector('.rv-point');
  assert.equal(await page.locator('[name=section]:checked').inputValue(),'Overview');
  assert.deepEqual(await page.locator('[name=metric]:checked').evaluateAll(es=>es.map(e=>e.value)),['Spread']);
  const metrics = ['Spread','10Y','30Y','10s30s'];
  const data = await (await page.request.get(base+'assets/rv-data.json')).json();
  let combinations = 0;
  for(const section of ['Overview','Cyclical','Non-Cyclical']) {
    await page.locator(`[name=section][value="${section}"]`).check();
    for(let mask=0;mask<16;mask++) {
      for(const metric of metrics) await page.locator(`[name=metric][value="${metric}"]`).setChecked(false);
      for(let index=0;index<4;index++) await page.locator(`[name=metric][value="${metrics[index]}"]`).setChecked(Boolean(mask&(1<<index)));
      const expected = mask&8 ? ['10s30s'] : metrics.filter((_,index)=>mask&(1<<index));
      assert.deepEqual(await page.locator('[name=metric]:checked').evaluateAll(es=>es.map(e=>e.value)),expected);
      assert.equal(await page.locator('.rv-chart').count(),mask ? 1 : 0);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${width}/${section}/${mask} overflow`);
      combinations++;
    }
    for(const metric of metrics) {
      for(const option of metrics) await page.locator(`[name=metric][value="${option}"]`).setChecked(false);
      await page.locator(`[name=metric][value="${metric}"]`).check();
      const points = page.locator(`.rv-point[data-metric="${metric}"]`);
      assert.equal(await points.count(),data.sections[section][metric].length*5);
      assert.equal(await page.locator(`polygon.rv-range-arrow[data-metric="${metric}"][data-field="min"]`).count(),data.sections[section][metric].length);
      assert.equal(await page.locator(`polygon.rv-range-arrow[data-metric="${metric}"][data-field="max"]`).count(),data.sections[section][metric].length);
      assert.equal(await page.locator(`line.rv-range-line`).count(),data.sections[section][metric].length);
      assert.equal(await page.locator(`rect.rv-median-marker[data-metric="${metric}"]`).count(),data.sections[section][metric].length);
      assert.equal(await page.locator(`polygon.rv-current-marker[data-metric="${metric}"]`).count(),data.sections[section][metric].length);
      assert.equal(await page.locator('.range-value-label,.current-value-label').count(),0);
      assert.equal(await page.locator('.percentile-value-label').count(),data.sections[section][metric].length);
      const currentPoints=(await page.locator(`polygon.rv-current-marker[data-metric="${metric}"]`).first().getAttribute('points')).trim().split(/\s+/).map(pair=>Number(pair.split(',')[0]));
      assert.equal(currentPoints[0]+currentPoints[1],currentPoints[2]*2,'current marker is horizontally centered');
      for(const field of ['min','max']) {
        await page.locator(`.rv-point[data-metric="${metric}"][data-field="${field}"]`).first().focus();
        await page.keyboard.press('Enter');
        assert.equal(await page.locator('#rv-tooltip').isVisible(),true);
        const row=data.sections[section][metric][0],tooltip=await page.locator('#rv-tooltip').innerText();
        assert.match(tooltip,/2Y Min–Max/);
        assert.ok(tooltip.includes(new Intl.NumberFormat('en-US',{maximumFractionDigits:6}).format(row.min)));
        assert.ok(tooltip.includes(new Intl.NumberFormat('en-US',{maximumFractionDigits:6}).format(row.max)));
        await page.keyboard.press('Escape');
      }
    }
    for(const option of metrics) await page.locator(`[name=metric][value="${option}"]`).setChecked(false);
    await page.locator('[name=metric][value="Spread"]').check();
    await page.locator('[name=metric][value="10Y"]').check();
    assert.equal(await page.locator('.percentile-value-label').count(),data.sections[section].Spread.length*2);
    assert.equal(await page.locator('.percentile-value-label.compact').count(),data.sections[section].Spread.length*2);
    assert.equal(await page.locator('.range-value-label,.current-value-label').count(),0);
  }
  const peerHref = await page.getByRole('link',{name:'返回券商報告知識庫'}).getAttribute('href');
  assert.equal(peerHref,'https://larry890122.github.io/ib-knowledge-base/');
  assert.deepEqual(errors,[]);
  await context.close();
  return {width,combinations};
}

async function runBonds(browser,base,width=1440){
  const context=await browser.newContext({viewport:{width,height:1000},hasTouch:width<650});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  page.on('response',response=>{if(response.status()>=400)errors.push(`${response.status()} ${response.url()}`);});
  await page.goto(base+'bonds.html');
  await page.waitForSelector('#bond-rows tr');
  const data=await (await page.request.get(base+'assets/luac-bonds.json')).json();
  const model=require('../assets/luac-model.js');
  assert.equal(await page.locator('[name=bond-metric]:checked').inputValue(),'yield_pct');
  assert.equal(await page.locator('#chart-title').innerText(),'Maturity × Yield');
  assert.equal(await page.locator('#bond-rows tr').count(),50);
  const uncheckedRatings=await page.locator('#rating-filter input:not(:checked)').evaluateAll(inputs=>inputs.map(input=>input.value));
  assert.ok(uncheckedRatings.length>0);
  assert.ok(uncheckedRatings.every(rating=>model.ratingBand(rating)==='NR'));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${width}/bonds overflow`);

  let row=page.locator('#bond-rows tr').first();
  await row.focus();
  let tooltip=await page.locator('#bond-tooltip').innerText();
  assert.match(tooltip,/Yield/);
  assert.match(tooltip,/OAS Spread/);
  assert.match(tooltip,/Yield − curve/);
  const residual=(await row.locator('td').nth(6).innerText()).trim();
  if(residual!=='n.a.')assert.ok(tooltip.includes(residual));
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#bond-tooltip').isVisible(),true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#bond-tooltip').isHidden(),true);

  const hoverId=data.records.find(record=>record[6]>2&&!record[10].length&&model.ratingBand(record[5])!=='NR')[0];
  await page.locator('#bond-search').fill(hoverId);
  await page.waitForFunction(id=>document.querySelectorAll('#bond-rows tr').length===1&&document.querySelector('#bond-rows tr')?.dataset.id===id,hoverId);
  await page.locator('#bond-canvas').scrollIntoViewIfNeeded();
  const box=await page.locator('#bond-canvas').boundingBox(),point={x:box.x+66+(box.width-88)/2,y:box.y+24+(box.height-72)/2};
  await page.mouse.move(point.x,point.y);
  await page.locator('#bond-tooltip').waitFor({state:'visible'});
  tooltip=await page.locator('#bond-tooltip').innerText();
  assert.match(tooltip,/Yield/);assert.match(tooltip,/OAS Spread/);
  if(width<650)await page.touchscreen.tap(point.x,point.y);else await page.mouse.click(point.x,point.y);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#bond-tooltip').isHidden(),true);
  await page.locator('#bond-search').fill('');

  await page.locator('[name=bond-metric][value=oas_bp]').check();
  await page.waitForFunction(()=>document.querySelector('#chart-title')?.textContent==='Maturity × OAS Spread');
  row=page.locator('#bond-rows tr').first();await row.focus();tooltip=await page.locator('#bond-tooltip').innerText();
  assert.match(tooltip,/Yield/);assert.match(tooltip,/OAS Spread/);assert.match(tooltip,/OAS Spread − curve/);
  await page.keyboard.press('Escape');

  const anomaly=data.records.find(record=>record[10].length);
  assert.ok(anomaly);
  await page.locator('[data-filter-action=all][data-filter=rating]').click();
  await page.locator('#show-outliers').check();
  await page.locator('#bond-search').fill(anomaly[0]);
  await page.waitForFunction(id=>document.querySelectorAll('#bond-rows tr').length===1&&document.querySelector('#bond-rows tr')?.dataset.id===id,anomaly[0]);
  await page.locator('#bond-rows tr').first().focus();tooltip=await page.locator('#bond-tooltip').innerText();
  assert.ok(tooltip.includes(new Intl.NumberFormat('en-US',{minimumFractionDigits:3,maximumFractionDigits:3}).format(anomaly[8])));
  assert.ok(tooltip.includes(new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}).format(anomaly[7])));
  assert.match(tooltip,/資料異常/);
  await page.keyboard.press('Escape');

  await page.locator('#reset-filters').click();
  await page.waitForFunction(()=>document.querySelector('#bond-rows tr'));
  await page.locator('#bond-canvas').hover({position:{x:200,y:200}});
  await page.mouse.wheel(0,-120);
  await page.locator('#zoom-reset').click();
  assert.deepEqual(errors,[]);
  await context.close();
  return {width,bonds:data.records.length};
}

module.exports={run,runBonds};

const FILES = {
  Spread:'2Y Percentile RV.xlsx',
  '10Y':'10Y RV.xlsx',
  '30Y':'30Y RV.xlsx',
  '10s30s':'10s30s RV.xlsx',
};

function fixtures(root,variant,date) {
  const output=join(root,variant);
  execFileSync('python3',['tests/make_xlsx_fixtures.py','--out',output,'--variant',variant,'--date',date],{stdio:'pipe'});
  return Object.fromEntries(Object.entries(FILES).map(([metric,name])=>[metric,join(output,name)]));
}

async function openUploader(browser,base,expectedDate,width=1440,currentLuacDate='2026-09-15',currentLuacCount=40) {
  const context=await browser.newContext({viewport:{width,height:1000},hasTouch:width<650});
  const page=await context.newPage();
  const requests=[];
  await page.route('**/assets/upload-config.json',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({enabled:true,luac_enabled:true,api_url:'https://rv-upload-service.example.workers.dev'})}));
  await page.route('**/assets/luac-bonds.json*',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({date:currentLuacDate,records:Array.from({length:currentLuacCount},()=>[])})}));
  await page.route('https://rv-upload-service.example.workers.dev/**',async route=>{
    const request=route.request();
    requests.push({url:request.url(),method:request.method(),body:request.postData()});
    if(request.url().endsWith('/session')) return route.fulfill({contentType:'application/json',body:JSON.stringify({token:'test-session',expires_in:900})});
    if(request.url().endsWith('/publish/luac')) return route.fulfill({status:202,contentType:'application/json',body:JSON.stringify({id:'43',state:'pending'})});
    if(request.url().endsWith('/publish')) return route.fulfill({status:202,contentType:'application/json',body:JSON.stringify({id:'42',state:'pending'})});
    if(request.url().endsWith('/status/luac/43')) return route.fulfill({contentType:'application/json',body:JSON.stringify({state:'deployed',message:`發布完成：${expectedDate}，正式站驗證 PASS。`})});
    if(request.url().endsWith('/status/42')) return route.fulfill({contentType:'application/json',body:JSON.stringify({state:'deployed',message:`發布完成：${expectedDate}，正式站驗證 PASS。`})});
    if(request.url().endsWith('/health')) return route.fulfill({contentType:'text/plain',body:'RV Upload Service OK'});
    return route.fulfill({status:404,body:'not found'});
  });
  await page.goto(base+'update.html');
  await page.waitForFunction(()=>document.querySelector('#service-state')?.textContent.includes('已啟用'));
  return {context,page,requests};
}

async function selectFour(page,files) {
  for(const [metric,path] of Object.entries(files)) await page.locator(`input[data-metric="${metric}"]`).setInputFiles(path);
}

async function runValidUpload(browser,base,width,files,expectedDate) {
  const {context,page,requests}=await openUploader(browser,base,expectedDate,width);
  await selectFour(page,files);
  await page.locator('#validate-files').click();
  await page.locator('#validation-status.success').waitFor();
  assert.equal(await page.locator('#summary-date').innerText(),expectedDate);
  assert.equal(await page.locator('#summary-count').innerText(),'460 / 460');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${width}/uploader overflow`);
  await page.locator('#upload-password').fill('company password');
  await page.locator('#publish-data').click();
  await page.locator('#publish-status.success').waitFor();
  const publish=requests.find(item=>item.url.endsWith('/publish'));
  assert.ok(publish,'sanitized publish request was sent');
  assert.deepEqual(Object.keys(JSON.parse(publish.body)),['data']);
  assert.equal(/\.xlsx|2Y Percentile|10Y RV|30Y RV|10s30s RV|source_file|sha256/i.test(publish.body),false,'request must not contain workbook identity or hash');
  assert.equal(JSON.parse(publish.body).data.date,expectedDate);
  await context.close();
}

async function runInvalidUpload(browser,base,files,expected,currentDate) {
  const {context,page,requests}=await openUploader(browser,base,currentDate);
  await selectFour(page,files);
  await page.locator('#validate-files').click();
  await page.locator('#validation-status.error').waitFor();
  assert.match(await page.locator('#validation-status').innerText(),expected);
  assert.equal(requests.some(item=>item.url.endsWith('/publish')),false);
  await context.close();
}

function luacFixture(root,variant,date,count=40){
  const output=join(root,`luac-${variant}-${count}.xlsx`);
  execFileSync('python3',['tests/make_luac_fixture.py','--out',output,'--variant',variant,'--date',date,'--count',String(count)],{stdio:'pipe'});
  return output;
}

async function runValidLuacUpload(browser,base,width,file,expectedDate,currentDate){
  const {context,page,requests}=await openUploader(browser,base,expectedDate,width,currentDate);
  await page.locator('#luac-file').setInputFiles(file);
  await page.locator('#validate-luac').click();
  await page.locator('#luac-validation-status.success').waitFor();
  assert.equal(await page.locator('#luac-summary-date').innerText(),expectedDate);
  assert.equal(await page.locator('#luac-summary-count').innerText(),'40');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${width}/luac uploader overflow`);
  await page.locator('#luac-upload-password').fill('company password');
  await page.locator('#publish-luac').click();
  await page.locator('#luac-publish-status.success').waitFor();
  const publish=requests.find(item=>item.url.endsWith('/publish/luac'));
  assert.ok(publish,'sanitized LUAC publish request was sent');
  assert.deepEqual(Object.keys(JSON.parse(publish.body)),['data']);
  assert.equal(/\.xlsx|source_file|sha256|\/Users\//i.test(publish.body),false);
  assert.equal(JSON.parse(publish.body).data.date,expectedDate);
  const python=JSON.parse(execFileSync('python3',['scripts/extract_luac.py',file],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  assert.deepEqual(JSON.parse(publish.body).data,python,'browser and Python LUAC extraction must match');
  await context.close();
}

async function runInvalidLuacUpload(browser,base,file,expected,currentDate,currentCount=40){
  const {context,page,requests}=await openUploader(browser,base,'2026-09-16',1440,currentDate,currentCount);
  await page.locator('#luac-file').setInputFiles(file);
  await page.locator('#validate-luac').click();
  await page.locator('#luac-validation-status.error').waitFor();
  assert.match(await page.locator('#luac-validation-status').innerText(),expected);
  assert.equal(requests.some(item=>item.url.endsWith('/publish/luac')),false);
  await context.close();
}

if(require.main===module) (async()=>{
  const {chromium}=require('playwright');
  const channel=process.env.RV_BROWSER_CHANNEL;
  const browser=await chromium.launch({headless:true,...(channel?{channel}:{})});
  const base=process.argv.find(argument=>argument.startsWith('http://')||argument.startsWith('https://'))||'http://127.0.0.1:8766/';
  const temporary=mkdtempSync(join(tmpdir(),'rv-upload-test-'));
  try {
    for(const width of [1440,768,375]) console.log(await run(browser,base,width));
    for(const width of [1440,768,375]) console.log(await runBonds(browser,base,width));
    const currentDate=JSON.parse(readFileSync('assets/rv-data.json','utf8')).date;
    const nextDate=new Date(`${currentDate}T00:00:00Z`);nextDate.setUTCDate(nextDate.getUTCDate()+1);
    const expectedDate=nextDate.toISOString().slice(0,10);
    const valid=fixtures(temporary,'valid',expectedDate);
    for(const width of [1440,768,375]) await runValidUpload(browser,base,width,valid,expectedDate);
    await runInvalidUpload(browser,base,fixtures(temporary,'date-mismatch',expectedDate),/日期不一致/,currentDate);
    await runInvalidUpload(browser,base,fixtures(temporary,'outdated',currentDate),/必須晚於正式站/,currentDate);
    await runInvalidUpload(browser,base,fixtures(temporary,'missing',expectedDate),/缺值或不是有效數字/,currentDate);
    await runInvalidUpload(browser,base,fixtures(temporary,'order',expectedDate),/Min ≤ Median ≤ Max/,currentDate);
    const wrong={...valid};
    wrong.Spread=join(temporary,'wrong.txt');
    writeFileSync(wrong.Spread,'not an xlsx');
    await runInvalidUpload(browser,base,wrong,/必須選取 .xlsx/,currentDate);
    const currentLuacDate=JSON.parse(readFileSync('assets/luac-bonds.json','utf8')).date;
    const nextLuacDate=new Date(`${currentLuacDate}T00:00:00Z`);nextLuacDate.setUTCDate(nextLuacDate.getUTCDate()+1);
    const expectedLuacDate=nextLuacDate.toISOString().slice(0,10),luacValid=luacFixture(temporary,'valid',expectedLuacDate);
    for(const width of [1440,768,375])await runValidLuacUpload(browser,base,width,luacValid,expectedLuacDate,currentLuacDate);
    await runInvalidLuacUpload(browser,base,luacFixture(temporary,'formula',expectedLuacDate),/只接受無公式/,currentLuacDate);
    await runInvalidLuacUpload(browser,base,luacFixture(temporary,'nonfinite',expectedLuacDate),/OAS.*無效/,currentLuacDate);
    await runInvalidLuacUpload(browser,base,luacFixture(temporary,'mismatch',expectedLuacDate),/ID 必須完整一致/,currentLuacDate);
    await runInvalidLuacUpload(browser,base,luacFixture(temporary,'mixed-date',expectedLuacDate),/資料日期不一致/,currentLuacDate);
    await runInvalidLuacUpload(browser,base,luacFixture(temporary,'valid',currentLuacDate),/必須晚於正式站/,currentLuacDate);
    await runInvalidLuacUpload(browser,base,luacFixture(temporary,'valid',expectedLuacDate,25),/超過 ±20%/,currentLuacDate);
    console.log('browser tests PASS');
  }
  finally {rmSync(temporary,{recursive:true,force:true});await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
