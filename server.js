#!/usr/bin/env node
/*
  WireStack + Boom3 Hybrid
  - Boom3-style simple chat UI
  - WireStack brain behind the scenes: blueprint, wiring, qutri, diff, health
  - AI team roles using OpenAI/Anthropic when keys are present
  - Workspace runner: apply files, install deps, run tests, package if passing
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.resolve(process.env.WIRESTACK_WORKSPACE || path.join(__dirname, 'workspace'));
const STATE_FILE = path.join(ROOT, '.wirestack-state.json');
const MAX_BODY = 25 * 1024 * 1024;
const TIMEOUT_MS = Number(process.env.WIRESTACK_TEST_TIMEOUT_MS || 120000);
fs.mkdirSync(ROOT, { recursive: true });

const DEFAULT_STATE = {
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  aiMode: 'dual',
  roles: {
    architect: { provider: 'anthropic', model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5', enabled: true },
    builder: { provider: 'openai', model: process.env.OPENAI_MODEL || 'gpt-5.5', enabled: true },
    tester: { provider: 'openai', model: process.env.OPENAI_MODEL || 'gpt-5.5', enabled: true },
    reviewer: { provider: 'anthropic', model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5', enabled: true },
    security: { provider: 'anthropic', model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5', enabled: true }
  },
  blueprint: {
    name: 'Untitled App',
    purpose: 'Describe your idea in chat to create this.',
    stack: 'auto',
    modules: [],
    wiring: [],
    rules: [],
    tasks: [],
    changelog: []
  },
  qutri: {},
  lastDiff: null,
  health: { score: 10, status: 'unknown', notes: ['No app built yet.'] },
  conversation: []
};

function loadState() {
  try { return { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; }
  catch { return structuredClone(DEFAULT_STATE); }
}
function saveState(state) {
  state.updatedAt = new Date().toISOString();
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  return state;
}
let state = loadState();

function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(JSON.stringify(data, null, 2));
}
function sendRaw(res, status, body, type='text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > MAX_BODY) reject(new Error('Body too large')); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function commandExists(cmd) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  const names = process.platform === 'win32' ? [cmd, `${cmd}.exe`, `${cmd}.cmd`] : [cmd];
  return dirs.some(d => names.some(n => fs.existsSync(path.join(d, n))));
}
function run(cmd, args = [], cwd = ROOT, timeout = TIMEOUT_MS) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd, shell: process.platform === 'win32', env: process.env });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { stderr += `\nTIMEOUT after ${timeout}ms`; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('close', code => { clearTimeout(timer); resolve({ cmd: [cmd, ...args].join(' '), code, stdout: stdout.slice(-20000), stderr: stderr.slice(-20000) }); });
    child.on('error', err => { clearTimeout(timer); resolve({ cmd: [cmd, ...args].join(' '), code: 127, stdout, stderr: err.message }); });
  });
}
function safePath(filePath) {
  let clean = String(filePath || '').replace(/^[A-Za-z]:/, '').replace(/\\/g, '/').replace(/^\/+/, '');
  clean = clean.split('/').filter(Boolean).join('/');
  if (!clean || clean.includes('..')) throw new Error(`Unsafe path: ${filePath}`);
  const abs = path.resolve(ROOT, clean);
  if (!abs.startsWith(ROOT + path.sep) && abs !== ROOT) throw new Error(`Path escapes workspace: ${filePath}`);
  return abs;
}
function walk(dir = ROOT, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules','.git','dist','build','.next','__pycache__','.venv','venv'].includes(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out); else out.push(abs);
  }
  return out;
}
function listFiles() {
  return walk(ROOT).filter(f => !f.endsWith('.wirestack-state.json')).map(abs => ({ path: path.relative(ROOT, abs), bytes: fs.statSync(abs).size }));
}
function hashBlueprint(bp) { return crypto.createHash('sha1').update(JSON.stringify(bp)).digest('hex').slice(0, 12); }
function snapshotBlueprint() { return JSON.parse(JSON.stringify(state.blueprint)); }
function diffBlueprint(before, after) {
  const b = new Map((before.modules || []).map(m => [m.id, m]));
  const a = new Map((after.modules || []).map(m => [m.id, m]));
  const added = [...a.keys()].filter(k => !b.has(k));
  const removed = [...b.keys()].filter(k => !a.has(k));
  const changed = [...a.keys()].filter(k => b.has(k) && JSON.stringify(a.get(k)) !== JSON.stringify(b.get(k)));
  const bw = new Set((before.wiring || []).map(x => `${x.from}->${x.to}`));
  const aw = new Set((after.wiring || []).map(x => `${x.from}->${x.to}`));
  return { at: new Date().toISOString(), beforeHash: hashBlueprint(before), afterHash: hashBlueprint(after), modules: { added, removed, changed }, wiring: { added: [...aw].filter(x => !bw.has(x)), removed: [...bw].filter(x => !aw.has(x)) } };
}
function moduleId(label) { return String(label).toLowerCase().replace(/[^a-z0-9]+/g,'.').replace(/^\.+|\.+$/g,'').slice(0,60) || 'module'; }
function addModule(id, purpose, type='module') {
  if (!state.blueprint.modules.some(m => m.id === id)) state.blueprint.modules.push({ id, type, purpose, files: [], status: 'unknown' });
}
function addWire(from,to,reason='') { if (from !== to && !state.blueprint.wiring.some(w => w.from === from && w.to === to)) state.blueprint.wiring.push({ from, to, reason }); }
function inferBlueprintFromText(text) {
  const before = snapshotBlueprint();
  const lower = text.toLowerCase();
  const name = (text.match(/(?:build|make|create) (?:me )?(?:an? )?([^\.\n]{3,60})/i)||[])[1];
  if (name && state.blueprint.name === 'Untitled App') state.blueprint.name = name.trim().replace(/with.*$/i,'').trim();
  state.blueprint.purpose = text.slice(0, 3000);
  const features = [
    ['auth','api.auth','Authentication and user sessions'], ['login','ui.login','Login UI'], ['dashboard','ui.dashboard','Main dashboard'],
    ['booking','svc.bookings','Booking service'], ['calendar','ui.calendar','Calendar interface'], ['customer','db.customers','Customer data'],
    ['invoice','svc.invoices','Invoice service'], ['payment','svc.payments','Payment provider integration'], ['stripe','svc.payments','Stripe payment provider'],
    ['email','svc.email','Email notifications'], ['reminder','svc.notifications','Reminder notifications'], ['admin','ui.admin','Admin panel'],
    ['database','db.core','Database schema'], ['test','tests','Automated tests'], ['mobile','ui.responsive','Responsive/mobile UI']
  ];
  for (const [kw,id,purpose] of features) if (lower.includes(kw)) addModule(id,purpose,id.split('.')[0]);
  if (!state.blueprint.modules.length) {
    ['ui.app','api.app','db.core','tests'].forEach((id,i)=>addModule(id, ['Main user interface','Application API','Data storage','Automated tests'][i], id.split('.')[0]));
  }
  addWire('ui.dashboard','api.app','UI calls backend API');
  if (state.blueprint.modules.some(m=>m.id==='svc.bookings')) { addWire('ui.dashboard','svc.bookings','Dashboard manages bookings'); addWire('svc.bookings','db.customers','Bookings use customers'); }
  if (state.blueprint.modules.some(m=>m.id==='svc.payments')) { addWire('svc.invoices','svc.payments','Invoices use payment provider'); addWire('svc.payments','db.customers','Payment customer IDs stored locally'); }
  if (state.blueprint.modules.some(m=>m.id==='svc.email')) addWire('svc.bookings','svc.email','Bookings trigger email messages');
  state.blueprint.tasks.unshift({ at: new Date().toISOString(), text, status: 'planned' });
  updateQutriAndHealth('blueprint updated');
  state.lastDiff = diffBlueprint(before, state.blueprint);
}
function updateQutriAndHealth(reason='') {
  const files = listFiles();
  const fileText = files.map(f => f.path).join('\n').toLowerCase();
  const q = {};
  for (const m of state.blueprint.modules) {
    const key = m.id.toLowerCase().split('.').pop();
    const hasFile = fileText.includes(key) || files.some(f => f.path.toLowerCase().includes(m.id.replace(/\./g,'/')));
    const hasWiring = state.blueprint.wiring.some(w => w.from === m.id || w.to === m.id);
    q[m.id] = hasFile && hasWiring ? 'verified' : hasFile ? 'partial' : hasWiring ? 'partial' : 'unknown';
  }
  const vals = Object.values(q);
  const score = vals.length ? Math.round(vals.reduce((s,v)=>s + ({verified:100,partial:60,unknown:25,conflicted:5}[v]||25),0)/vals.length) : 10;
  state.qutri = q;
  state.health = { score, status: score > 80 ? 'good' : score > 55 ? 'partial' : 'needs work', notes: [reason, `${files.length} workspace files`, `${vals.filter(v=>v==='verified').length}/${vals.length} modules verified`].filter(Boolean) };
}

function extractCodeBlocks(text) {
  const blocks = [];
  const re = /(?:^|\n)\s*(?:#{1,4}\s*)?(?:File|Path):\s*`?([^`\n]+?)`?\s*\n+```([\w.+-]*)\n([\s\S]*?)```/gi;
  let m;
  while ((m = re.exec(text))) blocks.push({ path: m[1].trim(), lang: m[2] || '', code: m[3].replace(/\n$/, '') });
  const re2 = /```([\w.+-]*)\n([\s\S]*?)```/g;
  let index = 0;
  while ((m = re2.exec(text))) {
    if (blocks.some(b => b.code === m[2].replace(/\n$/,''))) continue;
    blocks.push({ path: inferPath({lang:m[1]}, index++), lang: m[1] || '', code: m[2].replace(/\n$/, '') });
  }
  return blocks;
}
function inferPath(block, index) {
  const lang = String(block.lang || '').toLowerCase();
  const ext = lang.includes('python')||lang==='py' ? 'py' : lang.includes('html') ? 'html' : lang.includes('css') ? 'css' : lang.includes('json') ? 'json' : lang.includes('sql') ? 'sql' : lang.includes('md') ? 'md' : 'js';
  return `generated/file-${index+1}.${ext}`;
}
async function applyBlocks(blocks) {
  const written = [];
  for (let i=0;i<blocks.length;i++) {
    const b = blocks[i];
    const abs = safePath(b.path || inferPath(b,i));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, String(b.code || ''), 'utf8');
    written.push({ path: path.relative(ROOT, abs), bytes: Buffer.byteLength(String(b.code || ''),'utf8') });
  }
  updateQutriAndHealth('files applied');
  return written;
}
async function syntaxChecks() {
  const results = [];
  for (const abs of walk(ROOT)) {
    const rel = path.relative(ROOT, abs);
    if (rel === '.wirestack-state.json') continue;
    if (/\.(js|cjs|mjs)$/.test(rel)) results.push({ file: rel, ...(await run(process.execPath, ['--check', abs])) });
    else if (/\.json$/.test(rel)) { try { JSON.parse(fs.readFileSync(abs,'utf8')); results.push({ file: rel, cmd:'JSON.parse', code:0, stdout:'valid', stderr:'' }); } catch(e) { results.push({ file:rel, cmd:'JSON.parse', code:1, stdout:'', stderr:e.message }); } }
    else if (/\.py$/.test(rel) && commandExists('python3')) results.push({ file: rel, ...(await run('python3', ['-m','py_compile', abs])) });
  }
  return results;
}
function readTextSafe(abs, max=200000) {
  try { return fs.readFileSync(abs, 'utf8').slice(0, max); } catch { return ''; }
}
const BUILTIN_NODE_MODULES = new Set(['fs','path','http','https','url','crypto','child_process','os','util','events','stream','buffer','querystring','zlib','net','tls','readline','perf_hooks']);
const COMMON_JS_PACKAGES = {
  express:'express', cors:'cors', stripe:'stripe', pg:'pg', postgres:'postgres', mongoose:'mongoose', bcrypt:'bcryptjs', bcryptjs:'bcryptjs', jsonwebtoken:'jsonwebtoken', jwt:'jsonwebtoken', dotenv:'dotenv', axios:'axios', nodemailer:'nodemailer', uuid:'uuid', sqlite3:'sqlite3', better_sqlite3:'better-sqlite3', react:'react', 'react-dom':'react-dom', vite:'vite', typescript:'typescript', jest:'jest', vitest:'vitest', supertest:'supertest', zod:'zod', prisma:'prisma', '@prisma/client':'@prisma/client'
};
const COMMON_PY_PACKAGES = { flask:'flask', fastapi:'fastapi', uvicorn:'uvicorn', requests:'requests', stripe:'stripe', sqlalchemy:'sqlalchemy', psycopg2:'psycopg2-binary', dotenv:'python-dotenv', numpy:'numpy', pandas:'pandas', pytest:'pytest' };
function detectJsDependencies() {
  const deps = new Set();
  for (const abs of walk(ROOT)) {
    if (!/\.(js|mjs|cjs|jsx|ts|tsx)$/.test(abs)) continue;
    const t = readTextSafe(abs);
    const patterns = [ /from\s+['"]([^'"]+)['"]/g, /require\(\s*['"]([^'"]+)['"]\s*\)/g, /import\(\s*['"]([^'"]+)['"]\s*\)/g ];
    for (const re of patterns) { let m; while ((m = re.exec(t))) {
      let name = m[1];
      if (name.startsWith('.') || name.startsWith('/') || name.startsWith('node:')) continue;
      const pkg = name.startsWith('@') ? name.split('/').slice(0,2).join('/') : name.split('/')[0];
      if (!BUILTIN_NODE_MODULES.has(pkg)) deps.add(COMMON_JS_PACKAGES[pkg] || pkg);
    }}
  }
  return [...deps].sort();
}
function detectPyDependencies() {
  const deps = new Set();
  for (const abs of walk(ROOT)) {
    if (!/\.py$/.test(abs)) continue;
    const t = readTextSafe(abs);
    const re = /^(?:from|import)\s+([a-zA-Z_][\w]*)/gm; let m;
    while ((m = re.exec(t))) {
      const mod = m[1];
      if (['os','sys','re','json','time','datetime','pathlib','typing','subprocess','sqlite3','unittest','tempfile','uuid','hashlib','random','math','collections','itertools','functools','dataclasses'].includes(mod)) continue;
      deps.add(COMMON_PY_PACKAGES[mod] || mod);
    }
  }
  return [...deps].sort();
}
function ensurePackageJson(jsDeps) {
  const pkgPath = path.join(ROOT, 'package.json');
  let pkg = {};
  if (fs.existsSync(pkgPath)) { try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { pkg = {}; } }
  if (!pkg.name) pkg.name = moduleId(state.blueprint.name || 'wirestack-generated-app').replace(/\./g,'-');
  if (!pkg.version) pkg.version = '0.1.0';
  if (!pkg.scripts) pkg.scripts = {};
  if (!pkg.scripts.start) {
    if (fs.existsSync(path.join(ROOT,'server.js'))) pkg.scripts.start = 'node server.js';
    else if (fs.existsSync(path.join(ROOT,'src/server.js'))) pkg.scripts.start = 'node src/server.js';
    else if (fs.existsSync(path.join(ROOT,'index.html'))) pkg.scripts.start = 'node server.js';
  }
  if (!pkg.scripts.test) {
    if (jsDeps.includes('jest')) pkg.scripts.test = 'jest';
    else if (jsDeps.includes('vitest')) pkg.scripts.test = 'vitest run';
    else pkg.scripts.test = 'node --test';
  }
  pkg.dependencies = pkg.dependencies || {};
  pkg.devDependencies = pkg.devDependencies || {};
  for (const dep of jsDeps) {
    if (['jest','vitest','supertest','typescript','vite'].includes(dep)) pkg.devDependencies[dep] = pkg.devDependencies[dep] || 'latest';
    else pkg.dependencies[dep] = pkg.dependencies[dep] || 'latest';
  }
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  return pkg;
}
function ensureRequirements(pyDeps) {
  const req = path.join(ROOT,'requirements.txt');
  const existing = fs.existsSync(req) ? new Set(fs.readFileSync(req,'utf8').split(/\r?\n/).map(x=>x.trim()).filter(Boolean)) : new Set();
  pyDeps.forEach(d => existing.add(d));
  if (existing.size) fs.writeFileSync(req, [...existing].sort().join('\n') + '\n');
  return [...existing].sort();
}
async function installDeps() {
  const jsDeps = detectJsDependencies();
  const pyDeps = detectPyDependencies();
  const dependencyReport = { js: jsDeps, python: pyDeps, created: [] };
  if (jsDeps.length || walk(ROOT).some(f => /\.(js|mjs|cjs|jsx|ts|tsx)$/.test(f))) { ensurePackageJson(jsDeps); dependencyReport.created.push('package.json'); }
  if (pyDeps.length) { ensureRequirements(pyDeps); dependencyReport.created.push('requirements.txt'); }
  const results = [];
  if (fs.existsSync(path.join(ROOT,'package.json')) && commandExists('npm')) results.push(await run('npm', [fs.existsSync(path.join(ROOT,'package-lock.json')) ? 'ci' : 'install']));
  if (fs.existsSync(path.join(ROOT,'requirements.txt')) && commandExists('python3')) results.push(await run('python3', ['-m','pip','install','-r','requirements.txt']));
  if (!results.length) results.push({ cmd:'install', code:0, stdout:'No dependency manifest or installer detected.', stderr:'' });
  return { dependencyReport, results, code: results.some(r=>r.code!==0) ? 1 : 0, stdout: results.map(r=>`$ ${r.cmd}\n${r.stdout}`).join('\n'), stderr: results.map(r=>r.stderr).filter(Boolean).join('\n') };
}
async function runTests(custom) {
  const syntax = await syntaxChecks();
  const commands = [];
  if (custom) { const p = custom.split(' ').filter(Boolean); commands.push(await run(p[0], p.slice(1))); }
  else if (fs.existsSync(path.join(ROOT,'package.json')) && commandExists('npm')) {
    let pkg = {}; try { pkg = JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8')); } catch {}
    if (pkg.scripts?.test) commands.push(await run('npm', ['test']));
    else if (pkg.scripts?.start) commands.push(await run('npm', ['run','start'], ROOT, 5000));
    else commands.push({cmd:'npm test', code:0, stdout:'No test/start script; syntax checks only.', stderr:''});
  } else if (walk(ROOT).some(f=>f.endsWith('.py')) && commandExists('python3')) commands.push(await run('python3', ['-m','unittest','discover']));
  else commands.push({cmd:'auto test', code:0, stdout:'No test runner detected; syntax checks only.', stderr:''});
  const failed = [...syntax, ...commands].filter(x => x.code !== 0);
  updateQutriAndHealth(failed.length ? 'tests failed' : 'tests passed');
  return { status: failed.length ? 'FAILED' : 'PASSED', syntax, commands, failed };
}
async function packageApp() {
  const tests = await runTests();
  if (tests.status !== 'PASSED') return { status:'BLOCKED', reason:'Tests must pass first.', tests };
  const dist = path.join(ROOT,'dist'); fs.mkdirSync(dist,{recursive:true});
  if (walk(ROOT).some(f=>f.endsWith('.py')) && commandExists('pyinstaller')) {
    const main = walk(ROOT).map(f=>path.relative(ROOT,f)).find(f=>/(main|app|index)\.py$/.test(f)) || walk(ROOT).map(f=>path.relative(ROOT,f)).find(f=>f.endsWith('.py'));
    const r = await run('pyinstaller', ['--onefile', main]);
    return { status:r.code===0?'PASSED':'FAILED', kind:'python-exe', result:r, artifactDir:path.join(ROOT,'dist') };
  }
  if (commandExists('zip')) {
    const out = path.join(dist,'finished-app.zip');
    const r = await run('zip', ['-r', out, '.']);
    return { status:r.code===0?'PASSED':'FAILED', kind:'zip', artifact:out, result:r };
  }
  const manifest = listFiles();
  fs.writeFileSync(path.join(dist,'finished-app-manifest.json'), JSON.stringify(manifest,null,2));
  return { status:'PASSED', kind:'manifest', artifact:path.join(dist,'finished-app-manifest.json'), note:'zip not available; manifest created.' };
}

function buildSystemPrompt(role) {
  return `You are WireStack ${role}. The user wants to chat naturally while you build the app behind the scenes.
Return practical output. If creating/modifying files, use this exact format before every code block:
File: path/to/file.ext
\`\`\`language
code
\`\`\`

Current blueprint:
${JSON.stringify(state.blueprint, null, 2)}

Qutri states:
${JSON.stringify(state.qutri, null, 2)}

Health:
${JSON.stringify(state.health, null, 2)}

Workspace files:
${JSON.stringify(listFiles().slice(0,80), null, 2)}
`;
}
async function callOpenAI(model, messages) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');
  const response = await fetch('https://api.openai.com/v1/responses', {
    method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${process.env.OPENAI_API_KEY}`},
    body: JSON.stringify({ model, input: messages.map(m => `${m.role.toUpperCase()}:\n${m.content}`).join('\n\n') })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || JSON.stringify(data));
  return data.output_text || (data.output || []).flatMap(o => o.content || []).map(c => c.text || '').join('\n');
}
async function callAnthropic(model, messages) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  const sys = messages.find(m=>m.role==='system')?.content || '';
  const user = messages.filter(m=>m.role!=='system').map(m=>({ role:m.role==='assistant'?'assistant':'user', content:m.content }));
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST', headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},
    body: JSON.stringify({ model, max_tokens: 8000, system: sys, messages: user })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || JSON.stringify(data));
  return (data.content || []).map(c => c.text || '').join('\n');
}
async function runRole(role, userPrompt) {
  const cfg = state.roles[role] || state.roles.builder;
  const messages = [{role:'system', content: buildSystemPrompt(role)}, {role:'user', content:userPrompt}];
  if (cfg.provider === 'anthropic') return await callAnthropic(cfg.model, messages);
  return await callOpenAI(cfg.model, messages);
}
function localFallback(prompt) {
  inferBlueprintFromText(prompt);
  return `I updated the blueprint from your request. No AI API key was available, so I made a local scaffold.\n\nFile: README.md\n\`\`\`md\n# ${state.blueprint.name}\n\n${state.blueprint.purpose}\n\n## Modules\n${state.blueprint.modules.map(m=>`- ${m.id}: ${m.purpose}`).join('\n')}\n\n## Run\nOpen index.html or add real backend code.\n\`\`\`\n\nFile: index.html\n\`\`\`html\n<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${state.blueprint.name}</title><link rel="stylesheet" href="style.css"></head><body><main><h1>${state.blueprint.name}</h1><p>${state.blueprint.purpose.replace(/</g,'&lt;').slice(0,500)}</p><section id="app"></section><script src="app.js"></script></main></body></html>\n\`\`\`\n\nFile: style.css\n\`\`\`css\nbody{font-family:system-ui;margin:0;background:#f6f7fb;color:#172033}main{max-width:900px;margin:40px auto;background:white;border-radius:20px;padding:30px;box-shadow:0 20px 60px #0001}h1{color:#6842ff}\n\`\`\`\n\nFile: app.js\n\`\`\`javascript\ndocument.getElementById('app').innerHTML = '<h2>First scaffold ready</h2><p>Next, ask WireStack to add a feature.</p>';\n\`\`\``;
}
function summarizeResult(res) {
  return {
    intent: res.intent,
    outcome: res.outcome,
    filesWritten: res.written?.map(w => w.path) || [],
    install: res.install ? { code: res.install.code, dependencies: res.install.dependencyReport } : null,
    tests: res.tests ? { status: res.tests.status, failures: (res.tests.failed || []).length } : null,
    package: res.package ? { status: res.package.status, kind: res.package.kind, artifact: res.package.artifact || res.package.artifactDir } : null,
    health: state.health
  };
}
async function buildFullAppFromIdea(text) {
  const stages = [];
  stages.push({ stage:'understand', status:'running' });
  inferBlueprintFromText(text);
  stages[stages.length-1].status = 'done';
  stages.push({ stage:'generate', status:'running' });
  const prompt = `${text}\n\nBuild this as a complete runnable app. Include all required files, package.json or requirements.txt, tests, and clear start/test scripts. Use File: path headers before every code block.`;
  const result = await handleCommand(prompt, { autoApply:true, skipFullAppShortcut:true });
  stages[stages.length-1].status = result.written?.length ? 'done' : 'partial';
  stages.push({ stage:'dependencies', status: result.install?.code === 0 ? 'done' : 'failed', detail: result.install?.dependencyReport });
  stages.push({ stage:'tests', status: result.tests?.status === 'PASSED' ? 'done' : 'failed', detail: result.tests?.status });
  let pkg = null;
  if (result.tests?.status === 'PASSED') {
    stages.push({ stage:'package', status:'running' });
    pkg = await packageApp();
    stages[stages.length-1].status = pkg.status === 'PASSED' ? 'done' : 'failed';
  }
  return { intent:'full-app', outcome:'Full app pipeline completed', stages, ...result, package: pkg || result.package, summary: summarizeResult(result), state: publicState() };
}
function intentOf(text) {
  const l = text.toLowerCase();
  if (/package|exe|download|build final/.test(l)) return 'package';
  if (/test|run|check|verify/.test(l)) return 'test';
  if (/fix|repair|not good|wasn't good|wasnt good|bug|error|broken/.test(l)) return 'repair';
  if (/explain|what is|how does/.test(l)) return 'explain';
  if (/deploy|render|host/.test(l)) return 'deploy';
  return 'build';
}
async function handleCommand(text, options={}) {
  if (!options.skipFullAppShortcut && /full app|finished app|complete app|from idea.*works|build.*works/i.test(text)) return await buildFullAppFromIdea(text);
  const before = snapshotBlueprint();
  const intent = intentOf(text);
  let aiText = '';
  let role = intent === 'test' ? 'tester' : intent === 'repair' ? 'builder' : intent === 'explain' ? 'architect' : 'builder';
  if (/liked|like that|keep/.test(text.toLowerCase())) {
    state.blueprint.changelog.unshift({ at:new Date().toISOString(), type:'feedback-positive', text });
  }
  if (/not good|wasn't good|wasnt good|don't like|dont like/.test(text.toLowerCase())) {
    state.blueprint.tasks.unshift({ at:new Date().toISOString(), status:'repair-needed', text });
    Object.keys(state.qutri).slice(0,3).forEach(k => state.qutri[k] = 'conflicted');
  }
  if (intent === 'package') {
    const pkg = await packageApp();
    saveState(state);
    return { intent, outcome:'Package attempted', package:pkg, state: publicState() };
  }
  if (intent === 'test') {
    const tests = await runTests();
    saveState(state);
    return { intent, outcome:'Tests run', tests, state: publicState() };
  }
  inferBlueprintFromText(text);
  try {
    aiText = await runRole(role, `${text}\n\nIntent: ${intent}. Work through it. If code is needed, produce complete files with File: headers.`);
  } catch (e) {
    aiText = localFallback(text) + `\n\nAI note: ${e.message}`;
  }
  const blocks = extractCodeBlocks(aiText);
  let written = [];
  if (blocks.length && options.autoApply !== false) written = await applyBlocks(blocks);
  let install = null, tests = null, repairText = '';
  if (written.length) {
    install = await installDeps();
    tests = await runTests();
    if (tests.status === 'FAILED' && process.env.OPENAI_API_KEY) {
      try {
        repairText = await runRole('builder', `The generated files failed tests. Repair them.\n\nFailures:\n${JSON.stringify(tests.failed, null, 2).slice(0,12000)}`);
        const repairBlocks = extractCodeBlocks(repairText);
        if (repairBlocks.length) { written.push(...await applyBlocks(repairBlocks)); tests = await runTests(); }
      } catch (e) { repairText = `Auto repair unavailable: ${e.message}`; }
    }
  }
  let autoPackage = null;
  if (tests?.status === 'PASSED' && /package|exe|finished|complete|full app/i.test(text)) autoPackage = await packageApp();
  state.lastDiff = diffBlueprint(before, state.blueprint);
  state.conversation.push({ at:new Date().toISOString(), user:text, intent, ai:aiText.slice(0,20000), written, testsStatus: tests?.status });
  saveState(state);
  return { intent, role, outcome: written.length ? `Applied ${written.length} file(s)` : 'Blueprint/chat updated', aiText, written, install, tests, package: autoPackage, repairText, diff: state.lastDiff, state: publicState(), summary: { filesWritten: written.length, tests: tests?.status, package: autoPackage?.status, health: state.health.score } };
}
function publicState() { updateQutriAndHealth(); return { blueprint: state.blueprint, qutri: state.qutri, health: state.health, lastDiff: state.lastDiff, files: listFiles(), aiMode: state.aiMode, roles: state.roles, hasKeys: { openai: !!process.env.OPENAI_API_KEY, anthropic: !!process.env.ANTHROPIC_API_KEY } }; }

const MIME = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8'};
function serveStatic(req,res) {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  const abs = path.join(__dirname, p.replace(/^\/+/, ''));
  if (!abs.startsWith(__dirname) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return send(res,404,{error:'Not found'});
  sendRaw(res,200,fs.readFileSync(abs),MIME[path.extname(abs)]||'application/octet-stream');
}
const server = http.createServer(async (req,res)=>{
  if (req.method === 'OPTIONS') return send(res,200,{ok:true});
  try {
    if (!req.url.startsWith('/api/')) return serveStatic(req,res);
    if (req.method === 'GET' && req.url === '/api/state') return send(res,200,publicState());
    if (req.method === 'GET' && req.url === '/api/health') return send(res,200,{ok:true, workspace:ROOT, ...publicState().hasKeys});
    if (req.method === 'POST' && req.url === '/api/command') return send(res,200,await handleCommand((await readJson(req)).text || '', (await Promise.resolve({}))));
    if (req.method === 'POST' && req.url === '/api/apply') return send(res,200,{written: await applyBlocks((await readJson(req)).blocks || [])});
    if (req.method === 'POST' && req.url === '/api/test') return send(res,200,await runTests((await readJson(req)).command));
    if (req.method === 'POST' && req.url === '/api/package') return send(res,200,await packageApp());
    if (req.method === 'GET' && req.url.startsWith('/api/download')) {
      const target = path.join(ROOT,'dist','finished-app.zip');
      if (!fs.existsSync(target)) return send(res,404,{error:'No package artifact yet'});
      res.writeHead(200, {'Content-Type':'application/zip','Content-Disposition':'attachment; filename=finished-app.zip'});
      return fs.createReadStream(target).pipe(res);
    }
    if (req.method === 'POST' && req.url === '/api/reset') { fs.rmSync(ROOT,{recursive:true,force:true}); fs.mkdirSync(ROOT,{recursive:true}); state = structuredClone(DEFAULT_STATE); saveState(state); return send(res,200,{ok:true,state:publicState()}); }
    if (req.method === 'POST' && req.url === '/api/team') { const body = await readJson(req); state.aiMode = body.aiMode || state.aiMode; state.roles = body.roles || state.roles; saveState(state); return send(res,200,publicState()); }
    return send(res,404,{error:'API route not found'});
  } catch(e) { return send(res,500,{error:e.message, stack: process.env.NODE_ENV==='development'?e.stack:undefined}); }
});
server.listen(PORT,()=>{ console.log(`WireStack Boom Hybrid running on port ${PORT}`); console.log(`Workspace: ${ROOT}`); });
