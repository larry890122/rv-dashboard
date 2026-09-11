const assert = require('node:assert/strict');

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
      await page.locator(`[name=metric][value="${metric}"]`).check();
      const points = page.locator(`.rv-point[data-metric="${metric}"]`);
      assert.equal(await points.count(),data.sections[section][metric].length*5);
      const point = points.first();
      await point.focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('#rv-tooltip').isVisible(),true);
      await page.keyboard.press('Escape');
    }
  }
  const peerHref = await page.getByRole('link',{name:'返回券商報告知識庫'}).getAttribute('href');
  assert.equal(peerHref,'https://larry890122.github.io/ib-knowledge-base/');
  assert.deepEqual(errors,[]);
  await context.close();
  return {width,combinations};
}

module.exports={run};
if(require.main===module) (async()=>{
  const {chromium}=require('playwright');
  const channel=process.env.RV_BROWSER_CHANNEL;
  const browser=await chromium.launch({headless:true,...(channel?{channel}:{})});
  const base=process.argv.find(argument=>argument.startsWith('http://')||argument.startsWith('https://'))||'http://127.0.0.1:8766/';
  try {for(const width of [1440,768,375]) console.log(await run(browser,base,width));}
  finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
