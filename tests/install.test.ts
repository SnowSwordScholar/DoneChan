import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planZcodeInstall,
  codexSkillSourceFile,
  buildZcodeHooks,
  mergeHooks,
  isDoneChanHook,
} from "../src/install.js";
import { resolveTags, testNotification } from "../src/notification/presets.js";
import { opencodePluginSource } from "../src/agent/opencode.js";

function tempConfig(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "donechan-install-"));
  const file = join(dir, "config.json");
  if (content !== undefined) writeFileSync(file, JSON.stringify(content, null, 2));
  return file;
}

describe("planZcodeInstall", () => {
  it("plans a create when the config file is missing", () => {
    const plan = planZcodeInstall(join(tmpdir(), "donechan-nonexistent", "config.json"));
    expect(plan.fileExists).toBe(false);
    expect(plan.existing).toBe("none");
    expect(plan.conflictingStopHook).toBe(false);
  });

  it("detects a previous donechan install with its version", () => {
    const file = tempConfig({
      hooks: {
        enabled: true,
        events: {
          Stop: [
            { hooks: [{ _donechan: { version: "0.1.0" }, type: "process", command: "node" }] },
          ],
        },
      },
    });
    const plan = planZcodeInstall(file);
    expect(plan.existing).toBe("marked");
    expect(plan.existingVersion).toBe("0.1.0");
    expect(plan.conflictingStopHook).toBe(false);
  });

  it("recognizes legacy unmarked donechan hooks by shape (no false conflict)", () => {
    const file = tempConfig({
      hooks: {
        enabled: true,
        events: {
          Stop: [
            { hooks: [{ type: "process", command: "node", args: ["C:\\...\\donechan\\dist\\cli.js", "hook"] }] },
          ],
        },
      },
    });
    const plan = planZcodeInstall(file);
    expect(plan.existing).toBe("legacy");
    expect(plan.conflictingStopHook).toBe(false);
  });

  it("flags foreign Stop hooks as conflicts", () => {
    const file = tempConfig({
      hooks: {
        events: {
          Stop: [{ hooks: [{ type: "command", command: "someone-else" }] }],
        },
      },
    });
    const plan = planZcodeInstall(file);
    expect(plan.existing).toBe("none");
    expect(plan.conflictingStopHook).toBe(true);
  });

  it("flags invalid JSON as unknown instead of planning an overwrite", () => {
    const dir = mkdtempSync(join(tmpdir(), "donechan-install-"));
    const file = join(dir, "config.json");
    writeFileSync(file, "{ not json !!!");
    const plan = planZcodeInstall(file);
    expect(plan.existing).toBe("unknown");
  });
});

describe("Codex skill source", () => {
  it("resolves the dedicated Codex skill source", () => {
    const source = codexSkillSourceFile(join(process.cwd(), "dist", "cli.js"));
    expect(source).toContain("donechan-notify-codex");
  });
});

describe("isDoneChanHook", () => {
  it("matches marked hooks, legacy shapes, and rejects others", () => {
    expect(isDoneChanHook({ _donechan: { version: "1" } })).toBe(true);
    expect(isDoneChanHook({ type: "process", command: "node", args: ["/x/donechan/dist/cli.js", "hook"] })).toBe(true);
    expect(isDoneChanHook({ type: "command", command: "node '/x/donechan/cli.js' hook" })).toBe(true);
    expect(isDoneChanHook({ type: "command", command: "some-other-tool" })).toBe(false);
    expect(isDoneChanHook({ type: "command", command: "donechan-helper run" })).toBe(false);
  });
});

describe("mergeHooks", () => {
  it("creates hooks on an empty root and forces enabled:true", () => {
    const merged = mergeHooks({}, buildZcodeHooks("entry.js", "9.9.9"));
    const hooks = merged.hooks as { enabled: boolean; events: { Stop: unknown[] } };
    expect(hooks.enabled).toBe(true);
    expect(hooks.events.Stop).toHaveLength(1);
  });

  it("preserves foreign Stop groups and replaces only donechan ones", () => {
    const root = {
      provider: "x",
      hooks: {
        enabled: false,
        events: {
          Stop: [
            { hooks: [{ type: "command", command: "foreign" }] },
            { hooks: [{ _donechan: { version: "0.1.0" }, type: "process" }] },
          ],
          PostToolUse: [{ hooks: [{ type: "command", command: "keep-me" }] }],
        },
      },
    };
    const merged = mergeHooks(root, buildZcodeHooks("entry.js", "0.2.0"));
    const hooks = merged.hooks as {
      enabled: boolean;
      events: { Stop: { hooks: Record<string, unknown>[] }[]; PostToolUse: unknown[] };
    };
    expect(hooks.enabled).toBe(true); // forced on — config hooks are disabled by default
    expect(hooks.events.Stop).toHaveLength(2);
    expect(hooks.events.Stop[0]!.hooks[0]!.command).toBe("foreign"); // untouched
    expect(hooks.events.Stop[1]!.hooks[0]!._donechan).toMatchObject({ version: "0.2.0" }); // upgraded
    expect(hooks.events.PostToolUse).toHaveLength(1); // other events untouched
    expect((merged as { provider?: string }).provider).toBe("x"); // unrelated keys untouched
  });
});

describe("opencode plugin source", () => {
  it("embeds the entry path safely and handles session.idle", () => {
    const src = opencodePluginSource("/opt/my tools/cli.js", "0.2.0");
    expect(src).toContain('"session.idle"');
    expect(src).toContain('"/opt/my tools/cli.js"');
    expect(src).toContain("last_assistant_message");
    expect(src).toContain("source_agent");
  });
  it("redirects stdin inside the Bun shell template (outside `<` is a JS comparison)", () => {
    const src = opencodePluginSource("/opt/cli.js", "0.2.0");
    expect(src).toContain("hook < ${Buffer.from(payload)}`.quiet()");
    // The template must close after the redirect, with no dangling `<` outside.
    expect(src).not.toMatch(/hook` < /);
  });
});

describe("resolveTags", () => {
  it("always carries the agent tag, never AI tags by default", () => {
    expect(resolveTags("zcode")).toBe("ZCode");
    expect(resolveTags("zcode", undefined, "后端|bugfix", false)).toBe("ZCode");
    expect(resolveTags("codex-legacy")).toBe("Codex");
    expect(resolveTags("claude")).toBe("ClaudeCode");
  });
  it("appends configured static tags after the agent tag", () => {
    expect(resolveTags("zcode", "dev|urgent", undefined, false)).toBe("ZCode|dev|urgent");
  });
  it("lets AI marker tags through only when marker_tags_enabled is on", () => {
    expect(resolveTags("zcode", "dev", "后端|bugfix", true)).toBe("ZCode|后端|bugfix");
  });
});

describe("testNotification preset", () => {
  it("is bilingual and branded", () => {
    const n = testNotification();
    expect(n.title).toContain("DoneChan");
    expect(n.body).toContain("奴才来了");
    expect(n.body).toContain("[EN]");
    expect(n.tags).toBe("DoneChan");
  });
  it("keeps the body minimal — exactly the greeting, nothing else", () => {
    const n = testNotification();
    expect(n.body).not.toContain("员工");
    expect(n.body).not.toContain("---");
  });
});
