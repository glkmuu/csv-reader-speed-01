// Driver for csv-reader-speed-01-run-20261121.
//
// The harness runs `node /bot/main.ts`. It reads every case from
// /input/cases.json (or $MAKEFUN_INPUT_DIR outside a container), answers
// each case alone with run() from solve.js, and writes the answers in
// order to /output/answers.json (or $MAKEFUN_OUTPUT_DIR).
//
// V8's incremental marking is switched off before solve.js is loaded, so
// the long string chains the parser builds are not marked a step at a
// time; solve.js is imported dynamically, after the flag is set.
//
// Each answer is stringified and written as soon as it is computed, so
// the whole answer set is never held twice (once as objects, once as one
// big string). The bytes written are exactly JSON.stringify of the
// answers array: '[' then the answers comma-separated then ']'.

import { setFlagsFromString } from 'node:v8';
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

setFlagsFromString('--no-incremental-marking');

const { run } = await import('./solve.js');

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));

// writeSync may write fewer bytes than asked for, so loop until the
// whole buffer is out; a short write here would corrupt answers.json.
// (The buffer form takes a byte offset, which the string form does not.)
function writeAll(fd, s) {
  const buf = Buffer.from(s, 'utf8');
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off, null);
}

mkdirSync(outputDir, { recursive: true });
const fd = openSync(join(outputDir, 'answers.json'), 'w');
try {
  writeAll(fd, '[');
  for (let i = 0; i < cases.length; i++) {
    if (i > 0) writeAll(fd, ',');
    writeAll(fd, JSON.stringify(run(cases[i].input)));
  }
  writeAll(fd, ']');
} finally {
  closeSync(fd);
}
