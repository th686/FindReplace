const STORAGE_KEY = 'frRuleGroups';
const SLOT_KEY = 'frGroupHotkeySlots'; // { slotNumber: groupId }

async function getState() {
  const data = await chrome.storage.local.get([STORAGE_KEY, SLOT_KEY]);
  return {
    groups: data[STORAGE_KEY] || [],
    slots: data[SLOT_KEY] || {}
  };
}

function commandToSlot(command) {
  const m = command.match(/run_group_slot_(\d+)/);
  if (m) return parseInt(m[1],10);
  return null;
}

chrome.commands.onCommand.addListener(async (command) => {
  const slot = commandToSlot(command);
  if (!slot) return;
  const { groups, slots } = await getState();
  const groupId = slots[slot];
  if (!groupId) return; // no assignment
  const group = groups.find(g => g.id === groupId && g.enabled);
  if (!group) return;
  const payload = [{ name: group.name, rules: group.rules.filter(r=>r.enabled && r.pattern) }];
  if (!payload[0].rules.length) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    let response = await send(tab.id, payload);
    if (!response) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      response = await send(tab.id, payload);
    }
  } catch (e) {
    // swallow errors silently for now
  }
});

function send(tabId, groups) {
  return new Promise(resolve => {
    let done = false;
    const t = setTimeout(()=>{ if(!done) resolve(null); }, 1200);
    chrome.tabs.sendMessage(tabId, { type: 'FR_RUN', groups }, resp => {
      done = true; clearTimeout(t);
      if (chrome.runtime.lastError) resolve(null); else resolve(resp);
    });
  });
}
