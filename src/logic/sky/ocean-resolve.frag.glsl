precision highp float;

/*
 * FFT 海面的最后一趟：把两路复数的逆变换结果整理成**主着色器实际要用的那一张纹理**。
 *
 *   R = 空置, G = ∂h/∂x, B = ∂h/∂z, A = 全带焦散
 *
 * 一张纹理、一次取样。水面那段是逐像素的热点路径，分三张纹理就是三次显存往返；
 * 挤进一个 RGBA 里只付一次带宽。
 * （**四个通道必须都占着**：FFT 的打包天然是两路复数，R 这一格是数学上恒为 0 的空位。
 *  它原来是「粗带焦散」，随直射光柱在 water28 被删掉了 —— 详见 ocean-evolve.frag.glsl。）
 *
 * 输入（见 ocean-evolve.frag.glsl 的推导）：
 *   RG 的逆变换 = ∂h/∂x + i·0        → 实部 s.x 是 x 斜率，虚部恒为 0
 *   BA 的逆变换 = −∇²h + i·∂h/∂z     → 实部 s.z 是负拉普拉斯，虚部 s.w 是 z 斜率
 *
 * 波高那个通道从一开始就没被主着色器读过，所以前几轮拿它装带限拉普拉斯、
 * 这一轮干脆让它空着 —— 真正的区别是：**空着是零成本的，装东西不是**。
 *
 * 归一化 1/N² 在这里做一次 —— 蝶形那 14 趟不带任何除法。
 *
 * --- 焦散 ---
 *
 * 用会聚算子：水面的折射把光偏折，偏折的空间导数就是局部面积的伸缩比；
 * 面积被压缩到 1/|J|，辐照度就乘 |J|。高度场近似下 J = 1 + λ·∇²h。
 * 这里拿到的是 −∇²h，所以 J = 1 − λ·lap。凹下去（∇²h < 0）的地方亮 —— 那是一片会聚透镜。
 *
 * λ 不是随便调的：它决定**亮点有多稀疏**。λ·σ_lap 太小则整片均匀发亮（没有网），
 * 太大则亮部聚成亚像素的丝（变成噪点）。σ_lap 是谱的产物、换风速就变，
 * 所以 λ 由 CPU 侧按实测的 σ_lap 反算出来传进来，保证「亮暗比」不随风速漂移。
 *
 * 最后乘一个增益把均值拉回 1：能量守恒上焦散场的期望应该是 1（水面不凭空造光，
 * 只是把光重新分配），而 1/|J| 的期望没有解析式。均值由 CPU 侧初始化时
 * 读回真实数据算出来 —— 否则换一次谱，整幅画的曝光就整体漂一档。
 */

uniform sampler2D uSrc;
uniform float uNorm;         // 1/N²
uniform float uLambdaFine;
uniform float uGainFine;
uniform float uCausMax;

out vec4 outColor;

/* λ·σ_lap 的目标值由 CPU 侧反算（λ = CAUSTIC_K/σ），所以「亮暗比」是固定的一档。 */
float causticOf(float lap, float lambda, float gain) {
  float j = 1.0 - lambda * lap;
  // J 过零处 1/|J| 发散。真实水里那是焦散线最亮的地方，但它是个测度为零的集合，
  // 一个像素积分下来是有限值；夹住下限就是在替那个积分做近似。
  // 先乘增益再夹上限：上限是给「主着色器能吃到多大的数」定的，
  // 放在增益之前会让同一档外观在不同风速下有不同的天花板。
  return clamp(1.0 / max(abs(j), 2e-3) * gain, 0.0, uCausMax);
}

void main() {
  vec4 s = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0);

  float sx = s.x * uNorm;
  float lapFine = s.z * uNorm;
  float sz = s.w * uNorm;

  float fine = causticOf(lapFine, uLambdaFine, uGainFine);

  // 纹理顺序：R 空置 · G ∂h/∂x · B ∂h/∂z · A 全带焦散
  outColor = vec4(0.0, sx, sz, fine);
}
