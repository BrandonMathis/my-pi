export type SourceRange = { start: number; end: number };

type AccentFormatter = (text: string) => string;

const STANDARD_LIBRARY_CONSTANTS = new Set([
  // Ruby core and process constants commonly used in one-off scripts.
  "ARGF", "ARGV", "Array", "BasicObject", "Binding", "Class", "Complex", "DATA", "Dir", "ENV",
  "Encoding", "Enumerator", "Exception", "Fiber", "File", "Float", "GC", "Hash", "IO", "Integer",
  "Kernel", "MatchData", "Method", "Module", "Mutex", "NilClass", "Numeric", "Object", "Proc", "Process",
  "Queue", "RUBY_COPYRIGHT", "RUBY_DESCRIPTION", "RUBY_ENGINE", "RUBY_ENGINE_VERSION", "RUBY_PATCHLEVEL",
  "RUBY_PLATFORM", "RUBY_RELEASE_DATE", "RUBY_REVISION", "RUBY_VERSION", "Random", "Range", "Rational",
  "Regexp", "RubyVM", "STDERR", "STDIN", "STDOUT", "Signal", "SizedQueue", "String", "Struct", "Symbol",
  "TOPLEVEL_BINDING", "Thread", "ThreadGroup", "Time", "TracePoint", "TrueClass", "FalseClass", "UnboundMethod",

  // Common require-able standard-library entry points.
  "Abbrev", "Base64", "Benchmark", "BigDecimal", "CGI", "CSV", "Date", "DateTime", "Delegate", "Digest",
  "English", "ERB", "Etc", "FileUtils", "Find", "Forwardable", "IPAddr", "JSON", "Logger", "Matrix", "Monitor",
  "Net", "Open3", "OpenSSL", "OptionParser", "PP", "Pathname", "Prime", "REXML", "Resolv", "SecureRandom",
  "Set", "Shellwords", "Singleton", "StringIO", "Tempfile", "Timeout", "URI", "YAML", "Zlib",
]);

const KERNEL_FUNCTIONS = new Set([
  "abort", "at_exit", "autoload", "autoload?", "binding", "block_given?", "caller", "caller_locations", "catch",
  "eval", "exec", "exit", "exit!", "fail", "fork", "format", "gets", "global_variables", "lambda", "load",
  "local_variables", "loop", "open", "p", "pp", "print", "printf", "proc", "putc", "puts", "raise", "rand",
  "readline", "readlines", "require", "require_relative", "select", "sleep", "spawn", "sprintf", "srand",
  "syscall", "system", "test", "throw", "trace_var", "trap", "untrace_var", "warn",
]);

const REGEX_PREFIX_WORDS = new Set([
  "and", "begin", "break", "case", "do", "else", "elsif", "ensure", "for", "if", "in", "next", "not",
  "or", "redo", "rescue", "retry", "return", "then", "throw", "unless", "until", "when", "while", "yield",
]);

/** Find common Ruby core/stdlib references while conservatively skipping literal and comment bodies. */
export function findRubyStandardLibraryRanges(source: string): SourceRange[] {
  const excluded = findHeredocExcludedRanges(source);
  const ranges: SourceRange[] = [];
  let index = 0;
  let excludedIndex = 0;
  let previousWord: string | undefined;

  while (index < source.length) {
    while (excludedIndex < excluded.length && excluded[excludedIndex]!.end <= index) excludedIndex++;
    const excludedRange = excluded[excludedIndex];
    if (excludedRange && index >= excludedRange.start && index < excludedRange.end) {
      index = excludedRange.end;
      previousWord = undefined;
      continue;
    }

    if (source.startsWith("=begin", index) && isLineStart(source, index)) {
      index = skipBlockComment(source, index);
      previousWord = undefined;
      continue;
    }

    const character = source[index]!;
    if (character === "#") {
      index = skipLine(source, index);
      previousWord = undefined;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      index = skipDelimited(source, index, character, character);
      previousWord = undefined;
      continue;
    }

    const percentEnd = percentLiteralEnd(source, index);
    if (percentEnd !== undefined) {
      index = percentEnd;
      previousWord = undefined;
      continue;
    }

    if (character === "/" && looksLikeRegexStart(source, index, previousWord)) {
      index = skipRegex(source, index);
      previousWord = undefined;
      continue;
    }

    if (isIdentifierStart(character)) {
      const start = index;
      index++;
      while (index < source.length && isIdentifierPart(source[index]!)) index++;
      if ((source[index] === "?" || source[index] === "!") && source[index + 1] !== "=") index++;
      const word = source.slice(start, index);

      if (isConstantName(word)) {
        const qualified = qualifiedConstantRange(source, start, index);
        if (
          STANDARD_LIBRARY_CONSTANTS.has(word)
          && !isSymbolIdentifier(source, start, qualified.end)
          && !isSigiledIdentifier(source, start)
          && !isNestedConstantComponent(source, start)
        ) {
          ranges.push(qualified);
          index = qualified.end;
        }
      } else if (
        KERNEL_FUNCTIONS.has(word)
        && !isSymbolIdentifier(source, start, index)
        && !isSigiledIdentifier(source, start)
        && isBareFunctionReference(source, start, previousWord)
      ) {
        ranges.push({ start, end: index });
      }
      previousWord = word;
      continue;
    }

    if (!/\s/.test(character) && character !== ":") previousWord = undefined;
    index++;
  }

  return mergeRanges(ranges);
}

/** Overlay an accent foreground on source ranges without losing the highlighter's surrounding foreground. */
export function overlayAnsiForeground(
  highlighted: string,
  source: string,
  ranges: SourceRange[],
  accent: AccentFormatter,
): string {
  const normalizedRanges = mergeRanges(
    ranges.filter((range) => range.start >= 0 && range.end > range.start && range.end <= source.length),
  );
  if (normalizedRanges.length === 0) return highlighted;

  const marker = "\u{F0000}";
  const formattedMarker = accent(marker);
  const markerIndex = formattedMarker.indexOf(marker);
  if (markerIndex === -1) return highlighted;
  const accentStart = formattedMarker.slice(0, markerIndex);
  const accentEnd = formattedMarker.slice(markerIndex + marker.length);
  if (accentStart === "" && accentEnd === "") return highlighted;

  let output = "";
  let highlightedIndex = 0;
  let sourceIndex = 0;
  let rangeIndex = 0;
  let accented = false;
  let baseForeground = "";

  const syncAccent = (): void => {
    while (rangeIndex < normalizedRanges.length && normalizedRanges[rangeIndex]!.end <= sourceIndex) rangeIndex++;
    const range = normalizedRanges[rangeIndex];
    const shouldAccent = Boolean(range && sourceIndex >= range.start && sourceIndex < range.end);
    if (shouldAccent === accented) return;
    if (shouldAccent) output += accentStart;
    else output += accentEnd + baseForeground;
    accented = shouldAccent;
  };

  while (highlightedIndex < highlighted.length) {
    const ansi = ansiSequenceAt(highlighted, highlightedIndex);
    if (ansi) {
      output += ansi;
      baseForeground = foregroundAfterSgr(ansi, baseForeground);
      if (accented && ansi.endsWith("m")) output += accentStart;
      highlightedIndex += ansi.length;
      continue;
    }

    syncAccent();
    const codePoint = highlighted.codePointAt(highlightedIndex)!;
    const character = String.fromCodePoint(codePoint);
    output += character;
    highlightedIndex += character.length;

    const expected = source.slice(sourceIndex, sourceIndex + character.length);
    if (expected === character) sourceIndex += character.length;
    else return highlighted; // Never risk corrupt styling if visible text diverges from the source.
  }

  syncAccent();
  return sourceIndex === source.length ? output : highlighted;
}

function findHeredocExcludedRanges(source: string): SourceRange[] {
  const ranges: SourceRange[] = [];
  let index = 0;
  let previousWord: string | undefined;
  let declarations: Array<{ delimiter: string; allowIndent: boolean; start: number; end: number; scanEnd: number }> = [];

  while (index < source.length) {
    if (source.startsWith("=begin", index) && isLineStart(source, index)) {
      index = skipBlockComment(source, index);
      previousWord = undefined;
      continue;
    }

    const character = source[index]!;
    if (character === "#") {
      const nextLine = skipLine(source, index);
      if (declarations.length > 0) {
        const consumed = consumeHeredocBodies(source, nextLine, declarations);
        ranges.push(...consumed.ranges);
        index = consumed.end;
        declarations = [];
      } else {
        index = nextLine;
      }
      previousWord = undefined;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      index = skipDelimited(source, index, character, character);
      previousWord = undefined;
      continue;
    }

    const percentEnd = percentLiteralEnd(source, index);
    if (percentEnd !== undefined) {
      index = percentEnd;
      previousWord = undefined;
      continue;
    }

    if (character === "/" && looksLikeRegexStart(source, index, previousWord)) {
      index = skipRegex(source, index);
      previousWord = undefined;
      continue;
    }

    const declaration = heredocDeclarationAt(source, index);
    if (declaration) {
      declarations.push(declaration);
      ranges.push({ start: declaration.start, end: declaration.end });
      index = declaration.scanEnd;
      previousWord = undefined;
      continue;
    }

    if (character === "\n" && declarations.length > 0) {
      const consumed = consumeHeredocBodies(source, index + 1, declarations);
      ranges.push(...consumed.ranges);
      index = consumed.end;
      declarations = [];
      previousWord = undefined;
      continue;
    }

    if (isIdentifierStart(character)) {
      const start = index++;
      while (index < source.length && isIdentifierPart(source[index]!)) index++;
      previousWord = source.slice(start, index);
      continue;
    }

    if (!/\s/.test(character) && character !== ":") previousWord = undefined;
    index++;
  }

  if (declarations.length > 0) {
    const consumed = consumeHeredocBodies(source, source.length, declarations);
    ranges.push(...consumed.ranges);
  }
  return mergeRanges(ranges);
}

function heredocDeclarationAt(
  source: string,
  index: number,
): { delimiter: string; allowIndent: boolean; start: number; end: number; scanEnd: number } | undefined {
  if (!source.startsWith("<<", index)) return undefined;
  const match = source.slice(index).match(/^<<[-~]?(?:'([^'\n]+)'|"([^"\n]+)"|`([^`\n]+)`|([A-Za-z_][A-Za-z0-9_]*))/);
  if (!match) return undefined;
  const delimiter = match[1] ?? match[2] ?? match[3] ?? match[4];
  if (!delimiter) return undefined;
  const start = index + match[0]!.lastIndexOf(delimiter);
  const allowIndent = match[0]!.startsWith("<<-") || match[0]!.startsWith("<<~");
  return { delimiter, allowIndent, start, end: start + delimiter.length, scanEnd: index + match[0]!.length };
}

function consumeHeredocBodies(
  source: string,
  bodyStart: number,
  declarations: Array<{ delimiter: string; allowIndent: boolean }>,
): { ranges: SourceRange[]; end: number } {
  const ranges: SourceRange[] = [];
  let cursor = bodyStart;

  for (const declaration of declarations) {
    let lineStart = cursor;
    let found = false;
    while (lineStart < source.length) {
      const newline = source.indexOf("\n", lineStart);
      const lineEnd = newline === -1 ? source.length : newline;
      const candidate = source.slice(lineStart, lineEnd).replace(/\r$/, "");
      const terminator = declaration.allowIndent ? candidate.trimStart() : candidate;
      if (terminator === declaration.delimiter) {
        const terminatorEnd = newline === -1 ? lineEnd : newline + 1;
        ranges.push({ start: cursor, end: terminatorEnd });
        cursor = terminatorEnd;
        found = true;
        break;
      }
      lineStart = newline === -1 ? source.length : newline + 1;
    }
    if (!found) {
      ranges.push({ start: cursor, end: source.length });
      return { ranges, end: source.length };
    }
  }

  return { ranges, end: cursor };
}

function skipBlockComment(source: string, start: number): number {
  const match = /(?:^|\n)=end(?:\s|$)/g;
  match.lastIndex = start + "=begin".length;
  const end = match.exec(source);
  return end ? skipLine(source, end.index + (end[0]!.startsWith("\n") ? 1 : 0)) : source.length;
}

function skipLine(source: string, start: number): number {
  const newline = source.indexOf("\n", start);
  return newline === -1 ? source.length : newline + 1;
}

function skipDelimited(source: string, start: number, open: string, close: string): number {
  const paired = open !== close;
  let depth = 1;
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (paired && source[index] === open) depth++;
    else if (source[index] === close && --depth === 0) return index + 1;
    index++;
  }
  return source.length;
}

function percentLiteralEnd(source: string, index: number): number | undefined {
  if (source[index] !== "%") return undefined;
  const match = source.slice(index).match(/^%(?:[qQrwxsiIW])?([^A-Za-z0-9\s])/);
  if (!match) return undefined;
  const open = match[1]!;
  const close = ({ "(": ")", "[": "]", "{": "}", "<": ">" } as Record<string, string>)[open] ?? open;
  return skipDelimited(source, index + match[0]!.length - 1, open, close);
}

function looksLikeRegexStart(source: string, index: number, previousWord: string | undefined): boolean {
  if (/\s/.test(source[index + 1] ?? "") || source[index + 1] === "/" || source[index + 1] === "=" || !hasRegexTerminator(source, index)) return false;
  if (previousWord && REGEX_PREFIX_WORDS.has(previousWord)) return true;
  let cursor = index - 1;
  while (cursor >= 0 && /[ \t]/.test(source[cursor]!)) cursor--;
  if (cursor < 0 || "=([{,:;!&|?~>".includes(source[cursor]!)) return true;
  const separatedFromPrevious = cursor < index - 1;
  return Boolean(separatedFromPrevious && previousWord && /^[a-z_]/.test(previousWord));
}

function hasRegexTerminator(source: string, start: number): boolean {
  let index = start + 1;
  let inCharacterClass = false;
  while (index < source.length && source[index] !== "\n") {
    if (source[index] === "\\") index += 2;
    else {
      if (source[index] === "[") inCharacterClass = true;
      else if (source[index] === "]") inCharacterClass = false;
      else if (source[index] === "/" && !inCharacterClass) return true;
      index++;
    }
  }
  return false;
}

function skipRegex(source: string, start: number): number {
  let index = start + 1;
  let inCharacterClass = false;
  while (index < source.length) {
    const character = source[index]!;
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "\n") return index;
    if (character === "[") inCharacterClass = true;
    else if (character === "]") inCharacterClass = false;
    else if (character === "/" && !inCharacterClass) {
      index++;
      while (index < source.length && /[a-z]/i.test(source[index]!)) index++;
      return index;
    }
    index++;
  }
  return source.length;
}

function qualifiedConstantRange(source: string, start: number, end: number): SourceRange {
  let cursor = end;
  while (source.startsWith("::", cursor)) {
    const componentStart = cursor + 2;
    if (!isIdentifierStart(source[componentStart] ?? "") || !isConstantName(source[componentStart]!)) break;
    cursor = componentStart + 1;
    while (cursor < source.length && isIdentifierPart(source[cursor]!)) cursor++;
  }
  return { start, end: cursor };
}

function isSymbolIdentifier(source: string, start: number, end: number): boolean {
  const prefixSymbol = source[start - 1] === ":" && source[start - 2] !== ":";
  const labelSymbol = source[end] === ":" && source[end + 1] !== ":";
  return prefixSymbol || labelSymbol;
}

function isSigiledIdentifier(source: string, start: number): boolean {
  return source[start - 1] === "@" || source[start - 1] === "$";
}

function isNestedConstantComponent(source: string, start: number): boolean {
  if (source.slice(start - 2, start) !== "::") return false;
  return start >= 3 && isIdentifierPart(source[start - 3]!);
}

function isBareFunctionReference(source: string, start: number, previousWord: string | undefined): boolean {
  if (previousWord === "def" || previousWord === "alias" || previousWord === "undef") return false;
  let cursor = start - 1;
  while (cursor >= 0 && /\s/.test(source[cursor]!)) cursor--;
  if (cursor < 0) return true;
  return source[cursor] !== "." && source[cursor] !== ":" && source[cursor] !== "@";
}

function ansiSequenceAt(text: string, index: number): string | undefined {
  if (text[index] !== "\x1b") return undefined;
  const match = text.slice(index).match(/^\x1b\[[0-?]*[ -/]*[@-~]/);
  return match?.[0];
}

function foregroundAfterSgr(sequence: string, current: string): string {
  if (!sequence.endsWith("m")) return current;
  const parameters = sequence.slice(2, -1).split(";").map((value) => value === "" ? 0 : Number(value));
  let foreground = current;
  for (let index = 0; index < parameters.length; index++) {
    const parameter = parameters[index]!;
    if (parameter === 0 || parameter === 39) foreground = "";
    else if ((parameter >= 30 && parameter <= 37) || (parameter >= 90 && parameter <= 97)) {
      foreground = `\x1b[${parameter}m`;
    } else if (parameter === 38 && parameters[index + 1] === 5 && parameters[index + 2] !== undefined) {
      foreground = `\x1b[38;5;${parameters[index + 2]}m`;
      index += 2;
    } else if (parameter === 38 && parameters[index + 1] === 2 && parameters.slice(index + 2, index + 5).length === 3) {
      foreground = `\x1b[38;2;${parameters.slice(index + 2, index + 5).join(";")}m`;
      index += 4;
    }
  }
  return foreground;
}

function mergeRanges(ranges: SourceRange[]): SourceRange[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: SourceRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function isLineStart(source: string, index: number): boolean {
  return index === 0 || source[index - 1] === "\n";
}

function isIdentifierStart(character: string): boolean {
  return /[A-Za-z_]/.test(character);
}

function isIdentifierPart(character: string): boolean {
  return /[A-Za-z0-9_]/.test(character);
}

function isConstantName(word: string): boolean {
  return /^[A-Z]/.test(word);
}
