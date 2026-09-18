import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, profiles, scanChanges, applyScan, evidenceMessages, historySources, reconcile, editProfile, deleteProfile, completionChanges, applyCompletion, injection, parseResponse, mentions } from '../src/model.js';
import { chat, npc, response, quote, fact } from './fixtures.js';

function seeded() {
    const state = createState(), history = chat(), messages = evidenceMessages(history, 1);
    applyScan(state, scanChanges(state, response(npc()), messages, [], () => 'mira'), historySources(history)[1]);
    return { state, history, messages };
}

test('a first encounter extracts supported human fields and leaves backstory and ancestry unknown', () => {
    const { state } = seeded(), mira = profiles(state)[0];
    assert.equal(mira.values.body, 'sturdy build'); assert.equal(mira.values.ancestry, '');
    assert.equal(mira.values.backstory, ''); assert.deepEqual(mira.values.likes, ['gardening']);
    assert.equal(mira.cells.coloring.provenance, 'story'); assert.equal(mira.active, true);
});

test('multiple NPCs, including non-human characters and an unnamed individual, keep separate identities', () => {
    const state = createState(), history = chat();
    history[1].mes += ' The watchman offers you directions.';
    let id = 0;
    const changes = scanChanges(state, response(npc(), npc({ name: 'Ember', encounter: quote(history[1].mes), fields: { species: fact('dragon'), coloring: fact('silver') } }), npc({ name: 'watchman', identityKind: 'role', encounter: quote('The watchman offers you directions.'), fields: {} })), evidenceMessages(history, 1), [], () => String(++id));
    applyScan(state, changes, historySources(history)[1]);
    assert.deepEqual(profiles(state).map(item => item.values.name), ['Mira', 'Ember', 'watchman']);
    assert.equal(profiles(state)[1].values.species, 'dragon');
});

test('player and active character cards are excluded even in otherwise valid model output', () => {
    const { state, messages } = seeded();
    assert.deepEqual(scanChanges(state, response(npc()), messages, ['Mira']), []);
});

test('malformed fields or fabricated evidence reject an entire scan before mutation', () => {
    const { state, messages } = seeded(), before = structuredClone(state);
    for (const fields of [{ species: fact('elf', 'Mira is an elf.') }, { traits: fact('patient') }, { inventedField: fact('x') }]) {
        assert.throws(() => scanChanges(state, response(npc(), npc({ name: 'Ember', fields })), messages));
        assert.deepEqual(state, before);
    }
});

test('facts cannot cite older context outside the authorized exchange', () => {
    const { state, history } = seeded();
    history.push({ is_user: true, mes: 'Hello' }, { is_user: false, mes: 'Mira waves.' });
    assert.throws(() => scanChanges(state, response(npc({ id: 'mira' })), evidenceMessages(history, 3)), /excerpt/);
});

test('returning aliases reuse an ID while an ambiguous shared name does not merge profiles', () => {
    const { state, history } = seeded();
    let mira = profiles(state)[0];
    editProfile(state, 'mira', { ...mira.values, aliases: ['Captain Mira'] }, []);
    history[1].mes += ' Captain Mira returns.';
    const data = npc({ name: 'Captain Mira', fields: {}, encounter: quote('Captain Mira returns.') });
    assert.equal(scanChanges(state, response(data), evidenceMessages(history, 1))[0].id, 'mira');
    editProfile(state, null, { name: 'Captain Mira' }, [], () => 'other');
    assert.throws(() => scanChanges(state, response(data), evidenceMessages(history, 1)), /Ambiguous/);
});

test('manual edits lock automatically; explicitly unlocking allows later supported changes', () => {
    const { state, history } = seeded();
    editProfile(state, 'mira', { ...profiles(state)[0].values, species: 'elf' }, []);
    let changes = scanChanges(state, response(npc({ id: 'mira' })), evidenceMessages(history, 1));
    assert.equal(changes[0].fields.species, undefined);
    applyScan(state, changes, historySources(history)[1]);
    assert.equal(profiles(state)[0].values.species, 'elf');
    editProfile(state, 'mira', profiles(state)[0].values, []);
    changes = scanChanges(state, response(npc({ id: 'mira' })), evidenceMessages(history, 1));
    applyScan(state, changes, historySources(history)[1]);
    assert.equal(profiles(state)[0].values.species, 'human');
});

test('swiping away an encounter removes extracted and generated facts, retaining manual corrections', () => {
    const { state, history } = seeded();
    applyCompletion(state, [{ id: 'mira', fields: { backstory: 'She once ran a nursery.' } }], historySources(history)[1]);
    editProfile(state, 'mira', { ...profiles(state)[0].values, traits: ['bold'] }, []);
    history[1].mes = 'The tavern is empty.'; history[1].swipe_id = 1;
    assert.equal(reconcile(state, history), true);
    const mira = profiles(state)[0];
    assert.equal(mira.active, false); assert.equal(mira.values.species, '');
    assert.equal(mira.values.backstory, ''); assert.deepEqual(mira.values.traits, ['bold']);
});

test('middle-history edits invalidate descendant facts even if later text is unchanged', () => {
    const { state, history } = seeded();
    history[0].mes = 'I never entered the tavern.';
    reconcile(state, history);
    assert.equal(profiles(state)[0].active, false);
    assert.equal(state.events.length, 0);
});

test('deleted NPCs stay suppressed on later scans', () => {
    const { state, messages } = seeded(); deleteProfile(state, 'mira');
    assert.equal(profiles(state).length, 0);
    assert.equal(scanChanges(state, response(npc()), messages).length, 0);
});

test('creative output is restricted to empty unlocked non-identity fields', () => {
    const { state } = seeded(), targets = profiles(state);
    assert.throws(() => completionChanges({ profiles: [{ id: 'mira', fields: { species: 'elf' } }] }, targets), /existing/);
    assert.throws(() => completionChanges({ profiles: [{ id: 'wrong', fields: { backstory: 'x' } }] }, targets), /identity/);
    assert.deepEqual(completionChanges({ profiles: [{ id: 'mira', fields: { backstory: 'A florist turned bartender.' } }] }, targets), [{ id: 'mira', fields: { backstory: 'A florist turned bartender.' } }]);
});

test('edited preview suggestions become locked manual edits; unchanged suggestions stay generated', () => {
    const { state, history } = seeded();
    const original = [{ id: 'mira', fields: { ancestry: 'Coastal ancestry', backstory: 'A former florist.' } }];
    applyCompletion(state, [{ id: 'mira', fields: { ancestry: 'Coastal ancestry', backstory: 'A former sailor.' } }], historySources(history)[1], original);
    const mira = profiles(state)[0];
    assert.equal(mira.cells.ancestry.provenance, 'generated');
    assert.equal(mira.cells.backstory.provenance, 'edited');
    assert.ok(mira.locks.includes('backstory'));
});

test('token-limited context prioritizes a pending named NPC and never overflows its budget', async () => {
    const { state, history } = seeded();
    editProfile(state, null, { name: 'Ember', species: 'dragon', backstory: 'Long story. '.repeat(100) }, [], () => 'ember');
    const count = text => Promise.resolve(text.length);
    const result = await injection(state, history, 'I speak to Ember.', 310, count);
    assert.ok(result.text.length <= 310);
    assert.ok(result.text.indexOf('Ember') >= 0);
    assert.ok(result.text.indexOf('Mira') < 0 || result.text.indexOf('Ember') < result.text.indexOf('Mira'));
    assert.equal(mentions('Hannah enters', 'Ann'), false);
});

test('irrelevant and inactive profiles are not injected', async () => {
    const { state, history } = seeded();
    history[1].mes = 'Empty room'; reconcile(state, history);
    assert.equal((await injection(state, history, 'Mira?', 1000, async text => text.length)).text, '');
});

test('JSON parsing accepts a fenced object but never evaluates text', () => {
    assert.deepEqual(parseResponse('```json\n{"npcs":[]}\n```'), { npcs: [] });
    assert.throws(() => parseResponse('alert(document.cookie)'));
    assert.throws(() => parseResponse('[]'));
});

test('later likes enrich earlier evidence and deleting the later exchange restores the earlier set', () => {
    const { state, history } = seeded();
    history.push({ is_user: true, mes: 'What else do you like?' }, { is_user: false, mes: 'Mira says she also likes tea.' });
    const source = { messageId: 3, quote: 'Mira says she also likes tea.' };
    const changes = scanChanges(state, response(npc({ id: 'mira', encounter: source, fields: { likes: { value: ['tea'], evidence: [source] } } })), evidenceMessages(history, 3));
    applyScan(state, changes, historySources(history)[3]);
    assert.deepEqual(profiles(state)[0].values.likes, ['gardening', 'tea']);
    assert.equal(profiles(state)[0].cells.likes.evidence.length, 2);
    history.splice(2); reconcile(state, history);
    assert.deepEqual(profiles(state)[0].values.likes, ['gardening']);
    assert.equal(profiles(state)[0].active, true);
});

test('prototype property names are not accepted as profile fields', () => {
    const { state, messages } = seeded();
    const fields = JSON.parse('{"__proto__":{"value":"bad","evidence":[{"messageId":1,"quote":"Mira"}]}}');
    assert.throws(() => scanChanges(state, response(npc({ fields })), messages), /Unknown profile field/);
    assert.equal(Object.prototype.value, undefined);
});

test('manual recreation explicitly restores a suppressed name', () => {
    const { state, messages } = seeded(); deleteProfile(state, 'mira');
    editProfile(state, null, { name: 'Mira' }, [], () => 'restored');
    assert.equal(scanChanges(state, response(npc()), messages)[0].id, 'restored');
});
