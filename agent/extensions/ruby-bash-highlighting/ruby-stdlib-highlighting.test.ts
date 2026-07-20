import assert from "node:assert/strict";
import test from "node:test";
import {
  findRubyStandardLibraryRanges,
  overlayAnsiForeground,
  type SourceRange,
} from "./ruby-stdlib-highlighting.ts";

function references(source: string): string[] {
  return findRubyStandardLibraryRanges(source).map((range) => source.slice(range.start, range.end));
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

test("finds common core constants, stdlib constants, qualified references, and Kernel functions", () => {
  const source = [
    "puts File.read(ARGV.fetch(0))",
    "JSON.generate(Pathname.new(ENV.fetch('HOME')))",
    "Digest::SHA256.hexdigest(data)",
    "Net::HTTP.get(URI(url))",
    "warn Open3.capture3(command)",
    "Set.new(CSV.parse(input))",
  ].join("\n");

  assert.deepEqual(references(source), [
    "puts", "File", "ARGV", "JSON", "Pathname", "ENV", "Digest::SHA256", "Net::HTTP", "URI", "warn", "Open3",
    "Set", "CSV",
  ]);
});

test("covers the approved common standard-library entry points and functions", () => {
  const source = "pp YAML.load(FileUtils.read(Tempfile.new))\nprint Base64.encode64(SecureRandom.bytes)\np Logger.new\nOptionParser.new\nERB.new";
  assert.deepEqual(references(source), [
    "pp", "YAML", "FileUtils", "Tempfile", "print", "Base64", "SecureRandom", "p", "Logger", "OptionParser", "ERB",
  ]);
});

test("does not match literals, comments, symbols, sigiled names, regexes, heredocs, or partial identifiers", () => {
  const source = [
    "local = ArrayLike.new",
    "text = \"File JSON puts\"",
    "other = 'Pathname URI'",
    "command = `echo Set`",
    "symbols = [:File, :puts, :'JSON', { File: 1, puts: 2 }]",
    "sigiled = [@File, @@Pathname, $JSON]",
    "pattern = /File|JSON|puts/",
    "puts /File|JSON/",
    "matcher /Pathname|URI/",
    "percent = %q{Digest Open3 warn}",
    "# CSV YAML ERB",
    "message = <<~TEXT",
    "File JSON puts",
    "TEXT",
    "File.read(path)",
    "object.puts",
    "def warn; end",
  ].join("\n");

  assert.deepEqual(references(source), ["puts", "File"]);
});

test("distinguishes command-style regexes from spaced division", () => {
  assert.deepEqual(
    references("puts /File|JSON/\nmatcher /Pathname|URI/\nvalue / File / JSON"),
    ["puts", "File", "JSON"],
  );
});

test("handles string-like text, complete, multiple, and streamed-incomplete heredocs conservatively", () => {
  assert.deepEqual(references('text = "<<END"\nFile.read(path)'), ["File"]);
  assert.deepEqual(references("# <<END\nJSON.generate(value)"), ["JSON"]);

  const source = "values = [<<FIRST, <<~'SECOND']\nFile\nFIRST\nJSON\n  SECOND\nURI.parse(value)";
  assert.deepEqual(references(source), ["URI"]);
  assert.deepEqual(references("message = <<END\nFile\nEND\nJSON.generate(value)"), ["JSON"]);
  assert.deepEqual(references("message = <<-END\nFile\n  END\nJSON.generate(value)"), ["JSON"]);
  assert.deepEqual(references("message = <<~END\nFile\n  END\nJSON.generate(value)"), ["JSON"]);
  assert.deepEqual(references("message = <<END\nFile\n  END\nJSON.generate(value)"), []);
  assert.deepEqual(references("message = <<JSON\nFile JSON puts"), []);
});

test("does not highlight stdlib-looking components below application namespaces", () => {
  assert.deepEqual(references("MyApp::File.read\nFile::Stat.new\n::File.read"), ["File::Stat", "File"]);
});

test("ANSI overlay preserves visible source and restores the surrounding syntax foreground", () => {
  const source = "File + ArrayLike";
  const highlighted = "\x1b[31mFile + ArrayLike\x1b[39m";
  const ranges: SourceRange[] = [{ start: 0, end: 4 }];
  const output = overlayAnsiForeground(highlighted, source, ranges, (text) => `\x1b[34m${text}\x1b[39m`);

  assert.equal(stripAnsi(output), source);
  assert.equal(output, "\x1b[31m\x1b[34mFile\x1b[39m\x1b[31m + ArrayLike\x1b[39m");
});

test("ANSI overlay reapplies accent after nested syntax SGR and closes without color leakage", () => {
  const source = "JSON.parse(value)";
  const highlighted = "\x1b[36mJSON\x1b[39m.parse(\x1b[32mvalue\x1b[39m)";
  const ranges = findRubyStandardLibraryRanges(source);
  const output = overlayAnsiForeground(highlighted, source, ranges, (text) => `\x1b[38;5;99m${text}\x1b[39m`);

  assert.equal(stripAnsi(output), source);
  assert.match(output, /\x1b\[38;5;99mJSON/);
  assert.match(output, /\x1b\[39m\.parse/);
  assert.match(output, /\x1b\[32mvalue\x1b\[39m/);
  assert.ok(output.endsWith("\x1b[39m)"));
});

test("ANSI overlay returns the original highlight when visible text does not match source", () => {
  const highlighted = "\x1b[31mFile\x1b[39m";
  assert.equal(
    overlayAnsiForeground(highlighted, "Dir", [{ start: 0, end: 3 }], (text) => `\x1b[34m${text}\x1b[39m`),
    highlighted,
  );
});
