# Teenio Web

A browser companion for **HP-97 calculators fitted with Tony Nixon’s TEENIX97 replacement board**. Manage stored programs, inspect calculator memory and keep the board’s clock up to date from a Mac or Windows PC.

[![Launch Browser App](docs/assets/launch-browser-app.svg)](https://gwb2025.github.io/teenioweb/)

**Open in desktop Chrome for Bluetooth access.** You can explore **Demo mode** without a calculator or installation.

## What it can do

- **Read calculator information:** identify the model, firmware and current settings.
- **Inspect memory:** view all sixteen registers and 224 program positions; save listings and memory captures, or reopen saved captures.
- **Manage stored programs:** browse storage blocks and slots, read program cards, and import or export HP-97 `.hpp` files.
- **Back up and transfer programs:** write individual cards or prepare and upload a complete two-card program, with destination backups and read-back checks.
- **Read and set the clock:** update the board’s date and time and verify the result.
- **Explore and troubleshoot:** use Demo mode, widget tooltips, built-in Help and downloadable activity logs.

Program uploads go into the board’s card storage. Loading them into active program memory is a separate step performed on the calculator.

## Get started

1. Click **Launch Browser App** above. Select **Demo mode** to try the interface without hardware.
2. For a real calculator, enable its normal Bluetooth connection mode and pair **TEENIX97** in your computer’s Bluetooth settings. Close other Teenio or CalCom connections first.
3. Choose **Connect to TEENIX97** in the app, select the device and choose **Read settings**. The app’s **Help** explains the remaining workflows.

Calculator data is handled locally in your browser and saved to files you choose; it is not uploaded to a server.

## Compatibility and development status

The current hardware target is **TEENIX97 / HP-97 firmware 21**. Other replacement calculator boards are not yet supported. Live connections use desktop Chrome’s Web Serial support for Bluetooth Classic.

Development and hardware verification are ongoing. The **HP-97S interface is experimental**: Demo works, but live Bluetooth testing currently fails when requesting status after mode entry. USB/FTDI connection support is not yet implemented.

## Acknowledgements

Thank you to **Tony Nixon (TeenNix)** for the TEENIX97 board, CalCom, documentation and assistance with the protocols. Teenio Web is an independently developed companion inspired by that work; it does not include CalCom or the board firmware.

## Further reading

- [Development history, verification notes and local setup](DEVELOPMENT_HISTORY.md)
- [Publishing a website update](DEVELOPMENT_HISTORY.md#publish-an-update-on-github)
- [Example programs, including Lucas–Lehmer](Programs/README.md)
- [Clock protocol](Research/HP97-clock-protocol.md) and [HP-97S investigation](Research/HP97S-firmware21-follow-up.md)
