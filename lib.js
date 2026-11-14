'use strict';
/* Bridge Quest duplicate server — the bridge logic (no database, no web server in this file).
   Cards are two characters, suit then rank, exactly as the app writes them: 'SA', 'HT', 'D4', 'C2'. */
const crypto = require('crypto');

const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = 'AKQJT98765432';
const SEATS = ['N', 'E', 'S', 'W'];
const HCP = { A: 4, K: 3, Q: 2, J: 1 };

const hcp = (cards) => cards.reduce((n, c) => n + (HCP[c[1]] || 0), 0);
const sortHand = (cards) => cards.slice().sort((a, b) => SUITS.indexOf(a[0]) - SUITS.indexOf(b[0]) || RANKS.indexOf(a[1]) - RANKS.indexOf(b[1]));

function shuffledDeck(randInt = crypto.randomInt) {
  const d = [];
  SUITS.forEach((s) => RANKS.split('').forEach((r) => d.push(s + r)));
  for (let i = d.length - 1; i > 0; i--) { const j = randInt(i + 1); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}

/* A random deal, turned so the human (South) holds the best hand:
   South has the most high-card points at the table, and North-South have more than East-West.
   That makes South the declarer under the app's MiniBridge rule.  Deals that can't be turned that way are redealt. */
function dealBestSouth(randInt = crypto.randomInt) {
  for (;;) {
    const d = shuffledDeck(randInt);
    const h = [0, 1, 2, 3].map((i) => d.slice(i * 13, i * 13 + 13));          // four hands, clockwise
    const p = h.map(hcp), max = Math.max(...p);
    const s = [0, 1, 2, 3].find((i) => p[i] === max && p[i] + p[(i + 2) % 4] > 20);
    if (s === undefined) continue;
    // hand s becomes South; clockwise after South come West, North, East
    return { N: sortHand(h[(s + 2) % 4]), E: sortHand(h[(s + 3) % 4]), S: sortHand(h[s]), W: sortHand(h[(s + 1) % 4]) };
  }
}

/* Check a deal someone typed in: four hands of 13, all 52 cards exactly once.  Returns the tidied deal or throws. */
function checkDeal(hands) {
  if (!hands || typeof hands !== 'object') throw new Error('hands must be an object with N, E, S and W');
  const out = {}, seen = new Set();
  for (const seat of SEATS) {
    const cards = hands[seat];
    if (!Array.isArray(cards) || cards.length !== 13) throw new Error(`${seat} must have exactly 13 cards`);
    for (const c of cards) {
      if (typeof c !== 'string' || c.length !== 2 || !SUITS.includes(c[0]) || !RANKS.includes(c[1])) throw new Error(`"${c}" is not a card (use suit then rank, like SA or HT)`);
      if (seen.has(c)) throw new Error(`${c} appears twice`);
      seen.add(c);
    }
    out[seat] = sortHand(cards);
  }
  return out;
}

/* MiniBridge score from declarer's side, the same sums as the app's miniScore():
   made → trick points + 300 for game (100+ trick points bid) or 50 for a part score; down → minus 50 a trick. */
function parseContract(contract) {
  const m = /^([1-7])([CDHSN])$/.exec(String(contract || ''));
  return m ? { level: +m[1], strain: m[2] } : null;
}
function miniScore(contract, tricks) {
  const c = typeof contract === 'string' ? parseContract(contract) : contract;
  const need = c.level + 6;
  if (tricks < need) return -50 * (need - tricks);
  const per = 'DC'.includes(c.strain) ? 20 : 30;
  const bid = c.strain === 'N' ? 40 + 30 * (c.level - 1) : per * c.level;
  return bid + (tricks - need) * per + (bid >= 100 ? 300 : 50);
}

/* Matchpoints on one board.  results = [{ key, score, ... }].
   You get 1 point for every other player you beat and half a point for every one you tie.
   top = the most anyone could get (players − 1).  pct is null until at least two people have played. */
function matchpoint(results) {
  const n = results.length, top = n - 1;
  return results.map((r) => {
    let mp = 0, better = 0;
    for (const o of results) {
      if (o === r) continue;
      if (o.score < r.score) mp += 1; else if (o.score === r.score) mp += 0.5; else better++;
    }
    return Object.assign({}, r, { mp, top, pct: top > 0 ? Math.round((mp / top) * 1000) / 10 : null, rank: better + 1, players: n });
  });
}
/* Running tally over many boards: total matchpoints out of the total available. */
function tally(rows) {
  const t = { boards: rows.length, compared: 0, mp: 0, top: 0, pct: null };
  for (const r of rows) if (r.top > 0) { t.compared++; t.mp += r.mp; t.top += r.top; }
  if (t.top > 0) t.pct = Math.round((t.mp / t.top) * 1000) / 10;
  return t;
}

const USER_RE = /^[A-Za-z0-9]{1,20}$/;
function cleanUser(name) {
  const s = String(name == null ? '' : name).trim();
  return USER_RE.test(s) ? { name: s, key: s.toLowerCase() } : null;
}

module.exports = { SUITS, RANKS, SEATS, hcp, sortHand, shuffledDeck, dealBestSouth, checkDeal, parseContract, miniScore, matchpoint, tally, cleanUser };
