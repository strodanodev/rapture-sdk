// The Python side of `pnpm check`, offline: byte-compile every Blender and tools script (they import bpy only inside
// Blender, so compiling is all a plain Python can check), then run the harness's unit tests (no Blender, no network).
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const candidates = process.platform === 'win32' ? [['py', '-3'], ['python'], ['python3']] : [['python3'], ['python']];
const python = candidates.find(([cmd, ...pre]) => spawnSync(cmd, [...pre, '--version'], { encoding: 'utf8' }).status === 0);
if (!python) {
  console.error('pycheck: no Python 3 found (python3, python or py)');
  process.exit(1);
}
const [cmd, ...pre] = python;

/** @param {string} dir @returns {string[]} */
const pyFiles = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  if (statSync(p).isDirectory()) return n === '__pycache__' ? [] : pyFiles(p);
  return n.endsWith('.py') ? [p] : [];
});

const files = [...pyFiles('blender'), ...pyFiles('tools')];
// compile to a throwaway cache, so no __pycache__ lands in the package
const compile = spawnSync(cmd, [...pre, '-c', [
  'import sys, py_compile, tempfile, os',
  'd = tempfile.mkdtemp()',
  'bad = 0',
  'for i, f in enumerate(sys.argv[1:]):',
  '    try: py_compile.compile(f, cfile=os.path.join(d, f"{i}.pyc"), doraise=True)',
  '    except py_compile.PyCompileError as e: print(e.msg); bad += 1',
  'sys.exit(bad)',
].join('\n'), ...files], { stdio: 'inherit' });
if (compile.status !== 0) process.exit(1);
console.log(`py_compile: ${files.length} files ok`);

const tests = spawnSync(cmd, [...pre, '-B', '-m', 'unittest', 'discover', '-s', join('blender', 'tests'), '-p', 'test_*.py'], { stdio: 'inherit', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
process.exit(tests.status ?? 1);
