"""Build a two-card HP-97 Lucas–Lehmer program for prime exponents through 31."""

from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parent
BASE = "Lucas-Lehmer-Extended-HP97"
CARD_NAMES = ("LUCAS LEHMER X1/2", "LUCAS LEHMER X2/2")
PRIMES = (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31)


OPCODES = {
    "R/S": 0x00, "2": 0x12, "3": 0x13, "4": 0x14, "5": 0x15,
    "7": 0x17, "9": 0x19, "CHS": 0x1C, "÷": 0x1E, "PAUSE": 0x20,
    "INT": 0x29, "FRAC": 0x2D, "x↔y": 0x30, "+": 0x37, "−": 0x38,
    "×": 0x39, "x=y?": 0x51, "x=0?": 0x54, "x>0?": 0x55,
    "x<0?": 0x56,
}
for digit in range(10):
    OPCODES[str(digit)] = 0x10 + digit
    OPCODES[f"RCL {digit}"] = 0x70 + digit
    OPCODES[f"STO {digit}"] = 0x90 + digit
    OPCODES[f"GTO {digit}"] = 0xD0 + digit
    OPCODES[f"LBL {digit}"] = 0xF0 + digit
for offset, letter in enumerate("ABCDE", 10):
    OPCODES[f"GTO {letter}"] = 0xD0 + offset
    OPCODES[f"LBL {letter}"] = 0xF0 + offset


KEYS = {
    "R/S": "51", "CHS": "-22", "÷": "-24", "PAUSE": "16 51",
    "INT": "16 34", "FRAC": "16 44", "x↔y": "-41", "+": "-55",
    "−": "-45", "×": "-35", "x=y?": "16-33", "x=0?": "16-43",
    "x>0?": "16-44", "x<0?": "16-45",
}
for digit in range(10):
    KEYS[str(digit)] = f"0{digit}"
    KEYS[f"RCL {digit}"] = f"36 0{digit}"
    KEYS[f"STO {digit}"] = f"35 0{digit}"
    KEYS[f"GTO {digit}"] = f"22 0{digit}"
    KEYS[f"LBL {digit}"] = f"21 0{digit}"
for offset, letter in enumerate("ABCDE", 11):
    KEYS[f"GTO {letter}"] = f"22 {offset}"
    KEYS[f"LBL {letter}"] = f"21 {offset}"


def prime_check(value):
    digits = list(str(value))
    return [f"RCL 8", *digits, "x=y?", "GTO 9"]


# Registers: 0 modulus, 1 outer count, 2 residue, 3 doubled multiplicand,
# 4 halved multiplier, 5 modular product, 6 half before INT, 8 input exponent.
NAMES = ["LBL A", "STO 8", "RCL 8", "2", "x=y?", "GTO D"]
for prime in PRIMES[1:]:
    NAMES += prime_check(prime)
NAMES += [
    "1", "CHS", "R/S",
    "LBL 9",
    "1", "STO 0", "RCL 8", "STO 1",
    "LBL 8", "RCL 0", "2", "×", "STO 0", "RCL 1", "1", "−",
    "STO 1", "x>0?", "GTO 8",
    "RCL 0", "1", "−", "STO 0",
    "RCL 8", "2", "−", "STO 1", "4", "STO 2",
    "LBL 7", "RCL 2", "STO 3", "RCL 2", "STO 4", "0", "STO 5",
    "LBL 6", "RCL 4", "2", "÷", "STO 6", "FRAC", "x=0?", "GTO 5",
    "RCL 5", "RCL 3", "+", "RCL 0", "−", "x<0?", "GTO 4",
    "STO 5", "GTO 3", "LBL 4", "RCL 0", "+", "STO 5", "LBL 3",
    "LBL 5", "RCL 6", "INT", "STO 4",
    "RCL 3", "2", "×", "RCL 0", "−", "x<0?", "GTO 2",
    "STO 3", "GTO 1", "LBL 2", "RCL 0", "+", "STO 3", "LBL 1",
    "RCL 4", "x>0?", "GTO 6",
    "RCL 5", "2", "−", "x<0?", "GTO 0", "STO 2", "GTO B",
    "LBL 0", "RCL 0", "+", "STO 2", "LBL B",
    "RCL 1", "1", "−", "STO 1", "PAUSE", "x>0?", "GTO 7",
    "RCL 2", "R/S",
    "LBL D", "0", "R/S",
]
STEPS = [(name, OPCODES[name]) for name in NAMES]


def encode_record(opcodes, card_index):
    assert len(opcodes) == 112 and card_index in (0, 1)
    ram = bytearray((opcode >> 4) | ((opcode & 15) << 4) for opcode in opcodes)
    nibbles = [2, 2, 2, 0, 0, 0, 3 + card_index]
    for offset in range(0, 112, 7):
        digits = [digit for byte in ram[offset:offset + 7]
                  for digit in (byte >> 4, byte & 15)]
        nibbles.extend(digits[7:14] + digits[0:7])
    checksum = sum(
        sum(nibbles[offset + j] << (4 * j) for j in range(7))
        for offset in range(0, 231, 7)
    ) & 0x0FFFFFFF
    nibbles.extend((checksum >> (4 * j)) & 15 for j in range(7))
    title = CARD_NAMES[card_index].encode("ascii")
    record = bytearray([0x43]) + title + bytearray([0xFF] * (20 - len(title)))
    record.extend((nibbles[i] << 4) | nibbles[i + 1]
                  for i in range(0, 238, 2))
    record.extend([0xFF] * 10)
    assert len(record) == 150
    return bytes(record), nibbles


def make_hpp(opcodes, card_index):
    _, nibbles = encode_record(opcodes, card_index)
    numbers = [0] * 21 + nibbles + nibbles[-7:]
    payload = b"\r\n".join(
        [b"97", b"", CARD_NAMES[card_index].encode("ascii")]
        + [str(number).encode("ascii") for number in numbers] + [b""]
    )
    decoded = b"NeWe\r" + str(len(payload)).encode("ascii") + b"\r" + payload
    result = bytes(byte ^ 0x55 for byte in decoded)
    header, length, body = bytes(byte ^ 0x55 for byte in result).split(b"\r", 2)
    assert header == b"NeWe" and int(length) == len(body)
    return result


def reference_residue(p):
    if p == 2:
        return 0
    modulus = (1 << p) - 1
    residue = 4
    for _ in range(p - 2):
        residue = (residue * residue - 2) % modulus
    return residue


def simulate(value):
    labels = {name[4:]: index for index, (name, _) in enumerate(STEPS)
              if name.startswith("LBL ")}
    stack = [float(value), 0.0, 0.0, 0.0]
    registers = [0.0] * 10
    pc = 0
    digit_entry = False
    skip_next = False
    count = 0
    while pc < len(STEPS):
        name, _ = STEPS[pc]
        pc += 1
        count += 1
        assert count < 100000, f"Program did not terminate for input {value}"
        if skip_next:
            skip_next = False
            continue
        if len(name) == 1 and name.isdigit():
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
        elif name == "x=0?":
            skip_next = stack[0] != 0
        elif name == "x>0?":
            skip_next = stack[0] <= 0
        elif name == "x<0?":
            skip_next = stack[0] >= 0
        elif name == "CHS":
            stack[0] = -stack[0]
        elif name == "INT":
            stack[0] = float(int(stack[0]))
        elif name == "FRAC":
            stack[0] -= int(stack[0])
        elif name == "x↔y":
            stack[0], stack[1] = stack[1], stack[0]
        elif name in ("+", "−", "×", "÷"):
            y, x = stack[1], stack[0]
            result = {"+": y + x, "−": y - x, "×": y * x, "÷": y / x}[name]
            stack = [result, stack[2], stack[3], stack[3]]
        elif name == "R/S":
            return round(stack[0]), count
        else:
            raise AssertionError(f"Unknown instruction {name}")
        assert all(abs(number) < 10_000_000_000 for number in stack + registers), \
            f"HP-97 ten-digit limit exceeded for input {value}"
    raise AssertionError("Program reached the end without R/S")


def outputs():
    assert 112 < len(STEPS) <= 224
    opcodes = [opcode for _, opcode in STEPS] + [0] * (224 - len(STEPS))
    cards = [make_hpp(opcodes[i * 112:(i + 1) * 112], i) for i in range(2)]
    lines = [
        "HP-97 extended Lucas–Lehmer program · two cards",
        "Input: prime p = 2, 3, 5, 7, 11, 13, 17, 19, 23, 29 or 31; press A.",
        "Output: 0 means 2^p−1 is prime; a positive residue means composite.",
        "Other inputs return −1. Load card 1 followed by card 2 before running.",
        "The countdown briefly shows Lucas–Lehmer iterations remaining.", "",
        "Step  Card  Opcode  Instruction  [key code]", "",
    ]
    lines.extend(
        f"{i:03d}   {(i - 1) // 112 + 1}     {opcode:02X}    {name:<12} [{KEYS[name]}]"
        for i, (name, opcode) in enumerate(STEPS, 1)
    )
    files = {
        ROOT / f"{BASE}-card-1.hpp": cards[0],
        ROOT / f"{BASE}-card-2.hpp": cards[1],
        ROOT / f"{BASE}.txt": ("\n".join(lines) + "\n").encode("utf-8"),
    }
    return files


def verify():
    expected = {2: 0, 3: 0, 5: 0, 7: 0, 11: 1736, 13: 0,
                17: 0, 19: 0, 23: 6107895, 29: 458738443, 31: 0}
    assert {p: reference_residue(p) for p in PRIMES} == expected
    for exponent, residue in expected.items():
        actual, _ = simulate(exponent)
        assert actual == residue, (exponent, actual, residue)
    for invalid in (0, 1, 4, 9, 15, 21, 25, 27, 32, 127):
        assert simulate(invalid)[0] == -1
    assert len(STEPS) == 156


if __name__ == "__main__":
    verify()
    generated = outputs()
    if "--check" in sys.argv:
        for path, data in generated.items():
            assert path.exists() and path.read_bytes() == data, f"Regenerate {path.name}"
    else:
        for path, data in generated.items():
            path.write_bytes(data)
        print(f"Wrote {len(STEPS)} program steps across two HP-97 cards.")
