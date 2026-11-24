# InkBoard

An infinite whiteboard (a Microsoft Whiteboard replacement) for pen, touch and mouse. It uses the
InkNotes pen tuning and can import Microsoft Whiteboard `.whiteboard` files.

Run locally: `node serve.js`, then open http://localhost:5180/

## What it does
- Pen (plain, galaxy, rainbow), highlighter, stroke eraser (also the pen's eraser button), sticky notes, text, images (button, paste, drop)
- Select: tap, Shift+tap, or lasso; drag to move, corner handle to resize, Duplicate/Delete, recolour
- Undo/redo, zoom (Ctrl+wheel, pinch, buttons), pan (fingers, middle/right mouse, Space, hand tool)
- Shapes (rectangle, ellipse, triangle, diamond, line, arrow; Shift keeps them square), and **ink to shape**
  (pen menu): circles, boxes, triangles, polygons and straight lines you draw become clean shapes
- Ruler and protractor: move with one finger/mouse, turn with two fingers or the wheel; the pen
  draws along their edges and the protractor shows the angle
- Backgrounds: plain, dots, grid, graph paper, and numbered x/y axes, in several colours
- Comments: pinned threads with replies, resolve, a list of all comments; emoji reactions on
  anything you select and on comments
- Boards save on the device (IndexedDB). Export PNG, or save/open `.inkboard` copies (images included)
- OneDrive sync with InkNotes' sign-in and passphrase (encrypted, in the app folder's `boards/`);
  edits from two devices merge item by item
- **Share live**: a 6-letter code (or link) lets others join without an account and draw, type,
  comment and react together, with names next to their cursors and strokes appearing as they're
  drawn. The room server is in `worker/` (Cloudflare Worker + Durable Objects, Yjs).
- Shortcuts: V select, P pen, H highlighter, E eraser, S shape, N note, T text, C comment,
  Ctrl+Z/Y, Ctrl+A/C/X/V/D, Del

## Live sharing
`app/js/collab.js` mirrors the board into a Yjs document; `worker/` keeps one room per code at
`wss://inkboard-rooms.tasklist.workers.dev`. Locally, the app on localhost/127.0.0.1 talks to
`npm run dev` in `worker/` (port 8790) instead. Rooms nobody opens for 45 days are deleted;
"Stop sharing" ends a room for everyone (they keep their copy). Pictures over ~700 KB aren't
sent live. On a school network the rooms address may need to be allowed (Lightspeed).

## Pen handling (from InkNotes)
Raw ink while writing; on lift, Gaussian smoothing along the line (1.8 px default on Windows, off on
Android); pressure smoothed, width 40–100% of size; one pointer owns a stroke; touch ignored for
600 ms after any pen activity; MPP light-pressure dropouts rejoined (not on Android). The canvas is
low-latency (`desynchronized`) and opaque, with the background painted inside it.

## .whiteboard import
See the comment at the top of `app/js/whiteboard-import.js` for the file layout. Today it imports
ink (all brushes and colours, with pressure) and the background colour. Other object types (notes,
text, shapes, images) are counted and reported as "not imported yet". To add one, make a small board
in Microsoft Whiteboard containing that object, then decode it with `whiteboardOutline()` to see
its schema GUIDs.

Test the importer against real files: `node test/import.test.mjs "path/to/Board.whiteboard"`
