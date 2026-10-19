precision highp float;

uniform sampler2D uSpectrum;
uniform float uTime;
uniform float uPatch;
uniform int uBits;

out vec4 outColor;

const float GRAV = 9.81;
const float TENSION = 7.4e-5;
const float TAU = 6.28318530717958647692;

const float LOOP_STEP = TAU / 120.0;

const int MAX_BITS = 8;

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

  vec2 mi = vec2(srcIdx);
  mi -= vec2(n) * step(vec2(float(n) * 0.5), mi);
  vec2 k = TAU * mi / uPatch;
  float kmag = length(k);
  float k2 = dot(k, k);

  float w = sqrt(GRAV * kmag + TENSION * kmag * kmag * kmag);
  w = floor(w / LOOP_STEP) * LOOP_STEP;
  float ct = cos(w * uTime);
  float st = sin(w * uTime);

  vec2 H = cmul(spec.xy, vec2(ct, st)) + cmul(spec.zw, vec2(ct, -st));

  float sa = k.x;
  float sb = -(k2 + k.y);
  outColor = vec4(-sa * H.y, sa * H.x, sb * H.x, sb * H.y);
}
