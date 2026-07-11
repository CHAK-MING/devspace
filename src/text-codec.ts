import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import iconv from "iconv-lite";

export type TextEncoding = "utf8" | "utf8-bom" | "utf16le" | "utf16be" | "gb18030";

export interface DecodedText {
  content: string;
  encoding: TextEncoding;
}

export interface DecodedTextFile extends DecodedText {
  bytes: Buffer;
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);
const CONTROL_CHARACTER_LIMIT = 0.05;

export async function readTextFileAuto(path: string): Promise<DecodedTextFile> {
  const bytes = await readFile(path);
  const decoded = decodeText(bytes);
  return { ...decoded, bytes };
}

export function decodeText(bytes: Buffer): DecodedText {
  if (bytes.length === 0) return { content: "", encoding: "utf8" };

  if (bytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)) {
    const content = decodeUtf8Fatal(bytes.subarray(UTF8_BOM.length));
    assertTextLike(content);
    return { content, encoding: "utf8-bom" };
  }

  if (bytes.subarray(0, UTF16LE_BOM.length).equals(UTF16LE_BOM)) {
    const content = decodeUtf16Le(bytes.subarray(UTF16LE_BOM.length));
    assertTextLike(content);
    return { content, encoding: "utf16le" };
  }

  if (bytes.subarray(0, UTF16BE_BOM.length).equals(UTF16BE_BOM)) {
    const content = decodeUtf16Be(bytes.subarray(UTF16BE_BOM.length));
    assertTextLike(content);
    return { content, encoding: "utf16be" };
  }

  const utf16Guess = guessUtf16Encoding(bytes);
  if (utf16Guess === "utf16le") {
    const content = decodeUtf16Le(bytes);
    assertTextLike(content);
    return { content, encoding: "utf16le" };
  }
  if (utf16Guess === "utf16be") {
    const content = decodeUtf16Be(bytes);
    assertTextLike(content);
    return { content, encoding: "utf16be" };
  }

  try {
    const content = decodeUtf8Fatal(bytes);
    assertTextLike(content);
    return { content, encoding: "utf8" };
  } catch {
    const content = iconv.decode(bytes, "gb18030");
    assertTextLike(content);
    return { content, encoding: "gb18030" };
  }
}

export async function writeTextFileEncoded(
  path: string,
  content: string,
  encoding: TextEncoding,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, encodeText(content, encoding));
}

export function encodeText(content: string, encoding: TextEncoding): Buffer {
  switch (encoding) {
    case "utf8":
      return Buffer.from(content, "utf8");
    case "utf8-bom":
      return Buffer.concat([UTF8_BOM, Buffer.from(content, "utf8")]);
    case "utf16le":
      return Buffer.concat([UTF16LE_BOM, Buffer.from(content, "utf16le")]);
    case "utf16be":
      return Buffer.concat([UTF16BE_BOM, encodeUtf16Be(content)]);
    case "gb18030":
      return encodeLegacyChinese(content);
  }
}

function decodeUtf8Fatal(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function decodeUtf16Le(bytes: Buffer): string {
  return Buffer.from(bytes).toString("utf16le");
}

function decodeUtf16Be(bytes: Buffer): string {
  const swapped = Buffer.allocUnsafe(bytes.length - (bytes.length % 2));
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    swapped[index] = bytes[index + 1];
    swapped[index + 1] = bytes[index];
  }
  return swapped.toString("utf16le");
}

function encodeUtf16Be(content: string): Buffer {
  const little = Buffer.from(content, "utf16le");
  const big = Buffer.allocUnsafe(little.length);
  for (let index = 0; index + 1 < little.length; index += 2) {
    big[index] = little[index + 1];
    big[index + 1] = little[index];
  }
  return big;
}

function encodeLegacyChinese(content: string): Buffer {
  const encoded = iconv.encode(content, "gb18030");
  const roundTrip = iconv.decode(encoded, "gb18030");
  if (roundTrip !== content) {
    throw new Error("Content contains characters that cannot be represented in GB18030/GBK.");
  }
  return encoded;
}

function guessUtf16Encoding(bytes: Buffer): "utf16le" | "utf16be" | undefined {
  const sampleLength = Math.min(bytes.length - (bytes.length % 2), 4096);
  if (sampleLength < 8) return undefined;

  let evenZeros = 0;
  let oddZeros = 0;
  for (let index = 0; index < sampleLength; index += 2) {
    if (bytes[index] === 0) evenZeros++;
    if (bytes[index + 1] === 0) oddZeros++;
  }

  const pairs = sampleLength / 2;
  if (oddZeros / pairs > 0.45 && evenZeros / pairs < 0.1) return "utf16le";
  if (evenZeros / pairs > 0.45 && oddZeros / pairs < 0.1) return "utf16be";
  return undefined;
}

function assertTextLike(content: string): void {
  if (content.includes(String.fromCharCode(0))) {
    throw new Error("file appears to be binary: contains zero bytes");
  }

  let controls = 0;
  let total = 0;
  for (const char of content) {
    total++;
    const code = char.charCodeAt(0);
    const allowed = code === 9 || code === 10 || code === 12 || code === 13;
    if (!allowed && code < 32) controls++;
  }

  if (total > 0 && controls / total > CONTROL_CHARACTER_LIMIT) {
    throw new Error("file appears to be binary: too many control characters");
  }
}
