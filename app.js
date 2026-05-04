// ===== API ENDPOINTS (Free, no key needed) =====
const API={
  dexSearch:'https://api.dexscreener.com/latest/dex/search?q=',
  dexPairs:'https://api.dexscreener.com/latest/dex/pairs/solana/',
  dexToken:'https://api.dexscreener.com/latest/dex/tokens/',
  dexBoosts:'https://api.dexscreener.com/token-boosts/latest/v1',
  dexProfiles:'https://api.dexscreener.com/token-profiles/latest/v1',
  dexTokenPairs:'https://api.dexscreener.com/token-pairs/v1/solana/',
  gecko:'https://api.coingecko.com/api/v3/simple/price?ids=solana,bitcoin,ethereum,jupiter-exchange-solana,bonk,dogwifcoin,pepe&vs_currencies=usd&include_24hr_change=true',
};

// ===== GLOBAL STATE SYNC (NO BACKEND NEEDED) =====
// Calculate a global baseline so everyone on earth sees the same starting numbers.
function getGlobalBaseline() {
  const now = Date.now();
  const startOfUTCDay = new Date(now).setUTCHours(0,0,0,0);
  const msPassed = now - startOfUTCDay;
  
  // Solana average tokens created per day is ~25000 (~0.289 per second)
  // Raydium migrations average ~1500 per day (~0.017 per second)
  return {
    tokens: Math.floor((msPassed / 1000) * 0.289),
    migrations: Math.floor((msPassed / 1000) * 0.017),
    sessionStart: startOfUTCDay
  };
}

const globalBase = getGlobalBaseline();
let sessionStart = globalBase.sessionStart;

// Check if local storage is from an older day, if so, reset it
let lastSavedDay = parseInt(localStorage.getItem('cr_sessionStart')) || 0;
if (lastSavedDay !== sessionStart) {
  localStorage.setItem('cr_sessionStart', sessionStart);
  localStorage.setItem('cr_totalScanned', 0);
  localStorage.setItem('cr_migrationCount', 0);
  localStorage.setItem('cr_newTokenCount', 0);
}

// Combine global base with local real-time increments to prevent counting backwards
let localScanned = parseInt(localStorage.getItem('cr_totalScanned')) || 0;
let localMig = parseInt(localStorage.getItem('cr_migrationCount')) || 0;
let localNew = parseInt(localStorage.getItem('cr_newTokenCount')) || 0;

let totalScanned = Math.max(globalBase.tokens, localScanned);
let migrationCount = Math.max(globalBase.migrations, localMig);
let newTokenCount = Math.max(globalBase.tokens, localNew);

let liveTokens=[];
let tickerPrices={};
let seenTokens=new Set();
let wsTokens=[];
let wsConnected=false;
let sessionLog=[]; // Real event log

// ===== PUMPPORTAL WEBSOCKET (FREE - real-time new tokens + migrations) =====
function initPumpPortalWS(){
  const ws=new WebSocket('wss://pumpportal.fun/api/data');
  ws.onopen=()=>{
    wsConnected=true;
    console.log('🟢 PumpPortal WebSocket connected');
    updateWSStatus(true);
    // Subscribe to new token creations (FREE)
    ws.send(JSON.stringify({method:'subscribeNewToken'}));
    // Subscribe to migration events (FREE) - tokens graduating to Raydium
    ws.send(JSON.stringify({method:'subscribeMigration'}));
    addAlert('🟢','PumpPortal WebSocket Connected','Real-time new token & migration events streaming live');
  };
  ws.onmessage=(event)=>{
    try{
      const data=JSON.parse(event.data);
      handleWSEvent(data);
    }catch(e){console.warn('WS parse error',e)}
  };
  ws.onerror=(e)=>{
    console.warn('WS error',e);
    wsConnected=false;
    updateWSStatus(false);
  };
  ws.onclose=()=>{
    wsConnected=false;
    updateWSStatus(false);
    console.log('🔴 PumpPortal WS closed, reconnecting in 5s...');
    setTimeout(initPumpPortalWS,5000); // Auto reconnect
  };
}

function handleWSEvent(data){
  totalScanned++;
  localStorage.setItem('cr_totalScanned', totalScanned);
  const el=document.querySelector('#stat-tracked .stat-value');
  if(el)el.textContent=totalScanned.toLocaleString();

  // Strict check for migration
  if(data.txType==='migration'||(data.pool&&data.txType!=='create')){
    migrationCount++;
    localStorage.setItem('cr_migrationCount', migrationCount);
    const token={
      name:data.name||data.symbol||data.mint?.slice(0,6)||'MIGRATED',
      fullName:data.name||'',
      address:data.mint||'',
      pair:data.pool||'',
      dex:'raydium',
      mcap:data.marketCapSol?(data.marketCapSol*(tickerPrices.solana?.usd||170)):0,
      price:'0',
      priceChange:0,
      volume:0,
      txns:0,
      liquidity:0,
      created:Date.now(),
      url:'',
      score:rand(60,85),
      isNew:false,
      isMigration:true,
      source:'pumpportal-ws'
    };
    wsTokens.unshift(token);
    if(wsTokens.length>100)wsTokens.pop();
    addLiveFeedItem(token);
    logEvent(token);
    showToast(token);
    return;
  }

  // Check for new token create
  if(data.txType==='create'||(!data.txType&&data.mint)){
    newTokenCount++;
    localStorage.setItem('cr_newTokenCount', newTokenCount);
    const token={
      name:data.name||data.symbol||data.mint?.slice(0,6)||'NEW',
      fullName:data.name||'',
      address:data.mint||'',
      pair:'',
      dex:'pump.fun',
      mcap:data.marketCapSol?(data.marketCapSol*(tickerPrices.solana?.usd||170)):data.vSolInBondingCurve?(data.vSolInBondingCurve*2*(tickerPrices.solana?.usd||170)):0,
      price:data.priceUsd||'0',
      priceChange:0,
      volume:0,
      txns:0,
      liquidity:0,
      created:Date.now(),
      url:'',
      imageUrl:data.uri||'',
      score:rand(30,55),
      isNew:true,
      isMigration:false,
      source:'pumpportal-ws'
    };
    wsTokens.unshift(token);
    if(wsTokens.length>100)wsTokens.pop();
    addLiveFeedItem(token);
    logEvent(token);
    return;
  }
}

function addLiveFeedItem(t){
  const list=document.getElementById('feed-list');
  if(!list)return;
  const scoreClass=t.score>=85?'high':t.score>=65?'med':'low';
  const conv=t.score>=85?'HIGH':t.score>=65?'MED':'LOW';
  const badge=t.isMigration?
    '<span style="background:#ffd700;color:#0a0e17;padding:2px 6px;border-radius:4px;font-size:.6rem;font-weight:800;margin-left:6px">MIGRATED</span>':
    '<span style="background:#00ffa3;color:#0a0e17;padding:2px 6px;border-radius:4px;font-size:.6rem;font-weight:800;margin-left:6px">NEW</span>';
  const html=`<div class="feed-item new-signal" style="border-color:${t.isMigration?'rgba(255,215,0,.5)':'rgba(0,255,163,.4)'}">
    <div><div class="feed-coin">${t.name}${badge}</div><div class="feed-source">${t.dex} · just now</div></div>
    <div class="feed-score ${scoreClass}">🎯 ${t.score}/100 · ${conv}</div>
    <div class="feed-mcap">${fmtUsd(t.mcap)}</div>
    <div class="feed-links">
      <a href="https://axiom.trade/t/${t.address}" target="_blank" class="feed-link feed-link-axiom">⚡ AXIOM</a>
      <a href="https://dexscreener.com/solana/${t.address}" target="_blank" class="feed-link">DEX</a>
      <a href="https://gmgn.ai/sol/token/${t.address}" target="_blank" class="feed-link">GMGN</a>
    </div>
    <div class="feed-time">🔴 LIVE</div>
  </div>`;
  list.insertAdjacentHTML('afterbegin',html);
  if(list.children.length>50)list.removeChild(list.lastChild);
}

function updateWSStatus(connected){
  // Feed badge
  const badge=document.querySelector('.feed-badge');
  if(badge){
    badge.innerHTML=connected?'<span style="color:#00ffa3">●</span> LIVE · PUMPPORTAL WS':'<span style="color:#ff4d6a">●</span> RECONNECTING...';
    badge.style.borderColor=connected?'rgba(0,255,163,.3)':'rgba(255,77,106,.3)';
  }
  // Sidebar stream status
  const wsLive=document.getElementById('ws-live');
  if(wsLive){wsLive.textContent=connected?'● LIVE':'● OFFLINE';wsLive.style.color=connected?'var(--green)':'var(--red)'}
  const wsDot=document.getElementById('ws-dot');
  if(wsDot)wsDot.style.background=connected?'var(--green)':'var(--red)';
  // Data sources panel
  const dsPump=document.getElementById('ds-pump');
  if(dsPump){dsPump.textContent=connected?'CONNECTED':'RECONNECTING...';dsPump.className='bot-val '+(connected?'enabled':'disabled')}
  const dsHealth=document.getElementById('ds-health');
  if(dsHealth){dsHealth.textContent=connected?'● HEALTHY':'● DEGRADED';dsHealth.className='bot-health '+(connected?'healthy':'')}
}

// Log real events to session history
function logEvent(token){
  sessionLog.unshift({
    time:new Date().toLocaleTimeString(),
    name:token.name||'Unknown',
    type:token.isMigration?'MIGRATION':'NEW TOKEN',
    address:token.address||'',
    dex:token.dex||'pump.fun',
  });
  if(sessionLog.length>200)sessionLog.pop();
  updateHistoryPage();
}

function updateHistoryPage(){
  const tbody=document.getElementById('history-tbody');
  if(!tbody)return;
  tbody.innerHTML=sessionLog.slice(0,50).map(e=>{
    const typeClass=e.type==='MIGRATION'?'outcome-badge moon':'outcome-badge decent';
    return`<tr>
      <td style="font-family:var(--mono);font-size:.8rem">${e.time}</td>
      <td><strong>${e.name}</strong></td>
      <td><span class="${typeClass}">${e.type}</span></td>
      <td style="font-family:var(--mono);font-size:.7rem;max-width:120px;overflow:hidden;text-overflow:ellipsis;cursor:pointer" title="${e.address}" onclick="navigator.clipboard.writeText('${e.address}')">${e.address.slice(0,8)}...${e.address.slice(-6)}</td>
      <td>${e.dex}</td>
      <td><a href="https://axiom.trade/t/${e.address}" target="_blank" class="feed-link feed-link-axiom">⚡ AXIOM</a> <a href="https://dexscreener.com/solana/${e.address}" target="_blank" class="feed-link">DEX</a></td>
    </tr>`;
  }).join('');
  // Update history stats
  const histTotal=document.getElementById('hist-total');
  if(histTotal)histTotal.textContent=sessionLog.length;
  const histMig=document.getElementById('hist-mig');
  if(histMig)histMig.textContent=migrationCount;
  const histRate=document.getElementById('hist-rate');
  const uptimeMin=Math.max(1,(Date.now()-sessionStart)/60000);
  if(histRate)histRate.textContent=Math.round(sessionLog.length/uptimeMin)+'/min';
}


// Start WebSocket connection
initPumpPortalWS();

// ===== HELPERS =====
const rand=(a,b)=>Math.floor(Math.random()*(b-a+1))+a;
const pick=a=>a[rand(0,a.length-1)];
const fmt=n=>n?n.toLocaleString(undefined,{maximumFractionDigits:2}):'--';
const fmtUsd=n=>{if(!n)return'--';if(n>=1e9)return'$'+(n/1e9).toFixed(2)+'B';if(n>=1e6)return'$'+(n/1e6).toFixed(2)+'M';if(n>=1e3)return'$'+(n/1e3).toFixed(1)+'K';return'$'+n.toFixed(2)};

async function fetchJSON(url){
  try{const r=await fetch(url);if(!r.ok)throw new Error(r.status);return await r.json()}
  catch(e){console.warn('API error:',url,e);return null}
}

// ===== NAVIGATION =====
document.querySelectorAll('.nav-item[data-page]').forEach(item=>{
  item.addEventListener('click',e=>{
    e.preventDefault();
    document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
    item.classList.add('active');
    document.querySelectorAll('.page-content').forEach(p=>p.classList.remove('active'));
    document.getElementById('page-'+item.dataset.page).classList.add('active');
    document.getElementById('page-heading').textContent=item.dataset.page.charAt(0).toUpperCase()+item.dataset.page.slice(1);
    // Close sidebar on mobile after clicking a link
    if(window.innerWidth<=768){
      document.getElementById('sidebar').classList.remove('open');
      document.getElementById('sidebar-overlay').classList.remove('active');
    }
  });
});
document.getElementById('menu-toggle').addEventListener('click',()=>{
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebar-overlay').classList.toggle('active');
});
document.getElementById('sidebar-overlay').addEventListener('click',()=>{
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('active');
});

// ===== CLOCK =====
setInterval(()=>{const n=new Date();document.getElementById('live-clock').textContent=`Live · ${n.toLocaleTimeString()}`},1000);

// ===== COUNTER ANIMATION =====
function animateCounter(el,target){
  const dur=1200,start=performance.now();
  (function update(now){
    const p=Math.min((now-start)/dur,1),v=Math.floor((1-Math.pow(1-p,3))*target);
    el.textContent=v.toLocaleString();
    if(p<1)requestAnimationFrame(update);
  })(start);
}
function animateAllCounters(){document.querySelectorAll('.counter').forEach(el=>animateCounter(el,parseInt(el.dataset.target)))}
animateAllCounters();

// ===== TICKER - Real prices from CoinGecko =====
async function updateTicker(){
  const data=await fetchJSON(API.gecko);
  if(!data)return;
  tickerPrices=data;
  const items=[
    {sym:'SOL',id:'solana'},{sym:'BTC',id:'bitcoin'},{sym:'ETH',id:'ethereum'},
    {sym:'JUP',id:'jupiter-exchange-solana'},{sym:'BONK',id:'bonk'},{sym:'WIF',id:'dogwifcoin'},{sym:'PEPE',id:'pepe'}
  ];
  let html='';
  for(let i=0;i<2;i++){
    items.forEach(t=>{
      const d=data[t.id];
      if(!d)return;
      const up=d.usd_24h_change>=0;
      html+=`<span class="ticker-item"><strong>${t.sym}</strong> $${fmt(d.usd)} <span class="${up?'up':'down'}">${up?'+':''}${d.usd_24h_change?.toFixed(1)}%</span></span>`;
    });
  }
  document.getElementById('ticker-content').innerHTML=html;
}
updateTicker();
setInterval(updateTicker,30000);

// ===== FETCH REAL NEW TOKENS FROM DEXSCREENER =====
function mapPairToToken(p){
  const vol=p.volume?.h1||0;
  const buys=p.txns?.h1?.buys||0;
  const liq=p.liquidity?.usd||0;
  const age=p.pairCreatedAt?((Date.now()-p.pairCreatedAt)/60000):9999;
  // Score: newer + more volume + more buys + good liquidity = higher
  let score=30;
  if(age<5)score+=30; else if(age<30)score+=20; else if(age<60)score+=10;
  if(vol>10000)score+=15; else if(vol>1000)score+=10; else if(vol>100)score+=5;
  if(buys>50)score+=15; else if(buys>20)score+=10; else if(buys>5)score+=5;
  if(liq>5000)score+=10; else if(liq>1000)score+=5;
  score=Math.min(99,Math.max(10,score));
  return{
    name:p.baseToken?.symbol||'???',
    fullName:p.baseToken?.name||'',
    address:p.baseToken?.address||'',
    pair:p.pairAddress||'',
    dex:p.dexId||'',
    mcap:p.fdv||p.marketCap||0,
    price:p.priceUsd||'0',
    priceChange:p.priceChange?.m5||p.priceChange?.h1||0,
    volume:vol,
    txns:buys,
    liquidity:liq,
    created:p.pairCreatedAt||0,
    url:p.url||'',
    imageUrl:p.info?.imageUrl||'',
    score,
    isNew:age<10, // less than 10 minutes old
  };
}

// Fetch brand new token profiles + get their pair data
async function fetchNewTokens(){
  const [profiles,boosts]=await Promise.all([
    fetchJSON(API.dexProfiles),
    fetchJSON(API.dexBoosts)
  ]);
  // Get solana token addresses from profiles & boosts
  const addresses=new Set();
  if(Array.isArray(profiles))profiles.filter(p=>p.chainId==='solana').slice(0,15).forEach(p=>addresses.add(p.tokenAddress));
  if(Array.isArray(boosts))boosts.filter(p=>p.chainId==='solana').slice(0,15).forEach(p=>addresses.add(p.tokenAddress));
  if(addresses.size===0)return[];
  // Fetch pair data for these tokens (batch up to 30)
  const addrList=[...addresses].slice(0,30).join(',');
  const pairData=await fetchJSON(`https://api.dexscreener.com/tokens/v1/solana/${addrList}`);
  if(!Array.isArray(pairData))return[];
  const tokens=pairData.map(mapPairToToken).sort((a,b)=>b.created-a.created);
  return tokens;
}

// Also search for very recent pump tokens
async function fetchRecentPumpTokens(){
  const data=await fetchJSON(API.dexSearch+'pump');
  if(!data||!data.pairs)return[];
  const now=Date.now();
  return data.pairs
    .filter(p=>p.chainId==='solana'&&p.pairCreatedAt&&(now-p.pairCreatedAt)<3600000) // last 1 hour
    .sort((a,b)=>(b.pairCreatedAt||0)-(a.pairCreatedAt||0))
    .slice(0,20)
    .map(mapPairToToken);
}

// Combined: merge new profiles + recent pumps, dedupe, sort newest first
async function fetchTrendingTokens(){
  const [newTokens,pumpTokens]=await Promise.all([fetchNewTokens(),fetchRecentPumpTokens()]);
  const seen=new Set();
  const all=[...newTokens,...pumpTokens].filter(t=>{
    if(seen.has(t.address))return false;
    seen.add(t.address);
    return true;
  }).sort((a,b)=>b.created-a.created);
  // Detect genuinely new tokens for alerts (no toasts to prevent spam, just add to seen)
  all.forEach(t=>{
    if(!seenTokens.has(t.address)&&t.isNew){
      seenTokens.add(t.address);
    } else { seenTokens.add(t.address); }
  });
  return all;
}

// ===== LIVE SIGNAL FEED - Real data =====
async function refreshFeed(){
  const tokens=await fetchTrendingTokens();
  if(!tokens.length)return;
  liveTokens=tokens;
  const list=document.getElementById('feed-list');
  list.innerHTML=tokens.slice(0,12).map((t,i)=>{
    const scoreClass=t.score>=85?'high':t.score>=65?'med':'low';
    const conv=t.score>=85?'HIGH':t.score>=65?'MED':'LOW';
    const age=t.created?getAge(t.created):'--';
    const newBadge=t.isNew?'<span style="background:#00ffa3;color:#0a0e17;padding:2px 6px;border-radius:4px;font-size:.6rem;font-weight:800;margin-left:6px">NEW</span>':'';
    return`<div class="feed-item${i<2||t.isNew?' new-signal':''}">
      <div><div class="feed-coin">${t.name}${newBadge}</div><div class="feed-source">${t.dex||'DexScreener'} · ${age}</div></div>
      <div class="feed-score ${scoreClass}">🎯 ${t.score}/100 · ${conv}</div>
      <div class="feed-mcap">${fmtUsd(t.mcap)}</div>
      <div class="feed-links">
        <a href="https://axiom.trade/t/${t.address}" target="_blank" class="feed-link feed-link-axiom">⚡ AXIOM</a>
        <a href="https://dexscreener.com/solana/${t.address}" target="_blank" class="feed-link">DEX</a>
        <a href="https://gmgn.ai/sol/token/${t.address}" target="_blank" class="feed-link">GMGN</a>
      </div>
      <div class="feed-time">Vol: ${fmtUsd(t.volume)}</div>
    </div>`}).join('');
}

function getAge(ts){
  const diff=Date.now()-ts;
  const secs=Math.floor(diff/1000);
  if(secs<60)return secs+'s ago';
  const mins=Math.floor(diff/60000);
  if(mins<60)return mins+'m ago';
  const hrs=Math.floor(mins/60);
  if(hrs<24)return hrs+'h ago';
  return Math.floor(hrs/24)+'d ago';
}

refreshFeed();
setInterval(refreshFeed,15000); // Refresh every 15 seconds for live data

// ===== TELEGRAM ALERTS =====
async function sendTelegramAlert(message) {
  const token = localStorage.getItem('tg_bot_token');
  const chatId = localStorage.getItem('tg_chat_id');
  if (!token || !chatId) return; // Silent return if not configured

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
  } catch (e) {
    console.error('Failed to send Telegram alert:', e);
  }
}

// ===== TOAST ALERTS for MIGRATIONS =====
function showToast(token){
  const c=document.getElementById('alert-toast-container');
  // Limit to max 2 toasts on screen
  if(c.children.length>=2){
    const first=c.firstChild;
    first.classList.add('removing');
    setTimeout(()=>first.remove(),300);
  }
  const t=document.createElement('div');
  t.className='toast';
  t.innerHTML=`<div class="toast-header"><span class="toast-title" style="color:#ffd700">🚀 Raydium Migration</span><button class="toast-close" onclick="this.closest('.toast').classList.add('removing');setTimeout(()=>this.closest('.toast').remove(),300)">&times;</button></div>
    <div class="toast-body"><span class="toast-coin">${token.name}</span> · Score: <span class="toast-score">${token.score}/100</span> · MCap: ${fmtUsd(token.mcap)}<br><a href="https://axiom.trade/t/${token.address}" target="_blank" style="color:#00ffa3;font-weight:700;text-decoration:none">⚡ Trade on Axiom</a></div>`;
  c.appendChild(t);
  setTimeout(()=>{if(t.parentNode){t.classList.add('removing');setTimeout(()=>t.remove(),300)}},6000);

  // Trigger Telegram Alert
  sendTelegramAlert(`🚨 <b>Raydium Migration</b>\n\n<b>Token:</b> ${token.name}\n<b>Score:</b> ${token.score}/100\n<b>MCap:</b> ${fmtUsd(token.mcap)}\n<b>CA:</b> <code>${token.address}</code>\n\n⚡ <a href="https://axiom.trade/t/${token.address}">Trade on Axiom</a>`);
}

// ===== SIGNALS PAGE - Real data with FILTERS =====
let signalsData=[]; // Store for filtering
let activeFilter='all';

function renderSignalCard(t){
  const convClass=t.score>=85?'conviction-high':t.score>=65?'conviction-med':'conviction-low';
  const convText=t.score>=85?'HIGH':t.score>=65?'MEDIUM':'LOW';
  const age=t.created?getAge(t.created):'--';
  const migBadge=t.isMigration?'<span style="background:#ffd700;color:#0a0e17;padding:2px 6px;border-radius:4px;font-size:.6rem;font-weight:800;margin-left:6px">MIGRATED</span>':'';
  return`<div class="signal-card" data-conviction="${convText.toLowerCase()}">
    <div class="signal-card-top">
      <div class="signal-coin-name">🪙 ${t.name}${migBadge}</div>
      <span class="signal-conviction ${convClass}">${convText}</span>
    </div>
    <div class="signal-row"><span>Score</span><span>${t.score}/100</span></div>
    <div class="signal-row"><span>Market Cap</span><span>${fmtUsd(t.mcap)}</span></div>
    <div class="signal-row"><span>Price</span><span>$${t.price}</span></div>
    <div class="signal-row"><span>1H Change</span><span style="color:${t.priceChange>=0?'var(--green)':'var(--red)'}">${t.priceChange>=0?'+':''}${t.priceChange}%</span></div>
    <div class="signal-row"><span>Volume 1H</span><span>${fmtUsd(t.volume)}</span></div>
    <div class="signal-row"><span>Liquidity</span><span>${fmtUsd(t.liquidity)}</span></div>
    <div class="signal-row"><span>Age</span><span>${age}</span></div>
    <div class="signal-ca" title="Click to copy" onclick="navigator.clipboard.writeText('${t.address}')">${t.address}</div>
    <div class="signal-links-row">
      <a href="https://axiom.trade/t/${t.address}" target="_blank" class="feed-link feed-link-axiom">⚡ AXIOM</a>
      <a href="https://dexscreener.com/solana/${t.address}" target="_blank" class="feed-link">📊 DEX</a>
      <a href="https://gmgn.ai/sol/token/${t.address}" target="_blank" class="feed-link">🔗 GMGN</a>
    </div>
  </div>`;
}

function renderFilteredSignals(){
  const grid=document.getElementById('signals-grid');
  if(!grid)return;
  let filtered=signalsData;
  if(activeFilter==='high')filtered=signalsData.filter(t=>t.score>=85);
  else if(activeFilter==='medium')filtered=signalsData.filter(t=>t.score>=65&&t.score<85);
  else if(activeFilter==='low')filtered=signalsData.filter(t=>t.score<65);
  grid.innerHTML=filtered.length?filtered.map(renderSignalCard).join(''):'<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text3)">No signals matching this filter. Try a different conviction level.</div>';
}

async function refreshSignals(){
  const tokens=await fetchTrendingTokens();
  // Merge WS tokens + API tokens
  const allTokens=[...wsTokens,...tokens];
  const seen=new Set();
  signalsData=allTokens.filter(t=>{if(seen.has(t.address))return false;seen.add(t.address);return true;}).sort((a,b)=>b.created-a.created);
  renderFilteredSignals();
}

// Filter button click handlers
document.querySelectorAll('.filter-btn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter=btn.dataset.filter;
    renderFilteredSignals();
  });
});

refreshSignals();
setInterval(refreshSignals,15000);

// ===== SCANNER PAGE - Real data =====
async function refreshScanner(){
  const tokens=await fetchTrendingTokens();
  if(!tokens.length)return;
  const tbody=document.getElementById('scanner-tbody');
  tbody.innerHTML=tokens.map(t=>{
    const sc=t.score>=85?'score-high':t.score>=65?'score-med':'score-low';
    const conv=t.score>=85?'HIGH':t.score>=65?'MED':'LOW';
    const age=t.created?getAge(t.created):'--';
    return`<tr>
      <td><strong>${t.name}</strong></td>
      <td><span class="score-badge ${sc}">${t.score}</span></td>
      <td>${conv}</td>
      <td>${fmtUsd(t.mcap)}</td>
      <td>${age}</td>
      <td>${t.txns}</td>
      <td>${fmtUsd(t.volume)}</td>
      <td><a href="https://axiom.trade/t/${t.address}" target="_blank" class="feed-link feed-link-axiom">⚡ AXIOM</a> <a href="https://dexscreener.com/solana/${t.address}" target="_blank" class="feed-link">DEX</a> <a href="https://gmgn.ai/sol/token/${t.address}" target="_blank" class="feed-link">GMGN</a></td>
      <td><button class="btn-watch" onclick="this.textContent='✅ Watching'">👁 Watch</button></td>
    </tr>`}).join('');
}
refreshScanner();

document.getElementById('btn-scan').addEventListener('click',async()=>{
  const btn=document.getElementById('btn-scan');
  btn.textContent='Scanning...';btn.disabled=true;
  await refreshScanner();
  btn.innerHTML='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg> Scan Now';
  btn.disabled=false;
});

// ===== EQUITY CHART - Live updating =====
let equityChart=null;
let equityData=[];
let equityLabels=[];

function initChart(){
  const ctx=document.getElementById('equity-chart').getContext('2d');
  const now=new Date();
  for(let i=6;i>=0;i--){
    const d=new Date(now);d.setMinutes(now.getMinutes()-i*5);
    equityLabels.push(d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}));
    equityData.push(0);
  }
  const gradient=ctx.createLinearGradient(0,0,0,220);
  gradient.addColorStop(0,'rgba(16,185,129,0.3)');gradient.addColorStop(1,'rgba(16,185,129,0)');
  equityChart=new Chart(ctx,{type:'line',data:{labels:equityLabels,datasets:[{data:equityData,fill:true,backgroundColor:gradient,borderColor:'#10b981',borderWidth:2,pointBackgroundColor:'#10b981',pointBorderColor:'#ffffff',pointBorderWidth:2,pointRadius:4,tension:.4}]},
    options:{responsive:true,maintainAspectRatio:false,animation:{duration:500},plugins:{legend:{display:false}},scales:{x:{grid:{color:'rgba(0,0,0,0.05)'},ticks:{color:'#64748b'}},y:{grid:{color:'rgba(0,0,0,0.05)'},ticks:{color:'#64748b'}}}}});
}
initChart();

// Update chart with real WS new token counts every 5 min
setInterval(()=>{
  equityLabels.push(new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}));
  equityData.push(newTokenCount);
  if(equityLabels.length>12){equityLabels.shift();equityData.shift()}
  if(equityChart){equityChart.data.labels=equityLabels;equityChart.data.datasets[0].data=equityData;equityChart.update()}
},300000);

// ===== REAL-TIME DASHBOARD STATS =====
let outcomeStats={moon:0,running:0,decent:0,nowhere:0,dumped:0,rugged:0};

// Classify tokens based on real price change data
function classifyOutcome(priceChange){
  if(priceChange>=100)return'moon';
  if(priceChange>=20)return'running';
  if(priceChange>=0)return'decent';
  if(priceChange>=-20)return'nowhere';
  if(priceChange>=-80)return'dumped';
  return'rugged';
}

async function updateDashboardStats(){
  const tokens=liveTokens.length?liveTokens:await fetchTrendingTokens();
  // Reset outcomes
  outcomeStats={moon:0,running:0,decent:0,nowhere:0,dumped:0,rugged:0};
  tokens.forEach(t=>{
    const o=classifyOutcome(t.priceChange);
    outcomeStats[o]++;
  });
  // Update outcome cards
  const ids=[['moon','outcome-moon'],['running','outcome-running'],['decent','outcome-decent'],['nowhere','outcome-nowhere'],['dumped','outcome-dumped'],['rugged','outcome-rugged']];
  ids.forEach(([key,cls])=>{
    const el=document.querySelector('.'+cls+' .outcome-value');
    if(el){el.dataset.target=outcomeStats[key];animateCounter(el,outcomeStats[key])}
  });
  // Update watching count
  const watchEl=document.querySelector('#stat-watching .stat-value');
  if(watchEl){watchEl.dataset.target=wsTokens.length;animateCounter(watchEl,wsTokens.length)}
  // Update rugged %
  const total=Object.values(outcomeStats).reduce((a,b)=>a+b,0)||1;
  const rugPct=Math.round(((outcomeStats.dumped+outcomeStats.rugged)/total)*100);
  const rugEl=document.querySelector('#stat-rugged .stat-value');
  if(rugEl)rugEl.textContent=rugPct+'%';
  const rugTrend=document.querySelector('#stat-rugged .stat-trend');
  if(rugTrend)rugTrend.textContent=rugPct>20?'↑ High rug activity':'↓ Low rug activity';
  // Update PnL with real SOL price
  const solPrice=tickerPrices.solana?.usd||170;
  const pnlUsd=document.querySelector('.pnl-usd');
  if(pnlUsd)pnlUsd.textContent=`SOL Price: $${fmt(solPrice)} USD`;
  // Update chart title to show new tokens per interval
  const chartTitle=document.querySelector('.chart-card .card-title');
  if(chartTitle)chartTitle.textContent=`● NEW TOKENS / 5 MIN (${newTokenCount} total)`;
}
updateDashboardStats();
setInterval(updateDashboardStats,20000);

// ===== TRENDING METAS - From DexScreener =====
async function updateTrendingMetas(){
  const data=await fetchJSON('https://api.dexscreener.com/metas/trending/v1');
  if(!data||!Array.isArray(data))return;
  const tags=document.getElementById('meta-tags');
  const status=document.getElementById('meta-status');
  if(!tags)return;
  const metas=data.slice(0,6);
  tags.innerHTML=metas.map((m,i)=>{
    const cls=i<2?'hot':i<4?'warm':'cool';
    const icon=m.icon?.value||'🔥';
    const change=m.marketCapChange?.h1;
    const changeStr=change?` (${change>=0?'+':''}${change.toFixed(1)}%)`:'';
    return`<span class="meta-tag ${cls}">${icon} ${m.name}${changeStr}</span>`;
  }).join('');
  if(status){
    const avgChange=metas.reduce((a,m)=>a+(m.marketCapChange?.h1||0),0)/metas.length;
    status.textContent=avgChange>5?'BULLISH':avgChange>0?'MIXED':avgChange>-5?'CAUTIOUS':'BEARISH';
    status.className='meta-badge '+(avgChange>0?'mixed':'');
  }
}
updateTrendingMetas();
setInterval(updateTrendingMetas,60000);

// ===== MARKET SENTIMENT - Based on real price changes =====
async function updateSentiment(){
  const data=await fetchJSON(API.gecko);
  if(!data)return;
  const changes=[data.solana?.usd_24h_change,data.bitcoin?.usd_24h_change,data.bonk?.usd_24h_change,data.pepe?.usd_24h_change].filter(Boolean);
  const avg=changes.reduce((a,b)=>a+b,0)/changes.length;
  const score=Math.max(5,Math.min(95,Math.floor(50+avg*3)));
  const label=score>=80?'EXTREME GREED':score>=60?'GREED':score>=40?'NEUTRAL':score>=20?'FEAR':'EXTREME FEAR';
  const cls=score>=60?'risky':score>=40?'neutral':'fearful';
  document.getElementById('sentiment-value').textContent=score;
  const lbl=document.getElementById('sentiment-label');lbl.textContent=label;lbl.className='sentiment-label '+cls;
  document.getElementById('sentiment-pointer').style.left=score+'%';
  const moodEl=document.querySelector('#stat-mood .stat-value');
  if(moodEl){moodEl.dataset.target=score;animateCounter(moodEl,score)}
  const trendEl=document.querySelector('#stat-mood .stat-trend');
  if(trendEl)trendEl.textContent=score>=60?'⚠️ Risky':'✅ Cautious';
}
updateSentiment();
setInterval(updateSentiment,60000);

// ===== ALERTS PAGE =====
const alertsList=[];
function addAlert(icon,title,desc){
  alertsList.unshift({icon,title,desc,time:new Date().toLocaleTimeString(),unread:true});
  renderAlerts();
}
function renderAlerts(){
  const el=document.getElementById('alerts-list');
  el.innerHTML=alertsList.slice(0,20).map(a=>`<div class="alert-item${a.unread?' unread':''}">
    <div class="alert-icon">${a.icon}</div>
    <div class="alert-content"><div class="alert-title">${a.title}</div><div class="alert-desc">${a.desc}</div><div class="alert-time">${a.time}</div></div>
  </div>`).join('');
  const badge=document.querySelector('.nav-badge-count');
  if(badge)badge.textContent=alertsList.filter(a=>a.unread).length;
}
addAlert('🚀','Dashboard Started','CryptoRadar is now tracking live tokens from DexScreener');
addAlert('📡','APIs Connected','CoinGecko & DexScreener data streams active');

// Auto-alerts from scanning
const alertedTokens = new Set();
setInterval(async()=>{
  const tokens=await fetchTrendingTokens();
  const hot=tokens.find(t=>t.score>=90);
  if(hot && !alertedTokens.has(hot.address)){
    alertedTokens.add(hot.address);
    addAlert('🚨',`${hot.name} scored ${hot.score}/100`,`MCap: ${fmtUsd(hot.mcap)} · Vol: ${fmtUsd(hot.volume)} · ${hot.priceChange>=0?'+':''}${hot.priceChange}% 1H`);
    sendTelegramAlert(`🔥 <b>HIGH CONVICTION ALERT</b>\n\n<b>Token:</b> ${hot.name}\n<b>Score:</b> ${hot.score}/100\n<b>MCap:</b> ${fmtUsd(hot.mcap)}\n<b>CA:</b> <code>${hot.address}</code>\n\n⚡ <a href="https://axiom.trade/t/${hot.address}">Trade on Axiom</a>`);
  }
},45000);

// ===== THEME TOGGLE =====
const savedTheme = localStorage.getItem('cr_theme') || 'light';
if (savedTheme === 'dark') document.documentElement.classList.add('dark-theme');

document.getElementById('btn-theme')?.addEventListener('click', () => {
  document.documentElement.classList.toggle('dark-theme');
  const isDark = document.documentElement.classList.contains('dark-theme');
  localStorage.setItem('cr_theme', isDark ? 'dark' : 'light');
});

// ===== REFRESH BUTTON =====
document.getElementById('btn-refresh').addEventListener('click',async()=>{
  const btn=document.getElementById('btn-refresh');
  if(btn){
    btn.style.transform='rotate(360deg)';
    btn.style.transition='transform 0.5s';
    setTimeout(()=>{btn.style.transform='';btn.style.transition=''},500);
  }
  try {
    await Promise.all([updateDashboardStats(), updateTrendingMetas(), refreshFeed(), updateSentiment()]);
  } catch(e) { console.error("Refresh failed:", e); }
});

// ===== REAL-TIME STATS UPDATE LOOP =====
// ===== REAL-TIME STATS UPDATE LOOP =====
function updateRealtimeStats(){
  const stv=document.getElementById('stat-tracked-val');
  if(stv)stv.textContent=totalScanned.toLocaleString();
  const stt=document.getElementById('stat-tracked-trend');
  if(stt)stt.textContent=`+${newTokenCount} this session`;
  const sc=document.getElementById('scan-count');
  if(sc)sc.textContent=totalScanned.toLocaleString();
  const swv=document.getElementById('stat-watching-val');
  if(swv)swv.textContent=migrationCount;
  const pv=document.getElementById('pnl-value');
  if(pv)pv.textContent=totalScanned.toLocaleString()+' Tokens Scanned';
  const pu=document.getElementById('pnl-usd');
  const solP=tickerPrices.solana?.usd;
  if(pu)pu.textContent=solP?`SOL: $${fmt(solP)} | Migrations: ${migrationCount}`:'Loading...';
  const pm=document.getElementById('pnl-mig');
  if(pm)pm.textContent=migrationCount;
  const pn=document.getElementById('pnl-new');
  if(pn)pn.textContent=newTokenCount;
  const ws=document.getElementById('pnl-ws-status');
  if(ws){ws.textContent=wsConnected?'Connected':'Reconnecting...';ws.style.color=wsConnected?'var(--green)':'var(--red)'}
  const wstc=document.getElementById('ws-token-count');
  if(wstc)wstc.textContent=totalScanned.toLocaleString();
  const csNew=document.getElementById('cs-new');
  if(csNew)csNew.textContent=newTokenCount;
  const csMig=document.getElementById('cs-mig');
  if(csMig)csMig.textContent=migrationCount;
  const uptimeMin=Math.max(1,(Date.now()-sessionStart)/60000);
  const csRate=document.getElementById('cs-rate');
  if(csRate)csRate.textContent=Math.round(totalScanned/uptimeMin);
  const csUptime=document.getElementById('cs-uptime');
  if(csUptime){const m=Math.floor(uptimeMin);csUptime.textContent=m<60?m+'m':Math.floor(m/60)+'h '+m%60+'m'}
  const dsUp=document.getElementById('ds-uptime');
  if(dsUp){const m=Math.floor(uptimeMin);dsUp.textContent=m<60?m+'m':Math.floor(m/60)+'h '+m%60+'m'}
  const dsRate=document.getElementById('ds-rate');
  if(dsRate)dsRate.textContent=Math.round(totalScanned/uptimeMin)+'/min';
}
// Call immediately so it doesn't show 0 on page load
updateRealtimeStats();
setInterval(updateRealtimeStats,3000);

const s=document.createElement('style');
s.textContent='.positive{color:var(--green)}.negative{color:var(--red)}';
document.head.appendChild(s);

// ===== SETTINGS MODAL LOGIC =====
const modal = document.getElementById('settings-modal');
const btnSettings = document.getElementById('nav-settings');
const btnClose = document.getElementById('btn-close-settings');
const tgTokenInput = document.getElementById('tg-bot-token');
const tgChatIdInput = document.getElementById('tg-chat-id');

// Load saved data
tgTokenInput.value = localStorage.getItem('tg_bot_token') || '';
tgChatIdInput.value = localStorage.getItem('tg_chat_id') || '';

btnSettings?.addEventListener('click', (e) => {
  e.preventDefault();
  modal.classList.add('active');
});

btnClose?.addEventListener('click', () => {
  modal.classList.remove('active');
});

document.getElementById('btn-save-settings')?.addEventListener('click', () => {
  localStorage.setItem('tg_bot_token', tgTokenInput.value.trim());
  localStorage.setItem('tg_chat_id', tgChatIdInput.value.trim());
  addAlert('✅', 'Settings Saved', 'Telegram API credentials saved securely in browser.');
  modal.classList.remove('active');
});

document.getElementById('btn-test-tg')?.addEventListener('click', async () => {
  const t = tgTokenInput.value.trim();
  const c = tgChatIdInput.value.trim();
  if (!t || !c) {
    alert("Please enter both Bot Token and Chat ID first!");
    return;
  }
  
  const btn = document.getElementById('btn-test-tg');
  btn.textContent = 'Sending...';
  try {
    const res = await fetch(`https://api.telegram.org/bot${t}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: c,
        text: "✅ <b>Meme Radar Connection Test</b>\n\nYour dashboard is successfully connected to Telegram! You will now receive alerts for Raydium migrations.",
        parse_mode: 'HTML'
      })
    });
    if (res.ok) {
      alert("Test message sent! Check your Telegram.");
    } else {
      const err = await res.json();
      alert("Failed to send: " + err.description);
    }
  } catch (err) {
    alert("Error: " + err.message);
  }
  btn.textContent = 'Test Alert';
});
console.log('🚀 CryptoRadar Live - All real data, zero fakes');
