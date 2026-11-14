'use strict';
/* Bridge Quest duplicate server.
   Everyone plays the same deals; results are compared by matchpoints.
   Needs two settings (Railway supplies both):  PORT  and  DATABASE_URL  (a Postgres database).
   Optional:  ADMIN_KEY  — a word of your choosing that unlocks the /api/admin calls. */
const express = require('express');
const { Pool } = require('pg');
const L = require('./lib');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const GAMES = ['mini', 'bridge'];              // 'bridge' is reserved for the full game later

// state.problem is a plain-English reason the database is not usable yet (null once it is)
function createApp(pool, state = { problem: null }) {
  const q = (text, params) => pool.query(text, params);

  /* ---------- database ---------- */
  async function init() {
    await q(`CREATE TABLE IF NOT EXISTS meta (key text PRIMARY KEY, value text NOT NULL)`);
    await q(`INSERT INTO meta (key, value) VALUES ('season', '1') ON CONFLICT (key) DO NOTHING`);
    await q(`CREATE TABLE IF NOT EXISTS boards (
      id serial PRIMARY KEY,
      game text NOT NULL DEFAULT 'mini',
      season int NOT NULL,
      number int NOT NULL,
      hands jsonb NOT NULL,
      dealer text NOT NULL DEFAULT 'S',
      source text NOT NULL DEFAULT 'random',
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (game, season, number))`);
    // one row per player per board: made when they are handed the board, completed when they finish it
    await q(`CREATE TABLE IF NOT EXISTS plays (
      board_id int NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      user_key text NOT NULL,
      username text NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      contract text,
      tricks int,
      score int,
      detail jsonb,
      PRIMARY KEY (board_id, user_key))`);
    await q(`CREATE INDEX IF NOT EXISTS plays_user ON plays (user_key)`);
  }
  const currentSeason = async () => +(await q(`SELECT value FROM meta WHERE key = 'season'`)).rows[0].value;
  async function seasonOf(req) {
    const s = parseInt(req.query.season, 10);
    return Number.isInteger(s) && s > 0 ? s : currentSeason();
  }
  const gameOf = (v) => (GAMES.includes(v) ? v : 'mini');
  // the board this player has not been given yet that has the fewest finished results (oldest first on a tie)
  const UNPLAYED = `SELECT b.*, (SELECT count(*) FROM plays f WHERE f.board_id = b.id AND f.finished_at IS NOT NULL) AS n
    FROM boards b WHERE b.game = $1 AND b.season = $2
      AND NOT EXISTS (SELECT 1 FROM plays p WHERE p.board_id = b.id AND p.user_key = $3)
    ORDER BY n ASC, b.number ASC LIMIT 1`;
  const boardOut = (b, plays) => ({ id: b.id, number: b.number, game: b.game, season: b.season, hands: b.hands, dealer: b.dealer, plays });

  async function newBoard(game, season, hands, source, createdBy) {
    for (let attempt = 0; attempt < 5; attempt++) {       // two players can ask for a new board at the same moment
      const n = (await q(`SELECT COALESCE(MAX(number), 0) + 1 AS n FROM boards WHERE game = $1 AND season = $2`, [game, season])).rows[0].n;
      try {
        return (await q(`INSERT INTO boards (game, season, number, hands, source, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [game, season, n, JSON.stringify(hands), source, createdBy])).rows[0];
      } catch (e) { if (e.code !== '23505') throw e; }
    }
    throw new Error('could not create a board, please try again');
  }

  /* everyone's finished results on a set of boards, with matchpoints worked out board by board */
  async function scored(where, params) {
    const rows = (await q(`SELECT p.board_id, p.user_key, p.username, p.contract, p.tricks, p.score, p.finished_at, b.number, b.game, b.season
      FROM plays p JOIN boards b ON b.id = p.board_id WHERE p.finished_at IS NOT NULL AND ${where} ORDER BY p.finished_at`, params)).rows;
    const byBoard = new Map();
    for (const r of rows) { if (!byBoard.has(r.board_id)) byBoard.set(r.board_id, []); byBoard.get(r.board_id).push(r); }
    const out = [];
    for (const list of byBoard.values()) out.push(...L.matchpoint(list));
    return out;
  }
  const resultOut = (r, me) => ({ user: r.username, contract: r.contract, tricks: r.tricks, score: r.score, mp: r.mp, top: r.top, pct: r.pct, rank: r.rank, you: r.user_key === me });
  async function boardView(boardId, me) {
    const b = (await q(`SELECT * FROM boards WHERE id = $1`, [boardId])).rows[0];
    if (!b) return null;
    const rs = (await scored(`p.board_id = $1`, [boardId])).sort((x, y) => y.score - x.score || new Date(x.finished_at) - new Date(y.finished_at));
    const mine = rs.find((r) => r.user_key === me);
    return { board: boardOut(b, rs.length), results: rs.map((r) => resultOut(r, me)), you: mine ? resultOut(mine, me) : null };
  }
  async function playerView(u, game, season) {
    const mine = await scored(`b.game = $1 AND b.season = $2 AND p.board_id IN (SELECT board_id FROM plays WHERE user_key = $3 AND finished_at IS NOT NULL)`, [game, season, u.key]);
    const rows = mine.filter((r) => r.user_key === u.key).sort((x, y) => new Date(y.finished_at) - new Date(x.finished_at));
    return {
      user: rows.length ? rows[0].username : u.name, game, season, summary: L.tally(rows),
      boards: rows.map((r) => ({ id: r.board_id, number: r.number, contract: r.contract, tricks: r.tricks, score: r.score, players: r.players, mp: r.mp, top: r.top, pct: r.pct, rank: r.rank, playedAt: r.finished_at })),
    };
  }

  /* ---------- web server ---------- */
  const app = express();
  app.use((req, res, next) => {                  // the app is served from another site (GitHub Pages), so allow it in
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '50kb' }));
  const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
  const NAME_HELP = 'Pick a username of 1 to 20 letters and numbers (no spaces).';

  // Until the database is connected the server stays up and says what is wrong, instead of crashing.
  app.use((req, res, next) => {
    if (!state.problem) return next();
    if (req.path.startsWith('/api/')) return bad(res, 'The server is not ready: ' + state.problem, 503);
    res.status(503).type('text').send('NOT READY\n\n' + state.problem + '\n');
  });
  app.get('/', (req, res) => res.type('text').send('Bridge Quest duplicate server is running.'));
  app.get('/health', async (req, res) => { await q('SELECT 1'); res.type('text').send('ok'); });

  /* Hand a player their next board.
     1. A board they started but never finished comes back first.
     2. Otherwise the board they haven't played that has the FEWEST results so far — so every deal collects plays.
     3. If they have played everything, a brand-new random deal is made (and later players will be sent to it). */
  app.post('/api/next', async (req, res) => {
    const u = L.cleanUser(req.body && req.body.user); if (!u) return bad(res, NAME_HELP);
    const game = gameOf(req.body.game), season = await currentSeason();
    const count = async (id) => +(await q(`SELECT count(*) AS n FROM plays WHERE board_id = $1 AND finished_at IS NOT NULL`, [id])).rows[0].n;
    let b = (await q(`SELECT b.* FROM boards b JOIN plays p ON p.board_id = b.id
      WHERE b.game = $1 AND b.season = $2 AND p.user_key = $3 AND p.finished_at IS NULL ORDER BY p.started_at LIMIT 1`, [game, season, u.key])).rows[0];
    const resumed = !!b;
    if (!b) {
      b = (await q(UNPLAYED, [game, season, u.key])).rows[0];
    }
    let created = false;
    if (!b) {
      if (game !== 'mini') return bad(res, 'There are no more boards to play in this game yet.', 404);
      // One at a time here: if several players run out of boards in the same instant, the first makes the new deal
      // and the rest are handed that same deal instead of each getting their own.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(7412)');
        b = (await client.query(UNPLAYED, [game, season, u.key])).rows[0];
        if (!b) {
          const n = (await client.query(`SELECT COALESCE(MAX(number), 0) + 1 AS n FROM boards WHERE game = $1 AND season = $2`, [game, season])).rows[0].n;
          b = (await client.query(`INSERT INTO boards (game, season, number, hands, source, created_by) VALUES ($1, $2, $3, $4, 'random', $5) RETURNING *`,
            [game, season, n, JSON.stringify(L.dealBestSouth()), u.name])).rows[0];
          created = true;
        }
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    }
    await q(`INSERT INTO plays (board_id, user_key, username) VALUES ($1, $2, $3) ON CONFLICT (board_id, user_key) DO NOTHING`, [b.id, u.key, u.name]);
    res.json({ board: boardOut(b, await count(b.id)), resumed, created });
  });

  /* Save a finished board.  The first result a player sends for a board is the one that counts. */
  app.post('/api/result', async (req, res) => {
    const body = req.body || {};
    const u = L.cleanUser(body.user); if (!u) return bad(res, NAME_HELP);
    const boardId = parseInt(body.boardId, 10), tricks = parseInt(body.tricks, 10), c = L.parseContract(body.contract);
    if (!Number.isInteger(boardId)) return bad(res, 'boardId is missing.');
    if (!c) return bad(res, 'contract must look like 3N, 4S, 2C…');
    if (!Number.isInteger(tricks) || tricks < 0 || tricks > 13) return bad(res, 'tricks must be a number from 0 to 13.');
    const b = (await q(`SELECT id FROM boards WHERE id = $1`, [boardId])).rows[0];
    if (!b) return bad(res, 'That board does not exist.', 404);
    const score = L.miniScore(c, tricks), contract = body.contract, detail = body.detail == null ? null : JSON.stringify(body.detail);
    await q(`INSERT INTO plays (board_id, user_key, username) VALUES ($1, $2, $3) ON CONFLICT (board_id, user_key) DO NOTHING`, [boardId, u.key, u.name]);
    const done = await q(`UPDATE plays SET finished_at = now(), contract = $3, tricks = $4, score = $5, detail = $6, username = $7
      WHERE board_id = $1 AND user_key = $2 AND finished_at IS NULL`, [boardId, u.key, contract, tricks, score, detail, u.name]);
    const view = await boardView(boardId, u.key);
    const season = view.board.season, game = view.board.game;
    res.json(Object.assign({ saved: done.rowCount === 1, summary: (await playerView(u, game, season)).summary }, view));
  });

  /* Everyone's results on one board — only once you have played it yourself. */
  app.get('/api/board/:id', async (req, res) => {
    const u = L.cleanUser(req.query.user); if (!u) return bad(res, NAME_HELP);
    const view = await boardView(parseInt(req.params.id, 10) || 0, u.key);
    if (!view) return bad(res, 'That board does not exist.', 404);
    if (!view.you) return bad(res, 'Play this board first — then you can see how everyone else did.', 403);
    res.json(view);
  });

  /* A player's own page: every board they have played, with today's matchpoints, plus the running tally.
     Matchpoints are worked out fresh each time, so they move as more people play the same boards. */
  app.get('/api/player/:user', async (req, res) => {
    const u = L.cleanUser(req.params.user); if (!u) return bad(res, NAME_HELP);
    res.json(await playerView(u, gameOf(req.query.game), await seasonOf(req)));
  });

  /* Everyone, ranked by matchpoint percentage. */
  app.get('/api/leaderboard', async (req, res) => {
    const game = gameOf(req.query.game), season = await seasonOf(req);
    const rows = await scored(`b.game = $1 AND b.season = $2`, [game, season]);
    const by = new Map();
    for (const r of rows) { if (!by.has(r.user_key)) by.set(r.user_key, { user: r.username, rows: [] }); const e = by.get(r.user_key); e.rows.push(r); e.user = r.username; }
    const players = [...by.values()].map((e) => Object.assign({ user: e.user }, L.tally(e.rows)))
      .sort((a, b) => (b.pct === null ? -1 : b.pct) - (a.pct === null ? -1 : a.pct) || b.boards - a.boards || a.user.localeCompare(b.user));
    res.json({ game, season, boards: new Set(rows.map((r) => r.board_id)).size, players });
  });

  /* ---------- teacher-only calls (need the ADMIN_KEY setting) ---------- */
  const admin = (req, res, next) => (ADMIN_KEY && req.get('X-Admin-Key') === ADMIN_KEY ? next() : bad(res, 'Admin key missing or wrong.', 401));
  // start a fresh set of boards; the old season's boards and results are kept and can still be looked at with ?season=
  app.post('/api/admin/reset', admin, async (req, res) => {
    const season = (await currentSeason()) + 1;
    await q(`UPDATE meta SET value = $1 WHERE key = 'season'`, [String(season)]);
    res.json({ season });
  });
  // add a deal you chose yourself (for targeted practice or the full bridge game later)
  app.post('/api/admin/boards', admin, async (req, res) => {
    let hands; try { hands = L.checkDeal(req.body && req.body.hands); } catch (e) { return bad(res, e.message); }
    const b = await newBoard(gameOf(req.body.game), await currentSeason(), hands, 'targeted', 'admin');
    res.json({ board: boardOut(b, 0) });
  });

  app.use((req, res) => bad(res, 'Not found.', 404));
  app.use((err, req, res, next) => {             // eslint-disable-line no-unused-vars
    if (err && err.type === 'entity.parse.failed') return bad(res, 'That was not valid JSON.');
    console.error(err);
    bad(res, 'Something went wrong on the server.', 500);
  });
  return { app, init };
}

/* Turn a database error into something a person can act on (and never print the password). */
function explain(url, e) {
  const msg = (e && e.message) || String(e), code = e && e.code;
  let host = '';
  try { host = new URL(url).hostname; } catch (x) { /* not a web-style address at all */ }
  if (!url) return 'DATABASE_URL is not set.\nIn Railway: click this server service -> Variables -> New Variable -> Add Reference -> choose DATABASE_URL from your Postgres service. (Add it on the SERVER service, not on the database.)';
  if (url.includes('${{') || !/^postgres(ql)?:\/\//.test(url)) return 'DATABASE_URL is set, but it is not a database address (it starts with "' + url.slice(0, 12) + '...").\nThe reference probably did not resolve. In Railway: delete the DATABASE_URL variable on this service and add it again with Add Reference, picking DATABASE_URL from the Postgres service in the list.';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Cannot find the database server "' + host + '".\nThe Postgres service must be in the SAME Railway project and environment as this server. If it is, this usually clears by itself within a minute of a deploy.';
  if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || /timeout/i.test(msg)) return 'The database server "' + host + '" is not answering yet. Check the Postgres service is running (green) in Railway.';
  if (code === '28P01' || code === '28000') return 'The database refused the password. In Railway: delete the DATABASE_URL variable on this service and add it again with Add Reference.';
  if (code === '3D000') return 'The database named in DATABASE_URL does not exist. Re-add DATABASE_URL with Add Reference from the Postgres service.';
  return 'Database problem: ' + msg;
}

if (require.main === module) {
  const url = (process.env.DATABASE_URL || '').trim();
  const state = { problem: 'Connecting to the database...' };
  const usable = /^postgres(ql)?:\/\//.test(url) && !url.includes('${{');
  const pool = new Pool(usable ? { connectionString: url, connectionTimeoutMillis: 10000 } : { host: '127.0.0.1', port: 1, connectionTimeoutMillis: 1000 });
  pool.on('error', (e) => console.error('Database connection dropped (it will reconnect):', e.message));   // without this, a dropped connection would crash the server
  process.on('unhandledRejection', (e) => console.error('Unexpected error:', e && e.message ? e.message : e));
  const { app, init } = createApp(pool, state);
  app.listen(PORT, '0.0.0.0', () => console.log(`Bridge Quest duplicate server listening on port ${PORT}`));
  // Keep trying to reach the database.  The server answers /health with the reason while it waits.
  (async () => {
    let last = '';
    for (let attempt = 1; ; attempt++) {
      try {
        if (!usable) throw new Error('bad DATABASE_URL');
        await init();
        state.problem = null;
        console.log('Database ready. Everything is working.');
        return;
      } catch (e) {
        state.problem = explain(url, e);
        if (state.problem !== last || attempt % 12 === 0) console.error(`NOT READY (try ${attempt}): ${state.problem}`);
        last = state.problem;
        if (!usable) return;                        // nothing will change until the variable is fixed and the service redeploys
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  })();
}

module.exports = { createApp, explain };
