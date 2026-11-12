import re, sys
D = sys.argv[1]
metrics = open(D + '/metrics.rs').read()
winansi = open(D + '/win_ansi.rs').read()
def table(name):
    i = metrics.index(f'static {name}:')
    j = metrics.index('};', i)
    return {k: float(v) for k, v in re.findall(r'"([^"]+)" => ([\d.]+)_f32', metrics[i:j])}
codes = {int(c): n for c, n in re.findall(r'(\d+)_u8 => "([^"]+)"', winansi)}
fonts = ['HELVETICA', 'HELVETICA_BOLD', 'TIMES_ROMAN', 'TIMES_BOLD', 'TIMES_ITALIC', 'TIMES_BOLD_ITALIC']
out = []
missing = set()
for f in fonts:
    t = table(f)
    row = []
    for code in range(32, 256):
        name = codes.get(code)
        alias = {"nbspace": "space", "sfthyphen": "hyphen"}
        w = t.get(alias.get(name, name)) if name else None
        if w is None:
            missing.add((f, code, name))
            w = t.get('bullet', 500)
        row.append(int(round(w)))
    out.append((f, row))
print('missing:', sorted(missing)[:40], file=sys.stderr)
# Usage: gen_text_metrics.py <hayro font/generated dir> [--ts]
#   (Rust to src/operations/text_metrics.rs, --ts to packages/pdfrs-editor/src/text/metrics.ts)
src = ['// Generated from the Adobe Core 14 AFM metrics as packaged in the hayro-interpret crate',
       '// (src/font/generated/metrics.rs and win_ansi.rs, Apache-2.0 OR MIT). Do not edit by hand:',
       '// regenerate if fonts are added.',
       '//',
       '// Advance widths, in 1/1000 em, of the WinAnsiEncoding codes 32..=255 (index = code - 32).',
       '// Codes WinAnsi leaves undefined hold the width of "bullet"; text never uses them.',
       '']
for f, row in out:
    src.append(f'pub(crate) const {f}: [u16; 224] = [')
    for i in range(0, 224, 16):
        src.append('    ' + ', '.join(str(w) for w in row[i:i+16]) + ',')
    src.append('];')
    src.append('')
ts = len(sys.argv) > 2 and sys.argv[2] == '--ts'
if ts:
    lines = [l.replace('// ', '// ', 1) for l in src[:6]] + ['']
    for f, row in out:
        lines.append(f'export const {f}: readonly number[] = [')
        for i in range(0, 224, 16):
            lines.append('  ' + ', '.join(str(w) for w in row[i:i+16]) + ',')
        lines.append(']')
        lines.append('')
    print('\n'.join(lines))
else:
    print('\n'.join(src))
