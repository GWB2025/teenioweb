# Teenio Web

A browser-based companion for the TEENIX97 HP-97 calculator board, with Bluetooth connectivity, program backup and transfer, memory and register viewing, clock controls, and Demo mode.

This is the standalone web project, extracted from [Teenio for Mac](https://github.com/GWB2025/Teenio) at web version **0.4.0**. The browser application is in `Web/`; no native Mac build is required. Development remains private while hardware verification continues.

## Current functionality — v0.4.0

`Web/` contains the browser companion. It uses Chrome's Web Serial API to open the Serial Port Profile on a paired Bluetooth Classic TEENIX97. It provides an installable offline interface, live or Demo connection, the firmware-21 information/settings query, clock read and guarded time/date setting with read-back, and the complete 448-byte active-memory transfer. The memory view decodes all sixteen primary registers and all 224 program positions, and exports both the memory report and aligned program listing.

The Stored programs screen performs read-only 54-slot directory scans and individual 150-byte card reads. It saves and reopens the same SHA-256-checked `.calcom-slot` format as Teenio for Mac, imports and exports checksum-validated HP-97 `.hpp` cards, and includes Demo storage. Strict reply validation, activity-log export, Help and Tony Nixon acknowledgement are included.

Click any directory slot number or program name to update the Slot selector beside **Read selected slot**. Selection keeps the directory's scroll position, highlights the chosen entry and displays its block and slot. Changing the dropdown updates the same highlight. Selecting a destination does not replace the current source card.

**Card recognition:** a saved physical block-8/49 Lucas–Lehmer card uses storage marker `61` instead of `43`. Its checksum is valid and its entire program-card body matches the original first extended Lucas–Lehmer `.hpp` card. Both observed markers are now recognised; unknown markers, invalid titles, damaged checksums and invalid padding are rejected. `.calcom-slot` preserves all 150 original bytes. HPP export preserves the exact title and card body; HPP has no storage-marker field and re-imports with canonical marker `43`. See [the captured-card evidence](Research/web-stored-card-2026-09-22.md).

**Backed-up single-slot writing:** open or read a valid source card, select the destination block/slot, then choose **Write to selected slot…**. Review the source and destination and choose a new backup file. Teenio freshly reads the destination, saves its capture to disk, reopens and checks it, and only then starts writing. A separate slot read must match all 150 source bytes before success is reported. Live writes require desktop Chrome's file-saving API and verified HP-97 firmware 21. A cancelled or failed backup prevents writing. Source/destination controls stay locked throughout the workflow. Errors do not trigger an automatic retry or restore; retain the backup if writing has started, reconnect and inspect the destination. Scan the directory again after a live write. Stored-card writing does not load active program memory.

Demo writes use the same backup-validation and comparison workflow with temporary browser storage. The Demo backup stays in memory until **Save backup copy** is used, and direct writes of Demo captures to a real calculator are blocked. The latest destination backup remains available after an error or disconnect. A vacant or unrecognised backup remains saveable as an exact capture; this milestone only writes validated program cards and does not implement erasing/restoring an empty or unknown slot, automatic two-card uploading, or conversion of active RAM into card files.

**Web verification:** 29 automated checks pass, including the physical marker-61 capture and HPP round trip, exact write packet sequence, saved-backup validation, cancellation/save failure, disconnect during backup, frozen source, malformed acknowledgements and mismatched read-back. Browser Demo checks covered cancelling a write review, writing a source from slot 00 to vacant slot 49, checking the backup and read-back result, and opening/exporting the saved physical Lucas–Lehmer capture. The writer follows the native app's hardware-tested command-04 exchange, but a physical upload through this web implementation has **not yet been verified**. No physical calculator slot was changed during these web checks.

Run it locally with:

```sh
./scripts/serve-web.sh
```

Then open `http://localhost:8080` in Chrome 117 or later. Pair TEENIX97 in the operating system first. Chrome requires the user to choose the serial device when **Connect to TEENIX97** is pressed; the page cannot silently acquire a Bluetooth device. Demo mode can be used in any modern browser. Run the web protocol checks with `cd Web && npm test`.

## Development

Serve `Web/` using the supplied script (Python 3 required). The browser application has no build step or third-party runtime dependencies. The existing script uses port 8080; stop another server on that port before starting this checkout.

Run the automated tests with Node.js 22 or later:

```sh
npm --prefix Web test
```

GitHub Actions runs these checks on each push and pull request. `Tests/Fixtures/` contains the small regression captures required by the tests; `Programs/` includes the Lucas–Lehmer sample cards, listings and generators. See [the program notes](Programs/README.md) and [the clock protocol notes](Research/HP97-clock-protocol.md).

## Acknowledgements

Teenio acknowledges Tony Nixon (TeenNix), creator of the TEENIX97 replacement board and original CalCom application and documentation. This repository contains the independently developed browser companion, not the original Windows executable or board firmware.
