export const narrative = 'Mira, a human bartender with olive skin and a sturdy build, greets you. Mira likes gardening and dislikes loud arguments. She is patient. A silver-scaled dragon named Ember lands nearby.';
export const chat = () => [
    { is_user: true, name: 'Player', mes: 'I enter the tavern.' },
    { is_user: false, name: 'Narrator', mes: narrative, swipe_id: 0 },
];
export const quote = text => ({ messageId: 1, quote: text });
export const fact = (value, excerpt = narrative) => ({ value, evidence: [quote(excerpt)] });
export const npc = (overrides = {}) => ({
    id: null, name: 'Mira', identityKind: 'named', encounter: quote(narrative),
    fields: { species: fact('human'), coloring: fact('olive'), body: fact('sturdy build'), likes: fact(['gardening']), dislikes: fact(['loud arguments']), traits: fact(['patient']) },
    ...overrides,
});
export const response = (...npcs) => ({ npcs });
