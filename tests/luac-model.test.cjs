const assert = require('node:assert/strict');
const test = require('node:test');
const model = require('../assets/luac-model.js');

test('rating bands preserve the six public curve groups', () => {
  assert.deepEqual(['AAA','AA+','A-','BBB','BB-','B+','NR',''].map(model.ratingBand), ['AAA','AA','A','BBB','BB','NR','NR','NR']);
});

test('LOWESS needs 20 samples and follows a known local-linear curve', () => {
  assert.deepEqual(model.lowess(Array.from({length:19},(_,x)=>({id:String(x),x,y:2*x+1}))), []);
  const curve = model.lowess(Array.from({length:40},(_,x)=>({id:String(x),x:x/2,y:x+1})));
  assert.equal(curve.length,40);
  for(const point of curve) assert.ok(Math.abs(point.fitted-point.y)<1e-8);
});

test('two robust passes isolate a large Yield outlier', () => {
  const points = Array.from({length:60},(_,index)=>({id:String(index),x:index/3,y:2*(index/3)+4}));
  points[30].y += 100;
  const curve = model.lowess(points);
  const outlier = curve.find(point=>point.id==='30');
  assert.ok(outlier.residual>90);
  assert.ok(Math.abs(outlier.fitted-24)<2);
});

test('curve lookup returns residuals for each eligible rating band', () => {
  const bonds = [];
  for(const band of ['AAA','BBB']) for(let index=0;index<30;index++) bonds.push({
    id:`${band}-${index}`,band,maturity_years:index+1,yield_pct:index/10+3,oas_bp:index+100,
  });
  const result = model.buildCurves(bonds,'yield_pct');
  assert.equal(result.curves.get('AAA').length,30);
  assert.equal(result.curves.get('BBB').length,30);
  assert.equal(result.curves.get('AA').length,0);
  assert.equal(result.fitted.size,60);
});

test('public contract rejects impossible dates and incorrect quality flags', () => {
  const columns=model.COLUMNS;
  const row=['ID','Bond','Issuer','TK','2030-02-28','A',4,100,5,'Industry',[]];
  const data={schema_version:1,date:'2026-09-15',columns,records:[row]};
  assert.equal(model.validateSnapshot(data).length,1);
  assert.throws(()=>model.validateSnapshot({...data,date:'2026-02-31'}),/結構不正確/);
  assert.throws(()=>model.validateSnapshot({...data,records:[[...row.slice(0,10),['yield_outlier']]]}),/數值無效/);
});
