(() => {
  'use strict';
  const model = window.LuacModel;
  const colors = {AAA:'#2c7fb8',AA:'#41ab5d',A:'#f0a202',BBB:'#d9488b',BB:'#7b61a8',NR:'#8b95a1'};
  const pageSize = 50;
  const xLimit = {min:0,max:50};
  const elements = Object.fromEntries([
    'bond-total','bond-status','bond-search','bond-sort','show-curves','show-outliers','reset-filters','chart-title','chart-subtitle','curve-legend','canvas-wrap','bond-canvas','bond-tooltip','bond-rows','table-summary','page-prev','page-next','page-label','zoom-reset','residual-heading'
  ].map(id => [id,document.getElementById(id)]));
  const state = {
    bonds:[], date:'', metric:'yield_pct', selected:{rating:new Set(),industry:new Set(),issuer:new Set(),ticker:new Set()},
    fit:new Map(), curves:new Map(), table:[], plot:[], page:1, selectedBond:null, pinned:false,
    domain:null, baseDomain:null, screenPoints:[], drag:null, curveKey:'', renderTimer:null,
  };
  const canvas = elements['bond-canvas'], context = canvas.getContext('2d');

  const metricLabel = () => state.metric === 'yield_pct' ? 'Yield' : 'OAS Spread';
  const metricUnit = () => state.metric === 'yield_pct' ? '%' : ' bp';
  const number = (value,digits=2) => Number.isFinite(value) ? new Intl.NumberFormat('en-US',{minimumFractionDigits:digits,maximumFractionDigits:digits}).format(value) : 'n.a.';
  const escapeHtml = value => String(value).replace(/[&<>'"]/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[character]));
  const isOutlier = bond => bond.flags.length > 0;

  function optionLabel(value,count) {
    const label=document.createElement('label');
    const input=document.createElement('input');input.type='checkbox';input.value=value;
    const text=document.createElement('span');text.textContent=`${value} (${count.toLocaleString('en-US')})`;
    label.append(input,text);return label;
  }

  function buildFilter(name,values,defaultSelected) {
    const container=document.getElementById(`${name}-filter`),counts=new Map();
    for(const bond of state.bonds){const value=bond[name];counts.set(value,(counts.get(value)||0)+1);}
    container.replaceChildren();state.selected[name]=new Set(defaultSelected(values));
    for(const value of values){const label=optionLabel(value,counts.get(value)||0),input=label.querySelector('input');input.checked=state.selected[name].has(value);input.dataset.filter=name;container.append(label);}
  }

  function updateSummaries() {
    for(const name of ['rating','industry','issuer','ticker']) {
      const selected=state.selected[name],total=document.querySelectorAll(`#${name}-filter input`).length;
      const text=(name==='issuer'||name==='ticker')&&!selected.size?'全部':`${selected.size}/${total}`;
      document.getElementById(`${name}-summary`).textContent=`· ${text}`;
    }
  }

  function curvePopulation() {
    return state.bonds.filter(bond => state.selected.rating.has(bond.rating) && state.selected.industry.has(bond.industry) && !bond.flags.length);
  }

  function visibleBonds() {
    const search=elements['bond-search'].value.trim().toLocaleLowerCase('en-US');
    return state.bonds.filter(bond => {
      if(!state.selected.rating.has(bond.rating)||!state.selected.industry.has(bond.industry))return false;
      if(state.selected.issuer.size&&!state.selected.issuer.has(bond.issuer))return false;
      if(state.selected.ticker.size&&!state.selected.ticker.has(bond.ticker))return false;
      return !search||bond.security_des.toLocaleLowerCase('en-US').includes(search)||bond.id.toLocaleLowerCase('en-US').includes(search);
    });
  }

  function computeCurves() {
    const key=[state.metric,[...state.selected.rating].sort().join('|'),[...state.selected.industry].sort().join('|')].join('::');
    if(key===state.curveKey)return;
    const result=model.buildCurves(curvePopulation(),state.metric);
    state.curves=result.curves;state.fit=result.fitted;state.curveKey=key;
  }

  function sortedTable(bonds) {
    const mode=elements['bond-sort'].value;
    const fit=bond=>curvePoint(bond)?.residual;
    const numeric=(a,b,getter,direction)=>{
      const av=getter(a),bv=getter(b),af=Number.isFinite(av),bf=Number.isFinite(bv);
      if(af!==bf)return af?-1:1;
      return af?(av-bv)*direction:0;
    };
    const compare={
      'residual-desc':(a,b)=>numeric(a,b,fit,-1),
      'residual-asc':(a,b)=>numeric(a,b,fit,1),
      'yield-desc':(a,b)=>b.yield_pct-a.yield_pct,
      'oas-desc':(a,b)=>b.oas_bp-a.oas_bp,
      'maturity-asc':(a,b)=>a.maturity_years-b.maturity_years,
      'issuer-asc':(a,b)=>a.issuer.localeCompare(b.issuer),
      'ticker-asc':(a,b)=>a.ticker.localeCompare(b.ticker),
    }[mode];
    return [...bonds].sort((a,b)=>compare(a,b)||a.id.localeCompare(b.id));
  }

  function curvePoint(bond) {
    const direct=state.fit.get(bond.id);
    if(direct)return direct;
    const curve=state.curves.get(bond.band)||[];
    if(curve.length<20)return null;
    let right=curve.findIndex(point=>point.x>=bond.maturity_years);
    if(right<0)right=curve.length-1;
    const left=Math.max(0,right-1),a=curve[left],b=curve[right];
    const ratio=a===b||b.x===a.x?0:(bond.maturity_years-a.x)/(b.x-a.x);
    const fitted=a.fitted+(b.fitted-a.fitted)*Math.max(0,Math.min(1,ratio));
    return {fitted,residual:bond[state.metric]-fitted};
  }

  function domains(plot) {
    const included=plot.filter(bond=>(elements['show-outliers'].checked||!isOutlier(bond))&&bond.maturity_years>=xLimit.min&&bond.maturity_years<=xLimit.max);
    const ys=included.map(bond=>bond[state.metric]);
    if(!ys.length)return{xMin:xLimit.min,xMax:xLimit.max,yMin:0,yMax:1};
    let yMin=Math.min(...ys),yMax=Math.max(...ys);
    const yp=Math.max(state.metric==='yield_pct'?.2:5,(yMax-yMin)*.08);
    yMin-=yp;yMax+=yp;if(yMin===yMax)yMax=yMin+1;
    return{xMin:xLimit.min,xMax:xLimit.max,yMin,yMax};
  }

  function constrainedDomain(domain) {
    const result={...domain},maximumSpan=xLimit.max-xLimit.min,span=result.xMax-result.xMin;
    if(span>=maximumSpan){result.xMin=xLimit.min;result.xMax=xLimit.max;return result;}
    if(result.xMin<xLimit.min){result.xMax+=xLimit.min-result.xMin;result.xMin=xLimit.min;}
    if(result.xMax>xLimit.max){result.xMin-=result.xMax-xLimit.max;result.xMax=xLimit.max;}
    return result;
  }

  function tickValues(min,max,count=6){const values=[];for(let i=0;i<count;i++)values.push(min+(max-min)*i/(count-1));return values;}

  function resizeCanvas(){const rect=canvas.getBoundingClientRect(),ratio=Math.min(devicePixelRatio||1,2);const width=Math.max(1,Math.round(rect.width*ratio)),height=Math.max(1,Math.round(rect.height*ratio));if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}context.setTransform(ratio,0,0,ratio,0,0);return{width:rect.width,height:rect.height};}

  function draw() {
    const size=resizeCanvas(),d=state.domain||{xMin:0,xMax:1,yMin:0,yMax:1},margin={left:66,right:22,top:24,bottom:48};
    canvas.dataset.xMin=String(d.xMin);canvas.dataset.xMax=String(d.xMax);
    const width=Math.max(1,size.width-margin.left-margin.right),height=Math.max(1,size.height-margin.top-margin.bottom);
    const sx=x=>margin.left+(x-d.xMin)/(d.xMax-d.xMin)*width,sy=y=>margin.top+height-(y-d.yMin)/(d.yMax-d.yMin)*height;
    context.clearRect(0,0,size.width,size.height);context.fillStyle='#0c161e';context.fillRect(0,0,size.width,size.height);
    context.font='12px Arial';context.textBaseline='middle';context.strokeStyle='#31404a';context.lineWidth=1;
    for(const value of tickValues(d.xMin,d.xMax)){const x=sx(value);context.beginPath();context.moveTo(x,margin.top);context.lineTo(x,margin.top+height);context.stroke();context.fillStyle='#b9c4cc';context.textAlign='center';context.fillText(`${number(value,0)}Y`,x,size.height-24);}
    for(const value of tickValues(d.yMin,d.yMax)){const y=sy(value);context.beginPath();context.moveTo(margin.left,y);context.lineTo(margin.left+width,y);context.stroke();context.fillStyle='#b9c4cc';context.textAlign='right';context.fillText(`${number(value,state.metric==='yield_pct'?1:0)}${metricUnit()}`,margin.left-9,y);}
    context.fillStyle='#d5dde3';context.textAlign='center';context.fillText('Maturity',margin.left+width/2,size.height-8);
    context.save();context.translate(15,margin.top+height/2);context.rotate(-Math.PI/2);context.fillText(metricLabel(),0,0);context.restore();
    if(elements['show-curves'].checked){
      for(const band of model.BANDS){const curve=state.curves.get(band)||[];if(curve.length<20)continue;context.strokeStyle=colors[band];context.lineWidth=2.2;context.beginPath();let started=false;for(const point of curve){if(point.x<d.xMin||point.x>d.xMax||point.fitted<d.yMin||point.fitted>d.yMax)continue;const x=sx(point.x),y=sy(point.fitted);if(!started){context.moveTo(x,y);started=true;}else context.lineTo(x,y);}if(started)context.stroke();}
    }
    state.screenPoints=[];
    for(const bond of state.plot){if(!elements['show-outliers'].checked&&isOutlier(bond))continue;const value=bond[state.metric];if(bond.maturity_years<d.xMin||bond.maturity_years>d.xMax||value<d.yMin||value>d.yMax)continue;const x=sx(bond.maturity_years),y=sy(value),selected=bond.id===state.selectedBond?.id;context.beginPath();context.arc(x,y,selected?6:2.8,0,Math.PI*2);context.fillStyle=colors[bond.band];context.globalAlpha=selected?1:.72;context.fill();context.globalAlpha=1;if(selected){context.strokeStyle='#fff';context.lineWidth=2;context.stroke();}state.screenPoints.push({bond,x,y});}
  }

  function tooltipHtml(bond) {
    const point=curvePoint(bond),active=metricLabel(),flag=bond.flags.length?`<p class="flag">資料異常：${escapeHtml(bond.flags.join('、'))}</p>`:'';
    const curve=point?`${number(point.fitted,state.metric==='yield_pct'?3:2)}${metricUnit()}`:'樣本不足';
    const residual=point?`${point.residual>=0?'+':''}${number(point.residual,state.metric==='yield_pct'?3:2)}${metricUnit()}`:'n.a.';
    return `<strong>${escapeHtml(bond.security_des)}</strong><div>${escapeHtml(bond.issuer)} · ${escapeHtml(bond.ticker)}</div><dl><dt>Yield</dt><dd>${number(bond.yield_pct,3)}%</dd><dt>OAS Spread</dt><dd>${number(bond.oas_bp,2)} bp</dd><dt>Maturity</dt><dd>${escapeHtml(bond.maturity)} (${number(bond.maturity_years,2)}Y)</dd><dt>信評／產業</dt><dd>${escapeHtml(bond.rating)} · ${escapeHtml(bond.industry)}</dd><dt>${active} curve</dt><dd>${curve}</dd><dt>${active} − curve</dt><dd>${residual}</dd></dl>${flag}`;
  }

  function showTooltip(bond,clientX,clientY,pin=false){state.selectedBond=bond;state.pinned=pin;const tip=elements['bond-tooltip'];tip.innerHTML=tooltipHtml(bond);tip.hidden=false;requestAnimationFrame(()=>{tip.style.left=`${Math.max(8,Math.min(innerWidth-tip.offsetWidth-8,clientX+12))}px`;tip.style.top=`${Math.max(8,Math.min(innerHeight-tip.offsetHeight-8,clientY-tip.offsetHeight-12))}px`;});draw();}
  function hideTooltip(force=false){if(state.pinned&&!force)return;elements['bond-tooltip'].hidden=true;if(force){state.pinned=false;state.selectedBond=null;draw();}}
  function nearest(event){const rect=canvas.getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top;let best=null,distance=90;for(const point of state.screenPoints){const d=(point.x-x)**2+(point.y-y)**2;if(d<distance){distance=d;best=point;}}return best;}

  function renderTable() {
    const start=(state.page-1)*pageSize,rows=state.table.slice(start,start+pageSize),body=elements['bond-rows'];body.replaceChildren();
    for(const bond of rows){const point=curvePoint(bond),residual=point?.residual,tr=document.createElement('tr');tr.tabIndex=0;tr.dataset.id=bond.id;tr.setAttribute('aria-label',`${bond.security_des}，Yield ${number(bond.yield_pct,3)}%，OAS ${number(bond.oas_bp,2)} bp`);if(bond.id===state.selectedBond?.id){tr.classList.add('selected');tr.setAttribute('aria-selected','true');}
      tr.innerHTML=`<td><strong>${escapeHtml(bond.security_des)}</strong>${bond.flags.length?'<span class="quality">異常</span>':''}<small>${escapeHtml(bond.id)}</small></td><td>${escapeHtml(bond.issuer)}<small>${escapeHtml(bond.ticker)} · ${escapeHtml(bond.industry)}</small></td><td class="number">${escapeHtml(bond.maturity)}<small>${number(bond.maturity_years,2)}Y</small></td><td>${escapeHtml(bond.rating)}</td><td class="number">${number(bond.yield_pct,3)}%</td><td class="number">${number(bond.oas_bp,2)} bp</td><td class="number ${Number.isFinite(residual)?residual>=0?'positive':'negative':''}">${Number.isFinite(residual)?`${residual>=0?'+':''}${number(residual,state.metric==='yield_pct'?3:2)}${metricUnit()}`:'n.a.'}</td>`;
      const open=event=>{const box=tr.getBoundingClientRect();showTooltip(bond,event.clientX||box.right,event.clientY||box.top,true);renderTable();};tr.addEventListener('click',open);tr.addEventListener('focus',()=>{const box=tr.getBoundingClientRect();showTooltip(bond,box.right,box.top,false);});tr.addEventListener('keydown',event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();open(event);}});tr.addEventListener('blur',()=>hideTooltip());body.append(tr);
    }
    const pages=Math.max(1,Math.ceil(state.table.length/pageSize));elements['page-label'].textContent=`${state.page} / ${pages}`;elements['page-prev'].disabled=state.page<=1;elements['page-next'].disabled=state.page>=pages;
    elements['table-summary'].textContent=`${state.table.length.toLocaleString('en-US')} 檔；每頁 ${pageSize} 檔`;
  }

  function renderLegend() {
    const legend=elements['curve-legend'],population=curvePopulation();legend.replaceChildren();for(const band of model.BANDS){const count=state.plot.filter(bond=>bond.band===band&&(!isOutlier(bond)||elements['show-outliers'].checked)).length;if(!count)continue;const eligible=population.filter(bond=>bond.band===band).length,insufficient=elements['show-curves'].checked&&eligible>0&&(state.curves.get(band)||[]).length<20;const item=document.createElement('span');item.style.setProperty('--series',colors[band]);item.innerHTML=`<i></i>${band} (${count.toLocaleString('en-US')})${insufficient?' · 樣本不足':''}`;legend.append(item);}
  }

  function render(resetDomain=true) {
    computeCurves();const visible=visibleBonds();state.table=sortedTable(visible);state.plot=visible;
    const pages=Math.max(1,Math.ceil(state.table.length/pageSize));state.page=Math.min(state.page,pages);
    if(resetDomain){state.baseDomain=domains(state.plot);state.domain={...state.baseDomain};}
    const anomalies=visible.filter(isOutlier).length,curveCount=[...state.curves.values()].filter(curve=>curve.length>=20).length;
    elements['bond-status'].textContent=`顯示 ${visible.length.toLocaleString('en-US')} 檔；${curveCount} 條曲線；目前指標異常 ${anomalies.toLocaleString('en-US')} 檔`;
    elements['chart-title'].textContent=`Maturity × ${metricLabel()}`;elements['residual-heading'].textContent=`${metricLabel()} − curve`;
    elements['chart-subtitle'].textContent=`曲線依所選產業與信評計算；${elements['show-outliers'].checked?'圖中包含異常值':'異常值預設不顯示'}`;
    updateSummaries();renderLegend();renderTable();draw();
  }

  function scheduleRender(resetDomain=true){clearTimeout(state.renderTimer);state.renderTimer=setTimeout(()=>render(resetDomain),60);}

  function initializeFilters(){
    const unique=name=>[...new Set(state.bonds.map(bond=>bond[name]))].sort((a,b)=>a.localeCompare(b));
    buildFilter('rating',unique('rating'),values=>values.filter(value=>['AAA','AA','A','BBB'].includes(model.ratingBand(value))));
    buildFilter('industry',unique('industry'),values=>values);
    buildFilter('issuer',unique('issuer'),()=>[]);buildFilter('ticker',unique('ticker'),()=>[]);
    document.querySelectorAll('.check-list input').forEach(input=>input.addEventListener('change',()=>{const set=state.selected[input.dataset.filter];input.checked?set.add(input.value):set.delete(input.value);state.page=1;scheduleRender();}));
  }

  document.querySelectorAll('[name=bond-metric]').forEach(input=>input.addEventListener('change',()=>{state.metric=input.value;state.curveKey='';state.page=1;render();}));
  elements['show-curves'].addEventListener('change',()=>draw());elements['show-outliers'].addEventListener('change',()=>render());
  elements['bond-search'].addEventListener('input',()=>{state.page=1;scheduleRender();});elements['bond-sort'].addEventListener('change',()=>{state.page=1;render(false);});
  document.querySelectorAll('[data-filter-action]').forEach(button=>button.addEventListener('click',()=>{const name=button.dataset.filter,inputs=[...document.querySelectorAll(`#${name}-filter input`)];state.selected[name]=new Set(button.dataset.filterAction==='all'?inputs.map(input=>input.value):[]);for(const input of inputs)input.checked=state.selected[name].has(input.value);state.page=1;scheduleRender();}));
  document.querySelectorAll('[data-list-search]').forEach(input=>input.addEventListener('input',()=>{const query=input.value.trim().toLocaleLowerCase('en-US');document.querySelectorAll(`#${input.dataset.listSearch}-filter label`).forEach(label=>label.hidden=query&&!label.textContent.toLocaleLowerCase('en-US').includes(query));}));
  elements['reset-filters'].addEventListener('click',()=>{elements['bond-search'].value='';elements['bond-sort'].value='residual-desc';elements['show-curves'].checked=true;elements['show-outliers'].checked=false;document.querySelector('[name=bond-metric][value=yield_pct]').checked=true;state.metric='yield_pct';state.curveKey='';initializeFilters();state.page=1;render();});
  elements['page-prev'].addEventListener('click',()=>{state.page--;renderTable();});elements['page-next'].addEventListener('click',()=>{state.page++;renderTable();});elements['zoom-reset'].addEventListener('click',()=>{state.domain={...state.baseDomain};draw();});

  canvas.addEventListener('pointermove',event=>{if(state.drag){const rect=canvas.getBoundingClientRect(),dx=event.clientX-state.drag.x,dy=event.clientY-state.drag.y,d=state.drag.domain;state.domain=constrainedDomain({xMin:d.xMin-dx/rect.width*(d.xMax-d.xMin),xMax:d.xMax-dx/rect.width*(d.xMax-d.xMin),yMin:d.yMin+dy/rect.height*(d.yMax-d.yMin),yMax:d.yMax+dy/rect.height*(d.yMax-d.yMin)});state.drag.moved=state.drag.moved||Math.abs(dx)+Math.abs(dy)>4;draw();return;}if(state.pinned)return;const point=nearest(event);if(point)showTooltip(point.bond,event.clientX,event.clientY);else hideTooltip();});
  canvas.addEventListener('pointerleave',()=>{if(!state.drag)hideTooltip();});
  canvas.addEventListener('pointerdown',event=>{canvas.setPointerCapture(event.pointerId);state.drag={x:event.clientX,y:event.clientY,domain:{...state.domain},moved:false};elements['canvas-wrap'].classList.add('dragging');});
  canvas.addEventListener('pointerup',event=>{const drag=state.drag;state.drag=null;elements['canvas-wrap'].classList.remove('dragging');if(!drag?.moved){const point=nearest(event);if(point)showTooltip(point.bond,event.clientX,event.clientY,true);else hideTooltip(true);}});
  canvas.addEventListener('wheel',event=>{event.preventDefault();const rect=canvas.getBoundingClientRect(),fx=(event.clientX-rect.left)/rect.width,fy=(event.clientY-rect.top)/rect.height,d=state.domain,factor=event.deltaY>0?1.16:.86,x=d.xMin+fx*(d.xMax-d.xMin),y=d.yMax-fy*(d.yMax-d.yMin),xSpan=(d.xMax-d.xMin)*factor,ySpan=(d.yMax-d.yMin)*factor;state.domain=constrainedDomain({xMin:x-fx*xSpan,xMax:x+(1-fx)*xSpan,yMin:y-(1-fy)*ySpan,yMax:y+fy*ySpan});draw();},{passive:false});
  document.addEventListener('click',event=>{if(!event.target.closest('#canvas-wrap')&&!event.target.closest('#bond-tooltip')&&!event.target.closest('#bond-rows'))hideTooltip(true);});document.addEventListener('keydown',event=>{if(event.key==='Escape')hideTooltip(true);});window.addEventListener('resize',()=>draw());

  const version=document.querySelector('.bond-date time')?.dateTime||Date.now();
  fetch(`assets/luac-bonds.json?v=${encodeURIComponent(version)}`,{cache:'no-store'}).then(response=>{if(!response.ok)throw Error(`HTTP ${response.status}`);return response.json();}).then(data=>{state.date=data.date;state.bonds=model.validateSnapshot(data);elements['bond-total'].textContent=`${state.bonds.length.toLocaleString('en-US')} 檔債券`;initializeFilters();render();}).catch(error=>{elements['bond-status'].textContent=`資料暫時無法載入：${error.message}`;});
})();
