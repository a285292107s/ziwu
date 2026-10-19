precision highp float;

uniform sampler2D uSrc;
uniform int uAxis;
uniform int uHalf;
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

  vec4 bw = vec4(b.x * c - b.y * s,
                 b.x * s + b.y * c,
                 b.z * c - b.w * s,
                 b.z * s + b.w * c);

  outColor = ((i & uHalf) == 0) ? (a + bw) : (a - bw);
}
