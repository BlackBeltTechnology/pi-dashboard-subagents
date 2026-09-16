// Spike: is a shared DefaultResourceLoader safe for N concurrent createAgentSession()?
// Inline probe extension captures its load-time `pi` object; children then call
// pi.setSessionName / pi.appendEntry / pi.getActiveTools and we check which session got hit.
import { createAgentSession, DefaultResourceLoader, SessionManager, getAgentDir } from "/Users/robson/.nvm/versions/node/v25.8.1/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";

const cwd = process.argv[2] ?? "/Users/robson/Project/judo-ng";
const mode = process.argv[3] ?? "shared"; // shared | perchild
const n = Number(process.argv[4] ?? 3);

// Probe extension: one instance per factory execution. Records the `pi` it was given.
const piRefs = [];
const probeFactory = (pi) => {
  const me = { id: piRefs.length, pi };
  piRefs.push(me);
  pi.registerTool({ name: "probe_" + me.id, label: "probe", description: "probe", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: "ok" }] }; } });
  pi.on("session_start", async (_e, ctx) => { me.sessionStartCtxCwd = ctx.cwd; });
};

const mk = async () => {
  const l = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [probeFactory] });
  await l.reload();
  return l;
};
const shared = mode === "shared" ? await mk() : undefined;
const factoryRunsAfterLoad = piRefs.length;

const sessions = [];
await Promise.all(Array.from({ length: n }, async (_, i) => {
  const loader = shared ?? await mk();
  const sessionManager = SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({ cwd, sessionManager, resourceLoader: loader });
  sessions[i] = session;
}));
const out = { mode, n, factoryRunsAfterLoad, factoryRunsTotal: piRefs.length, distinctExtensionsResult: new Set(sessions.map(s => s._resourceLoader.getExtensions())).size, distinctRuntime: new Set(sessions.map(s => s._resourceLoader.getExtensions().runtime)).size };

// H1: setSessionName via the *first* probe's pi. Which session actually changes?
const probe = piRefs[0];
try {
  probe.pi.setSessionName("SET-BY-PROBE-0");
  out.h1_setSessionName = sessions.map((s, i) => ({ i, name: s.sessionName ?? null }));
} catch (e) { out.h1_error = String(e.message).slice(0, 80); }

// H2: appendEntry via probe 0's pi — count custom entries per session.
try {
  probe.pi.appendEntry("probe-marker", { from: "probe0" });
  out.h2_appendEntry = sessions.map((s, i) => ({ i, customEntries: s.sessionManager.getEntries().filter(e => e.type === "custom" && e.customType === "probe-marker").length }));
} catch (e) { out.h2_error = String(e.message).slice(0, 80); }

// H3: dispose child 0, then have child 1's runner emit → probe's pi.* call; also direct pi call.
sessions[0].dispose();
try { probe.pi.getActiveTools(); out.h3_afterDispose0_pi_getActiveTools = "ok"; } catch (e) { out.h3_afterDispose0_pi_getActiveTools = "THROWS: " + String(e.message).slice(0, 60); }
try { sessions[1].getActiveToolNames(); out.h3_session1_getActiveToolNames = "ok"; } catch (e) { out.h3_session1_getActiveToolNames = "THROWS: " + String(e.message).slice(0, 60); }
try { const r = await sessions[1]._extensionRunner.emit({ type: "session_start", reason: "startup" }); out.h3_session1_emit = "ok"; } catch (e) { out.h3_session1_emit = "THROWS: " + String(e.message).slice(0, 60); }
// does a tool from the shared set still execute on session 1?
try { const ctx = sessions[1]._extensionRunner.createContext(); const t = sessions[1]._extensionRunner.getAllRegisteredTools().find(t => t.definition.name.startsWith("probe_")); await t.definition.execute?.("x", {}, undefined, undefined, ctx) ?? await t.execute?.("x", {}, undefined, undefined, ctx); out.h3_session1_probeTool = "ok"; } catch (e) { out.h3_session1_probeTool = "THROWS: " + String(e.message).slice(0, 60); }
try { const ctx = sessions[1]._extensionRunner.createContext(); void ctx.cwd; out.h3_session1_ctx_cwd = "ok"; } catch (e) { out.h3_session1_ctx_cwd = "THROWS: " + String(e.message).slice(0, 60); }

for (const s of sessions.slice(1)) s.dispose();
console.log(JSON.stringify(out, null, 1));
