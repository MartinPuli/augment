/** Two independent coordinator processes, one isolated Postgres schema. No physical hardware. */
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { config } from "dotenv";
import pg from "pg";
import WebSocket from "ws";
import type { DeviceManifest, MeResponse, PairingResponse, InvokeResponse } from "../src/lib/ghost/contracts";

config({path:process.env.GHOST_TEST_ENV || ".ghost/vercel-production.env",quiet:true});
assert(process.env.DATABASE_URL,"DATABASE_URL is required");
const schema = `ghost_cluster_test_${Date.now().toString(36)}`;
const children:ChildProcess[]=[];
const sockets:WebSocket[]=[];
const headers=(token?:string)=>({"content-type":"application/json",...(token?{authorization:`Bearer ${token}`}:{})});
async function boot() {
  const child=fork(new URL("./fixtures/distributed-coordinator.ts",import.meta.url),[],{
    execArgv:["--import","tsx"],env:{...process.env,GHOST_DB_SCHEMA:schema,GHOST_DISTRIBUTED:"1",GHOST_DB_FALLBACK:"0",GHOST_QUIET:"1",VERCEL:"0"},stdio:["ignore","ignore","inherit","ipc"],
  });
  children.push(child);
  const ready=await Promise.race([once(child,"message"),once(child,"exit").then(() => { throw new Error("worker exited before ready"); }),new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error("worker boot timeout")),45000).unref())]);
  return `http://127.0.0.1:${(ready[0] as {port:number}).port}`;
}
async function api<T>(base:string,path:string,token?:string,body?:unknown):Promise<T> {
  const r=await fetch(`${base}/api/v1${path}`,{method:body===undefined?"GET":"POST",headers:headers(token),body:body===undefined?undefined:JSON.stringify(body)});
  assert(r.ok,`${path}: HTTP ${r.status} ${await r.clone().text()}`);
  return r.json() as Promise<T>;
}
type Message={type:string;[key:string]:unknown};
async function connect(base:string,hello?:unknown,cookie?:string) {
  const ws=new WebSocket(base.replace("http","ws")+"/v1/device-channel",{headers:cookie?{cookie}:undefined});sockets.push(ws);
  const messages:Message[]=[];
  ws.on("message",raw=>{const m=JSON.parse(raw.toString()) as Message;messages.push(m);if(m.type==="ping")ws.send(JSON.stringify({type:"heartbeat"}));});
  await once(ws,"open");
  const wait=async(type:string)=>{
    const deadline=Date.now()+15000;
    while(Date.now()<deadline){const i=messages.findIndex(m=>m.type===type);if(i>=0)return messages.splice(i,1)[0];await new Promise(r=>setTimeout(r,30));}
    throw new Error(`missing ${type}; received ${messages.map(m=>m.type).join(",")}`);
  };
  const send=(m:unknown)=>ws.send(JSON.stringify(m));
  if(hello)send(hello);
  return {ws,wait,send};
}
const manifest:DeviceManifest={protocol_version:"ghost/0.1",local_key:"sim-sensor",name:"SIMULATED Vercel migration sensor",device_class:"sensor",transport:"other",access_type:"own_device",terms:{price_cents:0,currency:"USD",max_duration_s:300},capabilities:[{capability_id:"temperature.read",kind:"measure",semantic_type:"temperature",title:"Read simulated temperature",description:"Test fixture only",input_schema:{type:"object",properties:{}},verification:"observation"}]};
let count=0;
function pass(name:string){console.log(`PASS ${++count}: ${name}`);}
async function main(){
  const [a,b]=await Promise.all([boot(),boot()]);pass("two processes start and migrate concurrently");
  const owner=await api<MeResponse>(a,"/me");const stranger=await api<MeResponse>(b,"/me");
  assert.equal((await api<MeResponse>(b,"/me",owner.owner_token)).principal_id,owner.principal_id);pass("identity persists across processes");
  const pairing=await api<PairingResponse>(a,"/pairings",owner.owner_token,{});
  const device=await connect(b,{type:"hello",pairing_code:pairing.code,label:"SIMULATED cluster device",connector_kind:"other"});
  await device.wait("pending_confirmation");
  const denied=await fetch(`${a}/api/v1/pairings/${pairing.pairing_id}/confirm`,{method:"POST",headers:headers(stranger.owner_token)});
  assert.equal(denied.status,403);pass("another owner cannot confirm a pairing");
  await api(a,`/pairings/${pairing.pairing_id}/confirm`,owner.owner_token,{});
  const welcome=await device.wait("welcome");pass("owner confirms a device connected to another process");
  device.send({type:"publish",devices:[manifest]});
  const published=await device.wait("published");const deviceId=(published.devices as {device_id:string}[])[0].device_id;
  const listed=await api<{device_id:string;online:boolean}[]>(a,"/devices?mine=1",owner.owner_token);
  assert(listed.some(d=>d.device_id===deviceId&&d.online));pass("remote device appears online");
  async function invoke(base:string,conn:typeof device,key:string){
    const result=api<InvokeResponse>(base,"/invoke",owner.owner_token,{device_id:deviceId,capability_id:"temperature.read",idempotency_key:key,timeout_ms:10000});
    const call=await conn.wait("invoke");
    conn.send({type:"result",invocation_id:call.invocation_id,state:"succeeded",output:{value:24,unit:"C",note:"SIMULATED test"}});
    const res=await result;assert.equal(res.invocation.state,"succeeded");assert.equal(res.observation?.value,24);return res;
  }
  const first=await invoke(a,device,"cluster-idempotent");pass("invocation and observation travel between processes");
  const replay=await api<InvokeResponse>(b,"/invoke",owner.owner_token,{device_id:deviceId,capability_id:"temperature.read",idempotency_key:"cluster-idempotent"});
  assert.equal(replay.invocation.invocation_id,first.invocation.invocation_id);pass("same idempotency key returns the original result on another process");
  const viewer=await connect(a,undefined,`ghost_pid=${owner.owner_token}`);
  viewer.send({type:"signal",to:"device",session_id:"test-view",data:{device_id:deviceId,sdp:"SIMULATED"}});
  assert.equal((await device.wait("signal")).from,"viewer");
  device.send({type:"signal",to:"viewer",session_id:"test-view",data:{sdp:"SIMULATED reply"}});
  assert.equal((await viewer.wait("signal")).from,"device");pass("WebRTC signaling routes across processes with owner authentication");
  const attacker=await connect(b,undefined,`ghost_pid=${stranger.owner_token}`);
  attacker.send({type:"signal",to:"device",session_id:"test-view",data:{device_id:deviceId,sdp:"bad"}});
  await attacker.wait("error");pass("unauthorized viewer cannot join the signal session");
  const replacement=await connect(a,{type:"hello",credential:welcome.credential});
  const resumed=await replacement.wait("welcome");assert.equal(resumed.connector_id,welcome.connector_id);
  replacement.send({type:"publish",devices:[manifest]});await replacement.wait("published");
  await invoke(b,replacement,"cluster-after-reconnect");pass("device reconnects on another process with the same identity and serves new requests");
  const end=Date.now()+8000;while(device.ws.readyState===WebSocket.OPEN&&Date.now()<end)await new Promise(r=>setTimeout(r,100));
  assert.notEqual(device.ws.readyState,WebSocket.OPEN);pass("superseded socket is closed");
  // A crashed process must not remain discoverable forever.
  children[0].kill("SIGKILL");
  const expiredAt=Date.now()+26000;
  let offline=false;
  while(Date.now()<expiredAt){
    const list=await api<{device_id:string;online:boolean}[]>(b,"/devices?mine=1",owner.owner_token);
    if(list.some(d=>d.device_id===deviceId&&!d.online)){offline=true;break;}
    await new Promise(r=>setTimeout(r,1000));
  }
  assert(offline);pass("device becomes offline after its server disappears");
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  for(const socket of sockets)socket.terminate();
  for(const child of children)if(child.exitCode===null)child.kill("SIGTERM");
  await Promise.all(children.map(child=>child.exitCode!==null?Promise.resolve():Promise.race([once(child,"exit"),new Promise(r=>setTimeout(r,3000))])));
  for(const child of children)if(child.exitCode===null)child.kill("SIGKILL");
  const c=new pg.Client({connectionString:process.env.DATABASE_URL!.replace(/-pooler(\.)/,"$1"),ssl:{rejectUnauthorized:false},connectionTimeoutMillis:10000});
  await c.connect();await c.query(`drop schema if exists ${schema} cascade`);await c.end();
});
