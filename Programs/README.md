# HP-97 Lucas–Lehmer examples

These program cards test whether a Mersenne number `2^p − 1` is prime for the supported exponents. Load the card or cards into the calculator's active program memory, enter the exponent `p`, then press **A**. Zero means prime; a positive residue means composite; unsupported inputs return −1.

Writing a stored slot in Teenio Web does not load active program memory. Use the calculator's card-read controls afterwards. Loading a program replaces its current active program; running it uses calculator registers.

## One-card version

`Lucas-Lehmer-HP97.hpp` is named **LUCAS LEHMER V2**. It supports prime exponents **3, 5, 7, 11 and 13**. Expected residues are zero except for exponent 11, which returns **1,736**. Exponent 2 is not supported by this version. `Lucas-Lehmer-HP97.txt` contains the 77-step listing; `make_lucas_lehmer.py` regenerates the program.

The user verified that this version runs on the HP-97, can be written to and read from a magnetic card, and can be transferred through Windows CalCom using an HPP file exported by native Teenio.

## Extended two-card version

Load `Lucas-Lehmer-Extended-HP97-card-1.hpp` (**LUCAS LEHMER X1/2**) followed by `Lucas-Lehmer-Extended-HP97-card-2.hpp` (**LUCAS LEHMER X2/2**). The 156-step program supports prime exponents **2, 3, 5, 7, 11, 13, 17, 19, 23, 29 and 31**.

| Exponent | Expected residue | Result |
| ---: | ---: | --- |
| 2, 3, 5, 7, 13, 17, 19, 31 | 0 | Prime |
| 11 | 1,736 | Composite |
| 23 | 6,107,895 | Composite |
| 29 | 458,738,443 | Composite |

This version uses modular addition and doubling to keep intermediate integers within the HP-97's precision. Turbo mode helps with the larger exponents. The user physically verified exponents 11, 23 and 31; other supported exponents were checked in the simulator.

`Lucas-Lehmer-Extended-HP97.txt` gives the complete listing and card boundary. `make_extended_lucas_lehmer.py` generates both cards and checks the supported inputs in its simulator.

Teenio Web currently writes one stored slot at a time. Uploading both cards requires two separate destination backups and writes, followed by loading them in order on the calculator. These program checks do not constitute hardware verification of the new browser writer.
