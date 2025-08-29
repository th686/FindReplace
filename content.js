// Content script: listens for messages with regex groups and applies them to editable fields.
// Targets: input[type=text|search|url|tel|email], textarea, [contenteditable="true"]

function getEditableElements() {
    // Only process contenteditable hosts (not inputs/textareas).
    // We select elements that explicitly have a contenteditable attribute not set to 'false'.
    const all = Array.from(document.querySelectorAll('[contenteditable]'))
        .filter(el => el.getAttribute('contenteditable')?.toLowerCase() !== 'false');
    // Keep only top-level hosts (exclude those whose ancestor is also contenteditable) to avoid double replacement.
    const hosts = all.filter(el => !el.closest('[contenteditable] [contenteditable]')); // simplistic but effective
    return hosts;
}

function replaceTextInNodes(element, regex, replacement, onReplace) {
    const walker = document.createTreeWalker(
        element,
        NodeFilter.SHOW_TEXT,
        null,
        false
    );
    
    const textNodes = [];
    let node;
    while (node = walker.nextNode()) {
        textNodes.push(node);
    }
    
    let changed = false;
    textNodes.forEach(textNode => {
        const oldText = textNode.textContent;
        const newText = oldText.replace(regex, (match) => {
            onReplace();
            return replacement;
        });
        if (newText !== oldText) {
            textNode.textContent = newText;
            changed = true;
        }
    });
    
    if (changed) {
        element.dispatchEvent(new Event('input', { bubbles: true }));
    }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'FR_RUN') {
        const elements = getEditableElements();
        let total = 0;
        const groupResults = msg.groups.map(g => {
            let groupReplacements = 0;
            const ruleResults = g.rules.map(r => {
                let replacements = 0;
                let regex;
                try { regex = new RegExp(r.pattern, r.flags || ''); }
                catch { return { pattern: r.pattern, flags: r.flags, replacements: 0, error: 'invalid regex' }; }
                elements.forEach(el => {
                    // value or textContent depending on element
                    if ('value' in el) {
                        const oldVal = el.value;
                        const newVal = oldVal.replace(regex, (match, ...rest) => {
                            replacements++;
                            return r.replacement;
                        });
                        if (newVal !== oldVal) {
                            el.value = newVal;
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    } else {
                        // For contenteditable elements, process text nodes individually
                        // to preserve HTML structure
                        replaceTextInNodes(el, regex, r.replacement, () => replacements++);
                    }
                });
                groupReplacements += replacements;
                total += replacements;
                return { pattern: r.pattern, flags: r.flags, replacements };
            });
            return { name: g.name, replacements: groupReplacements, ruleResults };
        });
        sendResponse({ total, groupResults });
        return true; // async response
    }
});