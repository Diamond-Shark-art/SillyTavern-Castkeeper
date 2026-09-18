import {
    KEY, DEFAULTS, readState, profiles, historySources, latestAssistant, evidenceMessages,
    reconcile, parseResponse, scanChanges, applyScan, editProfile, deleteProfile,
    completionChanges, applyCompletion, missingFields, injection,
} from './model.js';
import { scanPrompt, completionPrompt } from './prompts.js';

class StaleResult extends Error {
    constructor() { super('The chat or profile changed. The old result was discarded; run the action again.'); }
}

export function chatKey(context) {
    const chatId = context.getCurrentChatId?.() ?? context.chatId;
    if (chatId == null || chatId === '') return null;
    const owner = context.groupId != null ? `group:${context.groupId}` : `character:${context.characters?.[context.characterId]?.avatar ?? context.characterId}`;
    return `${owner}/${chatId}`;
}

export function exclusions(context) {
    const names = [context.name1];
    if (context.groupId != null) {
        const group = context.groups?.find(item => String(item.id) === String(context.groupId));
        for (const character of context.characters ?? []) if (group?.members?.includes(character.avatar)) names.push(character.name);
    } else names.push(context.characters?.[context.characterId]?.name, context.name2);
    return [...new Set(names.filter(Boolean))];
}

export class Engine {
    constructor(getContext, { onChange = () => {}, pendingText = () => '', defer = callback => setTimeout(callback, 0) } = {}) {
        this.getContext = getContext;
        this.onChange = onChange;
        this.pendingText = pendingText;
        this.defer = defer;
        this.epoch = 0;
        this.foregroundBusy = false;
        this.ownPrompt = null;
        this.queue = [];
        this.active = null;
        this.queuedScans = new Set();
        this.listeners = [];
        this.retrySpec = null;
        this.status = { kind: 'idle', message: 'Ready. Unknown details stay empty.' };
        this.injectionVersion = 0;
    }

    settings() {
        const context = this.getContext();
        return { ...DEFAULTS, ...context.extensionSettings?.[KEY] };
    }

    state() {
        return readState(this.getContext().chatMetadata?.[KEY]);
    }

    view() {
        return { profiles: profiles(this.state()), revision: this.state().revision, chatKey: chatKey(this.getContext()), settings: this.settings(), status: this.status };
    }

    signal(kind, message) {
        this.status = { kind, message, retry: Boolean(this.retrySpec) && kind === 'error' };
        this.onChange();
    }

    async setSettings(patch) {
        const context = this.getContext(), next = { ...this.settings(), ...patch };
        next.budget = Math.max(128, Math.min(8000, Number(next.budget) || 1000));
        context.extensionSettings[KEY] = next;
        context.saveSettingsDebounced();
        if (!next.enabled) this.invalidate('Disabled. Your saved profiles are retained.');
        await this.refreshInjection();
        this.onChange();
    }

    capture() {
        const context = this.getContext(), key = chatKey(context);
        if (!key) throw new Error('Open a character or group chat first.');
        return { key, epoch: this.epoch, revision: this.state().revision, history: historySources(context.chat ?? []).at(-1)?.key ?? '', connection: context.mainApi };
    }

    valid(ticket) {
        const context = this.getContext();
        return ticket.key === chatKey(context) && ticket.epoch === this.epoch && ticket.revision === this.state().revision
            && ticket.history === (historySources(context.chat ?? []).at(-1)?.key ?? '') && ticket.connection === context.mainApi;
    }

    assert(ticket) { if (!this.valid(ticket)) throw new StaleResult(); }

    async commit(next, ticket) {
        this.assert(ticket);
        const context = this.getContext(), previous = context.chatMetadata[KEY];
        context.chatMetadata[KEY] = next;
        try {
            // SillyTavern's API owns server persistence. Never write a captured metadata object after an await.
            await context.saveMetadata();
        } catch (error) {
            if (chatKey(this.getContext()) === ticket.key && this.getContext().chatMetadata[KEY] === next) this.getContext().chatMetadata[KEY] = previous;
            throw error;
        }
        if (chatKey(this.getContext()) !== ticket.key || this.epoch !== ticket.epoch) throw new StaleResult();
        await this.refreshInjection();
        this.onChange();
    }

    async saveProfile(id, values, locks, expectedRevision, expectedChat) {
        if (expectedChat !== chatKey(this.getContext()) || expectedRevision !== this.state().revision) throw new StaleResult();
        const ticket = this.capture(), next = structuredClone(this.state());
        const savedId = editProfile(next, id, values, locks);
        await this.commit(next, ticket);
        return savedId;
    }

    async removeProfile(id, expectedRevision, expectedChat) {
        if (expectedChat !== chatKey(this.getContext()) || expectedRevision !== this.state().revision) throw new StaleResult();
        const ticket = this.capture(), next = structuredClone(this.state());
        deleteProfile(next, id);
        await this.commit(next, ticket);
    }

    invalidate(message = 'Ready.') {
        this.epoch++;
        for (const task of this.queue.splice(0)) task.resolve(null);
        this.queuedScans.clear();
        this.retrySpec = null;
        this.clearInjection();
        this.signal('idle', message);
    }

    async changed({ scan = false, switched = false } = {}) {
        this.invalidate(switched ? 'Ready. Profiles belong to this chat.' : 'Story changed. Updating profile evidence.');
        if (switched) this.foregroundBusy = false;
        if (!chatKey(this.getContext())) return;
        try {
            const ticket = this.capture(), next = structuredClone(this.state());
            if (reconcile(next, this.getContext().chat)) await this.commit(next, ticket);
            else await this.refreshInjection();
            if (scan && this.settings().enabled && this.settings().autoScan) this.scheduleScan(latestAssistant(this.getContext().chat));
        } catch (error) { if (!(error instanceof StaleResult)) this.signal('error', error.message); }
    }

    enqueue(spec) {
        return new Promise((resolve, reject) => {
            this.queue.push({ spec, resolve, reject, epoch: this.epoch, key: chatKey(this.getContext()) });
            this.defer(() => this.drain());
        });
    }

    drain() {
        if (this.active || this.foregroundBusy || this.ownPrompt || !this.queue.length) return;
        const task = this.queue.shift();
        if (task.epoch !== this.epoch || task.key !== chatKey(this.getContext())) {
            task.resolve(null);
            this.defer(() => this.drain());
            return;
        }
        // Set the promise before the quiet generator can emit a synchronous host event.
        this.active = Promise.resolve().then(async () => {
            try {
                if (!this.settings().enabled) throw new Error('Enable Castkeeper before using AI actions.');
                this.retrySpec = task.spec;
                const result = await this.run(task.spec);
                if (task.epoch === this.epoch && task.key === chatKey(this.getContext())) {
                    this.retrySpec = null;
                    this.signal('idle', result?.preview ? 'Suggestions ready. Review them before applying.' : 'Profiles are up to date.');
                }
                task.resolve(result);
            } catch (error) {
                if (task.epoch === this.epoch && task.key === chatKey(this.getContext())) {
                    if (error instanceof StaleResult) {
                        this.retrySpec = null;
                        this.signal('idle', error.message);
                    } else this.signal('error', error.message);
                }
                task.reject(error);
            }
        }).finally(() => {
            this.active = null;
            if (task.spec.dedupe) this.queuedScans.delete(task.spec.dedupe);
            this.defer(() => this.drain());
        });
    }

    async quiet(prompt, ticket) {
        this.assert(ticket);
        this.ownPrompt = `${prompt}\nREQUEST IDENTIFIER: npc-profiles-${globalThis.crypto.randomUUID()}`;
        this.clearInjection();
        try {
            const context = this.getContext();
            if (context.onlineStatus === 'no_connection') throw new Error('Connect an AI model in SillyTavern, then retry.');
            const raw = await context.generateQuietPrompt({ quietPrompt: this.ownPrompt, quietToLoud: false, skipWIAN: false, responseLength: 4096, removeReasoning: true, trimToSentence: false });
            this.assert(ticket);
            return parseResponse(raw);
        } finally {
            this.ownPrompt = null;
            await this.refreshInjection();
        }
    }

    async run(spec) {
        if (spec.kind === 'scan') {
            const context = this.getContext(), index = spec.index ?? latestAssistant(context.chat);
            const source = historySources(context.chat)[index];
            if (!source || context.chat[index].is_user || context.chat[index].is_system) throw new Error('There is no assistant response to scan yet.');
            if (spec.sourceKey && source.key !== spec.sourceKey) throw new StaleResult();
            if (!spec.force && this.state().events.some(event => event.kind === 'scan' && event.source?.key === source.key)) return null;
            const ticket = this.capture(), messages = evidenceMessages(context.chat, index, spec.recent);
            this.signal('busy', spec.recent ? 'Scanning the last six messages…' : 'Scanning NPC encounters…');
            const payload = await this.quiet(scanPrompt(messages, profiles(this.state()), exclusions(context)), ticket);
            const next = structuredClone(this.state());
            const plans = scanChanges(next, payload, messages, exclusions(this.getContext()));
            applyScan(next, plans, source);
            await this.commit(next, ticket);
            const ids = plans.filter(plan => plan.isNew).map(plan => plan.id);
            if (this.settings().autoComplete && ids.length) {
                const completionSpec = { kind: 'complete', ids, automatic: true, source };
                this.retrySpec = completionSpec;
                return this.complete(completionSpec);
            }
            return null;
        }
        return this.complete(spec);
    }

    async complete(spec) {
        const ticket = this.capture(), context = this.getContext();
        const targets = profiles(this.state()).filter(profile => spec.ids.includes(profile.id) && missingFields(profile).length);
        if (!targets.length) return { empty: true };
        const source = spec.source ?? historySources(context.chat).at(-1) ?? null;
        if (source && historySources(context.chat)[source.index]?.key !== source.key) throw new StaleResult();
        this.signal('busy', spec.automatic ? 'Completing new profiles…' : 'Generating missing details…');
        const payload = await this.quiet(completionPrompt(targets), ticket);
        const changes = completionChanges(payload, targets);
        if (!changes.some(change => Object.keys(change.fields).length)) throw new Error('The model returned no missing details. Try generating again.');
        this.assert(ticket);
        if (!spec.automatic) return { preview: true, changes, ticket, source };
        const next = structuredClone(this.state());
        applyCompletion(next, changes, source);
        await this.commit(next, ticket);
        return null;
    }

    async applyPreview(preview, changes) {
        this.assert(preview.ticket);
        // Restrict edited suggestions to exactly the originally offered profiles/fields.
        for (const change of changes) {
            const original = preview.changes.find(item => item.id === change.id);
            if (!original || Object.keys(change.fields).some(key => !(key in original.fields))) throw new Error('Invalid preview selection.');
        }
        const next = structuredClone(this.state());
        applyCompletion(next, changes, preview.source, preview.changes);
        await this.commit(next, preview.ticket);
        this.signal('idle', 'Selected suggestions applied. Edited suggestions are locked.');
    }

    scanRecent() { return this.enqueue({ kind: 'scan', force: true, recent: true }); }
    generate(id) { return this.enqueue({ kind: 'complete', ids: [id], automatic: false }); }
    retry() {
        if (!this.retrySpec) return Promise.resolve(null);
        // Retry a scan against the current revision, never replay a removed source.
        return this.enqueue(this.retrySpec.kind === 'scan' ? { kind: 'scan', force: true, recent: this.retrySpec.recent } : this.retrySpec);
    }

    scheduleScan(index) {
        if (!this.settings().enabled || !this.settings().autoScan || index < 0) return;
        const context = this.getContext(), source = historySources(context.chat)[index];
        if (!source || context.chat[index].is_user || context.chat[index].is_system) return;
        const dedupe = `${chatKey(context)}:${source.key}`;
        if (this.queuedScans.has(dedupe)) return;
        this.queuedScans.add(dedupe);
        this.enqueue({ kind: 'scan', index, sourceKey: source.key, dedupe }).catch(() => {});
    }

    clearInjection() {
        this.injectionVersion++;
        this.getContext().setExtensionPrompt(KEY, '', 1, 1, false, 0);
    }

    async refreshInjection() {
        const version = ++this.injectionVersion, context = this.getContext(), settings = this.settings();
        if (!chatKey(context) || !settings.enabled || !settings.inject || this.ownPrompt) {
            context.setExtensionPrompt(KEY, '', 1, 1, false, 0);
            return;
        }
        const ticket = this.capture();
        // Reconcile a copy so abandoned facts can never be injected, even before an edit event is handled.
        const state = structuredClone(this.state());
        reconcile(state, context.chat);
        const count = async text => {
            const value = context.getTokenCountAsync ? await context.getTokenCountAsync(text) : new TextEncoder().encode(text).length;
            if (!Number.isFinite(value) || value < 0) throw new Error('SillyTavern could not count the profile tokens.');
            return value;
        };
        const pending = [context.chat.at(-1)?.is_user ? context.chat.at(-1).mes : '', this.pendingText()].join('\n');
        const result = await injection(state, context.chat, pending, Math.max(128, Math.min(8000, Number(settings.budget) || 1000)), count);
        if (version === this.injectionVersion && this.valid(ticket)) context.setExtensionPrompt(KEY, result.text, 1, 1, false, 0);
    }

    async intercept(_chat, _size, _abort, type) {
        if (this.ownPrompt && type === 'quiet') { this.clearInjection(); return; }
        try { await this.refreshInjection(); }
        catch (error) { this.clearInjection(); this.signal('error', `Profile context could not be updated: ${error.message}`); }
    }

    bind() {
        const context = this.getContext(), events = context.eventTypes ?? context.event_types;
        const on = (name, callback) => {
            if (!events[name]) return;
            context.eventSource.on(events[name], callback);
            this.listeners.push([events[name], callback]);
        };
        on('GENERATION_STARTED', async (type, options, dryRun) => {
            if (dryRun || (type === 'quiet' && this.ownPrompt && options?.quiet_prompt === this.ownPrompt)) return;
            // Prevent the user's next generation from overlapping our use of the same host connection.
            this.foregroundBusy = true;
            if (this.active) await this.active;
        });
        on('GENERATION_ENDED', () => {
            if (this.ownPrompt) return;
            this.foregroundBusy = false;
            this.defer(() => this.drain());
        });
        on('GENERATION_STOPPED', () => {
            this.foregroundBusy = false;
            this.invalidate('Generation stopped. Partial profile results were discarded.');
        });
        const received = (index, type) => {
            if (this.ownPrompt || ['quiet', 'impersonate'].includes(type)) return;
            const owner = chatKey(this.getContext()), epoch = this.epoch;
            this.defer(() => {
                if (owner !== chatKey(this.getContext()) || epoch !== this.epoch) return;
                const stream = this.getContext().streamingProcessor;
                if (stream?.isFinished === false) return;
                this.scheduleScan(Number(index));
            });
        };
        on('CHARACTER_MESSAGE_RENDERED', received);
        on('MESSAGE_RECEIVED', received);
        on('CHAT_CHANGED', () => { void this.changed({ switched: true }); });
        for (const name of ['MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED']) on(name, () => { void this.changed({ scan: true }); });
        for (const name of ['CONNECTION_PROFILE_LOADED', 'MAIN_API_CHANGED', 'CHATCOMPLETION_MODEL_CHANGED', 'CHATCOMPLETION_SOURCE_CHANGED']) {
            on(name, () => this.invalidate('AI connection changed. Retry any pending profile action.'));
        }
        return this;
    }

    dispose() {
        this.invalidate('Disabled. Your saved profiles are retained.');
        const source = this.getContext().eventSource;
        for (const [name, callback] of this.listeners) source.removeListener(name, callback);
        this.listeners = [];
    }
}
