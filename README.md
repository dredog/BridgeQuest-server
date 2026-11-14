# Bridge Quest duplicate server

A small web service that lets everyone play the **same MiniBridge deals** and compares their results by **matchpoints**.
The Bridge Quest app (on GitHub Pages) talks to it; all results live in a Postgres database.

- `server.js` — the web service and database calls
- `lib.js` — the bridge part: dealing, scoring, matchpoints
- `test.js` — checks everything (`npm test`)

## Put it on Railway

1. Put this folder in a GitHub repository of its own (these files at the top level, not inside a sub-folder).
2. Railway → **New Project** → **Deploy from GitHub repo** → pick the repository.
3. In the project: **+ New** → **Database** → **Add PostgreSQL**.
4. Click the server service (not the database) → **Variables** → add a **reference** to `DATABASE_URL` from Postgres.
   - Optional: add a variable `ADMIN_KEY` with a word of your choosing. It unlocks the two teacher calls at the bottom.
5. Server service → **Settings** → **Networking** → **Generate Domain**.
6. Open `https://<that-domain>/health` — it should say `ok`.

The tables are created automatically the first time the server starts. Every push to the repository redeploys it.

## How boards are handed out

When a player asks for a board, the server gives them, in this order:

1. a board they started but never finished;
2. otherwise the board they have not played that has the **fewest results so far** (so every deal collects plays);
3. if they have played every board, a **new random deal** — which later players are then sent to as well.

Players do not play in any fixed order. Every random deal is turned so that **South (the human) holds the best hand**:
South has the most high-card points at the table and North–South have more than East–West, so South declares.

The first result a player sends for a board is the one that counts; a second try does not replace it.

## Matchpoints

On each board you get 1 point for every other player you beat and ½ for every one you tie.
The percentage is your points out of the most possible (players − 1). With only one player on a board there is no
percentage yet. Nothing is stored — matchpoints are worked out fresh on every request, so a player's old boards
update on their own as more people play them. The running tally is total matchpoints ÷ total possible.

Scores are MiniBridge scores from declarer's side, the same as the app: trick points + 300 for game or 50 for a
part score; minus 50 per trick when the contract goes down.

## The calls

Usernames are 1–20 letters and numbers, no password. `Max`, `max` and `MAX` are the same player.

| Call | Send | Get back |
|---|---|---|
| `GET /health` | — | `ok` |
| `POST /api/next` | `{ "user": "Max" }` | `{ board: { id, number, hands: {N,E,S,W}, dealer, plays }, resumed, created }` |
| `POST /api/result` | `{ "user": "Max", "boardId": 12, "contract": "3N", "tricks": 10 }` | `{ saved, you, results: [...], board, summary }` |
| `GET /api/board/12?user=Max` | — | everyone's results on that board (only after Max has played it) |
| `GET /api/player/Max` | — | `{ summary: { boards, compared, mp, top, pct }, boards: [...] }` — every board Max played, with current matchpoints |
| `GET /api/leaderboard` | — | all players ranked by percentage |

Cards are written suit then rank: `SA`, `HT`, `D4`, `C2`. Contracts are level then strain: `1N`, `2C`, `4S`.
`/api/player` and `/api/leaderboard` accept `?season=1` to look at an earlier set of boards.

### Teacher calls (need `ADMIN_KEY`; send it in an `X-Admin-Key` header)

| Call | What it does |
|---|---|
| `POST /api/admin/reset` | Starts a fresh season: new boards and a new leaderboard. Old seasons are kept. |
| `POST /api/admin/boards` with `{ "hands": {N:[…],E:[…],S:[…],W:[…]}, "game": "mini" }` | Adds a deal you chose yourself. Use `"game": "bridge"` for the full bridge game later. |

Example reset from a terminal:

    curl -X POST https://<your-domain>/api/admin/reset -H "X-Admin-Key: yourword"

## Run the checks on your own computer

    npm install
    DATABASE_URL=postgres://user:password@localhost:5432/postgres npm test

The test uses a scratch area of the database (`bq_test`) that it creates and removes, so it never touches real results.
Without `DATABASE_URL` it only checks the bridge logic.

## Not done on purpose

There are no passwords and no limits on who can post: anyone who knows the address and a username can send a result
under that name. That was the choice for now.
