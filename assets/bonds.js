(() => {
  'use strict';
  const model=window.LuacModel;
  const bandColors={AAA:'#2c7fb8',AA:'#41ab5d',A:'#f0a202',BBB:'#d9488b',BB:'#7b61a8',NR:'#8b95a1'};
  const palette=['#2c7fb8','#41ab5d','#f0a202','#d9488b','#7b61a8','#00a6a6','#e76f51','#6a994e','#577590','#b56576'];
  const groupLabels={band:'信評大類',industry:'產業',ticker:'Ticker'};
  const pageSize=50,xLimit={min:0,max:50};
  const elements=Object.fromEntries([
    'bond-total','bond-status','bond-search','show-curves','show-outliers','reset-filters','point-group','curve-group','curve-source','grouping-notice','filter-grid','chart-title','chart-subtitle','curve-legend','canvas-wrap','bond-canvas','bond-tooltip','bond-rows','table-summary','page-prev','page-next','page-label','zoom-reset','residual-heading'
  ].map(id=>[id,document.getElementById(id)]));
  const state={
    bonds:[],date:'',metric:'yield_pct',selected:{rating:new Set(),industry:new Set(),ticker:new Set()},
    filterOrder:['rating','industry','ticker'],available:{},pointGroup:'band',curveGroup:'band',curveSource:'filtered',
    fit:new Map(),curves:new Map(),eligibility:new Map(),curveGroups:[],curvePopulation:[],table:[],plot:[],page:1,sort:{key:'residual',direction:'desc'},
    selectedBond:null,pinned:false,domain:null,baseDomain:null,screenPoints:[],drag:null,filterDrag:null,
    curveKey:'',renderTimer:null,
  };
  const canvas=elements['bond-canvas'],context=canvas.getContext('2d');

  const metricLabel=()=>state.metric==='yield_pct'?'Yield':'OAS Spread';
  const metricUnit=()=>state.metric==='yield_pct'?'%':' bp';
  const number=(value,digits=2)=>Number.isFinite(value)?new Intl.NumberFormat('en-US',{minimumFractionDigits:digits,maximumFractionDigits:digits}).format(value):'n.a.';
  const escapeHtml=value=>String(value).replace(/[&<>'"]/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[character]));
  const isOutlier=bond=>bond.flags.length>0;
  const sortedValues=values=>[...values].sort((a,b)=>String(a).localeCompare(String(b)));
  const groupKey=(bond,group)=>group==='band'?bond.band:bond[group];

  function filterActive(name){return name==='rating'||state.selected[name].size>0;}
  function passesFilter(bond,name){return !filterActive(name)||state.selected[name].has(bond[name]);}
  function passesAllFilters(bond){return state.filterOrder.every(name=>passesFilter(bond,name));}

  function optionLabel(name,value,count){
    const label=document.createElement('label'),input=document.createElement('input'),text=document.createElement('span');
    input.type='checkbox';input.value=value;input.dataset.filter=name;input.checked=state.selected[name].has(value);
    label.dataset.value=value;text.textContent=`${value} (${count.toLocaleString('en-US')})`;label.append(input,text);return label;
  }

  function renderFilterOrder(){
    for(const name of state.filterOrder){const card=elements['filter-grid'].querySelector(`[data-filter="${name}"]`);elements['filter-grid'].append(card);}
    state.filterOrder.forEach((name,index)=>{
      const card=elements['filter-grid'].querySelector(`[data-filter="${name}"]`);
      card.querySelector('.filter-order').textContent=String(index+1);
      card.querySelector('[data-filter-move="up"]').disabled=index===0;
      card.querySelector('[data-filter-move="down"]').disabled=index===state.filterOrder.length-1;
    });
  }

  function applyListSearch(name){
    const input=document.querySelector(`[data-list-search="${name}"]`),query=input?.value.trim().toLocaleLowerCase('en-US')||'';
    document.querySelectorAll(`#${name}-filter label`).forEach(label=>{label.hidden=Boolean(query&&!label.textContent.toLocaleLowerCase('en-US').includes(query));});
  }

  function syncCascadingFilters(){
    const scrollPositions=new Map(state.filterOrder.map(name=>[name,document.getElementById(`${name}-filter`).scrollTop]));
    const active=document.activeElement?.matches?.('.check-list input')?{name:document.activeElement.dataset.filter,value:document.activeElement.value}:null;
    for(let index=0;index<state.filterOrder.length;index++){
      const name=state.filterOrder[index],upstream=state.filterOrder.slice(0,index);
      const pool=state.bonds.filter(bond=>upstream.every(filter=>passesFilter(bond,filter))),counts=new Map();
      for(const bond of pool)counts.set(bond[name],(counts.get(bond[name])||0)+1);
      const values=sortedValues(counts.keys()),allowed=new Set(values);
      state.selected[name]=new Set([...state.selected[name]].filter(value=>allowed.has(value)));
      state.available[name]={values,counts};
    }
    renderFilterOrder();
    for(const name of state.filterOrder){
      const container=document.getElementById(`${name}-filter`),{values,counts}=state.available[name],existing=new Map([...container.querySelectorAll('label')].map(label=>[label.dataset.value,label]));
      values.forEach((value,index)=>{
        const label=existing.get(value)||optionLabel(name,value,counts.get(value)||0),input=label.querySelector('input'),text=label.querySelector('span');
        input.checked=state.selected[name].has(value);text.textContent=`${value} (${(counts.get(value)||0).toLocaleString('en-US')})`;
        const current=container.children[index];if(current!==label)container.insertBefore(label,current||null);existing.delete(value);
      });
      for(const label of existing.values())label.remove();
      const selected=state.selected[name],summary=name==='rating'?`${selected.size}/${values.length}`:selected.size?`${selected.size}/${values.length}`:'全部';
      document.getElementById(`${name}-summary`).textContent=`· ${summary}`;applyListSearch(name);
    }
    requestAnimationFrame(()=>{
      for(const [name,top] of scrollPositions)document.getElementById(`${name}-filter`).scrollTop=top;
      if(active&&!document.activeElement?.matches?.('.check-list input')){
        const inputs=[...document.querySelectorAll(`#${active.name}-filter input`)],target=inputs.find(input=>input.value===active.value)||inputs[0];target?.focus({preventScroll:true});
      }
    });
  }

  function enforceGroupings(announce=false){
    const messages=[];
    const check=(kind,group)=>{
      if(group==='band')return group;
      const effective=groupingValues(group,curvePopulation()),count=kind==='曲線'&&group==='industry'?effective.length:state.selected[group].size;
      if(count>=1&&count<=10)return group;
      if(announce)messages.push(`${kind}若依${groupLabels[group]}分類，需要 1–10 個有效分類；已改回信評大類。`);
      return 'band';
    };
    state.pointGroup=check('點位顏色',state.pointGroup);
    state.curveGroup=check('曲線',state.curveGroup);
    elements['point-group'].value=state.pointGroup;elements['curve-group'].value=state.curveGroup;
    elements['grouping-notice'].textContent=messages.join(' ');
  }

  function filterChanged(announce=true){syncCascadingFilters();enforceGroupings(announce);state.curveKey='';state.page=1;render();}

  function groupingValues(group,population){
    if(group==='band')return model.BANDS.filter(value=>population.some(bond=>bond.band===value));
    const available=new Set(population.map(bond=>groupKey(bond,group))),selected=state.selected[group];
    return selected.size?sortedValues([...selected].filter(value=>available.has(value))):sortedValues(available);
  }

  function seriesColors(group,values){
    if(group==='band')return new Map(model.BANDS.map(value=>[value,bandColors[value]]));
    return new Map(values.map((value,index)=>[value,palette[index%palette.length]]));
  }

  function curvePopulation(){return state.bonds.filter(passesAllFilters);}
  function visibleBonds(){
    const search=elements['bond-search'].value.trim().toLocaleLowerCase('en-US');
    return state.bonds.filter(bond=>passesAllFilters(bond)&&(!search||bond.security_des.toLocaleLowerCase('en-US').includes(search)||bond.id.toLocaleLowerCase('en-US').includes(search)));
  }

  function computeCurves(){
    const selectedKey=state.filterOrder.map(name=>`${name}:${sortedValues(state.selected[name]).join('|')}`).join('::');
    const key=[state.metric,state.curveGroup,state.curveSource,selectedKey].join('::');if(key===state.curveKey)return;
    const filtered=curvePopulation(),groups=groupingValues(state.curveGroup,filtered),allowed=new Set(groups);
    const population=state.curveSource==='all'?state.bonds.filter(bond=>allowed.has(groupKey(bond,state.curveGroup))):filtered;
    const options=state.curveSource==='all'?{minimumSamples:20,requireCoverage:true}:{minimumSamples:5,requireCoverage:false};
    const result=model.buildCurves(population,state.metric,bond=>groupKey(bond,state.curveGroup),groups,options);
    state.curves=result.curves;state.fit=result.fitted;state.eligibility=result.eligibility;state.curveGroups=groups;state.curvePopulation=population;state.curveKey=key;
  }

  function curveStatusText(group){
    const result=state.eligibility.get(group);if(!result||result.status==='sample')return '樣本不足';
    if(result.status==='coverage')return `期限覆蓋不足${result.missing.length?`（缺 ${result.missing.join('、')}）`:''}`;
    if(result.missing.length)return `期限帶提示（缺 ${result.missing.join('、')}）`;
    return '';
  }

  function curvePoint(bond){
    if(bond.maturity_years<=xLimit.min||bond.maturity_years>xLimit.max)return null;
    const group=groupKey(bond,state.curveGroup),eligibility=state.eligibility.get(group);if(eligibility?.status!=='eligible')return null;
    const direct=state.fit.get(bond.id);if(direct)return direct;
    const curve=state.curves.get(group)||[];if(!curve.length)return null;
    let right=curve.findIndex(point=>point.x>=bond.maturity_years);if(right<0)right=curve.length-1;
    const left=Math.max(0,right-1),a=curve[left],b=curve[right],ratio=a===b||b.x===a.x?0:(bond.maturity_years-a.x)/(b.x-a.x);
    const fitted=a.fitted+(b.fitted-a.fitted)*Math.max(0,Math.min(1,ratio));return{fitted,residual:bond[state.metric]-fitted};
  }

  function sortedTable(bonds){
    const {key,direction}=state.sort,sign=direction==='asc'?1:-1,fit=bond=>curvePoint(bond)?.residual;
    const numeric=(a,b,getter,direction)=>{const av=getter(a),bv=getter(b),af=Number.isFinite(av),bf=Number.isFinite(bv);if(af!==bf)return af?-1:1;return af?(av-bv)*direction:0;};
    const compare={residual:(a,b)=>numeric(a,b,fit,sign),yield:(a,b)=>(a.yield_pct-b.yield_pct)*sign,oas:(a,b)=>(a.oas_bp-b.oas_bp)*sign,maturity:(a,b)=>(a.maturity_years-b.maturity_years)*sign,issuer:(a,b)=>a.issuer.localeCompare(b.issuer)*sign,ticker:(a,b)=>a.ticker.localeCompare(b.ticker)*sign}[key];
    return [...bonds].sort((a,b)=>compare(a,b)||a.id.localeCompare(b.id));
  }

  function domains(plot){
    const included=plot.filter(bond=>(elements['show-outliers'].checked||!isOutlier(bond))&&bond.maturity_years>=xLimit.min&&bond.maturity_years<=xLimit.max),ys=included.map(bond=>bond[state.metric]);
    if(!ys.length)return{xMin:xLimit.min,xMax:xLimit.max,yMin:0,yMax:1};
    let yMin=Math.min(...ys),yMax=Math.max(...ys);const padding=Math.max(state.metric==='yield_pct'?.2:5,(yMax-yMin)*.08);yMin-=padding;yMax+=padding;if(yMin===yMax)yMax=yMin+1;
    return{xMin:xLimit.min,xMax:xLimit.max,yMin,yMax};
  }

  function constrainedDomain(domain){
    const result={...domain},maximumSpan=xLimit.max-xLimit.min,span=result.xMax-result.xMin;if(span>=maximumSpan){result.xMin=xLimit.min;result.xMax=xLimit.max;return result;}
    if(result.xMin<xLimit.min){result.xMax+=xLimit.min-result.xMin;result.xMin=xLimit.min;}if(result.xMax>xLimit.max){result.xMin-=result.xMax-xLimit.max;result.xMax=xLimit.max;}return result;
  }
  function tickValues(min,max,count=6){return Array.from({length:count},(_,index)=>min+(max-min)*index/(count-1));}
  function resizeCanvas(){const rect=canvas.getBoundingClientRect(),ratio=Math.min(devicePixelRatio||1,2),width=Math.max(1,Math.round(rect.width*ratio)),height=Math.max(1,Math.round(rect.height*ratio));if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}context.setTransform(ratio,0,0,ratio,0,0);return{width:rect.width,height:rect.height};}

  function draw(){
    const size=resizeCanvas(),domain=state.domain||{xMin:0,xMax:1,yMin:0,yMax:1},margin={left:66,right:22,top:24,bottom:48};canvas.dataset.xMin=String(domain.xMin);canvas.dataset.xMax=String(domain.xMax);
    const width=Math.max(1,size.width-margin.left-margin.right),height=Math.max(1,size.height-margin.top-margin.bottom),sx=x=>margin.left+(x-domain.xMin)/(domain.xMax-domain.xMin)*width,sy=y=>margin.top+height-(y-domain.yMin)/(domain.yMax-domain.yMin)*height;
    context.clearRect(0,0,size.width,size.height);context.fillStyle='#0c161e';context.fillRect(0,0,size.width,size.height);context.font='12px Arial';context.textBaseline='middle';context.strokeStyle='#31404a';context.lineWidth=1;
    for(const value of tickValues(domain.xMin,domain.xMax)){const x=sx(value);context.beginPath();context.moveTo(x,margin.top);context.lineTo(x,margin.top+height);context.stroke();context.fillStyle='#b9c4cc';context.textAlign='center';context.fillText(`${number(value,0)}Y`,x,size.height-24);}
    for(const value of tickValues(domain.yMin,domain.yMax)){const y=sy(value);context.beginPath();context.moveTo(margin.left,y);context.lineTo(margin.left+width,y);context.stroke();context.fillStyle='#b9c4cc';context.textAlign='right';context.fillText(`${number(value,state.metric==='yield_pct'?1:0)}${metricUnit()}`,margin.left-9,y);}
    context.fillStyle='#d5dde3';context.textAlign='center';context.fillText('Maturity',margin.left+width/2,size.height-8);context.save();context.translate(15,margin.top+height/2);context.rotate(-Math.PI/2);context.fillText(metricLabel(),0,0);context.restore();
    const curveColors=seriesColors(state.curveGroup,state.curveGroups);
    if(elements['show-curves'].checked)for(const group of state.curveGroups){const curve=state.curves.get(group)||[];if(!curve.length)continue;context.strokeStyle=curveColors.get(group)||'#cbd5e1';context.lineWidth=2.2;context.beginPath();let started=false;for(const point of curve){if(point.x<domain.xMin||point.x>domain.xMax||point.fitted<domain.yMin||point.fitted>domain.yMax)continue;const x=sx(point.x),y=sy(point.fitted);if(!started){context.moveTo(x,y);started=true;}else context.lineTo(x,y);}if(started)context.stroke();}
    const pointValues=groupingValues(state.pointGroup,state.plot),pointColors=seriesColors(state.pointGroup,pointValues);state.screenPoints=[];
    for(const bond of state.plot){if(!elements['show-outliers'].checked&&isOutlier(bond))continue;const value=bond[state.metric];if(bond.maturity_years<domain.xMin||bond.maturity_years>domain.xMax||value<domain.yMin||value>domain.yMax)continue;const x=sx(bond.maturity_years),y=sy(value),selected=bond.id===state.selectedBond?.id;context.beginPath();context.arc(x,y,selected?6:2.8,0,Math.PI*2);context.fillStyle=pointColors.get(groupKey(bond,state.pointGroup))||'#8b95a1';context.globalAlpha=selected?1:.72;context.fill();context.globalAlpha=1;if(selected){context.strokeStyle='#fff';context.lineWidth=2;context.stroke();}state.screenPoints.push({bond,x,y});}
  }

  function tooltipHtml(bond){
    const point=curvePoint(bond),active=metricLabel(),curveGroup=groupKey(bond,state.curveGroup),status=curveStatusText(curveGroup),flag=bond.flags.length?`<p class="flag">資料異常：${escapeHtml(bond.flags.join('、'))}</p>`:'';
    const curve=point?`${number(point.fitted,state.metric==='yield_pct'?3:2)}${metricUnit()}`:`n.a.${status?`（${escapeHtml(status)}）`:''}`,residual=point?`${point.residual>=0?'+':''}${number(point.residual,state.metric==='yield_pct'?3:2)}${metricUnit()}`:'n.a.';
    const source=state.curveSource==='all'?'全樣本':'已篩選標的';
    return `<strong>${escapeHtml(bond.security_des)}</strong><div>${escapeHtml(bond.issuer)} · ${escapeHtml(bond.ticker)}</div><dl><dt>Yield</dt><dd>${number(bond.yield_pct,3)}%</dd><dt>OAS Spread</dt><dd>${number(bond.oas_bp,2)} bp</dd><dt>Maturity</dt><dd>${escapeHtml(bond.maturity)} (${number(bond.maturity_years,2)}Y)</dd><dt>信評／產業</dt><dd>${escapeHtml(bond.rating)} · ${escapeHtml(bond.industry)}</dd><dt>點位顏色</dt><dd>${groupLabels[state.pointGroup]} · ${escapeHtml(groupKey(bond,state.pointGroup))}</dd><dt>曲線分類</dt><dd>${groupLabels[state.curveGroup]} · ${escapeHtml(curveGroup)}</dd><dt>曲線母體</dt><dd>${source}</dd><dt>${active} curve</dt><dd>${curve}</dd><dt>${active} − curve</dt><dd>${residual}</dd></dl>${flag}`;
  }
  function showTooltip(bond,clientX,clientY,pin=false){state.selectedBond=bond;state.pinned=pin;const tip=elements['bond-tooltip'];tip.innerHTML=tooltipHtml(bond);tip.hidden=false;requestAnimationFrame(()=>{tip.style.left=`${Math.max(8,Math.min(innerWidth-tip.offsetWidth-8,clientX+12))}px`;tip.style.top=`${Math.max(8,Math.min(innerHeight-tip.offsetHeight-8,clientY-tip.offsetHeight-12))}px`;});draw();}
  function hideTooltip(force=false){if(state.pinned&&!force)return;elements['bond-tooltip'].hidden=true;if(force){state.pinned=false;state.selectedBond=null;draw();}}
  function nearest(event){const rect=canvas.getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top;let best=null,distance=90;for(const point of state.screenPoints){const candidate=(point.x-x)**2+(point.y-y)**2;if(candidate<distance){distance=candidate;best=point;}}return best;}

  function renderTable(){
    const start=(state.page-1)*pageSize,rows=state.table.slice(start,start+pageSize),body=elements['bond-rows'];body.replaceChildren();
    for(const bond of rows){const point=curvePoint(bond),residual=point?.residual,tr=document.createElement('tr');tr.tabIndex=0;tr.dataset.id=bond.id;tr.setAttribute('aria-label',`${bond.security_des}，Yield ${number(bond.yield_pct,3)}%，OAS ${number(bond.oas_bp,2)} bp`);if(bond.id===state.selectedBond?.id){tr.classList.add('selected');tr.setAttribute('aria-selected','true');}
      tr.innerHTML=`<td><strong>${escapeHtml(bond.security_des)}</strong>${bond.flags.length?'<span class="quality">異常</span>':''}<small>${escapeHtml(bond.id)}</small></td><td>${escapeHtml(bond.issuer)}<small>${escapeHtml(bond.industry)}</small></td><td>${escapeHtml(bond.ticker)}</td><td class="number">${escapeHtml(bond.maturity)}<small>${number(bond.maturity_years,2)}Y</small></td><td>${escapeHtml(bond.rating)}</td><td class="number">${number(bond.yield_pct,3)}%</td><td class="number">${number(bond.oas_bp,2)} bp</td><td class="number ${Number.isFinite(residual)?residual>=0?'positive':'negative':''}">${Number.isFinite(residual)?`${residual>=0?'+':''}${number(residual,state.metric==='yield_pct'?3:2)}${metricUnit()}`:'n.a.'}</td>`;
      const open=event=>{const box=tr.getBoundingClientRect();showTooltip(bond,event.clientX||box.right,event.clientY||box.top,true);renderTable();};tr.addEventListener('click',open);tr.addEventListener('focus',()=>{const box=tr.getBoundingClientRect();showTooltip(bond,box.right,box.top,false);});tr.addEventListener('keydown',event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();open(event);}});tr.addEventListener('blur',()=>hideTooltip());body.append(tr);
    }
    document.querySelectorAll('.bond-table-card th[data-sort]').forEach(th=>{th.removeAttribute('aria-sort');if(th.dataset.sort===state.sort.key)th.setAttribute('aria-sort',state.sort.direction==='asc'?'ascending':'descending');});
    const pages=Math.max(1,Math.ceil(state.table.length/pageSize));elements['page-label'].textContent=`${state.page} / ${pages}`;elements['page-prev'].disabled=state.page<=1;elements['page-next'].disabled=state.page>=pages;elements['table-summary'].textContent=`${state.table.length.toLocaleString('en-US')} 檔；每頁 ${pageSize} 檔`;
  }

  function legendItem(group,color,mode,count,status=''){
    const item=document.createElement('span');item.className='legend-item';item.style.setProperty('--series',color||'#8b95a1');
    const mark=document.createElement('i'),label=document.createElement('span');mark.className=`legend-mark ${mode}`;label.textContent=`${group} (${count.toLocaleString('en-US')})`;item.append(mark,label);
    if(status){const note=document.createElement('span');note.className='legend-status';note.textContent=`· ${status}`;item.append(note);}return item;
  }
  function renderLegendGroup(title,group,mode){
    const wrapper=document.createElement('div');wrapper.className='legend-group';const heading=document.createElement('span');heading.className='legend-title';heading.textContent=title;wrapper.append(heading);
    const population=mode==='curve'?state.curvePopulation:state.plot,values=mode==='curve'?state.curveGroups:groupingValues(group,population),colors=seriesColors(group,values);
    for(const value of values){const count=mode==='curve'?(state.eligibility.get(value)?.count||0):population.filter(bond=>groupKey(bond,group)===value&&(elements['show-outliers'].checked||!isOutlier(bond))).length,status=mode==='curve'?curveStatusText(value):'';if(count||status)wrapper.append(legendItem(value,colors.get(value),mode,count,status));}
    return wrapper;
  }
  function renderLegend(){
    const legend=elements['curve-legend'];legend.replaceChildren();
    if(state.pointGroup===state.curveGroup&&state.curveSource==='filtered'){
      const population=state.plot,values=groupingValues(state.pointGroup,curvePopulation()),colors=seriesColors(state.pointGroup,values),wrapper=document.createElement('div');wrapper.className='legend-group';const heading=document.createElement('span');heading.className='legend-title';heading.textContent=`點位顏色與回歸曲線｜${groupLabels[state.pointGroup]}`;wrapper.append(heading);
      for(const value of values){const count=population.filter(bond=>groupKey(bond,state.pointGroup)===value&&(elements['show-outliers'].checked||!isOutlier(bond))).length,status=curveStatusText(value);wrapper.append(legendItem(value,colors.get(value),'combined',count,status));}legend.append(wrapper);
    }else{
      legend.append(renderLegendGroup(`點位顏色｜${groupLabels[state.pointGroup]}`,state.pointGroup,'point'));
      legend.append(renderLegendGroup(`回歸曲線｜${groupLabels[state.curveGroup]}・${state.curveSource==='all'?'全樣本':'已篩選標的'}`,state.curveGroup,'curve'));
    }
  }

  function render(resetDomain=true){
    computeCurves();const visible=visibleBonds();state.table=sortedTable(visible);state.plot=visible;const pages=Math.max(1,Math.ceil(state.table.length/pageSize));state.page=Math.min(state.page,pages);
    if(resetDomain){state.baseDomain=domains(state.plot);state.domain={...state.baseDomain};}
    const anomalies=visible.filter(isOutlier).length,curveCount=[...state.eligibility.values()].filter(result=>result.status==='eligible').length;
    elements['bond-status'].textContent=`顯示 ${visible.length.toLocaleString('en-US')} 檔；${curveCount} 條有效曲線；目前指標異常 ${anomalies.toLocaleString('en-US')} 檔`;
    elements['chart-title'].textContent=`Maturity × ${metricLabel()}`;elements['residual-heading'].querySelector('button').textContent=`${metricLabel()} − curve`;
    const sourceText=state.curveSource==='all'?'全樣本曲線只沿用目前可見分類':'曲線套用全部三層篩選';
    elements['chart-subtitle'].textContent=`曲線依${groupLabels[state.curveGroup]}分類；${sourceText}。個券搜尋只影響點位與表格。${elements['show-outliers'].checked?'圖中包含異常值。':'異常值預設不顯示。'}`;
    renderLegend();renderTable();draw();
  }
  function scheduleRender(resetDomain=true){clearTimeout(state.renderTimer);state.renderTimer=setTimeout(()=>render(resetDomain),60);}

  function initializeFilters(){
    state.filterOrder=['rating','industry','ticker'];state.selected={rating:new Set(state.bonds.filter(bond=>['AAA','AA','A','BBB'].includes(bond.band)).map(bond=>bond.rating)),industry:new Set(),ticker:new Set()};
    state.pointGroup='band';state.curveGroup='band';state.curveSource='filtered';state.sort={key:'residual',direction:'desc'};elements['point-group'].value='band';elements['curve-group'].value='band';elements['curve-source'].value='filtered';elements['grouping-notice'].textContent='';syncCascadingFilters();state.curveKey='';
  }

  function moveFilter(name,direction){const index=state.filterOrder.indexOf(name),next=index+direction;if(next<0||next>=state.filterOrder.length)return;state.filterOrder.splice(index,1);state.filterOrder.splice(next,0,name);filterChanged();}
  function setVisualFilterOrder(name,targetName,after){if(name===targetName)return;const next=state.filterOrder.filter(value=>value!==name),target=next.indexOf(targetName)+(after?1:0);next.splice(target,0,name);state.filterOrder=next;renderFilterOrder();}

  elements['filter-grid'].addEventListener('change',event=>{const input=event.target;if(!input.matches('.check-list input'))return;const set=state.selected[input.dataset.filter];input.checked?set.add(input.value):set.delete(input.value);filterChanged();});
  elements['filter-grid'].addEventListener('click',event=>{
    const action=event.target.closest('[data-filter-action]');if(action){const name=action.dataset.filter,values=state.available[name].values;state.selected[name]=new Set(action.dataset.filterAction==='all'?values:[]);filterChanged();return;}
    const move=event.target.closest('[data-filter-move]');if(move){const name=move.closest('.filter-card').dataset.filter;moveFilter(name,move.dataset.filterMove==='up'?-1:1);}
  });
  elements['filter-grid'].addEventListener('pointerdown',event=>{const handle=event.target.closest('.drag-handle');if(!handle)return;event.preventDefault();const card=handle.closest('.filter-card');handle.setPointerCapture(event.pointerId);state.filterDrag={name:card.dataset.filter,pointerId:event.pointerId};card.classList.add('dragging');});
  elements['filter-grid'].addEventListener('pointermove',event=>{if(!state.filterDrag||event.pointerId!==state.filterDrag.pointerId)return;const target=document.elementFromPoint(event.clientX,event.clientY)?.closest('.filter-card');if(!target)return;const box=target.getBoundingClientRect();setVisualFilterOrder(state.filterDrag.name,target.dataset.filter,event.clientY>box.top+box.height/2);target.classList.add('drop-target');for(const card of elements['filter-grid'].querySelectorAll('.filter-card'))if(card!==target)card.classList.remove('drop-target');});
  const finishFilterDrag=event=>{if(!state.filterDrag||event.pointerId!==state.filterDrag.pointerId)return;for(const card of elements['filter-grid'].querySelectorAll('.filter-card'))card.classList.remove('dragging','drop-target');state.filterDrag=null;filterChanged();};
  elements['filter-grid'].addEventListener('pointerup',finishFilterDrag);elements['filter-grid'].addEventListener('pointercancel',finishFilterDrag);
  document.querySelectorAll('[data-list-search]').forEach(input=>input.addEventListener('input',()=>applyListSearch(input.dataset.listSearch)));

  document.querySelectorAll('[name=bond-metric]').forEach(input=>input.addEventListener('change',()=>{state.metric=input.value;state.curveKey='';state.page=1;render();}));
  elements['point-group'].addEventListener('change',()=>{state.pointGroup=elements['point-group'].value;enforceGroupings(true);render(false);});
  elements['curve-group'].addEventListener('change',()=>{state.curveGroup=elements['curve-group'].value;enforceGroupings(true);state.curveKey='';render(false);});
  elements['curve-source'].addEventListener('change',()=>{state.curveSource=elements['curve-source'].value;state.curveKey='';state.page=1;render(false);});
  elements['show-curves'].addEventListener('change',()=>{renderLegend();draw();});elements['show-outliers'].addEventListener('change',()=>render());
  elements['bond-search'].addEventListener('input',()=>{state.page=1;scheduleRender();});
  document.querySelector('.bond-table-card thead').addEventListener('click',event=>{const header=event.target.closest('th[data-sort]');if(!header)return;const key=header.dataset.sort,defaultDirection=['yield','oas','residual'].includes(key)?'desc':'asc';state.sort=state.sort.key===key?{key,direction:state.sort.direction==='asc'?'desc':'asc'}:{key,direction:defaultDirection};state.page=1;render(false);});
  elements['reset-filters'].addEventListener('click',()=>{elements['bond-search'].value='';elements['show-curves'].checked=true;elements['show-outliers'].checked=false;document.querySelectorAll('[data-list-search]').forEach(input=>{input.value='';});document.querySelector('[name=bond-metric][value=yield_pct]').checked=true;state.metric='yield_pct';initializeFilters();state.page=1;render();});
  elements['page-prev'].addEventListener('click',()=>{state.page--;renderTable();});elements['page-next'].addEventListener('click',()=>{state.page++;renderTable();});elements['zoom-reset'].addEventListener('click',()=>{state.domain={...state.baseDomain};draw();});

  canvas.addEventListener('pointermove',event=>{if(state.drag){const rect=canvas.getBoundingClientRect(),dx=event.clientX-state.drag.x,dy=event.clientY-state.drag.y,domain=state.drag.domain;state.domain=constrainedDomain({xMin:domain.xMin-dx/rect.width*(domain.xMax-domain.xMin),xMax:domain.xMax-dx/rect.width*(domain.xMax-domain.xMin),yMin:domain.yMin+dy/rect.height*(domain.yMax-domain.yMin),yMax:domain.yMax+dy/rect.height*(domain.yMax-domain.yMin)});state.drag.moved=state.drag.moved||Math.abs(dx)+Math.abs(dy)>4;draw();return;}if(state.pinned)return;const point=nearest(event);if(point)showTooltip(point.bond,event.clientX,event.clientY);else hideTooltip();});
  canvas.addEventListener('pointerleave',()=>{if(!state.drag)hideTooltip();});canvas.addEventListener('pointerdown',event=>{canvas.setPointerCapture(event.pointerId);state.drag={x:event.clientX,y:event.clientY,domain:{...state.domain},moved:false};elements['canvas-wrap'].classList.add('dragging');});
  canvas.addEventListener('pointerup',event=>{const drag=state.drag;state.drag=null;elements['canvas-wrap'].classList.remove('dragging');if(!drag?.moved){const point=nearest(event);if(point)showTooltip(point.bond,event.clientX,event.clientY,true);else hideTooltip(true);}});
  canvas.addEventListener('wheel',event=>{event.preventDefault();const rect=canvas.getBoundingClientRect(),fx=(event.clientX-rect.left)/rect.width,fy=(event.clientY-rect.top)/rect.height,domain=state.domain,factor=event.deltaY>0?1.16:.86,x=domain.xMin+fx*(domain.xMax-domain.xMin),y=domain.yMax-fy*(domain.yMax-domain.yMin),xSpan=(domain.xMax-domain.xMin)*factor,ySpan=(domain.yMax-domain.yMin)*factor;state.domain=constrainedDomain({xMin:x-fx*xSpan,xMax:x+(1-fx)*xSpan,yMin:y-(1-fy)*ySpan,yMax:y+fy*ySpan});draw();},{passive:false});
  document.addEventListener('click',event=>{if(!event.target.closest('#canvas-wrap')&&!event.target.closest('#bond-tooltip')&&!event.target.closest('#bond-rows'))hideTooltip(true);});document.addEventListener('keydown',event=>{if(event.key==='Escape')hideTooltip(true);});window.addEventListener('resize',()=>draw());

  const version=document.querySelector('.bond-date time')?.dataset.version||Date.now();
  fetch(`assets/luac-bonds.json?v=${encodeURIComponent(version)}`,{cache:'no-store'}).then(response=>{if(!response.ok)throw Error(`HTTP ${response.status}`);return response.json();}).then(data=>{state.date=data.date;state.bonds=model.validateSnapshot(data);elements['bond-total'].textContent=`${state.bonds.length.toLocaleString('en-US')} 檔債券`;initializeFilters();render();}).catch(error=>{elements['bond-status'].textContent=`資料暫時無法載入：${error.message}`;});
})();
