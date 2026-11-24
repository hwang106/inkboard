# InkBoard rooms

Live collaboration server for InkBoard: one Durable Object per share code, holding the board as a
Yjs document in its SQLite storage and relaying edits, cursors/names (Yjs awareness) and
in-progress strokes. No accounts; only pages from the origins in `ALLOWED_ORIGINS` can connect.

    npm install
    npm run dev        # local server on ws://127.0.0.1:8790 (the app uses it on localhost)
    npm test           # two-plus clients against the local server (ROOMS=wss://... for the live one)
    npm run deploy     # npx wrangler deploy (needs `npx wrangler login` once)
    npm run vendor     # rebuild ../app/vendor/yjs.mjs after changing Yjs versions

Live at https://inkboard-rooms.tasklist.workers.dev. Messages: 0 sync, 1 awareness, 2 relay
(live stroke, passed through), 3 synced. Storage merges updates into rows under 800 KB so a
newcomer's first load arrives as several messages. Idle rooms are deleted after 45 days.
