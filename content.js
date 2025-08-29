// Content script: listens for messages with regex groups and applies them to editable fields.
// Targets: [contenteditable="true"] (inputs/textareas currently excluded by getEditableElements)

function getEditableElements() {
    // Only process contenteditable hosts (not inputs/textareas here).
    const all = Array.from(document.querySelectorAll('[contenteditable]'))
        .filter(el => el.getAttribute('contenteditable')?.toLowerCase() !== 'false');
    // Keep only top-level hosts (exclude those whose ancestor is also contenteditable)
    const hosts = all.filter(el => !el.closest('[contenteditable] [contenteditable]'));
    return hosts;
}

function replaceTextInNodes(element, regex, replacement, onReplace, opts = {}) {
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
        const newText = oldText.replace(regex, () => {
            onReplace();
            return replacement;
        });
        if (newText !== oldText) {
            textNode.textContent = newText;
            changed = true;
        }
    });
    if (changed && !opts.suppressEvent) {
        element.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return changed;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'FR_RUN') {
        const elements = getEditableElements();
        let total = 0;
        const changedContentEditables = new Set();

        const groupResults = msg.groups.map(g => {
            let groupReplacements = 0;
            const ruleResults = g.rules.map(r => {
                let replacements = 0;
                let regex;
                try {
                    regex = new RegExp(r.pattern, r.flags || '');
                } catch {
                    return { pattern: r.pattern, flags: r.flags, replacements: 0, error: 'invalid regex' };
                }
                elements.forEach(el => {
                    // (If later adding inputs/textarea back, this branch will handle them.)
                    if ('value' in el) {
                        const oldVal = el.value;
                        const newVal = oldVal.replace(regex, () => {
                            replacements++;
                            return r.replacement;
                        });
                        if (newVal !== oldVal) {
                            el.value = newVal;
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    } else {
                        // Suppress per-rule events; batch after all rules applied.
                        const changed = replaceTextInNodes(
                            el,
                            regex,
                            r.replacement,
                            () => replacements++,
                            { suppressEvent: true }
                        );
                        if (changed) changedContentEditables.add(el);
                    }
                });
                groupReplacements += replacements;
                total += replacements;
                return { pattern: r.pattern, flags: r.flags, replacements };
            });
            return { name: g.name, replacements: groupReplacements, ruleResults };
        });

        // Single input/change dispatch per contenteditable element after all rules.
        changedContentEditables.forEach(el => {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });

        sendResponse({ total, groupResults });
        return true;
    }
});