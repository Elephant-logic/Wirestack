// ─── STATE ───────────────────────────────────────────────────────────────────
const state = {
  blueprint: null, lastAnalysis: null, validationReport: null, repairPrompt: '',
  highlighted: new Set(), ingestion: null, knowledge: null, paused: false,
  engineLog: [], autosave: true, lastSavedAt: null, api: null,
  testingReport: null, testPlan: null, changeMemory: [], agents: null,
  deployment: null, brain: null, qutri: null, blueprintBaseline: null, blueprintDiff: null, wizardStep: 0,
  // AI Build state
  aiConversation: [],    // [{role, content}]
  aiAbortController: null,
  aiCodeBlocks: [],
  layoutCache: { key: null, pos: null },
  projectAnalysis: null,
};

// ─── TEMPLATES ───────────────────────────────────────────────────────────────
const templates = {
  auth: { type:'backend', layer:'Security', purpose:'Manage login, sessions, roles and protected routes.', dependsOn:['db.users'], usedBy:['api.invoices','ui.dashboard'], code:`export function requireUser(session) {\n  if (!session?.userId) throw new Error('Unauthorized');\n  return session.userId;\n}` },
  'ui.dashboard': { type:'frontend', layer:'Experience', purpose:'Show totals, recent records, status and quick actions.', dependsOn:['api.invoices'], usedBy:['users'], code:`export function Dashboard() {\n  return <main>Overview, totals and actions</main>;\n}` },
  'api.invoices': { type:'backend', layer:'API', purpose:'Expose invoice create, edit, send and payment-status endpoints.', dependsOn:['auth','svc.invoices'], usedBy:['ui.dashboard'], code:`router.post('/invoices', async (req, res) => {\n  const userId = requireUser(req.session);\n  res.json(await createInvoice(req.body, userId));\n});` },
  'svc.invoices': { type:'service', layer:'Business logic', purpose:'Create, edit, send and track invoices.', dependsOn:['db.invoices','svc.payments','svc.email'], usedBy:['api.invoices','tests'], code:`export async function createInvoice(input, userId) {\n  const invoice = await db.invoices.create({ ...input, userId });\n  await sendInvoiceEmail(invoice);\n  return invoice;\n}` },
  'svc.payments': { type:'service', layer:'External service', purpose:'Create payment links, handle provider webhooks and sync payment status.', dependsOn:['db.invoices'], usedBy:['svc.invoices','svc.email'], code:`export async function createPaymentLink(invoice) {\n  return stripe.paymentLinks.create({ line_items: invoice.items });\n}` },
  'svc.email': { type:'service', layer:'External service', purpose:'Send emails, reminders and receipts.', dependsOn:['db.invoices'], usedBy:['svc.invoices','svc.payments'], code:`export async function sendReceipt(invoice, payment) {\n  return mailer.send({ to: invoice.customerEmail, subject: 'Receipt' });\n}` },
  'db.users': { type:'database', layer:'Data', purpose:'Store users, password hashes, sessions and roles.', dependsOn:[], usedBy:['auth'], code:`CREATE TABLE users (\n  id TEXT PRIMARY KEY,\n  email TEXT UNIQUE NOT NULL,\n  password_hash TEXT NOT NULL\n);` },
  'db.invoices': { type:'database', layer:'Data', purpose:'Store invoices, line items, payment records and audit events.', dependsOn:['db.users'], usedBy:['svc.invoices','svc.payments','svc.email'], code:`CREATE TABLE invoices (\n  id TEXT PRIMARY KEY,\n  user_id TEXT NOT NULL,\n  customer_email TEXT NOT NULL,\n  status TEXT NOT NULL,\n  total INTEGER NOT NULL\n);` },
  tests: { type:'quality', layer:'Safety', purpose:'Protect critical user journeys and integrations from regressions.', dependsOn:['auth','api.invoices','svc.invoices','svc.payments','svc.email'], usedBy:['deploy'], code:`test('core flow passes', async () => {\n  expect(await runCoreFlow()).toEqual('ok');\n});` },
  deploy: { type:'ops', layer:'Release', purpose:'Build, test and ship the generated application.', dependsOn:['tests'], usedBy:['release'], code:`npm test\nnpm run build\nnpm run deploy` }
};

// ─── BLUEPRINT BUILD ──────────────────────────────────────────────────────────
function buildBlueprint() {
  const name = val('projectName') || 'UntitledApp';
  const ids = Object.keys(templates);
  const brief = val('brief');
  const target = document.getElementById('target').value;
  return {
    name, version:'0.5.0', target,
    engines:{
      importer:'Turn existing guides, README files, folder manifests and old project notes into blueprint context, modules, rules and wiring.',
      builder:'Generate or modify code sections from the blueprint.',
      validator:'Check fences, syntax-like structure, dependencies, wiring, tests and changelog.',
      tester:'Continuously generate function, edge, journey and impact tests from the blueprint and wiring graph.',
      cartographer:'Keep the index, wiring diagram and context synchronized with code.',
      knowledge:'Learn from guides, README files and old projects by extracting concepts, relationships, confidence scores and self-test questions.',
      multiApi:'Route work across one or more AI providers, using shared blueprint context and specialist model roles.'
    },
    context:{ purpose:brief, currentTask:val('task'), sourceMaterial:'No imported source yet.', rules:[
      'Every module must declare purpose, dependencies and dependants.',
      'No code change is complete until wiring, tests and changelog are checked.',
      'Imported guides and old projects become context, not blind instructions.',
      'The AI must identify impact radius before editing.',
      'Generated code must be returned in exactly one fenced code block when asking an AI to repair.',
      'Validation errors must be declared and sent back as the next repair request.',
      'Imported source must be converted into a knowledge graph before large changes.'
    ]},
    index: ids.map((id,idx)=>({ id, order:idx+1, type:templates[id].type, layer:templates[id].layer })),
    wiring: ids.flatMap(id => templates[id].dependsOn.map(dep => [id, dep])),
    sections: Object.fromEntries(ids.map(id => [id, { id, ...templates[id] }])),
    imports: [],
    changelog:[{ date:today(), actor:'WireStack', change:'Initial living blueprint generated.' }]
  };
}
function generateBlueprint(){ state.layoutCache={key:null,pos:null}; state.blueprint = buildBlueprint(); state.lastAnalysis=null; state.validationReport=null; state.repairPrompt=''; state.highlighted.clear(); captureBlueprintBaseline(false); render(); autosave(); toast('Blueprint generated'); }

// ─── REAL MULTI-PROVIDER API ─────────────────────────────────────────────────

const providerDefaults = {
  anthropic: { label: 'Claude', placeholder: 'sk-ant-…', model: 'claude-sonnet-4-6' },
  openai: { label: 'OpenAI', placeholder: 'sk-…', model: 'gpt-5.5' }
};

function getProvider() {
  return document.getElementById('providerSelect')?.value || 'anthropic';
}

function getProviderLabel() {
  return providerDefaults[getProvider()]?.label || 'AI';
}

function getApiKey() {
  return document.getElementById('apiKeyInput').value.trim();
}

function getModelId() {
  return (document.getElementById('modelInput')?.value || providerDefaults[getProvider()]?.model || '').trim();
}

function updateProviderUi() {
  const provider = getProvider();
  const cfg = providerDefaults[provider] || providerDefaults.anthropic;
  const keyInput = document.getElementById('apiKeyInput');
  const modelInput = document.getElementById('modelInput');
  if (keyInput) keyInput.placeholder = cfg.placeholder;
  if (modelInput && !modelInput.value.trim()) modelInput.value = cfg.model;
  const sendBtn = document.getElementById('aiSendBtn');
  if (sendBtn) sendBtn.textContent = `▶ Send to ${cfg.label}`;
  const thinking = document.getElementById('aiThinkingText');
  if (thinking) thinking.textContent = `${cfg.label} is thinking…`;
  const status = document.getElementById('apiKeyStatus');
  if (status && !getApiKey()) { status.className = 'keyStatus'; status.textContent = ''; }
}

function updateKeyStatus(ok, msg) {
  const el = document.getElementById('apiKeyStatus');
  el.textContent = msg;
  el.className = 'keyStatus ' + (ok ? 'keyOk' : 'keyErr');
}

/** Build the system prompt that includes blueprint context */
function buildSystemPrompt() {
  const bp = state.blueprint;
  const parts = ['You are WireStack AI — an expert software architect and developer embedded in the WireStack Studio.\n\nYour job is to analyze blueprints, generate real working code, write tests, and provide repair suggestions.\n\nRules:\n- Return code in fenced code blocks with language tags (```javascript, ```sql, ```bash etc)\n- One fenced block per module/file\n- Always declare which sections you are modifying\n- After generating code, update the mental model of wiring and dependencies\n- Be specific, write real implementations — never use placeholder comments like // TODO'];

  if (!bp) return parts.join('\n');

  if (document.getElementById('ctxBlueprint')?.checked) {
    parts.push(`\n## Current Blueprint: ${bp.name} (v${bp.version})\nTarget: ${bp.target}\nPurpose: ${bp.context.purpose}\nCurrent task: ${bp.context.currentTask}`);
  }
  if (document.getElementById('ctxWiring')?.checked && bp.wiring?.length) {
    parts.push(`\n## Wiring (${bp.wiring.length} connections)\n${bp.wiring.map(([a,b])=>`${a} → ${b}`).join('\n')}`);
  }
  if (document.getElementById('ctxWiring')?.checked && bp.sections) {
    parts.push(`\n## Modules\n${Object.values(bp.sections).map(s=>`- ${s.id} [${s.layer}]: ${s.purpose}`).join('\n')}`);
  }
  if (document.getElementById('ctxKnowledge')?.checked && state.knowledge) {
    const kg = state.knowledge;
    parts.push(`\n## Knowledge Graph (top concepts)\n${kg.concepts.slice(0,15).map(c=>`- ${c.name} (confidence: ${Math.round(c.confidence*100)}%)`).join('\n')}`);
  }
  if (document.getElementById('ctxValidation')?.checked && state.validationReport) {
    const vr = state.validationReport;
    parts.push(`\n## Last Validation: ${vr.status}\nErrors: ${vr.errors.join('\n')}\nWarnings: ${vr.warnings.join('\n')}`);
  }
  if (document.getElementById('ctxTests')?.checked && state.testingReport) {
    const tr = state.testingReport;
    parts.push(`\n## Test Report: ${tr.status} (${tr.confidence}% confidence)\nFailed: ${tr.failures?.length || 0}`);
  }
  if (bp.context.rules?.length) {
    parts.push(`\n## Blueprint Rules\n${bp.context.rules.map(r=>`- ${r}`).join('\n')}`);
  }
  return parts.join('\n');
}

/** Stream a message to the selected provider, update UI in real time */
async function sendToAiStreaming(userMessage, onChunk, onDone, onError) {
  const provider = getProvider();
  if (provider === 'openai') return sendToOpenAIStreaming(userMessage, onChunk, onDone, onError);
  return sendToClaudeStreaming(userMessage, onChunk, onDone, onError);
}

async function sendToClaudeStreaming(userMessage, onChunk, onDone, onError) {
  const apiKey = getApiKey();
  const model = getModelId();
  if (!apiKey) { onError('No API key. Add your Anthropic API key in the top bar.'); return; }
  if (!model) { onError('No Claude model selected.'); return; }

  state.aiConversation.push({ role: 'user', content: userMessage });
  const controller = new AbortController();
  state.aiAbortController = controller;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        system: buildSystemPrompt(),
        messages: state.aiConversation,
        stream: true,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: { message: response.statusText } }));
      const msg = err.error?.message || response.statusText;
      if (response.status === 401) updateKeyStatus(false, '✗ Invalid Claude key');
      onError('Claude API error: ' + msg);
      state.aiConversation.pop();
      return;
    }

    updateKeyStatus(true, `✓ Claude connected (${model})`);
    let fullText = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
            fullText += parsed.delta.text;
            onChunk(fullText);
          }
        } catch {}
      }
    }

    state.aiConversation.push({ role: 'assistant', content: fullText });
    onDone(fullText);
  } catch (err) {
    if (err.name === 'AbortError') onDone(null);
    else { onError(err.message); state.aiConversation.pop(); }
  } finally {
    state.aiAbortController = null;
  }
}

async function sendToOpenAIStreaming(userMessage, onChunk, onDone, onError) {
  const apiKey = getApiKey();
  const model = getModelId();
  if (!apiKey) { onError('No API key. Add your OpenAI API key in the top bar.'); return; }
  if (!model) { onError('No OpenAI model selected.'); return; }

  state.aiConversation.push({ role: 'user', content: userMessage });
  const controller = new AbortController();
  state.aiAbortController = controller;

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        instructions: buildSystemPrompt(),
        input: state.aiConversation.map(m => ({ role: m.role, content: m.content })),
        max_output_tokens: 8192,
        stream: true
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: { message: response.statusText } }));
      const msg = err.error?.message || response.statusText;
      if (response.status === 401) updateKeyStatus(false, '✗ Invalid OpenAI key');
      onError('OpenAI API error: ' + msg);
      state.aiConversation.pop();
      return;
    }

    updateKeyStatus(true, `✓ OpenAI connected (${model})`);
    let fullText = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'response.output_text.delta') {
            fullText += parsed.delta || '';
            onChunk(fullText);
          } else if (parsed.type === 'response.error') {
            throw new Error(parsed.error?.message || 'OpenAI stream error');
          }
        } catch (e) {
          if (e.message && !e.message.includes('JSON')) throw e;
        }
      }
    }

    state.aiConversation.push({ role: 'assistant', content: fullText });
    onDone(fullText);
  } catch (err) {
    if (err.name === 'AbortError') onDone(null);
    else { onError(err.message); state.aiConversation.pop(); }
  } finally {
    state.aiAbortController = null;
  }
}

/** Render the AI Build tab output */
function aiSend() {
  const userMsg = val('aiPromptInput');
  if (!userMsg) { toast('Add a prompt first'); return; }

  const outputEl = document.getElementById('aiOutput');
  const thinkingEl = document.getElementById('aiThinking');
  const sendBtn = document.getElementById('aiSendBtn');
  const stopBtn = document.getElementById('aiStopBtn');
  const applyBtn = document.getElementById('aiApplyCodeBtn');

  outputEl.textContent = '';
  thinkingEl.style.display = 'flex';
  sendBtn.disabled = true;
  stopBtn.style.display = 'inline-flex';
  applyBtn.style.display = 'none';
  document.getElementById('aiCodeBlocks').innerHTML = 'Waiting for response…';

  sendToAiStreaming(
    userMsg,
    (text) => {
      thinkingEl.style.display = 'none';
      outputEl.textContent = text;
      outputEl.scrollTop = outputEl.scrollHeight;
    },
    (fullText) => {
      sendBtn.disabled = false;
      stopBtn.style.display = 'none';
      thinkingEl.style.display = 'none';
      if (fullText) {
        const blocks = extractAllFencedBlocks(fullText);
        state.aiCodeBlocks = blocks;
        renderAiCodeBlocks(blocks);
        if (blocks.length > 0) applyBtn.style.display = 'inline-flex';
        renderAiHistory();
        autosave();
        toast(`Done — ${blocks.length} code block(s) extracted`);
      } else {
        toast('Request stopped');
      }
    },
    (errMsg) => {
      sendBtn.disabled = false;
      stopBtn.style.display = 'none';
      thinkingEl.style.display = 'none';
      outputEl.textContent = '⚠ ' + errMsg;
      toast('Error: ' + errMsg.slice(0,60));
    }
  );
}

function aiStop() {
  if (state.aiAbortController) {
    state.aiAbortController.abort();
    toast('Stopped');
  }
}

function aiClear() {
  state.aiConversation = [];
  state.aiCodeBlocks = [];
  document.getElementById('aiOutput').textContent = 'Conversation cleared.';
  document.getElementById('aiCodeBlocks').innerHTML = 'No code blocks extracted yet.';
  document.getElementById('aiHistory').innerHTML = 'No messages yet.';
  document.getElementById('aiApplyCodeBtn').style.display = 'none';
  toast('Conversation cleared');
}

/** Send blueprint to Claude to build */
function aiBuildFromBlueprint() {
  if (!state.blueprint) generateBlueprint();
  const bp = state.blueprint;
  const sections = Object.values(bp.sections).map(s => s.id).join(', ');
  document.getElementById('aiPromptInput').value =
    `Generate complete, production-ready implementations for this ${bp.target}.\n\nFor each of these modules: ${sections}\n\nWrite real, working code with:\n- Proper error handling and input validation\n- TypeScript types where appropriate\n- Comments explaining non-obvious logic\n- All imports/exports correctly declared\n\nReturn one fenced code block per module, labeled with the module name as a comment on the first line.`;
  showTab('ai-build');
  aiSend();
}

/** Send current change task to Claude for analysis */
function aiAnalyzeChange() {
  if (!state.blueprint) generateBlueprint();
  const task = val('task');
  document.getElementById('aiPromptInput').value =
    `Analyze the impact of this change on the current blueprint:\n\n"${task}"\n\nFor each affected module:\n1. Explain what needs to change and why\n2. Identify downstream effects and blast radius\n3. Suggest the safest implementation order\n4. Flag any breaking changes or risks\n\nThen provide the updated code for each affected module in separate fenced code blocks.`;
  showTab('ai-build');
  aiSend();
}

/** Extract ALL fenced code blocks from a response */
function extractAllFencedBlocks(text) {
  const blocks = [];
  const regex = /```([a-zA-Z0-9_.-]*)\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const lang = match[1] || 'text';
    const code = match[2].trim();
    // Try to detect module name from first comment line
    const firstLine = code.split('\n')[0];
    const moduleMatch = firstLine.match(/(?:\/\/|#|--|\/\*)\s*([a-z0-9_.-]+(?:\.[a-z]+)?)/i);
    const label = moduleMatch ? moduleMatch[1] : `block-${blocks.length + 1}`;
    blocks.push({ lang, code, label, index: blocks.length });
  }
  return blocks;
}

function renderAiCodeBlocks(blocks) {
  const el = document.getElementById('aiCodeBlocks');
  if (!blocks.length) { el.innerHTML = 'No fenced code blocks in this response.'; return; }
  el.innerHTML = blocks.map((b, i) => `
    <div class="codeBlockCard">
      <div class="codeBlockHeader">
        <span class="badge">${escapeHtml(b.lang)}</span>
        <span class="codeBlockLabel">${escapeHtml(b.label)}</span>
        <div class="buttonRow" style="margin:0;gap:6px">
          <button onclick="applyBlockToSection(${i})" class="primary" style="padding:6px 10px;font-size:12px">Apply to section</button>
          <button onclick="copyBlock(${i})" style="padding:6px 10px;font-size:12px">Copy</button>
        </div>
      </div>
      <pre class="codeBlock" style="max-height:280px">${escapeHtml(b.code)}</pre>
    </div>
  `).join('');
}

function applyBlockToSection(idx) {
  const block = state.aiCodeBlocks[idx];
  if (!block || !state.blueprint) return;
  // Try to find matching section
  const sectionId = Object.keys(state.blueprint.sections).find(id =>
    block.label.toLowerCase().includes(id.toLowerCase()) ||
    id.toLowerCase().includes(block.label.toLowerCase())
  );
  if (sectionId) {
    state.blueprint.sections[sectionId].code = block.code;
    state.blueprint.changelog.push({ date: today(), actor: 'AI Build Engine', change: `Applied ${getProviderLabel()}-generated code to section: ${sectionId}` });
    state.blueprint.version = bumpVersion(state.blueprint.version);
    runValidation();
    render();
    autosave();
    toast(`Applied to section: ${sectionId}`);
  } else {
    // Create new section
    const newId = block.label.replace(/[^a-z0-9._-]/gi, '-').toLowerCase();
    const lang = block.lang;
    const type = lang === 'sql' ? 'database' : lang === 'bash' || lang === 'sh' ? 'ops' : newId.startsWith('ui') ? 'frontend' : newId.startsWith('api') ? 'backend' : 'service';
    state.blueprint.sections[newId] = {
      id: newId, type, layer: 'Business logic',
      purpose: `AI-generated: ${newId}`,
      dependsOn: [], usedBy: [], code: block.code
    };
    state.blueprint.index.push({ id: newId, order: state.blueprint.index.length + 1, type, layer: 'Business logic' });
    state.blueprint.changelog.push({ date: today(), actor: 'AI Build Engine', change: `Created new section from ${getProviderLabel()} output: ${newId}` });
    runValidation();
    render();
    autosave();
    toast(`Created new section: ${newId}`);
  }
}

function applyAllBlocks() {
  if (!state.aiCodeBlocks.length) return;
  state.aiCodeBlocks.forEach((_, i) => applyBlockToSection(i));
  toast(`Applied ${state.aiCodeBlocks.length} block(s)`);
}

function copyBlock(idx) {
  const block = state.aiCodeBlocks[idx];
  if (block) { navigator.clipboard.writeText(block.code); toast('Copied'); }
}

function renderAiHistory() {
  const el = document.getElementById('aiHistory');
  if (!state.aiConversation.length) { el.innerHTML = 'No messages yet.'; return; }
  el.innerHTML = state.aiConversation.map(msg => `
    <div class="historyMsg ${msg.role}">
      <div class="historyRole">${msg.role === 'user' ? '👤 You' : `🤖 ${getProviderLabel()}`}</div>
      <div class="historyContent">${escapeHtml(msg.content.slice(0, 800))}${msg.content.length > 800 ? '…' : ''}</div>
    </div>
  `).join('');
}

function bumpVersion(v) {
  const parts = (v || '0.5.0').split('.').map(Number);
  parts[2] = (parts[2] || 0) + 1;
  return parts.join('.');
}

// ─── CREATION ─────────────────────────────────────────────────────────────────
function ideaSample(){ return 'Build a CRM for plumbers with customers, jobs, quotes, invoices, reminders, payments, mobile job sheets and an admin dashboard.'; }
function guidedSample(){ return sampleGuide(); }
function reverseSample(){ return `# Old Project Manifest\n\n/src/pages/dashboard.jsx\n/src/pages/customers.jsx\n/src/api/jobs.js\n/src/api/invoices.js\n/src/services/sms.js\n/src/services/payments.js\n/schema/customers.sql\n/schema/jobs.sql\n/schema/invoices.sql\n\nWiring\nui.dashboard -> api.jobs\nui.customers -> api.customers\napi.jobs -> db.jobs\napi.jobs -> svc.notifications\napi.invoices -> db.invoices\napi.invoices -> svc.payments\nsvc.payments -> svc.notifications\n\nRules\n- Never change payment flow without testing invoices\n- Always update customer history when a job is completed`; }

function createFromAnything(){
  const mode=document.getElementById('creationMode')?.value || 'idea';
  const raw=val('creationInput');
  if(!raw){ toast('Add an idea, guide or project manifest first'); return; }
  const nameGuess=(raw.match(/(?:build|make|create) (?:a|an)?\s*([^\.\n]{5,60})/i)||[])[1];
  if(nameGuess && (!val('projectName') || val('projectName')==='InvoiceFlow')) document.getElementById('projectName').value=pascal(nameGuess).slice(0,32)||'WireStackApp';
  document.getElementById('brief').value=raw.split(/\n/).find(x=>x.trim().length>25 && !x.trim().startsWith('#')) || raw.slice(0,240);
  state.blueprint=buildBlueprint();
  state.blueprint.creation={mode, sourcePreview:raw.slice(0,800), createdAt:new Date().toISOString(), principle:'Everything becomes a blueprint.'};
  const type=mode==='idea'?'pasted idea':mode==='guided'?'guide.md':'folder manifest';
  document.getElementById('sourceType').value=type;
  document.getElementById('guideInput').value=raw;
  state.ingestion=ingestSource(raw,type);
  state.knowledge=buildKnowledgeGraph(raw,type);
  importCreationIntoBlueprint(mode, raw);
  const preview={ mode, project:state.blueprint.name, detectedModules:state.ingestion.modules.map(m=>m.id), wires:state.ingestion.wires, tasks:state.ingestion.tasks, rules:state.ingestion.rules, knowledgeConcepts:state.knowledge.concepts.slice(0,12).map(c=>c.name) };
  const prev=document.getElementById('creationPreview'); if(prev) prev.textContent=JSON.stringify(preview,null,2);
  render(); autosave(); showTab('overview'); toast('Created blueprint from '+mode);
}

function importCreationIntoBlueprint(mode, raw){
  const bp=state.blueprint, ing=state.ingestion;
  bp.imports ||= [];
  bp.imports.push({date:today(), type:ing.type, title:ing.title, summary:ing.summary, modules:ing.modules.map(m=>m.id), rules:ing.rules, tasks:ing.tasks, creationMode:mode});
  bp.context.sourceMaterial=`${mode}: ${ing.title}. ${ing.summary}`;
  bp.context.purpose=ing.summary || bp.context.purpose;
  bp.context.currentTask=ing.tasks[0] || `Build the first working ${bp.target} from the ${mode} input.`;
  ing.rules.forEach(r=>{ if(!bp.context.rules.includes(r)) bp.context.rules.push(r); });
  ing.modules.forEach(m=>addOrMergeSection(bp,m));
  ing.wires.forEach(([a,b])=>{ if(bp.sections[a] && bp.sections[b] && !bp.wiring.some(w=>w[0]===a&&w[1]===b)) bp.wiring.push([a,b]); });
  if(state.knowledge) bp.knowledgeGraph=state.knowledge;
  bp.version='0.6.0'; renumberIndex();
  bp.changelog.push({date:today(), actor:'Understanding Engine', change:`Created project from ${mode}; converted source into blueprint, wiring, knowledge graph and tasks.`});
  state.highlighted=new Set(ing.modules.map(m=>m.id));
  runValidation(); buildTestPlan(); buildBrain();
}

function sampleGuide(){ return `# Codem8s / WireStack Guide\n\nBuild an AI-native app maker that can import an old project or guide.md and convert it into a living blueprint.\n\n## Features\n- Import README.md, guide.md, pasted idea, folder manifest or old project notes\n- Generate an index of modules\n- Draw a wiring diagram like a telephone exchange\n- Use a Builder Engine to create code sections\n- Use a Validator Engine to check fences, syntax, runtime errors and missing wiring\n- Use a Cartographer Engine to update the map after each code change\n- Export normal project files\n\n## Modules\n- importer: reads old project material and extracts requirements\n- builder: writes code from blueprint sections\n- validator: checks fenced code and reports errors for repair\n- cartographer: maintains index, wiring and changelog\n- ui.editor: blueprint editor and source material editor\n- api.project: saves, loads and exports project manifests\n- db.project: stores imported sources, sections and changes\n\n## Rules\n- Never accept code unless the fence check passes\n- Never mark complete until wiring and changelog are updated\n- If an imported guide conflicts with current blueprint, declare the conflict\n- Always send errors back as a repair request and ask for a corrected code block\n\n## Wiring\nui.editor -> importer\nimporter -> cartographer\ncartographer -> builder\nbuilder -> validator\nvalidator -> cartographer\napi.project -> db.project\nui.editor -> api.project`; }

// ─── INGESTION ────────────────────────────────────────────────────────────────
function analyzeSource(){ const raw=val('guideInput'); if(!raw){ toast('Paste or load a guide first'); return; } const type=document.getElementById('sourceType').value; const report=ingestSource(raw, type); state.ingestion=report; state.knowledge=buildKnowledgeGraph(raw, type); renderImporter(); renderKnowledge(); toast('Source analyzed + knowledge graph built'); }
function importSource(){ state.layoutCache={key:null,pos:null}; if(!state.blueprint) generateBlueprint(); if(!state.ingestion) analyzeSource(); const ing=state.ingestion; if(!ing) return; const bp=state.blueprint; bp.imports ||= [];
  bp.imports.push({ date:today(), type:ing.type, title:ing.title, summary:ing.summary, modules:ing.modules.map(m=>m.id), rules:ing.rules, tasks:ing.tasks, knowledge: state.knowledge ? { concepts: state.knowledge.concepts.length, relations: state.knowledge.relations.length } : null });
  bp.context.sourceMaterial = `${ing.type}: ${ing.title}. ${ing.summary}`;
  bp.context.purpose = ing.summary || bp.context.purpose;
  ing.rules.forEach(r=>{ if(!bp.context.rules.includes(r)) bp.context.rules.push(r); });
  ing.modules.forEach(m=>addOrMergeSection(bp, m));
  ing.wires.forEach(([a,b])=>{ if(bp.sections[a] && bp.sections[b] && !bp.wiring.some(w=>w[0]===a&&w[1]===b)) bp.wiring.push([a,b]); });
  if(state.knowledge) bp.knowledgeGraph = state.knowledge;
  if(ing.tasks.length) bp.context.currentTask = ing.tasks[0];
  bp.version='0.5.1'; renumberIndex(); bp.changelog.push({date:today(), actor:'Importer Engine', change:`Imported ${ing.type} and mapped ${ing.modules.length} modules, ${ing.wires.length} wires and ${ing.rules.length} rules.`});
  state.highlighted = new Set(ing.modules.map(m=>m.id)); runValidation(); render(); autosave(); showTab('overview'); toast('Imported into living blueprint'); }

function ingestSource(raw, type){ const lines=raw.split(/\r?\n/).map(x=>x.trim()).filter(Boolean); const title=(raw.match(/^#\s+(.+)$/m)||raw.match(/^name:\s*(.+)$/mi)||[])[1] || `${type} import`; const bullets=lines.filter(l=>/^[-*]\s+/.test(l)).map(l=>l.replace(/^[-*]\s+/,''));
  const lower=raw.toLowerCase(); const modules=[]; const wires=[]; const rules=[]; const tasks=[];
  const modRegex=/^[-*]\s*([a-z0-9_.-]+)\s*:\s*(.+)$/gmi; let match;
  while((match=modRegex.exec(raw))){ const id=normalId(match[1]); const purpose=match[2].trim(); if(id.length>1 && !['never','always','if','import','generate','draw','use','export'].includes(id)) modules.push(moduleFromId(id,purpose)); }
  const known=[['importer','Import source material and extract requirements, modules, rules and wiring.'],['builder','Generate or modify code from blueprint sections.'],['validator','Check fences, syntax, runtime risks, missing dependencies and repair prompts.'],['cartographer','Maintain the living index, wiring map, context and changelog.'],['ui.editor','Edit blueprints, guides and source material.'],['api.project','Save, load and export project manifests.'],['db.project','Store imported sources, sections, wiring and changes.']];
  known.forEach(([id,p])=>{ if(lower.includes(id) || lower.includes(id.replace('.',' '))) modules.push(moduleFromId(id,p)); });
  if(lower.includes('payment')||lower.includes('stripe')) modules.push(moduleFromId('svc.payments','Handle payments, subscriptions and provider webhooks.'));
  if(lower.includes('email')||lower.includes('receipt')) modules.push(moduleFromId('svc.email','Send emails, receipts and notifications.'));
  if(lower.includes('auth')||lower.includes('login')) modules.push(moduleFromId('auth','Manage login, sessions and protected routes.'));
  if(lower.includes('database')||lower.includes('store')||lower.includes('db.')) modules.push(moduleFromId('db.project','Store project state, imports and generated sections.'));
  const featureMap=[
    ['customer','ui.customers','Manage customer records, profiles and history.'], ['customers','db.customers','Store customer records and contact details.'],
    ['booking','svc.bookings','Manage booking slots, availability and booking lifecycle.'], ['job','svc.jobs','Track jobs, job status, notes and completion.'],
    ['quote','svc.quotes','Create quotes and convert accepted quotes into jobs or invoices.'], ['invoice','svc.invoices','Create, send and track invoices.'],
    ['dashboard','ui.dashboard','Show operational overview, metrics and quick actions.'], ['admin','ui.admin','Admin dashboard for settings, users and oversight.'],
    ['reminder','svc.notifications','Send reminders and notifications.'], ['notification','svc.notifications','Send reminders and notifications.'], ['sms','svc.notifications','Send SMS or email reminders.'],
    ['mobile','ui.mobile','Mobile friendly interface for field usage.'], ['payment','svc.payments','Handle payments, payment links and provider webhooks.'],
    ['stripe','svc.payments','Handle Stripe payment links, subscriptions and webhooks.'], ['auth','auth','Manage login, sessions, roles and protected routes.'], ['login','auth','Manage login, sessions, roles and protected routes.'],
    ['api','api.core','Expose application routes and backend endpoints.'], ['test','tests','Protect critical behaviour with automated tests.'], ['deploy','deploy','Build and deploy the generated application.']
  ];
  featureMap.forEach(([term,id,purpose])=>{ if(lower.includes(term)) modules.push(moduleFromId(id,purpose)); });
  const has=(id)=>modules.some(m=>m.id===id);
  if(has('ui.dashboard')&&has('svc.jobs')) wires.push(['ui.dashboard','svc.jobs']);
  if(has('ui.dashboard')&&has('svc.invoices')) wires.push(['ui.dashboard','svc.invoices']);
  if(has('ui.customers')&&has('db.customers')) wires.push(['ui.customers','db.customers']);
  if(has('svc.jobs')&&has('db.customers')) wires.push(['svc.jobs','db.customers']);
  if(has('svc.jobs')&&has('svc.notifications')) wires.push(['svc.jobs','svc.notifications']);
  if(has('svc.invoices')&&has('svc.payments')) wires.push(['svc.invoices','svc.payments']);
  if(has('svc.invoices')&&has('svc.notifications')) wires.push(['svc.invoices','svc.notifications']);
  if(has('svc.quotes')&&has('svc.invoices')) wires.push(['svc.quotes','svc.invoices']);
  if(has('auth')&&has('ui.admin')) wires.push(['ui.admin','auth']);
  raw.replace(/([a-z0-9_.-]+)\s*->\s*([a-z0-9_.-]+)/gi, (_,a,b)=>{ wires.push([normalId(a), normalId(b)]); return _; });
  bullets.forEach(b=>{ const bl=b.toLowerCase(); if(bl.startsWith('never')||bl.startsWith('always')||bl.includes('must')||bl.includes('until')||bl.includes('declare')) rules.push(b); else if(bl.includes('import')||bl.includes('generate')||bl.includes('build')||bl.includes('export')||bl.includes('check')) tasks.push(b); });
  const uniqueModules=[...new Map(modules.map(m=>[m.id,m])).values()]; const moduleIds=new Set(uniqueModules.map(m=>m.id));
  wires.forEach(([a,b])=>{ if(!moduleIds.has(a)) uniqueModules.push(moduleFromId(a,`Imported module ${a}.`)); if(!moduleIds.has(b)) uniqueModules.push(moduleFromId(b,`Imported module ${b}.`)); moduleIds.add(a); moduleIds.add(b); });
  const summary=lines.find(l=>!l.startsWith('#') && !l.startsWith('-') && l.length>40) || `Imported source with ${uniqueModules.length} detected modules.`;
  const conflicts=uniqueModules.filter(m=>state.blueprint?.sections?.[m.id]).map(m=>`${m.id} already exists; will merge purpose and dependencies.`);
  return { type, title, summary, modules:uniqueModules, wires:[...new Set(wires.map(w=>w.join('->')))].map(s=>s.split('->')), rules:[...new Set(rules)], tasks:[...new Set(tasks)].slice(0,10), conflicts };
}
function moduleFromId(id,purpose){ const type=id.startsWith('ui.')?'frontend':id.startsWith('api.')?'backend':id.startsWith('db.')?'database':id==='tests'?'quality':id==='deploy'?'ops':'service'; const layer=type==='frontend'?'Experience':type==='backend'?'API':type==='database'?'Data':type==='quality'?'Safety':type==='ops'?'Release':id==='auth'?'Security':id==='importer'?'Ingestion':id==='cartographer'?'Mapping':'Business logic'; return { id, type, layer, purpose, dependsOn:[], usedBy:[], code:starterCode(id,type,purpose) }; }
function starterCode(id,type,purpose){ if(type==='database') return `CREATE TABLE ${id.replace('db.','').replace(/\W/g,'_')} (\n  id TEXT PRIMARY KEY,\n  created_at TEXT NOT NULL\n);`; if(type==='frontend') return `export function ${pascal(id)}() {\n  return <section>${purpose}</section>;\n}`; if(type==='backend') return `router.post('/${id.replace('api.','').replace(/\W/g,'-')}', async (req, res) => {\n  res.json({ ok: true });\n});`; return `export async function ${camel(id)}(input) {\n  // ${purpose}\n  return { ok: true, input };\n}`; }
function addOrMergeSection(bp,m){ const existing=bp.sections[m.id]; if(existing){ existing.purpose = existing.purpose.includes(m.purpose) ? existing.purpose : `${existing.purpose} Imported context: ${m.purpose}`; existing.code = existing.code || m.code; } else { bp.sections[m.id]=m; bp.index.push({id:m.id,order:bp.index.length+1,type:m.type,layer:m.layer}); } }
function normalId(x){ return x.toLowerCase().replace(/[`"']/g,'').replace(/[^a-z0-9_.-]+/g,'.').replace(/^\.+|\.+$/g,''); }

// ─── KNOWLEDGE GRAPH ──────────────────────────────────────────────────────────
const KNOWLEDGE_STOPWORDS = new Set('the a an and or but if then than that this these those is are was were be being been to of in on for with as by from at it its into can could should would will may might such when where which who whom why how about also there their they them we you your our he she his her not no yes do does did done use used using app build create make system project code file files'.split(' '));
function kgTokenize(text){ return (text.toLowerCase().match(/[a-z][a-z0-9_.-]{2,}/g)||[]).filter(w=>!KNOWLEDGE_STOPWORDS.has(w)); }
function kgSentences(text){ return text.replace(/\s+/g,' ').split(/(?<=[.!?])\s+|\n+/).map(s=>s.trim()).filter(s=>s.length>18); }
function buildKnowledgeGraph(raw, type='source'){
  const tokens=kgTokenize(raw); const counts={}; tokens.forEach(t=>counts[t]=(counts[t]||0)+1);
  const concepts=Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,36).map(([name,count])=>({name,count,confidence:Math.min(0.95,0.35+count/18),evidence:[]}));
  const conceptSet=new Set(concepts.map(c=>c.name)); const sentences=kgSentences(raw); const edgeMap={};
  sentences.forEach(sentence=>{ const found=[...new Set(kgTokenize(sentence).filter(t=>conceptSet.has(t)))]; found.forEach(c=>{ const node=concepts.find(x=>x.name===c); if(node && node.evidence.length<3) node.evidence.push(sentence.slice(0,240)); }); for(let i=0;i<found.length;i++){ for(let j=i+1;j<found.length;j++){ const key=[found[i],found[j]].sort().join('::'); edgeMap[key] ||= {a:found[i],b:found[j],weight:0,evidence:[]}; edgeMap[key].weight += 1; if(edgeMap[key].evidence.length<2) edgeMap[key].evidence.push(sentence.slice(0,240)); } } });
  const relations=Object.values(edgeMap).sort((a,b)=>b.weight-a.weight).slice(0,60).map(r=>({...r,confidence:Math.min(0.95,0.35+r.weight/6)}));
  const modules=(state.ingestion?.modules||[]).map(m=>m.id); const questions=makeSelfTests(concepts, relations, modules);
  return { subject: document.getElementById('projectName')?.value || 'WireStack project', sourceType:type, createdAt:new Date().toISOString(), concepts, relations, modules, questions, designContext:{ purpose: sentences[0] || raw.slice(0,180), concepts: concepts.slice(0,15).map(c=>({name:c.name,confidence:c.confidence,evidence:c.evidence[0]||''})), relations: relations.slice(0,25), modules } };
}
function makeSelfTests(concepts, relations, modules){ const qs=[]; relations.slice(0,5).forEach(r=>qs.push({concept:r.a,prompt:`Explain how '${r.a}' relates to '${r.b}' in this app.`,expected:`${r.a} is linked to ${r.b}. Evidence: ${r.evidence[0]||'co-occurrence in source'}`,confidence:r.confidence})); modules.slice(0,5).forEach(m=>qs.push({concept:m,prompt:`What depends on '${m}', and what could break if it changes?`,expected:'Check the wiring map and downstream blast radius before editing.',confidence:0.72})); return qs.slice(0,10); }
function applyKnowledgeToBlueprint(){ if(!state.blueprint) generateBlueprint(); if(!state.knowledge){ const raw=val('guideInput'); if(!raw){ toast('Paste source first'); return; } state.knowledge=buildKnowledgeGraph(raw, document.getElementById('sourceType').value); }
  const bp=state.blueprint; bp.knowledgeGraph=state.knowledge; bp.context.rules.push('Before coding, pass the knowledge self-test for affected modules.'); bp.context.rules=[...new Set(bp.context.rules)]; bp.changelog.push({date:today(),actor:'Knowledge Graph Engine',change:`Added ${state.knowledge.concepts.length} concepts, ${state.knowledge.relations.length} relationships and ${state.knowledge.questions.length} self-test questions to design context.`}); bp.version='0.6.0'; render(); autosave(); showTab('knowledge'); toast('Knowledge graph applied to blueprint'); }
function renderKnowledge(){
  const kg=state.knowledge || state.blueprint?.knowledgeGraph;
  const conceptEl=document.getElementById('conceptList');
  if(!conceptEl) return;
  const visual=document.getElementById('knowledgeVisual');
  if(!kg){
    conceptEl.textContent='No knowledge graph yet.';
    document.getElementById('relationList').textContent='No relationships yet.';
    document.getElementById('selfTestList').textContent='No self-test yet.';
    document.getElementById('designContextView').textContent='No design context yet.';
    if(visual) visual.textContent='No knowledge graph yet.';
    return;
  }
  if(visual) visual.innerHTML = renderKnowledgeCloud(kg);
  conceptEl.innerHTML=kg.concepts.slice(0,20).map(c=>`<button class="kgItem kgAction" data-kg-concept="${escapeHtml(c.name)}"><b>${escapeHtml(c.name)}</b><span>${c.count} hits · ${Math.round(c.confidence*100)}%</span><small>${escapeHtml((c.evidence&&c.evidence[0])||'')}</small></button>`).join('');
  document.getElementById('relationList').innerHTML=kg.relations.slice(0,20).map(r=>`<button class="kgItem kgAction" data-kg-relation="${escapeHtml(r.a)}::${escapeHtml(r.b)}"><b>${escapeHtml(r.a)} → ${escapeHtml(r.b)}</b><span>weight ${r.weight.toFixed(1)} · ${Math.round(r.confidence*100)}%</span><small>${escapeHtml((r.evidence&&r.evidence[0])||'')}</small></button>`).join('');
  document.getElementById('selfTestList').innerHTML=kg.questions.map(q=>`<div class="check">☐ ${escapeHtml(q.prompt)}<br><span class="meta">Expected: ${escapeHtml(q.expected)}</span></div>`).join('');
  document.getElementById('designContextView').textContent=JSON.stringify(kg.designContext,null,2);
  bindKnowledgeActions();
}

function renderKnowledgeCloud(kg){
  const concepts=(kg.concepts||[]).slice(0,28);
  if(!concepts.length) return '<p class="meta">No concepts yet.</p>';
  const max=Math.max(...concepts.map(c=>c.count||1),1);
  const tags=concepts.map(c=>{
    const size=0.85 + ((c.count||1)/max)*1.25;
    const conf=Math.round((c.confidence||0.35)*100);
    return `<button class="kgTag" style="font-size:${size.toFixed(2)}rem" data-kg-concept="${escapeHtml(c.name)}" title="${conf}% confidence">${escapeHtml(c.name)} <span>${conf}%</span></button>`;
  }).join('');
  const links=(kg.relations||[]).slice(0,8).map(r=>`<div class="kgLink"><b>${escapeHtml(r.a)}</b><span>→</span><b>${escapeHtml(r.b)}</b><em>${Math.round((r.confidence||0)*100)}%</em></div>`).join('');
  return `<div class="kgCloud">${tags}</div><div class="kgMiniLinks">${links}</div>`;
}

function bindKnowledgeActions(){
  document.querySelectorAll('[data-kg-concept]').forEach(btn=>btn.onclick=()=>{
    const c=btn.dataset.kgConcept;
    prefillAiPrompt('explainModule', {concept:c, note:`Explain how the concept "${c}" appears in the imported source and which blueprint modules it should influence.`});
  });
  document.querySelectorAll('[data-kg-relation]').forEach(btn=>btn.onclick=()=>{
    const [a,b]=btn.dataset.kgRelation.split('::');
    prefillAiPrompt('explainModule', {concept:`${a} → ${b}`, note:`Explain the relationship ${a} → ${b}, whether it should become wiring, and what tests would prove it.`});
  });
}

// ─── CHANGE ANALYSIS ──────────────────────────────────────────────────────────
// ─── CHANGE ANALYSIS ──────────────────────────────────────────────────────────
function analyzeChange(){ const bp=state.blueprint; const task=val('task'); const words=task.toLowerCase(); const affected=new Set(); Object.keys(bp.sections).forEach(id=>{ const blob=(id+' '+bp.sections[id].purpose).toLowerCase(); if(words.split(/\W+/).some(w=>w.length>4 && blob.includes(w))) affected.add(id); });
  if(words.includes('subscription')||words.includes('recurring')) ['svc.invoices','svc.payments','svc.email','db.invoices','api.invoices','ui.dashboard','tests'].forEach(x=>bp.sections[x]&&affected.add(x));
  if(words.includes('auth')||words.includes('login')) ['auth','db.users','ui.dashboard','tests'].forEach(x=>bp.sections[x]&&affected.add(x));
  if(!affected.size) Object.keys(bp.sections).slice(0,3).forEach(x=>affected.add(x));
  const blast=[...affected].flatMap(id=>dependantsOf(id)).filter(Boolean); const all=[...new Set([...affected,...blast])];
  state.highlighted=new Set(all); state.lastAnalysis={ task, affectedSections:[...affected], downstreamBlastRadius:[...new Set(blast)], risk: all.length>7?'High':all.length>4?'Medium':'Low', requiredUpdates:['Update relevant code sections','Update wiring map if new dependency appears','Run Validator Engine','Add or update tests','Update changelog','Send error report back if rejected'] };
  render(); showTab('ai'); toast('Impact analysis complete'); }
function applySimulatedChange(){ if(!state.lastAnalysis) analyzeChange(); if(!state.blueprintBaseline) captureBlueprintBaseline(false); const bp=state.blueprint; const id='svc.subscriptions'; if(!bp.sections[id]) addOrMergeSection(bp,{ id, type:'service', layer:'Business logic', purpose:'Manage recurring schedules and provider subscriptions.', dependsOn:['svc.payments','svc.email'], usedBy:['api.invoices','ui.dashboard','tests'], code:starterCode(id,'service','Manage recurring schedules and provider subscriptions.') }); ['svc.payments','svc.email'].forEach(dep=>{ if(bp.sections[dep]&&!bp.wiring.some(w=>w[0]===id&&w[1]===dep)) bp.wiring.push([id,dep]); }); bp.context.currentTask=val('task'); bp.version=bumpVersion(bp.version); bp.changelog.push({date:today(),actor:'WireStack AI',change:`Applied simulated safe change: ${val('task')}`}); state.highlighted=new Set([id,'svc.payments','svc.email','tests']); runValidation(); render(); autosave(); showTab('validator'); toast('Change applied and validated'); }

// ─── VALIDATOR ────────────────────────────────────────────────────────────────
function extractFencedCode(raw){ const matches=[...raw.matchAll(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g)]; const errors=[]; if(matches.length===0) errors.push('FENCE_ERROR: No fenced code block found. Return exactly one fenced code block.'); if(matches.length>1) errors.push(`FENCE_ERROR: ${matches.length} fenced code blocks found. Return exactly one.`); if(matches.length===1){ const lang=(matches[0][1]||'').toLowerCase(); if(lang && !['js','javascript','ts','typescript','sql','bash','sh','python','py','html','css'].includes(lang)) errors.push(`FENCE_ERROR: Unsupported fence language "${lang}".`); return { code:matches[0][2].trim(), language:lang||'text', errors }; } return { code:raw.trim(), language:'text', errors }; }
function pseudoSyntaxCheck(code, lang){ const errors=[]; for(const [o,c] of [['(',')'],['[',']'],['{','}']]){ let n=0; for(const ch of code){ if(ch===o)n++; if(ch===c)n--; if(n<0){errors.push(`SYNTAX_ERROR: Unexpected closing ${c}.`); break;} } if(n>0) errors.push(`SYNTAX_ERROR: Missing ${c}.`); } if(/TODO_THROW|BROKEN_CODE|undefinedFunction/.test(code)) errors.push('RUNTIME_RISK: Placeholder or known broken symbol detected.'); return errors; }
function runValidation(){ const bp=state.blueprint; const errors=[]; const warnings=[]; const codeReports=[]; validate(bp).forEach(x=>errors.push('MAP_ERROR: '+x)); Object.values(bp.sections).forEach(s=>{ if(!s.purpose) warnings.push(`CONTEXT_WARNING: ${s.id} has no purpose.`); const lang=inferLang(s); const syntax=pseudoSyntaxCheck(s.code,lang); syntax.forEach(e=>(e.includes('WARNING')?warnings:errors).push(`${s.id}: ${e}`)); codeReports.push({section:s.id, language:lang, codeBytes:s.code.length, syntaxIssues:syntax}); }); if(!bp.changelog?.length) errors.push('CHANGELOG_ERROR: Missing changelog.'); if(!bp.context?.sourceMaterial) warnings.push('IMPORT_WARNING: No source material has been imported yet.'); const status=errors.length?'REJECTED':'PASSED'; state.validationReport={status, summary:{errors:errors.length,warnings:warnings.length,sections:Object.keys(bp.sections).length,wires:bp.wiring.length}, errors, warnings, codeReports}; state.repairPrompt=buildRepairPrompt(); render(); toast(`Validation ${status.toLowerCase()}`); }
function buildRepairPrompt(){ const r=state.validationReport; if(!r) return 'Run validation first.'; return `The previous output was rejected by WireStack Validator.\n\nReturn a corrected replacement in exactly one fenced code block.\n\nErrors:\n${r.errors.map(e=>'- '+e).join('\n') || '- none'}\n\nWarnings to consider:\n${r.warnings.map(w=>'- '+w).join('\n') || '- none'}\n\nRules:\n- Do not include explanations outside the code fence.\n- Update code and the living map together.\n- If dependencies change, update wiring and changelog.`; }
function simulateBadAI(){ document.getElementById('rawCodeInput').value = "Here is some code, but it has two blocks.\n```javascript\nexport function broken() {\n  undefinedFunction(\n}\n```\n```text\nextra block\n```"; runFenceCheck(); }
function runFenceCheck(){ const raw=val('rawCodeInput'); const result=extractFencedCode(raw); const syntax=result.code?pseudoSyntaxCheck(result.code,result.language):[]; const report={ status:[...result.errors,...syntax].length?'REJECTED':'PASSED', language:result.language, fenceErrors:result.errors, syntaxErrors:syntax }; document.getElementById('fenceReport').textContent=JSON.stringify(report,null,2); document.getElementById('extractedCode').textContent=result.code||'No code extracted.'; }

function validate(bp){ const issues=[]; if(!bp) return ['No blueprint loaded']; const ids=new Set(Object.keys(bp.sections||{})); (bp.index||[]).forEach(i=>{ if(!ids.has(i.id)) issues.push(`Index item ${i.id} has no matching section`); }); Object.values(bp.sections||{}).forEach(s=>{ (s.dependsOn||[]).forEach(d=>{ if(!ids.has(d) && d!=='users' && d!=='release') issues.push(`${s.id} depends on missing section ${d}`); if(ids.has(d) && !bp.wiring.some(([a,b])=>a===s.id&&b===d)) issues.push(`${s.id} depends on ${d} but wiring is missing`); }); }); (bp.wiring||[]).forEach(([a,b])=>{ if(!ids.has(a) && a!=='users' && a!=='release') issues.push(`Wire source ${a} has no section`); if(!ids.has(b) && b!=='users' && b!=='release') issues.push(`Wire target ${b} has no section`); }); return [...new Set(issues)]; }
function dependantsOf(id){ return Object.values(state.blueprint.sections).filter(s=>(s.dependsOn||[]).includes(id)).map(s=>s.id); }
function renumberIndex(){ state.blueprint.index.forEach((x,i)=>x.order=i+1); }

// ─── RENDER ───────────────────────────────────────────────────────────────────
function render(){ const bp=state.blueprint; if(!bp) return; const issues=validate(bp); text('appTitle', bp.name); text('appSummary', `${bp.target}: ${bp.context.purpose}`); text('moduleCount', Object.keys(bp.sections).length); text('wireCount', bp.wiring.length); text('version', bp.version); text('riskLevel', state.lastAnalysis?.risk || 'Low'); document.getElementById('blueprintText').value = blueprintToText(bp); document.getElementById('contextView').textContent = JSON.stringify(bp.context,null,2); document.getElementById('indexList').innerHTML = bp.index.map(i=>`<li><span>${i.order}. ${i.id}</span><span><span class="badge">${i.layer}</span> <span class="badge">${i.type}</span></span></li>`).join(''); document.getElementById('changelog').innerHTML = bp.changelog.slice().reverse().map(c=>`<div>${c.date} · ${c.actor}: ${escapeHtml(c.change)}</div>`).join(''); renderHealthScore(); renderCreation(); renderImporter(); renderKnowledge(); renderSections(bp); renderDiagram(bp); renderAI(bp); renderValidator(); renderTesting(); renderChangeMemory(); renderAgentWorkspace(); renderDeployment(); renderQutri(); renderBrain(); renderExport(bp); renderStatePanel(); renderAiHistory(); renderBlueprintDiff(); renderGuidedMode(); renderWizardMode(); }
function renderCreation(){
  const prev=document.getElementById('creationPreview'); if(!prev) return;
  if(state.blueprint?.creation && state.ingestion){
    prev.textContent=JSON.stringify({mode:state.blueprint.creation.mode, project:state.blueprint.name, modules:state.ingestion.modules.map(m=>m.id), wires:state.ingestion.wires, knowledgeConcepts:(state.knowledge?.concepts||[]).slice(0,10).map(c=>c.name)},null,2);
  }
}
function renderImporter(){ const ing=state.ingestion; const rep=document.getElementById('ingestionReport'); if(!rep) return; rep.textContent=ing?JSON.stringify({title:ing.title,type:ing.type,summary:ing.summary,modules:ing.modules.length,wires:ing.wires.length,rules:ing.rules.length,tasks:ing.tasks.length,conflicts:ing.conflicts},null,2):'No source analyzed yet.'; document.getElementById('detectedModules').innerHTML=ing?ing.modules.map(m=>`<span class="badge">${m.id}</span>`).join(''):'<p class="meta">None yet.</p>'; document.getElementById('detectedRules').innerHTML=ing?[...ing.rules,...ing.tasks].map(r=>`<span class="badge wide">${escapeHtml(r)}</span>`).join(''):'<p class="meta">None yet.</p>'; }
function renderSections(bp){ const q=(document.getElementById('sectionSearch')?.value||'').toLowerCase(); document.getElementById('sectionCards').innerHTML=Object.values(bp.sections).filter(s=>!q||JSON.stringify(s).toLowerCase().includes(q)).map(s=>`<article class="card sectionCard ${state.highlighted.has(s.id)?'hot':''}"><h3>${s.id} <span class="badge">${s.type}</span></h3><p>${escapeHtml(s.purpose)}</p><p class="meta"><b>Layer:</b> ${s.layer}</p><p class="meta"><b>Depends on:</b> ${(s.dependsOn||[]).join(', ')||'none'}</p><p class="meta"><b>Used by:</b> ${dependantsOf(s.id).join(', ')||(s.usedBy||[]).join(', ')||'none'}</p><pre class="codeBlock">${escapeHtml(s.code)}</pre></article>`).join(''); }
function renderDiagram(bp){
  const el=document.getElementById('diagram');
  if(!el || !bp) return;
  const ids=[...new Set([...Object.keys(bp.sections||{}),'users','release'])];
  const wires=(bp.wiring||[]).filter(([a,b])=>ids.includes(a)&&ids.includes(b));
  const pos=getCachedForceLayout(ids, wires, bp.sections||{}, el.clientWidth||980, el.clientHeight||620);
  let edgeSvg=wires.map(([from,to])=>{
    const a=pos[from], b=pos[to]; if(!a||!b) return '';
    const hot=state.highlighted.has(from)||state.highlighted.has(to);
    return `<line class="svgEdge ${hot?'hot':''}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" />`;
  }).join('');
  let nodes=ids.map(id=>{
    const p=pos[id];
    const s=bp.sections[id];
    const deps=(s?.dependsOn||[]).length;
    const used=wires.filter(([a,b])=>b===id).length;
    return `<button class="node forceNode ${state.highlighted.has(id)?'hot':''}" data-diagram-node="${escapeHtml(id)}" style="left:${p.x-82}px;top:${p.y-30}px"><b>${escapeHtml(id)}</b><small>${escapeHtml(s?.layer||'Boundary')} · ${deps} deps · ${used} uses</small></button>`;
  }).join('');
  el.innerHTML=`<svg class="wireSvg" viewBox="0 0 ${Math.max(el.clientWidth||980,980)} ${Math.max(el.clientHeight||620,620)}" preserveAspectRatio="none">${edgeSvg}</svg>${nodes}`;
  document.querySelectorAll('[data-diagram-node]').forEach(btn=>btn.onclick=()=>{
    const id=btn.dataset.diagramNode;
    state.highlighted=new Set([id,...dependantsSafe(id),...(state.blueprint?.sections?.[id]?.dependsOn||[])]);
    prefillAiPrompt('explainModule', {module:id, note:`Explain module ${id}, its dependencies, dependants, risks, and what changes would affect it.`});
    render();
    showTab('ai-build');
  });
}

function layoutSignature(ids, wires, sections, width=980, height=620){
  const shape={
    width:Math.round(Math.max(width,980)/40)*40,
    height:Math.round(Math.max(height,620)/40)*40,
    ids:[...ids].sort(),
    wires:[...wires].map(w=>w.join('->')).sort(),
    layers:Object.fromEntries(Object.keys(sections||{}).sort().map(id=>[id,sections[id]?.layer||'']))
  };
  return JSON.stringify(shape);
}
function getCachedForceLayout(ids, wires, sections, width=980, height=620){
  const key=layoutSignature(ids,wires,sections,width,height);
  if(state.layoutCache?.key===key && state.layoutCache.pos) return state.layoutCache.pos;
  const pos=computeForceLayout(ids,wires,sections,width,height);
  state.layoutCache={key,pos};
  return pos;
}
function computeForceLayout(ids, wires, sections, width=980, height=620){
  width=Math.max(width,980); height=Math.max(height,620);
  const pos={};
  const layerOrder=['Experience','Ingestion','API','Security','Mapping','Business logic','External service','Data','Safety','Release','Boundary'];
  const idsByLayer={};
  ids.forEach(id=>{
    const layer=sections[id]?.layer || (id==='users'?'Experience':id==='release'?'Release':'Boundary');
    (idsByLayer[layer] ||= []).push(id);
  });

  // Large imported projects do not need expensive all-pairs force simulation.
  // Use a stable layered layout that scales linearly and stays readable.
  if(ids.length > 70){
    const activeLayers=layerOrder.filter(l=>idsByLayer[l]?.length).concat(Object.keys(idsByLayer).filter(l=>!layerOrder.includes(l)));
    const colCount=Math.max(1,activeLayers.length);
    activeLayers.forEach((layer,li)=>{
      const list=idsByLayer[layer] || [];
      list.sort();
      list.forEach((id,ri)=>{
        const x=90+li*((width-180)/Math.max(1,colCount-1));
        const y=60+(ri+0.5)*((height-120)/Math.max(1,list.length));
        pos[id]={x,y};
      });
    });
    return pos;
  }

  ids.forEach((id,i)=>{
    const layer=sections[id]?.layer || (id==='users'?'Experience':id==='release'?'Release':'Boundary');
    const li=Math.max(0,layerOrder.indexOf(layer));
    const angle=(i/Math.max(1,ids.length))*Math.PI*2;
    pos[id]={x:80+li*((width-160)/Math.max(1,layerOrder.length-1)), y:height/2+Math.sin(angle)*(height*0.32)};
  });

  // Adaptive iteration count keeps the UI responsive as the graph grows.
  const iterations = ids.length > 45 ? 45 : ids.length > 30 ? 70 : 120;
  for(let iter=0;iter<iterations;iter++){
    const fx=Object.fromEntries(ids.map(id=>[id,0])), fy=Object.fromEntries(ids.map(id=>[id,0]));
    for(let i=0;i<ids.length;i++) for(let j=i+1;j<ids.length;j++){
      const a=ids[i], b=ids[j]; let dx=pos[a].x-pos[b].x, dy=pos[a].y-pos[b].y; let d=Math.max(20,Math.hypot(dx,dy));
      const rep=ids.length>40 ? 1500/(d*d) : 2400/(d*d);
      fx[a]+=dx/d*rep; fy[a]+=dy/d*rep; fx[b]-=dx/d*rep; fy[b]-=dy/d*rep;
    }
    wires.forEach(([a,b])=>{ if(!pos[a]||!pos[b]) return; let dx=pos[b].x-pos[a].x, dy=pos[b].y-pos[a].y; let d=Math.max(20,Math.hypot(dx,dy)); const pull=(d-180)*0.006; fx[a]+=dx/d*pull; fy[a]+=dy/d*pull; fx[b]-=dx/d*pull; fy[b]-=dy/d*pull; });
    ids.forEach(id=>{
      const layer=sections[id]?.layer || (id==='users'?'Experience':id==='release'?'Release':'Boundary');
      const li=Math.max(0,layerOrder.indexOf(layer)); const anchorX=80+li*((width-160)/Math.max(1,layerOrder.length-1));
      fx[id]+=(anchorX-pos[id].x)*0.02;
      const step=ids.length>40 ? 7 : 10;
      pos[id].x=Math.max(90,Math.min(width-90,pos[id].x+fx[id]*step));
      pos[id].y=Math.max(50,Math.min(height-50,pos[id].y+fy[id]*step));
    });
  }
  return pos;
}
function dependantsSafe(id){ try{return dependantsOf(id)}catch{return []} }

function renderAI(bp){ document.getElementById('analysisView').textContent = state.lastAnalysis ? JSON.stringify(state.lastAnalysis,null,2) : 'No analysis yet.'; document.getElementById('checklist').innerHTML=(state.lastAnalysis?.requiredUpdates||['Import old guide/project if available','Read context','Check wiring','Identify blast radius','Make smallest safe change','Run Validator Engine','Update map + changelog']).map(x=>`<div class="check">☐ ${x}</div>`).join(''); document.getElementById('promptView').textContent=`You are WireStack AI. You may edit code only after maintaining the living map.\n\nProtocol:\n1. Ingest any guide.md, README, file tree or old project notes.\n2. Convert source material into context, modules, wiring, rules and tasks.\n3. Read index and wiring.\n4. Identify affected sections, upstream dependencies and downstream blast radius.\n5. Make the smallest safe code change.\n6. Run Validator Engine.\n7. Update sections, wiring, imports, tests and changelog.\n\nApp: ${bp.name}\nTarget: ${bp.target}\nTask: ${bp.context.currentTask}`; }
function renderValidator(){ const r=state.validationReport; document.getElementById('validationStatus').textContent=r?`${r.status} · ${r.summary.errors} errors · ${r.summary.warnings} warnings`:'Not run yet'; document.getElementById('validationReport').textContent=r?JSON.stringify(r,null,2):'Run validation to check fences, code shape, dependencies, wiring, tests and changelog.'; document.getElementById('repairPrompt').textContent=state.repairPrompt||'No repair request yet.'; }
function renderExport(bp){ const files=projectFiles(bp); document.getElementById('fileTree').innerHTML=Object.keys(files).map(f=>`<div>${f}</div>`).join(''); }
function projectFiles(bp){ const files={'app.wire':blueprintToText(bp),'README.md':`# ${bp.name}\n\nGenerated by WireStack Studio.\n\nTarget: ${bp.target}\n`,'wirestack.project.json':JSON.stringify(bp,null,2)}; Object.values(bp.sections).forEach(s=>{ const dir=s.type==='frontend'?'src/frontend':s.type==='database'?'schema':s.type==='quality'?'tests':s.type==='ops'?'deploy':'src/modules'; const ext=s.type==='database'?'.sql':s.type==='ops'?'.sh':'.js'; files[`${dir}/${s.id.replace(/\./g,'-')}${ext}`]=s.code; }); return files; }
function exportProject(){ if(!state.blueprint) generateBlueprint(); download(`${state.blueprint.name}-wirestack-export.json`, JSON.stringify(projectFiles(state.blueprint),null,2), 'application/json'); toast('Export downloaded'); }
function copyManifest(){ navigator.clipboard.writeText(JSON.stringify(projectFiles(state.blueprint),null,2)); toast('Manifest copied'); }
function blueprintToText(bp){ return `<wire-app name="${bp.name}" version="${bp.version}" target="${bp.target}">\n  <context>\n    <purpose>${escXml(bp.context.purpose)}</purpose>\n    <current-task>${escXml(bp.context.currentTask)}</current-task>\n  </context>\n\n  <index>\n${bp.index.map(i=>`    <item id="${i.id}" type="${i.type}" layer="${i.layer}" />`).join('\n')}\n  </index>\n\n  <wiring>\n${bp.wiring.map(([a,b])=>`    <wire from="${a}" to="${b}" />`).join('\n')}\n  </wiring>\n</wire-app>`; }


// ─── BLUEPRINT DIFF ENGINE ───────────────────────────────────────────────────
function cloneBlueprint(bp){ return JSON.parse(JSON.stringify(bp || {})); }
function summarizeBlueprint(bp){
  if(!bp) return {name:'none', version:'—', modules:0, wires:0, health:null, qutri:{}};
  const q = qutriSnapshotFor(bp);
  return { name:bp.name, version:bp.version, target:bp.target, modules:Object.keys(bp.sections||{}).length, wires:(bp.wiring||[]).length, health:calculateHealthForBlueprint(bp), qutri:q };
}
function qutriSnapshotFor(bp){
  const old = state.blueprint;
  state.blueprint = bp;
  let out = {};
  try { Object.values(bp.sections||{}).forEach(s=>out[s.id]=qutriOf(s).state); }
  finally { state.blueprint = old; }
  return out;
}
function calculateHealthForBlueprint(bp){
  const old = state.blueprint;
  state.blueprint = bp;
  let score = 0;
  try { score = calculateProjectHealth().score; }
  catch(e){ score = 0; }
  finally { state.blueprint = old; }
  return score;
}
function captureBlueprintBaseline(show=true){
  if(!state.blueprint) return;
  state.blueprintBaseline = { capturedAt:new Date().toISOString(), blueprint:cloneBlueprint(state.blueprint), summary:summarizeBlueprint(state.blueprint) };
  state.blueprintDiff = null;
  autosave();
  if(show){ renderBlueprintDiff(); toast('Blueprint baseline captured'); }
}
function wireKey(w){ return Array.isArray(w) ? `${w[0]} -> ${w[1]}` : String(w); }
function sectionFingerprint(s){ return JSON.stringify({purpose:s?.purpose||'', type:s?.type||'', layer:s?.layer||'', dependsOn:[...(s?.dependsOn||[])].sort(), code:s?.code||''}); }
function diffBlueprints(before, after){
  const bSecs=before?.sections||{}, aSecs=after?.sections||{};
  const bIds=new Set(Object.keys(bSecs)), aIds=new Set(Object.keys(aSecs));
  const added=[...aIds].filter(x=>!bIds.has(x)).sort();
  const removed=[...bIds].filter(x=>!aIds.has(x)).sort();
  const modified=[...aIds].filter(x=>bIds.has(x) && sectionFingerprint(aSecs[x])!==sectionFingerprint(bSecs[x])).sort();
  const bW=new Set((before?.wiring||[]).map(wireKey)), aW=new Set((after?.wiring||[]).map(wireKey));
  const wiresAdded=[...aW].filter(x=>!bW.has(x)).sort();
  const wiresRemoved=[...bW].filter(x=>!aW.has(x)).sort();
  const oldQ=qutriSnapshotFor(before), newQ=qutriSnapshotFor(after);
  const qutriChanges=Object.keys({...oldQ,...newQ}).filter(id=>oldQ[id]!==newQ[id]).sort().map(id=>({id, before:oldQ[id]||'NONE', after:newQ[id]||'NONE'}));
  const affected=new Set([...added,...removed,...modified]);
  [...wiresAdded,...wiresRemoved].forEach(w=>w.split(' -> ').forEach(id=>affected.add(id)));
  const downstream=[];
  const walk=(id,seen=new Set())=>{
    (after?.wiring||[]).forEach(([from,to])=>{ if(to===id && !seen.has(from)){ seen.add(from); downstream.push(from); walk(from,seen); } });
  };
  [...affected].forEach(id=>walk(id));
  const impact=[...new Set([...affected,...downstream])].filter(Boolean).sort();
  const healthBefore=calculateHealthForBlueprint(before), healthAfter=calculateHealthForBlueprint(after);
  const delta=healthAfter-healthBefore;
  const risk=(qutriChanges.some(q=>q.after==='CONFLICTED') || wiresRemoved.length || removed.length) ? 'High' : (impact.length>6 || modified.length>3 ? 'Medium' : 'Low');
  const repair=[];
  if(removed.length) repair.push('Review removed modules and any dependants before accepting.');
  if(wiresRemoved.length) repair.push('Confirm removed wires do not break runtime flows.');
  if(qutriChanges.some(q=>q.after==='CONFLICTED')) repair.push('Resolve conflicted Qutri states before more building.');
  if(delta<0) repair.push('Health score dropped; run validation and watchdog tests.');
  if(!repair.length) repair.push('No blocking repair signals detected. Run validation and tests to verify.');
  return {createdAt:new Date().toISOString(), before:summarizeBlueprint(before), after:summarizeBlueprint(after), modules:{added,removed,modified}, wiring:{added:wiresAdded,removed:wiresRemoved}, qutriChanges, impactRadius:impact, healthDelta:{before:healthBefore, after:healthAfter, delta}, risk, repairSummary:repair};
}
function runBlueprintDiff(show=true){
  if(!state.blueprint) generateBlueprint();
  if(!state.blueprintBaseline) captureBlueprintBaseline(false);
  state.blueprintDiff = diffBlueprints(state.blueprintBaseline.blueprint, state.blueprint);
  autosave(); renderBlueprintDiff(); if(show){ showTab('diff'); toast('Blueprint diff generated'); }
}
function acceptBlueprintBaseline(){ captureBlueprintBaseline(false); renderBlueprintDiff(); toast('Current blueprint accepted as baseline'); }
function renderBlueprintDiff(){
  const base=document.getElementById('diffBaselineMeta'); if(!base) return;
  const cur=state.blueprint ? summarizeBlueprint(state.blueprint) : null;
  base.innerHTML = state.blueprintBaseline ? `<b>${escapeHtml(state.blueprintBaseline.summary.name)}</b><br>v${escapeHtml(state.blueprintBaseline.summary.version)} · ${state.blueprintBaseline.summary.modules} modules · ${state.blueprintBaseline.summary.wires} wires<br><span>${escapeHtml(state.blueprintBaseline.capturedAt.slice(0,19))}</span>` : 'No baseline captured.';
  document.getElementById('diffCurrentMeta').innerHTML = cur ? `<b>${escapeHtml(cur.name)}</b><br>v${escapeHtml(cur.version)} · ${cur.modules} modules · ${cur.wires} wires<br><span>Health ${cur.health}%</span>` : 'No blueprint loaded.';
  const d=state.blueprintDiff;
  document.getElementById('diffHealthDelta').textContent = d ? `${d.healthDelta.delta>=0?'+':''}${d.healthDelta.delta}%` : '—';
  const risk=document.getElementById('diffRisk'); risk.textContent=d?d.risk:'—'; risk.className='statusPill '+(d?.risk==='High'?'danger':d?.risk==='Medium'?'warn':'ok');
  const list=(items,cls)=>items.length?items.map(x=>`<div class="diffItem ${cls}">${escapeHtml(typeof x==='string'?x:JSON.stringify(x))}</div>`).join(''):'<div class="meta">No changes.</div>';
  document.getElementById('diffModules').innerHTML = d ? `<h3>Added</h3>${list(d.modules.added,'add')}<h3>Modified</h3>${list(d.modules.modified,'mod')}<h3>Removed</h3>${list(d.modules.removed,'remove')}` : 'Run a diff.';
  document.getElementById('diffWiring').innerHTML = d ? `<h3>Added</h3>${list(d.wiring.added,'add')}<h3>Removed</h3>${list(d.wiring.removed,'remove')}` : 'Run a diff.';
  document.getElementById('diffQutri').innerHTML = d ? (d.qutriChanges.length?d.qutriChanges.map(q=>`<div class="diffItem mod"><b>${escapeHtml(q.id)}</b>: ${escapeHtml(q.before)} → ${escapeHtml(q.after)}</div>`).join(''):'<div class="meta">No Qutri state changes.</div>') : 'Run a diff.';
  document.getElementById('diffImpact').innerHTML = d ? (d.impactRadius.length?d.impactRadius.map(x=>`<span class="badge wide">${escapeHtml(x)}</span>`).join(''):'<span class="badge wide">No impact</span>') : 'Run a diff.';
  document.getElementById('diffSummary').textContent = d ? JSON.stringify({risk:d.risk, healthDelta:d.healthDelta, modules:d.modules, wiring:d.wiring, impactRadius:d.impactRadius, repairSummary:d.repairSummary},null,2) : 'Run a diff to produce the change summary.';
}
function exportBlueprintDiff(){ if(!state.blueprintDiff) runBlueprintDiff(false); download(`${state.blueprint?.name||'wirestack'}-blueprint-diff.json`, JSON.stringify(state.blueprintDiff,null,2), 'application/json'); }

// ─── PERSISTENCE ──────────────────────────────────────────────────────────────
function makeSnapshot(){ return { kind:'wirestack.project.snapshot', schemaVersion:1, savedAt:new Date().toISOString(), paused:state.paused, autosave:state.autosave, blueprint:state.blueprint, lastAnalysis:state.lastAnalysis, validationReport:state.validationReport, repairPrompt:state.repairPrompt, highlighted:[...state.highlighted], ingestion:state.ingestion, knowledge:state.knowledge, testingReport:state.testingReport, testPlan:state.testPlan, changeMemory:state.changeMemory, agents:state.agents, deployment:state.deployment, brain:state.brain, qutri:state.qutri, blueprintBaseline:state.blueprintBaseline, blueprintDiff:state.blueprintDiff, wizardStep:state.wizardStep, engineLog:state.engineLog.slice(-50), aiConversation:state.aiConversation, aiCodeBlocks:state.aiCodeBlocks }; }
function restoreSnapshot(snap){ if(!snap) throw new Error('Empty snapshot'); const data = snap.blueprint ? snap : { blueprint:snap }; state.blueprint=data.blueprint; state.blueprint.imports ||= []; state.lastAnalysis=data.lastAnalysis||null; state.validationReport=data.validationReport||null; state.repairPrompt=data.repairPrompt||''; state.highlighted=new Set(data.highlighted||[]); state.ingestion=data.ingestion||null; state.knowledge=data.knowledge||data.blueprint?.knowledgeGraph||null; state.paused=!!data.paused; state.autosave=data.autosave!==false; state.testingReport=data.testingReport||null; state.testPlan=data.testPlan||null; state.changeMemory=data.changeMemory||[]; state.agents=data.agents||null; state.deployment=data.deployment||null; state.brain=data.brain||null; state.qutri=data.qutri||null; state.blueprintBaseline=data.blueprintBaseline||null; state.blueprintDiff=data.blueprintDiff||null; state.wizardStep=data.wizardStep||0; state.engineLog=data.engineLog||[]; state.lastSavedAt=data.savedAt||null; state.aiConversation=data.aiConversation||[]; state.aiCodeBlocks=data.aiCodeBlocks||[]; render(); toast('Project loaded'); }
function save(){ const snap=makeSnapshot(); localStorage.setItem('wirestack.snapshot', JSON.stringify(snap)); if(state.blueprint) localStorage.setItem('wirestack.integrated', JSON.stringify(state.blueprint)); state.lastSavedAt=snap.savedAt; renderStatePanel(); toast('Snapshot saved'); }
function load(){ const raw=localStorage.getItem('wirestack.snapshot') || localStorage.getItem('wirestack.integrated'); if(!raw) return false; try{ restoreSnapshot(JSON.parse(raw)); return true; }catch(e){ console.warn(e); return false; } }
function autosave(){ if(state.autosave && state.blueprint) { const snap=makeSnapshot(); localStorage.setItem('wirestack.snapshot', JSON.stringify(snap)); state.lastSavedAt=snap.savedAt; } }
function downloadState(){ if(!state.blueprint) generateBlueprint(); download(`${state.blueprint.name}.wirestack.json`, JSON.stringify(makeSnapshot(),null,2), 'application/json'); toast('State downloaded'); }
function loadStateFromFile(file){ const reader=new FileReader(); reader.onload=()=>{ try{ restoreSnapshot(JSON.parse(reader.result)); }catch(e){ toast('Load failed: invalid JSON'); } }; reader.readAsText(file); }
function setPaused(paused){ state.paused=paused; logEngine(paused?'Paused all engines':'Resumed engines'); renderStatePanel(); autosave(); toast(state.paused?'Paused':'Resumed'); }
function logEngine(msg){ state.engineLog.push({time:new Date().toLocaleTimeString(), message:msg}); state.engineLog=state.engineLog.slice(-80); }
function runEngineCycle(){ if(state.paused){ logEngine('Cycle skipped because project is paused'); renderStatePanel(); toast('Paused'); return; } if(!state.blueprint) generateBlueprint(); logEngine('Cycle started'); analyzeChange(); logEngine('Impact analysis completed'); runValidation(); logEngine('Validation completed: '+(state.validationReport?.status||'unknown')); runTestingEngine(false); logEngine('Testing completed: '+(state.testingReport?.status||'unknown')); runQutriScan(false); logEngine('Qutri scan completed'); state.blueprint.changelog.push({date:today(),actor:'Engine Loop',change:'Ran one WireStack engine cycle.'}); autosave(); render(); showTab('state'); toast('Engine cycle complete'); }
function resetProject(){ if(!confirm('Reset this project?')) return; state.blueprint=null; state.lastAnalysis=null; state.validationReport=null; state.repairPrompt=''; state.highlighted.clear(); state.ingestion=null; state.knowledge=null; state.engineLog=[]; state.paused=false; state.aiConversation=[]; state.aiCodeBlocks=[]; generateBlueprint(); showTab('state'); toast('Project reset'); }
function renderStatePanel(){ const status=document.getElementById('engineStatus'); if(!status) return; const bp=state.blueprint; status.innerHTML=`<div class="statusPill ${state.paused?'paused':'running'}">${state.paused?'Paused':'Running'}</div><div class="logList">${state.engineLog.slice().reverse().map(l=>`<div>${escapeHtml(l.time)} · ${escapeHtml(l.message)}</div>`).join('') || '<div>No engine events yet.</div>'}</div>`; const summary={ project:bp?.name||'None', version:bp?.version||'—', modules:bp?Object.keys(bp.sections).length:0, wires:bp?.wiring?.length||0, aiMessages:state.aiConversation.length, paused:state.paused, autosave:state.autosave, lastSavedAt:state.lastSavedAt||'not saved this session' }; const sumEl=document.getElementById('stateSummary'); if(sumEl) sumEl.textContent=JSON.stringify(summary,null,2); const prev=document.getElementById('statePreview'); if(prev) prev.textContent=JSON.stringify(makeSnapshot(),null,2).slice(0,6000); const auto=document.getElementById('autosaveToggle'); if(auto) auto.checked=state.autosave; const p1=document.getElementById('pauseBtn'); if(p1) p1.textContent=state.paused?'Resume':'Pause'; const p2=document.getElementById('statePauseBtn'); if(p2) p2.textContent=state.paused?'Resume engines':'Pause engines'; }

// ─── TESTING ──────────────────────────────────────────────────────────────────
function blastRadius(id){ return dependantsOf(id).flatMap(did=>[did,...dependantsOf(did)]); }
function buildTestPlan(){ const bp=state.blueprint; if(!bp) return null; const affected = state.lastAnalysis?.affectedSections || Object.keys(bp.sections); const downstream = [...new Set(affected.flatMap(id=>[id,...blastRadius(id)]))].filter(Boolean); const functionChecks=[]; const edgeChecks=[]; Object.values(bp.sections).forEach(s=>{ const fnNames=[...s.code.matchAll(/(?:function\s+|export\s+(?:async\s+)?function\s+|async\s+function\s+)([A-Za-z0-9_]+)/g)].map(m=>m[1]); const inferred = fnNames.length ? fnNames : [camel(s.id)+'Smoke']; inferred.forEach(fn=>{ functionChecks.push({section:s.id, function:fn, cases:['happy path','empty input','null input','bad type','large input'], status:'pending'}); edgeChecks.push({section:s.id, target:fn, edgeCases:['missing auth','dependency failure','duplicate request','timeout','malformed payload'], status:'pending'}); }); }); const journeys=[{name:'Core happy path', steps:['open app','authenticate','perform primary action','persist record','show success'], covers:Object.keys(bp.sections).slice(0,6)},{name:'Dependency failure path', steps:['start request','mock failure','surface safe error','avoid partial write','log recovery'], covers:downstream.slice(0,8)},{name:'Regression path', steps:['change module','run dependants','verify wiring','update changelog'], covers:downstream}]; state.testPlan={createdAt:new Date().toISOString(), affected, retestQueue:downstream, functionChecks, edgeChecks, journeys}; return state.testPlan; }
function runTestingEngine(show=true){ const bp=state.blueprint; if(!bp) return; const plan=state.testPlan || buildTestPlan(); const validationIssues=validate(bp); const results=[]; function scoreItem(item, kind){ let passed=true; const reasons=[]; const section=bp.sections[item.section]; if(item.section && !section){ passed=false; reasons.push('missing section'); } if(section && !section.purpose){ passed=false; reasons.push('missing purpose'); } if(section && /TODO|throw new Error\(['""]not implemented/i.test(section.code)){ passed=false; reasons.push('unfinished code marker'); } if(section && kind==='edge' && !(section.code||'').match(/if|try|catch|throw|return/)){ passed=false; reasons.push('no visible defensive branch'); } if(validationIssues.some(x=>item.section && x.includes(item.section))){ passed=false; reasons.push('validation issue affects this section'); } return {...item, status:passed?'pass':'fail', reasons}; } const functionResults=plan.functionChecks.map(x=>scoreItem(x,'function')); const edgeResults=plan.edgeChecks.map(x=>scoreItem(x,'edge')); const journeyResults=plan.journeys.map(j=>{ const missing=(j.covers||[]).filter(id=>!bp.sections[id] && id!=='users' && id!=='release'); const affectedErrors=validationIssues.filter(v=>(j.covers||[]).some(id=>v.includes(id))); const hasTests=!!bp.sections.tests; const passed=!missing.length && !affectedErrors.length && hasTests; return {...j,status:passed?'pass':'fail',reasons:[...missing.map(x=>'missing '+x),...affectedErrors,!hasTests?'tests section missing':null].filter(Boolean)}; }); results.push(...functionResults,...edgeResults,...journeyResults); const pass=results.filter(r=>r.status==='pass').length; const total=Math.max(1,results.length); const confidence=Math.round((pass/total)*100); const status=confidence>=90?'PASSED':confidence>=70?'NEEDS_ATTENTION':'REJECTED'; const failures=results.filter(r=>r.status!=='pass'); state.testingReport={status, confidence, summary:{passed:pass, failed:failures.length, total, retestQueue:plan.retestQueue.length}, retestQueue:plan.retestQueue, functionResults, edgeResults, journeyResults, failures}; if(bp && show) bp.changelog.push({date:today(),actor:'Testing Engine',change:`Ran continuous verification: ${confidence}% confidence, ${failures.length} issue(s).`}); renderTesting(); autosave(); if(show) toast('Testing '+status.toLowerCase()); }
function watchdogRetest(){ if(!state.lastAnalysis) analyzeChange(); buildTestPlan(); const q=state.testPlan.retestQueue || []; state.highlighted=new Set(q); runTestingEngine(true); logEngine('Watchdog retested: '+q.join(', ')); render(); showTab('testing'); }
function renderTesting(){ const confidence=document.getElementById('testConfidence'); if(!confidence) return; const plan=state.testPlan, rep=state.testingReport; confidence.textContent=rep ? rep.confidence+'%' : '—'; document.getElementById('testSummary').textContent=rep ? JSON.stringify({status:rep.status, ...rep.summary},null,2) : 'No test run yet.'; document.getElementById('impactRetestList').innerHTML=(plan?.retestQueue?.length?plan.retestQueue:['No retest queue yet']).map(x=>`<span class="badge wide">${escapeHtml(x)}</span>`).join(''); const fc=(rep?.functionResults || plan?.functionChecks || []).slice(0,60); document.getElementById('functionTests').innerHTML=fc.length?fc.map(t=>`<div class="check ${t.status==='fail'?'danger':'ok'}">${t.status==='fail'?'✗':'✓'} ${escapeHtml(t.section)} · ${escapeHtml(t.function||t.target)} <span class="meta">${escapeHtml((t.reasons||t.cases||[]).join(', '))}</span></div>`).join(''):'No generated tests yet.'; const jr=(rep?.journeyResults || plan?.journeys || []); document.getElementById('journeyTests').innerHTML=jr.length?jr.map(j=>`<div class="check ${j.status==='fail'?'danger':'ok'}">${j.status==='fail'?'✗':'✓'} <b>${escapeHtml(j.name)}</b><br><span class="meta">${escapeHtml((j.steps||[]).join(' → '))}</span></div>`).join(''):'No journeys yet.'; document.getElementById('testingReport').textContent=rep?JSON.stringify(rep,null,2):(plan?JSON.stringify(plan,null,2):'Run the testing engine to generate a report.'); }

// ─── CHANGE MEMORY ────────────────────────────────────────────────────────────
function ensureMemory(){ if(!Array.isArray(state.changeMemory)) state.changeMemory=[]; return state.changeMemory; }
function recordChangeMemory(){ const bp=state.blueprint || buildBlueprint(); const reason=(document.getElementById('commitReason')?.value||'Manual WireStack change').trim(); const affected=state.lastAnalysis?.affectedSections || [...state.highlighted] || []; const entry={ id:'chg-'+Date.now(), date:new Date().toISOString(), actor:'Change Memory Engine', reason, version:bp.version, affected:[...new Set(affected.length?affected:Object.keys(bp.sections).slice(0,4))], risk:state.lastAnalysis?.risk || 'Low', confidence:state.testingReport?.confidence ?? null, validation:state.validationReport?.status || 'not run', tests:state.testingReport?.status || 'not run', rollback:`Restore snapshot before ${bp.version}` }; ensureMemory().push(entry); bp.changelog.push({date:today(),actor:'Change Memory Engine',change:`Recorded memory ${entry.id}: ${reason}`}); logEngine('Recorded change memory '+entry.id); autosave(); render(); showTab('git'); toast('Change memory recorded'); }
function renderChangeMemory(){ const timeline=document.getElementById('memoryTimeline'); if(!timeline) return; const q=(document.getElementById('memorySearch')?.value||'').toLowerCase(); const items=ensureMemory().filter(m=>!q||JSON.stringify(m).toLowerCase().includes(q)).slice().reverse(); timeline.innerHTML=items.length?items.map(m=>`<div><b>${escapeHtml(m.id)}</b> · ${escapeHtml(m.date.slice(0,19))} · ${escapeHtml(m.reason)}<br><span class="meta">Affected: ${escapeHtml((m.affected||[]).join(', '))} · Risk: ${escapeHtml(m.risk)} · Confidence: ${m.confidence??'—'}</span></div>`).join(''):'<div>No change memory yet.</div>'; const report={total:ensureMemory().length, latest:ensureMemory().at(-1)||null}; const rep=document.getElementById('memoryReport'); if(rep) rep.textContent=JSON.stringify(report,null,2); }
function exportPatchNote(){ const m=ensureMemory().at(-1); if(!m){ toast('No memory to export'); return; } const text=`# WireStack Patch Note\n\nChange: ${m.id}\nDate: ${m.date}\nReason: ${m.reason}\nAffected: ${(m.affected||[]).join(', ')}\nRisk: ${m.risk}\nConfidence: ${m.confidence??'not run'}\n`; download(`${m.id}-patch-note.md`, text, 'text/markdown'); }

// ─── AGENTS ───────────────────────────────────────────────────────────────────
function defaultAgents(){ return [{id:'architect',name:'Architect',role:'Maintains blueprint, index and wiring.',enabled:true},{id:'coder',name:'Coder',role:'Implements smallest safe code change.',enabled:true},{id:'tester',name:'Tester',role:'Builds function, edge and journey tests.',enabled:true},{id:'security',name:'Security',role:'Checks auth, secrets, permissions and injection risk.',enabled:true},{id:'ux',name:'UX',role:'Reviews screens, flow, error states and accessibility.',enabled:true},{id:'release',name:'Release',role:'Prepares deploy plan, env vars and rollback.',enabled:true}]; }
function ensureAgents(){ if(!state.agents) state.agents=defaultAgents(); return state.agents; }
function runAgentReview(){ const bp=state.blueprint || buildBlueprint(); const packet={project:bp.name,target:bp.target,currentTask:bp.context.currentTask,modules:Object.keys(bp.sections),wires:bp.wiring.length,confidence:state.testingReport?.confidence||0,validation:state.validationReport?.status||'not run'}; const findings=ensureAgents().filter(a=>a.enabled).map(a=>{ let finding='No blocker found.'; if(a.id==='architect') finding=`Blueprint has ${Object.keys(bp.sections).length} modules and ${bp.wiring.length} wires.`; if(a.id==='coder') finding=`Code changes should target: ${(state.lastAnalysis?.affectedSections||Object.keys(bp.sections).slice(0,3)).join(', ')}.`; if(a.id==='tester') finding=`Current confidence is ${state.testingReport?.confidence??'unknown'}%.`; if(a.id==='security') finding=bp.sections.auth?'Auth module exists; verify protected routes.':'No auth module detected.'; if(a.id==='ux') finding='Verify loading, empty, success and error states.'; if(a.id==='release') finding=state.deployment?'Deployment plan exists.':'No deployment plan yet.'; return {...a, finding, status:finding.includes('No auth')?'warning':'ok'}; }); state.agentReview={createdAt:new Date().toISOString(), packet, findings}; bp.changelog.push({date:today(),actor:'Agent Workspace',change:`Ran ${findings.length} specialist agent review(s).`}); logEngine('Agent workspace reviewed blueprint'); autosave(); render(); showTab('agents'); toast('Agent review complete'); }
function renderAgentWorkspace(){ const list=document.getElementById('agentWorkspaceList'); if(!list) return; list.innerHTML=ensureAgents().map((a,i)=>`<article class="providerCard card small ${a.enabled?'enabled':''}"><div class="buttonRow between"><h3>${escapeHtml(a.name)}</h3><label class="inlineCheck"><input type="checkbox" data-agent-enable="${i}" ${a.enabled?'checked':''}/> enabled</label></div><label>Name</label><input data-agent-field="name" data-agent-index="${i}" value="${escapeHtml(a.name)}"/><label>Role</label><textarea data-agent-field="role" data-agent-index="${i}" rows="3">${escapeHtml(a.role)}</textarea></article>`).join(''); document.querySelectorAll('[data-agent-enable]').forEach(el=>el.onchange=()=>{ensureAgents()[Number(el.dataset.agentEnable)].enabled=el.checked; autosave(); renderAgentWorkspace();}); document.querySelectorAll('[data-agent-field]').forEach(el=>el.onchange=()=>{ensureAgents()[Number(el.dataset.agentIndex)][el.dataset.agentField]=el.value; autosave(); renderAgentWorkspace();}); const packet=document.getElementById('agentPacket'); if(packet) packet.textContent=JSON.stringify(state.agentReview?.packet || {},null,2); const findings=document.getElementById('agentFindings'); if(findings) findings.innerHTML=(state.agentReview?.findings||[]).length?state.agentReview.findings.map(f=>`<div class="check ${f.status==='warning'?'danger':'ok'}"><b>${escapeHtml(f.name)}</b>: ${escapeHtml(f.finding)}</div>`).join(''):'No agent review yet.'; }
function addAgent(){ ensureAgents().push({id:'agent-'+Date.now(), name:'New specialist', role:'Describe this specialist responsibility.', enabled:true}); renderAgentWorkspace(); autosave(); }

// ─── DEPLOY ───────────────────────────────────────────────────────────────────
function buildDeploymentPlan(){ const bp=state.blueprint || buildBlueprint(); const target=document.getElementById('deployTarget')?.value||'Docker'; const requireGreen=document.getElementById('requireGreenTests')?.checked!==false; const confidence=state.testingReport?.confidence||0; const validationOk=!state.validationReport || state.validationReport.status!=='REJECTED'; const ready=(!requireGreen || confidence>=85) && validationOk; const steps=['Create deployment snapshot','Install dependencies','Apply database migrations','Set environment variables','Run validation engine','Run watchdog tests','Deploy to '+target,'Smoke test primary journey','Record change memory']; state.deployment={createdAt:new Date().toISOString(), target, requireGreenTests:requireGreen, readiness:ready?'READY':'BLOCKED', confidence, validation:state.validationReport?.status||'not run', steps, rollback:'Use latest .wirestack.json snapshot.'}; bp.changelog.push({date:today(),actor:'Deployment Engine',change:`Built ${target} deployment plan: ${state.deployment.readiness}.`}); autosave(); render(); showTab('deploy'); toast('Deploy plan built'); }
function renderDeployment(){ const r=document.getElementById('deployReadiness'); if(!r) return; const d=state.deployment; r.textContent=d?d.readiness:'—'; document.getElementById('deploySummary').textContent=d?JSON.stringify({target:d.target, readiness:d.readiness, confidence:d.confidence},null,2):'No deploy plan yet.'; document.getElementById('deployPlan').textContent=d?JSON.stringify({steps:d.steps, rollback:d.rollback},null,2):'No deploy plan yet.'; }
function markDeployed(){ if(!state.deployment) buildDeploymentPlan(); state.deployment.lastDeploy={date:new Date().toISOString(), status:'simulated-success'}; recordChangeMemory(); toast('Simulated deploy recorded'); }

// ─── QUTRI LOGIC ──────────────────────────────────────────────────────────────
const QUTRI = {
  VERIFIED: { label:'Verified', rank:4, css:'verified', symbol:'✓' },
  PARTIAL: { label:'Partial', rank:3, css:'partial', symbol:'◐' },
  UNKNOWN: { label:'Unknown', rank:2, css:'unknown', symbol:'?' },
  CONFLICTED: { label:'Conflicted', rank:1, css:'conflicted', symbol:'!' }
};
function qutriOf(section){
  const bp=state.blueprint || buildBlueprint();
  const id=section.id;
  const reasons=[];
  const validationIssues=(validate(bp)||[]).filter(x=>x.includes(id));
  const fn=(state.testingReport?.functionResults||[]).filter(r=>r.section===id);
  const edge=(state.testingReport?.edgeResults||[]).filter(r=>r.section===id);
  const testResults=[...fn,...edge];
  const fails=testResults.filter(r=>r.status==='fail');
  const passes=testResults.filter(r=>r.status==='pass');
  const hasKnowledge=!!(state.knowledge?.concepts||[]).some(c=>id.toLowerCase().includes(String(c.name||c).toLowerCase()) || String(c.name||c).toLowerCase().includes(id.split('.')[1]||id));
  const hasCode=!!(section.code||'').trim();
  const hasPurpose=!!(section.purpose||'').trim();
  const hasWiring=bp.wiring.some(([a,b])=>a===id||b===id) || id==='deploy';
  const highlighted=state.highlighted.has(id);
  if(validationIssues.length){ reasons.push('validation conflict: '+validationIssues.join('; ')); }
  if(fails.length){ reasons.push(fails.length+' failing test signal(s)'); }
  if(highlighted){ reasons.push('active or affected change area'); }
  if(!hasCode) reasons.push('missing code');
  if(!hasPurpose) reasons.push('missing purpose');
  if(!hasWiring) reasons.push('not connected in wiring map');
  if(validationIssues.length || (fails.length && passes.length) || (fails.length && hasWiring && hasCode)) return {state:'CONFLICTED', ...QUTRI.CONFLICTED, reasons};
  if(hasCode && hasPurpose && hasWiring && (passes.length || id==='deploy')) return {state:'VERIFIED', ...QUTRI.VERIFIED, reasons: reasons.length?reasons:['code, purpose, wiring and tests agree']};
  if(hasCode || hasPurpose || hasWiring || hasKnowledge || passes.length) return {state:'PARTIAL', ...QUTRI.PARTIAL, reasons: reasons.length?reasons:['some evidence exists but coverage is incomplete']};
  return {state:'UNKNOWN', ...QUTRI.UNKNOWN, reasons: reasons.length?reasons:['no strong evidence yet']};
}
function runQutriScan(show=true){
  const bp=state.blueprint || buildBlueprint();
  const modules=Object.values(bp.sections).map(s=>({ id:s.id, layer:s.layer, type:s.type, ...qutriOf(s) }));
  const counts=modules.reduce((a,m)=>(a[m.state]=(a[m.state]||0)+1,a),{});
  const conflicted=modules.filter(m=>m.state==='CONFLICTED').map(m=>m.id);
  const unknown=modules.filter(m=>m.state==='UNKNOWN').map(m=>m.id);
  state.qutri={createdAt:new Date().toISOString(), states:['VERIFIED','PARTIAL','UNKNOWN','CONFLICTED'], counts, modules, repairQueue:[...conflicted,...unknown], rule:'Trust verified first. Build partial next. Inspect unknown. Repair conflicted before deploy.'};
  if(show){ bp.changelog.push({date:today(),actor:'Qutri Logic Engine',change:`Scanned four-state truth map: ${counts.VERIFIED||0} verified, ${counts.PARTIAL||0} partial, ${counts.UNKNOWN||0} unknown, ${counts.CONFLICTED||0} conflicted.`}); logEngine('Qutri scan recorded'); toast('Qutri scan complete'); }
  autosave(); renderQutri();
}
function renderQutri(){
  const matrix=document.getElementById('qutriMatrix'); if(!matrix) return;
  if(!state.qutri){ matrix.innerHTML='Run qutri scan.'; document.getElementById('qutriReport').textContent='No qutri report yet.'; return; }
  matrix.innerHTML=state.qutri.modules.map(m=>`<button class="qutriRow ${m.css}" data-qutri="${escapeHtml(m.id)}"><b>${m.symbol} ${escapeHtml(m.id)}</b><span>${escapeHtml(m.label)}</span><small>${escapeHtml((m.reasons||[])[0]||'')}</small></button>`).join('');
  document.querySelectorAll('[data-qutri]').forEach(btn=>btn.onclick=()=>{ const m=state.qutri.modules.find(x=>x.id===btn.dataset.qutri); document.getElementById('qutriReport').textContent=JSON.stringify(m,null,2); });
  document.getElementById('qutriReport').textContent=JSON.stringify({counts:state.qutri.counts, repairQueue:state.qutri.repairQueue, rule:state.qutri.rule},null,2);
}
function applyQutriToBrain(){ runQutriScan(false); buildBrain(); render(); showTab('brain'); toast('Qutri states applied to app brain'); }


// ─── PROJECT HEALTH SCORE ───────────────────────────────────────────────────
function clamp(n,min=0,max=100){ return Math.max(min, Math.min(max, Math.round(n))); }
function calculateProjectHealth(){
  const bp = state.blueprint || buildBlueprint();
  const issues = validate(bp);
  const sections = Object.values(bp.sections||{});
  const q = state.qutri || {counts:{VERIFIED:0,PARTIAL:0,UNKNOWN:0,CONFLICTED:0}, repairQueue:[]};
  const total = Math.max(1, sections.length);
  const verified = q.counts?.VERIFIED || 0;
  const partial = q.counts?.PARTIAL || 0;
  const unknown = q.counts?.UNKNOWN || 0;
  const conflicted = q.counts?.CONFLICTED || 0;
  const validationErrors = state.validationReport?.summary?.errors ?? issues.length;
  const validationWarnings = state.validationReport?.summary?.warnings ?? 0;
  const testConfidence = state.testingReport?.confidence ?? 0;
  const deploymentReady = state.deployment?.readiness === 'READY';
  const hasDeployment = !!state.deployment;
  const docsWithPurpose = sections.filter(s=>String(s.purpose||'').length>20).length;
  const codeWithComments = sections.filter(s=>/\/\/|#|\/\*/.test(s.code||'')).length;
  const authExists = !!bp.sections?.['auth'] || sections.some(s=>/auth|login|permission|session/i.test(`${s.id} ${s.purpose}`));
  const secretLeakRisk = sections.some(s=>/api[_-]?key\s*=|sk-[A-Za-z0-9]|password\s*=|secret\s*=/i.test(s.code||''));
  const externalCount = sections.filter(s=>s.type==='external'||/stripe|email|api|provider/i.test(`${s.id} ${s.purpose}`)).length;

  const blueprint = clamp(100 - issues.length*12 - validationErrors*10 - validationWarnings*3 + (bp.context?.purpose?5:0));
  const wiring = clamp(100 - issues.length*18 - conflicted*20 - unknown*5 + Math.min(10, (bp.wiring||[]).length));
  const tests = clamp(testConfidence || (state.testPlan ? 55 : 25));
  const documentation = clamp((docsWithPurpose/total)*65 + (codeWithComments/total)*20 + (bp.context?.rules?.length?15:0));
  const security = clamp(82 + (authExists?12:-18) - (secretLeakRisk?45:0) - Math.max(0, externalCount-2)*4);
  const deployment = clamp(hasDeployment ? (deploymentReady?92:62) : 30);
  const qutriScore = clamp(((verified*1)+(partial*.65)+(unknown*.35)+(conflicted*0))/Math.max(1, verified+partial+unknown+conflicted)*100);

  const breakdown = {blueprint, wiring, tests, documentation, security, deployment, qutri:qutriScore};
  const weights = {blueprint:.20, wiring:.18, tests:.22, documentation:.10, security:.14, deployment:.08, qutri:.08};
  const score = clamp(Object.entries(breakdown).reduce((sum,[k,v])=>sum+v*weights[k],0));
  const risks=[];
  if(conflicted) risks.push({area:'Qutri conflicts', severity:100, detail:`${conflicted} conflicted module(s) must be repaired first.`, tab:'qutri'});
  if(validationErrors) risks.push({area:'Validation errors', severity:95, detail:`${validationErrors} error(s) block safe builds.`, tab:'validator'});
  if(secretLeakRisk) risks.push({area:'Security', severity:92, detail:'Possible secret or credential pattern found in code.', tab:'sections'});
  if(testConfidence && testConfidence<80) risks.push({area:'Tests', severity:82, detail:`Testing confidence is ${testConfidence}%.`, tab:'testing'});
  if(!state.testingReport) risks.push({area:'Tests', severity:78, detail:'Continuous testing has not been run yet.', tab:'testing'});
  if(unknown) risks.push({area:'Unknown modules', severity:65, detail:`${unknown} module(s) need evidence, tests, or docs.`, tab:'qutri'});
  if(!hasDeployment) risks.push({area:'Deployment', severity:38, detail:'No deployment plan has been generated yet.', tab:'deploy'});
  const biggestRisk = risks.sort((a,b)=>b.severity-a.severity)[0] || {area:'None', severity:0, detail:'No major project risk detected.', tab:'overview'};
  let nextAction = 'Build the next feature or prepare deployment.';
  let nextTab = 'ai-build';
  if(biggestRisk.area==='Qutri conflicts'){ nextAction='Open the Qutri repair queue and resolve conflicted modules.'; nextTab='qutri'; }
  else if(biggestRisk.area==='Validation errors'){ nextAction='Run the Validator and apply the generated repair prompt.'; nextTab='validator'; }
  else if(biggestRisk.area==='Tests'){ nextAction='Run Continuous Testing, then improve weak functions and journeys.'; nextTab='testing'; }
  else if(biggestRisk.area==='Security'){ nextAction='Review sections for secrets, auth gaps, and unsafe assumptions.'; nextTab='sections'; }
  else if(biggestRisk.area==='Deployment'){ nextAction='Create a deployment plan once the build/test loop is green.'; nextTab='deploy'; }
  return {score, breakdown, biggestRisk, nextAction, nextTab, counts:{verified,partial,unknown,conflicted}, generatedAt:new Date().toISOString()};
}
function renderHealthScore(){
  const h = calculateProjectHealth();
  state.health = h;
  const scoreEl=document.getElementById('healthScore'); if(scoreEl) scoreEl.textContent=`${h.score}%`;
  const list=document.getElementById('healthList');
  if(list) list.innerHTML=`<p class="${h.score>=85?'ok':h.score>=65?'warn':'danger'}">• Biggest risk: ${escapeHtml(h.biggestRisk.area)} — ${escapeHtml(h.biggestRisk.detail)}</p><p>• Next: ${escapeHtml(h.nextAction)}</p>`;
  const dash=document.getElementById('projectHealthCard');
  if(dash) dash.innerHTML=`<div class="healthDial ${h.score>=85?'good':h.score>=65?'mid':'bad'}"><strong>${h.score}%</strong><span>health</span></div><div class="healthBreakdown">${Object.entries(h.breakdown).map(([k,v])=>`<div><span>${escapeHtml(k)}</span><meter min="0" max="100" value="${v}"></meter><b>${v}%</b></div>`).join('')}</div>`;
  const risk=document.getElementById('biggestRiskBox');
  if(risk) risk.innerHTML=`<b>${escapeHtml(h.biggestRisk.area)}</b><br>${escapeHtml(h.biggestRisk.detail)}<br><button class="miniBtn" data-health-tab="${escapeHtml(h.biggestRisk.tab)}">Open area</button>`;
  const action=document.getElementById('healthNextAction');
  if(action) action.textContent=h.nextAction;
  document.querySelectorAll('[data-health-tab]').forEach(b=>b.onclick=()=>showTab(b.dataset.healthTab));
}
function goHealthNext(){ const h=calculateProjectHealth(); showTab(h.nextTab || 'overview'); }

// ─── BRAIN ────────────────────────────────────────────────────────────────────
function buildBrain(){ const bp=state.blueprint || buildBlueprint(); const memory=ensureMemory(); const testBySection={}; (state.testingReport?.functionResults||[]).forEach(r=>{testBySection[r.section] ||= {pass:0,fail:0}; testBySection[r.section][r.status==='pass'?'pass':'fail']++;}); const nodes=Object.values(bp.sections).map(s=>{ const tests=testBySection[s.id]||{pass:0,fail:0}; const deps=(s.dependsOn||[]).length; const used=dependantsOf(s.id).length; const hot=state.highlighted.has(s.id); const confidence=Math.max(30, Math.min(100, 92 - tests.fail*18 - (hot?10:0) + tests.pass*2)); const last=memory.slice().reverse().find(m=>(m.affected||[]).includes(s.id)); const q=qutriOf(s); return {id:s.id, layer:s.layer, type:s.type, dependsOn:s.dependsOn||[], usedBy:dependantsOf(s.id), confidence, risk:q.state==='CONFLICTED'?'conflicted':(q.state==='UNKNOWN'?'unknown':(hot?'active-change':(deps+used>4?'medium':'low'))), qutri:q.state, qutriLabel:q.label, qutriReasons:q.reasons, tests, lastChange:last?.id||'none'}; }); state.brain={createdAt:new Date().toISOString(), project:bp.name, nodes, wires:bp.wiring, summary:{nodes:nodes.length,wires:bp.wiring.length,avgConfidence:Math.round(nodes.reduce((a,n)=>a+n.confidence,0)/Math.max(1,nodes.length))}}; autosave(); renderBrain(); }
function renderBrain(){ const el=document.getElementById('brainMap'); if(!el) return; if(!state.brain) buildBrain(); const b=state.brain; el.innerHTML=b.nodes.map(n=>`<button class="brainNode ${n.risk==='active-change'?'hot':''} ${n.risk==='conflicted'?'conflicted':''} ${n.risk==='unknown'?'unknown':''}" data-brain-node="${escapeHtml(n.id)}"><b>${escapeHtml(n.id)}</b><span>${escapeHtml(n.layer)}</span><meter min="0" max="100" value="${n.confidence}"></meter><small>${n.confidence}% · ${escapeHtml(n.qutriLabel||n.risk)}</small></button>`).join(''); document.querySelectorAll('[data-brain-node]').forEach(btn=>btn.onclick=()=>{const node=b.nodes.find(n=>n.id===btn.dataset.brainNode); document.getElementById('brainInspector').textContent=JSON.stringify(node,null,2);}); const insp=document.getElementById('brainInspector'); if(insp && !insp.textContent.trim()) insp.textContent=JSON.stringify(b.summary,null,2); }
function focusBrainAffected(){ if(!state.lastAnalysis) analyzeChange(); state.highlighted=new Set(state.lastAnalysis?.affectedSections||[]); buildBrain(); render(); showTab('brain'); }

// ─── UTILS ────────────────────────────────────────────────────────────────────
function inferLang(s){ if(s.type==='database') return 'sql'; if(s.type==='ops') return 'bash'; return 'javascript'; }
// Tabs that use the full workspace width (no sidebar needed)
const FULL_WIDTH_TABS = new Set(['wizard', 'help']);

function showTab(id){
  if(!id) return;
  document.querySelectorAll('.tab,.navPill,.engineChip').forEach(t=>t.classList.toggle('active',t.dataset.tab===id));
  document.querySelectorAll('.tabPage').forEach(p=>p.classList.toggle('active',p.id===id));
  document.body.classList.toggle('hide-sidebar', FULL_WIDTH_TABS.has(id));
  if(id==='ai-build') updateActiveContextHint(document.getElementById('promptTemplateSelect')?.value || 'buildBlueprint');
}

function val(id){return document.getElementById(id).value.trim()} function text(id,v){document.getElementById(id).textContent=v} function today(){return new Date().toISOString().slice(0,10)} function escapeHtml(s=''){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))} function escXml(s=''){return escapeHtml(s).replace(/"/g,'&quot;')} function download(name,content,type){const blob=new Blob([content],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();URL.revokeObjectURL(url)} function toast(msg){const t=document.getElementById('toast');t.textContent=msg;t.style.display='block';setTimeout(()=>t.style.display='none',1800)} function pascal(id){return id.split(/[^a-z0-9]/i).filter(Boolean).map(x=>x[0].toUpperCase()+x.slice(1)).join('')} function camel(id){const p=pascal(id); return p[0].toLowerCase()+p.slice(1)}



// ─── GUIDED WORKFLOW UI ───────────────────────────────────────────────────────
function getGuidedStatus(){
  const bp = state.blueprint;
  if(!bp) return {stage:'Start', action:'Describe your app, then create the first blueprint.', target:'create', steps:[]};
  if(!state.qutri) runQutriScan(false);
  if(!state.brain) buildBrain();
  const q = state.qutri || {counts:{VERIFIED:0,PARTIAL:0,UNKNOWN:0,CONFLICTED:0}, repairQueue:[]};
  const hasAi = state.aiConversation.length > 0;
  const hasTests = !!state.testingReport;
  const hasValidation = !!state.validationReport;
  const conflicts = q.counts.CONFLICTED || 0;
  const unknown = q.counts.UNKNOWN || 0;
  const partial = q.counts.PARTIAL || 0;
  const health = calculateProjectHealth();
  let stage='Blueprint ready', action=health.nextAction || 'Build the first feature with AI using the blueprint context.', target=health.nextTab || 'ai-build';
  if(conflicts>0){ stage='Repair first'; action=`${conflicts} conflicted module(s) found. Open the repair queue and fix those before building more.`; target='qutri'; }
  else if(!hasAi){ stage='Build'; action='Send the blueprint to your selected AI provider and generate the first implementation.'; target='ai-build'; }
  else if(!hasValidation){ stage='Validate'; action='Run the Validator Engine so fences, wiring, dependencies, and repair prompts are checked.'; target='validator'; }
  else if(!hasTests){ stage='Test'; action='Run Continuous Testing so function checks, edge cases, and user journeys produce a confidence score.'; target='testing'; }
  else if(unknown>0 || partial>0){ stage='Improve confidence'; action=`${unknown} unknown and ${partial} partial area(s) remain. Add tests, docs, or wiring evidence.`; target='qutri'; }
  else { stage='Ready to export/deploy'; action='Everything important is verified. Export or build a deployment plan.'; target='deploy'; }
  const steps=[
    {name:'Create blueprint', done:!!bp, detail:bp?`${Object.keys(bp.sections).length} modules mapped`:'No blueprint yet', tab:'create'},
    {name:'Understand app', done:!!state.knowledge || !!state.ingestion, detail:state.knowledge?'Knowledge graph available':'Optional: add guide.md or old project', tab:'importer'},
    {name:'Build with AI', done:hasAi, detail:hasAi?`${state.aiConversation.length} AI message(s)`:'No AI build yet', tab:'ai-build'},
    {name:'Validate', done:hasValidation && state.validationReport?.status!=='REJECTED', detail:hasValidation?state.validationReport.status:'Not run', tab:'validator'},
    {name:'Test', done:hasTests && (state.testingReport?.confidence||0)>=80, detail:hasTests?`${state.testingReport.confidence}% confidence`:'Not run', tab:'testing'},
    {name:'Resolve Qutri queue', done:conflicts===0, detail:conflicts?`${conflicts} conflicted`:'No conflicts', tab:'qutri'},
    {name:'Review blueprint diff', done:!!state.blueprintDiff, detail:state.blueprintDiff?`${state.blueprintDiff.risk} risk · ${state.blueprintDiff.healthDelta.delta>=0?'+':''}${state.blueprintDiff.healthDelta.delta}% health`:'No diff yet', tab:'diff'},
    {name:'Export / deploy', done:!!state.deployment, detail:state.deployment?state.deployment.readiness:'Not planned', tab:'deploy'}
  ];
  return {stage, action, target, steps, q};
}

function renderGuidedMode(){
  const next=document.getElementById('nextAction'); if(!next) return;
  const gs=getGuidedStatus();
  next.innerHTML=`<b>${escapeHtml(gs.stage)}</b><br>${escapeHtml(gs.action)}`;
  const stage=document.getElementById('flowStage'); if(stage) stage.textContent=gs.stage;
  const counts=gs.q?.counts || {VERIFIED:0,PARTIAL:0,UNKNOWN:0,CONFLICTED:0};
  const countsEl=document.getElementById('guidedQutriCounts');
  if(countsEl) countsEl.innerHTML=['VERIFIED','PARTIAL','UNKNOWN','CONFLICTED'].map(k=>`<div class="qutriMini ${k.toLowerCase()}"><strong>${counts[k]||0}</strong><span>${k}</span></div>`).join('');
  const steps=document.getElementById('guidedSteps');
  if(steps) steps.innerHTML=gs.steps.map((st,i)=>`<button class="guidedStep ${st.done?'done':'todo'}" data-guide-tab="${st.tab}"><span>${st.done?'✓':i+1}</span><b>${escapeHtml(st.name)}</b><small>${escapeHtml(st.detail)}</small></button>`).join('');
  document.querySelectorAll('[data-guide-tab]').forEach(b=>b.onclick=()=>showTab(b.dataset.guideTab));
}

function runGuidedCreate(){ showTab('create'); createFromAnything(); renderGuidedMode(); }
function runGuidedBuild(){ showTab('ai-build'); aiBuildFromBlueprint(); renderGuidedMode(); }
function runGuidedTest(){ runValidation(); if(!state.testPlan) buildTestPlan(); runTestingEngine(false); runQutriScan(false); buildBrain(); showTab('overview'); render(); toast('Validation and tests updated'); }
function runGuidedFix(){ runQutriScan(true); showTab('qutri'); }
function toggleAdvancedTabs(){
  document.body.classList.toggle('showAdvanced');
  const open=document.body.classList.contains('showAdvanced');
  const b=document.getElementById('advancedToggle');
  if(b){ b.textContent=open?'Engines ▴':'Engines ▾'; b.setAttribute('aria-expanded', String(open)); }
}



// ─── WIZARD MODE ─────────────────────────────────────────────────────────────
const wizardSteps = [
  { id:'source', title:'Start source', desc:'Start from an idea, a guide/spec, or an old project file tree.', action:'Create or refresh the blueprint from your source material.' },
  { id:'provider', title:'Choose AI provider', desc:'Pick Claude or OpenAI and confirm model/key settings. Keys stay in this browser prototype, so use local/private testing.', action:'Check provider, model, and context settings.' },
  { id:'blueprint', title:'Review blueprint', desc:'Confirm the living app map: purpose, modules, wiring, rules, and current task.', action:'Open the blueprint and capture a baseline.' },
  { id:'build', title:'Build with AI', desc:'Send the selected provider the blueprint, wiring, and task context.', action:'Open AI Build with a grounded starter prompt.' },
  { id:'verify', title:'Verify and test', desc:'Run validation, testing, Qutri scan, and App Brain health scoring.', action:'Run the verification loop.' },
  { id:'diff', title:'Diff and export', desc:'Show what changed, health delta, impact radius, and export the project snapshot.', action:'Run blueprint diff and prepare export.' }
];
function setWizardStep(n){ state.wizardStep=Math.max(0,Math.min(wizardSteps.length-1,n)); autosave(); renderWizardMode(); }
function runWizardStep(){
  const step=wizardSteps[state.wizardStep]?.id;
  if(step==='source'){ createFromAnything(); showTab('wizard'); }
  else if(step==='provider'){ updateProviderUi(); toast('Provider settings checked'); }
  else if(step==='blueprint'){ if(!state.blueprint) generateBlueprint(); captureBlueprintBaseline(true); showTab('wizard'); }
  else if(step==='build'){ showTab('ai-build'); document.getElementById('aiPromptInput').value = `Build the first safe feature for this blueprint.\n\nTask: ${val('task')}\n\nReturn real code in fenced blocks, one block per module/file. Declare modified sections and required tests.`; }
  else if(step==='verify'){ runGuidedTest(); showTab('wizard'); }
  else if(step==='diff'){ runBlueprintDiff(false); render(); showTab('wizard'); toast('Diff ready'); }
}
function renderWizardMode(){
  const rail=document.getElementById('wizardRail'); if(!rail) return;
  const step=wizardSteps[state.wizardStep] || wizardSteps[0];
  const done = {
    source: !!state.blueprint,
    provider: !!getModelId(),
    blueprint: !!state.blueprintBaseline,
    build: state.aiConversation.length>0 || state.aiCodeBlocks.length>0,
    verify: !!state.validationReport && !!state.testingReport && !!state.qutri,
    diff: !!state.blueprintDiff
  };
  rail.innerHTML=wizardSteps.map((s,i)=>`<button class="wizardRailStep ${i===state.wizardStep?'active':''} ${done[s.id]?'done':''}" data-wizard-step="${i}"><span>${done[s.id]?'✓':i+1}</span><b>${escapeHtml(s.title)}</b><small>${escapeHtml(s.action)}</small></button>`).join('');
  document.querySelectorAll('[data-wizard-step]').forEach(b=>b.onclick=()=>setWizardStep(Number(b.dataset.wizardStep)));
  text('wizardTitle', step.title); text('wizardDescription', step.desc); text('wizardStepPill', `Step ${state.wizardStep+1} of ${wizardSteps.length}`);
  const status=document.getElementById('wizardStatusText'); if(status) status.textContent=done[step.id]?'Completed or ready':'Needs action';
  const progress=document.getElementById('wizardProgressBar'); if(progress) progress.style.width=`${Math.round(((state.wizardStep+1)/wizardSteps.length)*100)}%`;
  const body=document.getElementById('wizardBody'); if(!body) return;
  if(step.id==='source'){
    const curMode = document.getElementById('creationMode')?.value || 'idea';
    body.innerHTML=`<div class="wizardHint"><b>Input accepted:</b> one sentence, pasted guide.md, README, notes, or a file tree.</div><label>Creation mode</label><select id="wizardCreationMode"><option value="idea"${curMode==='idea'?' selected':''}>Idea only</option><option value="guided"${curMode==='guided'?' selected':''}>Guide/spec</option><option value="reverse"${curMode==='reverse'?' selected':''}>Old project</option></select><label>Source material</label><textarea id="wizardCreationInput" rows="8">${escapeHtml(val('creationInput')||val('brief'))}</textarea>`;
    // live sync back to hidden fields so Run Step always uses latest values
    document.getElementById('wizardCreationInput')?.addEventListener('input', wizardSyncInputs);
    document.getElementById('wizardCreationMode')?.addEventListener('change', wizardSyncInputs);
  }
  if(step.id==='provider') body.innerHTML=`<div class="securityBanner"><b>API key warning:</b> this browser prototype sends keys directly from the page. For serious use, move provider calls behind a small local/server proxy.</div><div class="providerGrid"><div><b>Provider</b><br>${escapeHtml(getProviderLabel())}</div><div><b>Model</b><br>${escapeHtml(getModelId()||'none')}</div><div><b>Key status</b><br>${getApiKey()?'Key entered':'No key entered'}</div></div>`;
  if(step.id==='blueprint') body.innerHTML=`<pre class="wizardPre">${escapeHtml(JSON.stringify({name:state.blueprint?.name,target:state.blueprint?.target,modules:state.blueprint?Object.keys(state.blueprint.sections).length:0,wires:state.blueprint?.wiring?.length||0,baseline:!!state.blueprintBaseline},null,2))}</pre>`;
  if(step.id==='build'){
    const msgCount = state.aiConversation.length;
    const blockCount = state.aiCodeBlocks.length;
    const aiStatus = msgCount > 0
      ? `✓ AI has responded — ${msgCount} message(s), ${blockCount} code block(s) extracted.`
      : '⚠ No AI messages yet. Click "Run step" to open AI Build with a prepared prompt.';
    body.innerHTML=`<div class="wizardHint">This step opens AI Build and prepares a grounded prompt. The AI receives blueprint/wiring context selected in the AI Build tab.</div><pre class="wizardPre">Provider: ${escapeHtml(getProviderLabel())}
Model: ${escapeHtml(getModelId())}
Task: ${escapeHtml(val('task'))}</pre><div class="wizardHint ${msgCount>0?'ok':'warn'}">${escapeHtml(aiStatus)}</div>`;
  }
  if(step.id==='verify') body.innerHTML=`<pre class="wizardPre">${escapeHtml(JSON.stringify({validation:state.validationReport?.status||'not run',testing:state.testingReport?.status||'not run',confidence:state.testingReport?.confidence??null,qutri:state.qutri?.counts||null,health:calculateHealthScore?.()||null},null,2))}</pre>`;
  if(step.id==='diff') body.innerHTML=`<pre class="wizardPre">${escapeHtml(JSON.stringify(state.blueprintDiff||{status:'No diff yet'},null,2)).slice(0,5000)}</pre>`;
  const back=document.getElementById('wizardBackBtn'); if(back) back.disabled=state.wizardStep===0;
  const next=document.getElementById('wizardNextBtn'); if(next) next.textContent=state.wizardStep===wizardSteps.length-1?'Finish':'Next';
}
function wizardSyncInputs(){
  const mode=document.getElementById('wizardCreationMode'); const input=document.getElementById('wizardCreationInput');
  if(mode) document.getElementById('creationMode').value=mode.value;
  if(input){ document.getElementById('creationInput').value=input.value; document.getElementById('brief').value=input.value.slice(0,600); }
}



// ─── CONTEXT-AWARE PROMPT TEMPLATES ──────────────────────────────────────────
const aiPromptTemplates = {
  buildBlueprint: ({module, concept, note}={}) => `Build from the current WireStack blueprint.\n\nGoal:\n- Generate a practical implementation plan and starter code for the current blueprint.\n- Use the wiring map to decide dependencies.\n- Return one fenced code block per file/module.\n- Include tests for the highest-risk modules.\n\nFocus: ${module || concept || val('task') || 'first safe feature'}\n${note ? '\nContext note:\n' + note : ''}`,
  repairCurrent: ({module, note}={}) => `Repair the current WireStack problems.\n\nUse the active validation, testing, Qutri, and diff context.\n\nTask:\n- Fix the rejected/conflicted/partial areas.\n- Update code, wiring, tests, and changelog together.\n- Return corrected code in fenced blocks.\n\nTarget module: ${module || 'affected modules'}\n${note ? '\nContext note:\n' + note : ''}\n\nCurrent repair signal:\n${currentRepairSignal()}`,
  explainModule: ({module, concept, note}={}) => `Explain this part of the application as if onboarding a developer.\n\nSubject: ${module || concept || 'selected module/concept'}\n\nCover:\n- Purpose\n- Dependencies\n- Dependants / blast radius\n- Current Qutri confidence\n- Tests that prove it works\n- Risks before changing it\n${note ? '\nContext note:\n' + note : ''}`,
  writeTests: ({module, note}={}) => `Write a focused test plan and executable test examples for ${module || 'the affected modules'}.\n\nInclude:\n- Function tests\n- Edge cases\n- User journey tests\n- Regression tests for wiring dependencies\n- Expected failures and repair suggestions\n${note ? '\nContext note:\n' + note : ''}`,
  securityReview: ({module, note}={}) => `Review the current blueprint and code sections for security issues.\n\nFocus on:\n- Auth/session boundaries\n- Input validation\n- API exposure\n- Secrets handling\n- Payment/webhook risks\n- Deployment risks\n\nReturn prioritized fixes with code where needed.\nTarget: ${module || 'whole app'}\n${note ? '\nContext note:\n' + note : ''}`,
  diffExplain: ({note}={}) => `Explain the current Blueprint Diff.\n\nCover:\n- What changed\n- Impact radius\n- Health score delta\n- Qutri state changes\n- What must be repaired before accepting the diff\n- Suggested next AI build prompt\n${note ? '\nContext note:\n' + note : ''}\n\nCurrent diff:\n${JSON.stringify(state.blueprintDiff || {status:'No diff yet'}, null, 2)}`
};

function currentRepairSignal(){
  const parts=[];
  const bullet=(title,items,limit=8)=>{
    const clean=(items||[]).filter(Boolean).slice(0,limit);
    if(clean.length) parts.push(`${title}:\n`+clean.map(x=>`- ${String(x).replace(/\s+/g,' ').slice(0,220)}`).join('\n'));
  };
  if(state.validationReport){
    const r=state.validationReport;
    parts.push(`Validation: ${r.status} · ${r.summary?.errors||0} errors · ${r.summary?.warnings||0} warnings`);
    bullet('Top validation errors', r.errors, 6);
    bullet('Top validation warnings', r.warnings, 4);
  }
  if(state.testingReport){
    const t=state.testingReport;
    parts.push(`Testing: confidence ${t.confidence ?? t.overallConfidence ?? 'unknown'} · ${t.status || 'not labelled'}`);
    bullet('Failed or risky tests', [...(t.failures||[]),...(t.repairSignals||[]),...(t.risks||[])], 8);
  }
  if(state.qutri){
    const q=state.qutri;
    parts.push(`Qutri: ${Object.entries(q.counts||{}).map(([k,v])=>`${k}=${v}`).join(', ') || 'no counts'}`);
    bullet('Qutri repair queue', (q.repairQueue||[]).map(x=>typeof x==='string'?x:`${x.id||x.module||'module'}: ${x.reason||x.state||JSON.stringify(x)}`), 8);
  }
  if(state.blueprintDiff){
    const d=state.blueprintDiff;
    parts.push(`Blueprint diff: risk ${d.risk || 'unknown'} · health delta ${d.healthDelta ?? d.summary?.healthDelta ?? 'unknown'}`);
    bullet('Changed modules', [...(d.addedModules||[]).map(x=>`added ${x}`),...(d.removedModules||[]).map(x=>`removed ${x}`),...(d.changedModules||[]).map(x=>`changed ${x.id||x}`)], 10);
    bullet('Impact radius', d.impactRadius || d.impacted || [], 10);
  }
  if(state.projectAnalysis){
    const a=state.projectAnalysis;
    parts.push(`Project import: ${a.files} files · ${a.modules.length} inferred modules · ${a.edges.length} import edges`);
    bullet('Likely modules from source files', a.modules.map(m=>`${m.id} (${m.files.length} files, ${m.symbols.slice(0,5).join(', ')||'no symbols'})`), 8);
  }
  return parts.join('\n\n') || 'No repair signal yet. Run validation/testing/Qutri/diff first.';
}

function prefillAiPrompt(template='buildBlueprint', opts={}){
  const fn=aiPromptTemplates[template] || aiPromptTemplates.buildBlueprint;
  const input=document.getElementById('aiPromptInput');
  if(input) input.value=fn(opts);
  // Flip on context most relevant to intelligent repair.
  ['ctxBlueprint','ctxWiring','ctxValidation','ctxTests','ctxKnowledge'].forEach(id=>{ const el=document.getElementById(id); if(el) el.checked = id==='ctxBlueprint' || id==='ctxWiring' || template!=='buildBlueprint'; });
  updateActiveContextHint(template, opts);
  showTab('ai-build');
}

function updateActiveContextHint(template='buildBlueprint', opts={}){
  const el=document.getElementById('activeContextHint');
  if(!el) return;
  const label={buildBlueprint:'Build from blueprint',repairCurrent:'Repair current errors',explainModule:'Explain selected module/concept',writeTests:'Write tests',securityReview:'Security review',diffExplain:'Explain diff'}[template] || template;
  const subject=opts.module || opts.concept || val('task') || state.blueprint?.name || 'current project';
  el.innerHTML=`<b>${escapeHtml(label)}</b> · Grounded in: blueprint, wiring, ${state.validationReport?'validation, ':''}${state.testingReport?'tests, ':''}${state.knowledge?'knowledge graph, ':''}${state.qutri?'Qutri, ':''}${state.blueprintDiff?'diff, ':''}subject <code>${escapeHtml(subject)}</code>`;
}

function useCurrentContextForAi(){
  const active=document.querySelector('.tabPage.active')?.id || 'overview';
  if(active==='validator') return prefillAiPrompt('repairCurrent', {note:'Opened from Validator tab with current validation report.'});
  if(active==='testing') return prefillAiPrompt('writeTests', {note:'Opened from Testing tab with current test report and impact queue.'});
  if(active==='qutri') return prefillAiPrompt('repairCurrent', {note:'Opened from Qutri tab. Repair conflicted and unknown states first.'});
  if(active==='diff') return prefillAiPrompt('diffExplain', {note:'Opened from Blueprint Diff tab.'});
  if(active==='knowledge') return prefillAiPrompt('explainModule', {concept:'knowledge graph', note:'Use imported concepts and relationships.'});
  return prefillAiPrompt('buildBlueprint');
}

function sendValidationToAi(){ if(!state.validationReport) runValidation(); prefillAiPrompt('repairCurrent', {note:'Validator errors and warnings were injected automatically.'}); }
function sendTestsToAi(){ if(!state.testingReport){ if(!state.testPlan) buildTestPlan(); runTestingEngine(false); } prefillAiPrompt('writeTests', {note:'Testing failures and impact retest queue were injected automatically.'}); }
function sendQutriToAi(){ if(!state.qutri) runQutriScan(false); prefillAiPrompt('repairCurrent', {note:'Qutri conflicted/unknown/partial module states were injected automatically.'}); }
function sendDiffToAi(){ if(!state.blueprintDiff) runBlueprintDiff(false); prefillAiPrompt('diffExplain', {note:'Blueprint diff and health delta were injected automatically.'}); }

// ─── REAL FILE / PROJECT IMPORT ──────────────────────────────────────────────
const TEXT_FILE_RE = /\.(js|jsx|ts|tsx|py|html|css|json|md|txt|yml|yaml|sql|sh|env|toml|xml|vue|svelte)$/i;
const SKIP_FILE_RE = /(node_modules|\.git|dist|build|\.next|coverage|venv|__pycache__|package-lock\.json|yarn\.lock)/i;

async function importRealProjectFiles(){
  const input=document.getElementById('sourceFilesInput');
  const files=[...(input?.files||[])].filter(f=>!SKIP_FILE_RE.test(f.webkitRelativePath||f.name));
  if(!files.length){ toast('Choose files or a folder first'); return; }
  const textFiles=files.filter(f=>TEXT_FILE_RE.test(f.name)).slice(0,160);
  const entries=[];
  for(const f of textFiles){
    const path=f.webkitRelativePath || f.name;
    const content=await readFileTextSafe(f, 50000);
    entries.push({path, size:f.size, content});
  }
  const analysis=analyzeProjectFiles(entries, files);
  const manifest=buildProjectManifest(entries, files, analysis);
  document.getElementById('sourceType').value='folder manifest';
  document.getElementById('guideInput').value=manifest;
  state.projectAnalysis=analysis;
  state.ingestion=ingestProjectAnalysis(analysis, manifest);
  state.knowledge=buildProjectKnowledgeGraph(analysis, manifest);
  if(state.blueprint) mergeProjectAnalysisIntoBlueprint(analysis);
  renderImporter(); renderKnowledge(); showTab('importer'); autosave();
  toast(`Imported ${entries.length} text files · inferred ${analysis.modules.length} modules`);
}
function readFileTextSafe(file, maxChars=50000){
  return new Promise(resolve=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(String(reader.result||'').slice(0,maxChars));
    reader.onerror=()=>resolve('');
    reader.readAsText(file);
  });
}
function fileModuleId(path, used=null){
  const clean=path.replace(/\\/g,'/').replace(/^.*?(src|app|pages|components|server|backend|api|lib|schema|tests)\//,'$1/');
  const noExt=clean.replace(/\.[^.]+$/,'').replace(/\/index$/,'');
  const parts=noExt.split('/').filter(Boolean);
  let base=parts.slice(-3).join('.').replace(/[^A-Za-z0-9_.-]/g,'.').replace(/\.+/g,'.').toLowerCase() || 'root';
  if(!used) return base;
  if(!used[base]){ used[base]=1; return base; }
  // Expand with more path context before falling back to numeric suffixes.
  for(let depth=4; depth<=Math.min(8,parts.length); depth++){
    const candidate=parts.slice(-depth).join('.').replace(/[^A-Za-z0-9_.-]/g,'.').replace(/\.+/g,'.').toLowerCase();
    if(candidate && !used[candidate]){ used[candidate]=1; used[base]++; return candidate; }
  }
  const next=++used[base];
  return `${base}.${next}`;
}
function moduleTypeFromPath(path){
  const p=path.toLowerCase();
  if(/(test|spec|__tests__)/.test(p)) return 'quality';
  if(/(schema|migration|\.sql$|database|db)/.test(p)) return 'database';
  if(/(api|server|backend|route|controller)/.test(p)) return 'backend';
  if(/(component|pages|app\/|frontend|\.tsx$|\.jsx$|\.vue$|\.svelte$)/.test(p)) return 'frontend';
  if(/(deploy|docker|ci|workflow|\.sh$)/.test(p)) return 'ops';
  return 'service';
}
function analyzeProjectFiles(entries, allFiles){
  const modules=[]; const byId={}; const pathToId={}; const usedIds={}; const edges=[]; const packageDeps=new Set();
  entries.forEach(e=>{
    const id=fileModuleId(e.path, usedIds); pathToId[e.path]=id; const type=moduleTypeFromPath(e.path);
    const imports=[...e.content.matchAll(/(?:import\s+(?:[^'\"]*?\s+from\s+)?['\"]([^'\"]+)['\"]|require\(['\"]([^'\"]+)['\"]\)|from\s+([A-Za-z0-9_\.]+)\s+import)/g)].map(m=>m[1]||m[2]||m[3]).filter(Boolean).slice(0,20);
    const symbols=[...e.content.matchAll(/(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var|def)\s+([A-Za-z0-9_]+)/g)].map(m=>m[1]).slice(0,30);
    if(!byId[id]) byId[id]={id,type,layer:moduleFromId(id,'').layer, files:[], imports:new Set(), symbols:new Set(), dependsOn:new Set(), purpose:`Imported source module inferred from ${id}.`};
    byId[id].files.push(e.path); imports.forEach(x=>byId[id].imports.add(x)); symbols.forEach(x=>byId[id].symbols.add(x));
    if(/package\.json$/i.test(e.path)){ try{ const pkg=JSON.parse(e.content); Object.keys({...pkg.dependencies,...pkg.devDependencies}).forEach(d=>packageDeps.add(d)); }catch{} }
  });
  const ids=Object.keys(byId);
  ids.forEach(id=>{
    const m=byId[id];
    m.imports.forEach(spec=>{
      if(spec.startsWith('.')||spec.startsWith('/')){
        const short=spec.replace(/^\.\/?/,'').replace(/\.[^.]+$/,'').replace(/\/index$/,'').replace(/\//g,'.').toLowerCase();
        const match=ids.find(other=> other!==id && (other.endsWith(short) || short.endsWith(other.split('.').at(-1))));
        if(match){ m.dependsOn.add(match); edges.push([id,match]); }
      } else if(packageDeps.has(spec) || !spec.includes('/')) {
        const ext=`pkg.${spec.replace(/[^A-Za-z0-9_.-]/g,'.').toLowerCase()}`;
        m.dependsOn.add(ext); edges.push([id,ext]);
      }
    });
  });
  Object.values(byId).forEach(m=>modules.push({...m, imports:[...m.imports], symbols:[...m.symbols], dependsOn:[...m.dependsOn]}));
  const collisions=Object.entries(usedIds).filter(([,n])=>n>1).map(([base,count])=>({base,count}));
  return { files:entries.length, totalFiles:allFiles.length, modules, edges:[...new Set(edges.map(e=>e.join('->')))].map(s=>s.split('->')), packageDeps:[...packageDeps].slice(0,60), readmes:entries.filter(e=>/readme|guide|spec/i.test(e.path)).map(e=>e.path).slice(0,10), collisions };
}
function ingestProjectAnalysis(analysis, manifest){
  const modules=analysis.modules.slice(0,80).map(m=>({id:m.id,type:m.type,layer:m.layer,purpose:`Imported from ${m.files.slice(0,3).join(', ')}${m.files.length>3?'…':''}`,dependsOn:m.dependsOn.filter(d=>!d.startsWith('pkg.')).slice(0,12),usedBy:[],code:`// Imported module ${m.id}\n// Files:\n${m.files.map(f=>'// - '+f).join('\n')}\n// Symbols: ${m.symbols.slice(0,12).join(', ')||'none detected'}`}));
  const wires=analysis.edges.filter(([a,b])=>!b.startsWith('pkg.')).slice(0,160);
  return {type:'folder manifest',title:'Imported project',summary:`${analysis.files} text files analysed into ${modules.length} modules and ${wires.length} internal wires.`,modules,wires,rules:['Imported source should be verified before changing generated blueprint modules.','Package dependencies are external boundaries, not internal modules.'],tasks:['Review inferred modules','Confirm wiring edges','Run validation after merge'],conflicts:[],raw:manifest};
}
function buildProjectKnowledgeGraph(analysis, manifest){
  const concepts=analysis.modules.map(m=>({name:m.id, count:m.files.length+Math.max(1,m.symbols.length), confidence:Math.min(0.95,0.45+(m.files.length*0.08)+(m.symbols.length*0.01)), evidence:m.files.slice(0,3).join(', ')})).slice(0,80);
  const relations=analysis.edges.slice(0,160).map(([a,b])=>({a,b,weight:b.startsWith('pkg.')?0.35:0.75,evidence:'Static import relationship'}));
  const questions=concepts.slice(0,8).map(c=>({concept:c.name,prompt:`What depends on ${c.name}, and what could break if it changes?`,answerHint:`Use wiring and imported files: ${c.evidence}`}));
  return {subject:'imported project',type:'project files',concepts,relations,questions,rawSummary:manifest.slice(0,2000)};
}
function mergeProjectAnalysisIntoBlueprint(analysis){
  const bp=state.blueprint; if(!bp) return;
  const existing=new Set(Object.keys(bp.sections||{}));
  analysis.modules.slice(0,40).forEach(m=>{
    if(existing.has(m.id)) return;
    const internalDeps=m.dependsOn.filter(d=>!d.startsWith('pkg.') && analysis.modules.some(x=>x.id===d)).slice(0,8);
    bp.sections[m.id]={id:m.id,type:m.type,layer:m.layer,purpose:`Imported from real project files: ${m.files.slice(0,3).join(', ')}`,dependsOn:internalDeps,usedBy:[],code:`// Imported source reference for ${m.id}\n// Files:\n${m.files.map(f=>'// - '+f).join('\n')}\n// Symbols: ${m.symbols.slice(0,12).join(', ')||'none detected'}`};
    bp.index.push({id:m.id,order:bp.index.length+1,type:m.type,layer:m.layer});
  });
  analysis.edges.filter(([a,b])=>!b.startsWith('pkg.') && bp.sections[a] && bp.sections[b]).forEach(edge=>{
    if(!bp.wiring.some(w=>w[0]===edge[0]&&w[1]===edge[1])) bp.wiring.push(edge);
  });
  bp.imports ||= [];
  bp.imports.push({date:today(), type:'real project files', title:'Browser folder/file import', summary:`Merged ${analysis.modules.length} inferred modules from ${analysis.files} text files.`, modules:analysis.modules.map(m=>m.id).slice(0,80)});
  bp.changelog.push({date:today(),actor:'Importer',change:`Imported real project files and inferred ${analysis.modules.length} modules.`});
  state.layoutCache={key:null,pos:null};
}
function buildProjectManifest(entries, allFiles, analysis=analyzeProjectFiles(entries, allFiles)){
  const tree=entries.map(e=>`- ${e.path} (${e.size} bytes)`).join('\n');
  const packageFile=entries.find(e=>/package\.json$/i.test(e.path));
  const packageSummary=packageFile ? (()=>{ try{ const pkg=JSON.parse(packageFile.content); return JSON.stringify({name:pkg.name,version:pkg.version,type:pkg.type,scripts:pkg.scripts,dependencies:Object.keys(pkg.dependencies||{}).slice(0,40),devDependencies:Object.keys(pkg.devDependencies||{}).slice(0,40)},null,2); }catch{return 'package.json present but could not be parsed.'} })() : 'No package.json found.';
  const moduleSummary=analysis.modules.slice(0,100).map(m=>`- ${m.id} [${m.type}] files=${m.files.length}; depends=${m.dependsOn.filter(d=>!d.startsWith('pkg.')).slice(0,8).join(', ')||'none'}; packages=${m.dependsOn.filter(d=>d.startsWith('pkg.')).slice(0,6).map(d=>d.replace(/^pkg\./,'')).join(', ')||'none'}; symbols=${m.symbols.slice(0,8).join(', ')||'none'}`).join('\n');
  const collisionSummary=(analysis.collisions||[]).length ? analysis.collisions.map(c=>`- ${c.base}: ${c.count} variants created`).join('\n') : 'No module ID collisions after de-duplication.';
  return `# Imported Project Manifest\n\n## Structured file tree\n${tree}\n\n## Inferred modules\n${moduleSummary}\n\n## Internal wiring\n${analysis.edges.filter(([a,b])=>!b.startsWith('pkg.')).slice(0,160).map(([a,b])=>`- ${a} -> ${b}`).join('\n') || 'No internal imports detected.'}\n\n## External packages\n${analysis.packageDeps.slice(0,80).map(d=>`- ${d}`).join('\n') || 'No package dependencies detected.'}\n\n## Package/config summary\n${packageSummary}\n\n## README/spec files detected\n${analysis.readmes.map(p=>`- ${p}`).join('\n') || 'None detected.'}\n\n## Module ID de-duplication\n${collisionSummary}\n\n## Import notes\nThis compact manifest was generated locally in the browser from ${allFiles.length} files. It intentionally excludes raw source and README excerpts to avoid prompt bloat. Use the structured modules, symbols, packages, and wiring above to update the blueprint, Qutri states, tests, and risk model.`;
}

// ─── EVENT WIRING ─────────────────────────────────────────────────────────────
document.querySelectorAll('.tab,.navPill,.engineChip').forEach(b=>b.addEventListener('click',()=>showTab(b.dataset.tab)));

document.getElementById('advancedToggle')?.addEventListener('click', toggleAdvancedTabs);
document.getElementById('guidedCreateBtn')?.addEventListener('click', runGuidedCreate);
document.getElementById('guidedBuildBtn')?.addEventListener('click', runGuidedBuild);
document.getElementById('guidedTestBtn')?.addEventListener('click', runGuidedTest);
document.getElementById('guidedFixBtn')?.addEventListener('click', runGuidedFix);
document.getElementById('healthNextBtn')?.addEventListener('click', goHealthNext);

document.getElementById('wizardBtn')?.addEventListener('click',()=>showTab('wizard'));
document.getElementById('openWizardBtn')?.addEventListener('click',()=>showTab('wizard'));
document.getElementById('wizardBackBtn')?.addEventListener('click',()=>setWizardStep(state.wizardStep-1));
document.getElementById('wizardNextBtn')?.addEventListener('click',()=>setWizardStep(state.wizardStep+1));
document.getElementById('wizardDoBtn')?.addEventListener('click',()=>{ wizardSyncInputs(); runWizardStep(); });

// Sidebar
document.getElementById('generateBtn').onclick=generateBlueprint;
document.getElementById('analyzeBtn').onclick=analyzeChange;
document.getElementById('applyBtn').onclick=applySimulatedChange;
document.getElementById('validateBtn').onclick=runValidation;

// Topbar
document.getElementById('themeBtn').onclick=()=>document.body.classList.toggle('light');
document.getElementById('saveBtn').onclick=save;
document.getElementById('loadBtn').onclick=()=>document.getElementById('projectFileInput').click();
document.getElementById('downloadStateBtn').onclick=downloadState;
document.getElementById('pauseBtn').onclick=()=>setPaused(!state.paused);
document.getElementById('exportBtn').onclick=exportProject;
document.getElementById('seedBtn').onclick=()=>{ document.getElementById('projectName').value='InvoiceFlow'; document.getElementById('brief').value='A full-stack invoice app with login, dashboard, invoices, payments, email receipts, tests and deployment config.'; document.getElementById('task').value='Add recurring invoices with Stripe subscriptions.'; generateBlueprint(); };
document.getElementById('projectFileInput').onchange=e=>{ if(e.target.files[0]) loadStateFromFile(e.target.files[0]); e.target.value=''; };

// API provider/key status
document.getElementById('providerSelect')?.addEventListener('change', () => {
  const cfg = providerDefaults[getProvider()];
  document.getElementById('modelInput').value = cfg.model;
  document.getElementById('apiKeyInput').value = '';
  updateProviderUi();
});
document.getElementById('modelInput')?.addEventListener('input', updateProviderUi);
document.getElementById('apiKeyInput').oninput=()=>{
  const k = document.getElementById('apiKeyInput').value.trim();
  const provider = getProvider();
  if (!k) { document.getElementById('apiKeyStatus').className='keyStatus'; document.getElementById('apiKeyStatus').textContent=''; }
  else if (provider === 'anthropic' && k.startsWith('sk-ant-')) updateKeyStatus(true, '✓ Claude key format ok');
  else if (provider === 'openai' && k.startsWith('sk-')) updateKeyStatus(true, '✓ OpenAI key format ok');
  else updateKeyStatus(false, 'Check key format');
};
updateProviderUi();

// AI Build tab
document.getElementById('aiSendBtn').onclick=aiSend;
document.getElementById('aiStopBtn').onclick=aiStop;
document.getElementById('aiClearBtn').onclick=aiClear;
document.getElementById('aiBuildBlueprintBtn').onclick=aiBuildFromBlueprint;
document.getElementById('aiAnalyzeBtn').onclick=aiAnalyzeChange;
document.getElementById('aiApplyCodeBtn').onclick=applyAllBlocks;
document.getElementById('aiCopyBtn').onclick=()=>{ navigator.clipboard.writeText(document.getElementById('aiOutput').textContent); toast('Copied'); };
document.getElementById('applyPromptTemplateBtn')?.addEventListener('click',()=>prefillAiPrompt(document.getElementById('promptTemplateSelect').value));
document.getElementById('promptTemplateSelect')?.addEventListener('change',()=>updateActiveContextHint(document.getElementById('promptTemplateSelect').value));
document.getElementById('aiUseContextBtn')?.addEventListener('click',useCurrentContextForAi);


// Create tab
document.getElementById('createBlueprintBtn').onclick=createFromAnything;
document.getElementById('ideaSampleBtn').onclick=()=>{document.getElementById('creationInput').value=ideaSample();document.getElementById('creationMode').value='idea'};
document.getElementById('guidedSampleBtn').onclick=()=>{document.getElementById('creationInput').value=guidedSample();document.getElementById('creationMode').value='guided'};
document.getElementById('reverseSampleBtn').onclick=()=>{document.getElementById('creationInput').value=reverseSample();document.getElementById('creationMode').value='reverse'};

// Importer tab
document.getElementById('loadGuideSampleBtn').onclick=()=>{document.getElementById('guideInput').value=sampleGuide();toast('Sample loaded')};
document.getElementById('analyzeGuideBtn').onclick=analyzeSource;
document.getElementById('importGuideBtn').onclick=importSource;
document.getElementById('clearGuideBtn').onclick=()=>{document.getElementById('guideInput').value='';state.ingestion=null;state.knowledge=null;renderImporter();renderKnowledge();};
document.getElementById('importFilesBtn')?.addEventListener('click', importRealProjectFiles);


// Knowledge tab
document.getElementById('buildKnowledgeBtn').onclick=()=>{ const raw=val('guideInput'); if(!raw){ showTab('importer'); toast('Paste or load source first'); return; } state.knowledge=buildKnowledgeGraph(raw, document.getElementById('sourceType').value); renderKnowledge(); showTab('knowledge'); toast('Knowledge graph built'); };
document.getElementById('knowledgeToBlueprintBtn').onclick=applyKnowledgeToBlueprint;

// Blueprint tab
document.getElementById('refreshBtn').onclick=render;

// Wiring tab
document.getElementById('fitBtn').onclick=()=>{renderDiagram(state.blueprint);toast('Layout refreshed')};

// Sections tab
document.getElementById('sectionSearch').addEventListener('input',()=>renderSections(state.blueprint));

// Validator tab
document.getElementById('badAiBtn').onclick=simulateBadAI;
document.getElementById('fenceCheckBtn').onclick=runFenceCheck;
document.getElementById('validatorToAiBtn')?.addEventListener('click', sendValidationToAi);


// Testing tab
document.getElementById('buildTestsBtn').onclick=()=>{buildTestPlan(); renderTesting(); showTab('testing'); toast('Test plan built');};
document.getElementById('runTestsBtn').onclick=()=>{if(!state.testPlan) buildTestPlan(); runTestingEngine(true); showTab('testing');};
document.getElementById('watchdogBtn').onclick=watchdogRetest;
document.getElementById('testsToAiBtn')?.addEventListener('click', sendTestsToAi);


// Git tab
document.getElementById('commitMemoryBtn').onclick=recordChangeMemory;
document.getElementById('exportPatchBtn').onclick=exportPatchNote;
document.getElementById('memorySearch').addEventListener('input',renderChangeMemory);

// Agents tab
document.getElementById('runAgentsBtn').onclick=runAgentReview;
document.getElementById('addAgentBtn').onclick=addAgent;

// Deploy tab
document.getElementById('buildDeployBtn').onclick=buildDeploymentPlan;
document.getElementById('markDeployedBtn').onclick=markDeployed;

// Brain tab
document.getElementById('refreshBrainBtn').onclick=()=>{buildBrain(); renderBrain(); toast('Brain refreshed');};
document.getElementById('brainFocusAffectedBtn').onclick=focusBrainAffected;
document.getElementById('runQutriBtn').onclick=()=>runQutriScan(true);
document.getElementById('qutriApplyBtn').onclick=applyQutriToBrain;
document.getElementById('qutriToAiBtn')?.addEventListener('click', sendQutriToAi);


// Blueprint diff tab
document.getElementById('captureBaselineBtn')?.addEventListener('click',()=>captureBlueprintBaseline(true));
document.getElementById('runDiffBtn')?.addEventListener('click',()=>runBlueprintDiff(true));
document.getElementById('acceptDiffBtn')?.addEventListener('click',acceptBlueprintBaseline);
document.getElementById('exportDiffBtn')?.addEventListener('click',exportBlueprintDiff);
document.getElementById('diffToAiBtn')?.addEventListener('click',sendDiffToAi);


// State tab
document.getElementById('stateSaveBtn').onclick=save;
document.getElementById('stateLoadBtn').onclick=()=>document.getElementById('projectFileInput').click();
document.getElementById('stateDownloadBtn').onclick=downloadState;
document.getElementById('statePauseBtn').onclick=()=>setPaused(!state.paused);
document.getElementById('runCycleBtn').onclick=runEngineCycle;
document.getElementById('resetProjectBtn').onclick=resetProject;
document.getElementById('autosaveToggle').onchange=e=>{state.autosave=e.target.checked; autosave(); renderStatePanel(); toast(state.autosave?'Autosave on':'Autosave off');};

// Export tab
document.getElementById('copyManifestBtn').onclick=copyManifest;

// ─── KEY WARNING BANNER ───────────────────────────────────────────────────────
(function initKeyWarningBanner() {
  const banner = document.getElementById('keyWarningBanner');
  const closeBtn = document.getElementById('keyWarningClose');
  if (!banner || !closeBtn) return;
  const dismissed = localStorage.getItem('wirestack.keyWarningDismissed');
  if (!dismissed) banner.style.display = 'flex';
  closeBtn.onclick = () => {
    banner.style.display = 'none';
    localStorage.setItem('wirestack.keyWarningDismissed', '1');
  };
})();

// ─── INIT ─────────────────────────────────────────────────────────────────────
if(!load()) generateBlueprint(); else render();

showTab('wizard');
