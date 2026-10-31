import {
  cpSync,
  rmSync,
  mkdirSync,
  existsSync,
  symlinkSync,
  mkdtempSync,
  readFileSync,
  copyFileSync,
  writeFileSync,
} from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("configuration validation follows the shared documents layout and retains safeguards", async (t) => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-config-validation-"));
  const fixture = join(temporary, "repository");
  try {
    execFileSync("git", ["-c", "core.symlinks=true", "-c", "protocol.file.allow=always", "clone", "--quiet", "--no-hardlinks", "--single-branch", root, fixture], {
      stdio: "pipe",
    });
    execFileSync("git", ["-C", fixture, "config", "submodule..agents.url", join(root, ".agents")]);
    execFileSync("git", ["-C", fixture, "config", "core.symlinks", "true"]);
    execFileSync("git", ["-C", fixture, "-c", "protocol.file.allow=always", "submodule", "update", "--init"], { stdio: "pipe" });
    // Git can create dangling directory links as file links before submodules exist on Windows.
    if (process.platform === "win32") {
      for (const name of ["skills", "subagents", "procedures"]) {
        const path = join(fixture, "agent", name);
        rmSync(path);
        symlinkSync(`../.agents/${name}`, path, "dir");
      }
    }
    // Exercise the working validator against an isolated copy of committed resources.
    for (const path of ["scripts/validate-global-config.mjs", ".gitignore", ".agents/.gitignore", ".agents/AGENTS.md", ".agents/RULES.md", "packages/pi-subagents/README.md"]) {
      copyFileSync(join(root, path), join(fixture, path));
    }
    // The local migration may not yet be committed. Overlay only migrated resource
    // directories, leaving the cloned submodule's Git metadata and HEAD unchanged.
    for (const path of [
      "skills",
      "documents",
      "procedures/babysit-pr",
      "procedures/split-to-prs",
      "procedures/delegated-code-review",
      "procedures/delegated-review-results",
    ]) {
      const source = join(root, ".agents", path);
      assert.ok(existsSync(source), `shared migration must exist before testing: ${path}`);
      rmSync(join(fixture, ".agents", path), { recursive: true, force: true });
      cpSync(source, join(fixture, ".agents", path), { recursive: true });
    }
    for (const path of ["docs", "plans", "knowledge", "memory", "NOTES.md", "procedures/git", "procedures/github", "procedures/reviews"]) {
      rmSync(join(fixture, ".agents", path), { recursive: true, force: true });
    }
    // Model a clean clone without local records or misplaced container tooling.
    const removedPaths = execFileSync("git", ["-C", fixture, "ls-files", "-z", "--", "docs/", "containers/"], { encoding: "utf8" })
      .split("\0").filter(Boolean);
    if (removedPaths.length > 0) {
      execFileSync("git", ["-C", fixture, "rm", "--cached", "--", ...removedPaths], { stdio: "pipe" });
    }
    for (const directory of ["docs", "containers"]) {
      rmSync(join(fixture, directory), { recursive: true, force: true });
    }
    // Built-in MCP needs no shared custom-client guide or category directory.
    rmSync(join(fixture, ".agents", "mcp"), { recursive: true, force: true });

    await t.test("accepts documents and flat procedures without obsolete shared categories", () => {
      assert.equal(existsSync(join(fixture, ".agents", "documents")), true);
      assert.equal(existsSync(join(fixture, ".agents", "procedures", "delegated-review-results", "delegated-review-results.md")), true);
      for (const path of ["docs", "plans", "knowledge", "memory", "NOTES.md", "procedures/git", "procedures/github", "procedures/reviews"]) {
        assert.equal(existsSync(join(fixture, ".agents", path)), false);
      }
      assert.equal(existsSync(join(fixture, "docs")), false);
      assert.equal(existsSync(join(fixture, "containers")), false);
      assert.equal(existsSync(join(fixture, ".agents", "mcp")), false);
      const result = validate(fixture);
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /32 global skills/);
    });
    await t.test("artifact boundary: local paths stay ignored in the owning submodule", () => {
      withChangedFile(fixture, ".agents/.gitignore",
        (text) => text.replace(/^\/artifacts\/\r?\n/gm, ""), () => {
          const result = validate(fixture);
          assert.equal(result.status, 1, result.output);
          for (const probe of ["artifacts/probe.md", "artifacts/plans/probe.md", "artifacts/documents/probe.md"]) {
            assert.ok(result.output.includes(`expected shared artifact ignore is not covered: ${probe}`), result.output);
          }
        });
    });
    await t.test("artifact boundary: selective ignore exceptions do not expose local files", () => {
      const probe = join(fixture, ".agents", "artifacts", "exposed", "private-artifact.md");
      mkdirSync(dirname(probe), { recursive: true });
      writeFileSync(probe, "Local output\n");
      try {
        withChangedFile(fixture, ".agents/.gitignore",
          (text) => text.replace(/^\/artifacts\/\r?\n/gm, "/artifacts/*\n!/artifacts/exposed/\n"), () => {
            const result = validate(fixture);
            assert.equal(result.status, 1, result.output);
            assert.ok(result.output.includes("shared local artifacts must remain ignored"), result.output);
            assert.equal(result.output.includes("expected shared artifact ignore is not covered"), false, result.output);
            assert.equal(result.output.includes("private-artifact.md"), false);
          });
      } finally {
        rmSync(join(fixture, ".agents", "artifacts"), { recursive: true, force: true });
      }
    });
    await t.test("artifact boundary: force-added local files cannot become shared content", () => {
      const shared = join(fixture, ".agents");
      const probe = join(shared, "artifacts", "private-artifact.md");
      mkdirSync(dirname(probe), { recursive: true });
      writeFileSync(probe, "Local output\n");
      try {
        execFileSync("git", ["-C", shared, "add", "--force", "--", "artifacts/private-artifact.md"], { stdio: "pipe" });
        const result = validate(fixture);
        assert.equal(result.status, 1, result.output);
        assert.ok(result.output.includes("shared local artifacts must remain untracked"), result.output);
        assert.equal(result.output.includes("private-artifact.md"), false);
      } finally {
        execFileSync("git", ["-C", shared, "rm", "--cached", "--", "artifacts/private-artifact.md"], { stdio: "pipe" });
        rmSync(join(shared, "artifacts"), { recursive: true, force: true });
      }
    });
    for (const path of ["RULES.md", "documents/index.md"]) {
      await t.test(`requires shared discovery file ${path}`, () => {
        withChangedFile(fixture, `.agents/${path}`, () => undefined, () => {
          assertFailure(fixture, `shared discovery file is missing: ${path}`);
        });
      });
    }
    await t.test("rejects a missing documents category", () => {
      const documents = join(fixture, ".agents", "documents");
      rmSync(documents, { recursive: true });
      try {
        assertFailure(fixture, "shared resource category is missing: documents");
      } finally {
        cpSync(join(root, ".agents", "documents"), documents, { recursive: true });
      }
    });
    for (const path of ["docs", "plans", "knowledge", "memory", "NOTES.md", "procedures/git", "procedures/github", "procedures/reviews"]) {
      await t.test(`rejects obsolete shared directory ${path}`, () => {
        const obsoleteDirectory = join(fixture, ".agents", path);
        if (path.endsWith(".md")) writeFileSync(obsoleteDirectory, "# Retired notes\n");
        else mkdirSync(obsoleteDirectory, { recursive: true });
        try {
          assertFailure(fixture, `obsolete shared resource directory must be absent: ${path}`);
        } finally {
          rmSync(obsoleteDirectory, { recursive: true });
        }
      });
    }
    await t.test("requires lifecycle guidance in the flat delegated review procedure", () => {
      withChangedFile(fixture, ".agents/procedures/delegated-review-results/delegated-review-results.md",
        (text) => text.replaceAll("new envelope ID", "previous envelope ID"), () => {
          assertFailure(fixture, "delegated-review-results is missing current lifecycle guidance: new envelope ID");
        });
    });
    await t.test("requires legacy local documentation to remain ignored", () => {
      withChangedFile(fixture, ".gitignore",
        (text) => text.replace(/^\/docs\/\r?\n/gm, ""), () => {
          assertFailure(fixture, "expected ignored path is not covered: docs/probe.md");
          assertFailure(fixture, "expected ignored path is not covered: docs/legacy-probe.md");
        });
    });
    await t.test("rejects forcibly tracked legacy local documentation", () => {
      const probe = join(fixture, "docs", "probe.md");
      mkdirSync(dirname(probe), { recursive: true });
      writeFileSync(probe, "# Local investigation record\n");
      try {
        execFileSync("git", ["-C", fixture, "add", "--force", "--", "docs/probe.md"], { stdio: "pipe" });
        assertFailure(fixture, "project-only documentation must remain untracked: docs/probe.md");
      } finally {
        execFileSync("git", ["-C", fixture, "rm", "--cached", "--", "docs/probe.md"], { stdio: "pipe" });
        rmSync(join(fixture, "docs"), { recursive: true, force: true });
      }
    });
    await t.test("requires built-in MCP credentials to remain ignored in both layouts", () => {
      withChangedFile(fixture, ".gitignore",
        (text) => text.replace(/^\/(?:agent\/)?mcp-auth\.json\*\r?\n/gm, ""), () => {
          assertFailure(fixture, "expected ignored path is not covered: mcp-auth.json");
          assertFailure(fixture, "expected ignored path is not covered: agent/mcp-auth.json");
        });
    });
    await t.test("requires rotated MCP logs to remain ignored in both layouts", () => {
      withChangedFile(fixture, ".gitignore",
        (text) => text.replace(/^\/(?:agent\/)?mcp\.log\*\r?\n/gm, ""), () => {
          assertFailure(fixture, "expected ignored path is not covered: mcp.log.1");
          assertFailure(fixture, "expected ignored path is not covered: agent/mcp.log.1");
        });
    });
    await t.test("requires maintained package documentation for await outcomes", () => {
      withChangedFile(fixture, "packages/pi-subagents/README.md",
        (text) => text.replaceAll("outcomes", "results"), () => {
          assertFailure(fixture, "Pi Subagents package documentation is missing: outcomes");
        });
    });
    await t.test("rejects removal of the independent-review requirement", () => {
      withChangedFile(fixture, ".agents/skills/github-issue-maintenance/SKILL.md",
        (text) => text.replace("Do not bypass review to publish", "Review is optional"), () => {
          assertFailure(fixture, "Do not bypass review to publish");
        });
    });
    await t.test("rejects removal of runtime retirement verification", () => {
      withChangedFile(fixture, ".agents/skills/github-issue-maintenance/references/pi-runtime.md",
        (text) => text.replace("absence alone is not proof", "absence is sufficient"), () => {
          assertFailure(fixture, "absence alone is not proof");
        });
    });
    await t.test("rejects a missing runtime adapter", () => {
      withChangedFile(fixture, ".agents/skills/github-issue-maintenance/references/pi-runtime.md",
        () => undefined, () => {
          assertFailure(fixture, "cannot read required guidance .agents/skills/github-issue-maintenance/references/pi-runtime.md");
        });
    });
    await t.test("rejects a missing authorization regression scenario", () => {
      withChangedFile(fixture, ".agents/skills/github-issue-maintenance/evals/evals.json", (text) => {
        const suite = JSON.parse(text);
        suite.evals = suite.evals.filter((item) => item.id !== 21);
        return JSON.stringify(suite);
      }, () => assertFailure(fixture, "github-issue-maintenance eval IDs"));
    });
    await t.test("rejects the old Plan skill name in runtime discovery", () => {
      withChangedFile(fixture, "packages/pi-plan/extensions/plan/index.ts",
        (text) => text.replace('const PLAN_SKILL_NAME = "pi-plan-mode";', 'const PLAN_SKILL_NAME = "plan";'), () => {
          assertFailure(fixture, 'const PLAN_SKILL_NAME = "pi-plan-mode";');
        });
    });
    await t.test("rejects a submodule configured for the wrong repository", () => {
      withChangedFile(fixture, ".gitmodules",
        (text) => text.replace("voidverse-xyz/.agents.git", "example/wrong.git"), () => {
          assertFailure(fixture, ".agents submodule configuration must use the shared repository");
        });
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

function assertFailure(fixture, message) {
  const result = validate(fixture);
  assert.equal(result.status, 1, result.output);
  assert.ok(result.output.includes(message), result.output);
}

function validate(fixture) {
  const result = spawnSync(process.execPath, [join(fixture, "scripts/validate-global-config.mjs")], {
    cwd: fixture,
    encoding: "utf8",
  });
  assert.ifError(result.error);
  return { status: result.status, output: result.stdout + result.stderr };
}

function withChangedFile(fixture, relativePath, transform, check) {
  const path = join(fixture, relativePath);
  const original = readFileSync(path, "utf8");
  const changed = transform(original);
  assert.notEqual(changed, original, `mutation must change ${relativePath}`);
  try {
    if (changed === undefined) rmSync(path);
    else writeFileSync(path, changed);
    check();
  } finally {
    writeFileSync(path, original);
  }
}
