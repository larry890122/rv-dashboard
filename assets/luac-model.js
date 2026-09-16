(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LuacModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const COLUMNS = ['id','security_des','issuer','ticker','maturity','rating','maturity_years','oas_bp','yield_pct','industry','flags'];
  const BANDS = ['AAA','AA','A','BBB','BB','NR'];
  const CURVE_ANCHORS = [
    {label:'5Y',center:5,tolerance:1},
    {label:'7Y',center:7,tolerance:1},
    {label:'10Y',center:10,tolerance:1},
    {label:'30Y',center:30,tolerance:3},
  ];

  function finite(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function validDate(value) {
    if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
    const [year,month,day]=value.split('-').map(Number),parsed=new Date(Date.UTC(year,month-1,day));
    return parsed.getUTCFullYear()===year&&parsed.getUTCMonth()===month-1&&parsed.getUTCDate()===day;
  }

  function ratingBand(rating) {
    if (rating === 'AAA') return 'AAA';
    for (const prefix of ['AA','BBB','BB','A']) if (rating.startsWith(prefix)) return prefix;
    return 'NR';
  }

  function rowToBond(row) {
    const result = {};
    COLUMNS.forEach((name, index) => { result[name] = row[index]; });
    result.band = ratingBand(result.rating);
    return result;
  }

  function qualityFlags(years,oas,bondYield) {
    const flags=[];
    if(bondYield<=0||bondYield>50)flags.push('yield_outlier');
    if(years<=0||years>100)flags.push('maturity_outlier');
    if(oas<-250||oas>5000)flags.push('oas_outlier');
    return flags;
  }

  function validateSnapshot(data) {
    if (!data || Object.keys(data).length !== 4 || !['schema_version','date','columns','records'].every(key=>Object.hasOwn(data,key)) || data.schema_version !== 1 || JSON.stringify(data.columns) !== JSON.stringify(COLUMNS) || !validDate(data.date) || !Array.isArray(data.records) || data.records.length<1 || data.records.length>20000) {
      throw new Error('LUAC 公開資料結構不正確');
    }
    const ids = new Set();
    const bonds = data.records.map((row, index) => {
      if (!Array.isArray(row) || row.length !== COLUMNS.length) throw new Error(`LUAC 第 ${index + 1} 筆欄位不完整`);
      const bond = rowToBond(row);
      if (ids.has(bond.id)) throw new Error(`LUAC ID 重複：${bond.id}`);
      ids.add(bond.id);
      const textLimits={id:64,security_des:180,issuer:300,ticker:32,maturity:10,rating:16,industry:160};
      for (const [key,limit] of Object.entries(textLimits)) {
        if (typeof bond[key] !== 'string' || !bond[key].trim() || bond[key].length>limit) throw new Error(`LUAC 第 ${index + 1} 筆文字欄位無效`);
      }
      if (!validDate(bond.maturity) || ![bond.maturity_years,bond.oas_bp,bond.yield_pct].every(finite) || !Array.isArray(bond.flags) || JSON.stringify(bond.flags)!==JSON.stringify(qualityFlags(bond.maturity_years,bond.oas_bp,bond.yield_pct))) {
        throw new Error(`LUAC 第 ${index + 1} 筆數值無效`);
      }
      return bond;
    });
    return bonds;
  }

  function median(values) {
    if (!values.length) return 0;
    const ordered = [...values].sort((a,b) => a-b), middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
  }

  function localFit(points, target, neighborCount, robustWeights) {
    let insertion = 0;
    while (insertion < points.length && points[insertion].x < target) insertion++;
    let left = insertion - 1, right = insertion, chosen = [];
    while (chosen.length < neighborCount && (left >= 0 || right < points.length)) {
      if (left < 0) chosen.push(right++);
      else if (right >= points.length) chosen.push(left--);
      else if (Math.abs(points[left].x - target) <= Math.abs(points[right].x - target)) chosen.push(left--);
      else chosen.push(right++);
    }
    let bandwidth = 0;
    for (const index of chosen) bandwidth = Math.max(bandwidth, Math.abs(points[index].x - target));
    if (!bandwidth) return median(chosen.map(index => points[index].y));
    let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const index of chosen) {
      const point = points[index], distance = Math.abs(point.x - target) / bandwidth;
      const kernel = distance >= 1 ? 0 : Math.pow(1 - Math.pow(distance, 3), 3);
      const weight = kernel * robustWeights[index];
      sw += weight; sx += weight * point.x; sy += weight * point.y;
      sxx += weight * point.x * point.x; sxy += weight * point.x * point.y;
    }
    if (!sw) return median(chosen.map(index => points[index].y));
    const denominator = sw * sxx - sx * sx;
    if (Math.abs(denominator) < 1e-12) return sy / sw;
    const slope = (sw * sxy - sx * sy) / denominator;
    return (sy - slope * sx) / sw + slope * target;
  }

  function fitLowess(input, minimumSamples=20) {
    if (!Array.isArray(input) || input.length < minimumSamples) return null;
    const points = [...input].sort((a,b) => a.x-b.x || String(a.id).localeCompare(String(b.id)));
    const neighborCount = Math.min(points.length, Math.max(30, Math.ceil(points.length * 0.3)));
    let robust = new Array(points.length).fill(1), fitted = [];
    for (let iteration = 0; iteration < 3; iteration++) {
      fitted = points.map(point => localFit(points, point.x, neighborCount, robust));
      if (iteration === 2) break;
      const residuals = points.map((point,index) => Math.abs(point.y-fitted[index]));
      const scale = median(residuals);
      if (scale < 1e-12) {
        robust = residuals.map(value => value < 1e-10 ? 1 : 0);
        if (robust.every(value => value === 1)) break;
        continue;
      }
      robust = residuals.map(value => {
        const ratio = value/(6*scale);
        return ratio >= 1 ? 0 : Math.pow(1-ratio*ratio,2);
      });
    }
    return {points,neighborCount,robust,predict:target=>localFit(points,target,neighborCount,robust)};
  }

  function lowess(input, options={}) {
    const minimumSamples=options.minimumSamples??20,fit=fitLowess(input,minimumSamples);
    if(!fit)return [];
    const targets=options.targets||fit.points;
    return targets.map(target=>{
      const source=typeof target==='number'?{x:target}:target,fitted=fit.predict(source.x);
      return {...source,fitted,...(finite(source.y)?{residual:source.y-fitted}:{})};
    });
  }

  function curveEligibility(points, options={}) {
    const minimumSamples=options.minimumSamples??20,requireCoverage=options.requireCoverage??true;
    if (points.length < minimumSamples) return {status:'sample',count:points.length,missing:[]};
    const missing=CURVE_ANCHORS.filter(anchor=>!points.some(point=>Math.abs(point.x-anchor.center)<=anchor.tolerance)).map(anchor=>anchor.label);
    return {status:requireCoverage&&missing.length?'coverage':'eligible',count:points.length,missing};
  }

  function buildCurves(bonds, metric, groupBy='band', requestedGroups=groupBy==='band'?BANDS:null, options={}) {
    const getter=typeof groupBy==='function'?groupBy:bond=>bond[groupBy];
    const eligibleBonds=bonds.filter(bond=>
      (!Array.isArray(bond.flags)||bond.flags.length===0)&&
      finite(bond.maturity_years)&&bond.maturity_years>0&&bond.maturity_years<=50&&finite(bond[metric])
    );
    const groups=requestedGroups?[...requestedGroups]:[...new Set(eligibleBonds.map(getter))].sort((a,b)=>String(a).localeCompare(String(b)));
    const curves=new Map(),fitted=new Map(),eligibility=new Map();
    const grid=options.grid||Array.from({length:201},(_,index)=>index/4);
    for (const group of groups) {
      const points=eligibleBonds.filter(bond=>getter(bond)===group).map(bond=>({id:bond.id,x:bond.maturity_years,y:bond[metric],bond}));
      const result=curveEligibility(points,options),curve=result.status==='eligible'?lowess(points,{minimumSamples:options.minimumSamples??20,targets:grid}):[];
      eligibility.set(group,result);curves.set(group,curve);
      if(result.status==='eligible')for(const point of lowess(points,{minimumSamples:options.minimumSamples??20}))fitted.set(point.id,point);
    }
    return {curves,fitted,eligibility};
  }

  return {BANDS,COLUMNS,CURVE_ANCHORS,buildCurves,curveEligibility,finite,fitLowess,lowess,qualityFlags,ratingBand,rowToBond,validateSnapshot};
});
