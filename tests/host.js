import { chat as fixtureChat } from './fixtures.js';

export class Events {
    callbacks = new Map();
    on(name, callback) { if (!this.callbacks.has(name)) this.callbacks.set(name, []); this.callbacks.get(name).push(callback); }
    removeListener(name, callback) { this.callbacks.set(name, (this.callbacks.get(name) ?? []).filter(item => item !== callback)); }
    async emit(name, ...args) { for (const callback of [...(this.callbacks.get(name) ?? [])]) await callback(...args); }
}

export function createHost() {
    const eventSource = new Events();
    const eventTypes = Object.fromEntries(['APP_READY', 'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'MESSAGE_RECEIVED', 'CHARACTER_MESSAGE_RENDERED', 'CHAT_CHANGED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'CONNECTION_PROFILE_LOADED', 'MAIN_API_CHANGED', 'CHATCOMPLETION_MODEL_CHANGED', 'CHATCOMPLETION_SOURCE_CHANGED'].map(value => [value, value]));
    const host = {
        chat: fixtureChat(), chatMetadata: {}, chatId: 'story-one', characterId: 0, groupId: null,
        characters: [{ name: 'Narrator', avatar: 'narrator.png' }], groups: [], name1: 'Player', name2: 'Narrator',
        mainApi: 'openai', onlineStatus: 'connected', extensionSettings: {}, eventSource, eventTypes,
        extensionPrompts: {}, saved: [], calls: [],
        getCurrentChatId() { return host.chatId; },
        async saveMetadata() { host.saved.push(structuredClone(host.chatMetadata)); },
        saveSettingsDebounced() {},
        setExtensionPrompt(key, value, ...options) { host.extensionPrompts[key] = { value, options }; },
        async getTokenCountAsync(text) { return Math.ceil(text.length / 4); },
        respond: async () => '{"npcs":[]}',
        async generateQuietPrompt(options) {
            host.calls.push(options);
            await eventSource.emit(eventTypes.GENERATION_STARTED, 'quiet', { quiet_prompt: options.quietPrompt }, false);
            try { return await host.respond(options.quietPrompt); }
            finally { await eventSource.emit(eventTypes.GENERATION_ENDED, host.chat.length); }
        },
    };
    return host;
}

export const delay = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
export async function until(test) {
    for (let i = 0; i < 200; i++) { if (test()) return; await delay(5); }
    throw new Error('Timed out waiting for test condition.');
}
