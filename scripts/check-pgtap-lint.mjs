// Catches the two ways a pgTAP file has actually broken in this repo, BEFORE it costs a CI
// round trip. There is no Docker on the primary dev machine, so `supabase test db` only ever
// runs in CI -- which makes a syntax error in a test file a several-minute feedback loop
// paid by a human, not by the machine.
//
// It is deliberately lexical, not a parser. It does not pretend to validate SQL; it checks
// the specific things that have gone wrong:
//
//   1. DOLLAR QUOTES MANGLED IN TRANSIT. A dollar-quote delimiter is two characters that
//      several tools treat as special, and every one of them produces a file Postgres cannot
//      parse -- after which every assertion past that point silently does not run.
//
//      Three variants have actually happened here:
//        - a shell expanding `$$` into its own process id, so `do $$` arrives as `do 1913`
//          (suites 200 and 220; the second reached CI);
//        - JavaScript's String.replace, where `$$` in the REPLACEMENT string is the escape
//          for a literal `$`, so a patch script inserting a DO block writes `do $` and
//          `end $;` (suite 230, reached CI). Use split/join or a replacer function.
//
//      The first version of this check only knew the first variant: it looked for
//      `do <digits>` and for an ODD number of `$$`. The replace() variant eats one `$` from
//      BOTH delimiters of a block, which leaves the count even, so it sailed straight
//      through. The check below no longer tries to recognise a signature -- it verifies that
//      every `$` in the file is part of a WELL-FORMED delimiter (`$$` or `$tag$`), which is
//      true of a correct file however it was mangled.
//   2. plan(N) LOWER than the number of assertions written. pgTAP reports "Bad plan", the
//      suite is marked failed, and the cause is a number nobody recounted after adding a
//      test -- suite 110 shipped plan(13) while running 14. Only this direction is checked;
//      see the note at the check itself for why the opposite direction cannot be.
//
// Anything it cannot check with confidence, it says nothing about. A linter that guesses is
// worse than one with a narrow, honest remit.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const DIR = 'supabase/tests/database';
const ASSERTION_RE = /^\s*select\s+(is|isnt|ok|alike|unalike|cmp_ok|throws_ok|lives_ok|pass|fail|matches)\s*\(/i;

let problems = 0;
const report = (file, line, message) => {
  console.log(`FAIL  ${file}${line ? `:${line}` : ''}  ${message}`);
  problems += 1;
};

const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

for (const file of files) {
  const full = path.join(DIR, file);
  const text = readFileSync(full, 'utf8');
  const lines = text.split(/\r?\n/);

  // --- 1. mangled dollar quotes ---------------------------------------------------------
  // `do 1913` / `end 1913;` -- a bare integer where a delimiter belongs, which is what a
  // shell expanding $$ leaves behind. Reported separately because the message can name the
  // cause exactly.
  lines.forEach((line, i) => {
    if (/^\s*(do|end)\s+\d+\s*;?\s*$/i.test(line)) {
      report(file, i + 1, `dollar quote replaced by a number -- a shell expanded $$: "${line.trim()}"`);
    }
  });

  // Every `$` in one of these files belongs to a delimiter: `$$` or `$tag$`. Strip the
  // well-formed ones and anything left is a delimiter that lost a character on the way in --
  // which is the shape String.replace's `$$` escape produces, and which the old parity check
  // could not see because it eats one `$` from BOTH ends of a block.
  lines.forEach((line, i) => {
    const leftover = line.replace(/\$[a-zA-Z_][a-zA-Z0-9_]*\$|\$\$/g, '');
    if (leftover.includes('$')) {
      report(file, i + 1, `stray \`$\` outside a well-formed dollar quote -- a delimiter lost a character: "${line.trim()}"`);
    }
  });

  // Unbalanced $$ means a block was left open.
  const anonymous = (text.match(/\$\$/g) ?? []).length;
  if (anonymous % 2 !== 0) {
    report(file, null, `odd number of $$ delimiters (${anonymous}) -- a dollar-quoted block is unterminated`);
  }

  // Named delimiters must pair up too ($probe$ ... $probe$).
  const named = {};
  for (const [, tag] of text.matchAll(/\$([a-zA-Z_][a-zA-Z0-9_]*)\$/g)) {
    named[tag] = (named[tag] ?? 0) + 1;
  }
  for (const [tag, count] of Object.entries(named)) {
    if (count % 2 !== 0) {
      report(file, null, `odd number of $${tag}$ delimiters (${count}) -- unterminated block`);
    }
  }

  // --- 2. plan(N) vs the real assertion count -------------------------------------------
  const planMatch = text.match(/select\s+plan\s*\(\s*(\d+)\s*\)/i);
  if (!planMatch) {
    report(file, null, 'no select plan(N) found');
    continue;
  }
  const planned = Number(planMatch[1]);

  // Count only assertions at statement level. Ones nested inside a DO block are not pgTAP
  // assertions -- they cannot be, since a restricted role cannot reach the extensions
  // schema -- so counting them would produce a wrong expectation.
  let depth = 0;
  let counted = 0;
  for (const line of lines) {
    const opens = (line.match(/\$\$|\$[a-zA-Z_][a-zA-Z0-9_]*\$/g) ?? []).length;
    if (depth === 0 && ASSERTION_RE.test(line)) counted += 1;
    depth = (depth + opens) % 2;
  }

  // ONLY the over-count direction is reported, and this is the whole reason:
  //
  // pgTAP counts assertions at RUNTIME, not lexically. `select ok(...) from unnest(...)`
  // emits one assertion per row, so a correct file legitimately runs MORE assertions than it
  // has `select ok(` lines -- seven existing suites that pass in CI do exactly this. Failing
  // on counted < planned produced seven false positives on known-good files, which would
  // teach everyone to ignore this script, the same failure mode the webhook workflow is
  // written to avoid.
  //
  // Counted > planned cannot come from dynamic expansion, so it is a real signal. That is
  // the direction that actually bit: suite 110 shipped plan(13) while running 14.
  if (counted > planned) {
    report(
      file,
      null,
      `plan(${planned}) but at least ${counted} assertions are written -- pgTAP will report "Bad plan"`,
    );
  }
}

if (problems === 0) {
  console.log(`pgTAP lint: ${files.length} files clean (every $ belongs to a well-formed delimiter, blocks balanced, no plan under-count).`);
  console.log('This is a LEXICAL check only -- it does not parse SQL. `supabase test db` in CI remains the gate.');
} else {
  console.log(`\npgTAP lint: ${problems} problem(s).`);
  process.exit(1);
}
