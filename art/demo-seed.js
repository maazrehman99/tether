// Demo conversation for screenshots. Paste into the page with a key already set, then reload.
(() => {
  const T = '```';
  const evs = [
    { t: 'user', text: 'The add test fails on CI. Can you find out why and fix it?', cid: 'c1' },
    { t: 'tool', id: 't1', name: 'Read', sum: 'src/math.js', file: 'src/math.js' },
    { t: 'tres', id: 't1', ok: true, prev: 'export function add(a, b) {\n  return a - b;\n}', n: 44 },
    { t: 'tool', id: 't2', name: 'Bash', sum: 'npm test' },
    { t: 'tres', id: 't2', ok: false, prev: 'FAIL  test/math.test.js\n  expected 5, received -1', n: 52 },
    { t: 'tf', b: 'b1', text: `## Found it\n\n\`add\` in \`src/math.js\` **subtracts** instead of adding, so \`add(2, 3)\` returns \`-1\`.\n\n${T}js\nexport function add(a, b) {\n  return a - b; // wrong sign\n}\n${T}\n\nI'll fix the sign and run the tests again.` },
    { t: 'tool', id: 't3', name: 'Edit', sum: 'src/math.js', file: 'src/math.js', diff: { old: '  return a - b;', new: '  return a + b;' } },
    { t: 'tres', id: 't3', ok: true, prev: 'Edited src/math.js', n: 18 },
    { t: 'tool', id: 't4', name: 'Bash', sum: 'npm test' },
    { t: 'tres', id: 't4', ok: true, prev: 'PASS  test/math.test.js\n  3 passed', n: 36 },
    { t: 'tf', b: 'b2', text: `Fixed. All **3 tests pass** now.\n\n| File | Change |\n|---|---|\n| \`src/math.js\` | \`a - b\` → \`a + b\` |\n\nWant me to push it?` },
    { t: 'done' },
    { t: 'user', text: 'Yes, push it.', cid: 'c2' },
    { t: 'perm', id: 'p1', tool: 'Bash', sum: 'git push origin main', always: true },
  ].map((e, i) => ({ ...e, seq: i + 1 }));
  const chat = { id: 'tmp-demo', project: 'my-app', title: 'Fix the failing add test', updated: Date.now(), busy: false };
  const older = [
    { id: 'tmp-d2', project: 'my-app', title: 'Add dark mode to settings', updated: Date.now() - 3 * 3600e3 },
    { id: 'tmp-d3', project: 'my-app', title: 'Why is the build slow?', updated: Date.now() - 26 * 3600e3 },
    { id: 'tmp-d4', project: 'my-app', title: 'Write release notes for 1.4', updated: Date.now() - 3 * 86400e3 },
  ];
  localStorage.setItem('cm:chats', JSON.stringify([chat, ...older]));
  localStorage.setItem('cm:ev:tmp-demo', JSON.stringify({ seq: evs.length, evs }));
  localStorage.setItem('cm:cur', JSON.stringify('tmp-demo'));
  localStorage.setItem('cm:project', JSON.stringify('my-app'));
})();
