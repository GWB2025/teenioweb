"""Build a one-card HP-97 Lucas–Lehmer program for small prime exponents."""

from pathlib import Path


# HP-97 opcodes from the Teenio instruction table. Each tuple is (mnemonic, opcode).
STEPS = [
    ("LBL A", 0xFA), ("STO 4", 0x94),
    ("RCL 4", 0x74), ("3", 0x13), ("x=y?", 0x51), ("GTO 9", 0xD9),
    ("RCL 4", 0x74), ("5", 0x15), ("x=y?", 0x51), ("GTO 9", 0xD9),
    ("RCL 4", 0x74), ("7", 0x17), ("x=y?", 0x51), ("GTO 9", 0xD9),
    ("RCL 4", 0x74), ("1", 0x11), ("1", 0x11), ("x=y?", 0x51), ("GTO 9", 0xD9),
    ("RCL 4", 0x74), ("1", 0x11), ("3", 0x13), ("x=y?", 0x51), ("GTO 9", 0xD9),
    ("1", 0x11), ("CHS", 0x1C), ("R/S", 0x00),
    ("LBL 9", 0xF9),
    ("1", 0x11), ("STO 0", 0x90),
    ("RCL 4", 0x74), ("STO 1", 0x91),
    ("LBL 0", 0xF0), ("RCL 0", 0x70), ("2", 0x12), ("×", 0x39),
    ("STO 0", 0x90), ("RCL 1", 0x71), ("1", 0x11), ("−", 0x38),
    ("STO 1", 0x91), ("x>0?", 0x55), ("GTO 0", 0xD0),
    ("RCL 0", 0x70), ("1", 0x11), ("−", 0x38), ("STO 0", 0x90),
    ("RCL 4", 0x74), ("2", 0x12), ("−", 0x38), ("STO 1", 0x91),
    ("4", 0x14), ("STO 2", 0x92),
    ("LBL 1", 0xF1), ("RCL 2", 0x72), ("x²", 0x02), ("2", 0x12),
    ("−", 0x38), ("STO 3", 0x93), ("RCL 0", 0x70), ("÷", 0x1E),
    ("INT", 0x29), ("RCL 0", 0x70), ("×", 0x39), ("RCL 3", 0x73),
    ("x↔y", 0x30), ("−", 0x38), ("STO 2", 0x92),
    ("RCL 1", 0x71), ("1", 0x11), ("−", 0x38), ("STO 1", 0x91),
    ("PAUSE", 0x20), ("x>0?", 0x55), ("GTO 1", 0xD1),
    ("RCL 2", 0x72), ("R/S", 0x00),
]

KEYS = {
    "LBL A": "21 11", "STO 4": "35 04", "1": "01", "STO 0": "35 00",
    "RCL 4": "36 04", "STO 1": "35 01", "LBL 0": "21 00",
    "RCL 0": "36 00", "2": "02", "×": "-35", "RCL 1": "36 01",
    "−": "-45", "x>0?": "16-44", "GTO 0": "22 00",
    "4": "04", "STO 2": "35 02", "LBL 1": "21 01",
    "RCL 2": "36 02", "x²": "53", "STO 3": "35 03",
    "÷": "-24", "INT": "16 34", "RCL 3": "36 03",
    "x↔y": "-41", "GTO 1": "22 01", "RTN": "24",
    "3": "03", "5": "05", "7": "07", "x=y?": "16-33",
    "GTO 9": "22 09", "LBL 9": "21 09", "CHS": "-22",
    "R/S": "51", "PAUSE": "16 51",
}

NAME = "LUCAS LEHMER V2"
ROOT = Path(__file__).resolve().parent


def card_nibbles():
    assert len(STEPS) == 77
    # The calculator's own listing reads byte 0 through byte 6 in each
    # descending RAM register. A live E49 load established this order.
    ram = bytearray(112)
    for index, (_, opcode) in enumerate(STEPS):
        ram[index] = (opcode >> 4) | (opcode << 4 & 0xF0)
    # Header copied from a valid single-program-card capture (A21 Ohm's Law).
    nibbles = [2, 2, 2, 0, 0, 1, 3]
    for offset in range(0, 112, 7):
        digits = [digit for byte in ram[offset:offset + 7] for digit in (byte >> 4, byte & 15)]
        nibbles.extend(digits[7:14] + digits[0:7])
    checksum = sum(
        sum(nibbles[offset + j] << (4 * j) for j in range(7))
        for offset in range(0, 231, 7)
    ) & 0x0FFFFFFF
    nibbles.extend((checksum >> (4 * j)) & 15 for j in range(7))
    assert len(nibbles) == 238
    return nibbles


def physical_opcodes():
    """Decode the card as the HP-97 lists and executes it after CARD → Read."""
    nibbles = card_nibbles()
    steps = []
    for offset in range(7, 231, 14):
        digits = nibbles[offset + 7:offset + 14] + nibbles[offset:offset + 7]
        packed = [(digits[i] << 4) | digits[i + 1] for i in range(0, 14, 2)]
        steps.extend((value >> 4) | ((value & 15) << 4) for value in packed)
    return steps


def make_hpp():
    nibbles = card_nibbles()
    numbers = [0] * 21 + nibbles + nibbles[-7:]
    assert len(numbers) == 266
    payload = b"\r\n".join(
        [b"97", b"", NAME.encode("ascii")]
        + [str(number).encode("ascii") for number in numbers]
        + [b""]
    )
    decoded = b"NeWe\r" + str(len(payload)).encode("ascii") + b"\r" + payload
    result = bytes(byte ^ 0x55 for byte in decoded)
    # Verify the serialized fields expected by Teenio's HPPProgram importer.
    header, length, body = bytes(byte ^ 0x55 for byte in result).split(b"\r", 2)
    assert header == b"NeWe" and int(length) == len(body)
    lines = [line.removesuffix(b"\r") for line in body.split(b"\n")]
    assert len(lines) == 270 and lines[0] == b"97" and lines[-1] == b""
    assert [int(line) for line in lines[3:269]] == numbers
    return result


def lucas_lehmer_residue(p):
    modulus = 1
    for _ in range(p):
        modulus *= 2
    modulus -= 1
    residue = 4
    for _ in range(p - 2):
        numerator = residue * residue - 2
        quotient = int(numerator / modulus)  # HP-97 INT truncates toward zero.
        residue = numerator - quotient * modulus
    return residue


def simulate_card(value):
    """Execute the card's actual instruction sequence, including branch and stop."""
    by_opcode = {opcode: name for name, opcode in STEPS}
    program = [(by_opcode[opcode], opcode) for opcode in physical_opcodes()[:len(STEPS)]]
    labels = {name[4:]: index for index, (name, _) in enumerate(program)
              if name.startswith("LBL ")}
    stack = [float(value), 0.0, 0.0, 0.0]  # X, Y, Z, T
    registers = [0.0] * 5
    pc = 0
    digit_entry = False
    skip_next = False
    count = 0
    while pc < len(program):
        name, _ = program[pc]
        pc += 1
        count += 1
        assert count < 1000, f"Program did not terminate for input {value}"
        if skip_next:
            skip_next = False
            continue
        if name in ("1", "2", "3", "4", "5", "7"):
            if digit_entry:
                stack[0] = stack[0] * 10 + int(name)
            else:
                stack = [float(name)] + stack[:3]
            digit_entry = True
            continue
        digit_entry = False
        if name.startswith("LBL ") or name == "PAUSE":
            continue
        if name.startswith("STO "):
            registers[int(name[-1])] = stack[0]
        elif name.startswith("RCL "):
            stack = [registers[int(name[-1])]] + stack[:3]
        elif name.startswith("GTO "):
            pc = labels[name[4:]]
        elif name == "x=y?":
            skip_next = stack[0] != stack[1]
        elif name == "x>0?":
            skip_next = stack[0] <= 0
        elif name == "CHS":
            stack[0] = -stack[0]
        elif name == "x²":
            stack[0] *= stack[0]
        elif name == "INT":
            stack[0] = float(int(stack[0]))
        elif name == "x↔y":
            stack[0], stack[1] = stack[1], stack[0]
        elif name in ("×", "−", "÷"):
            y, x = stack[1], stack[0]
            result = {"×": lambda: y * x, "−": lambda: y - x,
                      "÷": lambda: y / x}[name]()
            stack = [result, stack[2], stack[3], stack[3]]
        elif name == "R/S":
            return round(stack[0]), count
        else:
            raise AssertionError(f"Unknown instruction {name}")
    raise AssertionError("Program reached the end without R/S")


if __name__ == "__main__":
    assert physical_opcodes()[:len(STEPS)] == [opcode for _, opcode in STEPS]
    assert set(physical_opcodes()[len(STEPS):]) == {0}
    assert {p: lucas_lehmer_residue(p) for p in (3, 5, 7, 11, 13)} == {
        3: 0, 5: 0, 7: 0, 11: 1736, 13: 0
    }
    for exponent in (3, 5, 7, 11, 13):
        assert simulate_card(exponent)[0] == lucas_lehmer_residue(exponent)
    for invalid in (2, 4, 9, 17, 31, 127, 2047):
        assert simulate_card(invalid)[0] == -1
    (ROOT / "Lucas-Lehmer-HP97.hpp").write_bytes(make_hpp())
    lines = ["HP-97 Lucas–Lehmer program (revised)", "Input: prime p = 3, 5, 7, 11 or 13; press A.",
             "Output: 0 means 2^p−1 is prime; a positive residue means composite.",
             "Invalid input returns −1. The countdown briefly shows iterations remaining.",
             "p=2 is the special case: 2^2−1=3 is prime.", "",
             "Step  Opcode  Instruction  [key code]", ""]
    lines.extend(f"{i:03d}   {opcode:02X}    {name:<12} [{KEYS[name]}]"
                 for i, (name, opcode) in enumerate(STEPS, 1))
    (ROOT / "Lucas-Lehmer-HP97.txt").write_text("\n".join(lines) + "\n")
