const express=require("express");
const cors=require("cors");
const {SmartAPI,WebSocketV2}=require("smartapi-javascript");
const {generate}=require("otplib");

const app=express();
const PORT=process.env.PORT||10000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

let smartApi=null,sessionData=null,webSocket=null;
let websocketReady=false;
let fnoCashUniverse=[];
let cashByToken=new Map();
let futureTokenToCash=new Map();
let futureSymbolToCash=new Map();
let priceData={};
let oiGainers=[];
let oiLosers=[];
let oiRefreshTimer=null;
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
  if(activityLogs.length>300) activityLogs=activityLogs.slice(-300);
  console.log(`[${type}] ${message}`);
  broadcast("activity",log);
}

function broadcast(event,data){
  const packet=`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for(const client of clients){
    try{client.write(packet)}catch(e){clients.delete(client)}
  }
}

function normalizeTotpSecret(input){
  if(!input)return "";
  let secret=String(input).trim();
  if(secret.toLowerCase().startsWith("otpauth://")){
    try{
      const url=new URL(secret);
      const value=url.searchParams.get("secret");
      if(value)secret=value;
    }catch(e){}
  }
  const match=secret.match(/(?:^|[?&\s])secret=([A-Za-z0-9=]+)/i);
  if(match&&match[1])secret=match[1];
  return secret.replace(/\s+/g,"").replace(/-/g,"").toUpperCase();
}

function cleanSymbol(value){
  return String(value||"").replace(/-EQ$/i,"").trim().toUpperCase();
}

async function buildUniverse(){
  addLog("Downloading Angel One instrument master...");
  const response=await fetch("https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json");
  if(!response.ok)throw new Error("Instrument master download failed.");
  const master=await response.json();
  if(!Array.isArray(master))throw new Error("Invalid instrument master.");

  const fnoNames=new Set();
  const futures=[];

  for(const item of master){
    if(item.exch_seg==="NFO"&&item.instrumenttype==="FUTSTK"&&item.name&&item.token){
      const name=cleanSymbol(item.name);
      if(!name)continue;
      fnoNames.add(name);
      futures.push({
        token:String(item.token),
        tradingSymbol:String(item.symbol||item.tradingsymbol||"").toUpperCase(),
        name
      });
    }
  }

  const cashMap=new Map();

  for(const item of master){
    if(item.exch_seg==="NSE"&&item.symbol&&item.symbol.endsWith("-EQ")&&item.token){
      const symbol=cleanSymbol(item.symbol);
      if(fnoNames.has(symbol)){
        cashMap.set(symbol,{
          symbol,
          token:String(item.token),
          tradingSymbol:item.symbol,
          exchangeType:1
        });
      }
    }
  }

  fnoCashUniverse=Array.from(cashMap.values());
  cashByToken=new Map();
  for(const cash of fnoCashUniverse)cashByToken.set(cash.token,cash);

  futureTokenToCash=new Map();
  futureSymbolToCash=new Map();

  for(const future of futures){
    if(cashMap.has(future.name)){
      futureTokenToCash.set(future.token,future.name);
      if(future.tradingSymbol)futureSymbolToCash.set(future.tradingSymbol,future.name);
    }
  }

  addLog(`F&O cash universe ready: ${fnoCashUniverse.length} stocks.`,"SUCCESS");
  addLog(`Futures mapping ready: ${futureTokenToCash.size} contracts.`,"SUCCESS");
}

function getCashSymbolFromOI(item){
  const token=String(item?.symbolToken||item?.token||"");
  if(token&&futureTokenToCash.has(token))return futureTokenToCash.get(token);

  const ts=String(item?.tradingSymbol||item?.symbol||"").toUpperCase();
  if(ts&&futureSymbolToCash.has(ts))return futureSymbolToCash.get(ts);

  const symbols=Array.from(cashByToken.values()).map(x=>x.symbol).sort((a,b)=>b.length-a.length);
  for(const symbol of symbols){
    if(ts.startsWith(symbol)&&ts.endsWith("FUT"))return symbol;
  }
  return "";
}

app.post("/api/login",async(req,res)=>{
  try{
    const {apiKey,clientId,mpin,totpSecret}=req.body;

    if(!apiKey||!clientId||!mpin||!totpSecret){
      return res.status(400).json({success:false,message:"API Key, Client ID, MPIN aur Long TOTP Secret required hai."});
    }

    addLog(`Login started for ${String(clientId).trim()}.`);

    const secret=normalizeTotpSecret(totpSecret);
    if(!secret)throw new Error("TOTP Secret empty hai.");

    addLog(`Long TOTP Secret received (${secret.length} characters).`);

    const currentTotp=await generate({secret});
    addLog("Current TOTP generated successfully.","SUCCESS");

    smartApi=new SmartAPI({api_key:String(apiKey).trim()});

    const loginResponse=await smartApi.generateSession(
      String(clientId).trim(),
      String(mpin).trim(),
      currentTotp
    );

    if(!loginResponse?.status||!loginResponse?.data){
      throw new Error(loginResponse?.message||loginResponse?.errorcode||"Angel One login failed.");
    }

    sessionData=loginResponse.data;

    let feedToken=sessionData.feedToken;
    if(!feedToken){
      try{feedToken=await Promise.resolve(smartApi.getfeedToken())}catch(e){}
    }
    sessionData.feedToken=feedToken;

    addLog("Angel One broker login successful.","SUCCESS");

    await buildUniverse();

    await startWebSocket({
      jwtToken:sessionData.jwtToken,
      feedToken,
      apiKey:String(apiKey).trim(),
      clientId:String(clientId).trim()
    });

    await refreshOI();

    if(oiRefreshTimer)clearInterval(oiRefreshTimer);

    oiRefreshTimer=setInterval(()=>{
      refreshOI().catch(e=>addLog(`OI refresh error: ${e.message}`,"ERROR"));
    },5000);

    broadcast("login",{connected:true});

    res.json({
      success:true,
      message:"Angel One connected successfully.",
      stocks:fnoCashUniverse.length,
      websocket:websocketReady
    });

  }catch(error){
    addLog(`Login failed: ${error.message}`,"ERROR");
    res.status(401).json({success:false,message:error.message||"Login failed."});
  }
});

async function startWebSocket(credentials){
  const {jwtToken,feedToken,apiKey,clientId}=credentials;

  if(!jwtToken||!feedToken)throw new Error("JWT token ya Feed Token missing hai.");

  if(webSocket){
    try{webSocket.close()}catch(e){}
    webSocket=null;
  }

  addLog("Starting SmartAPI WebSocket V2...");

  webSocket=new WebSocketV2({
    jwttoken:jwtToken,
    apikey:apiKey,
    clientcode:clientId,
    feedtype:feedToken
  });

  return new Promise((resolve,reject)=>{
    let finished=false;

    webSocket.connect().then(()=>{
      websocketReady=true;
      addLog("SmartAPI WebSocket connected.","SUCCESS");

      webSocket.on("tick",handleTick);

      webSocket.on("error",error=>{
        websocketReady=false;
        addLog(`WebSocket error: ${error?.message||error}`,"ERROR");
        broadcast("status",getStatus());
      });

      webSocket.on("close",()=>{
        websocketReady=false;
        addLog("WebSocket closed.","WARN");
        broadcast("status",getStatus());
      });

      subscribeCashStocks();

      if(!finished){
        finished=true;
        resolve();
      }
    }).catch(error=>{
      websocketReady=false;
      addLog(`WebSocket connection failed: ${error.message}`,"ERROR");
      if(!finished){
        finished=true;
        reject(error);
      }
    });
  });
}

function subscribeCashStocks(){
  if(!webSocket||!websocketReady)return;

  const tokens=fnoCashUniverse.map(x=>x.token);
  const chunkSize=100;

  for(let i=0;i<tokens.length;i+=chunkSize){
    webSocket.fetchData({
      correlationID:`cash-${i}`,
      action:1,
      mode:2,
      exchangeType:1,
      tokens:tokens.slice(i,i+chunkSize)
    });
  }

  addLog(`Subscribed ${tokens.length} F&O cash stocks for live ticks.`,"SUCCESS");
}

app.post("/api/index-toggle",(req,res)=>{
  try{
    const {index,enabled}=req.body;

    if(index!=="nifty"&&index!=="sensex"){
      return res.status(400).json({success:false,message:"Invalid index."});
    }

    if(!webSocket||!websocketReady){
      throw new Error("Live WebSocket is not connected.");
    }

    const item=indexData[index];

    webSocket.fetchData({
      correlationID:`${index}-toggle`,
      action:enabled?1:0,
      mode:1,
      exchangeType:item.exchangeType,
      tokens:[item.token]
    });

    indexState[index]=Boolean(enabled);

    addLog(`${item.name} tick-by-tick ${enabled?"ON":"OFF"}`,enabled?"SUCCESS":"INFO");
    broadcast("indexState",indexState);

    res.json({success:true,indexState});

  }catch(error){
    addLog(`Index toggle failed: ${error.message}`,"ERROR");
    res.status(500).json({success:false,message:error.message});
  }
});

function handleTick(tick){
  try{
    if(!tick)return;

    const token=String(tick.token||tick.symbolToken||tick.symboltoken||"");
    if(!token)return;

    if(token===indexData.nifty.token){
      updateIndex("nifty",tick);
      return;
    }

    if(token===indexData.sensex.token){
      updateIndex("sensex",tick);
      return;
    }

    const stock=cashByToken.get(token);
    if(!stock)return;

    const data=parseTick(tick);
    if(data.price===null)return;

    priceData[stock.symbol]={
      symbol:stock.symbol,
      price:data.price,
      close:data.close,
      change:data.change,
      changePercent:data.changePercent,
      timestamp:Date.now()
    };

    broadcast("stockTick",priceData[stock.symbol]);

  }catch(error){
    addLog(`Tick error: ${error.message}`,"ERROR");
  }
}

function parseTick(tick){
  let price=Number(tick.last_traded_price??tick.lastTradedPrice??tick.ltp??0);
  let close=Number(tick.close??tick.closePrice??tick.previous_close??tick.previousClose??0);

  if(price>0)price/=100;
  if(close>0)close/=100;

  let change=null,changePercent=null;

  if(price>0&&close>0){
    change=price-close;
    changePercent=(change/close)*100;
  }

  return {
    price:price>0?price:null,
    close:close>0?close:null,
    change,
    changePercent
  };
}

function updateIndex(name,tick){
  const data=parseTick(tick);
  if(data.price===null)return;

  const item=indexData[name];

  item.price=data.price;
  item.close=data.close;
  item.change=data.change;
  item.changePercent=data.changePercent;
  item.timestamp=Date.now();

  broadcast("indexTick",{index:name,data:item});
}

async function getOI(type){
  return smartApi.gainersLosers({
    datatype:type,
    expirytype:"NEAR"
  });
}

function convertOI(rows){
  if(!Array.isArray(rows))return [];

  const seen=new Set();

  return rows.map(item=>{
    const symbol=getCashSymbolFromOI(item);
    if(!symbol||seen.has(symbol))return null;

    seen.add(symbol);

    const live=priceData[symbol];

    return {
      symbol,
      oiPercent:Number(item.percentChange||0),
      openInterest:Number(item.opnInterest||0),
      oiChange:Number(item.netChangeOpnInterest||0),
      price:live?.price??null,
      change:live?.change??null,
      changePercent:live?.changePercent??null,
      timestamp:Date.now()
    };
  }).filter(Boolean);
}

async function refreshOI(){
  if(!smartApi)return;

  // Dono request parallel hain, lekin ek empty response
  // dusre ka valid data delete nahi karega.
  const [gainerResult,loserResult]=await Promise.allSettled([
    getOI("PercOIGainers"),
    getOI("PercOILosers")
  ]);

  let gainerUpdated=false;
  let loserUpdated=false;

  if(gainerResult.status==="fulfilled"){
    const response=gainerResult.value;

    if(response?.status&&Array.isArray(response.data)){
      const fresh=convertOI(response.data);

      if(fresh.length>0){
        fresh.sort((a,b)=>b.oiPercent-a.oiPercent);
        oiGainers=fresh.slice(0,10);
        gainerUpdated=true;
      }
    }
  }

  if(loserResult.status==="fulfilled"){
    const response=loserResult.value;

    if(response?.status&&Array.isArray(response.data)){
      const fresh=convertOI(response.data);

      if(fresh.length>0){
        fresh.sort((a,b)=>a.oiPercent-b.oiPercent);
        oiLosers=fresh.slice(0,10);
        loserUpdated=true;
      }
    }
  }

  // IMPORTANT:
  // Empty/failed API result par purana valid data retain hoga.
  broadcast("oi",{
    gainers:oiGainers,
    losers:oiLosers,
    timestamp:Date.now()
  });

  addLog(
    `OI synced: Gainers ${oiGainers.length}${gainerUpdated?" updated":" kept"} | Losers ${oiLosers.length}${loserUpdated?" updated":" kept"}.`,
    "SUCCESS"
  );
}

function getStatus(){
  return {
    connected:Boolean(smartApi&&sessionData),
    websocket:websocketReady,
    stocks:fnoCashUniverse.length,
    liveStocks:Object.keys(priceData).length,
    indexes:indexState,
    indexData
  };
}

app.get("/api/status",(req,res)=>{
  res.json(getStatus());
});

app.get("/api/data",(req,res)=>{
  res.json({
    success:Boolean(smartApi&&sessionData),
    connected:Boolean(smartApi&&sessionData),
    websocket:websocketReady,
    indexes:indexData,
    indexState,
    oiGainers,
    oiLosers
  });
});

app.get("/api/logs",(req,res)=>{
  res.json({success:true,logs:activityLogs});
});

app.get("/api/stream",(req,res)=>{
  res.setHeader("Content-Type","text/event-stream");
  res.setHeader("Cache-Control","no-cache");
  res.setHeader("Connection","keep-alive");
  res.flushHeaders();

  clients.add(res);

  res.write(`event: status\ndata: ${JSON.stringify(getStatus())}\n\n`);
  res.write(`event: indexState\ndata: ${JSON.stringify(indexState)}\n\n`);
  res.write(`event: oi\ndata: ${JSON.stringify({gainers:oiGainers,losers:oiLosers})}\n\n`);
  res.write(`event: logs\ndata: ${JSON.stringify(activityLogs)}\n\n`);

  req.on("close",()=>clients.delete(res));
});

app.post("/api/logout",(req,res)=>{
  try{
    if(oiRefreshTimer)clearInterval(oiRefreshTimer);

    if(webSocket){
      try{webSocket.close()}catch(e){}
    }

    smartApi=null;
    sessionData=null;
    webSocket=null;
    websocketReady=false;
    priceData={};
    oiGainers=[];
    oiLosers=[];

    indexState.nifty=false;
    indexState.sensex=false;

    addLog("Broker logged out.");
    res.json({success:true});
  }catch(e){
    res.json({success:true});
  }
});

app.get("/{*splat}",(req,res)=>{
  res.sendFile(__dirname+"/public/index.html");
});

app.listen(PORT,()=>{
  addLog(`Server started on port ${PORT}.`);
});
