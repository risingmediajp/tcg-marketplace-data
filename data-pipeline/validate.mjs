// Sanity checks run before anything is written to dist/. A throw here fails the job
// and leaves the last published files untouched.

const MIN_CARDS = { en: 20000 };

export function validateIndex(ix) {
  const need = (ok, msg) => { if (!ok) throw new Error(`index-${ix.lang}: ${msg}`); };
  need(ix.v === 1, 'bad version');
  need(Array.isArray(ix.sets) && ix.sets.length > 50, `too few sets (${ix.sets?.length})`);
  need(Array.isArray(ix.cards) && ix.cards.length >= (MIN_CARDS[ix.lang] ?? 1000), `too few cards (${ix.cards?.length})`);
  for (const c of ix.cards) {
    need(Array.isArray(c) && c.length === 8 && typeof c[0] === 'string' && typeof c[1] === 'string', `bad card tuple ${JSON.stringify(c)}`);
    need(ix.sets[c[2]], `card ${c[0]} points at missing set ${c[2]}`);
  }
  if (ix.lang === 'en') need(ix.species.length > 900, `too few species (${ix.species.length})`);
}

export function validateHome(h) {
  const need = (ok, msg) => { if (!ok) throw new Error(`home: ${msg}`); };
  need(h.v === 1 && h.config && Array.isArray(h.sections), 'bad shape');
  for (const s of h.sections) {
    need(s.id && s.title, 'section missing id/title');
    need(s.cards.length >= (s.id === 'heating' ? 0 : 5), `section ${s.id} has only ${s.cards.length} cards`);
    for (const c of s.cards) need(c.id && c.name && c.image && c.usd > 0, `bad card in ${s.id}: ${JSON.stringify(c)}`);
  }
}
