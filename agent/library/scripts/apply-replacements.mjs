#!/usr/bin/env node
/**
 * apply-replacements.mjs — apply exact-string replacements to a file, atomically.
 *
 * For careful edits to a document or source file where each anchor must be unambiguous.
 * Every OLD block must match exactly once; if any does not, NOTHING is written and the
 * failing pair is reported. This makes a partially-applied edit impossible.
 *
 * Usage:
 *   node apply-replacements.mjs <target-file> <pairs-file> [--dry-run] [--backup]
 *
 * Parameters:
 *   <target-file>  File to edit, rewritten in place.
 *   <pairs-file>   Replacement definitions, format below.
 *   --dry-run      Report what would change; write nothing. Run this first.
 *   --backup       Write <target-file>.bak before modifying.
 *
 * Pairs file format — repeat the block for each replacement:
 *
 *   <<<<OLD
 *   text to find, verbatim, may span lines
 *   ====
 *   replacement text
 *   >>>>
 *
 * For an empty replacement (a deletion), leave a blank line between ==== and >>>>.
 * Markers must each sit alone at the start of a line. Text between blocks is ignored,
 * so the pairs file can carry notes.
 *
 * Side effects:
 *   - Rewrites <target-file> in place. Nothing else is touched. Use --backup or version control.
 *
 * Line endings: the target's dominant ending (LF or CRLF) is detected and restored, so a CRLF
 * file stays CRLF. Pairs files are read as LF regardless, so their own endings never matter.
 *
 * Exit codes: 0 applied (or dry run clean), 1 a pair failed or input was invalid.
 *
 * Prerequisites: Node 18+. No dependencies.
 */

import fs from "node:fs";
import process from "node:process";

const OPEN = "<<<<OLD";
const SEPARATOR = "====";
const CLOSE = ">>>>";

function fail(message) {
    console.error(message);
    process.exit(1);
}

function printUsage() {
    console.log("Usage: node apply-replacements.mjs <target-file> <pairs-file> [--dry-run] [--backup]");
    console.log("Run with --help for the pairs file format.");
}

function parseArguments(argv) {
    let positional = argv.filter((value) => !value.startsWith("--"));
    let flags = new Set(argv.filter((value) => value.startsWith("--")));

    for (let flag of flags) {
        if (!["--dry-run", "--backup", "--help"].includes(flag)) {
            fail(`Unknown flag: ${flag}`);
        }
    }

    return {
        targetPath: positional[0],
        pairsPath: positional[1],
        dryRun: flags.has("--dry-run"),
        backup: flags.has("--backup"),
        help: flags.has("--help"),
    };
}

function toLf(text) {
    return text.replace(/\r\n/g, "\n");
}

function detectLineEnding(text) {
    let crlfCount = (text.match(/\r\n/g) ?? []).length;
    let lfCount = (text.match(/\n/g) ?? []).length - crlfCount;

    return crlfCount > lfCount ? "\r\n" : "\n";
}

function parsePairs(source) {
    let blocks = source.split(`${OPEN}\n`).slice(1);
    if (blocks.length === 0) {
        fail(`No ${OPEN} blocks found in the pairs file.`);
    }

    return blocks.map((block, index) => {
        let body = block.split(`\n${CLOSE}`)[0];
        let match = body.match(new RegExp(`^([\\s\\S]*?)\\n${SEPARATOR}\\n([\\s\\S]*)$`));

        if (!match) {
            fail(
                `Pair ${index + 1} is malformed: expected a line containing only ${SEPARATOR} ` +
                    `between the old and new text.\n` +
                    `For a deletion, leave a blank line between ${SEPARATOR} and ${CLOSE}.`,
            );
        }

        return { number: index + 1, oldText: match[1], newText: match[2] };
    });
}

function describe(text) {
    let firstLine = text.split("\n")[0];
    return firstLine.length > 70 ? `${firstLine.slice(0, 70)}…` : firstLine;
}

function main() {
    let { targetPath, pairsPath, dryRun, backup, help } = parseArguments(process.argv.slice(2));

    if (help || !targetPath || !pairsPath) {
        printUsage();
        process.exit(help ? 0 : 1);
    }

    for (let path of [targetPath, pairsPath]) {
        if (!fs.existsSync(path)) {
            fail(`File not found: ${path}`);
        }
    }

    let originalText = fs.readFileSync(targetPath, "utf8");
    let lineEnding = detectLineEnding(originalText);
    let document = toLf(originalText);
    let pairs = parsePairs(toLf(fs.readFileSync(pairsPath, "utf8")));

    let report = [];

    for (let { number, oldText, newText } of pairs) {
        if (oldText.length === 0) {
            fail(`Pair ${number}: the old text is empty, which would match everywhere.`);
        }

        let matches = document.split(oldText).length - 1;

        if (matches !== 1) {
            let reason = matches === 0 ? "no match" : `${matches} matches, must be unique`;
            fail(`Pair ${number} FAILED (${reason}). Nothing was written.\n  anchor: ${describe(oldText)}`);
        }

        document = document.replace(oldText, () => newText);
        report.push(`  ${number}. ${describe(oldText)}  [${oldText.length} -> ${newText.length} chars]`);
    }

    console.log(`${dryRun ? "Would apply" : "Applied"} ${pairs.length} replacement(s) to ${targetPath}:`);
    console.log(report.join("\n"));

    if (dryRun) {
        console.log("Dry run: nothing written.");
        return;
    }

    if (backup) {
        fs.writeFileSync(`${targetPath}.bak`, originalText);
        console.log(`Backup written to ${targetPath}.bak`);
    }

    let output = lineEnding === "\n" ? document : document.replace(/\n/g, "\r\n");
    fs.writeFileSync(targetPath, output);

    if (lineEnding === "\r\n") {
        console.log("Target uses CRLF; line endings preserved.");
    }
}

main();
