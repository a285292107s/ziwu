precision highp float;

uniform sampler2D uSrc;
uniform float uNorm;
uniform float uLambdaFine;
uniform float uGainFine;
uniform float uCausMax;

out vec4 outColor;

float causticOf(float lap, float lambda, float gain) {
  float j = 1.0 - lambda * lap;
  return clamp(1.0 / max(abs(j), 2e-3) * gain, 0.0, uCausMax);
}

void main() {
  vec4 s = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0);

  float sx = s.x * uNorm;
  float lapFine = s.z * uNorm;
  float sz = s.w * uNorm;

  float fine = causticOf(lapFine, uLambdaFine, uGainFine);

  outColor = vec4(0.0, sx, sz, fine);
}
