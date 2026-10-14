precision highp float;

/*
 * FFT 海面的第三趟：一趟 radix-2 蝶形。
 *
 * 用的是迭代式 Cooley-Tukey 的 DIT 形式。它对**一维**数组的定义是：
 *
 *   for (len = 2; len <= N; len <<= 1) {
 *     half = len / 2;
 *     for (i = 0; i < N; i += len)
 *       for (j = 0; j < half; j++) {
 *         u = a[i+j]; v = a[i+j+half] * w(j, len);
 *         a[i+j]        = u + v;
 *         a[i+j+half]   = u − v;
 *       }
 *   }
 *
 * 把它摊到一个纹素一个线程上：每个线程负责**一个输出格子 i**，
 * 只需要算出这一格的那一对 (lo, hi) 和它自己的 twiddle 因子。三行位运算：
 *
 *   half = 2^pass
 *   lo   = i & ~half        只把「第 pass 位」清掉，就得到同组里的低半格
 *   hi   = lo | half
 *   j    = i & (half − 1)   组内偏移，决定 twiddle 的相位
 *
 * 因为 half 恰好是 2 的幂，`i & ~half` 清掉的就是唯一区分两个半区的那个位 ——
 * 不需要算组起点，也不需要知道自己在第几组。这是这段代码能这么短的原因。
 *
 * 二维变换拆成「先横后纵」：`uAxis` 为 0 时沿 X 做 7 趟，为 1 时沿 Y 做 7 趟，
 * 中间乒乓。搭配上一趟把谱写成位反转序，14 趟出来就是自然序的空间域，
 * 后面 pack 那趟不用再置换。
 *
 * `uSign` 取 +1（逆变换的方向）。这个符号是**必须**想清楚的：
 * 我们最后要的是 h(x) = Σ_k H(k)·e^{+i k·x}，而教科书里的正变换是 e^{−i k·x}。
 * 用 −1 也能出一张「看起来像海浪」的图，只是把图案左右镜像了 ——
 * 镜像过的浪和光的方向对不上，光柱会从错误的一侧斜过来。所以这里写 +1。
 *
 * RG 和 BA 各是一路独立的复数，所以一趟同时变换两个场（高度+斜率x，或者 斜率z+拉普拉斯），
 * 一趟顶两趟。
 */

uniform sampler2D uSrc;
uniform int uAxis;   // 0 → 沿 X，1 → 沿 Y
uniform int uHalf;   // 2^pass
uniform float uSign;

out vec4 outColor;

const float TAU = 6.28318530717958647692;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int i = (uAxis == 0) ? p.x : p.y;

  int lo = i & ~uHalf;
  int hi = lo | uHalf;
  int j = i & (uHalf - 1);

  float ang = uSign * TAU * float(j) / float(2 * uHalf);
  float c = cos(ang);
  float s = sin(ang);

  ivec2 pl = (uAxis == 0) ? ivec2(lo, p.y) : ivec2(p.x, lo);
  ivec2 ph = (uAxis == 0) ? ivec2(hi, p.y) : ivec2(p.x, hi);

  vec4 a = texelFetch(uSrc, pl, 0);
  vec4 b = texelFetch(uSrc, ph, 0);

  // 两路复数各乘一个单位复数 (c + i·s)
  vec4 bw = vec4(b.x * c - b.y * s,
                 b.x * s + b.y * c,
                 b.z * c - b.w * s,
                 b.z * s + b.w * c);

  outColor = ((i & uHalf) == 0) ? (a + bw) : (a - bw);
}
