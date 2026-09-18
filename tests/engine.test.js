import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, chatKey, exclusions } from '../src/engine.js';
import { KEY, profiles } from '../src/model.js';
import { createHost, until, delay } from './host.js';
import { npc, response } from './fixtures.js';

function setup() {
    const host = createHost(), engine = new Engine(() => host).bind();
    host.respond = async () => JSON.stringify(response(npc()));
    return { host, engine };
}

test('quiet scans keep visible chat intact, persist metadata, and do not recursively scan', async () => {
    const { host, engine } = setup(), before = structuredClone(host.chat);
    await engine.scanRecent(); await delay(10);
    assert.deepEqual(host.chat, before); assert.equal(host.calls.length, 1);
    assert.equal(profiles(host.chatMetadata[KEY]).length, 1); assert.equal(host.saved.length, 1);
    assert.match(host.extensionPrompts[KEY].value, /Mira/);
    assert.equal(host.calls[0].skipWIAN, false);
    engine.dispose();
});

test('duplicate completion notifications cause one scan and already scanned responses are skipped', async () => {
    const { host, engine } = setup();
    await host.eventSource.emit('MESSAGE_RECEIVED', 1, 'normal');
    await host.eventSource.emit('CHARACTER_MESSAGE_RENDERED', 1, 'normal');
    await until(() => host.saved.length === 1); await delay(20);
    await host.eventSource.emit('MESSAGE_RECEIVED', 1, 'normal'); await delay(20);
    assert.equal(host.calls.length, 1); engine.dispose();
});

test('scanning waits for ordinary generation to end and ignores unfinished streaming notifications', async () => {
    const { host, engine } = setup();
    await host.eventSource.emit('GENERATION_STARTED', 'normal', {}, false);
    host.streamingProcessor = { isFinished: false };
    await host.eventSource.emit('CHARACTER_MESSAGE_RENDERED', 1, 'normal'); await delay(15);
    assert.equal(host.calls.length, 0);
    host.streamingProcessor.isFinished = true;
    await host.eventSource.emit('CHARACTER_MESSAGE_RENDERED', 1, 'normal'); await delay(15);
    assert.equal(host.calls.length, 0);
    await host.eventSource.emit('GENERATION_ENDED');
    await until(() => host.saved.length === 1); engine.dispose();
});

test('chat switch during a model call discards the result and clears old injection', async () => {
    const { host, engine } = setup(); let finish;
    host.respond = () => new Promise(resolve => { finish = resolve; });
    const job = engine.scanRecent();
    await until(() => Boolean(finish));
    host.chatId = 'story-two'; host.chatMetadata = {};
    await host.eventSource.emit('CHAT_CHANGED');
    finish(JSON.stringify(response(npc())));
    await assert.rejects(job, /discarded/);
    assert.equal(host.chatMetadata[KEY], undefined); assert.equal(host.extensionPrompts[KEY].value, ''); engine.dispose();
});

test('editing a profile during a scan wins over the stale model result', async () => {
    const { host, engine } = setup(); await engine.scanRecent();
    let finish; host.respond = () => new Promise(resolve => { finish = resolve; });
    const job = engine.scanRecent(); await until(() => Boolean(finish));
    const view = engine.view(), mira = view.profiles[0];
    await engine.saveProfile(mira.id, { ...mira.values, species: 'elf' }, mira.locks, view.revision, view.chatKey);
    finish(JSON.stringify(response(npc({ id: mira.id }))));
    await assert.rejects(job, /discarded/);
    assert.equal(engine.view().profiles[0].values.species, 'elf'); engine.dispose();
});

test('invalid JSON and connection errors keep previous profiles and expose retry', async () => {
    const { host, engine } = setup(); await engine.scanRecent();
    const before = structuredClone(host.chatMetadata[KEY]); host.respond = async () => '{bad';
    await assert.rejects(engine.scanRecent(), /JSON/);
    assert.deepEqual(host.chatMetadata[KEY], before); assert.equal(engine.status.retry, true);
    host.respond = async () => JSON.stringify(response(npc({ id: engine.view().profiles[0].id })));
    await engine.retry();
    host.respond = async () => { throw new Error('Network unavailable'); };
    await assert.rejects(engine.scanRecent(), /Network/); assert.equal(engine.status.retry, true);
    assert.equal(engine.foregroundBusy, false); engine.dispose();
});

test('manual generation is a preview; stale previews cannot overwrite edited fields', async () => {
    const { host, engine } = setup(); await engine.scanRecent();
    const mira = engine.view().profiles[0];
    host.respond = async () => JSON.stringify({ profiles: [{ id: mira.id, fields: { backstory: 'A former florist.' } }] });
    const preview = await engine.generate(mira.id);
    assert.equal(engine.view().profiles[0].values.backstory, '');
    const view = engine.view();
    await engine.saveProfile(mira.id, { ...mira.values, backstory: 'A former captain.' }, [], view.revision, view.chatKey);
    await assert.rejects(engine.applyPreview(preview, preview.changes), /discarded/);
    assert.equal(engine.view().profiles[0].values.backstory, 'A former captain.'); engine.dispose();
});

test('automatic completion defaults off and uses one additional request when enabled', async () => {
    const { host, engine } = setup(); assert.equal(engine.settings().autoComplete, false);
    await engine.setSettings({ autoComplete: true });
    host.respond = async prompt => prompt.includes('TASK: Extract') ? JSON.stringify(response(npc())) : JSON.stringify({ profiles: [{ id: engine.view().profiles[0].id, fields: { backstory: 'A former florist.' } }] });
    await engine.scanRecent();
    assert.equal(host.calls.length, 2); assert.equal(engine.view().profiles[0].cells.backstory.provenance, 'generated'); engine.dispose();
});

test('the next ordinary generation waits for a running background scan without deadlocking', async () => {
    const { host, engine } = setup(); let finish;
    host.respond = () => new Promise(resolve => { finish = resolve; });
    const scan = engine.scanRecent(); await until(() => Boolean(finish));
    let started = false;
    const foreground = host.eventSource.emit('GENERATION_STARTED', 'normal', {}, false).then(() => { started = true; });
    await delay(10); assert.equal(started, false);
    finish(JSON.stringify(response(npc())));
    await scan; await foreground; assert.equal(started, true);
    await host.eventSource.emit('GENERATION_ENDED'); engine.dispose();
});

test('disabling while a request is running discards it and clears injection', async () => {
    const { host, engine } = setup(); let finish;
    host.respond = () => new Promise(resolve => { finish = resolve; });
    const job = engine.scanRecent(); await until(() => Boolean(finish));
    await engine.setSettings({ enabled: false });
    finish(JSON.stringify(response(npc())));
    await assert.rejects(job, /discarded/); assert.equal(engine.view().profiles.length, 0);
    assert.equal(host.extensionPrompts[KEY].value, ''); engine.dispose();
});

test('same chat names across characters have different identities; group cards are excluded', () => {
    const host = createHost(), first = chatKey(host);
    host.characters.push({ name: 'Other', avatar: 'other.png' }); host.characterId = 1;
    assert.notEqual(chatKey(host), first);
    host.groupId = 'group'; host.groups = [{ id: 'group', members: ['narrator.png', 'other.png'] }];
    assert.deepEqual(exclusions(host), ['Player', 'Narrator', 'Other']);
});

test('persisted metadata survives a reload and stays isolated from another chat', async () => {
    const { host, engine } = setup(); await engine.scanRecent();
    const saved = structuredClone(host.chatMetadata); engine.dispose();
    const reloaded = new Engine(() => host);
    host.chatMetadata = JSON.parse(JSON.stringify(saved)); assert.equal(reloaded.view().profiles[0].label, 'Mira');
    host.chatMetadata = {}; host.chatId = 'different'; assert.equal(reloaded.view().profiles.length, 0); reloaded.dispose();
});

test('a stopped background call cannot commit a late successful response', async () => {
    const { host, engine } = setup(); let finish;
    host.respond = () => new Promise(resolve => { finish = resolve; });
    const job = engine.scanRecent(); await until(() => Boolean(finish));
    await host.eventSource.emit('GENERATION_STOPPED'); finish(JSON.stringify(response(npc())));
    await assert.rejects(job, /discarded/); assert.equal(engine.view().profiles.length, 0); engine.dispose();
});

test('a deferred notification from the previous chat cannot scan the newly opened chat', async () => {
    const host = createHost(), deferred = [];
    const engine = new Engine(() => host, { defer: callback => deferred.push(callback) }).bind();
    await host.eventSource.emit('MESSAGE_RECEIVED', 1, 'normal');
    host.chatId = 'another-story'; host.chatMetadata = {};
    await host.eventSource.emit('CHAT_CHANGED');
    while (deferred.length) deferred.shift()();
    await delay(10);
    assert.equal(host.calls.length, 0); engine.dispose();
});

test('queued generation actions are serialized', async () => {
    const { host, engine } = setup(); let inflight = 0, maximum = 0;
    host.respond = async () => { inflight++; maximum = Math.max(maximum, inflight); await delay(10); inflight--; return JSON.stringify(response(npc())); };
    await Promise.all([engine.scanRecent(), engine.scanRecent()]);
    assert.equal(host.calls.length, 2); assert.equal(maximum, 1);
    assert.equal(engine.view().profiles.length, 1); engine.dispose();
});

test('unsupported stored data stays untouched', async () => {
    const { host, engine } = setup();
    host.chatMetadata[KEY] = { version: 999, secretFutureData: 'retain' };
    await assert.rejects(engine.scanRecent(), /Unsupported/);
    assert.deepEqual(host.chatMetadata[KEY], { version: 999, secretFutureData: 'retain' });
    assert.equal(host.calls.length, 0); engine.dispose();
});
