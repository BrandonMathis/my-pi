export type CommandSegment = {
  language: "bash" | "ruby";
  text: string;
};

type Token = {
  value: string;
  start: number;
  end: number;
  contentStart: number;
  contentEnd: number;
  quoted: boolean;
  complete: boolean;
  operator: boolean;
};

type Range = { start: number; end: number };

/**
 * Split a Bash command into explicitly labelled Bash and inline Ruby source.
 * This deliberately understands only the small shell subset needed to find Ruby;
 * uncertain input is left as Bash so it remains safe while tool calls stream.
 */
export function parseRubyCommand(command: string): CommandSegment[] {
  try {
    const rubyRanges = findRubyHeredocRanges(command);
    for (const range of bashRanges(command.length, rubyRanges)) {
      for (const program of findRubyProgramArgumentRanges(command.slice(range.start, range.end))) {
        rubyRanges.push({ start: range.start + program.start, end: range.start + program.end });
      }
    }
    return rangesToSegments(command, rubyRanges);
  } catch {
    return [{ language: "bash", text: command }];
  }
}

function findRubyHeredocRanges(command: string): Range[] {
  const ranges: Range[] = [];
  let offset = 0;
  const lines = command.split(/(?<=\n)/);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    if (!lineHasRubyInvocation(line)) {
      offset += line.length;
      continue;
    }

    const declarations = heredocDeclarations(line);
    if (declarations.length === 0) {
      offset += line.length;
      continue;
    }

    let bodyStart = offset + line.length;
    let closingLine = lineIndex + 1;
    for (const declaration of declarations) {
      while (closingLine < lines.length) {
        const candidate = lines[closingLine]!;
        const text = candidate.endsWith("\n") ? candidate.slice(0, -1) : candidate;
        const comparable = declaration.stripTabs ? text.replace(/^\t+/, "") : text;
        if (comparable === declaration.delimiter) break;
        closingLine++;
      }
      if (closingLine >= lines.length) return ranges; // incomplete streamed heredoc

      const bodyEnd = lines.slice(lineIndex + 1, closingLine).reduce((size, value) => size + value.length, bodyStart);
      ranges.push({ start: bodyStart, end: bodyEnd });
      bodyStart = bodyEnd + lines[closingLine]!.length;
      closingLine++;
    }

    // Skip bodies and delimiters that we have conclusively matched.
    while (lineIndex < closingLine - 1) {
      offset += lines[lineIndex]!.length;
      lineIndex++;
    }
    offset += lines[lineIndex]!.length;
  }
  return ranges;
}

function heredocDeclarations(line: string): Array<{ delimiter: string; stripTabs: boolean }> {
  const declarations: Array<{ delimiter: string; stripTabs: boolean }> = [];
  const pattern = /<<(-?)(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/g;
  for (const match of line.matchAll(pattern)) {
    const delimiter = match[2] ?? match[3] ?? match[4];
    if (delimiter) declarations.push({ delimiter, stripTabs: match[1] === "-" });
  }
  return declarations;
}

function findRubyProgramArgumentRanges(source: string): Range[] {
  const tokens = tokenize(source);
  const ranges: Range[] = [];

  for (let index = 0; index < tokens.length; index++) {
    if (!isRubyExecutable(tokens, index)) continue;
    for (let cursor = index + 1; cursor < tokens.length; cursor++) {
      const token = tokens[cursor]!;
      if (token.operator) break;
      if (isProgramOption(token.value)) {
        const argument = tokens[cursor + 1];
        if (argument && !argument.operator && argument.complete) {
          // Keep shell quotes as Bash; only the code they delimit is Ruby.
          ranges.push({ start: argument.contentStart, end: argument.contentEnd });
        }
        break;
      }
    }
  }
  return ranges;
}

function isProgramOption(value: string): boolean {
  return value === "-e" || /^-[0-9A-Za-z]*e[A-Za-z]*$/.test(value);
}

function lineHasRubyInvocation(line: string): boolean {
  const tokens = tokenize(line);
  return tokens.some((_, index) => isRubyExecutable(tokens, index));
}

function isRubyExecutable(tokens: Token[], index: number): boolean {
  const token = tokens[index];
  if (!token || token.operator || token.value !== "ruby") return false;

  let start = index;
  while (start > 0 && !tokens[start - 1]!.operator) start--;
  const words = tokens.slice(start, index).filter((candidate) => !candidate.operator);
  let cursor = 0;
  while (cursor < words.length && isEnvironmentAssignment(words[cursor]!.value)) cursor++;

  if (words[cursor]?.value === "env") {
    cursor++;
    while (cursor < words.length && (/^-/.test(words[cursor]!.value) || isEnvironmentAssignment(words[cursor]!.value))) cursor++;
  }

  if (words[cursor]?.value === "bundle" && words[cursor + 1]?.value === "exec") cursor += 2;
  return cursor === words.length;
}

function isEnvironmentAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    if (/\s/.test(source[index]!)) {
      index++;
      continue;
    }
    if (source.startsWith("&&", index) || source.startsWith("||", index)) {
      tokens.push(operatorToken(source.slice(index, index + 2), index, index + 2));
      index += 2;
      continue;
    }
    if ("|;()".includes(source[index]!)) {
      tokens.push(operatorToken(source[index]!, index, index + 1));
      index++;
      continue;
    }

    const start = index;
    let value = "";
    let quoted = false;
    let complete = true;
    let contentStart = start;
    let contentEnd = start;
    let singleQuote: boolean | undefined;
    while (index < source.length) {
      if (singleQuote === undefined && (/\s/.test(source[index]!) || "|;()".includes(source[index]!) || source.startsWith("&&", index) || source.startsWith("||", index))) break;
      const character = source[index]!;
      if ((character === "'" || character === '"') && singleQuote === undefined) {
        quoted = true;
        singleQuote = character === "'";
        contentStart = index + 1;
        index++;
        continue;
      }
      if (singleQuote !== undefined && character === (singleQuote ? "'" : '"')) {
        contentEnd = index;
        singleQuote = undefined;
        index++;
        continue;
      }
      if (character === "\\" && !singleQuote && index + 1 < source.length) {
        value += source[index + 1]!;
        index += 2;
        continue;
      }
      value += character;
      index++;
    }
    if (singleQuote !== undefined) complete = false;
    if (!quoted) {
      contentStart = start;
      contentEnd = index;
    } else if (!complete) {
      contentEnd = index;
    }
    tokens.push({ value, start, end: index, contentStart, contentEnd, quoted, complete, operator: false });
  }
  return tokens;
}

function operatorToken(value: string, start: number, end: number): Token {
  return { value, start, end, contentStart: start, contentEnd: end, quoted: false, complete: true, operator: true };
}

function bashRanges(length: number, rubyRanges: Range[]): Range[] {
  const sorted = [...rubyRanges].sort((a, b) => a.start - b.start);
  const ranges: Range[] = [];
  let start = 0;
  for (const range of sorted) {
    if (start < range.start) ranges.push({ start, end: range.start });
    start = Math.max(start, range.end);
  }
  if (start < length) ranges.push({ start, end: length });
  return ranges;
}

function rangesToSegments(command: string, ranges: Range[]): CommandSegment[] {
  const sorted = ranges
    .filter((range) => range.start >= 0 && range.end >= range.start && range.end <= command.length)
    .sort((a, b) => a.start - b.start);
  const segments: CommandSegment[] = [];
  let cursor = 0;
  for (const range of sorted) {
    if (range.start < cursor) continue;
    addSegment(segments, "bash", command.slice(cursor, range.start));
    addSegment(segments, "ruby", command.slice(range.start, range.end));
    cursor = range.end;
  }
  addSegment(segments, "bash", command.slice(cursor));
  return segments.length > 0 ? segments : [{ language: "bash", text: command }];
}

function addSegment(segments: CommandSegment[], language: CommandSegment["language"], text: string): void {
  if (text === "") return;
  const previous = segments[segments.length - 1];
  if (previous?.language === language) previous.text += text;
  else segments.push({ language, text });
}
