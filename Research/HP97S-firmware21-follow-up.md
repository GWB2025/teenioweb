# HP-97S follow-up: Windows logs and firmware 21

23 September 2026. This supplements the supplied
[protocol investigation](TEENIX97-HP97S-Protocol.md), which is preserved unchanged.
It separates observed traffic from static firmware interpretation. No live
calculator commands were sent during this investigation.

## Observed Windows session

The user supplied `Teenio-Web-activity.log (1).txt` and `Teenio-HP97S.log.txt`.
The activity log records:

| Time | Result |
| --- | --- |
| 20:50:21 | Settings query `07` returned `55 61 DD 91 21 05 11 00`: HP-97, firmware 21. |
| 20:50:27 | Clock read succeeded, initially showing 1 January 2000 at midnight. |
| 20:50:35 | Clock write was acknowledged, then read back as 23 September 2026 at 20:50:31. |
| 20:50:38 | Clock read back as 20:50:33, confirming it was advancing. |
| 20:50:48 | All 448 RAM bytes were received and decoded into sixteen registers and 224 program positions. |
| 20:51:03 | Block 0 directory completed: 31 occupied and 23 vacant slots. |
| 20:51:44–45 | HP-97S entry sent `12`, received `F5`, and stopped. |

No status query, transfer request or key code followed the failed HP-97S entry.
The user confirmed that they had enabled **97S in the calculator's own menu**
before pressing Teenio's interface-on control for this attempt.

This establishes recovery of the normal Windows functions. It does not establish
why the earlier, separate zero-byte settings timeouts occurred. The user had
said 97S was not enabled before those earlier timeouts.

## Evidence inputs

These original files were inspected locally and are not included in this repository:

| File | SHA-256 |
| --- | --- |
| `CalCom.exe` | `277f5d6435996d40d8d737ef72fda794750d2ccdf3e914f26c3d7d4d506abef7` |
| `HPF9721.hex` | `9b6b133ce721c18ae48af6660caf67fe24a06d5881091fc8e8ca9fc1c4174a42` |

Intel HEX records were decoded with their checksums validated. Firmware addresses
below are **byte addresses**, with little-endian PIC18 instruction words.
Instruction interpretation follows Microchip's
[PIC18 instruction reference](https://onlinedocs.microchip.com/oxy/GUID-6449C1CD-8855-4812-B64E-314070F3DA22-en-US-5/GUID-A411F567-0108-419A-8C3C-EC1AE1EFB684.html).
The board reported version 21; the installed firmware image has not been dumped
and compared byte-for-byte with this supplied HEX file.

## F5 at mode entry is not successful ON

CalCom's shared on/off response handler maps:

| Reply | CalCom string | Handler branch |
| --- | --- | --- |
| `FF` | `ACK: 97S = ON` | `0068AB2A` |
| `F5` | `ACK: 97S = OFF` | `0068AB74` |
| `00` | Cannot activate 97S; ensure RUN mode | `0068ABBE` |

Those labels alone do not establish the board's state after a rejected command.
In the supplied firmware, the normal PC dispatcher checks the active 97S flag
**before dispatching command 12**:

```text
0A06 B051       BTFSC 0x51,0       ; skip the branch if active bit is clear
0A08 D044       BRA   0A92
...
0A92 0EF5       MOVLW F5
0A94 EC43 F046  CALL  8C86         ; serial reply
```

With that flag already set, the PC command is rejected with `F5`; this path does
not clear the flag. With the flag clear, command `12` reaches `AF38`, sets bit 4
of register `04` to select the PC path, calls the enable helper at `A258`, and
returns `FF` at `AF48` on successful activation (or `00` at `AF54` on rejection).

The separate PC-mode exit path at `A1B8` checks the PC-path flag and an incoming
`F5`, replies `F5` at `A1C4`, then clears the mode flags through `A29A`.
Therefore an unsolicited or mode-entry `F5` must not be treated as proof of a
successful exit, and sending a guessed `F5` does not reliably recover the
external-equipment mode.

**Interpretation:** the user's calculator-menu selection and observed `12 → F5`
are consistent with the firmware's already-active-mode guard. Teenio's PC test
path should start with the calculator in RUN and its own 97S menu setting off.
Normal Bluetooth ConnEct mode is still needed. Teenio then requests the PC mode
itself with `12`.

Teenio v0.7.1 explains this response, sends no follow-up command, and retains its
recovery lock. Recovery is: disconnect, leave calculator-menu 97S off, restart
the calculator, restore Bluetooth connection mode, acknowledge recovery in
Teenio, reconnect and read settings, then enable the interface in Teenio.
At that stage, successful live entry, status and key transfer still needed verification.

## Second Windows session: entry succeeds, status fails

The next supplied logs were `Teenio-HP97S.log (1).txt` and
`Teenio-Web-activity.log (1) (1).txt`:

| Time | Observed exchange |
| --- | --- |
| 21:04:51 | `07` received `55 61 DD 91 21 05 11 00`; settings verified firmware 21. |
| 21:04:55–56 | Clock read succeeded, showing 23 September 2026 at 21:04:51. |
| 21:05:00 | `12 → FF`: HP-97S entry was acknowledged. |
| 21:05:20–21 | `F0 → F5`: status was rejected; the app stopped. |

The user confirmed that no equipment was connected to the isolated external
serial connector. None is required for the PC dummy-controller path. The second
failure cannot be explained just by the earlier calculator-menu mistake: this
time entry received the expected acknowledgement. No `F1` transfer request, key
code or `F5` exit command was sent. The 20-second gap does not itself establish
an idle timeout.

### Internal serial routing

Inspection of the same HEX image identifies different routing for normal commands
and the HP-97S PC test. Microchip's
[PIC18(L)F65/66K40 datasheet, DS40001842](https://ww1.microchip.com/downloads/aemDocuments/documents/MCU08/ProductDocuments/DataSheets/PIC18%28L%29F65-66K40-Data-Sheet-DS40001842.pdf)
maps the relevant hardware registers as follows:

| Serial channel | Receive register | Transmit register |
| --- | --- | --- |
| EUSART3 | `0EEA` / RC3REG | `0EEB` / TX3REG |
| EUSART4 | `0EE3` / RC4REG | `0EE4` / TX4REG |
| EUSART5 | `0EDC` / RC5REG | `0EDD` / TX5REG |

The normal receive routine at `5AB4` tests register `00`, bit 2 to select channel
3 or 5. On the channel-3 branch, `5ABE` checks the PC-test flag (`04`, bit 4)
and skips normal dispatch if set, leaving the byte for the HP-97S handler.
On the channel-5 branch at `5ACA`, there is **no corresponding PC-test flag
check**: it reads RC5REG at `5AD0` and jumps to normal dispatch at `0A00`.
Normal dispatch returns `F5` when the 97S-active flag is set, as described above.

Normal replies at `8C86` use the same channel selector to choose TX3REG or TX5REG.
This allows an entry request on either normal PC path to receive `FF`.

In contrast, the HP-97S receive helper at `A2BC` uses the PC-test flag to choose
between **channel 3 for the PC test** (`A2CC–A2D2`) and **channel 4 for external
equipment** (`A2C2–A2C8`). The HP-97S send helper at `A2FE` likewise writes TX3REG
when PC test is selected, otherwise TX4REG. These helpers do not select channel 5.

**Inference:** the reported Bluetooth `12 → FF`, then `F0 → F5` matches the
channel-5 path continuing to feed the normal command dispatcher after mode entry,
while the HP-97S handler is listening on channel 3. This strongly suggests that
this firmware's PC test path is tied to the wired FTDI connection rather than
Bluetooth. The mode-entry acknowledgement alone does not prove that later
Bluetooth HP-97S exchanges work. The installed image has still not been compared
byte-for-byte with the inspected HEX, nor has a wired live test been performed.

This corrects the earlier assumption that the PC test would work over every
normal PC transport. `CPU_97.pdf` page 25 documents the isolated connector, and
`CalComHelp.pdf` page 15 documents the dummy controller, but neither explicitly
establishes that this firmware supports the dummy controller over Bluetooth.

Teenio v0.7.1 now gives a distinct diagnostic for `F5` during a status query after
acknowledged entry. It retains the recovery lock, never treats `F5` as flags or a
confirmed exit, and sends no follow-up keys, retries or guessed reset commands.
It does not silently change baud rate or select another port. The current device
chooser only offers Bluetooth SPP devices; USB/FTDI support is not implemented.

Next independent checks: compare **On/Off → Read Status** in Windows CalCom over
the same Bluetooth connection after restarting the calculator, or ask Tony
whether firmware 21's PC test path is intended to use the wired connection only.
A CalCom success would require revisiting the wire sequence/routing assumptions;
a matching failure would strengthen the firmware/transport explanation. Do not
send digits for this comparison. Successful live status, key entry and confirmed
mode exit remain unverified.

## Run A can terminate the transfer immediately

Section 6 of the original investigation describes waiting for another prompt
after Run A and then sending NOP. The supplied firmware instead terminates on
either NOP (`0F`) or Run A (`0D`):

```text
A206 0A0F       XORLW 0F
A208 B4D8       BTFSC STATUS,Z
A20A D00F       BRA   A22A         ; NOP finishes
...
A218 5007       MOVF  07,W
A21A 0A0D       XORLW 0D
A21C B4D8       BTFSC STATUS,Z
A21E D005       BRA   A22A         ; Run A also finishes
...
A224 0EF1       MOVLW F1          ; ordinary key requests the next symbol
...
A230 0EA0       MOVLW A0          ; transfer accepted
```

CalCom's digit-response state likewise checks for `F1` at `0068AF5A` to send the
next symbol, or `A0` at `0068AFE8` to stop and reset the exchange.

Teenio v0.7.1 accepts immediate `A0` **only after the final Run A or NOP**.
After Run A's `A0` it sends nothing more. If Run A instead receives a next-symbol
prompt `F1`, it sends the pending NOP and still requires `A0`. An early `A0`
after an ordinary digit remains an error, preventing partial entries from being
reported as complete. Run A must remain the last actionable key. The conservative
nine-key limit is unchanged. Demo now models firmware 21's immediate completion.

## Verification and remaining limits

Automated checks reproduce the user's rejected-entry sequence, retain normal
command locking, and verify no automatic reset, exit, status or key bytes follow
it. They also reproduce `12 → FF`, `F0 → F5`, including the status check before
a proposed key transfer; no `F1` request or digit is sent. Separate scripted checks cover immediate Run A acceptance with no trailing
NOP and the prompt-then-NOP case. The existing checks still reject early acceptance,
errors, timeouts and unverified interleaved replies.

Mode entry has now been observed on hardware, but a complete physical HP-97S
exchange has not succeeded. The remaining checks are software/static evidence.
The logs do not verify displayed key-entry results, program execution through
this interface, external-port operation, electrical requirements, interleaved
notifications or the ten-symbol buffer boundary.
