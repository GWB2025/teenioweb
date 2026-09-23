# TEENIX97 / CalCom HP-97S-style serial protocol

Recovered 23 September 2026 from the supplied CPU_97.pdf (printed pages 25-28),
CalComHelp.pdf (page 15), and static analysis of CalCom.exe.

CalCom.exe SHA-256:
`277f5d6435996d40d8d737ef72fda794750d2ccdf3e914f26c3d7d4d506abef7`.

This is a documented and statically cross-checked protocol, not a hardware-tested
specification. No bytes were sent to the calculator during this investigation.
The firmware installed on the user's board has not been identified or inspected.

## 1. What this interface does

An external controller supplies numerical/key-entry data to the calculator and
receives readiness and the four calculator flags. The incoming symbols are
processed as calculator keystrokes, allowing a calculator program to process
measurements and external equipment to respond to flag changes.

The recovered HP97S functions do not provide a general text terminal, arbitrary
instrument-command passthrough, or an X-register-result read command. Other
CalCom functions may access calculator memory, but those are separate protocols.

There are two distinct access paths:

| Path | Purpose | Start/stop |
|---|---|---|
| External controller to the board's isolated four-pin HP97S connector | Real equipment supplying digit/key codes | Connect equipment first, then enable 97S mode from the calculator menu |
| CalCom's HP97S utility over its existing normal PC connection (Bluetooth/USB) | Dummy interface controller for exercising the same status/digit functions | CalCom sends `12`, expects `FF`; sends `F5`, expects `F5`, to leave |

CalCom uses its existing serial component for the HP97S utility, not a second
COM-port selection for external equipment. Its receive dispatcher routes data
to the HP97S dialogue while that dialogue is active. This establishes the PC-side
test path; it does not prove that arbitrary external-equipment traffic is bridged
between the two physical interfaces, or that both paths can be used simultaneously.

## 2. Serial transport and connector

- **19200 baud, 8 data bits, no parity, 1 stop bit.**
- Handshaking is in the byte protocol; no separate hardware-flow-control lines
  are shown. Disable RTS/CTS, DSR/DTR and XON/XOFF flow control.
- Send raw binary bytes. `F0` means one byte of value 240, not two ASCII characters.
- Each digit/key symbol occupies one byte `00` through `0F`, not a packed pair
  of BCD nibbles and not ASCII.
- No CR/LF delimiter, length prefix, or checksum is present in the recovered
  command exchanges.
- Wait for the appropriate response before transmitting the next byte.

The board manual shows an isolated four-wire connection labelled:

1. External supply, **3.3-5 V**.
2. Controller transmit (towards the calculator).
3. Controller receive (from the calculator).
4. External ground.

These are signal names, not verified physical pin numbers. Use the manual's
diagram and the actual board orientation to identify pins. The manual calls the
interface RS-232, but its four-pin diagram and supply annotation do not establish
the electrical signal voltage/polarity. Do not infer compatibility with a
conventional positive/negative-voltage RS-232 port or a particular TTL adapter
without confirming the board's electrical requirements. No electrical measurement
was made here.

The manual suggests starting with approximately 300 mm of cable and connecting
before enabling 97S mode. Connecting/disconnecting while enabled can introduce
invalid input; a calculator power cycle is its documented recovery for a hung
transaction. The 97S enable mode is separate from the normal Bluetooth ConnEct
setting used earlier in this investigation.

## 3. Commands and control bytes

All numbers in this document's protocol tables are hexadecimal.

| Direction | Byte | Meaning |
|---|---|---|
| Controller -> board | `F0` | Request status; reply is one status byte |
| Controller -> board | `F1` | Request a digit/key-code transfer |
| Board -> controller | `F1` | Ready for the next single digit/key-code byte |
| Controller -> board | `00`-`0E` | Digit/key code, after the board's `F1` prompt |
| Controller -> board | `0F` | NOP / terminator, after the board's `F1` prompt |
| Board -> controller | `A0` | Transfer accepted; stop sending this transaction |
| Board -> controller | `A1` | Digit-buffer-full error / terminal condition; stop |
| Board -> controller | `A2` | Transfer error / terminal condition; stop; exact cause is inconsistent in sources |

An initial response other than `F1` to a transfer request is not permission to
send digit data. Abort that transfer rather than continuing blindly.

### CalCom On/Off (normal PC connection only)

| Action | PC sends | Expected reply | Interpretation |
|---|---|---|---|
| On | `12` | `FF` | HP97S controller/test mode accepted |
| On, rejected | `12` | `00` | CalCom says it cannot activate 97S mode and to ensure RUN mode |
| Off | `F5` | `F5` | Mode left / acknowledged |

The On/Off handler uses `12` when its local on/off state is false and `F5` when
true. A successful reply updates that local state. Closing an active, idle HP97S
dialogue also sends `F5` and waits for its acknowledgement. Closing during a
transfer produces a warning in CalCom that a calculator power cycle may be needed.

These extra bytes were recovered from the CalCom binary. They are not listed
as commands for the isolated equipment port in the board manual. Do not assume
that sending `12` or `F5` to that isolated port is supported.

## 4. Status byte

| Bit | Mask | Meaning |
|---|---|---|
| 7 | `80` | FlagChanged: notification that calculator flags changed |
| 6 | `40` | Reserved |
| 5 | `20` | Reserved |
| 4 | `10` | **Ready: 1 = ready to begin a transfer; 0 = not ready** |
| 3 | `08` | Calculator Flag 3 |
| 2 | `04` | Calculator Flag 2 |
| 1 | `02` | Calculator Flag 1 |
| 0 | `01` | Calculator Flag 0 |

Start with `F0`, read a status byte and require `(status & 0x10) != 0` before
sending `F1`. The Ready bit is cleared while a transfer is accepted/being handled.
PRGM mode and a running calculator program can also make the interface not ready.

Status changes can arrive unsolicited with bit 7 set. The manual specifies that
these mirror changes in the four calculator flags, allowing an external controller
to update its own output pins. Digit entry sets Flag 3 as keyboard entry does,
which affects readiness; calculator code or the keyboard must clear it as needed.
The manual says starting program A clears Flag 3, although the running program
itself makes the calculator not ready.

Parse replies by transaction state. `F1`, `A0`, `A1`, `A2` and `FF` all also have
bit 7 set, so a generic 'bit 7 means flag event' rule would misclassify replies.
The CalCom idle handler handles flag-change notifications separately from its
status/transfer states. Behaviour for flag events interleaved with a transfer has
not been verified on hardware.

## 5. Digit/key-code alphabet

| Binary byte | Meaning | Character typed in CalCom's digit fields |
|---|---|---|
| `00`-`09` | Digits 0-9 | `0`-`9` |
| `0A` | Decimal point | `.` |
| `0B` | EEX | `X` |
| `0C` | ENTER | `E` |
| `0D` | Run from label A | `A` |
| `0E` | Change sign | `S` |
| `0F` | NOP / end of transfer | `N` |

The mapping of CalCom's characters was recovered from its conversion jump table.
In particular, its text `A` means Run A (`0D`), not hex `0A`. CalCom's text `E`
means ENTER (`0C`), not change sign. External controllers send the binary column.

## 6. Example: enter 34.27

The following is a request/reply sequence, not one uninterrupted transmitted
buffer. `10` is an illustrative status with Ready set and all four flags clear.

| Step | Controller sends | Board replies |
|---|---|---|
| Check readiness | `F0` | `10` (or another status with bit 4 set) |
| Begin digit transfer | `F1` | `F1` |
| Digit 3 | `03` | `F1` |
| Digit 4 | `04` | `F1` |
| Decimal point | `0A` | `F1` |
| Digit 2 | `02` | `F1` |
| Digit 7 | `07` | `F1` |
| End | `0F` | `A0` |

This enters the number as key data; it does not append ENTER. To request program
A after entering the number, include `0D` after `07`, wait for the next handshake,
then terminate with `0F`. The manual says symbols following Run A are ignored once
the program runs, so Run A should be the last actionable symbol.

In CalCom the corresponding fields are `3`, `4`, `.`, `2`, `7`, `N`, or
`3`, `4`, `.`, `2`, `7`, `A`, `N` to request program A.

## 7. Limits and manual discrepancies

The receive buffer is documented as ten digit/key symbols. The manual also says
the internal PIK key buffer holds seven; the firmware feeds it incrementally.
Once digit input is expected, the manual gives an approximate one-second timeout.
Avoid deliberate pauses between per-byte acknowledgements.

Three important discrepancies were found:

1. **Ready polarity:** page 26 contains a sentence saying to send when Ready = 0.
   Its own bit table and worked example say Ready = 1. CalCom's branch at
   `0068AD79` masks with `10`, compares against `10`, and only then sends `F1`.
   Its message explicitly says 'Interface is ready - Bit 4 = 1'. Use **1 = ready**.
2. **Digit acknowledgement:** the page 26 summary suggests `A0` acknowledges a
   digit. The worked example and CalCom agree that `F1` asks for each subsequent
   symbol; `A0` ends the transaction. Do not send more symbols after `A0`.
3. **Error meanings/buffer boundary:** the manual describes `A2` as a timeout
   that loses the pending data and turns 97S mode off; CalCom labels it
   'Key buffer overflow'. It treats both `A1` and `A2` as terminal responses.
   Page 26 describes termination at ten symbols, whereas page 28 describes
   excess digits and loss of data. CalCom accepts ten filled fields without a
   NOP, but labels `A1` as an error. The exact ten-symbol boundary and firmware
   error causes therefore require hardware/firmware verification.

For a conservative initial implementation, use at most **nine actionable
symbols plus `0F`**, require `A0` for success, and abort on `A1`, `A2`, unexpected
bytes or a timeout. Do not silently retry a digit transfer: that can duplicate
keystrokes when acknowledgement or completion is uncertain. This is an
implementation recommendation, not a newly established firmware limit.

## 8. CalCom functions and implementation evidence

| Function | Recovered behaviour | Static address |
|---|---|---|
| HP97S button | Opens dummy-controller dialogue and routes PC receive data to it | `006AB188`, `006C4156` |
| On/Off | `12` on / `F5` off | `0068A0C8` |
| Read Status | Sends `F0`, expects one status byte | `0068A18C` |
| Send Digits | Validates fields, sends `F0`, checks Ready, sends `F1`, then one code per `F1` | `0068A228`, `0068ACE8`-`0068AFE3` |
| Digit conversion | UI characters to bytes `00`-`0F` | `0068A2B4` |
| Field validation | Ten slots; NOP required for incomplete sequence | `0068A3BC` |
| Receive state machine | On/off acknowledgements, status, per-digit flow, errors | `0068A9D8` |
| Clear | Clears the message display; not a calculator-clear command | `00689F4C` |
| Close | Sends `F5` when on and idle; otherwise warns about active transfer | `00689E80` |
| Send byte | Existing main serial component; no HP97S text framing added | `006BE3B4`, `006408E0` |

`inspect_97s.py` regenerates `HP97S-static-evidence.txt`, including decoded message
strings, input-character mapping, receive-state targets and relevant disassembly.
The sender was followed to the serial component's one-byte write operation.

## 9. What remains unverified

- Actual firmware version and behaviour on the user's board.
- Exact ten-symbol handling and the precise `A2` cause for that firmware.
- Electrical levels, polarity and physical connector pin numbering.
- Whether PC test mode and physical external-port mode can be active together.
- Robust treatment of unsolicited status messages during a transaction.

A useful bench verification would start with the physical interface's `F0`
status query, then a short number terminated by `0F`, capturing both directions.
It should not begin by writing programs or probing undocumented command values.

## Sources

- [CPU_97.pdf](<C:/Users/quaff/OneDrive/Desktop/claude session/CalCom-inspection/CPU_97.pdf>), printed pages 25-28.
- [CalComHelp.pdf](<C:/Users/quaff/OneDrive/Desktop/claude session/CalCom-inspection/CalComHelp.pdf>), page 15.
- [Static evidence](<C:/Users/quaff/OneDrive/Desktop/claude session/CalCom-inspection/HP97S-static-evidence.txt>).
