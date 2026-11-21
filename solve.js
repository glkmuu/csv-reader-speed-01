// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// Semantics, copied from the reference reader (vendor/csv-reader/index.js):
// BOM U+FEFF dropped at the very start; a record ends at LF or CRLF; a line
// left with no characters is no record; outside quotes a CR not followed by
// LF is dropped (stray_cr); a field opening with a quote runs to the next
// non-doubled quote ("" inside is one quote, CRLF / lone CR inside is LF);
// text after the closing quote up to the next comma or line break is appended
// as-is (quote_junk, when the field ends, if anything was appended); a quote
// that never closes is a literal character and the text after it is re-read
// as unquoted (unterminated_quote); a quote inside an unquoted field is a
// literal; fields stay strings; columns is the first record when header is
// true else null; rows are the rest, padded (short_row, fields: its count)
// or cut (long_row, extra: the cut fields) to the first record's width;
// each error is {code, line, row} in the order met, line the 1-based line
// the record starts on, row the record's index in rows (null for the header);
// a record's short_row / long_row is pushed when the record ends.
//
// Speed: indexOf scans for the next special character instead of walking
// one character at a time, fields are sliced out of the text instead of
// built character by character, and a whole record with no quote and no CR
// is split in one native call. Quoted fields only pay for the slow path
// when a doubled quote or a line break actually occurs inside them.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  let recordLine = 1;
  let recordRow = null;

  // Reads an unquoted field starting at pos, with `prefix` already kept
  // (the opening quote for an unterminated field, or a closed quoted value
  // for quote junk). Returns {value, ended, added}: added counts the
  // characters kept after the prefix. Updates pos and line. Pushes
  // stray_cr errors in the order met.
  function readUnquoted(prefix) {
    let added = 0;
    let parts = null;
    let segStart = pos;
    for (;;) {
      let ci = text.indexOf(',', pos);
      if (ci < 0) ci = n;
      let ni = text.indexOf('\n', pos);
      if (ni < 0) ni = n;
      // A CR past the nearer of the comma / LF ends a later field, so it
      // is irrelevant here: only look for one inside this field, using a
      // slice (a lazy view, no copy) so the search stays bounded.
      const limit = ci < ni ? ci : ni;
      const riRel = text.slice(pos, limit).indexOf('\r');
      const ri = riRel < 0 ? n : pos + riRel;
      if (ci <= ni && ci <= ri) {
        if (ci >= n) {
          pos = n;
          if (parts === null) return { value: prefix + text.slice(segStart, n), ended: END, added: added + (n - segStart) };
          parts.push(text.slice(segStart, n));
          return { value: prefix + parts.join(''), ended: END, added: added + (n - segStart) };
        }
        pos = ci + 1;
        if (parts === null) return { value: prefix + text.slice(segStart, ci), ended: COMMA, added: added + (ci - segStart) };
        parts.push(text.slice(segStart, ci));
        return { value: prefix + parts.join(''), ended: COMMA, added: added + (ci - segStart) };
      }
      if (ni < ri) {
        if (parts === null) {
          pos = ni + 1;
          line += 1;
          return { value: prefix + text.slice(segStart, ni), ended: LINE_BREAK, added: added + (ni - segStart) };
        }
        parts.push(text.slice(segStart, ni));
        pos = ni + 1;
        line += 1;
        return { value: prefix + parts.join(''), ended: LINE_BREAK, added: added + (ni - segStart) };
      }
      // A CR is the nearest special character.
      if (ri + 1 < n && text.charCodeAt(ri + 1) === 10) {
        if (parts === null) {
          pos = ri + 2;
          line += 1;
          return { value: prefix + text.slice(segStart, ri), ended: LINE_BREAK, added: added + (ri - segStart) };
        }
        parts.push(text.slice(segStart, ri));
        pos = ri + 2;
        line += 1;
        return { value: prefix + parts.join(''), ended: LINE_BREAK, added: added + (ri - segStart) };
      }
      // Stray CR: dropped, error recorded, scanning resumes after it.
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      if (parts === null) parts = [];
      parts.push(text.slice(segStart, ri));
      added += ri - segStart;
      pos = ri + 1;
      segStart = pos;
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: a whole record with no quote and no CR. Its first LF is
    // its end (a quote or CR anywhere before it would change the reading,
    // so those records fall through to the field loop below).
    const nl = text.indexOf('\n', pos);
    const recEnd = nl < 0 ? n : nl;
    // Check for a quote or a CR inside this record only, on the record's
    // own slice, so neither search runs past the record's end.
    const recText = recEnd > pos ? text.slice(pos, recEnd) : '';
    if (recEnd > pos && recText.indexOf('"') < 0 && recText.indexOf('\r') < 0) {
      const fields = recText.split(',');
      if (nl < 0) {
        pos = n;
      } else {
        pos = nl + 1;
        line += 1;
      }
      if (width < 0) width = fields.length;
      if (header && columns === null) {
        columns = fields;
        continue;
      }
      if (fields.length < width) {
        errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
        while (fields.length < width) fields.push('');
      } else if (fields.length > width) {
        errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
      }
      rows.push(fields);
      continue;
    }

    const fields = [];
    let ended;
    let lastQuoted = false;
    for (;;) {
      const quoted = pos < n && text.charCodeAt(pos) === 34;
      lastQuoted = quoted;
      let value;
      if (!quoted) {
        const f = readUnquoted('');
        value = f.value;
        ended = f.ended;
      } else {
        // Quoted field: scan quote to quote.
        const open = pos;
        const openLine = line;
        let segStart = pos + 1;
        let scan = segStart;
        let parts = null;
        let closed = false;
        let closedValue = '';
        for (;;) {
          const q = text.indexOf('"', scan);
          if (q < 0) break;
          // Only a break inside this quoted segment matters; check it on
          // the segment's own slice so the search stays bounded.
          const segText = text.slice(segStart, q);
          const hasBreak = segText.indexOf('\n') >= 0 || segText.indexOf('\r') >= 0;
          if (!hasBreak) {
            if (q + 1 < n && text.charCodeAt(q + 1) === 34) {
              if (parts === null) parts = [];
              parts.push(text.slice(segStart, q));
              parts.push('"');
              scan = q + 2;
              segStart = scan;
              continue;
            }
            if (parts === null) closedValue = text.slice(segStart, q);
            else {
              parts.push(text.slice(segStart, q));
              closedValue = parts.join('');
            }
            pos = q + 1;
            closed = true;
            break;
          }
          // Segment holds a line break: walk it once, turning each CRLF
          // or lone CR into one LF and counting lines.
          let chunk = '';
          let i = segStart;
          while (i < q) {
            const cc = text.charCodeAt(i);
            if (cc === 13) {
              chunk += '\n';
              line += 1;
              i += i + 1 < n && text.charCodeAt(i + 1) === 10 ? 2 : 1;
            } else {
              if (cc === 10) line += 1;
              chunk += text[i];
              i += 1;
            }
          }
          if (q + 1 < n && text.charCodeAt(q + 1) === 34) {
            if (parts === null) parts = [];
            parts.push(chunk);
            parts.push('"');
            scan = q + 2;
            segStart = scan;
            continue;
          }
          if (parts === null) closedValue = chunk;
          else {
            parts.push(chunk);
            closedValue = parts.join('');
          }
          pos = q + 1;
          closed = true;
          break;
        }
        if (!closed) {
          // The quote never closes: it is a literal character, and the
          // text after it is read again as unquoted.
          pos = open + 1;
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          const f = readUnquoted('"');
          value = f.value;
          ended = f.ended;
        } else if (pos >= n) {
          value = closedValue;
          ended = END;
        } else {
          const c = text.charCodeAt(pos);
          if (c === 44) {
            pos += 1;
            value = closedValue;
            ended = COMMA;
          } else if (c === 10) {
            pos += 1;
            line += 1;
            value = closedValue;
            ended = LINE_BREAK;
          } else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
            pos += 2;
            line += 1;
            value = closedValue;
            ended = LINE_BREAK;
          } else {
            // What follows the closing quote is appended as it stands.
            const f = readUnquoted(closedValue);
            if (f.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
            value = f.value;
            ended = f.ended;
          }
        }
      }
      fields.push(value);
      if (ended !== COMMA) break;
    }

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
