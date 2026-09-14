(() => {
  'use strict';
  const charts = document.querySelector('#rv-charts'), status = document.querySelector('#rv-status'), tip = document.querySelector('#rv-tooltip');
  const ns = 'http://www.w3.org/2000/svg';
  const colors = {Spread:'#178995','10Y':'#3269b1','30Y':'#8054ab','10s30s':'#9b6833'};
  const labels = {min:'Min',median:'Median',max:'Max',current:'目前值',pct:'Percentile'};
  let data;
  const finite = v => typeof v === 'number' && Number.isFinite(v);
  const number = v => new Intl.NumberFormat('en-US',{maximumFractionDigits:6}).format(v);
  const format = (r,f) => !finite(r[f]) ? '缺值' : `${r.sources[f]==='投影片' && f!=='pct' ? '約 ' : ''}${number(r[f]*(f==='pct'?100:1))}${f==='pct'?'%':' bp'}`;
  const tooltipText = (r,metric,field) => ['min','max'].includes(field)
    ? `${r.sector} · ${metric} 2Y Min–Max：${format(r,'min')} – ${format(r,'max')}`
    : `${r.sector} · ${metric} ${labels[field]}：${format(r,field)}`;
  function el(name,attrs={},text) {
    const e=document.createElementNS(ns,name);
    Object.entries(attrs).forEach(([k,v])=>e.setAttribute(k,v));
    if(text!==undefined)e.textContent=text;
    return e;
  }
  function hide(){tip.hidden=true;}
  function show(point,r,metric,field,event) {
    tip.textContent=tooltipText(r,metric,field);
    tip.hidden=false;
    const box=point.getBoundingClientRect();
    const x=event?.clientX ?? box.x+box.width/2, y=event?.clientY ?? box.y;
    tip.style.left=`${Math.max(8,Math.min(innerWidth-tip.offsetWidth-8,x+12))}px`;
    tip.style.top=`${Math.max(8,Math.min(innerHeight-tip.offsetHeight-8,y-tip.offsetHeight-12))}px`;
  }
  function point(svg,shape,attrs,r,metric,field) {
    const p=el(shape,{...attrs,class:`rv-point ${attrs.class||''}`.trim(),tabindex:0,role:'button','data-sector':r.sector,'data-metric':metric,'data-field':field,'aria-label':tooltipText(r,metric,field),'aria-describedby':'rv-tooltip'});
    p.addEventListener('pointerenter',e=>{if(e.pointerType!=='touch')show(p,r,metric,field,e);});
    p.addEventListener('pointermove',e=>{if(e.pointerType!=='touch')show(p,r,metric,field,e);});
    p.addEventListener('pointerleave',hide);
    p.addEventListener('focus',()=>show(p,r,metric,field));p.addEventListener('blur',hide);
    p.addEventListener('click',e=>{e.stopPropagation();show(p,r,metric,field);});
    p.addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();show(p,r,metric,field);}});
    svg.append(p);
  }
  const trianglePoints=(x,y,direction)=>direction==='up'
    ? `${x},${y} ${x+7},${y+12} ${x-7},${y+12}`
    : `${x},${y} ${x+7},${y-12} ${x-7},${y-12}`;
  function chart(metrics,section) {
    const groups=data.sections[section], rows=groups[metrics[0]];
    const card=document.createElement('section');card.className='rv-chart';
    const head=document.createElement('header'),title=document.createElement('h2'),legend=document.createElement('div');
    title.textContent=`${section} · 指標比較`;legend.className='rv-series-legend';
    for(const m of metrics){const item=document.createElement('span');item.textContent=m;item.style.setProperty('--series',colors[m]);legend.append(item);}
    head.append(title,legend);card.append(head);
    const scroll=document.createElement('div');scroll.className='rv-scroll';scroll.tabIndex=0;scroll.setAttribute('aria-label','指標比較圖表，可橫向捲動');
    const width=Math.max(620,rows.length*Math.max(104,metrics.length*40+36)+80,charts.clientWidth-22);
    const left=55,right=width-22,step=(right-left)/rows.length,lane=40;
    const svg=el('svg',{viewBox:`0 0 ${width} 470`,role:'group','aria-label':`${section} ${metrics.join('、')} 共用刻度比較`});svg.style.minWidth=`${width}px`;
    const values=metrics.flatMap(m=>groups[m].flatMap(r=>['min','median','max','current'].map(f=>r[f]))).filter(finite);
    let low=values.length?Math.min(...values):0,high=values.length?Math.max(...values):1;
    const tick=Math.max(1,Math.ceil((high-low)/4/5)*5);low=Math.floor(low/tick)*tick;high=Math.ceil(high/tick)*tick;if(high===low)high=low+tick;
    const y=v=>220-(v-low)/(high-low)*180;
    svg.append(el('text',{x:left,y:17,class:'axis-title'},'2Y value range (bp)'));
    for(let v=low;v<=high+.0001;v+=tick)svg.append(el('line',{x1:left,y1:y(v),x2:right,y2:y(v),stroke:'#e6edf2'}),el('text',{x:left-9,y:y(v)+4,'text-anchor':'end'},number(v)));
    for(const v of [0,50,100])svg.append(el('line',{x1:left,y1:430-v*1.1,x2:right,y2:430-v*1.1,stroke:'#e6edf2'}),el('text',{x:left-9,y:434-v*1.1,'text-anchor':'end'},`${v}%`));
    rows.forEach((row,i)=>{
      const center=left+step*(i+.5);
      if(i%2===0)svg.append(el('rect',{x:left+step*i,y:24,width:step,height:422,fill:'#173e5a','fill-opacity':.025,'pointer-events':'none'}));
      metrics.forEach((metric,j)=>{
        const r=groups[metric][i],x=center+(j-(metrics.length-1)/2)*lane,color=colors[metric];
        if(finite(r.min)&&finite(r.max))svg.append(el('line',{x1:x,y1:y(r.max),x2:x,y2:y(r.min),stroke:'#aebbc9','stroke-width':3,class:'rv-range-line','pointer-events':'none'}));
        // Triangle tips sit on the exact range boundaries; each mark remains its own tooltip target.
        if(finite(r.min))point(svg,'polygon',{points:trianglePoints(x,y(r.min),'down'),fill:'#aebbc9',class:'rv-range-arrow'},r,metric,'min');
        if(finite(r.median))point(svg,'rect',{x:x-13,y:y(r.median)-2,width:26,height:4,fill:'#43516a',class:'rv-median-marker'},r,metric,'median');
        if(finite(r.max))point(svg,'polygon',{points:trianglePoints(x,y(r.max),'up'),fill:'#aebbc9',class:'rv-range-arrow'},r,metric,'max');
        if(finite(r.current))point(svg,'polygon',{points:`${x-7},${y(r.current)-5} ${x+7},${y(r.current)-5} ${x},${y(r.current)+7}`,fill:'#dc7b22',stroke:'white','stroke-width':1.5,class:'rv-current-marker'},r,metric,'current');
        else svg.append(el('text',{x,y:238,'text-anchor':'middle'},'—'));
        if(finite(r.pct))point(svg,'rect',{x:x-10,y:430-Math.max(2,r.pct*110),width:20,height:Math.max(2,r.pct*110),fill:color,rx:2},r,metric,'pct');
        else svg.append(el('text',{x,y:422,'text-anchor':'middle'},'—'));
        if(finite(r.pct))svg.append(el('text',{x,y:430-Math.max(2,r.pct*110)-8,'text-anchor':'middle',class:`percentile-value-label${metrics.length>1?' compact':''}`,style:`fill:${color}`,'data-metric':metric},`${number(r.pct*100)}%`));
      });
      const label=el('text',{x:center,y:253,'text-anchor':'middle',class:'sector-label'}),words=row.sector.split(' ');
      if(row.sector.length>11&&words.length>1)words.forEach((w,j)=>label.append(el('tspan',{x:center,dy:j?14:0},w)));else label.textContent=row.sector;
      svg.append(label);
    });
    svg.append(el('text',{x:left,y:290,class:'axis-title'},'Current percentile'));
    scroll.append(svg);card.append(scroll);
    if(width>charts.clientWidth-22){const hint=document.createElement('p');hint.className='rv-scroll-hint';hint.textContent=`左右捲動圖表，查看全部 ${rows.length} 個分類項目`;card.append(hint);}
    return card;
  }
  function render(){
    hide();const section=document.querySelector('[name=section]:checked').value,metrics=[...document.querySelectorAll('[name=metric]:checked')].map(e=>e.value);
    charts.replaceChildren(...(metrics.length?[chart(metrics,section)]:[]));
    status.textContent=metrics.length?`${section} · ${data.sections[section].Spread.length} 個分類項目 · ${metrics.length} 個指標，共用 bp 刻度`:'請選擇至少一個指標';
  }
  document.querySelector('.rv-controls').addEventListener('change',event=>{
    const input=event.target;
    if(input.name==='metric'&&input.checked){
      for(const other of document.querySelectorAll('[name=metric]')){
        if(other!==input&&(input.value==='10s30s'||other.value==='10s30s'))other.checked=false;
      }
    }
    if(data)render();
  });
  document.addEventListener('keydown',e=>{if(e.key==='Escape')hide();});document.addEventListener('click',hide);
  window.addEventListener('resize',()=>{if(data)render();});window.addEventListener('scroll',hide,true);
  const dataVersion=document.querySelector('.rv-date time')?.getAttribute('datetime')||String(Date.now());
  fetch(`assets/rv-data.json?v=${encodeURIComponent(dataVersion)}`,{cache:'no-store'}).then(r=>{if(!r.ok)throw Error();return r.json();}).then(d=>{data=d;render();}).catch(()=>{status.textContent='資料暫時無法載入，請重新整理頁面。';});
})();
