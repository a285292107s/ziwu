import { execFileSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ext = process.platform === 'win32' ? '.cmd' : ''
const bin = name => path.join(root, 'node_modules', '.bin', name + ext)

const env = { ...process.env, NODE_ENV: 'production' }

function run(label, cmd, args) {
  process.stdout.write(`\n▶ ${label}\n`)
  execFileSync(cmd, args, { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' })
}

run('清空 dist', bin('rimraf'), ['--glob', 'extension/dist', 'extension/manifest.json'])
run('build:web', bin('vite'), ['build'])
run('build:prepare', bin('esno'), ['scripts/prepare.ts'])
run('build:background', bin('vite'), ['build', '--config', 'vite.config.background.mts'])

const extra = process.argv[2]
if (extra) {
  run(`额外脚本 ${extra}`, process.execPath, [path.resolve(root, extra), ...process.argv.slice(3)])
}
else {
  process.stdout.write('\n✓ 生产构建完成（extension/ 现在可直接加载）\n')
}
