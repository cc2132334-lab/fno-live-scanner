const express=require("express");
const cors=require("cors");
const {SmartAPI,WebSocketV2}=require("smartapi-javascript");
const {generate}=require("otplib");

const app=express(),PORT=process.env.PORT||10000;
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

let smartApi=null,sessionData=null,webSocket=null,websocketReady=false;
let fnoCashUniverse=[],cashByToken=new Map(),futureTokenToCash=new Map(),futureSymbolToCash=new Map();
let priceData={},oiGainers=[],oiLosers=[],oiRefreshTimer=null;
const clients=new Set();

const indexState={nifty:false,sensex:false};
const indexData={
  nifty:{name:"NIFTY 50",exchangeType:1,token:"99926000",price:null,close:null,change:null,changePercent:null,timestamp:null},
  sensex:{name:"SENSEX",exchangeType:3,token:"99919000",price:null,close:null,change:null,changePercent:null,timestamp:null}
};

let activityLogs=[];

function addLog(message,type="INFO"){
  const log={time:new Date().toISOString(),type,message};
  activityLogs.push(log);
  if(activityLogs.length>300)activityLogs=activityLogs.slice(-300);
  console.log(`[${type}] ${message}`);
  broadcast("activity",log);
}

function broadcast(event,data){
  const packet=`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for(const c of clients){try{c.write(packet)}catch(e){clients.delete(c)}}
}

function normalizeTotpSecret(input){
  if(!input)return "";
  let s=String(input).trim();
  if(s.toLowerCase().startsWith("otpauth://")){
    try{const u=new URL(s),v=u.searchParams.get("secret");if(v)s=v}catch(e){}
  }
  const m=s.match(/(?:^|[?&\s])secret=([A-Za-z0-9=]+)/i);
  if(m&&m[1])s=m[1];
  return s.replace(/\s+/g,"").replace(/-/g,"").toUpperCase();
}

function cleanSymbol(v){
  return String(v||"").replace(/-EQ$/i,"").trim().toUpperCase();
}

async function buildUniverse(){
  addLog("Downloading Angel One instrument master...");
  const r=await fetch("https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json");
  if(!r.ok)throw new Error("Instrument master download failed.");
  const master=await r.json();
  if(!Array.isArray(master))throw new Error("Invalid instrument master.");

  const fnoNames=new Set(),futures=[];
  for(const x of master){
    if(x.exch_seg==="NFO"&&x.instrumenttype==="FUTSTK"&&x.name&&x.token){
      const name=cleanSymbol(x.name);
      if(name){
        fnoNames.add(name);
        futures.push({token:String(x.token),tradingSymbol:String(x.symbol||x.tradingsymbol||"").toUpperCase(),name});
      }
    }
  }

  const cashMap=new Map();
  for(const x of master){
    if(x.exch_seg==="NSE"&&x.symbol&&x.symbol.endsWith("-EQ")&&x.token){
      const symbol=cleanSymbol(x.symbol);
      if(fnoNames.has(symbol))cashMap.set(symbol,{symbol,token:String(x.token),tradingSymbol:x.symbol,exchangeType:1});
    }
  }

  fnoCashUniverse=Array.from(cashMap.values());
  cashByToken=new Map(fnoCashUniverse.map(x=>[x.token,x]));
  futureTokenToCash=new Map();
  futureSymbolToCash=new Map();

  for(const f of futures){
    if(cashMap.has(f.name)){
      futureTokenToCash.set(f.token,f.name);
      if(f.tradingSymbol)futureSymbolToCash.set(f.tradingSymbol,f.name);
    }
  }

  addLog(`F&O cash universe ready: ${fnoCashUniverse.length} stocks.`,"SUCCESS");
}

function getCashSymbolFromOI(x){
  const token=String(x?.symbolToken||x?.token||"");
  if(token&&futureTokenToCash.has(token))return futureTokenToCash.get(token);

  const ts=String(x?.tradingSymbol||x?.symbol||"").toUpperCase();
  if(ts&&futureSymbolToCash.has(ts))return futureSymbolToCash.get(ts);

  for(const s of Array.from(cashByToken.values()).map(x=>x.symbol).sort((a,b)=>b.length-a.length)){
    if(ts.startsWith(s)&&ts.endsWith("FUT"))return s;
  }
  return "";
}

app.post("/api/login",async(req,res)=>{
  try{
    const {apiKey,clientId,mpin,totpSecret}=req.body;
    if(!apiKey||!clientId||!mpin||!totpSecret)return res.status(400).json({success:false,message:"API Key, Client ID, MPIN aur Long TOTP Secret required hai."});

    addLog(`Login started for ${String(clientId).trim()}.`);
    const secret=normalizeTotpSecret(totpSecret);
    if(!secret)throw new Error("TOTP Secret empty hai.");

    addLog(`Long TOTP Secret received (${secret.length} characters).`);
    const currentTotp=await generate({secret});
    addLog("Current TOTP generated successfully.","SUCCESS");

    smartApi=new SmartAPI({api_key:String(apiKey).trim()});
    const login=await smartApi.generateSession(String(clientId).trim(),String(mpin).trim(),currentTotp);
    if(!login?.status||!login?.data)throw new Error(login?.message||login?.errorcode||"Angel One login failed.");

    sessionData=login.data;
    let feedToken=sessionData.feedToken;
    if(!feedToken){try{feedToken=await Promise.resolve(smartApi.getfeedToken())}catch(e){}}
    sessionData.feedToken=feedToken;

    addLog("Angel One broker login successful.","SUCCESS");
    await buildUniverse();
    await startWebSocket({jwtToken:sessionData.jwtToken,feedToken,apiKey:String(apiKey).trim(),clientId:String(clientId).trim()});
    await refreshOI();

    if(oiRefreshTimer)clearInterval(oiRefreshTimer);
    oiRefreshTimer=setInterval(()=>refreshOI().catch(e=>addLog(`OI refresh error: ${e.message}`,"ERROR")),5000);

    broadcast("login",{connected:true});
    res.json({success:true,stocks:fnoCashUniverse.length,websocket:websocketReady});
  }catch(e){
    addLog(`Login failed: ${e.message}`,"ERROR");
    res.status(401).json({success:false,message:e.message||"Login failed."});
  }
});

async function startWebSocket(c){
  if(!c.jwtToken||!c.feedToken)throw new Error("JWT token ya Feed Token missing hai.");
  if(webSocket){try{webSocket.close()}catch(e){}}

  addLog("Starting SmartAPI WebSocket V2...");
  webSocket=new WebSocketV2({jwttoken:c.jwtToken,apikey:c.apiKey,clientcode:c.clientId,feedtype:c.feedToken});

  return new Promise((resolve,reject)=>{
    webSocket.connect().then(()=>{
      websocketReady=true;
      addLog("SmartAPI WebSocket connected.","SUCCESS");
      webSocket.on("tick",handleTick);
      webSocket.on("error",e=>{websocketReady=false;addLog(`WebSocket error: ${e?.message||e}`,"ERROR");broadcast("status",getStatus())});
      webSocket.on("close",()=>{websocketReady=false;addLog("WebSocket closed.","WARN");broadcast("status",getStatus())});
      subscribeCashStocks();
      resolve();
    }).catch(e=>{websocketReady=false;reject(e)});
  });
}

function subscribeCashStocks(){
  if(!webSocket||!websocketReady)return;
  const tokens=fnoCashUniverse.map(x=>x.token);
  for(let i=0;i<tokens.length;i+=100){
    webSocket.fetchData({correlationID:`cash-${i}`,action:1,mode:2,exchangeType:1,tokens:tokens.slice(i,i+100)});
  }
  addLog(`Subscribed ${tokens.length} F&O cash stocks for live ticks.`,"SUCCESS");
}

app.post("/api/index-toggle",(req,res)=>{
  try{
    const {index,enabled}=req.body;
    if(index!=="nifty"&&index!=="sensex")return res.status(400).json({success:false,message:"Invalid index."});
    if(!webSocket||!websocketReady)throw new Error("Live WebSocket is not connected.");

    const x=indexData[index];
    webSocket.fetchData({correlationID:`${index}-toggle`,action:enabled?1:0,mode:1,exchangeType:x.exchangeType,tokens:[x.token]});
    indexState[index]=!!enabled;
    addLog(`${x.name} tick-by-tick ${enabled?"ON":"OFF"}`,enabled?"SUCCESS":"INFO");
    broadcast("indexState",indexState);
    res.json({success:true,indexState});
  }catch(e){
    addLog(`Index toggle failed: ${e.message}`,"ERROR");
    res.status(500).json({success:false,message:e.message});
  }
});

function handleTick(tick){
  try{
    if(!tick)return;
    const token=String(tick.token||tick.symbolToken||tick.symboltoken||"");
    if(!token)return;

    if(token===indexData.nifty.token)return updateIndex("nifty",tick);
    if(token===indexData.sensex.token)return updateIndex("sensex",tick);

    const stock=cashByToken.get(token);
    if(!stock)return;

    const d=parseTick(tick);
    if(d.price===null)return;

    priceData[stock.symbol]={symbol:stock.symbol,price:d.price,close:d.close,change:d.change,changePercent:d.changePercent,timestamp:Date.now()};

    updateCachedOIRow(stock.symbol,d);
    broadcast("stockTick",priceData[stock.symbol]);
  }catch(e){addLog(`Tick error: ${e.message}`,"ERROR")}
}

function parseTick(tick){
  let price=Number(tick.last_traded_price??tick.lastTradedPrice??tick.ltp??0);
  let close=Number(tick.close??tick.closePrice??tick.previous_close??tick.previousClose??0);
  if(price>0)price/=100;
  if(close>0)close/=100;

  let change=null,changePercent=null;
  if(price>0&&close>0){change=price-close;changePercent=change/close*100}
  return {price:price>0?price:null,close:close>0?close:null,change,changePercent};
}

function updateIndex(name,tick){
  const d=parseTick(tick);
  if(d.price===null)return;
  const x=indexData[name];
  x.price=d.price;x.close=d.close;x.change=d.change;x.changePercent=d.changePercent;x.timestamp=Date.now();
  broadcast("indexTick",{index:name,data:x});
}

function updateCachedOIRow(symbol,d){
  for(const list of [oiGainers,oiLosers]){
    const row=list.find(x=>x.symbol===symbol);
    if(row){
      row.price=d.price;
      row.change=d.change;
      row.changePercent=d.changePercent;
      row.timestamp=Date.now();
    }
  }
  broadcast("oiPrice",{symbol,price:d.price,change:d.change,changePercent:d.changePercent,timestamp:Date.now()});
}

async function refreshOI(){
  if(!smartApi)return;

  const [g,l]=await Promise.allSettled([
    smartApi.gainersLosers({datatype:"PercOIGainers",expirytype:"NEAR"}),
    smartApi.gainersLosers({datatype:"PercOILosers",expirytype:"NEAR"})
  ]);

  if(g.status==="fulfilled"&&g.value?.status&&Array.isArray(g.value.data)){
    const fresh=convertOI(g.value.data).sort((a,b)=>b.oiPercent-a.oiPercent).slice(0,10);
    if(fresh.length)oiGainers=fresh;
  }

  if(l.status==="fulfilled"&&l.value?.status&&Array.isArray(l.value.data)){
    const fresh=convertOI(l.value.data).sort((a,b)=>a.oiPercent-b.oiPercent).slice(0,10);
    if(fresh.length)oiLosers=fresh;
  }

  broadcast("oi",{gainers:oiGainers,losers:oiLosers,timestamp:Date.now()});
  addLog(`OI synced: Gainers ${oiGainers.length}
