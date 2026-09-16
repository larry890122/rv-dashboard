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
    id:`${band}-${index}`,band,maturity_years:index+1,yield_pct:index/10+3,oas_bp:index+100,flags:[],
  });
  const result = model.buildCurves(bonds,'yield_pct');
  assert.equal(result.curves.get('AAA').length,201);
  assert.deepEqual([result.curves.get('AAA')[0].x,result.curves.get('AAA').at(-1).x],[0,50]);
  assert.equal(result.curves.get('BBB').length,201);
  assert.equal(result.curves.get('AA').length,0);
  assert.equal(result.eligibility.get('AA').status,'sample');
  assert.equal(result.fitted.size,60);
});

test('generic curve groups enforce sample, maturity coverage, range, and outlier rules', () => {
  const maturities=[4,6,6,8,9,11,27,33];
  const bonds=Array.from({length:24},(_,index)=>({
    id:`tech-${index}`,industry:'Technology',maturity_years:maturities[index%maturities.length],
    yield_pct:3+index/100,flags:[],
  }));
  bonds.push({id:'flagged',industry:'Technology',maturity_years:30,yield_pct:99,flags:['yield_outlier']});
  bonds.push({id:'long',industry:'Technology',maturity_years:60,yield_pct:4,flags:[]});
  const eligible=model.buildCurves(bonds,'yield_pct','industry',['Technology','Utilities']);
  assert.equal(eligible.curves.get('Technology').length,201);
  assert.equal(eligible.eligibility.get('Technology').status,'eligible');
  assert.equal(eligible.eligibility.get('Utilities').status,'sample');
  assert.equal(eligible.fitted.has('flagged'),false);
  assert.equal(eligible.fitted.has('long'),false);

  const noThirty=bonds.filter(bond=>bond.id.startsWith('tech-')).map(bond=>({...bond,maturity_years:bond.maturity_years>20?12:bond.maturity_years}));
  const coverage=model.buildCurves(noThirty,'yield_pct','industry',['Technology']);
  assert.equal(coverage.curves.get('Technology').length,0);
  assert.equal(coverage.eligibility.get('Technology').status,'coverage');
  assert.deepEqual(coverage.eligibility.get('Technology').missing,['30Y']);
});

test('filtered curves allow five samples and annotate missing tenor bands', () => {
  const bonds=[1,2,3,4,5].map((x,index)=>({id:String(index),industry:'Technology',maturity_years:x,yield_pct:2*x+1,flags:[]}));
  const result=model.buildCurves(bonds,'yield_pct','industry',['Technology'],{minimumSamples:5,requireCoverage:false});
  assert.equal(result.eligibility.get('Technology').status,'eligible');
  assert.ok(result.eligibility.get('Technology').missing.includes('30Y'));
  assert.equal(result.curves.get('Technology').length,201);
  assert.ok(Number.isFinite(result.curves.get('Technology')[0].fitted));
  assert.ok(Number.isFinite(result.curves.get('Technology').at(-1).fitted));
  assert.equal(result.fitted.size,5);
});

test('public contract rejects impossible dates and incorrect quality flags', () => {
  const columns=model.COLUMNS;
  const row=['ID','Bond','Issuer','TK','2030-02-28','A',4,100,5,'Industry',[]];
  const data={schema_version:1,date:'2026-09-15',columns,records:[row]};
  assert.equal(model.validateSnapshot(data).length,1);
  assert.throws(()=>model.validateSnapshot({...data,date:'2026-02-31'}),/結構不正確/);
  assert.throws(()=>model.validateSnapshot({...data,records:[[...row.slice(0,10),['yield_outlier']]]}),/數值無效/);
});
