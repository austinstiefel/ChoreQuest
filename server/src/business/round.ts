/** CPython round(float, digits): round the actual binary float, ties to even.
 * Used for the reference's chart percentages and rank/pet progress values. */
export function pythonRound(value: number, digits: number): number {
	if (!Number.isFinite(value) || !Number.isInteger(digits) || digits < 0 || digits > 6)
		throw new RangeError("Invalid report rounding input");
	if (value === 0)
		return value;
	const bytes = new DataView(new ArrayBuffer(8));
	bytes.setFloat64(0, Math.abs(value));
	const bits = bytes.getBigUint64(0);
	const exponent = Number((bits >> 52n) & 2047n);
	const mantissa = (bits & ((1n << 52n) - 1n)) + (exponent ? 1n << 52n : 0n);
	const power = (exponent || 1) - 1023 - 52;
	let numerator = mantissa * 10n ** BigInt(digits), denominator = 1n;
	if (power >= 0)
		numerator <<= BigInt(power);
	else
		denominator <<= BigInt(-power);
	let result = numerator / denominator;
	const remainder = numerator % denominator;
	if (remainder * 2n > denominator || (remainder * 2n === denominator && result % 2n !== 0n))
		result++;
	return Math.sign(value) * Number(result) / 10 ** digits;
}
