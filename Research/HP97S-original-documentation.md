# Original HP-97S documentation

Research reference added 24 September 2026. This note compares HP's original
interface with the documented TEENIX97 design; it is not a verified wiring guide
for Tony Nixon's replacement board.

## Original manual

- **Title:** HP-97S I/O Calculator — Installation and Operation Guide.
- **Publisher:** Hewlett-Packard.
- **Date:** 1 December 1977.
- **Part number:** 5955-2816.
- [Open the repository copy (PDF, approximately 60 MB)](manuals/HP-97S-Installation-and-Operation-Guide-1977.pdf).
- [Original scan at the HP Calculator Literature Archive](https://literature.hpcalc.org/community/hp97s-iog-en.pdf).

The 78-page scan is preserved unchanged. The manual credits copyright to
Hewlett-Packard Company, 1977, and the scan was produced by hpcalc.org. This is
third-party reference material, not Teenio-authored documentation.

SHA-256: `09e4da028d7327a60df6e930726f4e1ddb7635d3e9e2c6389c445c563db8190c`.

## Relevant sections

Printed page numbers differ from the PDF viewer's page numbers by two.

| Subject | Printed pages | PDF pages | What HP documents |
| --- | --- | --- | --- |
| Data inputs and codes | 7–8 | 9–10 | Forty input wires arranged as ten four-bit groups; digits, decimal point, EEX, ENTER, continue at label A, CHS and no-operation. |
| Outputs and readiness | 11–14 | 13–16 | Four software flag outputs and a load-enable signal indicating readiness for input. |
| Connector and wiring | 17–18 | 19–20 | A 50-contact connector, with a complete pin assignment viewed from the wire side. |
| Character-serial operation | 48–49 | 50–51 | Successive digits use four data wires plus clock and control signals. This is not a TX/RX UART connection. |

## What this establishes for TEENIX97

The digit/instruction codes and the four flags provide strong evidence of shared
calculator-side behaviour. That is a functional comparison, not proof of complete
compatibility or identical timing.

Tony's supplied `CPU_97.pdf`, printed pages 25–28, describes a different physical
transport: an isolated four-wire interface at **19200 baud, 8 data bits, no parity,
one stop bit**, using byte-level acknowledgements. The wires are external
3.3–5 V supply, controller transmit, controller receive and external ground.
These are signal roles, not confirmed physical pin numbers.

The original HP connector diagram and electrical limits must not be used as the
TEENIX97 pinout or voltage specification. Before wiring the proposed Pico tester,
confirm connector orientation, pin order, signal voltage/polarity and interface
power requirements with Tony. The original manual helps define behaviour to test;
the replacement board's serial protocol determines how to perform those tests.

## Related investigations

- [TEENIX97 / CalCom HP-97S serial protocol](TEENIX97-HP97S-Protocol.md).
- [Firmware-21 routing and protocol follow-up](HP97S-firmware21-follow-up.md).

These investigations distinguish the isolated external-equipment connection from
CalCom's PC test mode and record the remaining hardware verification limits.
