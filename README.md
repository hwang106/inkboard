# InkBoard

An infinite whiteboard (a Microsoft Whiteboard replacement) for pen, touch and mouse. It uses the
InkNotes pen tuning and can import Microsoft Whiteboard `.whiteboard` files.

Run locally: `node serve.js`, then open http://localhost:5180/

## What it does
- Pen (plain, galaxy, rainbow), highlighter, stroke eraser (also the pen's eraser button), sticky notes, text, images (button, paste, drop)
- Select: tap, Shift+tap, or lasso; drag to move, corner handle to resize, Duplicate/Delete, recolour
- Undo/redo, zoom (Ctrl+wheel, pinch, buttons), pan (fingers, middle/right mouse, Space, hand tool)
- Plain/dots/grid backgrounds in several colours
- Boards save on the device (IndexedDB). Export PNG, or save/open `.inkboard` copies (images included)
- Shortcuts: V select, P pen, H highlighter, E eraser, N note, T text, Ctrl+Z/Y, Ctrl+A/C/X/V/D, Del

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
