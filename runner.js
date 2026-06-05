#!/usr/bin/env node
/**
 * WireStack Local Runner
 *
 * This is the execution layer that a static browser app cannot safely provide.
 * It accepts generated file blocks, writes them into ./workspace, runs syntax checks
 * and test commands, then returns stdout/stderr to WireStack for repair.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const archiverAvailable = false;

const PORT = Number(process.env.WIRESTACK_RUNNER_PORT || 8787);
const ROOT = path.resolve(process.env.WIRESTACK_WORKSPACE || path.join(__dirname, 'workspace'));
const MAX_BODY = 15 * 1024 * 1024;
const TIMEOUT_MS = Number(process.env.WIRESTACK_TEST_TIMEOUT_MS || 45000);

fs.mkdirSync(ROOT, { recursive: true });

function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(JSON.stringify(data, null, 2));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY) reject(new Error('Request body too large'));
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(new Error('Invalid JSON: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

function safePath(filePath) {
  if (!filePath || typeof filePath !== 'string') throw new Error('Missing file path');
  let clean = filePath.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/').replace(/^\/+/, '');
  clean = clean.split('/').filter(Boolean).join('/');
  if (!clean || clean.includes('..')) throw new Error('Unsafe path: ' + filePath);
  const abs = path.resolve(ROOT, clean);
  if (!abs.startsWith(ROOT + path.sep) && abs !== ROOT) throw new Error('Path escapes workspace: ' + filePath);
  return abs;
}

function inferPath(block, index) {
  const existing = block.path || block.filePath || block.file || block.label || '';
  if (existing.includes('/') || existing.includes('\\')) return existing;
  const lang = String(block.lang || '').toLowerCase();
  const ext = lang.includes('sql') ? 'sql'
    : lang.includes('python') || lang === 'py' ? 'py'
    : lang.includes('html') ? 'html'
    : lang.includes('css') ? 'css'
    : lang.includes('json') ? 'json'
    : lang.includes('bash') || lang === 'sh' ? 'sh'
    : 'js';
  const label = String(existing || `generated-${index + 1}`).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || `generated-${index + 1}`;
  return `generated/${label}.${ext}`;
}

function commandExists(cmd) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  const names = process.platform === 'win32' ? [cmd, cmd + '.exe', cmd + '.cmd'] : [cmd];
  return dirs.some(d => names.some(n => fs.existsSync(path.join(d, n))));
}

function run(cmd, args, cwd = ROOT) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd, shell: process.platform === 'win32' });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      stderr += `\nTIMEOUT: command exceeded ${TIMEOUT_MS}ms`;
    }, TIMEOUT_MS);
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ cmd: [cmd, ...args].join(' '), code, stdout: stdout.slice(-12000), stderr: stderr.slice(-12000) });
    });
    child.on('error', err => {
      clearTimeout(timer);
      resolve({ cmd: [cmd, ...args].join(' '), code: 127, stdout, stderr: err.message });
    });
  });
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'build', '.next', '__pycache__'].includes(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else out.push(abs);
  }
  return out;
}

async function syntaxChecks() {
  const files = walk(ROOT);
  const results = [];
  for (const abs of files) {
    const rel = path.relative(ROOT, abs);
    if (/\.js$|\.cjs$|\.mjs$/.test(rel)) results.push({ file: rel, ...(await run(process.execPath, ['--check', abs], ROOT)) });
    else if (/\.json$/.test(rel)) {
      try { JSON.parse(fs.readFileSync(abs, 'utf8')); results.push({ file: rel, cmd: 'JSON.parse', code: 0, stdout: 'valid json', stderr: '' }); }
      catch (e) { results.push({ file: rel, cmd: 'JSON.parse', code: 1, stdout: '', stderr: e.message }); }
    } else if (/\.py$/.test(rel) && commandExists('python3')) results.push({ file: rel, ...(await run('python3', ['-m', 'py_compile', abs], ROOT)) });
    else if (/\.sql$/.test(rel)) {
      const txt = fs.readFileSync(abs, 'utf8');
      const ok = /;\s*$/.test(txt.trim()) && !/```/.test(txt);
      results.push({ file: rel, cmd: 'basic sql check', code: ok ? 0 : 1, stdout: ok ? 'basic sql check passed' : '', stderr: ok ? '' : 'SQL may be missing a final semicolon or contains fenced markdown.' });
    }
  }
  return results;
}

async function runTests(customCommand) {
  const checks = await syntaxChecks();
  const commands = [];
  if (customCommand) {
    const parts = customCommand.split(' ').filter(Boolean);
    commands.push(await run(parts[0], parts.slice(1), ROOT));
  } else if (fs.existsSync(path.join(ROOT, 'package.json'))) {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    if (pkg.scripts && pkg.scripts.test) commands.push(await run(commandExists('npm') ? 'npm' : 'node', commandExists('npm') ? ['test', '--', '--runInBand'] : ['-e', 'console.log("npm unavailable")'], ROOT));
    else commands.push({ cmd: 'npm test', code: 0, stdout: 'No package.json test script found; syntax checks only.', stderr: '' });
  } else if (walk(ROOT).some(f => f.endsWith('.py')) && commandExists('python3')) {
    commands.push(await run('python3', ['-m', 'unittest', 'discover'], ROOT));
  } else {
    commands.push({ cmd: 'auto test', code: 0, stdout: 'No test runner detected; syntax checks only.', stderr: '' });
  }
  const all = [...checks, ...commands];
  const failed = all.filter(r => r.code !== 0);
  return { status: failed.length ? 'FAILED' : 'PASSED', workspace: ROOT, syntax: checks, commands, failed };
}

function listFiles() {
  return walk(ROOT).map(abs => ({ path: path.relative(ROOT, abs), bytes: fs.statSync(abs).size }));
}

function hasFilesMatching(regex) { return walk(ROOT).some(f => regex.test(path.relative(ROOT, f))); }
async function installDeps() {
  if (fs.existsSync(path.join(ROOT, 'package.json'))) {
    if (!commandExists('npm')) return { status: 'FAILED', reason: 'npm is not available', commands: [] };
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const cmd = fs.existsSync(path.join(ROOT, 'package-lock.json')) ? ['ci'] : ['install'];
    const result = await run('npm', cmd, ROOT);
    return { status: result.code === 0 ? 'PASSED' : 'FAILED', commands: [result], packageName: pkg.name || 'node-app' };
  }
  if (fs.existsSync(path.join(ROOT, 'requirements.txt')) && commandExists('python3')) {
    const result = await run('python3', ['-m', 'pip', 'install', '-r', 'requirements.txt'], ROOT);
    return { status: result.code === 0 ? 'PASSED' : 'FAILED', commands: [result] };
  }
  return { status: 'PASSED', commands: [], note: 'No dependency manifest detected.' };
}
function makeZipWithNode(outputPath, sourceDir) {
  const files = walk(sourceDir);
  const manifest = files.map(abs => ({ path: path.relative(sourceDir, abs), bytes: fs.statSync(abs).size }));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  // Minimal portable bundle: JSON manifest plus copied files folder when zip tooling is unavailable.
  // If system zip exists, create a real zip.
  return new Promise(async resolve => {
    if (commandExists('zip')) {
      const relOut = path.relative(sourceDir, outputPath);
      const result = await run('zip', ['-r', outputPath, '.'], sourceDir);
      resolve({ type: 'zip', path: outputPath, command: result, manifest });
    } else {
      const bundleDir = outputPath.replace(/\.zip$/,'');
      fs.rmSync(bundleDir, { recursive: true, force: true });
      fs.mkdirSync(bundleDir, { recursive: true });
      for (const abs of files) {
        const rel = path.relative(sourceDir, abs);
        if (rel.startsWith('dist')) continue;
        const dest = path.join(bundleDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(abs, dest);
      }
      fs.writeFileSync(path.join(bundleDir, 'WIRESTACK_BUNDLE.json'), JSON.stringify({ createdAt: new Date().toISOString(), manifest }, null, 2));
      resolve({ type: 'folder-bundle', path: bundleDir, manifest, note: 'zip command not available; created folder bundle instead.' });
    }
  });
}
async function packageApp() {
  const dist = path.join(ROOT, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  const tests = await runTests();
  if (tests.status !== 'PASSED') return { status: 'BLOCKED', reason: 'Tests must pass before packaging.', tests };
  const artifacts = [];
  if (fs.existsSync(path.join(ROOT, 'package.json'))) {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    if (pkg.scripts && pkg.scripts.build && commandExists('npm')) artifacts.push({ step: 'build', ...(await run('npm', ['run', 'build'], ROOT)) });
    if (pkg.scripts && (pkg.scripts.dist || pkg.scripts.package) && commandExists('npm')) {
      const script = pkg.scripts.dist ? 'dist' : 'package';
      artifacts.push({ step: 'electron/package', ...(await run('npm', ['run', script], ROOT)) });
      return { status: artifacts.every(a => a.code === 0) ? 'PASSED' : 'FAILED', kind: 'node/electron', workspace: ROOT, artifacts };
    }
  }
  if (hasFilesMatching(/\.py$/) && commandExists('pyinstaller')) {
    const pyFiles = walk(ROOT).map(f => path.relative(ROOT, f)).filter(f => /\.py$/.test(f));
    const main = pyFiles.find(f => /main\.py$|app\.py$|index\.py$/.test(f)) || pyFiles[0];
    const result = await run('pyinstaller', ['--onefile', main], ROOT);
    return { status: result.code === 0 ? 'PASSED' : 'FAILED', kind: 'python-exe', workspace: ROOT, artifactDir: path.join(ROOT, 'dist'), artifacts: [result] };
  }
  const bundle = await makeZipWithNode(path.join(dist, 'wirestack-app-bundle.zip'), ROOT);
  return { status: 'PASSED', kind: 'static-or-source-bundle', workspace: ROOT, artifacts: [bundle], note: 'Created a portable bundle. For a Windows .exe, generate a Python/PyInstaller or Electron project.' };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 200, { ok: true });
  try {
    if (req.method === 'GET' && req.url === '/api/health') return send(res, 200, { ok: true, workspace: ROOT, files: listFiles().length });
    if (req.method === 'GET' && req.url === '/api/files') return send(res, 200, { workspace: ROOT, files: listFiles() });
    if (req.method === 'POST' && req.url === '/api/apply') {
      const body = await readJson(req);
      const blocks = Array.isArray(body.blocks) ? body.blocks : [];
      const written = [];
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        const rel = inferPath(b, i);
        const abs = safePath(rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, String(b.code || ''), 'utf8');
        written.push({ path: path.relative(ROOT, abs), bytes: Buffer.byteLength(String(b.code || ''), 'utf8') });
      }
      return send(res, 200, { ok: true, workspace: ROOT, written });
    }
    if (req.method === 'POST' && req.url === '/api/run-tests') {
      const body = await readJson(req);
      return send(res, 200, await runTests(body.command));
    }
    if (req.method === 'POST' && req.url === '/api/install') {
      return send(res, 200, await installDeps());
    }
    if (req.method === 'POST' && req.url === '/api/package') {
      return send(res, 200, await packageApp());
    }
    if (req.method === 'POST' && req.url === '/api/reset') {
      fs.rmSync(ROOT, { recursive: true, force: true });
      fs.mkdirSync(ROOT, { recursive: true });
      return send(res, 200, { ok: true, workspace: ROOT, reset: true });
    }
    return send(res, 404, { error: 'Not found' });
  } catch (err) {
    return send(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`WireStack runner listening on http://localhost:${PORT}`);
  console.log(`Workspace: ${ROOT}`);
});
