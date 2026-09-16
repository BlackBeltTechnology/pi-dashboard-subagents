import { createRequire } from "module"; const require = createRequire(import.meta.url);
// Spike: cost of createAgentSession() as pi-dashboard-subagents calls it
// (default resource loader => loads all extensions) vs a noExtensions loader.
// Measures wall time + max event-loop lag. No LLM calls.
import { createAgentSession, DefaultResourceLoader, SessionManager, getAgentDir } from "/Users/robson/.nvm/versions/node/v25.8.1/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";

const cwd = process.argv[2] ?? "/Users/robson/Project/judo-ng";
const mode = process.argv[3] ?? "default"; // default | noext
const n = Number(process.argv[4] ?? 1);

let maxLag = 0, last = Date.now(); const t0 = performance.now();
const lagTimer = setInterval(() => { const now = Date.now(); const l = now - last - 50; if (l > 500) console.error(JSON.stringify({t:Math.round(performance.now()-t0),blockMs:l})); maxLag = Math.max(maxLag, l); last = now; }, 50);

let sharedLoader;
if (process.env.PARENT) { const a=performance.now(); const l=new DefaultResourceLoader({cwd, agentDir:getAgentDir()}); await l.reload(); console.error(JSON.stringify({parentLoadMs:Math.round(performance.now()-a)})); if (mode==="shared") sharedLoader=l; last=Date.now(); maxLag=0; }
async function spawnOne() {
  const sessionManager = SessionManager.inMemory(cwd);
  const opts = { cwd, sessionManager };
  if (mode === "noext") {
    const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true });
    await loader.reload();
    opts.resourceLoader = loader;
  }
  if (mode==="shared") opts.resourceLoader = sharedLoader;
  const { session } = await createAgentSession(opts);
  const tools = session.getActiveToolNames().length;
  if (process.env.PROMPT) { const a=performance.now(); let evs=0; let lastErr; const un=session.subscribe((e)=>{evs++; if(e.type==="message_update"&&e.assistantMessageEvent?.type==="error") lastErr=JSON.stringify(e.assistantMessageEvent.error).slice(0,200); if(e.type==="message_end"&&e.message?.role==="assistant"){ const c=e.message.content; const t=Array.isArray(c)?c.filter(b=>b.type==="text").map(b=>b.text).join(""):""; console.error("ANSWER: "+t.slice(0,120).replace(/\n/g," ")); if(e.message.errorMessage) console.error("ERR: "+e.message.errorMessage.slice(0,200)); if(e.message.stopReason) console.error("STOP: "+e.message.stopReason);} }); await session.prompt("Read the file AGENTS.md in the current directory and reply with its first heading only."); un(); console.error(JSON.stringify({promptMs:Math.round(performance.now()-a), events:evs, lastErr, model:session.model?.id})); }
  if (process.env.HOLD) { await new Promise(r=>setTimeout(r,Number(process.env.HOLD))); }
  session.dispose();
  return tools;
}

setInterval(()=>{ const {execSync}=require("child_process"); const kids=execSync(`pgrep -P ${process.pid} | wc -l`).toString().trim(); console.error(JSON.stringify({t:Math.round(performance.now()-t0),lag:maxLag,rssMB:Math.round(process.memoryUsage().rss/1e6),childProcs:Number(kids)})); },60000).unref();
let tools;
if (process.env.SEQ) { tools=[]; for (let i=0;i<n;i++){ const a=performance.now(); tools.push(await spawnOne()); console.error(JSON.stringify({seq:i, spawnMs:Math.round(performance.now()-a)})); } }
else tools = await Promise.all(Array.from({ length: n }, spawnOne));
const wall = Math.round(performance.now() - t0);
clearInterval(lagTimer);
const rss = Math.round(process.memoryUsage().rss / 1e6);
console.log(JSON.stringify({ mode, n, wallMs: wall, maxLoopLagMs: maxLag, rssMB: rss, toolsPerChild: tools[0] }));
process.exit(0);
