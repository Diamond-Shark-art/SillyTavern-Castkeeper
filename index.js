import { Engine } from './src/engine.js';
import { ProfilesUI } from './src/ui.js';

let engine, ui;

export function initialize() {
    if (engine || !globalThis.SillyTavern) return;
    const context = SillyTavern.getContext();
    for (const name of ['generateQuietPrompt', 'saveMetadata', 'setExtensionPrompt', 'saveSettingsDebounced']) {
        if (typeof context[name] !== 'function') {
            console.error(`Castkeeper requires SillyTavern 1.19.0 or later: ${name} is unavailable.`);
            return;
        }
    }
    engine = new Engine(() => SillyTavern.getContext(), {
        onChange: () => ui?.refresh(),
        pendingText: () => document.querySelector('#send_textarea')?.value ?? '',
    });
    ui = new ProfilesUI(engine).mount();
    engine.bind();
    void engine.changed({ switched: true });
}

globalThis.npcProfilesBeforeGeneration = async (...args) => engine?.intercept(...args);

export function onDisable() {
    engine?.dispose(); ui?.dispose(); engine = null; ui = null;
}
export function onEnable() { initialize(); }

// Third-party extensions may be loaded before or after APP_READY.
if (globalThis.SillyTavern) {
    const context = SillyTavern.getContext();
    const events = context.eventTypes ?? context.event_types;
    if (events?.APP_READY) context.eventSource.on(events.APP_READY, initialize);
    else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
    else initialize();
}
