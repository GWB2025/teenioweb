# Teenio Web

A browser-based companion for the TEENIX97 HP-97 calculator board, with Bluetooth connectivity, program backup and transfer, memory and register viewing, clock controls, and Demo mode.

[**▶ Launch Teenio Web**](https://gwb2025.github.io/teenioweb/)

Open the launch link in **desktop Chrome** on your Mac or Windows PC. The link becomes available after GitHub Pages has been enabled and the first deployment below has succeeded. GitHub's code preview shows files; the launch link opens the running application.

For private local use, [**launch the local copy**](http://localhost:8080/) after starting the server with the [local launch instructions](#run-locally). This option does not require GitHub Pages or a paid GitHub plan.

This is the standalone web project, extracted from [Teenio for Mac](https://github.com/GWB2025/Teenio) at web version **0.4.0**. The browser application is in `Web/`; no native Mac build is required. Development remains private while hardware verification continues.

## Enable the launch link on GitHub

**Hosting and privacy:** this repository is private. On 22 September 2026, its Pages settings displayed “Upgrade or make this repository public to enable Pages”. For a private repository owned by a personal account, GitHub Pages requires **GitHub Pro** (or an eligible Enterprise plan). Free accounts can use Pages with public repositories. Keep this repository private unless you deliberately decide to publish its source. See [GitHub Pages availability](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages).

**A normal GitHub Pages website is public even when its repository is private.** Publishing makes the app's HTML, JavaScript, styles and icons downloadable by visitors. It does not publish your local calculator captures or grant visitors access to your calculator. If the app itself must remain private during development, use the local launch instructions below and leave Pages disabled. See [GitHub's publishing and visibility guidance](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).

When ready to publish:

1. Commit and push the README, Pages workflow, packaging script and service-worker changes to `main`.
2. Open [Settings → Pages](https://github.com/GWB2025/teenioweb/settings/pages). If the upgrade notice is still shown, an eligible plan is needed to continue with this private repository.
3. Under **Build and deployment → Source**, select **GitHub Actions**. The workflow is already included; you do not need a Jekyll template or a `/docs` folder.
4. Open [Actions → Deploy Teenio Web to Pages](https://github.com/GWB2025/teenioweb/actions/workflows/pages.yml), choose **Run workflow**, select **main**, then choose **Run workflow** again.
5. Wait for both **Check and package** and **Publish website** to finish successfully. Then click **Launch Teenio Web** above, or **Visit site** in Settings → Pages.

Publishing is **manual**: ordinary commits and pushes run the existing checks but do not update the public website. To publish a later version, push it to `main` and run the Pages workflow again. The workflow tests the app before deployment and packages only its runtime files; calculator fixtures, program examples, research notes and repository history are excluded from the website. It uses GitHub's built-in workflow token; no SSH key or personal access token is added to the workflow.

The expected website address is **https://gwb2025.github.io/teenioweb/**. A 404 before the first successful deployment is expected. If deployment fails, open the failed step in Actions for its explanation. If GitHub blocks a deployment because of environment rules, allow `main` in **Settings → Environments → github-pages**.

## Connect from the hosted app

1. Open **Launch Teenio Web** in desktop Chrome. Demo mode works without a calculator.
2. Close any existing Teenio or CalCom connection to the calculator, including an older local browser tab.
3. Pair TEENIX97 in macOS or Windows Bluetooth settings, then choose **Connect to TEENIX97** in the app and select the board in Chrome's chooser.
4. Choose **Read settings** to verify HP-97 firmware 21 before using the other functions.

The hosted app communicates directly with your selected calculator through Chrome's Web Serial API. You grant access separately for the hosted website; a connection granted to `localhost` or a local file does not automatically transfer to it. You can install the hosted app using Chrome's installation control when available. Single-slot writing still requires choosing a destination backup file.

## Current functionality — v0.4.0

`Web/` contains the browser companion. It uses Chrome's Web Serial API to open the Serial Port Profile on a paired Bluetooth Classic TEENIX97. It provides an installable offline interface, live or Demo connection, the firmware-21 information/settings query, clock read and guarded time/date setting with read-back, and the complete 448-byte active-memory transfer. The memory view decodes all sixteen primary registers and all 224 program positions, and exports both the memory report and aligned program listing.

The Stored programs screen performs read-only 54-slot directory scans and individual 150-byte card reads. It saves and reopens the same SHA-256-checked `.calcom-slot` format as Teenio for Mac, imports and exports checksum-validated HP-97 `.hpp` cards, and includes Demo storage. Strict reply validation, activity-log export, Help and Tony Nixon acknowledgement are included.

Click any directory slot number or program name to update the Slot selector beside **Read selected slot**. Selection keeps the directory's scroll position, highlights the chosen entry and displays its block and slot. Changing the dropdown updates the same highlight. Selecting a destination does not replace the current source card.

**Card recognition:** a saved physical block-8/49 Lucas–Lehmer card uses storage marker `61` instead of `43`. Its checksum is valid and its entire program-card body matches the original first extended Lucas–Lehmer `.hpp` card. Both observed markers are now recognised; unknown markers, invalid titles, damaged checksums and invalid padding are rejected. `.calcom-slot` preserves all 150 original bytes. HPP export preserves the exact title and card body; HPP has no storage-marker field and re-imports with canonical marker `43`. See [the captured-card evidence](Research/web-stored-card-2026-09-22.md).

**Backed-up single-slot writing:** open or read a valid source card, select the destination block/slot, then choose **Write to selected slot…**. Review the source and destination and choose a new backup file. Teenio freshly reads the destination, saves its capture to disk, reopens and checks it, and only then starts writing. A separate slot read must match all 150 source bytes before success is reported. Live writes require desktop Chrome's file-saving API and verified HP-97 firmware 21. A cancelled or failed backup prevents writing. Source/destination controls stay locked throughout the workflow. Errors do not trigger an automatic retry or restore; retain the backup if writing has started, reconnect and inspect the destination. Scan the directory again after a live write. Stored-card writing does not load active program memory.

Demo writes use the same backup-validation and comparison workflow with temporary browser storage. The Demo backup stays in memory until **Save backup copy** is used, and direct writes of Demo captures to a real calculator are blocked. The latest destination backup remains available after an error or disconnect. A vacant or unrecognised backup remains saveable as an exact capture; this milestone only writes validated program cards and does not implement erasing/restoring an empty or unknown slot, automatic two-card uploading, or conversion of active RAM into card files.

**Web verification:** 30 automated checks pass, including the physical marker-61 capture and HPP round trip, exact write packet sequence, saved-backup validation, cancellation/save failure, disconnect during backup, frozen source, malformed acknowledgements, mismatched read-back and isolation of the offline cache from other Pages projects. Browser Demo checks covered cancelling a write review, writing a source from slot 00 to vacant slot 49, checking the backup and read-back result, and opening/exporting the saved physical Lucas–Lehmer capture. The writer follows the native app's hardware-tested command-04 exchange, but a physical upload through this web implementation has **not yet been verified**. No physical calculator slot was changed during these web checks.

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
