import assert from "node:assert/strict";
import test from "node:test";
import { parseRubyCommand } from "./parse-ruby-command.ts";

function languages(command: string): string[] {
  return parseRubyCommand(command).map((segment) => segment.language);
}

function rubyText(command: string): string {
  return parseRubyCommand(command)
    .filter((segment) => segment.language === "ruby")
    .map((segment) => segment.text)
    .join("");
}

test("highlights a simple ruby -e argument without consuming shell quotes", () => {
  const command = "ruby -e 'puts ENV[\"PATH\"]'";
  assert.deepEqual(languages(command), ["bash", "ruby", "bash"]);
  assert.equal(rubyText(command), 'puts ENV["PATH"]');
});

test("supports multiline Ruby program arguments and combined executable flags", () => {
  for (const option of ["-e", "-ne", "-pe", "-0ne"]) {
    const command = `ruby ${option} '\n  puts $_\n'`;
    assert.equal(rubyText(command), "\n  puts $_\n", option);
  }
});

test("highlights a Ruby heredoc while retaining its declaration and delimiter as Bash", () => {
  const command = "ROOT=\"$root\" ruby <<'RUBY'\nrequire \"find\"\nputs ENV.fetch(\"ROOT\")\nRUBY";
  const segments = parseRubyCommand(command);
  assert.deepEqual(segments.map((segment) => segment.language), ["bash", "ruby", "bash"]);
  assert.equal(segments[1]?.text, 'require "find"\nputs ENV.fetch("ROOT")\n');
  assert.equal(segments[0]?.text.endsWith("\n"), true);
  assert.equal(segments[2]?.text, "RUBY");
});

test("supports tab-stripped and multiple Ruby heredocs", () => {
  const command = "ruby <<-FIRST\n\tputs :first\n\tFIRST\nruby <<'SECOND'\nputs :second\nSECOND";
  assert.equal(rubyText(command), "\tputs :first\nputs :second\n");
  assert.equal(languages(command).filter((language) => language === "ruby").length, 2);
});

test("finds Ruby in pipelines, compound commands, bundle exec, and env wrappers", () => {
  const cases = [
    "find . -print0 | ruby -0ne 'puts $_' | sort",
    "false || bundle exec ruby -e 'puts RUBY_VERSION' && true",
    "env ROOT=\"$root\" ruby -e 'puts ENV.fetch(\"ROOT\")'",
  ];
  for (const command of cases) assert.ok(rubyText(command).length > 0, command);
});

test("does not treat non-Ruby heredocs, mentions, or Ruby script filenames as inline Ruby", () => {
  for (const command of [
    "cat <<'RUBY'\nputs :not_ruby\nRUBY",
    "echo ruby -e 'puts :not_ruby'",
    "ruby script.rb",
  ]) {
    assert.deepEqual(languages(command), ["bash"], command);
  }
});

test("falls back conservatively for incomplete streamed input", () => {
  for (const command of [
    "ruby -e 'puts :partial",
    "ruby <<'RUBY'\nputs :partial\n",
  ]) {
    assert.deepEqual(languages(command), ["bash"], command);
  }
});

test("preserves every source character", () => {
  const command = "printf before && ruby -ne '\n  puts $_\n' || ruby <<RUBY\nputs :done\nRUBY";
  assert.equal(parseRubyCommand(command).map((segment) => segment.text).join(""), command);
});
