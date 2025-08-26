// Popup logic for managing regex find/replace groups and rules.
// Data shape stored in chrome.storage.local under key 'frRuleGroups':
// [ { id, name, enabled, rules: [ { id, pattern, replacement, flags, enabled } ] } ]

const STORAGE_KEY = 'frRuleGroups';

/** Utility **/
const uid = () => Math.random().toString(36).slice(2, 10);

async function loadGroups() {
	const data = await chrome.storage.local.get(STORAGE_KEY);
	return data[STORAGE_KEY] || [];
}

async function saveGroups(groups) {
	await chrome.storage.local.set({ [STORAGE_KEY]: groups });
}

function createEmptyGroup() {
	return { id: uid(), name: 'Group', enabled: true, rules: [ createEmptyRule() ] };
}

function createEmptyRule() {
	return { id: uid(), pattern: '', replacement: '', flags: 'g', enabled: true };
}

// DOM references
const groupsEl = document.getElementById('groups');
const addGroupBtn = document.getElementById('addGroup');
const groupSelect = document.getElementById('groupSelect');
const runAllBtn = document.getElementById('runAll');
const emptyStateEl = document.getElementById('emptyState');
const runSummaryEl = document.getElementById('runSummary');
const exportBtn = document.getElementById('exportBtn');
const importBtn = document.getElementById('importBtn');
const importFile = document.getElementById('importFile');
const toggleExpandBtn = document.getElementById('toggleExpand');
const openFullBtn = document.getElementById('openFull');
const hotkeySlotSelect = document.getElementById('hotkeySlot');
const saveSlotBtn = document.getElementById('saveSlot');
const slotStatusEl = document.getElementById('slotStatus');
const SLOT_KEY = 'frGroupHotkeySlots'; // mapping slot->groupId
let slotMap = {};

let state = [];
let currentGroupId = null;

// Debounced persistence to avoid re-render focus loss on every keystroke
function debounce(fn, ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; }
const schedulePersist = debounce(()=> saveGroups(state), 400);

function render() {
	// Populate dropdown
	groupSelect.innerHTML = '';
	state.forEach(g => {
		const opt = document.createElement('option');
		opt.value = g.id; opt.textContent = g.name + (g.enabled ? '' : ' (disabled)');
		groupSelect.appendChild(opt);
	});
	if (!state.length) {
		groupsEl.innerHTML = '';
		emptyStateEl.hidden = false;
		return;
	}
	emptyStateEl.hidden = true;
	if (!currentGroupId || !state.find(g=>g.id===currentGroupId)) currentGroupId = state[0].id;
	groupSelect.value = currentGroupId;
	const group = state.find(g=>g.id===currentGroupId);
	groupsEl.innerHTML = '';
	const gEl = document.createElement('div');
	gEl.className = 'group' + (!group.enabled ? ' disabled' : '');
	const header = document.createElement('div');
	header.className = 'group-header';
	header.innerHTML = `
		<input class="group-name" title="Group name" value="${escapeHtml(group.name)}" />
		<label><input type="checkbox" class="toggle-group" ${group.enabled?'checked':''}/> Enabled</label>
		<button class="mini move-up" ${(state.indexOf(group)===0)?'disabled':''}>▲</button>
		<button class="mini move-down" ${(state.indexOf(group)===state.length-1)?'disabled':''}>▼</button>
		<button class="mini add-rule" title="Add rule">+ Rule</button>
		<button class="mini delete-group" title="Delete group">✕</button>
	`;
	gEl.appendChild(header);
	const rulesWrap = document.createElement('div');
	rulesWrap.className = 'rules';
	group.rules.forEach((rule, ri) => {
		const rEl = document.createElement('div');
		rEl.className = 'rule';
		let invalid=false; if(rule.pattern){ try{ new RegExp(rule.pattern, rule.flags||''); }catch{ invalid=true; } }
		if(invalid) rEl.classList.add('invalid');
		rEl.innerHTML = `
			<input class="pattern" placeholder="Pattern" value="${escapeHtml(rule.pattern)}" title="Regex pattern" />
			<input class="replacement" placeholder="Replacement" value="${escapeHtml(rule.replacement)}" title="Replacement string" />
			<input class="flags" placeholder="Flags" value="${escapeHtml(rule.flags)}" maxlength="6" title="Regex flags" />
			<label style="display:flex;align-items:center;gap:2px;font-size:11px"><input type="checkbox" class="rule-enabled" ${rule.enabled?'checked':''}/> On</label>
			<div class="row-tools">
				<button class="mini rule-run" title="Run this rule">▶</button>
				<button class="mini rule-up" ${ri===0?'disabled':''}>▲</button>
				<button class="mini rule-down" ${ri===group.rules.length-1?'disabled':''}>▼</button>
				<button class="mini rule-del" title="Delete">✕</button>
			</div>`;
		rulesWrap.appendChild(rEl);
		const patternInput = rEl.querySelector('.pattern');
		const replacementInput = rEl.querySelector('.replacement');
		const flagsInput = rEl.querySelector('.flags');
		const enabledCheckbox = rEl.querySelector('.rule-enabled');
		function updateInvalid(){ if(!rule.pattern){ rEl.classList.remove('invalid'); return;} try{ new RegExp(rule.pattern, rule.flags||''); rEl.classList.remove('invalid'); }catch{ rEl.classList.add('invalid'); } }
		patternInput.addEventListener('input', e => { rule.pattern = e.target.value; updateInvalid(); schedulePersist(); });
		replacementInput.addEventListener('input', e => { rule.replacement = e.target.value; schedulePersist(); });
		flagsInput.addEventListener('input', e => { rule.flags = e.target.value; updateInvalid(); schedulePersist(); });
		enabledCheckbox.addEventListener('change', e => { rule.enabled = e.target.checked; schedulePersist(); });
		rEl.querySelector('.rule-up').addEventListener('click', () => { arrayMove(group.rules, ri, ri-1); changed(); });
		rEl.querySelector('.rule-down').addEventListener('click', () => { arrayMove(group.rules, ri, ri+1); changed(); });
		rEl.querySelector('.rule-del').addEventListener('click', () => { group.rules.splice(ri,1); if(!group.rules.length) group.rules.push(createEmptyRule()); changed(); });
		rEl.querySelector('.rule-run').addEventListener('click', async () => {
			if(!rule.pattern) { flashSummary('Rule has no pattern.'); return; }
			const groupPayload = { name: group.name, rules: [{ ...rule, enabled: true }] };
			const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
			if(!tab?.id) { flashSummary('No active tab.'); return; }
			let resp = await sendRunMessage(tab.id, [groupPayload]);
			if(!resp) {
				try { await chrome.scripting.executeScript({ target:{ tabId: tab.id }, files:['content.js']});
					resp = await sendRunMessage(tab.id, [groupPayload]);
				} catch(e) { flashSummary('Injection failed: '+e.message); return; }
			}
			if(resp) {
				const rr = resp.groupResults?.[0]?.ruleResults?.[0];
				flashSummary(`/${rr?.pattern||rule.pattern}/${rr?.flags||rule.flags} -> ${rr?.replacements||0}`);
			} else flashSummary('No response.');
		});
	});
	gEl.appendChild(rulesWrap);
	groupsEl.appendChild(gEl);
	const nameInput = header.querySelector('.group-name');
	nameInput.addEventListener('input', e => { group.name = e.target.value; schedulePersist(); updateGroupSelectNames(); });
	header.querySelector('.toggle-group').addEventListener('change', e => { group.enabled = e.target.checked; schedulePersist(); updateGroupSelectNames(); render(); });
	header.querySelector('.add-rule').addEventListener('click', () => { group.rules.push(createEmptyRule()); changed(); });
	header.querySelector('.delete-group').addEventListener('click', () => { if(confirm('Delete group?')) { const idx = state.indexOf(group); state.splice(idx,1); if(state.length) currentGroupId = state[Math.min(idx,state.length-1)].id; else currentGroupId=null; changed(); } });
	header.querySelector('.move-up').addEventListener('click', () => { const gi = state.indexOf(group); arrayMove(state, gi, gi-1); changed(); });
	header.querySelector('.move-down').addEventListener('click', () => { const gi = state.indexOf(group); arrayMove(state, gi, gi+1); changed(); });
}

function updateGroupSelectNames(){
	Array.from(groupSelect.options).forEach(opt => {
		const g = state.find(g=>g.id===opt.value);
		if(g) opt.textContent = g.name + (g.enabled ? '' : ' (disabled)');
	});
}
async function loadSlotMap(){
	const data = await chrome.storage.local.get(SLOT_KEY);
	slotMap = data[SLOT_KEY] || {};
}
function initSlotSelect(){
	if(!hotkeySlotSelect) return;
	hotkeySlotSelect.innerHTML = '<option value="">(none)</option>';
	for(let i=1;i<=10;i++) {
		const opt = document.createElement('option');
		opt.value = String(i);
		const assignedGroupId = slotMap[i];
		let label = 'Slot '+i;
		if(assignedGroupId){ const g = state.find(g=>g.id===assignedGroupId); if(g) label += ' – '+g.name; }
		opt.textContent = label;
		hotkeySlotSelect.appendChild(opt);
	}
	refreshCurrentSlotSelection();
}
function refreshCurrentSlotSelection(){
	if(!hotkeySlotSelect) return;
	if(!currentGroupId){ hotkeySlotSelect.value=''; return; }
	const found = Object.entries(slotMap).find(([slot,gid]) => gid === currentGroupId);
	hotkeySlotSelect.value = found ? String(found[0]) : '';
}

function escapeHtml(str='') {
	return str.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

function arrayMove(arr, from, to) {
	if (to<0 || to>=arr.length) return;
	const item = arr.splice(from,1)[0];
	arr.splice(to,0,item);
}

async function changed() {
	// For structural changes (add/remove/reorder) we persist immediately and re-render.
	await saveGroups(state);
	render();
}

addGroupBtn.addEventListener('click', async () => {
	const g = createEmptyGroup();
	state.push(g);
	currentGroupId = g.id;
	await changed();
});

groupSelect?.addEventListener('change', () => {
	currentGroupId = groupSelect.value;
	render();
	refreshCurrentSlotSelection();
});

runAllBtn.addEventListener('click', async () => {
	runSummaryEl.hidden = true;
	runSummaryEl.textContent = '';
	const group = state.find(g=>g.id===currentGroupId);
	if(!group) { runSummaryEl.textContent='No current group.'; runSummaryEl.hidden=false; return; }
	if(!group.enabled) { runSummaryEl.textContent='Group is disabled.'; runSummaryEl.hidden=false; return; }
	const toRun = [{ name: group.name, rules: group.rules.filter(r=>r.enabled && r.pattern) }];
	if(!toRun[0].rules.length) { runSummaryEl.textContent='No enabled rules with patterns.'; runSummaryEl.hidden=false; return; }
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (!tab?.id) { runSummaryEl.textContent='No active tab id.'; runSummaryEl.hidden=false; return; }
	try {
		let response = await sendRunMessage(tab.id, toRun);
		if(!response) {
			await chrome.scripting.executeScript({ target:{ tabId: tab.id }, files:['content.js']});
			response = await sendRunMessage(tab.id, toRun);
		}
		runSummaryEl.textContent = formatRunSummary(response);
	} catch(e) {
		runSummaryEl.textContent = 'Error: '+(e.message||e);
	}
	runSummaryEl.hidden = false;
});

async function sendRunMessage(tabId, groups) {
	return new Promise((resolve, reject) => {
		let done = false;
		const timeout = setTimeout(()=>{ if(!done) resolve(null); }, 1200);
		try {
			chrome.tabs.sendMessage(tabId, { type: 'FR_RUN', groups }, resp => {
				done = true;
				clearTimeout(timeout);
				if (chrome.runtime.lastError) {
					// Usually no receiving end
						resolve(null);
				} else resolve(resp);
			});
		} catch (e) { reject(e); }
	});
}

function formatRunSummary(resp) {
	if (!resp) return 'No response (content script not injected?)';
	const lines = [];
	lines.push('Replacements:');
	resp.groupResults?.forEach(gr => {
		lines.push(`- ${gr.name}: ${gr.replacements} replacement(s)`);
		gr.ruleResults.forEach(rr => {
			lines.push(`   · /${rr.pattern}/${rr.flags} -> ${rr.replacements}`);
		});
	});
	lines.push(`Total: ${resp.total}`);
	return lines.join('\n');
}

function flashSummary(msg) {
  runSummaryEl.textContent = msg;
  runSummaryEl.hidden = false;
  runSummaryEl.style.outline = '2px solid #4b8';
  setTimeout(()=> runSummaryEl.style.outline = 'none', 550);
}

exportBtn.addEventListener('click', () => {
	const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = 'find-replace-rules.json';
	a.click();
	setTimeout(()=>URL.revokeObjectURL(url), 1000);
});

importBtn.addEventListener('click', () => importFile.click());
importFile.addEventListener('change', async () => {
	const file = importFile.files?.[0];
	if (!file) return;
	const text = await file.text();
	try {
		const parsed = JSON.parse(text);
		if (Array.isArray(parsed)) {
			state = sanitize(parsed);
			await saveGroups(state);
			render();
		} else alert('Invalid JSON root (expected array)');
	} catch(e) {
		alert('Failed to parse JSON: ' + e.message);
	} finally {
		importFile.value = '';
	}
});

function sanitize(arr) {
	return arr.map(g => ({
		id: g.id || uid(),
		name: String(g.name||'Group'),
		enabled: g.enabled!==false,
		rules: Array.isArray(g.rules) && g.rules.length ? g.rules.map(r=>({
			id: r.id||uid(),
			pattern: String(r.pattern||''),
			replacement: String(r.replacement||''),
			flags: sanitizeFlags(r.flags||'g'),
			enabled: r.enabled!==false,
		})) : [createEmptyRule()]
	}));
}

function sanitizeFlags(f) {
	return Array.from(new Set(String(f).replace(/[^gimsuyd]/g,'').split(''))).join('');
}

// Initial load
(async () => {
	state = sanitize(await loadGroups());
	if(!state.length) state.push(createEmptyGroup());
	if(!currentGroupId && state.length) currentGroupId = state[0].id;
	await loadSlotMap();
	initSlotSelect();
	render();
})();

// Width toggle
let sizeMode = 'normal';
toggleExpandBtn.addEventListener('click', () => {
	const body = document.body;
	if (sizeMode === 'normal') { body.classList.add('expanded'); sizeMode='expanded'; }
	else if (sizeMode === 'expanded') { body.classList.remove('expanded'); body.classList.add('compact'); sizeMode='compact'; }
	else { body.classList.remove('compact'); sizeMode='normal'; }
});

// Open full tab view (chrome extension page)
openFullBtn.addEventListener('click', () => {
	const url = chrome.runtime.getURL('popup.html#full');
	chrome.tabs.create({ url });
});

saveSlotBtn?.addEventListener('click', async () => {
	if(!currentGroupId) return;
	const sel = hotkeySlotSelect.value; // '' or number
	for(const k of Object.keys(slotMap)) if(slotMap[k] === currentGroupId) delete slotMap[k];
	if(sel) slotMap[sel] = currentGroupId;
	await chrome.storage.local.set({ [SLOT_KEY]: slotMap });
	initSlotSelect();
	if(slotStatusEl){ slotStatusEl.textContent = 'Saved'; setTimeout(()=> slotStatusEl.textContent='', 1300); }
});

