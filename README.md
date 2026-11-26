# Paper Trader: stock and crypto practice trading

A browser app that follows crypto and US stocks with real market prices and **pretend money only**. A chain of connected automation cards decides what to do, and a virtual ledger records every simulated trade, hold, rejection and failure.

No real-money orders, deposits, withdrawals, wallets, leverage or real-trading switch exist anywhere in the code.

## Start it (free, no installs beyond what you likely have)

You need the whole folder, not only `index.html`.

**Option A, on a computer (recommended):**
1. Open a terminal in this folder.
2. Run `node tools/serve.js` (Node.js 18 or newer), or `python3 -m http.server 8080` if you have Python instead.
3. Open http://localhost:8080 in Chrome, Edge or Firefox.

**Option B, quickest:** double-click `index.html`. It opens from the file. Most features work this way, but some browsers limit saving or network access for files opened like this, so prefer Option A.

**Option C, on your phone (Samsung Galaxy S25):** the phone needs the app at a web address. A free way is GitHub Pages: put this folder in a **public** GitHub repository, then Settings → Pages → "Deploy from a branch" → `main` / root. The address will be `https://<your-github-name>.github.io/<repo-name>/`. Free GitHub accounts can only use Pages on public repositories, so the code (not your data) is public. Your trades and settings stay in your phone's browser.

### Stock prices: one free key
Crypto prices need nothing. For stocks, create a free Finnhub account (email only, no card) at https://finnhub.io, copy the key, and paste it in **Results & Settings → Data connections**. Without a key, stocks show "Unavailable" and are never traded.

## The screens
- **Dashboard**: virtual cash, current investments, total value, realized and unrealized profit or loss, simulated fees and slippage, performance chart, positions, and what the automation is doing.
- **Markets**: one watchlist for crypto and stocks. Add or remove assets. Each price shows its source, market time, fetch time and status (Current, Delayed, Stale, Unavailable, or Market closed). US market hours and holidays through 2027 are built in.
- **Cards**: the eight connected cards and their wires, drawn in the exact order they run. Tap a card to edit its name, purpose, instructions, settings and on/off state, or to Test, Duplicate or Remove it. Tap a wire (or "Inspect") to see what passed through it on the last run. The Connections form wires cards without dragging. Loops, wires into the Trigger, and anything that would let a trade skip the Rules Check are refused.
- **Journal**: every simulated buy and sell, hold, rejected proposal, failed run and outcome review, in plain language, with run ID and strategy version. CSV export.
- **Results & Settings**: performance with definitions, suggested changes to accept or reject, strategy versions, recent runs, account reset, simulated fees and slippage, data connections, AI Mode, backups, and storage notes.

## How the cards work
1. **Trigger**: starts a run on Run Once or when the schedule is due (default every 15 minutes).
2. **Market Watch**: fetches prices, attaches stored history and the virtual portfolio, and lists missing or stale data.
3. **Analyze**: compares a short and a long moving average for each asset. It proposes buy, sell or hold with evidence, uncertainty and what would prove it wrong. It holds when data is missing.
4. **Challenge**: objects to weak evidence (too few observations), high volatility, too much invested, delayed data, or a latest move against the idea. A block stops the trade.
5. **Practice Decision**: combines analysis and challenge, applies stop loss and take profit (take profit sells part of the position), sizes orders as a share of cash, and holds when unsure.
6. **Rules Check**: fixed application code checks price age, market hours, order size, free cash after a reserve and other approvals in the same run, position size, crypto or stock concentration, daily and total loss limits, a cooldown per asset, and holdings before a sale. It issues approvals that only exist inside the run, so nothing else can create one.
7. **Paper Ledger**: fetches a **new** price after approval, applies slippage and fees, and saves the fill and the cash update together in one save. It refuses duplicates, negative cash, overselling and borrowing.
8. **Outcome Review**: after a set time (default 4 hours) compares each earlier decision with a price observed later. It suggests setting changes that you accept or reject. It never changes the strategy by itself.

Every run has an ID, start and end times, the strategy version and a fingerprint of each card's instructions and settings. Any change to cards, instructions, settings or wires saves a new strategy version. You can switch back to an older version.

## AI Mode and Rules Mode
**AI Mode is unavailable unless you connect a local model.** By default every card runs in **Rules Mode**: fixed code using moving averages and limits. Its explanations are built from the numbers. They are not AI reasoning.

To try AI Mode for free on a computer you already have:
1. Install Ollama from https://ollama.com.
2. Run `ollama pull llama3.2:3b`.
3. Open the app from that same computer (Option A) and press **Save and test connection** under Results & Settings → AI Mode.

Only after a real test succeeds can the Analyze and Challenge cards switch to AI Mode. Their instructions are then sent to the model as text, and never run as code. The model's answer must be valid JSON with only the supplied assets and the actions buy, sell or hold. It cannot set prices, quantities or sizes. A bad answer fails the card and nothing is traded. The Rules Check still applies. AI Mode was tested here only with simulated model replies, not with a real model. Phone browsers cannot run it.

## Data sources and limits (checked November 2026)
| Source | Used for | Free limit | Key |
|---|---|---|---|
| Coinbase Exchange public API | Crypto prices and hourly history | 10 requests per second per IP | None |
| CoinGecko keyless API | Backup crypto price | About 5 calls per minute, varies | None |
| Finnhub free plan | US stock prices | 60 calls per minute | Free, email sign-up |

The app stays under these limits and backs off for 2 minutes after a "too many requests" reply. Status always comes from the market timestamp each source reports, so delayed prices show as Delayed and are not assumed to be real time. Some reviews of Finnhub's free plan say stock quotes may be delayed. If a source fails, the asset shows Unavailable with the reason, new trades for it stop, and no price is ever made up.

Stock history builds up from the app's own observations (one per run), so stocks need about 20 runs during market hours before the starter strategy can trade them. Crypto gets 300 hours of hourly history from Coinbase right away.

Historical replay (backtesting) is **not** in this version. All results are forward paper trading.

## Saving, backups and background running
- Everything is saved in this browser (IndexedDB) on this device: cards, wires, instructions, settings, watchlist, portfolio, journal, runs and strategy versions. There is no cloud sync. Clearing site data or using private mode loses it, so export backups.
- **Export full backup (JSON)** saves everything. Your Finnhub key is left out unless you tick the box. **Import** checks the file completely first (structure, workflow, and that cash and holdings match the recorded fills) and asks before replacing anything. **Export trades (CSV)** is for spreadsheets.
- Resetting the account asks for confirmation first.
- **Automation runs only while the page is open.** Background tabs are slowed, and a sleeping phone stops completely. Missed runs are not made up later. For steadier running, keep the page open on a computer you already own, plugged in, with sleep turned off.

## Not modeled
Stock splits, dividends and other corporate actions; crypto network fees; order book depth and partial fills; extended-hours stock trading; taxes. If a held stock splits, its value will be wrong until you reset the account.

## Tests
- `node --test tests/core.test.js`: 25 tests of the accounting, rules, engine, AI-output validation and backups, using simulated market replies.
- `node tools/serve.js 8765` and then `NODE_PATH=$(npm root -g) node tests/browser.e2e.js` (needs Playwright and Chrome): 13 checks in a real browser at the Galaxy S25 size (384×832) and on desktop. They cover the run, wire inspection, card editing, loop refusal, saving after reload, backup export, reset, refusal of a tampered backup, restore, CSV, feed failure and the AI-unavailable label.

## Files
`index.html`, `styles.css`, `src/core.js` (engine, cards, ledger, rules, metrics, backups), `src/data.js` (market data), `src/ai.js` (optional local model), `src/store.js` (browser storage), `src/app.js` (screens), `tools/serve.js` (local server), `tests/`.
