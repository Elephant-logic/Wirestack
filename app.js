const $ = s => document.querySelector(s);
let appState = null;
function addMsg(kind, text) {
  const el = document.createElement('div');
  el.className = `msg ${kind}`;
  el.textContent = text;
  $('#chatLog').appendChild(el);
  $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
}
function setStage(text) { $('#stage').textContent = text; }
function getUserApiKeys() {
  return {
    openai: $('#openaiKey')?.value?.trim() || '',
    anthropic: $('#anthropicKey')?.value?.trim() || ''
  };
}
function updateKeyStatus() {
  const k = getUserApiKeys();
  const saved = localStorage.getItem('wirestack_save_keys') === 'true';
  $('#keyStatus').textContent = `User keys: OpenAI ${k.openai?'✓':'—'} · Claude ${k.anthropic?'✓':'—'}${saved?' · saved in browser':''}`;
}
function loadSavedKeys() {
  $('#saveKeys').checked = localStorage.getItem('wirestack_save_keys') === 'true';
  if ($('#saveKeys').checked) {
    $('#openaiKey').value = localStorage.getItem('wirestack_openai_key') || '';
    $('#anthropicKey').value = localStorage.getItem('wirestack_anthropic_key') || '';
  }
  updateKeyStatus();
}
async function api(path, body) {
  const payload = body ? { ...body, apiKeys: body.apiKeys || getUserApiKeys() } : undefined;
  const r = await fetch(path, { method: payload ? 'POST' : 'GET', headers: {'Content-Type':'application/json'}, body: payload ? JSON.stringify(payload) : undefined });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function renderState(st) {
  appState = st;
  const local = getUserApiKeys();
  $('#apiStatus').textContent = `Runner live · User OpenAI ${local.openai?'✓':'—'} · User Claude ${local.anthropic?'✓':'—'} · Server fallback OpenAI ${st.hasKeys?.openai?'✓':'—'} · Claude ${st.hasKeys?.anthropic?'✓':'—'}`;
  $('#healthScore').textContent = `${st.health?.score ?? 0}%`;
  $('#healthNotes').innerHTML = (st.health?.notes || []).map(n=>`<div>• ${escapeHtml(n)}</div>`).join('');
  $('#blueprint').innerHTML = `<strong>${escapeHtml(st.blueprint?.name || 'Untitled')}</strong><br>${escapeHtml(st.blueprint?.purpose || '').slice(0,450)}<hr><small>${(st.blueprint?.modules||[]).length} modules · ${(st.blueprint?.wiring||[]).length} wires</small>`;
  $('#qutri').innerHTML = Object.entries(st.qutri || {}).map(([k,v])=>`<span class="chip ${v}">${escapeHtml(k)} · ${v}</span>`).join('') || '<span class="chip unknown">No states yet</span>';
  $('#files').innerHTML = (st.files || []).slice(0,100).map(f=>`<div class="file">${escapeHtml(f.path)} <small>${f.bytes}b</small></div>`).join('') || '<div class="muted">No files yet</div>';
  renderTeam(st);
}
function renderTeam(st) {
  const roles = st.roles || {};
  $('#teamGrid').innerHTML = Object.entries(roles).map(([role,cfg])=>`
    <div class="role" data-role="${role}"><strong>${role}</strong>
      <label>Provider<select class="provider"><option value="openai" ${cfg.provider==='openai'?'selected':''}>OpenAI</option><option value="anthropic" ${cfg.provider==='anthropic'?'selected':''}>Claude/Anthropic</option></select></label>
      <label>Model<input class="model" value="${escapeHtml(cfg.model || '')}"></label>
    </div>`).join('');
}
function escapeHtml(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
async function refresh(){ try { renderState(await api('/api/state')); } catch(e) { $('#apiStatus').textContent = e.message; } }
function summarise(res){
  const lines = [];
  if (res.intent) lines.push(`Intent: ${res.intent}`);
  if (res.outcome) lines.push(`Outcome: ${res.outcome}`);
  if (res.stages) lines.push('Pipeline:\n' + res.stages.map(s=>`- ${s.stage}: ${s.status}`).join('\n'));
  if (res.written?.length) lines.push(`Files written:\n${res.written.map(w=>`- ${w.path}`).join('\n')}`);
  if (res.install?.dependencyReport) {
    const d = res.install.dependencyReport;
    lines.push(`Dependencies detected: JS [${(d.js||[]).join(', ') || 'none'}], Python [${(d.python||[]).join(', ') || 'none'}]`);
    lines.push(`Install: ${res.install.code === 0 ? 'OK' : 'FAILED'}`);
  }
  if (res.tests) lines.push(`Tests: ${res.tests.status} (${(res.tests.failed||[]).length} failures)`);
  if (res.package) lines.push(`Package: ${res.package.status}${res.package.kind ? ' · ' + res.package.kind : ''}`);
  if (res.diff) lines.push(`Blueprint diff: +${res.diff.modules.added.length} modules, ${res.diff.modules.changed.length} changed`);
  if (res.package?.status === 'PASSED') lines.push('Download: use the Download package button.');
  if (res.aiText) lines.push(`\nAI output preview:\n${res.aiText.slice(0,1800)}`);
  return lines.filter(Boolean).join('\n');
}
async function sendPrompt(text) {
  if (!text.trim()) return;
  addMsg('user', text);
  $('#sendBtn').disabled = true;
  setStage('Working: understand → generate → apply → dependencies → test → repair/package when possible');
  addMsg('bot', 'Working through it. I will update the blueprint, generate/apply files, install dependencies, run tests, and package when passing.');
  try {
    const res = await api('/api/command', { text, autoApply:true });
    renderState(res.state);
    addMsg('bot', summarise(res));
    setStage(res.tests?.status === 'FAILED' ? 'Needs repair' : res.package?.status === 'PASSED' ? 'Packaged' : 'Ready');
  } catch(e) { addMsg('bot', 'Error: ' + e.message); setStage('Error'); }
  $('#sendBtn').disabled = false;
}
$('#sendBtn').onclick = () => { const t = $('#prompt').value; $('#prompt').value=''; sendPrompt(t); };
$('#testBtn').onclick = async()=>{ addMsg('user','Run tests'); try{ const r=await api('/api/test',{}); addMsg('bot',`Tests: ${r.status}\nFailures: ${(r.failed||[]).length}\n${JSON.stringify((r.failed||[]).slice(0,3),null,2)}`); refresh(); }catch(e){addMsg('bot',e.message)} };
$('#packageBtn').onclick = async()=>{ addMsg('user','Package if passing'); try{ const r=await api('/api/package',{}); addMsg('bot',`Package: ${r.status}\n${r.reason||r.note||''}\n${r.artifact||r.artifactDir||''}`); refresh(); }catch(e){addMsg('bot',e.message)} };
$('#downloadBtn').onclick = ()=>{ window.location.href = '/api/download'; };
$('#resetBtn').onclick = async()=>{ if(confirm('Reset workspace and blueprint?')) { await api('/api/reset',{}); $('#chatLog').innerHTML=''; addMsg('bot','Reset complete. Tell me what to build.'); refresh(); } };
document.querySelectorAll('[data-prompt]').forEach(b=>b.onclick=()=>{$('#prompt').value=b.dataset.prompt;});
$('#saveKeysBtn').onclick = () => {
  if ($('#saveKeys').checked) {
    localStorage.setItem('wirestack_save_keys','true');
    localStorage.setItem('wirestack_openai_key', $('#openaiKey').value.trim());
    localStorage.setItem('wirestack_anthropic_key', $('#anthropicKey').value.trim());
  } else {
    localStorage.removeItem('wirestack_save_keys');
    localStorage.removeItem('wirestack_openai_key');
    localStorage.removeItem('wirestack_anthropic_key');
  }
  updateKeyStatus();
  addMsg('bot','API key settings updated for this browser.');
  refresh();
};
$('#clearKeysBtn').onclick = () => {
  $('#openaiKey').value = ''; $('#anthropicKey').value = ''; $('#saveKeys').checked = false;
  localStorage.removeItem('wirestack_save_keys'); localStorage.removeItem('wirestack_openai_key'); localStorage.removeItem('wirestack_anthropic_key');
  updateKeyStatus(); addMsg('bot','API keys cleared from this browser.'); refresh();
};
['openaiKey','anthropicKey','saveKeys'].forEach(id => $('#'+id).addEventListener('input', updateKeyStatus));
$('#saveTeam').onclick = async()=>{
  const roles = {};
  document.querySelectorAll('.role').forEach(el=>{ roles[el.dataset.role] = { provider: el.querySelector('.provider').value, model: el.querySelector('.model').value, enabled:true }; });
  const st = await api('/api/team', { roles }); renderState(st); addMsg('bot','AI Team settings saved.');
};
loadSavedKeys();
addMsg('bot','Hi. Add your own API key above, then tell me the app idea or change. For a full build, say: “Build a complete app from this idea and make it work.”');
refresh();
