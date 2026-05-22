# MSU Check Project

This workspace is the imported MSU check website project. Continue future work here instead of the old projectless Codex thread.

## Purpose

- Site name: 大锅菜查账专用网
- Public deployment: https://msu-check.vercel.app/
- GitHub remote: https://github.com/yoyobs/MSU-Check.git
- Main use case: read addresses from `data/address-book.xlsx`, then show NESO transfer history between listed MapleStory Universe addresses using Xangle MSU Explorer APIs.

## Current Behavior

- `public/index.html` is the single-page frontend.
- `server.js` serves the frontend and API endpoints.
- The left panel lists all people from `data/address-book.xlsx`.
- Clicking a person filters the right-side history to NESO transfers between that person and other people in the Excel list.
- The history refreshes automatically every 15 seconds.
- Sender names in history are red; receiver names are green.
- Amounts are formatted with thousands separators and trailing zero decimals removed.
- The app detects deployed version changes and shows a refresh prompt to active users.

## Commands

- Install dependencies: `npm install`
- Start locally: `npm start`
- Optional local port override: `$env:PORT='3002'; npm start`
- Syntax check: `node --check server.js`

## Files

- `server.js`: Node HTTP server, Explorer API integration, address book parsing, history scanning, API routes.
- `public/index.html`: all frontend HTML/CSS/JS.
- `data/address-book.xlsx`: user-maintained address list. Columns are nickname and address.
- `data/address-book.json`: generated/legacy address data kept in repo.
- `data/admin-password.txt`: ignored secret file. Do not commit.
- `一键更新.bat`: one-click git update helper for the user.
- `docs/msu-check-context.md`: human-readable import summary from the old conversation.
- `docs/imported-msu-check-thread-019e3410.jsonl`: raw backup of the old Codex thread.

## Notes For Future Work

- Prefer preserving the current simple Node + static HTML structure unless the user asks for a framework migration.
- Do not commit `node_modules` or `data/admin-password.txt`.
- When changing frontend behavior, run a local server and verify the page in the browser if possible.
- When pushing to GitHub from this Windows environment, the old thread used proxy flags:
  `git -c http.proxy=http://127.0.0.1:7890 -c https.proxy=http://127.0.0.1:7890 push origin main`
- The旧 working copy was `E:\个人项目文件\MSU查账网\https-msu-explorer-xangle-io`; this workspace is now the active copy.
