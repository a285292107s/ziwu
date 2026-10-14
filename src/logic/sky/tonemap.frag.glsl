// 最终 pass：ACES 色调映射 + sRGB 编码 + 抖动。
//
// 为什么单独一个 pass 而不是并进水体着色器：泛光必须作用在**线性 HDR** 上。
// 见 water.frag.glsl 末尾的说明。
//
// ⚠ 这条 ACES 曲线不是随便挑的：src/logic/skyRenderer.ts 里的自动曝光闭环
//   用 `acesInv()`（这条曲线的解析反函数）把测到的屏幕亮度反推回场景亮度。
//   **改这里任何一个系数，都必须同步改那个反函数**，否则闭环的目标值会静默偏移。
//   曲线是 Narkowicz 的 ACES 拟合：
//     aces(x) = x(2.51x + 0.03) / (x(2.43x + 0.59) + 0.14)
uniform sampler2D tDiffuse;

varying vec2 vUv;

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

// 抖动噪声。8bit 输出上大面积的平滑渐变（这片水里全是）必然出色带，
// 加半个色阶的白噪声把它打散。
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec3 col = texture2D(tDiffuse, vUv).rgb;

  /* **暗角已删除（water28）。** 它原是一枚横向 1.0 / 纵向 0.75 的椭圆，
     强度 0.11 —— 角上只掉 9%，注释里自己写着「不是做暗角本身，
     只是给浅色主题一点向心收拢」。既然它不承担任何构图职责，
     又是唯一一处「镜头感」而不是「水」的东西，就跟着这一轮一起删掉。 */

  col = aces(col);
  col = pow(max(col, 0.0), vec3(1.0 / 2.2));

  float dither = (hash12(gl_FragCoord.xy * 1.7) - 0.5) / 255.0;
  gl_FragColor = vec4(max(col + dither, 0.0), 1.0);
}
