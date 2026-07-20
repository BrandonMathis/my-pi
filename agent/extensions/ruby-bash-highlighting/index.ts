import { createBashToolDefinition, highlightCode, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { parseRubyCommand } from "./parse-ruby-command.ts";
import { findRubyStandardLibraryRanges, overlayAnsiForeground } from "./ruby-stdlib-highlighting.ts";

/** Rebuilds highlighted text from raw input when Pi invalidates components (e.g. theme changes). */
class RubyBashCallComponent implements Component {
  private readonly text = new Text("", 0, 0);
  private command = "";
  private timeout: number | undefined;
  private theme: { fg(color: "toolTitle" | "muted" | "accent", text: string): string; bold(text: string): string };

  constructor(theme: RubyBashCallComponent["theme"]) {
    this.theme = theme;
  }

  setCall(command: string, timeout: number | undefined, theme: RubyBashCallComponent["theme"]): void {
    this.command = command;
    this.timeout = timeout;
    this.theme = theme;
    this.rebuild();
  }

  render(width: number): string[] {
    return this.text.render(width);
  }

  invalidate(): void {
    // highlightCode reads Pi's active theme, so this also refreshes syntax ANSI colors.
    this.rebuild();
    this.text.invalidate();
  }

  private rebuild(): void {
    const highlighted = parseRubyCommand(this.command)
      .map((segment) => {
        const syntaxHighlighted = highlightCode(segment.text, segment.language).join("\n");
        if (segment.language !== "ruby") return syntaxHighlighted;
        return overlayAnsiForeground(
          syntaxHighlighted,
          segment.text,
          findRubyStandardLibraryRanges(segment.text),
          (text) => this.theme.fg("accent", text),
        );
      })
      .join("");
    const prefix = this.theme.fg("toolTitle", this.theme.bold("$ "));
    const timeout = this.timeout ? this.theme.fg("muted", ` (timeout ${this.timeout}s)`) : "";
    this.text.setText(prefix + highlighted + timeout);
  }
}

export default function (pi: ExtensionAPI) {
  // Preserve Pi's schema, prompt metadata, executor, result renderer, and render state.
  const base = createBashToolDefinition(process.cwd());
  pi.registerTool({
    ...base,
    renderCall(args, theme, context) {
      const component = context.lastComponent instanceof RubyBashCallComponent
        ? context.lastComponent
        : new RubyBashCallComponent(theme);
      component.setCall(args.command ?? "", args.timeout, theme);
      return component;
    },
  });
}
