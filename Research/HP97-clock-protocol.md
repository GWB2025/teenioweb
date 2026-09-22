# HP-97 TEENIX97 clock protocol recovered from CalCom

## Scope and confidence

Recovered by static analysis of the supplied CalCom.exe. No executable was run and no commands were sent to a calculator. These are the exchanges implemented by this binary, not a hardware-tested specification. Firmware revisions may differ.

Executable SHA-256: `277f5d6435996d40d8d737ef72fda794750d2ccdf3e914f26c3d7d4d506abef7`.

This describes the CalCom Bluetooth/FTDI connection in normal command mode. It is not the separate HP-97S data-entry interface. Establish the calculator's normal PC connection first, and leave its clock view/edit menu before requesting clock access. Initial connection identification is outside this clock-specific reference.

## Transport

- CalCom initializes its serial component to **19200 baud, 8 data bits, no parity, one stop bit, no flow control**.
- Every number below is a hexadecimal byte. Send raw binary bytes, not the text `0F` or `01`.
- No text delimiters, CR/LF, or checksum are added by the clock routines.
- Treat serial input as a stream: collect exactly the required number of bytes; one read call need not return a whole reply.
- Complete each request/reply step before proceeding.
- The tilde-separated decimal strings visible inside CalCom are internal storage only. They are converted to individual binary bytes before transmission. The XOR encoding used in its disk files is unrelated to these wire messages.

## Read clock

| Step | PC sends | Calculator returns | Meaning |
|---|---|---|---|
| 1 | `0F` | `0F` | Open clock access |
| 2 | `01` | `01` | Select read |
| 3 | `01` | Eight bytes: R00 through R07 | Request first half |
| 4 | `01` | Eight bytes: R08 through R0F | Request second half |
| 5 | `00` | `00` | Finish read |

The two blocks form a 16-byte register image. The final reply must be received before beginning a new transaction. A successful read alone does not set the time; CalCom subsequently opens its clock settings dialog.

## Register image

The assignments below come from CalCom's clock dialog decoder and encoder. They describe the values the program uses; they should not be generalized into a specification for an unidentified clock chip.

| Offset | Meaning | Encoding / behaviour |
|---|---|---|
| `00` | Seconds | Packed BCD; decode after masking with `7F` |
| `01` | Minutes | Packed BCD; decode after masking with `7F` |
| `02` | Hours | CalCom uses 24-hour BCD; decode with mask `3F` for this mode |
| `03` | Weekday | CalCom writes Sunday=1 through Saturday=7 |
| `04` | Day of month | Packed BCD, mask `3F` |
| `05` | Month | Packed BCD, mask `1F` |
| `06` | Year | Packed BCD, two digits; CalCom constructs dates in 2000–2099 |
| `07`–`0A` | Other clock registers | Read but not written by this clock-settings transaction |
| `0B` | Alarm minute | Packed BCD; CalCom writes it with bit 7 clear |
| `0C` | Alarm hour | 24-hour BCD; CalCom writes it with bit 7 clear |
| `0D` | Alarm day/date mask | CalCom writes `80` |
| `0E` | Clock/alarm control | CalCom writes `1C` for alarm off, `1E` for alarm on |
| `0F` | Date-format value as used by CalCom | CalCom writes `00` for MM DD YY or `FF` for DD MM YY; its reader checks bit 0 |

The calculator manual describes its displayed weekday as Sunday=0 through Saturday=6. That differs from the value CalCom sends in register `03`; use the wire convention above when reproducing CalCom.

Packed BCD conversion:

```python
def bcd(n):
    return ((n // 10) << 4) | (n % 10)

def unbcd(b):
    return 10 * (b >> 4) + (b & 15)
```

For example, 2026-09-20 15:14:23 has the first seven bytes:

```text
23 14 15 01 20 09 26
ss mm hh wd DD MM YY
```

## Write clock

The HP-97 path writes variable-length register blocks. Each block is:

```text
00  START_REGISTER  BYTE_COUNT  DATA...
```

The leading `00` means another block follows. The transaction terminator is a single `01`. It is not an extra data byte or a block with a zero count.

The complete sequence produced by CalCom is:

| Step | PC sends | Calculator returns |
|---|---|---|
| 1 | `0F` | `0F` |
| 2 | `00` | `00` |
| 3 | `00 00 03 ss mm hh` | `00` |
| 4 | `00 03 04 wd DD MM YY` | `00` |
| 5 | `00 0B 03 alarm_min alarm_hour 80` | `00` |
| 6 | `00 0E 01 control` | `00` |
| 7 | `00 0F 01 date_format` | `00` |
| 8 | `01` | `01` |

CalCom pauses 10 ms before sending each register block after receiving its preceding `00` reply. Its serial writer sends each byte individually. There is no per-data-byte acknowledgement in this path: wait for one reply after the entire block.

The fields `ss mm hh DD MM YY` and the alarm fields are BCD; addresses, counts, weekday, control, and date-format values are ordinary binary values.

If only changing the time/date, read the existing image first and retain the existing alarm and date-format choices when constructing the full exchange. The block-loop implementation suggests a transaction containing only the first two data blocks would also work, but that shortened sequence has not been confirmed against firmware or hardware. The full sequence above reproduces CalCom.

CalCom itself takes time/date from the PC when the dialog is accepted, using local wall-clock time. There is no timezone field in this exchange.

### Worked full write

Set 2026-09-20 (Sunday), 15:14:23, alarm time 07:30 but alarm disabled, DD MM YY display. **This example explicitly changes the alarm and date-format settings as well as the time/date.**

```text
PC -> calculator                 calculator -> PC
0F                               0F
00                               00
00 00 03 23 14 15                00
00 03 04 01 20 09 26             00
00 0B 03 30 07 80                00
00 0E 01 1C                      00
00 0F 01 FF                      00
01                               01
```

Read the clock again after writing to verify the result, allowing for seconds advancing.

## Error replies

CalCom handles these in the clock-access state machine:

| Byte | CalCom interpretation |
|---|---|
| `AE` | DS chip access failed |
| `EE` | Time changes cannot occur while accessing the calculator clock view/edit menu |
| `55` | Clock disabled; explicitly handled at read-access entry |
| Unexpected reply | Communication failure |

These are status replies at handshake/acknowledgement boundaries. Do not interpret an arbitrary register-data byte as an error response. Stop the transaction on an unexpected reply or timeout; do not continue sending the remaining blocks blindly.

## Evidence in the executable

Addresses below are preferred-image virtual addresses with image base `00400000`.

| Address | Evidence |
|---|---|
| `006A99ED` | Serial initialization: 19200 baud and serial options |
| `00640520` | Serial options translated into the Windows port configuration |
| `006AE193`–`006AE1EC` | Clock access command selection and entry to read state 470 |
| `006ADA0C` | Command sender: writes a single raw command byte |
| `006C9B77` | State 470: checks `0F`, sends read selector `01` |
| `006C9D39` | State 471: checks `01`, sends `01` to request data |
| `006C9E73` | State 472: gathers eight bytes, requests next block or finishes |
| `006CA01A` | State 474: verifies final read reply `00` |
| `00685538` | Decodes the 16-byte clock image into dialog controls |
| `006857C4` | Builds BCD time/date and clock settings from dialog/PC time |
| `00685E71` | Weekday calculation and assignment |
| `006BE060` | Constructs the five HP-97 write blocks |
| `006BE2C7` | Starts write exchange with command `0F`, state 480 |
| `006CA0BA` | State 480: checks `0F`, sends write selector `00` |
| `006CA22A` | State 481: on `00`, sends next block; sends `01` when exhausted |
| `006CA409` | State 482: requires final write acknowledgement `01` |
| `006408E0` | Serial WriteChar: one binary byte passed to the OS |

The separate 10-byte clock routines used for some other calculator models are deliberately excluded from this HP-97 reference.
