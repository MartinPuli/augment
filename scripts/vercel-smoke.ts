/** Public deployment smoke test. A clearly labeled synthetic device; no real hardware actions. */
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";
import type { MeResponse, PairingResponse, InvokeResponse } from "../src/lib/ghost/contracts";

const base=process.argv[2]?.replace(/\/$/,"");
assert(base?.startsWith("https://"),"Pass the deployed HTTPS URL");
const extra:Record<string,string>=process.env.VERCEL_AUTOMATION_BYPASS_SECRET?{"x-vercel-protection-bypass":process.env.VERCEL_AUTOMATION_BYPASS_SECRET}:{};
let ws:WebSocket|undefined;
let testDevice:string|undefined;
let owner:MeResponse|undefined;
const messages:Record<string,unknown>[]=[];
async function request(path:string,body?:unknown,token?:string){
  const r=await fetch(base+path,{method:body===undefined?"GET":"POST",headers:{...extra,...(token?{authorization:`Bearer ${token}`} : {}),...(body!==undefined?{"content-type":"application/json"}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
  assert(r.ok,`${path}: ${r.status} ${(await r.clone().text()).slice(0,300)}`);return r.json();
}
async function wait(type:string,timeout=30000){
  const end=Date.now()+timeout;
  while(Date.now()<end){const i=messages.findIndex(m=>m.type===type);if(i>=0)return messages.splice(i,1)[0];await new Promise(r=>setTimeout(r,50));}
  throw Error(`Missing ${type}; received ${messages.map(m=>m.type).join(",")}`);
}
async function main(){
  assert.equal((await request("/api/v1/health")).ok,true);console.log("PASS health");
  owner=await request("/api/v1/me") as MeResponse;
  assert(owner.owner_token);console.log("PASS identity persisted");
  const guides=await request("/api/v1/hardware-guides");assert(guides);console.log("PASS hardware guides");
  const pairing=await request("/api/v1/pairings",{},owner.owner_token) as PairingResponse;
  ws=new WebSocket(base!.replace("https:","wss:")+"/v1/device-channel",{headers:extra,handshakeTimeout:60000});
  ws.on("message",raw=>{const m=JSON.parse(raw.toString());messages.push(m);if(m.type==="ping")ws?.send(JSON.stringify({type:"heartbeat"}));});
  await once(ws,"open");console.log("PASS real Vercel WebSocket handshake");
  ws.send(JSON.stringify({type:"hello",label:"SIMULATED Vercel deployment check",connector_kind:"other",pairing_code:pairing.code}));
  await wait("pending_confirmation");
  await request(`/api/v1/pairings/${pairing.pairing_id}/confirm`,{},owner.owner_token);await wait("welcome");console.log("PASS pairing over deployed HTTP and WebSocket");
  ws.send(JSON.stringify({type:"publish",devices:[{protocol_version:"ghost/0.1",local_key:"vercel-test-sensor",name:"SIMULATED deployment check (temporary)",device_class:"sensor",transport:"other",access_type:"own_device",terms:{price_cents:0,currency:"USD",max_duration_s:120},capabilities:[{capability_id:"temperature.read",kind:"measure",semantic_type:"temperature",title:"Read simulated temperature",description:"Synthetic deployment test",verification:"observation",input_schema:{type:"object",properties:{}}}]}]}));
  testDevice=((await wait("published")).devices as {device_id:string}[])[0].device_id;
  const invoked=request("/api/v1/invoke",{device_id:testDevice,capability_id:"temperature.read",timeout_ms:20000,idempotency_key:"vercel-smoke-temperature"},owner.owner_token) as Promise<InvokeResponse>;
  const command=await wait("invoke");
  ws.send(JSON.stringify({type:"result",invocation_id:command.invocation_id,state:"succeeded",output:{value:24,unit:"C",note:"SIMULATED deployment test, no physical sensor"}}));
  const result=await invoked;assert.equal(result.invocation.state,"succeeded");assert.equal(result.observation?.value,24);console.log("PASS end-to-end device invocation with observation");
  const mcp=await fetch(base+"/mcp",{method:"POST",headers:{...extra,authorization:`Bearer ${owner.owner_token}`,"content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list",params:{}})});
  assert.equal(mcp.status,200);const tools=await mcp.json();assert(tools.result.tools.some((t:{name:string})=>t.name==="invoke_capability"));console.log(`PASS MCP ${tools.result.tools.length} tools`);
  const replay=await request("/api/v1/invoke",{device_id:testDevice,capability_id:"temperature.read",idempotency_key:"vercel-smoke-temperature"},owner.owner_token);
  assert.equal(replay.invocation.invocation_id,result.invocation.invocation_id);console.log("PASS idempotent replay");
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(ws?.readyState===WebSocket.OPEN&&testDevice){ws.send(JSON.stringify({type:"unpublish",local_keys:["vercel-test-sensor"]}));await new Promise(r=>setTimeout(r,1000));}
  ws?.close();setTimeout(()=>ws?.terminate(),1000).unref();
});
