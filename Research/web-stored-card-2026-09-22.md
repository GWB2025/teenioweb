# Web stored-card recognition and single-slot writing — 22 September 2026

## Captured evidence

The user's saved `LUCAS-LEH_Er-_1_1.calcom-slot` identifies block 8, slot 49 on firmware 21. Its saved SHA-256 verifies:

`5f2a0289f994186eea66284a15044d1d374b6f468ea9b47c4a4fc4851ef8e4eb`

The exact 150-byte payload is retained in `Tests/Fixtures/HP97-stored-slot-8-49.bin` for regression checks. It starts with `61`, contains the title `LUCAS LEH_Er _1_1`, and has ten trailing `FF` bytes. The seven header nibbles are `2 2 2 0 0 0 3`. Its stored and calculated 28-bit card checksums both equal `0B63C9FB`.

Bytes 21–139, the entire header/program/checksum body, exactly match the decoded `Programs/Lucas-Lehmer-Extended-HP97-card-1.hpp`. The capture differs from that original only in the storage marker and five title characters. The existing web validator required marker `43`, causing the valid card to be labelled opaque. The title differences predate this fix and are preserved, not silently corrected. This evidence concerns slot 49; slot 50 was not captured or independently verified in this investigation.

Web v0.4.0 accepts `43` and the observed `61` variant while retaining title, header, padding and checksum checks. Other markers remain unsupported. HPP carries model 97, a title and card nibbles, but no storage marker. Export validates an HPP re-import against bytes 1–149 and the canonical reconstructed marker `43`. Export never mutates the original capture, whose exact bytes and SHA remain intact.

## Write sequence and backup requirements

The web writer follows the native [ProgramWriting.swift implementation](https://github.com/GWB2025/Teenio/blob/main/Sources/CalComMac/ProgramWriting.swift):

1. Send `04`, expect `04`, send `55`, expect `55`.
2. Send the selected block and BCD slot; expect `04`.
3. Send fifteen packets of `00` plus ten card bytes, each gated by one `04` acknowledgement.
4. After the last chunk acknowledgement, send commit `AA`, expect `04`, send finish `FF`, then require a final `04`.

Every write reply must contain exactly one expected acknowledgement. Unexpected/excess replies and `AE` errors stop the operation. The source's original address never overrides the selected destination. A copied source and fixed destination are used for the entire workflow.

Before any `04` request, command `03` reads the destination's exact 150 bytes and completion reply. The browser saves a `.calcom-slot` file through a user-selected file handle, closes it, reads it from disk and validates its hash, destination, Demo provenance and all original bytes. A download being initiated alone is insufficient proof of a saved backup. Cancellation, failure or changed connection stops before writing.

After a complete write handshake, a new command-03 read must match all 150 bytes. No retry or automatic restoration is attempted on failure. The backup remains available and the directory is invalidated when a write starts. A failed write may leave changed destination contents; the interface does not claim otherwise. Only valid program cards are writable; backups of vacant/unknown records can be saved but cannot be restored through this milestone's card-write control.

## Verification scope

All 29 web automated checks passed. Browser Demo confirmed review cancellation, copying slot 00 to slot 49 with backup and byte-for-byte read-back, and recognising/exporting the user's marker-61 capture. Updated entry points and changed modules use versioned URLs to avoid an older cached module causing an import error during upgrade. Help includes the new workflow and recovery limits.

Live browser writing and the browser's real file-permission prompt remain to be exercised together on hardware. The saved-capture check is physical-data validation, not a new live transfer. No physical calculator storage, active program or registers were changed during this development pass.
