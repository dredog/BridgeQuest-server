'use strict';
/* Run:  DATABASE_URL=postgres://... node test.js
   Checks the bridge logic, then plays a small duplicate game through the real web calls.
   It works in a scratch schema ("bq_test") that it creates and deletes, so it never touches real results. */
const assert = require('assert');
const L = require('./lib');
let n = 0; const ok = (name) => console.log(`ok  ${++n}. ${name}`);

// ---------- logic ----------
for (let i = 0; i < 2000; i++) {
  const h = L.dealBestSouth();
  const all = [...h.N, ...h.E, ...h.S, ...h.W];
  assert.strictEqual(new Set(all).size, 52); for (const s of L.SEATS) assert.strictEqual(h[s].length, 13);
  const p = Object.fromEntries(L.SEATS.map((s) => [s, L.hcp(h[s])]));
  assert.ok(p.S >= p.N && p.S >= p.E && p.S >= p.W, 'South has the best hand');
  assert.ok(p.N + p.S > 20, 'North-South are the stronger side');
  assert.deepStrictEqual(L.checkDeal(h), h);
}
ok('2000 random deals: 52 different cards, South holds the best hand, North-South stronger');
assert.strictEqual(L.miniScore('3N', 9), 400); assert.strictEqual(L.miniScore('3N', 10), 430); assert.strictEqual(L.miniScore('4S', 10), 420);
assert.strictEqual(L.miniScore('2C', 9), 110); assert.strictEqual(L.miniScore('1N', 7), 90); assert.strictEqual(L.miniScore('5D', 11), 400);
assert.strictEqual(L.miniScore('3N', 7), -100); assert.strictEqual(L.miniScore('2H', 8), 110); assert.strictEqual(L.miniScore('4H', 9), -50);
ok('scores match the app (3NT= 400, 4S= 420, 2C+1 110, down two −100 …)');
const mp = L.matchpoint([{ key: 'a', score: 420 }, { key: 'b', score: 420 }, { key: 'c', score: 170 }, { key: 'd', score: -50 }]);
assert.deepStrictEqual(mp.map((r) => [r.mp, r.top, r.pct, r.rank]), [[2.5, 3, 83.3, 1], [2.5, 3, 83.3, 1], [1, 3, 33.3, 3], [0, 3, 0, 4]]);
assert.strictEqual(L.matchpoint([{ key: 'a', score: 90 }])[0].pct, null);
ok('matchpoints: beat = 1, tie = ½, alone on a board = no percentage yet');
assert.ok(L.cleanUser('Max7') && !L.cleanUser('max the great') && !L.cleanUser('') && !L.cleanUser('a'.repeat(21)) && !L.cleanUser('bob!'));
assert.throws(() => L.checkDeal({ N: [], E: [], S: [], W: [] })); 
ok('usernames: letters and numbers only, 1–20 long');

// ---------- the web calls, against a real database ----------
(async () => {
  if (!process.env.DATABASE_URL) { console.log('\nDATABASE_URL not set — skipped the database part.'); return; }
  process.env.ADMIN_KEY = 'testkey';
  const { Pool } = require('pg');
  const admin = new Pool({ connectionString: process.env.DATABASE_URL });
  await admin.query('DROP SCHEMA IF EXISTS bq_test CASCADE'); await admin.query('CREATE SCHEMA bq_test');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: '-c search_path=bq_test' });
  delete require.cache[require.resolve('./server')];
  const { createApp } = require('./server');
  const { app, init } = createApp(pool);
  await init(); await init();                      // starting twice must be harmless
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, path, body, headers) => {
    const r = await fetch(base + path, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json; try { json = JSON.parse(text); } catch (e) { json = text; }
    return { status: r.status, body: json, headers: r.headers };
  };
  const next = (user) => call('POST', '/api/next', { user });
  const result = (user, boardId, contract, tricks) => call('POST', '/api/result', { user, boardId, contract, tricks });
  try {
    assert.strictEqual((await call('GET', '/health')).body, 'ok'); ok('health check answers ok');
    assert.strictEqual((await next('not a name')).status, 400); ok('a bad username is turned away');

    // Alice is first: a new deal is made for her
    let a = await next('Alice'); assert.strictEqual(a.status, 200); assert.ok(a.body.created); const b1 = a.body.board;
    assert.strictEqual(b1.number, 1); assert.strictEqual(b1.hands.S.length, 13);
    assert.strictEqual((await next('alice')).body.board.id, b1.id); ok('first player gets a new random deal; asking again resumes the same board');
    assert.strictEqual((await call('GET', `/api/board/${b1.id}?user=Bob`)).status, 403); ok('results are hidden until you have played the board');
    let r = await result('Alice', b1.id, '3N', 9);
    assert.ok(r.body.saved); assert.strictEqual(r.body.you.score, 400); assert.strictEqual(r.body.you.pct, null); ok('first result saved; no matchpoints yet with one player');
    r = await result('Alice', b1.id, '6N', 13); assert.strictEqual(r.body.saved, false); assert.strictEqual(r.body.you.score, 400); ok('a second try on the same board does not replace the first');

    // Bob and Cara arrive: both are sent to the SAME deal, not a new one
    const b = await next('Bob'); assert.strictEqual(b.body.board.id, b1.id); assert.deepStrictEqual(b.body.board.hands, b1.hands); assert.ok(!b.body.created);
    const c = await next('Cara'); assert.strictEqual(c.body.board.id, b1.id); ok('later players are dealt the same hands');
    r = await result('Bob', b1.id, '3N', 10); assert.strictEqual(r.body.you.pct, 100); assert.strictEqual(r.body.results.length, 2);
    r = await result('Cara', b1.id, '4S', 9); assert.strictEqual(r.body.you.score, -50); assert.strictEqual(r.body.you.pct, 0);
    assert.deepStrictEqual(r.body.results.map((x) => [x.user, x.score, x.pct]), [['Bob', 430, 100], ['Alice', 400, 50], ['Cara', -50, 0]]); ok('board comparison: ranked by score with matchpoint percentages');

    // Alice looks back: her 400 was "no score yet", now it is 50%
    let me = await call('GET', '/api/player/Alice'); assert.strictEqual(me.body.boards[0].pct, 50); assert.strictEqual(me.body.summary.pct, 50); ok('looking back later shows the updated matchpoints');

    // Alice has played everything → new deal #2.  Bob (played #1 only) is sent to #2 as well, so it collects plays.
    a = await next('Alice'); assert.ok(a.body.created); assert.strictEqual(a.body.board.number, 2); const b2 = a.body.board;
    assert.strictEqual((await next('Bob')).body.board.id, b2.id);
    await result('Alice', b2.id, '2H', 8); await result('Bob', b2.id, '2H', 8);
    // Dee is brand new: boards 1 (3 results) and 2 (2 results) exist → she gets the one with FEWER results
    const d = await next('Dee'); assert.strictEqual(d.body.board.id, b2.id); ok('a player is sent to the unplayed board with the fewest results');
    await result('Dee', b2.id, '2H', 9);
    assert.strictEqual((await next('Dee')).body.board.id, b1.id); ok('…and then to the other one, in any order');

    me = await call('GET', '/api/player/alice');
    // board 1: 1 of 2 matchpoints.  board 2: Alice 110 ties Bob 110, loses to Dee 140 → 0.5 of 2.  Total 1.5 of 4 = 37.5%
    assert.deepStrictEqual(me.body.summary, { boards: 2, compared: 2, mp: 1.5, top: 4, pct: 37.5 }); ok('running tally adds matchpoints across boards (1.5 of 4 = 37.5%)');
    const lb = await call('GET', '/api/leaderboard');
    assert.deepStrictEqual(lb.body.players.map((p) => [p.user, p.pct]), [['Dee', 100], ['Bob', 62.5], ['Alice', 37.5], ['Cara', 0]]); ok('leaderboard ranks everyone by percentage');

    assert.strictEqual((await result('Bob', b1.id, '8N', 9)).status, 400); assert.strictEqual((await result('Bob', b1.id, '3N', 14)).status, 400);
    assert.strictEqual((await result('Bob', 99999, '3N', 9)).status, 404); ok('nonsense contracts, trick counts and board numbers are refused');

    // teacher calls
    assert.strictEqual((await call('POST', '/api/admin/reset')).status, 401);
    const deal = L.dealBestSouth();
    const t = await call('POST', '/api/admin/boards', { hands: deal }, { 'X-Admin-Key': 'testkey' }); assert.strictEqual(t.body.board.number, 3);
    assert.strictEqual((await call('POST', '/api/admin/boards', { hands: Object.assign({}, deal, { N: deal.S }) }, { 'X-Admin-Key': 'testkey' })).status, 400); ok('a hand-picked deal can be added with the admin key; a broken deal is refused');
    assert.strictEqual((await call('POST', '/api/admin/reset', null, { 'X-Admin-Key': 'testkey' })).body.season, 2);
    a = await next('Alice'); assert.strictEqual(a.body.board.number, 1); assert.strictEqual(a.body.board.season, 2); assert.notStrictEqual(a.body.board.id, b1.id);
    assert.strictEqual((await call('GET', '/api/leaderboard')).body.players.length, 0);
    assert.strictEqual((await call('GET', '/api/leaderboard?season=1')).body.players.length, 4); ok('reset starts a fresh season; the old one can still be looked up');

    // two players asking at the same instant with nothing left to play
    const both = await Promise.all(['Eve', 'Finn', 'Gus', 'Hal'].map(async (u) => { await result(u, a.body.board.id, '1N', 7); return u; }));
    const ask = await Promise.all(both.map((u) => next(u)));
    assert.ok(ask.every((x) => x.status === 200));
    assert.strictEqual(new Set(ask.map((x) => x.body.board.id)).size, 1); assert.strictEqual(ask.filter((x) => x.body.created).length, 1);
    ok('several players running out of boards at the same instant all get the SAME new deal');
    const opt = await call('OPTIONS', '/api/next'); assert.strictEqual(opt.status, 204); assert.strictEqual(opt.headers.get('access-control-allow-origin'), '*'); ok('the app on another website is allowed to call the server');
    console.log(`\nAll ${n} checks passed.`);
  } finally {
    srv.close(); await pool.end(); await admin.query('DROP SCHEMA IF EXISTS bq_test CASCADE'); await admin.end();
  }
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
