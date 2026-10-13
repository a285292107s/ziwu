/**
 * 生产构建 + （可选）临时脚本执行的组合入口。
 *
 * 背景：开发模式（`pnpm dev`）会把 `extension/dist` 覆盖成**指向 localhost 的开发版 stub**。
 * 之后任何直接加载 `extension/` 的浏览器验证都会失败在
 * `net::ERR_CONNECTION_REFUSED`（因为 Vite 服务已经停了）。
 *
 * 所以：跑完开发模式想再手工验证，必须重新做一次生产构建。
 *
 * 用法：
 *   node scripts/rebuild.mjs
 *   node scripts/rebuild.mjs scripts/contrast-audit.mjs
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Windows 下 node_modules/.bin 里是 .cmd 包装脚本，直接 spawn 不带后缀会 ENOENT
const ext = process.platform === 'win32' ? '.cmd' : ''
const bin = name => path.join(root, 'node_modules', '.bin', name + ext)

// 这里曾经要塞 NODE_OPTIONS=--no-experimental-require-module 来绕开 Node 24 加载
// unocss.config.ts 时的 ERR_INTERNAL_ASSERTION。根因已在 vite.config.mts 里修掉
// （UnoCSS 的配置改成内联传入，不再运行时加载 TS 配置），所以这个 flag 撤掉了 ——
// 它在 Node 18/20 上本来也不存在，会让子进程直接起不来。
const env = { ...process.env, NODE_ENV: 'production' }

function run(label, cmd, args) {
  process.stdout.write(`\n▶ ${label}\n`)
  // .cmd 包装脚本需要 shell:true 才能在 Windows 上正确执行
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
