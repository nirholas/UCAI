'use strict';
// decode-uri-component 0.2.2 public API (CommonJS, `+` decodes to a space) with the decoder from
// 0.5.1. The 0.2.x fallback re-split and re-decoded the token list for every token and then ran one
// global RegExp replace per distinct run, which is exponential/quadratic on crafted malformed input
// (GHSA-vcc3-ghjq-m6fr, GHSA-qr28-fpjm-wq7f). The fixed releases are ESM-only, which CommonJS
// consumers such as query-string 6/7 cannot require, so this copy keeps the old module shape.

var token = '%[a-f0-9]{2}';
var multiMatcher = new RegExp('(' + token + ')+', 'gi');
var hexPair = /^[a-f\d]{2}$/i;

// Read a `%XX` sequence at `position`, returning the byte value and where to continue scanning.
function parsePercentByte(input, position) {
	if (input.charCodeAt(position) !== 37 || position + 3 > input.length) {
		return undefined;
	}

	var digits = input.slice(position + 1, position + 3);

	if (!hexPair.test(digits)) {
		return undefined;
	}

	return {byte: parseInt(digits, 16), next: position + 3};
}

// How many bytes a UTF-8 code point needs based on its lead byte; 0 for continuation or invalid bytes.
function utf8SequenceLength(byte) {
	if (byte <= 0x7F) {
		return 1;
	}

	// Start at 0xC2 to exclude overlong 2-byte encodings (0xC0/0xC1).
	if (byte >= 0xC2 && byte <= 0xDF) {
		return 2;
	}

	if (byte >= 0xE0 && byte <= 0xEF) {
		return 3;
	}

	if (byte >= 0xF0 && byte <= 0xF4) {
		return 4;
	}

	return 0;
}

function isContinuationByte(byte) {
	return byte >= 0x80 && byte <= 0xBF;
}

// Decode as much of `input` as possible without throwing, left to right in O(n).
function decode(input) {
	try {
		return decodeURIComponent(input);
	} catch (err) {
		var output = '';
		var position = 0;

		while (position < input.length) {
			if (input.charCodeAt(position) !== 37) {
				output += input.charAt(position);
				position++;
				continue;
			}

			var firstByte = parsePercentByte(input, position);

			// `%` not followed by two hex digits (e.g. `%` or `%G`).
			if (!firstByte) {
				output += input.charAt(position);
				position++;
				continue;
			}

			var sequenceLength = utf8SequenceLength(firstByte.byte);

			// Continuation byte or invalid lead byte: emit one `%XX` literally.
			if (sequenceLength === 0) {
				var pair = input.slice(position, position + 6);

				// UTF-16 BOM byte pairs become two replacement characters.
				if (pair === '%FE%FF' || pair === '%FF%FE') {
					output += '\uFFFD\uFFFD';
					position += 6;
					continue;
				}

				output += input.slice(position, position + 3);
				position += 3;
				continue;
			}

			var end = firstByte.next;
			var validSequence = true;

			for (var index = 1; index < sequenceLength; index++) {
				var nextByte = parsePercentByte(input, end);

				if (!nextByte || !isContinuationByte(nextByte.byte)) {
					validSequence = false;
					break;
				}

				end = nextByte.next;
			}

			if (validSequence) {
				try {
					output += decodeURIComponent(input.slice(position, end));
					position = end;
					continue;
				} catch (err2) {
					// Invalid UTF-8 despite correct structure: emit the first byte literally below.
				}
			}

			// Missing continuation bytes or decode failure: emit the first byte literally.
			var literal = input.slice(position, position + 3);

			// A truncated `%C2` becomes a replacement character.
			output += literal === '%C2' ? '\uFFFD' : literal;
			position += 3;
		}

		return output;
	}
}

function customDecodeURIComponent(input) {
	// Decode each percent-encoded run in place in a single pass. Decoded output is never rescanned.
	return input.replace(multiMatcher, function (run) {
		return decode(run);
	});
}

module.exports = function (encodedURI) {
	if (typeof encodedURI !== 'string') {
		throw new TypeError('Expected `encodedURI` to be of type `string`, got `' + typeof encodedURI + '`');
	}

	encodedURI = encodedURI.replace(/\+/g, ' ');

	try {
		// Try the built in decoder first
		return decodeURIComponent(encodedURI);
	} catch (err) {
		// Fallback to a more advanced decoder
		return customDecodeURIComponent(encodedURI);
	}
};
