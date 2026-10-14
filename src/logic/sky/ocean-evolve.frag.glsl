precision highp float;

/*
 * FFT 海面的第二趟：把频域谱演化到时刻 t，并把**四个场打包进两路复数**。
 * （四个场里现在只有三个有内容 —— 第四格空置，见下面。）
 *
 * Tessendorf 的演化式：
 *
 *   h(k,t) = h0(k)·e^{iωt} + conj(h0(-k))·e^{-iωt}
 *
 * 谱纹理里 RG 存 h0(k)、BA 存 conj(h0(-k))（CPU 侧预先算好）。
 *
 * --- 位反转为什么在这一趟 ---
 *
 * 下一趟的蝶形是 Cooley-Tukey 的 DIT 形式，它要求 FFT 数组的位置 m 上放的是
 * 自然序的 a[brev(m)]。而谱是 CPU 按**自然序**生成的。所以这里读谱时把索引
 * 反转一次、写出去的仍是自然位置：位置 m 拿到 h0(k(brev(m)))，也就是
 * a[brev(m)] —— 正好是蝶形要的。代价是三条位运算。
 *
 * 已在 CPU 上逐项验算过：位反转输入 + DIT 蝶形 + uSign=+1，
 * 与朴素逆 DFT 的最大误差 4.6e-15。
 *
 * --- 四个场为什么只要两路复数 ---
 *
 * 逆变换是线性的，所以「一个复数组的逆变换」的实部和虚部，
 * 分别就是「它的实部数组」和「它的虚部数组」各自的逆变换 —— 只要那两个
 * 实部/虚部数组都是 Hermitian 的（也就是各自对应一个**实**的空间场）。
 *
 * 于是挑两个复数谱 A、B，让它们各自的实/虚部都对应我们想要的实场：
 *
 *   A = H + i·(i·kx·H)  = (1 − kx)·H        → 逆变换 = h + i·∂h/∂x
 *   B = (−|k|²·H) + i·(i·kz·H) = −(|k|² + kz)·H → 逆变换 = −∇²h + i·∂h/∂z
 *
 * 一条 FFT 链就把 波高 / 两个斜率 / 拉普拉斯 全拿到了 —— 不是两条。
 * （|k|² + kz 这种量纲混搭看着别扭，但它就是上面那个恒等式展开的结果。）
 *
 * 一个必须处理的边角：Nyquist 格（下标 = N/2）是它自己的镜像，
 * 实函数在那里必须只有实谱值，否则 i·k·H 在那一格就不再 Hermitian，
 * 导数场会带出虚部、反过来污染波高。CPU 侧已经把那两行/两列清零
 * （物理上 Nyquist 对应「隔一格一正一负」的锯齿，本来也不该有能量）。
 */

uniform sampler2D uSpectrum;
uniform float uTime;
uniform float uPatch;   // 波场边长（米）
uniform int uBits;      // log2(n)

out vec4 outColor;

const float GRAV = 9.81;
/* 表面张力项。深水色散关系是 ω² = g·k + (σ/ρ)·k³，
   7.4e-5 是 20°C 水的 σ/ρ。这一项只在厘米级的小波上才有存在感，
   但它正是焦散丝最细的那一档，缺了会让水面显得「塑料」。 */
const float TENSION = 7.4e-5;
const float TAU = 6.28318530717958647692;

/* ω 量化步长。把所有波的角频率向下取整到 2π/120 的整数倍，
   于是 120 秒后每个波都精确回到起始相位 —— 整个海面无缝循环。
   代价是最慢的那几支波的速度最多差 2π/120（约 5%），肉眼看不出来；
   换来的是新标签页开着一整天也不会看到「跳一下」。
   实测过：不量化时最长周期不同的波会在几分钟后错开，出现一次硬跳。 */
const float LOOP_STEP = TAU / 120.0;

const int MAX_BITS = 8;   // 网格边长最多 2^8 = 256

/* 8 位三步对折交换，再按 log2(n) 右移对齐。
   对 n < 256：输入高位是 0，反转后落到低位，右移正好把多出来的丢掉 ——
   不需要为每种 n 写一份。 */
int bitReverse(int v) {
  v = ((v & 0x0F) << 4) | ((v >> 4) & 0x0F);
  v = ((v & 0x33) << 2) | ((v >> 2) & 0x33);
  v = ((v & 0x55) << 1) | ((v >> 1) & 0x55);
  return v >> (MAX_BITS - uBits);
}

vec2 cmul(vec2 a, vec2 b) {
  return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

void main() {
  ivec2 outIdx = ivec2(gl_FragCoord.xy);
  ivec2 srcIdx = ivec2(bitReverse(outIdx.x), bitReverse(outIdx.y));
  int n = textureSize(uSpectrum, 0).x;
  vec4 spec = texelFetch(uSpectrum, srcIdx, 0);

  // 有符号频率索引：0…n/2-1 然后是 −n/2…−1
  vec2 mi = vec2(srcIdx);
  mi -= vec2(n) * step(vec2(float(n) * 0.5), mi);
  vec2 k = TAU * mi / uPatch;   // rad/m
  float kmag = length(k);
  float k2 = dot(k, k);

  float w = sqrt(GRAV * kmag + TENSION * kmag * kmag * kmag);
  w = floor(w / LOOP_STEP) * LOOP_STEP;
  float ct = cos(w * uTime);
  float st = sin(w * uTime);

  vec2 H = cmul(spec.xy, vec2(ct, st)) + cmul(spec.zw, vec2(ct, -st));

  /* 两路复数，四个实通道。
   *
   *   A = kx·H                     → 逆变换 = (∂h/∂x, 0)
   *   B = −(|k|² + kz)·H           → 逆变换 = (−∇²h, ∂h/∂z)
   *
   * **第二格是空的。** 它原来装的是**带限拉普拉斯**（粗带焦散）：
   *   A = i·(kx − |k|²·W)·H，W(k) = exp(−|k|²/kc²)
   * 那个场只服务于丁达尔光柱 —— 把焦散胞元从 0.18~1.8m 拉到 1.5~6m，
   * 好让它在体积步进积分里活下来。光柱按用户要求删掉之后（water28），
   * 它就没有任何读取点了，于是 W 与 uCoarseK 一起删除，sa 退回成纯 kx。
   *
   * 注意：sa 取纯实数 kx 时，RG 这一路复数的逆变换是**纯实**的
   * （= ∂h/∂x），虚部恒为 0 —— 也就是说那一格不是「算出来很小」，
   * 而是**数学上就是零**。这是它能被安全空置的原因。
   *
   * 打包的推导：选两个复数谱 A、B，让它们各自的实/虚部都对应一个**实**空间场，
   * 一条 FFT 链就能同时拿到 斜率x / 斜率z / 拉普拉斯 三个场 —— 不是三条。
   * （|k|² + kz 这种量纲混搭看着别扭，但它是 A = H + i·(i·kx·H) 那个恒等式展开的结果。）
   *
   * 一个必须处理的边角：Nyquist 格（下标 = N/2）是它自己的镜像，
   * 实函数在那里必须只有实谱值，否则 i·k·H 在那一格就不再 Hermitian，
   * 导数场会带出虚部、反过来污染波高。CPU 侧已经把那两行/两列清零
   * （物理上 Nyquist 对应「隔一格一正一负」的锯齿，本来也不该有能量）。 */
  float sa = k.x;               // A = kx·H  → Re = −sa·H.y, Im = sa·H.x
  float sb = -(k2 + k.y);       // B = −(|k|² + kz)·H
  outColor = vec4(-sa * H.y, sa * H.x, sb * H.x, sb * H.y);
}
