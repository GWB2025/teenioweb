# Teenio Web

A browser-based companion for the TEENIX97 HP-97 calculator board, with Bluetooth connectivity, program backup and transfer, memory and register viewing, clock controls, and Demo mode.

[**▶ Launch Teenio Web**](https://gwb2025.github.io/teenioweb/)

Open the launch link in **desktop Chrome** on your Mac or Windows PC. The hosted app is available now. GitHub's code preview shows files; the launch link opens the running application.

For private local use, [**launch the local copy**](http://localhost:8080/) after starting the server with the [local launch instructions](#run-locally). This option does not require GitHub Pages or a paid GitHub plan.

This is the standalone web project, extracted from [Teenio for Mac](https://github.com/GWB2025/Teenio) at web version **0.4.0**. The browser application is in `Web/`; no native Mac build is required. The repository and GitHub Pages app are now public; hardware verification continues.

## Publish an update on GitHub

GitHub Pages is enabled with **GitHub Actions** as its source. The site is live at [gwb2025.github.io/teenioweb](https://gwb2025.github.io/teenioweb/).

1. Commit and push the new version to `main`.
2. Open [Actions → Deploy Teenio Web to Pages](https://github.com/GWB2025/teenioweb/actions/workflows/pages.yml), choose **Run workflow**, select **main**, then choose **Run workflow** again.
3. Wait for both **Check and package** and **Publish website** to succeed.
4. Finish any calculator transfer and disconnect before refreshing the hosted app. Reopen or refresh it and check the version in the sidebar before reconnecting.

Publishing is **manual**: ordinary commits and pushes run the checks but do not update the website. The workflow tests the app and packages only runtime files, excluding calculator fixtures, program examples and research notes from the website. Those tracked files remain visible in the public source repository. The app handles calculator captures in your browser and does not upload them to a server.

If deployment fails, open the failed step in Actions for its explanation. Pages configuration is under [Settings → Pages](https://github.com/GWB2025/teenioweb/settings/pages); keep **Build and deployment → Source** set to **GitHub Actions**. No additional workflow template is needed.

## Connect from the hosted app

1. Open **Launch Teenio Web** in desktop Chrome. Demo mode works without a calculator.
2. Close any existing Teenio or CalCom connection to the calculator, including an older local browser tab.
3. Pair TEENIX97 in macOS or Windows Bluetooth settings, then choose **Connect to TEENIX97** in the app and select the board in Chrome's chooser.
4. Choose **Read settings** to verify HP-97 firmware 21 before using the other functions.

The hosted app communicates directly with your selected calculator through Chrome's Web Serial API. You grant access separately for the hosted website; a connection granted to `localhost` or a local file does not automatically transfer to it. You can install the hosted app using Chrome's installation control when available. Single-slot writing still requires choosing a destination backup file.

## Current functionality — v0.5.0

`Web/` contains the browser companion. It uses Chrome's Web Serial API to open the Serial Port Profile on a paired Bluetooth Classic TEENIX97. It provides an installable offline interface, live or Demo connection, the firmware-21 information/settings query, clock read and guarded time/date setting with read-back, and the complete 448-byte active-memory transfer. The memory view decodes all sixteen primary registers and all 224 program positions, and exports both the memory report and aligned program listing.

**Reopen saved memory:** in **Memory & registers**, choose **Open memory capture…** for a memory text report saved by Teenio Web or Teenio for Mac. The original capture time and Demo provenance are retained. All 64 consecutive RAM rows, hexadecimal bytes and metadata are validated; displayed values and instructions are recomputed from RAM. Text reports do not have a checksum. An invalid file leaves the previous memory view intact. This works while disconnected and sends no calculator commands.

**Export a full program as two HPP cards:**

1. Read current memory or open a saved memory capture.
2. In **Stored programs**, read or open an existing valid program card. Its display/trigonometry settings and flags will be used as the template; its program instructions will not be copied. A vacant slot is not a template.
3. Return to **Memory & registers**, enter a program name of up to 13 ASCII characters, and choose **Prepare two cards**.
4. Save **card 1 of 2** and **card 2 of 2** separately. Keep them together and load card 1 before card 2. The first contains positions 001–112 and the second 113–224. Both cards are always produced, preserving trailing R/S instructions.

The conversion uses the native app's card layout, verifies every program byte, checks each card checksum, and reopens both HPP exports to compare their exact contents. Numeric registers are not included in program cards; retain the full memory report to preserve them. Changing the memory capture, card template or name invalidates the prepared exports. If either source is Demo data, the export labels and filenames say DEMO; HPP itself does not store provenance. Preparing and saving cards does not upload them or modify calculator memory.

The Stored programs screen performs read-only 54-slot directory scans and individual 150-byte card reads. It saves and reopens the same SHA-256-checked `.calcom-slot` format as Teenio for Mac, imports and exports checksum-validated HP-97 `.hpp` cards, and includes Demo storage. Strict reply validation, activity-log export, Help and Tony Nixon acknowledgement are included.

Click any directory slot number or program name to update the Slot selector beside **Read selected slot**. Selection keeps the directory's scroll position, highlights the chosen entry and displays its block and slot. Changing the dropdown updates the same highlight. Selecting a destination does not replace the current source card.

**Card recognition:** a saved physical block-8/49 Lucas–Lehmer card uses storage marker `61` instead of `43`. Its checksum is valid and its entire program-card body matches the original first extended Lucas–Lehmer `.hpp` card. Both observed markers are now recognised; unknown markers, invalid titles, damaged checksums and invalid padding are rejected. `.calcom-slot` preserves all 150 original bytes. HPP export preserves the exact title and card body; HPP has no storage-marker field and re-imports with canonical marker `43`. See [the captured-card evidence](Research/web-stored-card-2026-09-22.md).

**Backed-up single-slot writing:** open or read a valid source card, select the destination block/slot, then choose **Write to selected slot…**. Review the source and destination and choose a new backup file. Teenio freshly reads the destination, saves its capture to disk, reopens and checks it, and only then starts writing. A separate slot read must match all 150 source bytes before success is reported. Live writes require desktop Chrome's file-saving API and verified HP-97 firmware 21. A cancelled or failed backup prevents writing. Source/destination controls stay locked throughout the workflow. Errors do not trigger an automatic retry or restore; retain the backup if writing has started, reconnect and inspect the destination. Scan the directory again after a live write. Stored-card writing does not load active program memory.

Demo writes use the same backup-validation and comparison workflow with temporary browser storage. The Demo backup stays in memory until **Save backup copy** is used, and direct writes of Demo captures to a real calculator are blocked. The latest destination backup remains available after an error or disconnect. A vacant or unrecognised backup remains saveable as an exact capture; this milestone only writes validated program cards and does not implement erasing/restoring an empty or unknown slot, automatic two-card uploading, or verification that a stored program has subsequently been loaded into active RAM.

**Web verification:** 39 automated checks pass, including the physical marker-61 capture and HPP round trip, exact write packet sequence, saved-backup validation, cancellation/save failure, disconnect during backup, frozen source, malformed acknowledgements, mismatched read-back and isolation of the offline cache from other Pages projects. Browser Demo checks covered cancelling a write review, writing a source from slot 00 to vacant slot 49, checking the backup and read-back result, and opening/exporting the saved physical Lucas–Lehmer capture. The writer follows the native app's hardware-tested command-04 exchange, but a physical upload through this web implementation has **not yet been verified**. No physical calculator slot was changed during these web checks.

**23 September 2026 verification:** the hosted v0.4.0 session showed verified HP-97 firmware 21, a successful clock read and a complete 448-byte active-memory transfer. Version 0.5.0 adds nine automated checks for memory report import and card preparation. Tests reproduce an independently captured physical card body and both original extended Lucas–Lehmer HPP bodies, preserve all 224 positions, exclude numeric registers, reject malformed captures/templates, and retain Demo provenance. Separate browser checks cover Demo preparation, both downloaded files, native memory-report import, source-change invalidation and rejection without losing the previous capture. The newly exported pair still needs a physical load/run check; no write or clock change was made on the connected calculator during this development work.

## Run locally

In Terminal, start the server from this repository:

```sh
cd /Users/gordonbrindle/Downloads/teenioweb
./scripts/serve-web.sh
```

If you cloned the repository somewhere else, use that folder in the `cd` command. Leave this Terminal window running and click [Launch the local copy](http://localhost:8080/) in desktop Chrome. Stop the server with Control-C when finished. Pair TEENIX97 in the operating system first. Chrome requires the user to choose the serial device when **Connect to TEENIX97** is pressed; the page cannot silently acquire a Bluetooth device. Demo mode can be used in any modern browser. Run the web protocol checks with `cd Web && npm test`.

## Development

Serve `Web/` using the supplied script (Python 3 required). The browser application has no build step or third-party runtime dependencies. The existing script uses port 8080; stop another server on that port before starting this checkout.

Run the automated tests with Node.js 22 or later:

```sh
npm --prefix Web test
```

GitHub Actions runs these checks on each push and pull request. `Tests/Fixtures/` contains the small regression captures required by the tests; `Programs/` includes the Lucas–Lehmer sample cards, listings and generators. See [the program notes](Programs/README.md) and [the clock protocol notes](Research/HP97-clock-protocol.md).

To prepare the same static website artifact used by Pages, run `node scripts/build-pages.mjs`. This creates the generated `_site/` directory. All app URLs are relative so the site works under the `/teenioweb/` project path. The offline cache is scoped to this app's URL, preserving caches belonging to other projects on the same GitHub Pages domain.

## Acknowledgements

Teenio acknowledges Tony Nixon (TeenNix), creator of the TEENIX97 replacement board and original CalCom application and documentation. This repository contains the independently developed browser companion, not the original Windows executable or board firmware.
