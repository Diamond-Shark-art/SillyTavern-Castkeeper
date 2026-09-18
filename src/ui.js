import { FIELDS, missingFields, empty } from './model.js';

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}
function button(text, action, className = '') {
    const node = element('button', `menu_button npc-button ${className}`, text);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
}
const provenance = { story: 'From story', generated: 'Generated', edited: 'Edited' };

export class ProfilesUI {
    constructor(engine) {
        this.engine = engine;
        this.selected = null;
        this.dirty = false;
        this.editorRevision = null;
        this.editorChat = null;
        this.fields = {};
        this.preview = null;
    }

    mount() {
        this.settingsRoot = element('div', 'npc-profiles-settings');
        const drawer = element('div', 'inline-drawer');
        const toggle = element('div', 'inline-drawer-toggle inline-drawer-header');
        toggle.setAttribute('role', 'button'); toggle.tabIndex = 0;
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-controls', 'castkeeper-settings-content');
        const icon = element('div', 'inline-drawer-icon fa-solid fa-circle-chevron-down down');
        icon.setAttribute('aria-hidden', 'true');
        toggle.append(element('b', '', 'Castkeeper'), icon);
        // The host's delegated click handler owns animation and visibility. Only
        // add keyboard activation and ARIA here, to avoid toggling the drawer twice.
        toggle.addEventListener('click', () => toggle.setAttribute('aria-expanded', String(icon.classList.contains('down'))));
        toggle.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle.click(); }
        });
        const content = element('div', 'inline-drawer-content'); content.id = 'castkeeper-settings-content';
        drawer.append(toggle, content);
        this.settingsControls = {};
        for (const [key, text, help] of [
            ['enabled', 'Enable Castkeeper', 'Keep a separate NPC library for each chat.'],
            ['autoScan', 'Detect NPCs automatically', 'Normally adds one AI request after each reply, using your current connection.'],
            ['autoComplete', 'Automatically complete new profiles', 'Adds a creative-generation request when new profiles have empty fields. Off by default.'],
            ['inject', 'Include relevant profiles in replies', 'Use saved details to help the roleplay model stay consistent.'],
        ]) {
            const row = element('label', 'npc-setting'), input = element('input');
            input.type = 'checkbox'; input.dataset.setting = key;
            input.addEventListener('change', () => this.action(() => this.engine.setSettings({ [key]: input.checked })));
            const copy = element('span'); copy.append(element('strong', '', text), element('small', '', help));
            row.append(input, copy); content.append(row); this.settingsControls[key] = input;
        }
        const budgetLabel = element('label', 'npc-budget', 'Profile context budget (tokens)');
        const budget = element('input', 'text_pole'); budget.type = 'number'; budget.min = '128'; budget.max = '8000'; budget.step = '1'; budget.dataset.setting = 'budget';
        budget.addEventListener('change', () => this.action(() => this.engine.setSettings({ budget: Number(budget.value) })));
        budgetLabel.append(budget); content.append(budgetLabel); this.settingsControls.budget = budget;
        content.append(button('Open Castkeeper', () => this.open()));
        this.settingsRoot.append(drawer);
        (document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings') ?? document.body).append(this.settingsRoot);
        const menu = document.querySelector('#extensionsMenu');
        if (menu) {
            this.launcher = element('div', 'list-group-item npc-launcher');
            this.launcher.setAttribute('role', 'button'); this.launcher.tabIndex = 0;
            const menuIcon = element('i', 'fa-solid fa-address-book fa-fw');
            menuIcon.setAttribute('aria-hidden', 'true');
            this.launcher.append(menuIcon, element('span', '', 'Castkeeper'));
            this.launcher.addEventListener('click', () => this.open());
            this.launcher.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.launcher.click(); }
            });
            menu.append(this.launcher);
        } else {
            this.launcher = button('Castkeeper', () => this.open(), 'npc-launcher npc-launcher-floating');
            document.body.append(this.launcher);
        }
        this.launcher.title = 'Browse and edit NPC profiles for this chat';

        this.dialog = element('dialog', 'npc-profiles-dialog');
        this.dialog.setAttribute('aria-labelledby', 'npc-profiles-title');
        const header = element('header', 'npc-header'), title = element('div');
        title.append(element('span', 'npc-eyebrow', 'YOUR STORY’S CAST'));
        const heading = element('h2', '', 'Castkeeper'); heading.id = 'npc-profiles-title';
        title.append(heading); header.append(title, button('Close', () => this.close()));
        this.dialog.append(header);
        const tools = element('div', 'npc-toolbar');
        this.scanButton = button('Scan recent messages', () => this.action(async () => this.handleResult(await this.engine.scanRecent())));
        this.newButton = button('+ New profile', () => this.choose('new'));
        tools.append(this.scanButton, this.newButton);
        this.dialog.append(tools);
        const statusRow = element('div', 'npc-status-row');
        this.status = element('span', 'npc-status'); this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
        this.retryButton = button('Retry', () => this.action(async () => this.handleResult(await this.engine.retry())));
        statusRow.append(this.status, this.retryButton); this.dialog.append(statusRow);
        this.scanDetails = element('details', 'npc-scan-details'); this.scanDetails.hidden = true;
        this.scanDetailsList = element('ul');
        this.scanDetails.append(element('summary', '', 'Scan details'), this.scanDetailsList);
        this.dialog.append(this.scanDetails);
        this.error = element('p', 'npc-error'); this.error.setAttribute('role', 'alert'); this.error.hidden = true; this.dialog.append(this.error);
        const body = element('div', 'npc-layout');
        this.sidebar = element('aside', 'npc-sidebar');
        this.search = element('input', 'text_pole npc-search'); this.search.type = 'search'; this.search.placeholder = 'Search this chat’s NPCs'; this.search.setAttribute('aria-label', 'Search NPC profiles');
        this.search.addEventListener('input', () => this.renderList());
        this.list = element('div', 'npc-list'); this.list.setAttribute('aria-label', 'NPC profiles');
        this.sidebar.append(this.search, this.list);
        this.editor = element('section', 'npc-editor'); this.editor.setAttribute('aria-label', 'Profile editor');
        body.append(this.sidebar, this.editor); this.dialog.append(body);
        this.dialog.addEventListener('cancel', event => { if (this.dirty && !globalThis.confirm('Discard your unsaved profile edits?')) event.preventDefault(); else this.dirty = false; });
        document.body.append(this.dialog);
        this.refresh();
        return this;
    }

    async action(callback) {
        this.error.hidden = true;
        try { return await callback(); }
        catch (error) {
            // Background actions already expose their error beside Retry.
            if (this.engine.status.kind !== 'error' || this.engine.status.message !== error.message) {
                this.error.textContent = error.message; this.error.hidden = false;
            }
        }
        finally { this.refresh(); }
    }

    open() {
        this.error.hidden = true;
        this.refresh();
        if (!this.dialog.open) this.dialog.showModal();
    }

    close() {
        if (this.dirty && !globalThis.confirm('Discard your unsaved profile edits?')) return;
        this.dirty = false;
        this.renderEditor();
        this.dialog.close();
        this.launcher.focus();
    }

    choose(id) {
        if (this.dirty && !globalThis.confirm('Discard your unsaved profile edits?')) return;
        this.selected = id; this.dirty = false; this.preview = null; this.error.hidden = true;
        this.renderEditor(); this.renderList();
    }

    refresh() {
        if (!this.dialog) return;
        let view;
        try { view = this.engine.view(); }
        catch (error) { this.status.textContent = error.message; return; }
        for (const [key, control] of Object.entries(this.settingsControls)) {
            if (key === 'budget') control.value = view.settings.budget;
            else control.checked = view.settings[key];
        }
        this.status.textContent = view.status.message;
        this.status.dataset.kind = view.status.kind;
        this.retryButton.hidden = !view.status.retry;
        this.scanDetails.hidden = !view.status.details?.length;
        this.scanDetailsList.replaceChildren(...(view.status.details ?? []).map(issue => element('li', '', `${issue.npc}${issue.field ? ` — ${FIELDS[issue.field]?.label ?? issue.field}` : ' — encounter'}: ${issue.reason}`)));
        this.retryButton.disabled = view.status.kind === 'busy';
        this.scanButton.disabled = view.status.kind === 'busy' || !view.settings.enabled || !view.chatKey;
        this.newButton.disabled = !view.chatKey;
        if (this.editorChat && this.editorChat !== view.chatKey) {
            const lost = this.dirty;
            this.selected = null; this.dirty = false; this.preview = null;
            this.renderEditor();
            if (lost) { this.error.textContent = 'Chat changed. Unsaved edits from the previous chat were discarded.'; this.error.hidden = false; }
        } else if (!this.dirty && !this.preview && this.editorRevision !== view.revision) this.renderEditor();
        if (this.staleNotice) this.staleNotice.hidden = !this.dirty || this.editorRevision === view.revision;
        if (this.generateButton) this.generateButton.disabled = this.dirty || view.status.kind === 'busy' || !view.settings.enabled || !view.chatKey || !this.canGenerate;
        this.renderList();
    }

    renderList() {
        const view = this.engine.view(), query = this.search.value.trim().toLocaleLowerCase();
        const items = view.profiles.filter(profile => JSON.stringify(profile.values).toLocaleLowerCase().includes(query) || profile.label.toLocaleLowerCase().includes(query));
        this.list.replaceChildren();
        if (!items.length) {
            const blank = element('div', 'npc-empty');
            blank.append(element('h3', '', query ? 'No matches' : 'A cast waiting to be discovered'), element('p', '', query ? 'Try a different name or detail.' : 'NPCs appear here after a story reply. You can also scan recent messages or create a profile yourself.'));
            this.list.append(blank);
        }
        for (const profile of items) {
            const item = button('', () => this.choose(profile.id), `npc-cast-card ${this.selected === profile.id ? 'is-selected' : ''}`);
            item.setAttribute('aria-pressed', String(this.selected === profile.id));
            const count = Object.values(profile.values).filter(value => !empty(value)).length;
            item.append(element('strong', '', profile.label), element('span', '', profile.values.species || 'Species unknown'), element('small', '', `${count}/${Object.keys(FIELDS).length} fields · ${profile.active ? 'In this story' : 'Inactive encounter'}`));
            this.list.append(item);
        }
    }

    renderEditor() {
        const view = this.engine.view();
        this.editorRevision = view.revision; this.editorChat = view.chatKey;
        this.editor.replaceChildren(); this.fields = {}; this.generateButton = null;
        this.dialog.classList.toggle('npc-has-selection', Boolean(this.selected));
        const profile = view.profiles.find(item => item.id === this.selected);
        if (this.selected !== 'new' && !profile) {
            this.selected = null; this.dialog.classList.remove('npc-has-selection');
            const blank = element('div', 'npc-editor-empty');
            blank.append(element('span', 'npc-empty-glyph', '✦'), element('h3', '', 'Every encounter has a story'), element('p', '', 'Select an NPC to see what is known, add your own details, or explore a generated backstory.'));
            this.editor.append(blank); return;
        }
        this.editor.append(button('← All profiles', () => this.choose(null), 'npc-mobile-back'));
        const intro = element('div', 'npc-editor-intro');
        intro.append(element('h3', '', profile?.label ?? 'New profile'), element('p', '', profile?.active === false ? 'This encounter no longer exists in the current history. Your manual corrections are retained.' : 'Empty fields are unknown. Your edits lock automatically; uncheck a lock to allow later story updates.'));
        this.editor.append(intro);
        this.staleNotice = element('div', 'npc-stale', 'Profiles changed while you were editing. Copy any unsaved text, then reload this editor before saving.');
        this.staleNotice.hidden = true;
        this.staleNotice.append(button('Reload editor', () => { if (globalThis.confirm('Discard these unsaved edits and reload the saved profile?')) { this.dirty = false; this.renderEditor(); } }));
        this.editor.append(this.staleNotice);
        const form = element('form', 'npc-form'); form.addEventListener('submit', event => { event.preventDefault(); void this.save(); });
        for (const [key, def] of Object.entries(FIELDS)) {
            const wrapper = element('div', `npc-field ${['body', 'backstory'].includes(key) ? 'npc-field-wide' : ''}`);
            const labelRow = element('div', 'npc-field-header'), label = element('label', '', def.label), id = `npc-profile-field-${key}`;
            label.htmlFor = id; labelRow.append(label);
            const cell = profile?.cells[key], badge = element('span', 'npc-provenance', cell ? provenance[cell.provenance] : 'Unknown');
            badge.dataset.provenance = cell?.provenance ?? 'unknown';
            if (cell?.evidence?.length) badge.title = cell.evidence.map(item => `Message ${item.messageId + 1}: ${item.quote}`).join('\n');
            labelRow.append(badge);
            const input = element(key === 'name' || key === 'species' || key === 'ancestry' || key === 'coloring' ? 'input' : 'textarea', 'text_pole');
            input.id = id; input.name = key;
            if (input.tagName === 'TEXTAREA') input.rows = ['body', 'backstory'].includes(key) ? 4 : 3;
            input.maxLength = def.list ? def.max * 12 + 11 : def.max;
            input.value = def.list ? (profile?.values[key] ?? []).join('\n') : (profile?.values[key] ?? '');
            input.placeholder = def.list ? 'Unknown · one item per line' : 'Unknown';
            if (key === 'name') input.required = true;
            const lockLabel = element('label', 'npc-lock'), lock = element('input'); lock.type = 'checkbox'; lock.checked = profile?.locks.includes(key) ?? false;
            lock.setAttribute('aria-label', `Lock ${def.label}`); lockLabel.append(lock, document.createTextNode('Lock field'));
            input.addEventListener('input', () => {
                lock.checked = true; badge.textContent = 'Edited · unsaved'; badge.dataset.provenance = 'edited';
                this.dirty = true; this.refresh();
            });
            lock.addEventListener('change', () => { this.dirty = true; this.refresh(); });
            wrapper.append(labelRow, input, lockLabel); form.append(wrapper);
            this.fields[key] = { input, lock };
        }
        const actions = element('div', 'npc-editor-actions');
        const save = button('Save profile', () => this.save(), 'npc-primary');
        actions.append(save, button('Reset edits', () => { this.dirty = false; this.renderEditor(); }));
        if (profile) {
            this.canGenerate = missingFields(profile).length > 0;
            this.generateButton = button('Generate missing details', () => this.action(async () => {
                if (this.dirty) throw new Error('Save or reset your edits before generating suggestions.');
                this.handleResult(await this.engine.generate(profile.id));
            }));
            this.generateButton.disabled = !this.canGenerate || !view.settings.enabled || view.status.kind === 'busy';
            actions.append(this.generateButton);
            actions.append(button('Delete profile', () => this.action(async () => {
                if (!globalThis.confirm(`Delete ${profile.label}? This name and its aliases will be ignored by automatic detection. You can still create it manually.`)) return;
                await this.engine.removeProfile(profile.id, this.editorRevision, this.editorChat);
                this.selected = null; this.dirty = false; this.preview = null; this.renderEditor();
            }), 'npc-danger'));
        }
        form.append(actions); this.editor.append(form);
        this.previewArea = element('section', 'npc-preview'); this.previewArea.hidden = true; this.editor.append(this.previewArea);
    }

    async save() {
        return this.action(async () => {
            const values = {}, locks = [];
            for (const [key, { input, lock }] of Object.entries(this.fields)) {
                values[key] = FIELDS[key].list ? input.value.split('\n').map(value => value.trim()).filter(Boolean) : input.value;
                if (lock.checked) locks.push(key);
            }
            const id = await this.engine.saveProfile(this.selected === 'new' ? null : this.selected, values, locks, this.editorRevision, this.editorChat);
            this.selected = id; this.dirty = false; this.preview = null; this.renderEditor();
        });
    }

    handleResult(result) {
        if (result?.empty) { this.error.textContent = 'There are no empty, unlocked fields to fill.'; this.error.hidden = false; }
        if (!result?.preview) return;
        const targetId = result.changes[0]?.id;
        if (!targetId) return;
        if (this.editorChat !== result.ticket.key || this.dirty) throw new Error('Suggestions are no longer current. Save your edits and generate again.');
        this.selected = targetId; this.preview = result; this.renderEditor(); this.renderList();
        this.previewArea.hidden = false;
        this.previewArea.append(element('h3', '', 'Review suggested details'), element('p', '', 'These are invented additions. Edit or deselect any suggestion before applying. Changed suggestions become locked edits.'));
        const controls = [];
        for (const change of result.changes) {
            for (const [key, value] of Object.entries(change.fields)) {
                const label = element('div', 'npc-preview-field'), tick = element('input'); tick.type = 'checkbox'; tick.checked = true;
                tick.setAttribute('aria-label', `Include suggested ${FIELDS[key].label}`);
                const title = element('span', '', FIELDS[key].label), input = element('textarea', 'text_pole');
                input.setAttribute('aria-label', `Suggested ${FIELDS[key].label}`); input.rows = 3;
                input.value = Array.isArray(value) ? value.join('\n') : value;
                label.append(tick, title, input); this.previewArea.append(label); controls.push({ id: change.id, key, tick, input });
            }
        }
        const actions = element('div', 'npc-editor-actions');
        actions.append(button('Apply selected suggestions', () => this.action(async () => {
            if (this.dirty) throw new Error('Save or reset your profile edits before applying suggestions.');
            const byId = new Map();
            for (const { id, key, tick, input } of controls) {
                if (!tick.checked) continue;
                if (!byId.has(id)) byId.set(id, { id, fields: {} });
                byId.get(id).fields[key] = FIELDS[key].list ? input.value.split('\n').map(value => value.trim()).filter(Boolean) : input.value;
            }
            if (!byId.size) throw new Error('Select at least one suggestion, or discard this preview.');
            await this.engine.applyPreview(result, [...byId.values()]);
            this.preview = null; this.renderEditor();
        }), 'npc-primary'), button('Discard suggestions', () => { this.preview = null; this.renderEditor(); }));
        this.previewArea.append(actions);
        this.previewArea.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    dispose() {
        this.dialog?.remove(); this.launcher?.remove(); this.settingsRoot?.remove();
    }
}
