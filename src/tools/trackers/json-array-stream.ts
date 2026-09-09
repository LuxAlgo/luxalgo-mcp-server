/*
  Streaming reader for the dumps' gzipped JSON arrays. A year shard can be
  tens of megabytes compressed and hundreds decompressed, so nothing here ever
  holds a whole shard: bytes stream through gunzip, the splitter tracks JSON
  structure (strings, escapes, nesting) to find each top-level element's
  boundaries, and every element is parsed and yielded on its own. Memory is
  bounded by the largest single row, not the file.
*/
import { StringDecoder } from "node:string_decoder";

const WHITESPACE = new Set([" ", "\n", "\r", "\t"]);

/**
 * Splits the text of a JSON array into its top-level elements as the text
 * arrives in pieces. `push` returns the elements completed by that piece.
 */
export class JsonArraySplitter {
  private started = false;
  private done = false;
  private inElement = false;
  private scalar = false;
  private depth = 0;
  private inString = false;
  private escape = false;
  private carried = "";

  push(text: string): unknown[] {
    const out: unknown[] = [];
    if (this.done) return out;
    let segmentStart = this.inElement ? 0 : -1;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i] as string;

      if (!this.started) {
        if (ch === "[") this.started = true;
        else if (!WHITESPACE.has(ch)) throw new Error(`Expected a JSON array, found ${ch}`);
        continue;
      }

      if (!this.inElement) {
        if (ch === "," || WHITESPACE.has(ch)) continue;
        if (ch === "]") {
          this.done = true;
          return out;
        }
        this.inElement = true;
        segmentStart = i;
        this.depth = 0;
        this.inString = false;
        this.escape = false;
        this.scalar = !(ch === "{" || ch === "[");
        if (ch === "{" || ch === "[") this.depth = 1;
        else if (ch === '"') this.inString = true;
        continue;
      }

      if (this.inString) {
        if (this.escape) this.escape = false;
        else if (ch === "\\") this.escape = true;
        else if (ch === '"') {
          this.inString = false;
          if (this.scalar) {
            out.push(this.complete(text.slice(segmentStart, i + 1)));
            segmentStart = -1;
          }
        }
        continue;
      }

      if (ch === '"') {
        this.inString = true;
        continue;
      }

      if (this.scalar) {
        if (ch === "," || ch === "]" || WHITESPACE.has(ch)) {
          out.push(this.complete(text.slice(segmentStart, i)));
          segmentStart = -1;
          if (ch === "]") {
            this.done = true;
            return out;
          }
        }
        continue;
      }

      if (ch === "{" || ch === "[") this.depth++;
      else if (ch === "}" || ch === "]") {
        this.depth--;
        if (this.depth === 0) {
          out.push(this.complete(text.slice(segmentStart, i + 1)));
          segmentStart = -1;
        }
      }
    }

    if (this.inElement && segmentStart >= 0) this.carried += text.slice(segmentStart);
    return out;
  }

  /** Call once the input is exhausted; a dangling element is a format error. */
  finish(): unknown[] {
    if (this.inElement) {
      if (this.scalar && this.carried.length > 0 && !this.inString) {
        const value = this.complete(this.carried);
        return [value];
      }
      throw new Error("Unterminated JSON array element");
    }
    return [];
  }

  private complete(tail: string): unknown {
    const text = this.carried + tail;
    this.carried = "";
    this.inElement = false;
    return JSON.parse(text);
  }
}

/** Yields every top-level element of the JSON array carried by `chunks`. */
export async function* iterateJsonArray(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<unknown, void, undefined> {
  const decoder = new StringDecoder("utf8");
  const splitter = new JsonArraySplitter();
  for await (const chunk of chunks) {
    for (const element of splitter.push(decoder.write(Buffer.from(chunk)))) yield element;
  }
  const tail = decoder.end();
  if (tail) for (const element of splitter.push(tail)) yield element;
  for (const element of splitter.finish()) yield element;
}
