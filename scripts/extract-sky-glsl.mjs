/**
 * 一次性工具：把 skyRenderer.ts 里内联的 GLSL 抽成独立文件。
 *
 * 为什么值得做：GLSL 现在住在 JS 模板字符串里，**注释里出现一个反引号就会
 * 截断字符串**——这个坑已经踩过两次，而且 `node scripts/rebuild.mjs` 照样
 * 打印「✓ 生产构建完成」，只有 `pnpm typecheck` 才会报出来。
 * 抽成 .glsl 用 Vite 的 `?raw` 导入之后，这个坑从根上消失。
 *
 * 切完之后 VERT/FRAG 只作为**校验用**留在输出里，不写回源码。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = resolve(root, 'src/logic/skyRenderer.ts')
const out = resolve(root, 'src/logic/sky')
mkdirSync(out, { recursive: true })

const lines = readFileSync(src, 'utf8').split(/\r?\n/)
/** 1-based 行号 → 数组下标 */
const at = n => lines[n - 1]

console.log('边界校验（必须是模板字符串的起止行）:')
for (const n of [42, 48, 50, 51, 914, 915])
  console.log(`  ${n}: ${JSON.stringify(at(n))}`)

if (!at(42).startsWith('const VERT = `#version 300 es'))
  throw new Error('第 42 行不是 VERT 的开头，行号已漂移，先重新定位')
if (!at(50).startsWith('const FRAG = `#version 300 es'))
  throw new Error('第 50 行不是 FRAG 的开头，行号已漂移，先重新定位')
if (at(915).trim() !== '`')
  throw new Error('第 915 行不是模板字符串的结尾反引号，行号已漂移')

/**
 * 顶点着色器：three.js 的 RawShaderMaterial 不会自动声明属性，
 * 而且我们不再用 gl_VertexID 的无缓冲三角形（three.js 走的是
 * PlaneGeometry(2,2) + 正交相机），所以要显式声明 `position`。
 */
const vert = `// three.js 全屏三角形：几何体是 PlaneGeometry(2, 2)，
// 相机是 OrthographicCamera(-1, 1, 1, -1, 0, 1)，所以顶点位置直接就是
// 裁剪空间的 xy（z 交给相机，这里写 0 即可）。
//
// 注意 RawShaderMaterial 不会替我们声明属性，\`position\` 必须自己写。
in vec3 position;

void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

/**
 * 片元着色器：去掉第 50 行的 \`#version\`（three.js 按 glslVersion 自己加），
 *  \`precision\` 保留在文件里，因为 RawShaderMaterial 也不加精度声明。
 */
const fragBody = lines.slice(50, 914).join('\n') // 第 51 行 → 第 914 行
if (!fragBody.includes('precision highp float;'))
  throw new Error('片元着色器里没有精度声明，RawShaderMaterial 下会编译失败')
if (fragBody.includes('`'))
  throw new Error('片元着色器里还有反引号——正是要消灭的那个坑')

writeFileSync(resolve(out, 'water.vert.glsl'), vert.replace(/\n/g, '\r\n'))
writeFileSync(resolve(out, 'water.frag.glsl'), `${fragBody}\r\n`)

console.log(`\n写出：`)
console.log(`  water.vert.glsl  ${vert.split('\n').length} 行`)
console.log(`  water.frag.glsl  ${fragBody.split('\n').length} 行`)
console.log(`  片元首行: ${JSON.stringify(fragBody.split('\n')[0])}`)
console.log(`  片元末行: ${JSON.stringify(fragBody.split('\n').at(-1))}`)
